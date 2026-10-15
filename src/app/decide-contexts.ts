import { mapConcurrent } from './concurrency.ts';
import type { CheckedDecision, CheckedRule } from './check-result.ts';
import type { DecisionContext } from './decision/group.ts';
import type { Decision, DecisionService } from './decision/service.ts';
import type { DiagnosticFields, Diagnostics } from './ports/diagnostics.ts';
import type { LoadedRule } from './ports/rules.ts';
import type { Context } from './rule/types.ts';

export type DecisionServiceFactory = (diagnostics?: Diagnostics, threshold?: number) => DecisionService;

export interface DecideContextsInput {
  readonly loaded: readonly LoadedRule[];
  readonly contexts: readonly (readonly DecisionContext[])[];
  readonly concurrency: number;
  readonly threshold: number | undefined;
  readonly createService: DecisionServiceFactory;
  readonly onDecision: () => void;
  readonly diagnostics: Diagnostics | undefined;
}

interface DecisionJob {
  readonly index: number;
  readonly context: DecisionContext;
}

export function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined ? error.name : `${error.name} ${code}`;
}

function decisionIdentity(context: DecisionContext, rule: string): DiagnosticFields {
  return 'group' in context
    ? { rule, group: context.group.type, group_path: context.group.path }
    : { rule, filepath: context.filepath, scope_id: context.scope.id };
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

export async function decideContexts(input: DecideContextsInput): Promise<CheckedDecision[][]> {
  const { loaded, contexts, concurrency, threshold, createService, onDecision, diagnostics } = input;
  const jobs: DecisionJob[] = [];
  for (let index = 0; index < loaded.length; index++) {
    for (const context of contexts[index]!) jobs.push({ index, context });
  }

  let service: DecisionService | undefined;
  const decisions = await mapConcurrent(jobs, concurrency, async (job) => {
    const { filepath: ruleFile, rule } = loaded[job.index]!;
    const active = (service ??= createService(diagnostics, threshold));
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

export function buildCheckedRules(
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
