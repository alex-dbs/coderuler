import { Rule, pass, scopes, violation, type ProjectContext, type Subject } from '@alex-dbs/coderuler';

const EXTERNAL_CALL = 'lspdep.External()';
const EXTERNAL_SYMBOL = 'External';
const DEPENDENCY_FILE = '/project-dependency/dep.go';

export default class GoExternalDefinition extends Rule {
  files = ['**/*.go'];
  scope = scopes.astGrep({ language: 'go', rule: { kind: 'function_declaration' } });

  check = async (subject: Subject, context: ProjectContext) => {
    if (subject.kind !== 'scope' || !subject.source.includes(EXTERNAL_CALL)) return pass();

    const lines = subject.source.split('\n');
    const lineOffset = lines.findIndex(line => line.includes(EXTERNAL_CALL));
    const column = lines[lineOffset].indexOf(EXTERNAL_SYMBOL) + 1;
    const definitions = await context.goLsp.definitions({
      filepath: subject.filepath,
      line: subject.lines!.start + lineOffset,
      column,
    }, { includeDependencies: true });

    context.trace('Go dependency definition', definitions.map(definition => definition.uri));
    return definitions.some(definition => definition.uri.endsWith(DEPENDENCY_FILE))
      ? pass()
      : violation('Resolve lspdep.External to the local dependency');
  };
}
