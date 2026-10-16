import type { CheckedRule, CheckProgress } from './check-result.ts';
import type { ContextCollector, SourceProgress } from './ports/sources.ts';
import { DEFAULT_CONCURRENCY } from './concurrency.ts';
import type { Diagnostics } from './ports/diagnostics.ts';
import type { RuleLoader } from './ports/rules.ts';
import { buildCheckedRules, decideContexts, failureReason, type DecisionServiceFactory } from './decide-contexts.ts';
import { groupContexts } from './decision/group.ts';

export interface CheckOptions {
  readonly rules?: string | undefined;
  readonly diffOnly?: boolean | undefined;
  readonly base?: string | undefined;
  readonly concurrency?: number | undefined;
  readonly threshold?: number | undefined;
}

export interface CheckDependencies {
  readonly loadRules: RuleLoader;
  readonly contexts: ContextCollector;
  readonly createDecisionService: DecisionServiceFactory;
  readonly cwd: string;
}

export type Check = (
  target: string,
  options: CheckOptions,
  progress?: CheckProgress,
  diagnostics?: Diagnostics,
) => Promise<CheckedRule[]>;

export function createCheck(dependencies: CheckDependencies): Check {
  return async function check(
    target: string,
    options: CheckOptions,
    progress?: CheckProgress,
    diagnostics?: Diagnostics,
  ): Promise<CheckedRule[]> {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    let startedAt = 0;
    let stageAt = 0;
    if (diagnostics !== undefined) {
      startedAt = performance.now();
      stageAt = startedAt;
    }
    let phase = 'rules';
    try {
      const loaded = await dependencies.loadRules(options.rules, concurrency, diagnostics);
      progress?.rulesLoaded(loaded.length);
      if (diagnostics !== undefined) {
        const now = performance.now();
        diagnostics.important('rules.loaded', { count: loaded.length, ms: Math.round(now - stageAt) });
        stageAt = now;
      }

      const active = loaded.filter(({ rule }) => rule.enabled);
      if (active.length === 0) {
        progress?.sources(0);
        progress?.decisions({ matchingRules: 0, scopes: 0, total: 0 });
        diagnostics?.important('decisions.planned', { rules: 0, scopes: 0, units: 0 });
        diagnostics?.important('decisions.complete', { units: 0, passed: 0, violations: 0, ms: 0 });
        diagnostics?.important('run.complete', {
          rules: 0,
          scopes: 0,
          files: 0,
          units: 0,
          ms: Math.round(performance.now() - startedAt),
        });
        return [];
      }

      phase = 'identities';
      const rulePaths = await dependencies.contexts.identities(loaded, concurrency, diagnostics);
      if (diagnostics !== undefined) {
        const now = performance.now();
        diagnostics.important('rules.paths', { count: rulePaths.size, ms: Math.round(now - stageAt) });
        stageAt = now;
      }

      phase = 'sources';
      const grouped = active.map(({ rule }) => rule.decision.group_by !== 'scope');
      const sourceProgress: SourceProgress = {
        start: (total) => progress?.sources(total),
        complete: () => progress?.sourceComplete(),
      };
      const contextsByRule = await dependencies.contexts.collect(
        target,
        { diffOnly: options.diffOnly === true, base: options.base },
        active,
        grouped,
        rulePaths,
        concurrency,
        sourceProgress,
        diagnostics,
      );
      const sourceContexts = contextsByRule.reduce((total, contexts) => total + contexts.length, 0);
      const matchingRules = contextsByRule.filter((contexts) => contexts.length > 0).length;
      if (diagnostics !== undefined) {
        const now = performance.now();
        diagnostics.important('sources.collected', {
          rules: active.length,
          matched: matchingRules,
          contexts: sourceContexts,
          ms: Math.round(now - stageAt),
        });
        stageAt = now;
      }

      const decisionContextsByRule = active.map(({ rule }, index) =>
        rule.decision.group_by === 'scope'
          ? contextsByRule[index]!
          : groupContexts(contextsByRule[index]!, rule.decision, dependencies.cwd),
      );
      const units = decisionContextsByRule.reduce((total, contexts) => total + contexts.length, 0);
      progress?.decisions({ matchingRules, scopes: sourceContexts, total: units });
      diagnostics?.important('decisions.planned', { rules: matchingRules, scopes: sourceContexts, units });

      phase = 'decisions';
      const decisionsByRule = await decideContexts({
        loaded: active,
        contexts: decisionContextsByRule,
        concurrency,
        threshold: options.threshold,
        createService: dependencies.createDecisionService,
        onDecision: () => progress?.decisionComplete(),
        diagnostics,
      });
      const results = buildCheckedRules(active, contextsByRule, decisionsByRule);

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
      }

      return results;
    } catch (error) {
      diagnostics?.important('run.failed', { phase, reason: failureReason(error) });
      throw error;
    }
  };
}
