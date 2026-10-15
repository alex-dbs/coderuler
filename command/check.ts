import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createDecisionService } from '../src/decision/config.ts';
import type { Decision, DecisionService } from '../src/decision/service.ts';
import { branchDiff, readBranchFile } from '../src/git-diff.ts';
import { type CompiledRule, type Context, type FileInput, type MatchOptions, type RuleExamples, type RuleInput } from '../src/rule.ts';
import { loadRules, type LoadedRule } from '../src/rule-loader.ts';

/** The parsed `check` options: the rules to use and whether to read the working tree or a diff. */
export interface CheckOptions {
  readonly rules?: string;
  /** Compare committed revisions instead of reading source files from the working tree. */
  readonly diffOnly?: boolean;
  /** Ref to merge-base `HEAD` against in diff mode; the default branch when omitted. */
  readonly base?: string;
}

/**
 * One source file of the scan: the absolute real path it is read from, and the logical filepath
 * every rule glob selects on and every context reports. The logical path is always relative to the
 * process working directory, so `check some/dir` narrows which files are read without rebasing one
 * rule's globs. The absolute path is resolved, so one file reached under two spellings is one
 * candidate — which is what keeps a rule descriptor out of the sources however it was named.
 */
interface SourceCandidate {
  readonly absolute: string;
  readonly logical: string;
}

/** Directories never descended into: version control, installed packages and the rule folders. */
const SKIPPED_DIRECTORIES: Record<string, true> = {
  '.git': true,
  node_modules: true,
  '.rulekeeper': true,
};

/**
 * One decision of one selected scope, reported in the context's own file and scope. The decision
 * service derives all three values; the scope `id` is carried alongside rather than looked up from
 * the context again, so the report is self-contained.
 */
interface CheckedDecision {
  readonly filepath: string;
  readonly scopeId: string;
  readonly follows: boolean;
  readonly probability: number;
  readonly model: string;
}

/**
 * One entry per loaded rule: its descriptor, the contexts it selected, and the decision each
 * context received in the same order. The absolute rule-file path is what the entry is reported
 * under.
 */
interface CheckedRule {
  readonly ruleFile: string;
  readonly name: string;
  readonly rule: string;
  readonly examples: RuleExamples;
  readonly contexts: readonly Context[];
  readonly decisions: readonly CheckedDecision[];
}

/**
 * Collect the source files at and below one directory. A directory in {@link SKIPPED_DIRECTORIES}
 * and every symlink entry are skipped, so the walk never descends into dependencies and never
 * loops on a link back into itself. Read order carries no meaning: the caller sorts the collected
 * logical filepaths, so the file order is deterministic regardless of the directory read order.
 */
async function collectSources(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES[entry.name] !== true) await collectSources(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
}

/**
 * The source files one invocation scans, lexically sorted by logical filepath. A directory target
 * is walked recursively; a file target is that one file. A target that does not exist, or that is
 * itself a symlink, fails with its path named — following a link here would check the link's
 * target under a logical path that hides what was really read.
 *
 * Every candidate is read from its real path. The walk never follows a link, so the only alias a
 * collected path can carry is one in the target's own prefix: resolving that prefix once yields
 * every candidate's real path without a lookup per file, and only an aliased target rewrites the
 * path a candidate is read from. What a context reports is untouched: the logical filepath stays
 * the cwd-relative spelling.
 */
async function resolveSources(target: string): Promise<SourceCandidate[]> {
  const absolute = resolve(target);
  let stats: Stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Source path ${absolute} does not exist`, { cause: error });
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Source path ${absolute} is a symbolic link; point check at the real file or directory`);
  }

  const files: string[] = [];
  if (stats.isDirectory()) await collectSources(absolute, files);
  else if (stats.isFile()) files.push(absolute);
  else throw new Error(`Source path ${absolute} is neither a file nor a directory`);

  const realRoot = await realpath(absolute);
  return files
    .map((path) => ({
      // An unaliased target keeps the walked path itself rather than a copy of it.
      absolute: realRoot === absolute ? path : join(realRoot, relative(absolute, path)),
      logical: relative(process.cwd(), path).split(sep).join('/'),
    }))
    .sort((a, b) => (a.logical < b.logical ? -1 : a.logical > b.logical ? 1 : 0));
}

/**
 * The descriptor identities no source may match: for every loaded rule file, both the path the
 * caller named it with and the real path that path resolves to. A rule keeps being reported under
 * the named path — an explicit `--rules` may be a symlink file, or a link in the path to it — while
 * the file the link resolves to is excluded as well, so a descriptor cannot slip into the scan
 * under a second spelling. Identical entries collapse in the set.
 */
async function descriptorPaths(loaded: readonly LoadedRule[]): Promise<Set<string>> {
  const identities = new Set<string>();
  for (const { filepath } of loaded) {
    identities.add(filepath);
    identities.add(await realpath(filepath));
  }
  return identities;
}

/** Head modes a diff source may carry: a regular file, or a deletion whose scopes are all gone. */
const DIFF_HEAD_MODES: Record<string, true> = { '100644': true, '100755': true, '000000': true };

/** The indexes of the loaded rules whose compiled selection accepts one logical filepath. */
function selectingRules(loaded: readonly LoadedRule[], filepath: string): number[] {
  const selected: number[] = [];
  for (let index = 0; index < loaded.length; index++) {
    if (loaded[index]!.rule.matchesFile(filepath)) selected.push(index);
  }
  return selected;
}

/**
 * One selected rule's contexts at one logical filepath, with a failure of the rule's own matching
 * named by the rule file and the filepath. Nothing is written here, so a failure cannot leave a
 * partial result behind.
 */
function matchedContexts(
  ruleFile: string,
  rule: CompiledRule,
  filepath: string,
  input: RuleInput | FileInput,
  options?: MatchOptions,
): Context[] {
  try {
    return rule.match(input, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Rule ${ruleFile} failed on ${filepath}: ${detail}`, { cause: error });
  }
}

/**
 * Collect one context list per loaded rule from the committed change between the merge base and
 * `HEAD`, the same shape the working-tree scan produces.
 *
 * Only committed revisions are compared: no source file is stat'ed, read or even expected to exist
 * on disk, so a checkout whose committed files were deleted or rewritten is still checked as
 * committed. Candidate scoping is lexical over the repository-relative change paths — the target
 * must lie inside the repository, and no path outside it is read — then a change is dropped when no
 * loaded rule selects its logical filepath, before any blob is read. A change matching no rule, or
 * a deletion, contributes no contexts; a rename's base side is the old path, so a rule that does
 * not select that path is treated as newly applicable and compares against an empty base.
 *
 * Every rule matches every selected change before this returns, so a failing read, a malformed
 * scope or a failing match never yields a partial result; the failure names the change and, for a
 * match failure, the rule file.
 */
async function collectDiffContexts(target: string, options: CheckOptions, loaded: readonly LoadedRule[]): Promise<Context[][]> {
  const branch = await branchDiff(options.base);
  const targetAbsolute = resolve(target);
  const targetWithinRepo = relative(branch.repoRoot, targetAbsolute);
  if (targetWithinRepo !== '' && (targetWithinRepo === '..' || targetWithinRepo.startsWith(`..${sep}`) || isAbsolute(targetWithinRepo))) {
    throw new Error(`Source path ${targetAbsolute} is outside the repository ${branch.repoRoot}`);
  }

  const cwd = process.cwd();
  const rulePaths = await descriptorPaths(loaded);
  const contextsByRule = loaded.map((): Context[] => []);

  for (const file of branch.files) {
    // A symlink or submodule is not readable source text, so it is not a candidate even when a
    // glob would select its path.
    if (DIFF_HEAD_MODES[file.headMode] !== true) continue;
    // A change under a directory no source may come from is not a candidate either.
    if (file.filepath.split('/').some(segment => SKIPPED_DIRECTORIES[segment] === true)) continue;
    const absolute = join(branch.repoRoot, file.filepath);
    // A rule descriptor inside the target is never a source, even when a glob would select it: the
    // committed path is canonical, so comparing it to the descriptor paths excludes the file
    // however the caller named the rule — and without stat'ing a source that may not exist on disk.
    if (rulePaths.has(absolute)) continue;
    // The target scoping stays lexical: diff mode never consults the working tree.
    if (absolute !== targetAbsolute && !absolute.startsWith(targetAbsolute + sep)) continue;
    const logical = relative(cwd, absolute).split(sep).join('/');

    const selected = selectingRules(loaded, logical);
    if (selected.length === 0) continue;

    // One read per changed file, shared by every rule that selects it.
    let snapshot: { base: string; head: string; diff: string };
    try {
      snapshot = await readBranchFile(branch, file);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Diff for ${logical} could not be read: ${detail}`, { cause: error });
    }
    const previous = relative(cwd, join(branch.repoRoot, file.previousPath)).split(sep).join('/');

    for (const index of selected) {
      const { filepath: ruleFile, rule } = loaded[index]!;
      const base = rule.matchesFile(previous) ? snapshot.base : '';
      const input: RuleInput = { filepath: logical, diff: snapshot.diff, head: snapshot.head, base };
      for (const context of matchedContexts(ruleFile, rule, logical, input, { changedOnly: true })) {
        contextsByRule[index]!.push(context);
      }
    }
  }

  return contextsByRule;
}

/**
 * Write the one JSON array both modes produce: one entry per loaded rule, in load order, each
 * carrying its contexts and the decision of every context. A run writes nothing before this point,
 * so no failure inside it can leave a partial result behind.
 */
function writeChecked(
  loaded: readonly LoadedRule[],
  contextsByRule: readonly Context[][],
  decisionsByRule: readonly CheckedDecision[][],
): void {
  const checked: CheckedRule[] = loaded.map(({ filepath, rule }, index) => ({
    ruleFile: filepath,
    name: rule.name,
    rule: rule.rule,
    examples: rule.examples,
    contexts: contextsByRule[index]!,
    decisions: decisionsByRule[index]!,
  }));
  process.stdout.write(`${JSON.stringify(checked, null, 2)}\n`);
}

/**
 * Answer every collected context, one awaited call per context in rule order and then context
 * order — never a fan-out, so the requests stay as ordered as the report. One decision service is
 * created on the first context and reused for the rest; a run that collected no context never
 * creates one, and so never reads the decision configuration.
 *
 * A failing request names the rule file, the context's filepath and the scope, and carries only the
 * sanitized message the adapter produced. Every context is collected before this call, so the
 * requests are the only external effect and a failure here leaves nothing written.
 */
async function decideContexts(
  loaded: readonly LoadedRule[],
  contextsByRule: readonly Context[][],
): Promise<CheckedDecision[][]> {
  const decisionsByRule = contextsByRule.map((): CheckedDecision[] => []);
  let service: DecisionService | undefined;
  for (let index = 0; index < loaded.length; index++) {
    const { filepath: ruleFile, rule } = loaded[index]!;
    for (const context of contextsByRule[index]!) {
      // Created lazily on the first context, so only a run that has something to decide reads the
      // backend configuration.
      const active = (service ??= createDecisionService());
      let decision: Decision;
      try {
        decision = await active.decide({ context, rule: rule.rule, examples: rule.examples });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Decision for ${context.filepath} scope ${context.scope.id} of rule ${ruleFile} failed: ${detail}`,
          { cause: error },
        );
      }
      decisionsByRule[index]!.push({
        filepath: context.filepath,
        scopeId: context.scope.id,
        follows: decision.follows,
        probability: decision.probability,
        model: decision.model,
      });
    }
  }
  return decisionsByRule;
}

/**
 * Collect one context list per loaded rule from the working tree, in lexical filepath order.
 *
 * Only files at least one compiled rule selects are read, and each selected file is read once and
 * shared by every selecting rule. Contexts accumulate per rule across the files, and the rules keep
 * their loaded order. A rule that selects nothing still appears, with an empty `contexts` list.
 * Every rule is compiled, every selected file is read and matched before this returns, so a
 * malformed rule, an unreadable source or a failing match never yields a partial result; the
 * failure names the source path and the rule involved.
 */
async function collectTreeContexts(target: string, loaded: readonly LoadedRule[]): Promise<Context[][]> {
  const rulePaths = await descriptorPaths(loaded);
  const sources = await resolveSources(target);

  const contextsByRule = loaded.map((): Context[] => []);
  for (const source of sources) {
    // A rule descriptor inside the target is never a source, even when a glob would select it: the
    // candidate is a real path, so a rule reached through an explicit `--rules` link is excluded too.
    if (rulePaths.has(source.absolute)) continue;

    const selected = selectingRules(loaded, source.logical);
    if (selected.length === 0) continue;

    let text: string;
    try {
      text = await readFile(source.absolute, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Source file ${source.logical} could not be read: ${detail}`, { cause: error });
    }

    for (const index of selected) {
      const { filepath: ruleFile, rule } = loaded[index]!;
      const input: FileInput = { filepath: source.logical, source: text };
      for (const context of matchedContexts(ruleFile, rule, source.logical, input)) {
        contextsByRule[index]!.push(context);
      }
    }
  }

  return contextsByRule;
}

/**
 * Compile the rules, scan the target, decide every selected scope, and print one JSON array with an
 * entry per loaded rule.
 *
 * Rules come from `--rules` — a rule YAML file or a folder of them, recursively — or from the
 * default discovery when no such option is given. The target only narrows which files are read;
 * rule discovery always looks at the process working directory and the user's home.
 *
 * Both modes collect all their contexts before any decision is requested, so a parse failure has no
 * external side effect; then each context is decided against the configured backend, in rule and
 * context order, and only once every decision has succeeded is the array written. A successful run
 * that answered every context exits `0` even when no scope follows its rule — deciding is the
 * command's job, reporting an overall verdict is not.
 *
 * `--diff-only` collects the contexts from the committed change instead of the working tree: rules
 * still come from the working tree, but the sources are committed revisions. `--base` has no
 * meaning without it, so that combination fails here, before any rule or repository is read.
 */
export async function checkCommand(target: string, options: CheckOptions): Promise<void> {
  if (options.base !== undefined && options.diffOnly !== true) {
    throw new Error('--base requires --diff-only');
  }

  const loaded = await loadRules(options.rules);
  const contextsByRule =
    options.diffOnly === true
      ? await collectDiffContexts(target, options, loaded)
      : await collectTreeContexts(target, loaded);
  const decisionsByRule = await decideContexts(loaded, contextsByRule);
  writeChecked(loaded, contextsByRule, decisionsByRule);
}
