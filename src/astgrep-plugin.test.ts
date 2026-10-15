import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { registerDynamicLanguage, type DynamicLangRegistrations } from '@ast-grep/napi';
import { astGrepPlugin } from './plugins/astgrep.ts';
import { createAstGrepLanguageRegistrations } from './plugins/astgrep-languages.ts';
import type { ScopeMatch } from './plugins/types.ts';
import { compileRule, type CompiledRule } from './rule.ts';

const loadCommonJs = createRequire(import.meta.url);
const mojoRegistration = loadCommonJs('@ast-grep/lang-go') as DynamicLangRegistrations[string];

const HOST_GRAMMAR = 'mojo';

registerDynamicLanguage({ ...createAstGrepLanguageRegistrations(), [HOST_GRAMMAR]: mojoRegistration });

const GO_RULE: Record<string, unknown> = {
  any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
  has: {
    kind: 'for_statement',
    stopBy: 'end',
    has: { pattern: 'append($SLICE,$$$ARGS)', stopBy: 'end' },
  },
};

const ADD_TAGS = [
  'func addTags(tags []string) []string {',
  '\tout := []string{}',
  '\tfor _, tag := range tags {',
  '\t\tout = append(out, tag)',
  '\t}',
  '\treturn out',
  '}',
].join('\n');

const GO_SOURCE = ['package store', '', ADD_TAGS, ''].join('\n');

const METHOD_SOURCE = [
  'package store',
  '',
  'type Cart struct {',
  '\titems []string',
  '}',
  '',
  'func (c *Cart) Add(items ...string) {',
  '\tfor _, item := range items {',
  '\t\tc.items = append(c.items, item)',
  '\t}',
  '}',
  '',
  'func (w *Wishlist) Add(items ...string) {',
  '\tfor _, item := range items {',
  '\t\tw.items = append(w.items, item)',
  '\t}',
  '}',
  '',
].join('\n');

const JS_SOURCE = [
  'function 集める(世界) {',
  '  const out = [];',
  '  for (const 値 of 世界) {',
  '    out.push(値);',
  '  }',
  '  return out;',
  '}',
].join('\n');

const JS_RULE: Record<string, unknown> = {
  any: [{ kind: 'function_declaration' }],
  has: {
    kind: 'for_in_statement',
    stopBy: 'end',
    has: { pattern: 'out.push($ITEM)', stopBy: 'end' },
  },
};

const TS_SOURCE = [
  'export function collect(values: number[]): number[] {',
  '  const out: number[] = [];',
  '  for (let i = 0; i < values.length; i++) {',
  '    out.push(values[i]!);',
  '  }',
  '  return out;',
  '}',
].join('\n');

const TS_RULE: Record<string, unknown> = {
  any: [{ kind: 'function_declaration' }],
  has: {
    kind: 'for_statement',
    stopBy: 'end',
    has: { pattern: 'out.push($VALUE)', stopBy: 'end' },
  },
};

const PYTHON_SOURCE = [
  'def add_tags(tags):',
  '    out = []',
  '    for tag in tags:',
  '        out.append(tag)',
  '    return out',
].join('\n');

const PYTHON_RULE: Record<string, unknown> = {
  kind: 'function_definition',
  has: { pattern: 'return $NAME', stopBy: 'end' },
};

function select(options: Record<string, unknown>, source: string): readonly ScopeMatch[] {
  return astGrepPlugin.compile(options).select({ filepath: 'memory.go', source });
}

test('matches Go under the canonical spelling and a plugin-owned alias in one process', () => {
  const canonical = select({ language: 'Go', rule: GO_RULE }, GO_SOURCE);
  const alias = select({ language: 'golang', rule: GO_RULE }, GO_SOURCE);
  assert.deepEqual(alias, canonical);
  assert.equal(canonical.length, 1);
  const scope = canonical[0]!;
  assert.equal(scope.id, 'function_declaration:addTags');
  assert.equal(scope.source, ADD_TAGS);
  assert.deepEqual(scope.captures, { SLICE: 'out', ARGS: ['tag'] });
  assert.equal(typeof scope.captures!.SLICE, 'string');
  assert.ok(Array.isArray(scope.captures!.ARGS));
  assert.ok(!('data' in scope));
});

test('matches a grammar the host registered itself under its own name, exactly as written', () => {
  const custom = select({ language: HOST_GRAMMAR, rule: GO_RULE }, GO_SOURCE);
  assert.deepEqual(custom, select({ language: 'go', rule: GO_RULE }, GO_SOURCE));
  assert.equal(custom.length, 1);
  assert.equal(custom[0]!.id, 'function_declaration:addTags');
  assert.deepEqual(custom[0]!.captures, { SLICE: 'out', ARGS: ['tag'] });
  // An out-of-catalog name is passed to the native parser verbatim, so a different spelling of the
  // same grammar is a different language and stays unregistered.
  assert.throws(() => select({ language: 'Mojo', rule: GO_RULE }, GO_SOURCE), Error);
});

test('the host single native call also serves catalog grammars it never named', () => {
  const matches = select({ language: 'py', rule: PYTHON_RULE }, PYTHON_SOURCE);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.id, 'function_definition:add_tags');
  assert.equal(matches[0]!.source, PYTHON_SOURCE);
  assert.deepEqual(matches[0]!.captures, { NAME: 'out' });
});

test('keys Go methods by receiver so same-named methods never collide', () => {
  const matches = select({ language: 'golang', rule: GO_RULE }, METHOD_SOURCE);
  assert.deepEqual(matches.map((scope) => scope.id), [
    'method_declaration:Cart.Add',
    'method_declaration:Wishlist.Add',
  ]);
  assert.deepEqual(matches.map((scope) => scope.captures), [
    { SLICE: 'c.items', ARGS: ['item'] },
    { SLICE: 'w.items', ARGS: ['item'] },
  ]);
});

test('keeps a declaration identity stable when earlier lines move', () => {
  const shifted = ['package store', '', '// a new leading comment', '', ADD_TAGS, ''].join('\n');
  const original = select({ language: 'golang', rule: GO_RULE }, GO_SOURCE);
  const moved = select({ language: 'golang', rule: GO_RULE }, shifted);
  assert.deepEqual(moved, original);
});

function declarationRule(language: string, rule: Record<string, unknown>): CompiledRule {
  return compileRule({
    version: 'v1',
    name: 'Declarations',
    files: { included: ['src/**'] },
    scope: { format: 'ast-grep', language, rule },
    rule: 'Review the selected declarations.',
  });
}

const TS_OVERLOAD_IMPLEMENTATION = [
  'export function collect(values: readonly unknown[]): readonly unknown[] {',
  '  return [...values];',
  '}',
].join('\n');

const TS_ONE_SIGNATURE = [
  'export function collect(values: number[]): number[];',
  '',
  TS_OVERLOAD_IMPLEMENTATION,
].join('\n');

const TS_TWO_SIGNATURES = [
  'export function collect(values: number[]): number[];',
  'export function collect(values: string[]): string[];',
  TS_OVERLOAD_IMPLEMENTATION,
].join('\n');

test('keys legal TypeScript overloads with a deterministic ordinal instead of failing the file', () => {
  const rule = declarationRule('typescript', { kind: 'function_signature' });
  const filepath = 'src/collect.ts';
  const first = {
    id: 'function_signature:collect',
    source: 'function collect(values: number[]): number[];',
    captures: {},
  };
  const second = {
    id: 'function_signature:collect#1',
    source: 'function collect(values: string[]): string[];',
    captures: {},
  };
  assert.deepEqual(rule.match({ filepath, source: TS_TWO_SIGNATURES }), [
    { filepath, scope: first },
    { filepath, scope: second },
  ]);
  // The added overload is the only change: the overload already there keeps the id it had alone.
  assert.deepEqual(rule.match({ filepath, diff: '', head: TS_TWO_SIGNATURES, base: TS_ONE_SIGNATURE }), [
    { filepath, diff: '', scope: second },
  ]);
  // Nothing changed, so neither overload is re-reviewed.
  assert.deepEqual(rule.match({ filepath, diff: '', head: TS_TWO_SIGNATURES, base: TS_TWO_SIGNATURES }), []);
});

const JAVA_ONE_ADD = ['class Cart {', '  void add(String item) {', '    items.add(item);', '  }', '}', ''].join('\n');

const JAVA_OVERLOADED_ADD = [
  'class Cart {',
  '  void add(String item) {',
  '    items.add(item);',
  '  }',
  '',
  '  void add(int count) {',
  '    items.add(count);',
  '  }',
  '}',
  '',
].join('\n');

test('keys a legal Java overload with a deterministic ordinal instead of failing the file', () => {
  const rule = declarationRule('java', { kind: 'method_declaration' });
  const filepath = 'src/Cart.java';
  const add = {
    id: 'class_declaration:Cart/method_declaration:add',
    source: 'void add(String item) {\n    items.add(item);\n  }',
    captures: {},
  };
  const count = {
    id: 'class_declaration:Cart/method_declaration:add#1',
    source: 'void add(int count) {\n    items.add(count);\n  }',
    captures: {},
  };
  assert.deepEqual(rule.match({ filepath, source: JAVA_OVERLOADED_ADD }), [
    { filepath, scope: add },
    { filepath, scope: count },
  ]);
  assert.deepEqual(rule.match({ filepath, diff: '', head: JAVA_OVERLOADED_ADD, base: JAVA_ONE_ADD }), [
    { filepath, diff: '', scope: count },
  ]);
  assert.deepEqual(rule.match({ filepath, diff: '', head: JAVA_OVERLOADED_ADD, base: JAVA_OVERLOADED_ADD }), []);
});

const PYTHON_ONE_ADD_TAGS = ['def add_tags(tags):', '    return tags', ''].join('\n');

const PYTHON_REDEFINED_ADD_TAGS = [
  'def add_tags(tags):',
  '    return tags',
  '',
  'def add_tags(values):',
  '    return values',
  '',
].join('\n');

test('keys a Python redefinition with a deterministic ordinal instead of failing the file', () => {
  const rule = declarationRule('python', { kind: 'function_definition' });
  const filepath = 'src/store.py';
  const tags = {
    id: 'function_definition:add_tags',
    source: 'def add_tags(tags):\n    return tags',
    captures: {},
  };
  const values = {
    id: 'function_definition:add_tags#1',
    source: 'def add_tags(values):\n    return values',
    captures: {},
  };
  assert.deepEqual(rule.match({ filepath, source: PYTHON_REDEFINED_ADD_TAGS }), [
    { filepath, scope: tags },
    { filepath, scope: values },
  ]);
  // Python's last definition is the one that takes effect, but both parse as declarations: the
  // redefinition takes the ordinal after the first, so only it is a change against the base.
  assert.deepEqual(rule.match({ filepath, diff: '', head: PYTHON_REDEFINED_ADD_TAGS, base: PYTHON_ONE_ADD_TAGS }), [
    { filepath, diff: '', scope: values },
  ]);
});

test('keeps a declaration whose name already looks suffixed apart from a repeated one', () => {
  const source = [
    'class Cart {',
    '  add() {}',
    '  add() {}',
    '  "add#1"() {}',
    '}',
  ].join('\n');
  // The string-literal method name is `"add#1"` including its quotes, so it never collides with the
  // ordinal id of the repeated `add`, whichever order the declarations appear in.
  assert.deepEqual(select({ language: 'javascript', rule: { kind: 'method_definition' } }, source), [
    { id: 'class_declaration:Cart/method_definition:add', source: 'add() {}', captures: {} },
    { id: 'class_declaration:Cart/method_definition:add#1', source: 'add() {}', captures: {} },
    { id: 'class_declaration:Cart/method_definition:"add#1"', source: '"add#1"() {}', captures: {} },
  ]);
});

test('extracts UTF-8 source and capture text exactly', () => {
  const matches = select({ language: 'javascript', rule: JS_RULE }, JS_SOURCE);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.id, 'function_declaration:集める');
  assert.equal(matches[0]!.source, JS_SOURCE);
  assert.deepEqual(matches[0]!.captures, { ITEM: '値' });
});

test('runs built-in TypeScript queries without any host registration', () => {
  const matches = select({ language: 'typescript', rule: TS_RULE }, TS_SOURCE);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.id, 'function_declaration:collect');
  assert.deepEqual(matches[0]!.captures, { VALUE: 'values[i]!' });
  assert.deepEqual(select({ language: 'ts', rule: TS_RULE }, TS_SOURCE), matches);
});

test('returns an empty captures object when the rule binds no metavariables', () => {
  const matches = select({ language: 'golang', rule: { kind: 'function_declaration' } }, GO_SOURCE);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]!.captures, {});
  assert.ok(!('data' in matches[0]!));
});

test('matches loop-scoped appends syntactically, keeping correct pre-sized candidates', () => {
  const noLoop = ['package store', '', 'func appendOne(values []string) []string {', '\treturn append(values, "x")', '}', ''].join('\n');
  const preSized = [
    'package store',
    '',
    'func grow(values []string) []string {',
    '\tout := make([]string, 0, len(values))',
    '\tfor _, value := range values {',
    '\t\tout = append(out, value)',
    '\t}',
    '\treturn out',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(select({ language: 'golang', rule: GO_RULE }, noLoop), []);
  const matches = select({ language: 'golang', rule: GO_RULE }, preSized);
  assert.deepEqual(matches.map((scope) => scope.id), ['function_declaration:grow']);
});

test('rejects an unknown or empty language', () => {
  assert.throws(() => astGrepPlugin.compile({ language: 'nope', rule: { kind: 'function_declaration' } }), Error);
  assert.throws(() => astGrepPlugin.compile({ language: '', rule: { kind: 'function_declaration' } }), Error);
  assert.throws(() => astGrepPlugin.compile({ rule: { kind: 'function_declaration' } }), Error);
});

test('rejects an invalid native query while compiling', () => {
  assert.throws(() => astGrepPlugin.compile({ language: 'golang', rule: { kind: 'not_a_kind' } }), Error);
  assert.throws(() => astGrepPlugin.compile({ language: 'golang', rule: { regex: '(' } }), Error);
  assert.throws(() => astGrepPlugin.compile({ language: 'golang', rule: { pattern: '$$$ROOT' } }), Error);
  assert.throws(() => astGrepPlugin.compile({ language: 'golang', rule: { pattern: '' } }), Error);
  assert.throws(
    () => astGrepPlugin.compile({ language: 'golang', rule: { pattern: 'append($SLICE)' }, constraints: { SLICE: { regex: '(' } } }),
    Error,
  );
});

test('rejects unknown and malformed scope options', () => {
  assert.throws(() => astGrepPlugin.compile({ language: 'golang', rule: { kind: 'function_declaration' }, extra: 1 }), Error);
  assert.throws(() => astGrepPlugin.compile({ language: 'golang', rule: 'function_declaration' }), Error);
  assert.throws(() => astGrepPlugin.compile({ language: 'golang', rule: { kind: 'function_declaration' }, constraints: [] }), Error);
  assert.throws(() => astGrepPlugin.compile({ language: 'golang', rule: { kind: 'function_declaration' }, utils: 'x' }), Error);
});
