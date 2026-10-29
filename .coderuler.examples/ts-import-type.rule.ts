import { Rule, scopes, test, violation } from '@alex-dbs/coderuler';

export default class TsImportType extends Rule {
  enabled = false;
  files = ['**/*.{ts,tsx,mts,cts}'];
  exclude = ['**/*.d.{ts,mts,cts}'];

  scope = scopes.astGrep({
    language: 'typescript',
    utils: {
      'import-call': {
        kind: 'call_expression',
        has: { kind: 'import', field: 'function' },
      },
    },
    rule: {
      all: [
        {
          any: [
            { matches: 'import-call' },
            {
              kind: 'member_expression',
              has: {
                matches: 'import-call',
                stopBy: { not: { kind: 'member_expression' } },
              },
            },
          ],
        },
        {
          any: [
            { inside: { kind: 'type_alias_declaration', field: 'value' } },
            { inside: { kind: 'function_type', field: 'return_type' } },
            { inside: { kind: 'constructor_type', field: 'type' } },
            {
              inside: {
                any: [
                  { kind: 'type_annotation' },
                  { kind: 'type_arguments' },
                  { kind: 'type_query' },
                  { kind: 'union_type' },
                  { kind: 'intersection_type' },
                  { kind: 'array_type' },
                  { kind: 'parenthesized_type' },
                  { kind: 'tuple_type' },
                  { kind: 'optional_type' },
                  { kind: 'rest_type' },
                  { kind: 'conditional_type' },
                  { kind: 'constraint' },
                  { kind: 'default_type' },
                  { kind: 'index_type_query' },
                  { kind: 'lookup_type' },
                  { kind: 'mapped_type_clause' },
                  { kind: 'type_predicate' },
                ],
              },
            },
            {
              inside: { any: [{ kind: 'as_expression' }, { kind: 'satisfies_expression' }] },
              nthChild: { position: 1, reverse: true },
            },
          ],
        },
      ],
    },
  });

  check = () => violation('Use a top-level import type declaration instead of an inline import type.');
}

export const tests = [
  test('inline annotation').withFiles({
    'value.ts': 'const value: import("./types").Value = source;',
  }).violates(),
  test('multiline generic type argument').withFiles({
    'value.ts': `type Values = Promise<
  import('./types').Value
>;`,
  }).violates(),
  test('typeof import type query').withFiles({
    'value.ts': 'type Module = typeof import("./types");',
  }).violates(),
  test('bare import type alias').withFiles({
    'value.ts': 'type Module = import("./types");',
  }).violates(),
  test('conditional type branches').withFiles({
    'value.ts': 'type Value<T> = T extends string ? import("./types").Text : number;',
  }).violates(),
  test('function type return').withFiles({
    'value.ts': 'type Factory = () => import("./types").Value;',
  }).violates(),
  test('constructor type return').withFiles({
    'value.ts': 'type Constructor = new () => import("./types").Value;',
  }).violates(),
  test('TSX function and constructor type returns').withFiles({
    'view.tsx': `type Factory = () => import("./types").Value;
type Constructor = new () => import("./types").Value;
const view = <div />;`,
  }).violates(),
  test('generic constraint').withFiles({
    'value.ts': 'function use<T extends import("./types").Value>(value: T) {}',
  }).violates(),
  test('asserted type rather than runtime import').withFiles({
    'value.ts': 'const value = source as import("./types").Value;',
  }).violates(),
  test('satisfies type').withFiles({
    'value.ts': 'const value = source satisfies import("./types").Value;',
  }).violates(),
  test('angle assertion type').withFiles({
    'value.ts': 'const value = <import("./types").Value>source;',
  }).violates(),
  test('TSX annotation and JSX').withFiles({
    'view.tsx': 'const View = (props: import("./types").Props) => <div>{props.title}</div>;',
  }).violates(),
  test('ES module extension').withFiles({
    'value.mts': 'type Value = import("./types").Value;',
  }).violates(),
  test('CommonJS extension').withFiles({
    'value.cts': 'type Value = import("./types").Value;',
  }).violates(),
] as const;
