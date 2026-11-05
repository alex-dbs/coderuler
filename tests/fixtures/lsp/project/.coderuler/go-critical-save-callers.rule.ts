import { basename } from 'node:path';
import { Rule, pass, scopes, violation, type ProjectContext, type Subject } from '@alex-dbs/coderuler';

const ALLOWED_CALLER = 'CriticalServiceSave';
const ALLOWED_FILE = 'service.go';

export default class GoCriticalSaveCallers extends Rule {
  files = ['**/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: { pattern: 'func criticalSave() { $$$BODY }' },
  });

  check = async (subject: Subject, context: ProjectContext) => {
    if (subject.kind !== 'scope') return pass();

    const callers = await context.goLsp.callers(
      { filepath: subject.filepath, line: subject.lines!.start },
      { depth: 1 },
    );
    const identities = callers.map(caller => `${caller.filepath}:${caller.name}`);
    const allowed = callers.every(caller => caller.name === ALLOWED_CALLER && basename(caller.filepath) === ALLOWED_FILE);
    context.trace('criticalSave callers', identities);

    return allowed
      ? pass()
      : violation(`Call criticalSave only from ${ALLOWED_CALLER} in ${ALLOWED_FILE}; found ${identities.join(', ')}`);
  };
}
