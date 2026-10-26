import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Rule, pass, scopes, test, violation } from '@alex-dbs/coderuler';
import type { CheckResult, GroupSubject, JsonValue, ScopeSubject, Subject } from '@alex-dbs/coderuler';

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

function env(...values: readonly Record<string, JsonValue>[]) {
  return Object.fromEntries(values.map((text, index) => [`scope${index}`, { env: { text } }]));
}

export const tests = [
  test('changed values, new names, distinct JSON types, and reordered arrays pass').withFiles({
    'tests/manual/default.yml': env({ NAME: 'one', COUNT: 0, ENABLED: false, ORDER: ['a', 'b'] }),
    'tests/manual/production.yml': env({ NAME: 'two', OTHER: 'one', COUNT: '0', ENABLED: 'false', ORDER: ['b', 'a'] }),
  }).passes(),
  test('a late override repeats an earlier default even when a later default changes it').withFiles({
    'tests/manual/default.yml': env({ SHARED: 'first' }, { SHARED: 'second' }),
    'tests/manual/production.yml': env({ SHARED: 'changed' }, { OTHER: 'second' }),
    'tests/manual/staging.yml': env({ NEW: 'first' }, { SHARED: 'first' }),
  }).violates(),
  test('a later default scope is also compared').withFiles({
    'tests/manual/default.yml': env({ FIRST: 'one' }, { SECOND: 'two' }),
    'tests/manual/production.yml': env({ SECOND: 'two' }),
  }).violates(),
  test('zero remains a duplicate').withFiles({
    'tests/manual/default.yml': env({ COUNT: 0 }),
    'tests/manual/production.yml': env({ COUNT: 0 }),
  }).violates(),
  test('false remains a duplicate').withFiles({
    'tests/manual/default.yml': env({ ENABLED: false }),
    'tests/manual/production.yml': env({ ENABLED: false }),
  }).violates(),
  test('object equality ignores property order').withFiles({
    'tests/manual/default.yml': env({ CONFIG: { first: 1, nested: { enabled: false, retries: 0 } } }),
    'tests/manual/production.yml': env({ CONFIG: { nested: { retries: 0, enabled: false }, first: 1 } }),
  }).violates(),
  test('equal arrays remain duplicates').withFiles({
    'tests/manual/default.yml': env({ ORDER: ['a', 'b'] }),
    'tests/manual/production.yml': env({ ORDER: ['a', 'b'] }),
  }).violates(),
  test('default scopes are not compared with one another').withFiles({
    'tests/manual/default.yml': env({ SHARED: 'one' }, { SHARED: 'one' }),
  }).passes(),
  test('overrides without defaults pass even if they match each other').withFiles({
    'tests/manual/production.yml': env({ SHARED: 'one' }),
    'tests/manual/staging.yml': env({ SHARED: 'one' }),
  }).passes(),
  test('all-empty env scopes are skipped').withFiles({
    'tests/manual/production.yml': env({ EMPTY: '', NULL: null, LIST: [], MAP: {} }),
  }).skips(),
  test('a duplicate among otherwise empty env scopes still violates').withFiles({
    'tests/manual/default.yml': env({}, { SHARED: 'one' }, { EMPTY: '' }),
    'tests/manual/production.yml': env({ NULL: null }, { SHARED: 'one' }, {}),
  }).violates(),
  test('missing env or text fields are skipped').withFiles({
    'tests/manual/production.yml': {
      app: { container: { image: 'example/app:1' } },
      worker: { env: {} },
    },
  }).skips(),
] as const;
