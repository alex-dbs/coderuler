import { Rule, pass, violation, scopes, type CheckResult, type CsvRow, type Subject } from '@alex-dbs/rulekeeper';

import { isRow } from './policy-helpers.ts';

export default class CsvRows extends Rule<CsvRow> {
  files = ['data/rows.csv'];

  scope = scopes.csv({ key: 'name' });

  check = (subject: Subject<CsvRow>): CheckResult => {
    if (subject.kind !== 'scope' || !isRow(subject.data)) return pass();
    return subject.data['owner'] === 'unknown'
      ? violation(`row "${subject.id}" names an unknown owner`)
      : pass();
  };
}
