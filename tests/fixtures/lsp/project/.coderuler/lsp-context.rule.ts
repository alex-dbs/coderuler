import { Rule, pass, scopes, violation, type ProjectContext, type Subject } from '@alex-dbs/coderuler';

const EXPECTED_CALLEES = ['First:1', 'Leaf:2', 'Second:1', 'Shared:1', 'Shared:1'];
const EXPECTED_CALLERS = ['Caller:1', 'Grandcaller:2'];

export default class LspContext extends Rule {
  files = ['**/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }] },
  });

  check = async (subject: Subject, context: ProjectContext) => {
    if (subject.kind !== 'scope' || !subject.source.includes('func Seed()')) return pass();
    const target = { filepath: subject.filepath, line: subject.lines!.start };
    const [callers, callees, symbols] = await Promise.all([
      context.goLsp.callers(target, { depth: 2 }),
      context.goLsp.callees(target, { depth: 2 }),
      context.goLsp.documentSymbols(subject.filepath),
    ]);
    const callerIdentities = callers.map(call => `${call.name}:${call.depth}`).sort();
    const calleeIdentities = callees.map(call => `${call.name}:${call.depth}`).sort();
    const symbolNames = symbols.map(symbol => symbol.name);
    context.trace('Go LSP call graph', {
      callers: callerIdentities,
      callees: calleeIdentities,
      symbols: symbolNames,
    });
    const valid = JSON.stringify(callerIdentities) === JSON.stringify(EXPECTED_CALLERS)
      && JSON.stringify(calleeIdentities) === JSON.stringify(EXPECTED_CALLEES)
      && symbolNames.includes('Seed');
    return valid ? pass() : violation('Go LSP call graph did not match the fixture');
  };
}
