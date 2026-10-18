import type { AiUsage } from './rule.js';
import { validateAiUsage } from './validate.js';

export function addUsage(current: AiUsage | undefined, usage: AiUsage): AiUsage {
  if (current === undefined) return { ...usage };
  return validateAiUsage({
    calls: current.calls + usage.calls,
    unreportedCalls: current.unreportedCalls + usage.unreportedCalls,
    inputTokens: current.inputTokens + usage.inputTokens,
    outputTokens: current.outputTokens + usage.outputTokens,
    inputCost: current.inputCost + usage.inputCost,
    outputCost: current.outputCost + usage.outputCost,
  }, 'Accumulated AI usage');
}
