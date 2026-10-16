import { DEFAULT_CONCURRENCY, mapConcurrent } from './concurrency.ts';
import { groupContexts } from './decision/group.ts';
import type { DecisionExchange } from './decision/port.ts';
import type { Decision, DecisionService } from './decision/service.ts';
import { RegexEvaluator } from './decision/regex.ts';
import type { RuleSelector } from './ports/rules.ts';
import type { SourceRepository, TreeSourceJob } from './ports/sources.ts';
import type { CompiledRule, Context, FileInput, RuleSettings } from './rule/types.ts';
import type { InspectionFile, InspectionObserver, InspectionSummary } from './inspect-result.ts';

export interface InspectDependencies {
  readonly rules: RuleSelector;
  readonly compile: (source: string, filepath: string) => CompiledRule;
  readonly sources: SourceRepository;
  readonly createDecisionService: (settings: RuleSettings) => DecisionService;
  readonly cwd: string;
}

export type Inspect = (selector: string, observer?: InspectionObserver) => Promise<InspectionSummary>;

export type InspectCommand = (
  selector: string,
  folder: string,
  observer: InspectionObserver,
) => Promise<InspectionSummary>;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectFile(
  job: TreeSourceJob,
  rule: CompiledRule,
  ruleFile: string,
): Promise<InspectionFile> {
  let input: FileInput;
  try {
    input = await job.read();
  } catch (error) {
    throw new Error(`Source file ${job.logical} could not be read: ${detail(error)}`, { cause: error });
  }

  const selected: Context[] = [];
  const filtered: Context[] = [];
  let accepted: Context[];
  try {
    accepted = rule.match(input, {
      onScope: (context, ok) => {
        selected.push(context);
        if (!ok) filtered.push(context);
      },
    });
  } catch (error) {
    throw new Error(`Rule ${ruleFile} failed on ${job.logical}: ${detail(error)}`, { cause: error });
  }

  return { filepath: job.logical, selected, accepted, filtered };
}

export function createInspect(dependencies: InspectDependencies): Inspect {
  return async function inspect(selector: string, observer?: InspectionObserver): Promise<InspectionSummary> {
    const { filepath: ruleFile, source } = await dependencies.rules.select(selector);
    let rule: CompiledRule;
    try {
      rule = dependencies.compile(source, ruleFile);
    } catch (error) {
      throw new Error(`Rule file ${ruleFile} is invalid: ${detail(error)}`, { cause: error });
    }

    observer?.({
      type: 'rule',
      cwd: dependencies.cwd,
      ruleFile,
      name: rule.name,
      kind: rule.kind,
      enabled: rule.enabled,
      ...(rule.violationMessage === undefined ? {} : { violationMessage: rule.violationMessage }),
      rule: rule.rule,
      grouping: rule.decision,
    });

    if (!rule.enabled) {
      const summary: InspectionSummary = {
        eligibleFiles: 0,
        matchedFiles: 0,
        selectedScopes: 0,
        filteredScopes: 0,
        verifications: 0,
        passed: 0,
        violations: 0,
      };
      observer?.({ type: 'selection', files: [] });
      observer?.({ type: 'complete', summary });
      return summary;
    }

    const rulePaths = new Set<string>([
      ruleFile,
      ...(await dependencies.sources.identities([ruleFile], DEFAULT_CONCURRENCY)),
    ]);
    const jobs = await dependencies.sources.treeJobs({
      target: dependencies.cwd,
      rulePaths,
      select: (logical) => (rule.matchesFile(logical) ? [0] : []),
    });

    const files = await mapConcurrent(jobs, DEFAULT_CONCURRENCY, (job) => inspectFile(job, rule, ruleFile));
    const selectedScopes = files.reduce((total, file) => total + file.selected.length, 0);
    const filteredScopes = files.reduce((total, file) => total + file.filtered.length, 0);
    observer?.({ type: 'selection', files });

    const contexts = groupContexts(files.flatMap((file) => file.accepted), rule.decision, dependencies.cwd);
    const total = contexts.length;

    let service: DecisionService | undefined;
    const evaluator = rule.kind === 'regex' ? new RegexEvaluator(rule.rule) : undefined;
    let passed = 0;
    for (let index = 0; index < total; index++) {
      const context = contexts[index]!;
      const position = index + 1;
      observer?.({ type: 'verification', index: position, total, context });

      const described =
        'group' in context
          ? `${context.group.type} group ${context.group.path}`
          : `${context.filepath} scope ${context.scope.id}`;

      let decision: Decision;
      if (evaluator === undefined) {
        try {
          service ??= dependencies.createDecisionService(rule.settings);
          decision = await service.decide(
            { context, rule: rule.rule, examples: rule.examples },
            observer === undefined
              ? undefined
              : (exchange: DecisionExchange) => observer({ type: 'exchange', index: position, exchange }),
          );
        } catch (error) {
          const message = `Decision for ${described} of rule ${ruleFile} failed: ${detail(error)}`;
          observer?.({ type: 'failure', index: position, message });
          throw new Error(message, { cause: error });
        }
      } else {
        const verdict = evaluator.evaluate(context);
        observer?.({
          type: 'regex',
          index: position,
          pattern: rule.rule,
          inputs: verdict.targets,
          matched: verdict.matched,
        });
        decision = verdict.decision;
      }

      if (decision.follows) passed++;
      observer?.({ type: 'decision', index: position, decision });
    }

    const summary: InspectionSummary = {
      eligibleFiles: jobs.length,
      matchedFiles: files.filter((file) => file.selected.length > 0).length,
      selectedScopes,
      filteredScopes,
      verifications: total,
      passed,
      violations: total - passed,
    };
    observer?.({ type: 'complete', summary });
    return summary;
  };
}
