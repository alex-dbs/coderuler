import { Rule, pass, test, violation, type ProjectContext, type Subject } from '@alex-dbs/coderuler';

const tsconfig = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    jsx: 'preserve',
    strict: true,
    noEmit: true,
    types: [],
  },
  include: ['src/**/*'],
}, null, 2);
const widget = `export interface Builder {}
export class Widget implements Builder {}
`;
const usage = `import { Widget, type Builder } from './widget.js';


export const widget = new Widget();
export const builder: Builder = widget;
`;

export default class TypescriptDefinition extends Rule {
  files = ['src/usage.ts'];

  check = async (subject: Subject, context: ProjectContext) => {
    if (subject.kind === 'group') return pass();

    const definitions = await context.typescriptLsp.definitions({
      filepath: subject.filepath,
      line: 4,
      column: 27,
    });
    return definitions.some(definition => definition.uri.endsWith('/src/widget.ts'))
      ? pass()
      : violation('Widget must resolve to src/widget.ts');
  };
}

export const tests = [
  test('Widget resolves to its definition').withFiles({
    'tsconfig.json': tsconfig,
    'src/widget.ts': widget,
    'src/usage.ts': usage,
  }).passes(),
  test('an unknown widget does not resolve').withFiles({
    'tsconfig.json': tsconfig,
    'src/widget.ts': widget,
    'src/usage.ts': usage.replace('new Widget()', 'new UnknownWidget()'),
  }).violates(),
] as const;
