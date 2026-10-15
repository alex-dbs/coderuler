import type { Stats } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseRule, type CompiledRule } from './rule.ts';

/**
 * Where the two rule roots are looked up. Both default to the real process values, so production
 * callers pass nothing while a test can point the same lookup at its own isolated directories
 * without touching `process.cwd()` or `$HOME`.
 */
export interface RuleDiscoveryOptions {
  /** The project root whose `.rulekeeper` is searched first; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** The user root whose `.rulekeeper` is searched second; defaults to `homedir()`. */
  readonly home?: string;
}

/** One rule file compiled from disk: its absolute path and the rule it parsed to. */
export interface LoadedRule {
  readonly filepath: string;
  /** The compiled rule exactly as {@link parseRule} produced it. */
  readonly rule: CompiledRule;
}

/** The directory name both roots are looked up under. */
const RULE_DIR = '.rulekeeper';

/** A rule file: `.yaml` or `.yml`, matched case-insensitively so `.YAML` is still a rule. */
const RULE_FILE = /\.ya?ml$/i;

/**
 * The two roots in lookup order: the current project's `.rulekeeper`, then the user's. A relative
 * override is resolved against the process working directory, so the pair is always absolute.
 */
function resolveRoots(options: RuleDiscoveryOptions): readonly [string, string] {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  return [resolve(cwd, RULE_DIR), resolve(home, RULE_DIR)];
}

/**
 * Collect the rule files at and below one directory. An entry that is a symlink — to a file or to a
 * directory, including one pointing back into this walk — is skipped: no link is intentionally
 * followed, which is what keeps the walk from looping.
 */
async function walk(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (entry.isFile() && RULE_FILE.test(entry.name)) files.push(path);
  }
}

/** Every rule file at and below one directory, lexically sorted by full path. */
async function ruleFilesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  await walk(directory, files);
  // Strings sort by code unit, which is the full-path lexical order the callers expect; sorting
  // here makes the order deterministic regardless of the order the directories were read in.
  return files.sort();
}

/**
 * Discover every rule file under both `.rulekeeper` roots: the current project's first, then the
 * user's. Discovery is recursive at any depth, so a local rule and a home rule are both found even
 * when they share a name or a relative path — neither shadows the other. No parent of a root is
 * ever walked.
 *
 * The roots are deduplicated by physical directory, so one root reached under two spellings — a home
 * that is the working directory, or a root under a link — contributes its files exactly once, under
 * the first spelling. A missing root contributes nothing; a root that is itself a symlink is never
 * walked, so a linked directory is not searched by accident.
 */
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

/**
 * The rule files one explicit path names: the path itself when it is a file, or every rule file at
 * and below it when it is a directory, lexically sorted by full path. Both failures name the path —
 * a path that does not exist and one that is neither file nor directory — because an explicit path
 * has no default to fall back on.
 *
 * The explicit path itself is followed when it is a symlink: the caller pointed at it deliberately.
 * Links encountered while walking a directory are still skipped, exactly as discovery skips them.
 */
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

/**
 * Read and compile one discovered rule file. The filepath is named in both failures — an unreadable
 * file and a malformed rule — because a repository-wide load must say which rule failed rather than
 * only that one did.
 */
async function compileFile(filepath: string): Promise<CompiledRule> {
  let source: string;
  try {
    source = await readFile(filepath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Rule file ${filepath} could not be read: ${detail}`, { cause: error });
  }
  try {
    return parseRule(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Rule file ${filepath} is invalid: ${detail}`, { cause: error });
  }
}

/**
 * Load rules: the `rulePath` the caller named — one rule file or a directory of rule files — or
 * every discovered rule when none is named.
 *
 * A named path bypasses discovery entirely, so a directory is loaded on its own and never widened to
 * the `.rulekeeper` roots; when that directory holds no rule the failure names the directory the
 * caller actually selected. A discovered load is the project root's rules followed by the user
 * root's, in the order {@link discoverRuleFiles} returns.
 *
 * Every rule is compiled before any of them is returned, so a repository with one malformed rule
 * fails as a whole instead of yielding the valid prefix; no rule is skipped for being invalid. An
 * empty discovery is its own actionable failure rather than an empty rule set.
 */
export async function loadRules(rulePath?: string): Promise<LoadedRule[]> {
  const explicit = rulePath === undefined ? undefined : resolve(rulePath);
  const files = explicit === undefined ? await discoverRuleFiles() : await explicitRuleFiles(explicit);

  if (files.length === 0) {
    if (explicit !== undefined) {
      throw new Error(`No rule files found: expected a .yaml or .yml rule under ${explicit}`);
    }
    const [localRoot, homeRoot] = resolveRoots({});
    throw new Error(
      `No rule files found: expected a .yaml or .yml rule under ${localRoot} or ${homeRoot}`,
    );
  }

  const loaded: LoadedRule[] = [];
  for (const filepath of files) loaded.push({ filepath, rule: await compileFile(filepath) });
  return loaded;
}
