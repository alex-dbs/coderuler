import type { Stats } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { RuleDiscovery, RuleFiles } from '../../app/ports/rules.ts';

export interface RuleDiscoveryOptions {
  readonly cwd?: string;
  readonly home?: string;
}

const RULE_DIR = '.rulekeeper';

const RULE_FILE = /\.ya?ml$/i;

function resolveRoots(options: RuleDiscoveryOptions): readonly [string, string] {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  return [resolve(cwd, RULE_DIR), resolve(home, RULE_DIR)];
}

async function walk(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (entry.isFile() && RULE_FILE.test(entry.name)) files.push(path);
  }
}

async function ruleFilesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  await walk(directory, files);
  // Strings sort by code unit, which is the full-path lexical order the callers expect; sorting
  // here makes the order deterministic regardless of the order the directories were read in.
  return files.sort();
}

export async function discoverRuleFiles(options: RuleDiscoveryOptions = {}): Promise<string[]> {
  const visited = new Set<string>();
  const files: string[] = [];
  for (const root of resolveRoots(options)) {
    // Only `ENOENT` is absorbed: any other stat failure — a file where a directory is expected, an
    // unreadable directory — propagates rather than being read as "this root has no rules".
    let stats: Stats | undefined;
    try {
      stats = await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (stats === undefined || stats.isSymbolicLink()) continue;
    const physical = await realpath(root);
    if (visited.has(physical)) continue;
    visited.add(physical);
    files.push(...(await ruleFilesUnder(root)));
  }
  return files;
}

async function explicitRuleFiles(path: string): Promise<string[]> {
  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Rule path ${path} does not exist`, { cause: error });
    }
    throw error;
  }
  if (stats.isFile()) return [path];
  if (!stats.isDirectory()) throw new Error(`Rule path ${path} is neither a file nor a directory`);
  return ruleFilesUnder(path);
}

function missingRulesError(explicit: string | undefined): Error {
  if (explicit !== undefined) {
    return new Error(`No rule files found: expected a .yaml or .yml rule under ${explicit}`);
  }
  const [localRoot, homeRoot] = resolveRoots({});
  return new Error(
    `No rule files found: expected a .yaml or .yml rule under ${localRoot} or ${homeRoot}`,
  );
}

async function findRuleFiles(rulePath?: string): Promise<RuleDiscovery> {
  const explicit = rulePath === undefined ? undefined : resolve(rulePath);
  const files =
    explicit === undefined ? await discoverRuleFiles() : await explicitRuleFiles(explicit);
  if (files.length > 0) return { files };
  return { files, missingRulesError: missingRulesError(explicit) };
}

export function createRuleFiles(): RuleFiles {
  return {
    find: findRuleFiles,
    read: (filepath) => readFile(filepath, 'utf8'),
  };
}
