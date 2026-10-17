import { Rule, ai, scopes, type AiOptions, type Grouping, type JsonValue, type ScopeSubject } from 'rulekeeper';

import { isMapping, isPresent } from './presence.ts';

export const duplicatedEnvPolicy: AiOptions = {
  rule: 'No env override may redundantly repeat a default value. Defaults are the variable-name/value entries of every scope in default.yml. Every scope in every other file is an override. An override violates the rule when it has a variable with the SAME NAME and SAME VALUE as a default. One such override anywhere makes the whole group noncompliant, regardless of other variables, scopes or files. New variable names and changed values are allowed. Do not compare defaults with themselves.',
  examples: {
    good: [
      'default.yml {A:one,B:two}; production.yml {A:changed}; staging.yml {B:changed} => compliant: no override repeats a default.',
      'default.yml {A:one,B:two}; production.yml scopes [{A:changed},{B:changed}] => compliant.',
    ],
    bad: [
      'default.yml {A:one,B:two}; production.yml {A:changed}; staging.yml {B:two} => violation: staging.yml repeats B=two.',
      'default.yml {A:one,B:two}; production.yml scopes [{A:changed},{B:two}] => violation: the second scope repeats B=two.',
    ],
  },
  violationMessage: 'Env var is overriden with the default value, so we can remove it.',
};

export default class DuplicatedEnv extends Rule {
  files = ['tests/manual/*.yml'];

  scope = scopes.yaml({ path: '$.*.env.text' });

  group: Grouping = 'folder';

  filter(subject: ScopeSubject<JsonValue>): boolean {
    const data = subject.data;
    const children: readonly JsonValue[] = Array.isArray(data)
      ? data
      : isMapping(data)
        ? Object.values(data)
        : [];
    return children.some(child => isPresent(child));
  }

  check = ai(duplicatedEnvPolicy);
}
