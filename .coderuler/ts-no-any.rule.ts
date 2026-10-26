import { Rule, scopes, test, violation } from '@alex-dbs/coderuler';

export default class TsNoAny extends Rule {
  files = ['**/*.{ts,tsx,mts,cts}'];

  scope = scopes.astGrep({
    language: 'typescript',
    rule: {
      kind: 'predefined_type',
      pattern: { context: 'type ExplicitAny = any;', selector: 'predefined_type' },
    },
  });

  check = () => violation('Replace explicit any with a specific type or unknown and narrow it.');
}

export const tests = [
  test('explicit variable annotation').withFiles({
    'value.ts': 'let value: any;',
  }).violates(),
  test('any inside a multiline union and generic').withFiles({
    'value.ts': `type Value =
  | string
  | Promise<Array<any>>;`,
  }).violates(),
  test('as assertion').withFiles({
    'value.ts': 'const result = value as any;',
  }).violates(),
  test('angle assertion uses TypeScript rather than TSX grammar').withFiles({
    'value.ts': 'const result = <any>value;',
  }).violates(),
  test('TSX props and JSX coexist').withFiles({
    'view.tsx': 'const View = (props: { value: any }) => <div>{props.value}</div>;',
  }).violates(),
  test('ES module extension').withFiles({
    'value.mts': 'type Value = Record<string, any>;',
  }).violates(),
  test('CommonJS extension').withFiles({
    'value.cts': 'function use(value: any): void {}',
  }).violates(),
  test('declaration files are not implicitly exempt from explicit any').withFiles({
    'api.d.ts': 'export declare const value: any;',
  }).violates(),
] as const;
