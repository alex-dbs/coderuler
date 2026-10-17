import { Rule, ai, scopes, type AiOptions, type JsonValue, type ScopeSubject } from 'rulekeeper';

import { isPresent } from './presence.ts';

export const memoryPolicy: AiOptions = {
  rule: 'Memory limit must be less than or equal to memory request * 1.5. Compare both values in the same units.',
  examples: {
    good: [
      `# limit equals request, so the ratio is 1.0 and stays below 1.5x
  requests:
    memory: 512Mi
  limits:
    memory: 512Mi
`,
      `# limit is exactly 1.5x request, so the boundary is compliant
  requests:
    memory: 512Mi
  limits:
    memory: 768Mi
`,
      `# mixed units: 1536Mi is exactly 1.5x the 1Gi request
  requests:
    memory: 1Gi
  limits:
    memory: 1536Mi
`,
    ],
    bad: [
      `# limit is 2x request, which exceeds 1.5x
  requests:
    memory: 512Mi
  limits:
    memory: 1Gi
`,
    ],
  },
  violationMessage: 'Memory limit must not exceed 1.5 times the memory request.',
};

export default class MemoryRatio extends Rule {
  files = ['tests/manual/*.yml'];

  scope = scopes.yaml({ path: '$.*.container.resources' });

  filter(subject: ScopeSubject<JsonValue>): boolean {
    return isPresent(subject.data, 'requests', 'memory') && isPresent(subject.data, 'limits', 'memory');
  }

  check = ai(memoryPolicy);
}
