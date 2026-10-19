import { lstat, readdir, realpath } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { LoadedRule, RuleLoader, RuleSelection } from '../../app/ports.js';
import type { Rule } from '../../app/rule.js';
import { isRecord, isRuleBranded, validateRule } from '../../app/validate.js';

const RULE_DIR = '.rulekeeper';
const RULE_MODULE = /\.rule\.(?:ts|mts|js|mjs)$/;
const PATH_LIKE = /[/\\]|\.rule\.(?:ts|mts|js|mjs)$/;
const ARCHIVED_DIRECTORY = 'old';
const SDK_ENTRY = new URL('../../index.js', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== '@alex-dbs/rulekeeper') return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const resolutionError = error as NodeJS.ErrnoException;
      if (resolutionError.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return nextResolve(SDK_ENTRY, context);
    }
  },
});

export interface RuleLoaderOptions {
  readonly home?: string;
}

export interface ResolvedRuleSelector {
  readonly explicit?: string;
  readonly name?: string;
}

interface RuleModule {
  readonly name: string;
  readonly modulePath: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ruleNameOf(modulePath: string): string {
  return basename(modulePath).replace(RULE_MODULE, '');
}

async function collectModules(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ARCHIVED_DIRECTORY) continue;
      await collectModules(child, files);
    } else if (entry.isFile() && RULE_MODULE.test(entry.name)) {
      files.push(child);
    }
  }
}

interface DiscoveryRoot {
  readonly physical: string;
  readonly files: readonly string[];
}

async function inspectRoot(root: string): Promise<DiscoveryRoot | undefined> {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stats.isSymbolicLink()) return undefined;
  if (!stats.isDirectory()) {
    throw new Error(`Rule discovery root ${root} is not a directory`);
  }
  const physical = await realpath(root);
  if (physical.split(sep).includes(ARCHIVED_DIRECTORY)) {
    throw new Error(`Rule path ${physical} is inside an archived "${ARCHIVED_DIRECTORY}" directory`);
  }
  const files: string[] = [];
  await collectModules(physical, files);
  return { physical, files: files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)) };
}

function noRulesError(roots: readonly string[]): Error {
  return new Error(
    `No rule files found: expected a .rule.ts, .rule.mts, .rule.js, or .rule.mjs module under ${roots.join(' or ')}`,
  );
}

function duplicatedNameError(name: string, paths: readonly string[]): Error {
  const listed = paths.map((path) => `  ${path}`).join('\n');
  return new Error(`Rule name '${name}' matches ${paths.length} rule files:\n${listed}`);
}

function assertUniqueNames(entries: readonly RuleModule[]): void {
  const byName = new Map<string, string[]>();
  for (const entry of entries) {
    const paths = byName.get(entry.name);
    if (paths === undefined) byName.set(entry.name, [entry.modulePath]);
    else paths.push(entry.modulePath);
  }
  for (const [name, paths] of byName) {
    if (paths.length > 1) throw duplicatedNameError(name, paths);
  }
}

async function discover(roots: readonly string[]): Promise<readonly RuleModule[]> {
  const visitedRoots = new Set<string>();
  const modulePaths: string[] = [];
  for (const root of roots) {
    const found = await inspectRoot(root);
    if (found === undefined || visitedRoots.has(found.physical)) continue;
    visitedRoots.add(found.physical);
    modulePaths.push(...found.files);
  }
  const seen = new Set<string>();
  const entries: RuleModule[] = [];
  for (const modulePath of modulePaths) {
    if (seen.has(modulePath)) continue;
    seen.add(modulePath);
    entries.push({ name: ruleNameOf(modulePath), modulePath });
  }
  if (entries.length === 0) throw noRulesError(roots);
  return entries;
}

async function canonicalRulePath(absolute: string): Promise<string> {
  const physical = await realpath(absolute);
  if (physical.split(sep).includes(ARCHIVED_DIRECTORY)) {
    throw new Error(`Rule path ${physical} is inside an archived "${ARCHIVED_DIRECTORY}" directory`);
  }
  return physical;
}

async function collectExplicit(explicit: string, invocationCwd: string): Promise<string[]> {
  const absolute = resolve(invocationCwd, explicit);
  if (absolute.split(sep).includes(ARCHIVED_DIRECTORY)) {
    throw new Error(`Rule path ${absolute} is inside an archived "${ARCHIVED_DIRECTORY}" directory`);
  }
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Rule path ${absolute} does not exist`, { cause: error });
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Rule path ${absolute} is a symbolic link; point rule selection at the real file or directory`,
    );
  }
  if (stats.isDirectory()) {
    const files: string[] = [];
    await collectModules(await canonicalRulePath(absolute), files);
    files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (files.length === 0) throw noRulesError([absolute]);
    return files;
  }
  if (stats.isFile()) {
    if (!RULE_MODULE.test(basename(absolute))) {
      throw new Error(
        `Unsupported rule module ${absolute}; expected a .rule.ts, .rule.mts, .rule.js, or .rule.mjs file`,
      );
    }
    return [await canonicalRulePath(absolute)];
  }
  throw new Error(`Rule path ${absolute} is neither a file nor a directory`);
}

async function loadRule(modulePath: string): Promise<Rule<unknown>> {
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new Error(`Rule module ${modulePath} failed to import: ${describe(error)}`, {
      cause: error,
    });
  }
  const candidate: unknown = isRecord(imported) ? imported['default'] : undefined;
  if (typeof candidate !== 'function' || !isRuleBranded(candidate)) {
    throw new Error(
      `Rule module ${modulePath} must default-export a constructible Rule class carrying the shared Rule brand`,
    );
  }
  let instance: unknown;
  try {
    instance = new (candidate as new () => unknown)();
  } catch (error) {
    throw new Error(`Rule module ${modulePath} failed to construct: ${describe(error)}`, {
      cause: error,
    });
  }
  return validateRule(instance, modulePath);
}

async function loadEntries(entries: readonly RuleModule[]): Promise<readonly LoadedRule[]> {
  const loaded: LoadedRule[] = [];
  for (const entry of entries) {
    const rule = await loadRule(entry.modulePath);
    loaded.push({ name: entry.name, ruleFile: entry.modulePath, rule });
  }
  return loaded;
}

export async function resolveRuleSelector(
  selector: string,
  invocationCwd: string,
): Promise<ResolvedRuleSelector> {
  const absolute = resolve(invocationCwd, selector);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  if (stats?.isDirectory() === true) {
    throw new Error(
      `Rule selector ${selector} is a directory; inspecting requires one rule module or an exact rule name`,
    );
  }
  if (stats !== undefined || PATH_LIKE.test(selector)) return { explicit: absolute };
  return { name: selector };
}

export function createRuleLoader(options: RuleLoaderOptions = {}): RuleLoader {
  const home = options.home ?? homedir();
  return {
    async load(selection: RuleSelection): Promise<readonly LoadedRule[]> {
      if (selection.explicit !== undefined && selection.name !== undefined) {
        throw new Error('Rule selection cannot combine an explicit rule path with a rule name');
      }
      const roots = [resolve(selection.root, RULE_DIR), resolve(home, RULE_DIR)];
      if (selection.explicit !== undefined) {
        const modulePaths = await collectExplicit(selection.explicit, selection.invocationCwd);
        const entries = modulePaths.map((modulePath) => ({
          name: ruleNameOf(modulePath),
          modulePath,
        }));
        assertUniqueNames(entries);
        return loadEntries(entries);
      }
      const discovered = await discover(roots);
      if (selection.name !== undefined) {
        const matches = discovered.filter((entry) => entry.name === selection.name);
        if (matches.length === 0) {
          throw new Error(`No rule named '${selection.name}' found under ${roots.join(' or ')}`);
        }
        if (matches.length > 1) {
          throw duplicatedNameError(
            selection.name,
            matches.map((match) => match.modulePath),
          );
        }
        return loadEntries(matches);
      }
      assertUniqueNames(discovered);
      return loadEntries(discovered);
    },
  };
}
