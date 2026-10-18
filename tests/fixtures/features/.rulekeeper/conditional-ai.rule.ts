import {
  Rule,
  pass,
  scopes,
  type AiOptions,
  type CheckContext,
  type CheckResult,
  type JsonValue,
  type Subject,
} from '@alex-dbs/rulekeeper';

import { isMapping } from './policy-helpers.ts';

export const strictPolicy: AiOptions = {
  rule: 'A strict policy must name an owning team and an enforcement limit.',
  examples: {
    good: ['id: secrets\nstrict: true\nowner: security\nlimit: 30'],
    bad: ['id: secrets\nstrict: true'],
  },
  violationMessage: 'Strict policy is missing its owner or enforcement limit.',
};

export default class ConditionalAi extends Rule {
  files = ['data/policy.json'];

  scope = scopes.json({ path: '$.policies[*]', key: '$.id' });

  check = async (subject: Subject<JsonValue>, context: CheckContext<JsonValue>): Promise<CheckResult> => {
    const data = subject.kind === 'scope' ? subject.data : undefined;
    if (!isMapping(data) || data['strict'] !== true) {
      context.trace('policy is not strict, so no model call', { policy: subject.kind === 'scope' ? subject.id : 'group' });
      return pass();
    }
    return context.ai({
      ...strictPolicy,
      input: (current) => ({
        policy: current.kind === 'scope' ? current.id : 'group',
        settings: current.kind === 'scope' ? (current.data ?? null) : null,
      }),
    });
  };
}
