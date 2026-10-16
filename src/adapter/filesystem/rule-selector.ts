import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

import type { RuleSelector, RuleSource } from '../../app/ports/rules.ts';
import { discoverRuleFiles } from './rule-files.ts';

export interface RuleSelectorOptions {
  readonly cwd: string;
  readonly invocationCwd: string;
  readonly home?: string;
}

const RULE_DIR = '.rulekeeper';

const PATH_LIKE = /[/\\]|\.ya?ml$/i;

async function readRuleSource(filepath: string): Promise<RuleSource> {
  try {
    return { filepath, source: await readFile(filepath, 'utf8') };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Rule file ${filepath} could not be read: ${detail}`, { cause: error });
  }
}

const RULE_EXTENSION = /\.ya?ml$/i;

function ruleStem(filepath: string): string {
  return basename(filepath).replace(RULE_EXTENSION, '');
}

export async function resolveInspectionFolder(folder: string, invocationCwd: string): Promise<string> {
  const absolute = resolve(invocationCwd, folder);
  let stats: Stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    throw new Error(`Inspection folder ${absolute} does not exist`, { cause: error });
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Inspection folder ${absolute} is a symbolic link; point inspect at the real directory`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Inspection folder ${absolute} is not a directory`);
  }
  return absolute;
}

export function createRuleSelector(options: RuleSelectorOptions): RuleSelector {
  const roots = [
    resolve(options.cwd, RULE_DIR),
    resolve(options.home ?? homedir(), RULE_DIR),
  ];

  async function matchingFiles(name: string): Promise<string[]> {
    const matches: string[] = [];
    for (const filepath of await discoverRuleFiles(options)) {
      if (ruleStem(filepath) === name) matches.push(filepath);
    }
    return matches;
  }

  return {
    async select(selector: string): Promise<RuleSource> {
      const asPath = resolve(options.invocationCwd, selector);
      let stats: Stats | undefined;
      try {
        stats = await lstat(asPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }

      if (stats !== undefined) {
        if (stats.isSymbolicLink()) {
          throw new Error(`Rule path ${asPath} is a symbolic link; point inspect at the real rule file`);
        }
        if (stats.isDirectory()) {
          throw new Error(`Inspect takes exactly one rule file, but ${asPath} is a directory`);
        }
        if (!stats.isFile()) throw new Error(`Rule path ${asPath} is neither a file nor a directory`);
        return await readRuleSource(asPath);
      }

      const matches = await matchingFiles(selector);
      if (matches.length === 1) return await readRuleSource(matches[0]!);
      if (matches.length > 1) {
        const listed = matches.map((filepath) => `  ${filepath}`).join('\n');
        throw new Error(`Rule name '${selector}' matches ${matches.length} rule files:\n${listed}`);
      }

      if (selector.startsWith('.') || PATH_LIKE.test(selector)) {
        throw new Error(`Rule path ${asPath} does not exist`);
      }
      throw new Error(`No rule named '${selector}' found under ${roots[0]} or ${roots[1]}`);
    },
  };
}
