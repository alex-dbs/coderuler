import {
  Rule,
  pass,
  violation,
  type CheckResult,
  type JsonValue,
  type PredicateResult,
  type ScopeMatch,
  type ScopeSubject,
  type SelectionContext,
  type SourceFile,
  type Subject,
} from 'rulekeeper';

import { isMapping } from './policy-helpers.ts';

const OWNER = /^# owner: (\S+)$/;

export default class CustomSelector extends Rule {
  files = ['data/values.yaml'];

  scope = ({ source }: SourceFile): readonly ScopeMatch<JsonValue>[] => {
    const matches: ScopeMatch<JsonValue>[] = [];
    source.split('\n').forEach((text, index) => {
      const owner = OWNER.exec(text)?.[1];
      if (owner === undefined) return;
      matches.push({
        id: `owner@${index + 1}`,
        source: text,
        data: { owner },
        lines: { start: index + 1, end: index + 1 },
        captures: { owner },
      });
    });
    return matches;
  };

  async select(context: SelectionContext): Promise<readonly ScopeSubject<JsonValue>[]> {
    const scope = this.scope;
    if (scope === undefined) throw new Error('custom-selector needs a scope selector');
    const subjects = await context.select<JsonValue>({ files: this.files, scope });
    return subjects.filter((subject) => !(isMapping(subject.data) && subject.data['owner'] === 'unassigned'));
  }

  filter(subject: ScopeSubject<JsonValue>): PredicateResult {
    return isMapping(subject.data) && subject.data['owner'] === 'payments'
      ? { applies: false, reason: 'payments owners are reviewed by another rule' }
      : { applies: true };
  }

  check = (subject: Subject<JsonValue>): CheckResult =>
    subject.kind === 'scope' && isMapping(subject.data) && subject.data['owner'] === 'platform'
      ? violation('owner "platform" must be replaced by an owning team')
      : pass();
}
