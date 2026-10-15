import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { mapConcurrent } from '../src/concurrency.ts';
import type { Diagnostics } from '../src/diagnostics.ts';
import { branchDiff, readBranchFile, type BranchDiff, type DiffFile } from '../src/git-diff.ts';
import type { CompiledRule, Context, FileInput, MatchOptions, RuleInput } from '../src/rule.ts';
import type { LoadedRule } from '../src/rule-loader.ts';

interface SourceCandidate {
  readonly absolute: string;
  readonly logical: string;
}

const SKIPPED_DIRECTORIES: Record<string, true> = {
  '.git': true,
  node_modules: true,
  '.rulekeeper': true,
};

const DIFF_HEAD_MODES: Record<string, true> = { '100644': true, '100755': true, '000000': true };

type SkipReason =
  | 'no_rule'
  | 'rule_descriptor'
  | 'excluded_directory'
  | 'symlink'
  | 'not_a_file'
  | 'outside_target'
  | 'head_mode';

type SkipReporter = (file: string, reason: SkipReason) => void;

function logicalPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/');
}

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function skipReporter(counts: Map<string, number>, diagnostics: Diagnostics | undefined): SkipReporter | undefined {
  if (diagnostics === undefined) return undefined;
  const verbose = diagnostics.verbose;
  return (file, reason) => {
    const key = `skipped_${reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (verbose !== undefined) verbose('source.skipped', { file, reason });
  };
}

interface RuleContexts {
  readonly index: number;
  readonly contexts: readonly Context[];
}

interface TreeSourceJob {
  readonly kind: 'tree';
  readonly logical: string;
  readonly absolute: string;
  readonly rules: readonly number[];
}

interface DiffSourceJob {
  readonly kind: 'diff';
  readonly branch: BranchDiff;
  readonly file: DiffFile;
  readonly logical: string;
  readonly previous: string;
  readonly rules: readonly number[];
}

type SourceJob = TreeSourceJob | DiffSourceJob;

export interface SourceProgress {
  readonly start: (total: number) => void;
  readonly complete: () => void;
}

export async function descriptorIdentities(
  loaded: readonly LoadedRule[],
  concurrency: number,
  diagnostics?: Diagnostics,
): Promise<Set<string>> {
  const verbose = diagnostics?.verbose;
  const resolved = await mapConcurrent(loaded, concurrency, async ({ filepath }) => {
    const identity = await realpath(filepath);
    if (verbose !== undefined && identity !== filepath) verbose('rules.identity', { rule_file: filepath, resolved: identity });
    return identity;
  });
  const identities = new Set<string>();
  for (const { filepath } of loaded) identities.add(filepath);
  for (const path of resolved) identities.add(path);
  return identities;
}

async function collectSources(directory: string, files: string[], onSkip: SkipReporter | undefined): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      onSkip?.(logicalPath(join(directory, entry.name)), 'symlink');
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES[entry.name] === true) onSkip?.(logicalPath(path), 'excluded_directory');
      else await collectSources(path, files, onSkip);
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      onSkip?.(logicalPath(path), 'not_a_file');
    }
  }
}

async function resolveSources(target: string, onSkip: SkipReporter | undefined): Promise<SourceCandidate[]> {
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
  if (stats.isDirectory()) await collectSources(absolute, files, onSkip);
  else if (stats.isFile()) files.push(absolute);
  else throw new Error(`Source path ${absolute} is neither a file nor a directory`);

  const realRoot = await realpath(absolute);
  return files
    .map((path) => ({
      absolute: realRoot === absolute ? path : join(realRoot, relative(absolute, path)),
      logical: logicalPath(path),
    }))
    .sort((a, b) => (a.logical < b.logical ? -1 : a.logical > b.logical ? 1 : 0));
}

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
  diagnostics?: Diagnostics,
): Context[] {
  try {
    return rule.match(input, options);
  } catch (error) {
    diagnostics?.important('source.failed', { file: filepath, stage: 'match', rule_file: ruleFile, code: failureCode(error) });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Rule ${ruleFile} failed on ${filepath}: ${detail}`, { cause: error });
  }
}

async function treeSourceJobs(
  target: string,
  loaded: readonly LoadedRule[],
  rulePaths: ReadonlySet<string>,
  mask?: readonly boolean[],
  diagnostics?: Diagnostics,
): Promise<TreeSourceJob[]> {
  const counts = new Map<string, number>();
  const onSkip = skipReporter(counts, diagnostics);
  const verbose = diagnostics?.verbose;
  const sources = await resolveSources(target, onSkip);
  const jobs: TreeSourceJob[] = [];
  for (const source of sources) {
    if (rulePaths.has(source.absolute)) {
      onSkip?.(source.logical, 'rule_descriptor');
      continue;
    }

    const rules = selectingRules(loaded, source.logical, mask);
    if (rules.length === 0) {
      onSkip?.(source.logical, 'no_rule');
      continue;
    }
    if (verbose !== undefined) verbose('source.selected', { file: source.logical, rules: rules.length });
    jobs.push({ kind: 'tree', logical: source.logical, absolute: source.absolute, rules });
  }
  if (diagnostics !== undefined) {
    const fields = new Map<string, string | number>([
      ['mode', 'tree'],
      ['candidates', sources.length],
      ['selected', jobs.length],
    ]);
    for (const [reason, count] of counts) fields.set(reason, count);
    diagnostics.important('sources.discovered', Object.fromEntries(fields));
  }
  return jobs;
}

async function diffSourceJobs(
  target: string,
  base: string | undefined,
  loaded: readonly LoadedRule[],
  rulePaths: ReadonlySet<string>,
  mask?: readonly boolean[],
  diagnostics?: Diagnostics,
): Promise<DiffSourceJob[]> {
  const branch = await branchDiff(base);
  diagnostics?.important('diff.branch', {
    repo: branch.repoRoot,
    head: branch.head,
    merge_base: branch.mergeBase,
    changed_files: branch.files.length,
    requested_base: base ?? 'default',
  });
  const targetAbsolute = resolve(target);
  const targetWithinRepo = relative(branch.repoRoot, targetAbsolute);
  if (targetWithinRepo !== '' && (targetWithinRepo === '..' || targetWithinRepo.startsWith(`..${sep}`) || isAbsolute(targetWithinRepo))) {
    throw new Error(`Source path ${targetAbsolute} is outside the repository ${branch.repoRoot}`);
  }

  const counts = new Map<string, number>();
  const onSkip = skipReporter(counts, diagnostics);
  const verbose = diagnostics?.verbose;
  const jobs: DiffSourceJob[] = [];
  for (const file of branch.files) {
    if (DIFF_HEAD_MODES[file.headMode] !== true) {
      onSkip?.(file.filepath, 'head_mode');
      continue;
    }
    if (file.filepath.split('/').some(segment => SKIPPED_DIRECTORIES[segment] === true)) {
      onSkip?.(file.filepath, 'excluded_directory');
      continue;
    }
    const absolute = join(branch.repoRoot, file.filepath);
    if (rulePaths.has(absolute)) {
      onSkip?.(file.filepath, 'rule_descriptor');
      continue;
    }
    if (absolute !== targetAbsolute && !absolute.startsWith(targetAbsolute + sep)) {
      onSkip?.(file.filepath, 'outside_target');
      continue;
    }
    const logical = logicalPath(absolute);

    const rules = selectingRules(loaded, logical, mask);
    if (rules.length === 0) {
      onSkip?.(file.filepath, 'no_rule');
      continue;
    }

    const previous = logicalPath(join(branch.repoRoot, file.previousPath));
    if (verbose !== undefined) verbose('source.selected', { file: logical, mode: 'diff', rules: rules.length });
    jobs.push({ kind: 'diff', branch, file, logical, previous, rules });
  }
  if (diagnostics !== undefined) {
    const fields = new Map<string, string | number>([
      ['mode', 'diff'],
      ['candidates', branch.files.length],
      ['selected', jobs.length],
    ]);
    for (const [reason, count] of counts) fields.set(reason, count);
    diagnostics.important('sources.discovered', Object.fromEntries(fields));
  }
  return jobs;
}

async function matchTreeJob(job: TreeSourceJob, loaded: readonly LoadedRule[], diagnostics?: Diagnostics): Promise<RuleContexts[]> {
  const verbose = diagnostics?.verbose;
  const started = verbose === undefined ? 0 : performance.now();
  if (verbose !== undefined) verbose('source.read.start', { file: job.logical, mode: 'tree' });
  let text: string;
  try {
    text = await readFile(job.absolute, 'utf8');
  } catch (error) {
    diagnostics?.important('source.failed', { file: job.logical, stage: 'read', code: failureCode(error) });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Source file ${job.logical} could not be read: ${detail}`, { cause: error });
  }
  if (verbose !== undefined) {
    verbose('source.read', { file: job.logical, mode: 'tree', chars: text.length, ms: Math.round(performance.now() - started) });
  }

  return job.rules.map((index) => {
    const { filepath: ruleFile, rule } = loaded[index]!;
    const matchStarted = verbose === undefined ? 0 : performance.now();
    const input: FileInput = { filepath: job.logical, source: text };
    const contexts = matchedContexts(ruleFile, rule, job.logical, input, undefined, diagnostics);
    if (verbose !== undefined) {
      verbose('source.match', {
        file: job.logical,
        mode: 'tree',
        rule: rule.name,
        rule_file: ruleFile,
        contexts: contexts.length,
        ms: Math.round(performance.now() - matchStarted),
      });
    }
    return { index, contexts };
  });
}

async function matchDiffJob(job: DiffSourceJob, loaded: readonly LoadedRule[], diagnostics?: Diagnostics): Promise<RuleContexts[]> {
  const verbose = diagnostics?.verbose;
  const started = verbose === undefined ? 0 : performance.now();
  if (verbose !== undefined) verbose('source.read.start', { file: job.logical, mode: 'diff' });
  let snapshot: { base: string; head: string; diff: string };
  try {
    snapshot = await readBranchFile(job.branch, job.file);
  } catch (error) {
    diagnostics?.important('source.failed', { file: job.logical, stage: 'diff_read', code: failureCode(error) });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Diff for ${job.logical} could not be read: ${detail}`, { cause: error });
  }
  if (verbose !== undefined) {
    verbose('source.read', {
      file: job.logical,
      mode: 'diff',
      chars: snapshot.head.length + snapshot.base.length + snapshot.diff.length,
      deleted: snapshot.head === '',
      ms: Math.round(performance.now() - started),
    });
  }

  return job.rules.map((index) => {
    const { filepath: ruleFile, rule } = loaded[index]!;
    const matchStarted = verbose === undefined ? 0 : performance.now();
    const base = rule.matchesFile(job.previous) ? snapshot.base : '';
    const input: RuleInput = { filepath: job.logical, diff: snapshot.diff, head: snapshot.head, base };
    const contexts = matchedContexts(ruleFile, rule, job.logical, input, { changedOnly: true }, diagnostics);
    if (verbose !== undefined) {
      verbose('source.match', {
        file: job.logical,
        mode: 'diff',
        rule: rule.name,
        rule_file: ruleFile,
        previous: job.previous,
        base_compared: base !== '',
        contexts: contexts.length,
        ms: Math.round(performance.now() - matchStarted),
      });
    }
    return { index, contexts };
  });
}

function foldSourceResults(
  loaded: readonly LoadedRule[],
  results: readonly (readonly RuleContexts[])[],
): Context[][] {
  const contextsByRule = loaded.map((): Context[] => []);
  for (const jobResults of results) {
    for (const { index, contexts } of jobResults) {
      for (const context of contexts) contextsByRule[index]!.push(context);
    }
  }
  return contextsByRule;
}

async function runSourceJobs(
  jobs: readonly SourceJob[],
  loaded: readonly LoadedRule[],
  concurrency: number,
  progress: SourceProgress | undefined,
  diagnostics?: Diagnostics,
): Promise<Context[][]> {
  const started = diagnostics === undefined ? 0 : performance.now();
  progress?.start(jobs.length);
  const results = await mapConcurrent(jobs, concurrency, async (job) => {
    const matched = await (job.kind === 'tree' ? matchTreeJob(job, loaded, diagnostics) : matchDiffJob(job, loaded, diagnostics));
    progress?.complete();
    return matched;
  });
  const contextsByRule = foldSourceResults(loaded, results);
  if (diagnostics !== undefined) {
    let treeSources = 0;
    for (const job of jobs) if (job.kind === 'tree') treeSources += 1;
    let contexts = 0;
    let matchedRules = 0;
    for (const ruleContexts of contextsByRule) {
      if (ruleContexts.length > 0) matchedRules += 1;
      contexts += ruleContexts.length;
    }
    diagnostics.important('sources.match', {
      sources: jobs.length,
      tree_sources: treeSources,
      diff_sources: jobs.length - treeSources,
      rules: loaded.length,
      matched_rules: matchedRules,
      contexts,
      ms: Math.round(performance.now() - started),
    });
  }
  return contextsByRule;
}

export async function collectContexts(
  target: string,
  options: { readonly diffOnly: boolean; readonly base?: string | undefined },
  loaded: readonly LoadedRule[],
  grouped: readonly boolean[],
  rulePaths: ReadonlySet<string>,
  concurrency: number,
  progress?: SourceProgress,
  diagnostics?: Diagnostics,
): Promise<Context[][]> {
  if (!options.diffOnly) {
    const jobs = await treeSourceJobs(target, loaded, rulePaths, undefined, diagnostics);
    return runSourceJobs(jobs, loaded, concurrency, progress, diagnostics);
  }

  const scope = grouped.map((isGrouped) => !isGrouped);
  const verbose = diagnostics?.verbose;
  if (verbose !== undefined) {
    for (let index = 0; index < loaded.length; index++) {
      verbose('source.routing', {
        rule: loaded[index]!.rule.name,
        rule_file: loaded[index]!.filepath,
        mode: grouped[index] === true ? 'tree' : 'diff',
      });
    }
  }
  const [treeJobs, diffJobs] = await Promise.all([
    grouped.some(Boolean) ? treeSourceJobs(target, loaded, rulePaths, grouped, diagnostics) : [],
    scope.some(Boolean) ? diffSourceJobs(target, options.base, loaded, rulePaths, scope, diagnostics) : [],
  ]);
  diagnostics?.important('diff.routing', {
    requested_base: options.base ?? 'default',
    tree_rules: grouped.filter(Boolean).length,
    diff_rules: scope.filter(Boolean).length,
    tree_sources: treeJobs.length,
    diff_sources: diffJobs.length,
  });

  return runSourceJobs([...treeJobs, ...diffJobs], loaded, concurrency, progress, diagnostics);
}
