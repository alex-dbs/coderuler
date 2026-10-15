import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createDecisionService } from '../src/decision/config.ts';
import { groupContexts, type DecisionContext, type GroupedContext } from '../src/decision/group.ts';
import type { Decision, DecisionService } from '../src/decision/service.ts';
import { branchDiff, readBranchFile } from '../src/git-diff.ts';
import { type CompiledRule, type Context, type FileInput, type MatchOptions, type RuleExamples, type RuleInput } from '../src/rule.ts';
import { loadRules, type LoadedRule } from '../src/rule-loader.ts';

export interface CheckOptions {
  readonly rules?: string;
  readonly diffOnly?: boolean;
  readonly base?: string;
}

interface SourceCandidate {
  readonly absolute: string;
  readonly logical: string;
}

const SKIPPED_DIRECTORIES: Record<string, true> = {
  '.git': true,
  node_modules: true,
  '.rulekeeper': true,
};

interface CheckedScopeDecision {
  readonly filepath: string;
  readonly scopeId: string;
  readonly follows: boolean;
  readonly probability: number;
  readonly model: string;
}

interface CheckedGroupDecision {
  readonly group: GroupedContext['group'];
  readonly members: readonly { readonly filepath: string; readonly scopeId: string }[];
  readonly follows: boolean;
  readonly probability: number;
  readonly model: string;
}

type CheckedDecision = CheckedScopeDecision | CheckedGroupDecision;

interface CheckedRule {
  readonly ruleFile: string;
  readonly name: string;
  readonly rule: string;
  readonly examples: RuleExamples;
  readonly contexts: readonly Context[];
  readonly decisions: readonly CheckedDecision[];
}

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

async function descriptorPaths(loaded: readonly LoadedRule[]): Promise<Set<string>> {
  const identities = new Set<string>();
  for (const { filepath } of loaded) {
    identities.add(filepath);
    identities.add(await realpath(filepath));
  }
  return identities;
}

const DIFF_HEAD_MODES: Record<string, true> = { '100644': true, '100755': true, '000000': true };

function selectingRules(loaded: readonly LoadedRule[], filepath: string, mask?: readonly boolean[]): number[] {
  const selected: number[] = [];
  for (let index = 0; index < loaded.length; index++) {
    if ((mask === undefined || mask[index] === true) && loaded[index]!.rule.matchesFile(filepath)) selected.push(index);
  }
  return selected;
}

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

async function collectDiffContexts(
  target: string,
  options: CheckOptions,
  loaded: readonly LoadedRule[],
  rulePaths: ReadonlySet<string>,
  mask?: readonly boolean[],
): Promise<Context[][]> {
  const branch = await branchDiff(options.base);
  const targetAbsolute = resolve(target);
  const targetWithinRepo = relative(branch.repoRoot, targetAbsolute);
  if (targetWithinRepo !== '' && (targetWithinRepo === '..' || targetWithinRepo.startsWith(`..${sep}`) || isAbsolute(targetWithinRepo))) {
    throw new Error(`Source path ${targetAbsolute} is outside the repository ${branch.repoRoot}`);
  }

  const cwd = process.cwd();
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

    const selected = selectingRules(loaded, logical, mask);
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

async function decideContexts(
  loaded: readonly LoadedRule[],
  decisionContextsByRule: readonly (readonly DecisionContext[])[],
): Promise<CheckedDecision[][]> {
  const decisionsByRule = decisionContextsByRule.map((): CheckedDecision[] => []);
  let service: DecisionService | undefined;
  for (let index = 0; index < loaded.length; index++) {
    const { filepath: ruleFile, rule } = loaded[index]!;
    for (const context of decisionContextsByRule[index]!) {
      // Created lazily on the first context, so only a run that has something to decide reads the
      // backend configuration.
      const active = (service ??= createDecisionService());
      let decision: Decision;
      try {
        decision = await active.decide({ context, rule: rule.rule, examples: rule.examples });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const subject = 'group' in context
          ? `${context.group.type} group ${context.group.path}`
          : `${context.filepath} scope ${context.scope.id}`;
        throw new Error(`Decision for ${subject} of rule ${ruleFile} failed: ${detail}`, { cause: error });
      }
      decisionsByRule[index]!.push(decisionRecord(context, decision));
    }
  }
  return decisionsByRule;
}

function decisionRecord(context: DecisionContext, decision: Decision): CheckedDecision {
  if ('group' in context) {
    return {
      group: context.group,
      members: context.files.flatMap((file) => file.scopes.map((scope) => ({ filepath: file.filepath, scopeId: scope.id }))),
      follows: decision.follows,
      probability: decision.probability,
      model: decision.model,
    };
  }
  return {
    filepath: context.filepath,
    scopeId: context.scope.id,
    follows: decision.follows,
    probability: decision.probability,
    model: decision.model,
  };
}

async function collectTreeContexts(
  target: string,
  loaded: readonly LoadedRule[],
  rulePaths: ReadonlySet<string>,
  mask?: readonly boolean[],
): Promise<Context[][]> {
  const sources = await resolveSources(target);

  const contextsByRule = loaded.map((): Context[] => []);
  for (const source of sources) {
    // A rule descriptor inside the target is never a source, even when a glob would select it: the
    // candidate is a real path, so a rule reached through an explicit `--rules` link is excluded too.
    if (rulePaths.has(source.absolute)) continue;

    const selected = selectingRules(loaded, source.logical, mask);
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

async function collectContexts(
  target: string,
  options: CheckOptions,
  loaded: readonly LoadedRule[],
  grouped: readonly boolean[],
  rulePaths: ReadonlySet<string>,
): Promise<Context[][]> {
  if (options.diffOnly !== true) {
    return collectTreeContexts(target, loaded, rulePaths);
  }

  // A grouped rule ignores the diff, so it is collected from the current tree, while a scope-mode
  // rule is collected from the committed change. A pass runs only when some rule needs it, so a run
  // with no scope-mode rule never touches the repository, and each rule is filled from its own pass.
  const treeByRule = grouped.some(Boolean) ? await collectTreeContexts(target, loaded, rulePaths, grouped) : undefined;
  const scope = grouped.map((isGrouped) => !isGrouped);
  const diffByRule = scope.some(Boolean) ? await collectDiffContexts(target, options, loaded, rulePaths, scope) : undefined;

  return loaded.map((_, index) => (grouped[index] === true ? treeByRule![index]! : diffByRule![index]!));
}

export async function checkCommand(target: string, options: CheckOptions): Promise<void> {
  if (options.base !== undefined && options.diffOnly !== true) {
    throw new Error('--base requires --diff-only');
  }

  const loaded = await loadRules(options.rules);
  // Prepared once from every loaded rule and shared by both collectors, so a descriptor cannot slip
  // into either pass whichever grouping its own rule uses.
  const rulePaths = await descriptorPaths(loaded);
  const grouped = loaded.map(({ rule }) => rule.decision.group_by !== 'scope');
  const contextsByRule = await collectContexts(target, options, loaded, grouped, rulePaths);
  // Every group is built here, before the first request, so a member outside the working directory
  // fails before any call while a scope-mode rule keeps its contexts as one decision each.
  const decisionsByRule = await decideContexts(
    loaded,
    loaded.map(({ rule }, index) =>
      rule.decision.group_by === 'scope' ? contextsByRule[index]! : groupContexts(contextsByRule[index]!, rule.decision),
    ),
  );
  writeChecked(loaded, contextsByRule, decisionsByRule);
}
