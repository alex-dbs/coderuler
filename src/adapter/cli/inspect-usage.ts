import type { RunEvent } from '../../app/ports.js';
import type { AiUsage } from '../../app/rule.js';
import { addUsage } from '../../app/usage.js';

export interface InspectionUsage extends AiUsage {
  readonly verifications: number;
}

export function createUsageTracker(): {
  readonly emit: (event: RunEvent) => void;
  readonly summary: () => InspectionUsage | undefined;
} {
  const verifications = new Set<number>();
  let total: AiUsage | undefined;
  return {
    emit: event => {
      if (event.type !== 'usage' || event.usage.calls === 0) return;
      verifications.add(event.evaluationId);
      total = addUsage(total, event.usage);
    },
    summary: () => total === undefined ? undefined : { ...total, verifications: verifications.size },
  };
}
