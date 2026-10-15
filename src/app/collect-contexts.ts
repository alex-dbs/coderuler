import { mapConcurrent } from './concurrency.ts';
import type { Diagnostics } from './ports/diagnostics.ts';
import type { LoadedRule } from './ports/rules.ts';
import type {
  CollectOptions,
  ContextCollector,
  DiffSourceJob,
  SourceJob,
  SourceProgress,
  SourceRepository,
  TreeSourceJob,
} from './ports/sources.ts';
import type { CompiledRule, Context, FileInput, MatchOptions, RuleInput } from './rule/types.ts';

interface RuleContexts {
  readonly index: number;
  readonly contexts: readonly Context[];
}

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function selector(
  loaded: readonly LoadedRule[],
  mask?: readonly boolean[],
): (logical: string) => readonly number[] {
  return (logical) => {
    const selected: number[] = [];
    for (let index = 0; index < loaded.length; index++) {
      if ((mask === undefined || mask[index] === true) && loaded[index]!.rule.matchesFile(logical)) {
        selected.push(index);
      }
    }
    return selected;
  };
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

async function matchTreeJob(
  job: TreeSourceJob,
  loaded: readonly LoadedRule[],
  diagnostics?: Diagnostics,
): Promise<RuleContexts[]> {
  const verbose = diagnostics?.verbose;
  const started = verbose === undefined ? 0 : performance.now();
  if (verbose !== undefined) verbose('source.read.start', { file: job.logical, mode: 'tree' });
  let input: FileInput;
  try {
    input = await job.read();
  } catch (error) {
    diagnostics?.important('source.failed', { file: job.logical, stage: 'read', code: failureCode(error) });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Source file ${job.logical} could not be read: ${detail}`, { cause: error });
  }
  if (verbose !== undefined) {
    verbose('source.read', { file: job.logical, mode: 'tree', chars: input.source.length, ms: Math.round(performance.now() - started) });
  }

  return job.rules.map((index) => {
    const { filepath: ruleFile, rule } = loaded[index]!;
    const matchStarted = verbose === undefined ? 0 : performance.now();
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

async function matchDiffJob(
  job: DiffSourceJob,
  loaded: readonly LoadedRule[],
  diagnostics?: Diagnostics,
): Promise<RuleContexts[]> {
  const verbose = diagnostics?.verbose;
  const started = verbose === undefined ? 0 : performance.now();
  if (verbose !== undefined) verbose('source.read.start', { file: job.logical, mode: 'diff' });
  let snapshot: RuleInput;
  try {
    snapshot = await job.read();
  } catch (error) {
    diagnostics?.important('source.failed', { file: job.logical, stage: 'diff_read', code: failureCode(error) });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Diff for ${job.logical} could not be read: ${detail}`, { cause: error });
  }
  if (verbose !== undefined) {
    verbose('source.read', {
      file: job.logical,
      mode: 'diff',
      chars: snapshot.head.length + (snapshot.base ?? '').length + snapshot.diff.length,
      deleted: snapshot.head === '',
      ms: Math.round(performance.now() - started),
    });
  }

  return job.rules.map((index) => {
    const { filepath: ruleFile, rule } = loaded[index]!;
    const matchStarted = verbose === undefined ? 0 : performance.now();
    const base = rule.matchesFile(job.previous) ? snapshot.base ?? '' : '';
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

export function createContextCollector(sources: SourceRepository): ContextCollector {
  return {
    async identities(loaded, concurrency, diagnostics): Promise<Set<string>> {
      const resolved = await sources.identities(
        loaded.map(({ filepath }) => filepath),
        concurrency,
        diagnostics,
      );
      const identities = new Set<string>();
      for (const { filepath } of loaded) identities.add(filepath);
      for (const path of resolved) identities.add(path);
      return identities;
    },

    async collect(
      target: string,
      options: CollectOptions,
      loaded: readonly LoadedRule[],
      grouped: readonly boolean[],
      rulePaths: ReadonlySet<string>,
      concurrency: number,
      progress?: SourceProgress,
      diagnostics?: Diagnostics,
    ): Promise<Context[][]> {
      if (!options.diffOnly) {
        const jobs = await sources.treeJobs(
          { target, rulePaths, select: selector(loaded) },
          diagnostics,
        );
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
        grouped.some(Boolean)
          ? sources.treeJobs({ target, rulePaths, select: selector(loaded, grouped) }, diagnostics)
          : [],
        scope.some(Boolean)
          ? sources.diffJobs(
              { target, base: options.base, rulePaths, select: selector(loaded, scope) },
              diagnostics,
            )
          : [],
      ]);
      diagnostics?.important('diff.routing', {
        requested_base: options.base ?? 'default',
        tree_rules: grouped.filter(Boolean).length,
        diff_rules: scope.filter(Boolean).length,
        tree_sources: treeJobs.length,
        diff_sources: diffJobs.length,
      });

      return runSourceJobs([...treeJobs, ...diffJobs], loaded, concurrency, progress, diagnostics);
    },
  };
}
