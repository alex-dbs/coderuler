import { Rule, pass, violation, scopes, type CheckResult, type JsonValue, type Subject } from '@alex-dbs/rulekeeper';

export default class FileNotes extends Rule {
  files = ['docs/notes/**/*.txt'];

  scope = scopes.file();

  check = (subject: Subject<JsonValue>): CheckResult =>
    subject.kind === 'scope' && subject.source.includes('TODO')
      ? violation(`unfinished work in "${subject.filepath}"`)
      : pass();
}
