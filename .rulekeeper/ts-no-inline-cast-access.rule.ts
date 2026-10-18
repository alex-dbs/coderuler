import { Rule, scopes, test, violation } from '@alex-dbs/rulekeeper';

const asObject = {
  kind: 'as_expression',
  has: {
    kind: 'object_type',
    stopBy: { not: { kind: 'parenthesized_type' } },
  },
};

const immediateAccess = {
  any: [{ kind: 'member_expression' }, { kind: 'subscript_expression' }],
  field: 'object',
  stopBy: { not: { kind: 'parenthesized_expression' } },
};

export default class TsNoInlineCastAccess extends Rule {
  files = ['**/*.{ts,tsx,mts,cts}'];

  scope = scopes.astGrep({
    language: 'typescript',
    rule: {
      any: [
        asObject,
        {
          kind: 'type_assertion',
          has: {
            kind: 'type_arguments',
            has: {
              kind: 'object_type',
              stopBy: { not: { kind: 'parenthesized_type' } },
            },
          },
        },
      ],
      inside: immediateAccess,
    },
    tsx: {
      rule: { ...asObject, inside: immediateAccess },
    },
  });

  check = () => violation('Narrow or validate the value before accessing it instead of asserting an inline object type.');
}

export const tests = [
  test('direct property access').withFiles({
    'value.ts': 'const name = (value as { name: string }).name;',
  }).violates(),
  test('subscript access').withFiles({
    'value.ts': 'const name = (value as { name: string })["name"];',
  }).violates(),
  test('optional property access').withFiles({
    'value.ts': 'const name = (value as { name?: string })?.name;',
  }).violates(),
  test('optional subscript access').withFiles({
    'value.ts': 'const name = (value as { name?: string })?.["name"];',
  }).violates(),
  test('multiline parenthesized assertion and object type').withFiles({
    'value.ts': `const name = (((value as (
  { name: string }
)))).name;`,
  }).violates(),
  test('angle assertion').withFiles({
    'value.ts': 'const name = (<{ name: string }>value).name;',
  }).violates(),
  test('parenthesized angle assertion type and optional access').withFiles({
    'value.ts': 'const name = ((<({ name?: string })>value))?.["name"];',
  }).violates(),
  test('TSX expression beside JSX').withFiles({
    'view.tsx': 'const view = <div>{(value as { name: string }).name}</div>;',
  }).violates(),
  test('ES module extension').withFiles({
    'value.mts': 'const name = (value as { name: string }).name;',
  }).violates(),
  test('CommonJS angle assertion').withFiles({
    'value.cts': 'const name = (<{ name: string }>value)["name"];',
  }).violates(),
] as const;
