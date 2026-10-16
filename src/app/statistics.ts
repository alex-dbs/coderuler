import type { Check } from './check.ts';
import type { Inspect } from './inspect.ts';
import type { InspectionObserver } from './inspect-result.ts';
import type { EvaluationStatistics, StatisticsStore } from './ports/statistics.ts';

export function trackCheck(check: Check, project: string, store: StatisticsStore, now: () => number): Check {
  return async function trackedCheck(target, options, progress, diagnostics) {
    const startedAt = now();
    const results = await check(target, options, progress, diagnostics);
    const elapsedMs = now() - startedAt;
    let verifications = 0;
    let violations = 0;
    for (const result of results) {
      verifications += result.decisions.length;
      for (const decision of result.decisions) {
        if (!decision.follows) violations += 1;
      }
    }
    store.record(project, { rules: results.length, verifications, violations, elapsedMs });
    return results;
  };
}

export function trackInspect(inspect: Inspect, project: string, store: StatisticsStore, now: () => number): Inspect {
  return async function trackedInspect(selector, observer) {
    const startedAt = now();
    let enabled = false;
    const relay: InspectionObserver = (event) => {
      if (event.type === 'rule') enabled = event.enabled;
      observer?.(event);
    };
    const summary = await inspect(selector, relay);
    const elapsedMs = now() - startedAt;
    const evaluation: EvaluationStatistics = {
      rules: enabled ? 1 : 0,
      verifications: summary.verifications,
      violations: summary.violations,
      elapsedMs,
    };
    store.record(project, evaluation);
    return summary;
  };
}
