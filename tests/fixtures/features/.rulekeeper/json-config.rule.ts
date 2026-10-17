import {
  Rule,
  pass,
  violation,
  scopes,
  type CheckResult,
  type JsonValue,
  type PredicateResult,
  type ScopeSubject,
  type Subject,
} from 'rulekeeper';

import { isMapping, readNumber } from './policy-helpers.ts';

const MAX_REPLICAS = 3;

export default class JsonConfig extends Rule {
  files = ['data/config.json'];

  scope = scopes.json({ path: '$.services[*]', key: '$.name' });

  filter(subject: ScopeSubject<JsonValue>): PredicateResult {
    return isMapping(subject.data) && subject.data['replicas'] !== undefined
      ? { applies: true }
      : { applies: false, reason: 'service declares no replica count' };
  }

  check = (subject: Subject<JsonValue>): CheckResult => {
    if (subject.kind !== 'scope' || !isMapping(subject.data)) return pass();
    const replicas = readNumber(subject.data['replicas']);
    if (replicas === undefined || replicas <= MAX_REPLICAS) return pass();
    return violation(`service "${subject.id}" runs ${replicas} replicas, above the ${MAX_REPLICAS} allowed`);
  };
}
