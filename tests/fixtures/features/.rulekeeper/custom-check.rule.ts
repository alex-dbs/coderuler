import {
  Rule,
  pass,
  violation,
  scopes,
  type CheckContext,
  type CheckResult,
  type JsonValue,
  type Subject,
} from 'rulekeeper';

import { isMapping, isRow } from './policy-helpers.ts';

export default class CustomCheck extends Rule {
  files = ['data/rows.csv'];

  scope = scopes.file();

  check = async (subject: Subject<JsonValue>, context: CheckContext<JsonValue>): Promise<CheckResult> => {
    const config = await context.project.readJson('data/config.json');
    const owners: string[] = [];
    if (isMapping(config)) {
      const declared = config['owners'];
      if (Array.isArray(declared)) {
        for (const owner of declared) {
          if (typeof owner === 'string') owners.push(owner);
        }
      }
    }
    const values = await context.project.readYaml('data/values.yaml');
    const rows = await context.project.readCsv('data/rows.csv');
    context.trace('cross-referenced project data', { documents: values.length, rows: rows.length });
    const unknown: string[] = [];
    for (const row of rows) {
      if (!isRow(row)) continue;
      const owner = row['owner'];
      if (owner !== undefined && !owners.includes(owner)) unknown.push(`${row['name'] ?? '?'} -> ${owner}`);
    }
    if (unknown.length === 0) return pass();
    const where = subject.kind === 'scope' ? subject.filepath : 'data';
    return violation(`${where} names owners outside data/config.json: ${unknown.join(', ')}`);
  };
}
