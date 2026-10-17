import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Rule, pass, scopes, violation, type CheckResult, type GroupSubject, type JsonValue, type ScopeSubject, type Subject } from 'rulekeeper';

import { isPresent } from './presence.ts';

export default class DuplicatedEnv extends Rule<Record<string, JsonValue>> {
  files = ['tests/manual/*.yml'];

  scope = scopes.yaml<Record<string, JsonValue>>({ path: '$.*.env.text' });

  group = 'folder' as const;

  filter(subject: ScopeSubject<Record<string, JsonValue>>): boolean {
    const data = subject.data;
    return data !== null && typeof data === 'object'
      && Object.values(data).some(value => isPresent(value));
  }

  check = (subject: Subject<Record<string, JsonValue>>): CheckResult => {
    const { members } = subject as GroupSubject<Record<string, JsonValue>>;
    const defaults = members
      .filter(member => basename(member.filepath) === 'default.yml')
      .map(member => member.data!);

    for (const member of members) {
      if (basename(member.filepath) === 'default.yml') continue;
      for (const [name, value] of Object.entries(member.data!)) {
        if (defaults.some(data => Object.hasOwn(data, name) && isDeepStrictEqual(data[name], value))) {
          return violation(`Env var (${name}) is overriden with the default value, so we can remove it.`);
        }
      }
    }
    return pass();
  };
}
