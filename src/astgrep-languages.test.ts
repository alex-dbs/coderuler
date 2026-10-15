import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from '@ast-grep/napi';
import { astGrepPlugin } from './adapter/scope/astgrep.ts';
import type { ScopeMatch } from './app/scope/types.ts';

const CATALOG: readonly string[] = [
  'angular',
  'bash',
  'bicep',
  'c',
  'cpp',
  'csharp',
  'dart',
  'elixir',
  'glimmer-javascript',
  'glimmer-typescript',
  'go',
  'haskell',
  'java',
  'json',
  'kotlin',
  'lua',
  'markdown',
  'php',
  'python',
  'ruby',
  'rust',
  'scala',
  'sql',
  'swift',
  'toml',
  'yaml',
];

const ALIASES: Readonly<Record<string, string>> = {
  cc: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  ex: 'elixir',
  golang: 'go',
  hs: 'haskell',
  kt: 'kotlin',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
};

interface LanguageFixture {
  readonly source: string;
  readonly rule: Record<string, unknown>;
  readonly expected: readonly ScopeMatch[];
}

interface LanguageCase extends LanguageFixture {
  readonly language: string;
}

const ANGULAR_SOURCE = ['<div *ngIf="items.length > 0">', '  <p>{{ title }}</p>', '</div>', ''].join('\n');

const BASH_SOURCE = ['greet() {', '  echo "hello"', '}', '', 'for f in *.txt; do', '  echo "$f"', 'done', ''].join('\n');

const BICEP_SOURCE = [
  'param location string = resourceGroup().location',
  '',
  "resource store 'Microsoft.Storage/storageAccounts@2023-01-01' = {",
  "  name: 'store'",
  '  location: location',
  '}',
  '',
].join('\n');

const C_SOURCE = ['int add(int a, int b) {', '  return a + b;', '}', ''].join('\n');

const CSHARP_SOURCE = ['class Cart {', '  public void Add(string item) {', '    items.Add(item);', '  }', '}', ''].join('\n');

const DART_SOURCE = ['class Cart {', '  int add(int a, int b) {', '    return a + b;', '  }', '}', ''].join('\n');

const ELIXIR_SOURCE = ['defmodule Store do', '  def add(a, b) do', '    a + b', '  end', 'end', ''].join('\n');

const GLIMMER_SOURCE = ['<template>', '  <div class="card">{{@title}}</div>', '</template>', ''].join('\n');

const GO_ADD_TAGS = [
  'func addTags(tags []string) []string {',
  '\tout := []string{}',
  '\tfor _, tag := range tags {',
  '\t\tout = append(out, tag)',
  '\t}',
  '\treturn out',
  '}',
].join('\n');

const GO_SOURCE = ['package store', '', GO_ADD_TAGS, ''].join('\n');

const GO_RULE: Record<string, unknown> = {
  any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
  has: {
    kind: 'for_statement',
    stopBy: 'end',
    has: { pattern: 'append($SLICE,$$$ARGS)', stopBy: 'end' },
  },
};

const HASKELL_SOURCE = ['module Store where', '', 'add :: Int -> Int -> Int', 'add a b = a + b', ''].join('\n');

const JAVA_SOURCE = ['class Cart {', '  void add(String item) {', '    items.add(item);', '  }', '}', ''].join('\n');

const JSON_SOURCE = ['{', '  "name": "store",', '  "tags": ["a", "b"]', '}', ''].join('\n');

const KOTLIN_SOURCE = ['fun add(a: Int, b: Int): Int {', '  return a + b', '}', ''].join('\n');

const LUA_SOURCE = ['local function add(a, b)', '  return a + b', 'end', ''].join('\n');

const MARKDOWN_SOURCE = ['# Title', '', 'Some text with `code`.', ''].join('\n');

const PHP_SOURCE = ['<?php', 'function add(int $a, int $b): int {', '  return $a + $b;', '}', ''].join('\n');

const PYTHON_SOURCE = [
  'def add_tags(tags):',
  '    out = []',
  '    for tag in tags:',
  '        out.append(tag)',
  '    return out',
  '',
].join('\n');

const RUBY_SOURCE = ['def add(a, b)', '  a + b', 'end', ''].join('\n');

const RUST_SOURCE = ['fn add(a: i32, b: i32) -> i32 {', '    a + b', '}', ''].join('\n');

const SCALA_SOURCE = ['def add(a: Int, b: Int): Int = a + b', ''].join('\n');

const SQL_SOURCE = ['SELECT id, name FROM users WHERE active = true;', ''].join('\n');

const SWIFT_SOURCE = ['func add(_ a: Int, _ b: Int) -> Int {', '  return a + b', '}', ''].join('\n');

const TOML_SOURCE = ['[package]', 'name = "store"', ''].join('\n');

const YAML_SOURCE = ['name: store', 'tags:', '  - a', '  - b', ''].join('\n');

const CSS_SOURCE = ['.cart { display: flex; }', ''].join('\n');

const HTML_SOURCE = ['<div class="cart"><span>Store</span></div>', ''].join('\n');

const JAVASCRIPT_SOURCE = [
  'function collect(values) {',
  '  const out = [];',
  '  for (const value of values) {',
  '    out.push(value);',
  '  }',
  '  return out;',
  '}',
].join('\n');

const TSX_SOURCE = ['export function Card({title}: {title: string}) {', '  return <div className="card">{title}</div>;', '}'].join('\n');

const TYPESCRIPT_SOURCE = [
  'export function collect(values: number[]): number[] {',
  '  const out: number[] = [];',
  '  for (let i = 0; i < values.length; i++) {',
  '    out.push(values[i]!);',
  '  }',
  '  return out;',
  '}',
].join('\n');

const C_FUNCTION_FIXTURE: LanguageFixture = {
  source: C_SOURCE,
  rule: { kind: 'function_definition', has: { pattern: 'return $LEFT + $RIGHT', stopBy: 'end' } },
  expected: [
    {
      id: 'function_definition#0',
      lines: { start: 1, end: 3 },
      source: ['int add(int a, int b) {', '  return a + b;', '}'].join('\n'),
      captures: { LEFT: 'a', RIGHT: 'b' },
    },
  ],
};

const GLIMMER_TEMPLATE_FIXTURE: LanguageFixture = {
  source: GLIMMER_SOURCE,
  rule: { kind: 'glimmer_template' },
  expected: [
    {
      id: 'glimmer_template#0',
      lines: { start: 1, end: 3 },
      source: ['<template>', '  <div class="card">{{@title}}</div>', '</template>'].join('\n'),
      captures: {},
    },
  ],
};

const CASES: readonly LanguageCase[] = [
  {
    language: 'angular',
    source: ANGULAR_SOURCE,
    rule: {
      kind: 'element',
      has: {
        kind: 'start_tag',
        stopBy: 'end',
        has: { kind: 'attribute', stopBy: 'end', has: { kind: 'structural_directive', stopBy: 'end' } },
      },
    },
    expected: [
      {
        id: 'element#0',
        lines: { start: 1, end: 3 },
        source: ['<div *ngIf="items.length > 0">', '  <p>{{ title }}</p>', '</div>'].join('\n'),
        captures: {},
      },
    ],
  },
  {
    language: 'bash',
    source: BASH_SOURCE,
    rule: { kind: 'function_definition', has: { pattern: 'echo $MSG', stopBy: 'end' } },
    expected: [
      {
        id: 'function_definition:greet',
        lines: { start: 1, end: 3 },
        source: ['greet() {', '  echo "hello"', '}'].join('\n'),
        captures: { MSG: '"hello"' },
      },
    ],
  },
  {
    language: 'bicep',
    source: BICEP_SOURCE,
    rule: { kind: 'resource_declaration', has: { pattern: 'name: $RES', stopBy: 'end' } },
    expected: [
      {
        id: 'resource_declaration#0',
        lines: { start: 3, end: 6 },
        source: [
          "resource store 'Microsoft.Storage/storageAccounts@2023-01-01' = {",
          "  name: 'store'",
          '  location: location',
          '}',
        ].join('\n'),
        captures: { RES: "'store'" },
      },
    ],
  },
  {
    language: 'c',
    ...C_FUNCTION_FIXTURE,
  },
  {
    language: 'cpp',
    ...C_FUNCTION_FIXTURE,
  },
  {
    language: 'csharp',
    source: CSHARP_SOURCE,
    rule: { kind: 'method_declaration', has: { pattern: 'items.Add($ITEM)', stopBy: 'end' } },
    expected: [
      {
        id: 'class_declaration:Cart/method_declaration:Add',
        lines: { start: 2, end: 4 },
        source: ['public void Add(string item) {', '    items.Add(item);', '  }'].join('\n'),
        captures: { ITEM: 'item' },
      },
    ],
  },
  {
    language: 'dart',
    source: DART_SOURCE,
    rule: { kind: 'class_definition', has: { kind: 'method_signature', stopBy: 'end' } },
    expected: [
      {
        id: 'class_definition:Cart',
        lines: { start: 1, end: 5 },
        source: ['class Cart {', '  int add(int a, int b) {', '    return a + b;', '  }', '}'].join('\n'),
        captures: {},
      },
    ],
  },
  {
    language: 'elixir',
    source: ELIXIR_SOURCE,
    rule: { kind: 'call', pattern: 'def $NAME($A, $B) do $$$BODY end' },
    expected: [
      {
        id: 'call#0',
        lines: { start: 2, end: 4 },
        source: ['def add(a, b) do', '    a + b', '  end'].join('\n'),
        captures: { NAME: 'add', A: 'a', B: 'b', BODY: ['a + b'] },
      },
    ],
  },
  {
    language: 'glimmer-javascript',
    ...GLIMMER_TEMPLATE_FIXTURE,
  },
  {
    language: 'glimmer-typescript',
    ...GLIMMER_TEMPLATE_FIXTURE,
  },
  {
    language: 'go',
    source: GO_SOURCE,
    rule: GO_RULE,
    expected: [{ id: 'function_declaration:addTags', lines: { start: 3, end: 9 }, source: GO_ADD_TAGS, captures: { SLICE: 'out', ARGS: ['tag'] } }],
  },
  {
    language: 'haskell',
    source: HASKELL_SOURCE,
    rule: { kind: 'signature' },
    expected: [{ id: 'signature:add', lines: { start: 3, end: 3 }, source: 'add :: Int -> Int -> Int', captures: {} }],
  },
  {
    language: 'java',
    source: JAVA_SOURCE,
    rule: { kind: 'method_declaration', has: { pattern: 'items.add($ITEM)', stopBy: 'end' } },
    expected: [
      {
        id: 'class_declaration:Cart/method_declaration:add',
        lines: { start: 2, end: 4 },
        source: ['void add(String item) {', '    items.add(item);', '  }'].join('\n'),
        captures: { ITEM: 'item' },
      },
    ],
  },
  {
    language: 'json',
    source: JSON_SOURCE,
    rule: { kind: 'pair', has: { kind: 'string', pattern: '"tags"', stopBy: 'end' } },
    expected: [{ id: 'pair#0', lines: { start: 3, end: 3 }, source: '"tags": ["a", "b"]', captures: {} }],
  },
  {
    language: 'kotlin',
    source: KOTLIN_SOURCE,
    rule: { kind: 'function_declaration', has: { pattern: 'return $LEFT + $RIGHT', stopBy: 'end' } },
    expected: [
      {
        id: 'function_declaration#0',
        lines: { start: 1, end: 3 },
        source: ['fun add(a: Int, b: Int): Int {', '  return a + b', '}'].join('\n'),
        captures: { LEFT: 'a', RIGHT: 'b' },
      },
    ],
  },
  {
    language: 'lua',
    source: LUA_SOURCE,
    rule: { kind: 'function_declaration', has: { pattern: 'return $LEFT + $RIGHT', stopBy: 'end' } },
    expected: [
      {
        id: 'function_declaration:add',
        lines: { start: 1, end: 3 },
        source: ['local function add(a, b)', '  return a + b', 'end'].join('\n'),
        captures: { LEFT: 'a', RIGHT: 'b' },
      },
    ],
  },
  {
    language: 'markdown',
    source: MARKDOWN_SOURCE,
    rule: { kind: 'atx_heading', pattern: '# $TITLE' },
    expected: [{ id: 'atx_heading#0', lines: { start: 1, end: 1 }, source: '# Title\n', captures: { TITLE: 'Title' } }],
  },
  {
    language: 'php',
    source: PHP_SOURCE,
    rule: { kind: 'function_definition', has: { kind: 'binary_expression', stopBy: 'end' } },
    expected: [
      {
        id: 'function_definition:add',
        lines: { start: 2, end: 4 },
        source: ['function add(int $a, int $b): int {', '  return $a + $b;', '}'].join('\n'),
        captures: {},
      },
    ],
  },
  {
    language: 'python',
    source: PYTHON_SOURCE,
    rule: { kind: 'function_definition', has: { pattern: 'return $NAME', stopBy: 'end' } },
    expected: [
      {
        id: 'function_definition:add_tags',
        lines: { start: 1, end: 5 },
        source: [
          'def add_tags(tags):',
          '    out = []',
          '    for tag in tags:',
          '        out.append(tag)',
          '    return out',
        ].join('\n'),
        captures: { NAME: 'out' },
      },
    ],
  },
  {
    language: 'ruby',
    source: RUBY_SOURCE,
    rule: { kind: 'method', has: { pattern: '$LEFT + $RIGHT', stopBy: 'end' } },
    expected: [
      {
        id: 'method:add',
        lines: { start: 1, end: 3 },
        source: ['def add(a, b)', '  a + b', 'end'].join('\n'),
        captures: { LEFT: 'a', RIGHT: 'b' },
      },
    ],
  },
  {
    language: 'rust',
    source: RUST_SOURCE,
    rule: { kind: 'function_item', has: { pattern: '$LEFT + $RIGHT', stopBy: 'end' } },
    expected: [
      {
        id: 'function_item:add',
        lines: { start: 1, end: 3 },
        source: ['fn add(a: i32, b: i32) -> i32 {', '    a + b', '}'].join('\n'),
        captures: { LEFT: 'a', RIGHT: 'b' },
      },
    ],
  },
  {
    language: 'scala',
    source: SCALA_SOURCE,
    rule: { kind: 'function_definition', has: { pattern: '$LEFT + $RIGHT', stopBy: 'end' } },
    expected: [
      {
        id: 'function_definition:add',
        lines: { start: 1, end: 1 },
        source: 'def add(a: Int, b: Int): Int = a + b',
        captures: { LEFT: 'a', RIGHT: 'b' },
      },
    ],
  },
  {
    language: 'sql',
    source: SQL_SOURCE,
    rule: { pattern: 'SELECT $COLS FROM $TABLE WHERE $COND' },
    expected: [
      {
        id: 'statement#0',
        lines: { start: 1, end: 1 },
        source: 'SELECT id, name FROM users WHERE active = true',
        captures: { COLS: 'id, name', TABLE: 'users', COND: 'active = true' },
      },
    ],
  },
  {
    language: 'swift',
    source: SWIFT_SOURCE,
    rule: {
      kind: 'function_declaration',
      has: { kind: 'additive_expression', pattern: '$LEFT + $RIGHT', stopBy: 'end' },
    },
    expected: [
      {
        id: 'function_declaration:add',
        lines: { start: 1, end: 3 },
        source: ['func add(_ a: Int, _ b: Int) -> Int {', '  return a + b', '}'].join('\n'),
        captures: { LEFT: 'a', RIGHT: 'b' },
      },
    ],
  },
  {
    language: 'toml',
    source: TOML_SOURCE,
    rule: { kind: 'pair', pattern: 'name = $VALUE' },
    expected: [{ id: 'pair#0', lines: { start: 2, end: 2 }, source: 'name = "store"', captures: { VALUE: '"store"' } }],
  },
  {
    language: 'yaml',
    source: YAML_SOURCE,
    rule: { kind: 'block_mapping_pair', pattern: 'name: $VALUE' },
    expected: [{ id: 'block_mapping_pair#0', lines: { start: 1, end: 1 }, source: 'name: store', captures: { VALUE: 'store' } }],
  },
  {
    language: 'css',
    source: CSS_SOURCE,
    rule: { kind: 'declaration', pattern: 'display: $VALUE;' },
    expected: [{ id: 'declaration#0', lines: { start: 1, end: 1 }, source: 'display: flex;', captures: { VALUE: 'flex' } }],
  },
  {
    language: 'html',
    source: HTML_SOURCE,
    rule: { pattern: '<div class="cart">$$$CHILDREN</div>' },
    expected: [
      {
        id: 'element#0',
        lines: { start: 1, end: 1 },
        source: '<div class="cart"><span>Store</span></div>',
        captures: { CHILDREN: ['<span>Store</span>'] },
      },
    ],
  },
  {
    language: 'javascript',
    source: JAVASCRIPT_SOURCE,
    rule: {
      kind: 'function_declaration',
      has: {
        kind: 'for_in_statement',
        stopBy: 'end',
        has: { pattern: 'out.push($ITEM)', stopBy: 'end' },
      },
    },
    expected: [{ id: 'function_declaration:collect', lines: { start: 1, end: 7 }, source: JAVASCRIPT_SOURCE, captures: { ITEM: 'value' } }],
  },
  {
    language: 'tsx',
    source: TSX_SOURCE,
    rule: { pattern: 'return <div className="card">{$CHILD}</div>;' },
    expected: [{ id: 'return_statement#0', lines: { start: 2, end: 2 }, source: 'return <div className="card">{title}</div>;', captures: { CHILD: 'title' } }],
  },
  {
    language: 'typescript',
    source: TYPESCRIPT_SOURCE,
    rule: {
      kind: 'function_declaration',
      has: { kind: 'for_statement', stopBy: 'end', has: { pattern: 'out.push($VALUE)', stopBy: 'end' } },
    },
    expected: [
      {
        id: 'function_declaration:collect',
        lines: { start: 1, end: 7 },
        source: [
          'function collect(values: number[]): number[] {',
          '  const out: number[] = [];',
          '  for (let i = 0; i < values.length; i++) {',
          '    out.push(values[i]!);',
          '  }',
          '  return out;',
          '}',
        ].join('\n'),
        captures: { VALUE: 'values[i]!' },
      },
    ],
  },
];

const CASE_BY_LANGUAGE: Record<string, LanguageCase> = {};
for (const entry of CASES) CASE_BY_LANGUAGE[entry.language] = entry;

function select(language: string, source: string, rule: Record<string, unknown>): readonly ScopeMatch[] {
  return astGrepPlugin.compile({ language, rule }).select({ filepath: 'memory.src', source });
}

test('matches with a builtin grammar without loading any bundled grammar package', () => {
  // No grammar package has been touched: not one catalog language parses yet.
  for (const language of CATALOG) assert.throws(() => parse(language, ''), Error, language);
  const javascript = CASE_BY_LANGUAGE.javascript!;
  assert.deepEqual(select('javascript', javascript.source, javascript.rule), javascript.expected);
  // ...and matching with a builtin still registered nothing.
  for (const language of CATALOG) assert.throws(() => parse(language, ''), Error, language);
});

for (const entry of CASES) {
  test(`selects ${entry.language} scopes with exact identity, source and captures`, () => {
    assert.deepEqual(select(entry.language, entry.source, entry.rule), entry.expected);
  });
}

test('selects the same scopes through an alias or a display-cased spelling as through the canonical name', () => {
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    const entry = CASE_BY_LANGUAGE[canonical]!;
    const canonicalScopes = select(canonical, entry.source, entry.rule);
    assert.deepEqual(canonicalScopes, entry.expected, canonical);
    assert.deepEqual(select(alias, entry.source, entry.rule), canonicalScopes, alias);
    assert.deepEqual(select(alias.toUpperCase(), entry.source, entry.rule), canonicalScopes, alias);
  }
  for (const entry of CASES) {
    const display = entry.language[0]!.toUpperCase() + entry.language.slice(1);
    assert.deepEqual(select(display, entry.source, entry.rule), entry.expected, display);
    assert.deepEqual(select(entry.language.toUpperCase(), entry.source, entry.rule), entry.expected, entry.language);
  }
});

test('compiles and matches several languages in one process, in any order', () => {
  const picked = ['python', 'rust', 'java', 'go'].map((language) => {
    const entry = CASE_BY_LANGUAGE[language]!;
    return { language, entry, scope: astGrepPlugin.compile({ language, rule: entry.rule }) };
  });
  const firstPass = picked.map(({ language, entry, scope }) =>
    scope.select({ filepath: `memory.${language}`, source: entry.source }),
  );
  firstPass.forEach((scopes, index) => assert.deepEqual(scopes, picked[index]!.entry.expected, picked[index]!.language));
  // Recompiled and matched in the opposite order, every language still selects only its own scopes.
  const secondPass = [...picked].reverse().map(({ language, entry }) => select(language, entry.source, entry.rule));
  assert.deepEqual(secondPass, [...firstPass].reverse());
  // The file name and extension never influence the match.
  const first = picked[0]!;
  assert.deepEqual(first.scope.select({ filepath: 'anything.txt', source: first.entry.source }), firstPass[0]);
});

test('captures a $ metavariable name in a language whose identifiers start with $', () => {
  const matches = select('php', PHP_SOURCE, { kind: 'variable_name', pattern: '$A' });
  assert.deepEqual(matches, [
    { id: 'variable_name#0', lines: { start: 2, end: 2 }, source: '$a', captures: { A: '$a' } },
    { id: 'variable_name#1', lines: { start: 2, end: 2 }, source: '$b', captures: { A: '$b' } },
    { id: 'variable_name#2', lines: { start: 3, end: 3 }, source: '$a', captures: { A: '$a' } },
    { id: 'variable_name#3', lines: { start: 3, end: 3 }, source: '$b', captures: { A: '$b' } },
  ]);
});
