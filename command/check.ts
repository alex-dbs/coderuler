import { DEFAULT_CONCURRENCY, mapConcurrent } from '../src/concurrency.ts';
import { createDecisionService } from '../src/decision/config.ts';
import { groupContexts, type DecisionContext } from '../src/decision/group.ts';
import type { Decision, DecisionService } from '../src/decision/service.ts';
import { validateThreshold } from '../src/decision/threshold.ts';
import {
  createDiagnostics,
  type DiagnosticFields,
  type DiagnosticOptions,
  type Diagnostics,
} from '../src/diagnostics.ts';
import type { Context } from '../src/rule.ts';
import { loadRules, type LoadedRule } from '../src/rule-loader.ts';
import { createCheckReporter, type CheckedDecision, type CheckedRule } from './check-report.ts';
import { collectContexts, descriptorIdentities, type SourceProgress } from './check-sources.ts';

export interface CheckOptions extends DiagnosticOptions {
  readonly rules?: string;
  readonly diffOnly?: boolean;
  readonly base?: string;
  readonly concurrency?: number;
  readonly threshold?: number;
  readonly json?: boolean;
}

interface DecisionJob {
  readonly index: number;
  readonly context: DecisionContext;
}

function buildChecked(
  loaded: readonly LoadedRule[],
  contextsByRule: readonly Context[][],
  decisionsByRule: readonly CheckedDecision[][],
): CheckedRule[] {
  return loaded.map(({ filepath, rule }, index) => ({
    ruleFile: filepath,
    name: rule.name,
    rule: rule.rule,
    examples: rule.examples,
    contexts: contextsByRule[index]!,
    decisions: decisionsByRule[index]!,
    ...(rule.title === undefined ? {} : { title: rule.title }),
  }));
}

function concurrencyOf(value: number | undefined, diagnostics: Diagnostics | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value <= 0) {
    diagnostics?.important('run.invalid', { option: 'concurrency', value: String(value) });
    throw new Error(`--concurrency must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function thresholdOf(value: number | undefined, diagnostics: Diagnostics | undefined): number | undefined {
  if (value === undefined) return undefined;
  try {
    return validateThreshold(value);
  } catch (error) {
    diagnostics?.important('run.invalid', { option: 'threshold', value: String(value) });
    throw error;
  }
}

function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined ? error.name : `${error.name} ${code}`;
}

function decisionIdentity(context: DecisionContext, rule: string): DiagnosticFields {
  return 'group' in context
    ? { rule, group: context.group.type, group_path: context.group.path }
    : { rule, filepath: context.filepath, scope_id: context.scope.id };
}

async function decideContexts(
  loaded: readonly LoadedRule[],
  decisionContextsByRule: readonly (readonly DecisionContext[])[],
  concurrency: number,
  threshold: number | undefined,
  onDecision: () => void,
  diagnostics: Diagnostics | undefined,
): Promise<CheckedDecision[][]> {
  const jobs: DecisionJob[] = [];
  for (let index = 0; index < loaded.length; index++) {
    for (const context of decisionContextsByRule[index]!) jobs.push({ index, context });
  }

  let service: DecisionService | undefined;
  const decisions = await mapConcurrent(jobs, concurrency, async (job) => {
    const { filepath: ruleFile, rule } = loaded[job.index]!;
    const active = (service ??= createDecisionService(undefined, diagnostics, threshold));
    diagnostics?.important('decision.start', decisionIdentity(job.context, rule.name));
    let startedAt = 0;
    if (diagnostics !== undefined) startedAt = performance.now();
    let decision: Decision;
    try {
      decision = await active.decide({ context: job.context, rule: rule.rule, examples: rule.examples });
    } catch (error) {
      diagnostics?.important('decision.failed', {
        ...decisionIdentity(job.context, rule.name),
        reason: failureReason(error),
      });
      const detail = error instanceof Error ? error.message : String(error);
      const subject = 'group' in job.context
        ? `${job.context.group.type} group ${job.context.group.path}`
        : `${job.context.filepath} scope ${job.context.scope.id}`;
      throw new Error(`Decision for ${subject} of rule ${ruleFile} failed: ${detail}`, { cause: error });
    }
    const verbose = diagnostics?.verbose;
    if (verbose !== undefined && 'group' in job.context) {
      const { group, files } = job.context;
      for (const file of files) {
        for (const scope of file.scopes) {
          verbose('decision.group.member', {
            group: group.path,
            filepath: file.filepath,
            scope_id: scope.id,
          });
        }
      }
    }
    diagnostics?.important('decision.result', {
      ...decisionIdentity(job.context, rule.name),
      follows: decision.follows,
      probability: decision.probability,
      model: decision.model,
      ms: Math.round(performance.now() - startedAt),
    });
    onDecision();
    return decisionRecord(job.context, decision);
  });

  const decisionsByRule = loaded.map((): CheckedDecision[] => []);
  jobs.forEach((job, position) => decisionsByRule[job.index]!.push(decisions[position]!));
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

export async function checkCommand(target: string, options: CheckOptions): Promise<void> {
  const diagnostics = createDiagnostics(options);
  const requestedConcurrency = concurrencyOf(options.concurrency, diagnostics);
  const threshold = thresholdOf(options.threshold, diagnostics);
  if (options.base !== undefined && options.diffOnly !== true) {
    diagnostics?.important('run.invalid', { option: 'base', reason: 'requires diff-only' });
    throw new Error('--base requires --diff-only');
  }

  const concurrency = options.debug === true ? 1 : requestedConcurrency;
  diagnostics?.important('run.start', {
    target,
    mode: options.json === true ? 'json' : 'human',
    diff_only: options.diffOnly === true,
    base: options.base ?? 'default',
    requested: requestedConcurrency,
    concurrency,
  });
  if (options.debug === true && requestedConcurrency !== 1) {
    diagnostics?.important('concurrency.forced', { effective: 1, requested: requestedConcurrency, reason: 'debug' });
  }

  const reporter =
    options.json === true ? undefined : createCheckReporter({ activity: diagnostics === undefined });
  let startedAt = 0;
  let stageAt = 0;
  if (diagnostics !== undefined) {
    startedAt = performance.now();
    stageAt = startedAt;
  }
  let phase = 'rules';
  try {
    const loaded = await loadRules(options.rules, concurrency, diagnostics);
    reporter?.rulesLoaded(loaded.length);
    if (diagnostics !== undefined) {
      const now = performance.now();
      diagnostics.important('rules.loaded', { count: loaded.length, ms: Math.round(now - stageAt) });
      stageAt = now;
    }

    phase = 'identities';
    const rulePaths = await descriptorIdentities(loaded, concurrency, diagnostics);
    if (diagnostics !== undefined) {
      const now = performance.now();
      diagnostics.important('rules.paths', { count: rulePaths.size, ms: Math.round(now - stageAt) });
      stageAt = now;
    }

    phase = 'sources';
    const grouped = loaded.map(({ rule }) => rule.decision.group_by !== 'scope');
    const progress: SourceProgress = {
      start: (total) => reporter?.sources(total),
      complete: () => reporter?.sourceComplete(),
    };
    const contextsByRule = await collectContexts(
      target,
      { diffOnly: options.diffOnly === true, base: options.base },
      loaded,
      grouped,
      rulePaths,
      concurrency,
      progress,
      diagnostics,
    );
    const sourceContexts = contextsByRule.reduce((total, contexts) => total + contexts.length, 0);
    const matchingRules = contextsByRule.filter((contexts) => contexts.length > 0).length;
    if (diagnostics !== undefined) {
      const now = performance.now();
      diagnostics.important('sources.collected', {
        rules: loaded.length,
        matched: matchingRules,
        contexts: sourceContexts,
        ms: Math.round(now - stageAt),
      });
      stageAt = now;
    }

    const decisionContextsByRule = loaded.map(({ rule }, index) =>
      rule.decision.group_by === 'scope' ? contextsByRule[index]! : groupContexts(contextsByRule[index]!, rule.decision),
    );
    const units = decisionContextsByRule.reduce((total, contexts) => total + contexts.length, 0);
    reporter?.decisions({ matchingRules, scopes: sourceContexts, total: units });
    diagnostics?.important('decisions.planned', { rules: matchingRules, scopes: sourceContexts, units });

    phase = 'decisions';
    const decisionsByRule = await decideContexts(
      loaded,
      decisionContextsByRule,
      concurrency,
      threshold,
      () => reporter?.decisionComplete(),
      diagnostics,
    );
    const results = buildChecked(loaded, contextsByRule, decisionsByRule);

    if (diagnostics !== undefined) {
      const now = performance.now();
      let decisionsRan = 0;
      let passed = 0;
      let selectedScopes = 0;
      const files = new Set<string>();
      for (const rule of results) {
        selectedScopes += rule.contexts.length;
        for (const context of rule.contexts) files.add(context.filepath);
        for (const decision of rule.decisions) {
          decisionsRan++;
          if (decision.follows) passed++;
        }
      }
      diagnostics.important('decisions.complete', {
        units: decisionsRan,
        passed,
        violations: decisionsRan - passed,
        ms: Math.round(now - stageAt),
      });
      diagnostics.important('run.complete', {
        rules: results.length,
        scopes: selectedScopes,
        files: files.size,
        units: decisionsRan,
        ms: Math.round(now - startedAt),
      });
      process.stderr.write('\n');
    }

    phase = 'report';
    if (reporter === undefined) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    } else {
      reporter.finish(results);
    }
  } catch (error) {
    diagnostics?.important('run.failed', { phase, reason: failureReason(error) });
    throw error;
  } finally {
    reporter?.stop();
  }
}
