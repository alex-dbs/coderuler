import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { astGrep } from '../dist/adapter/scope/astgrep.js';
import {
  createAstGrepLanguageRegistrations,
  resolveAstGrepLanguage,
} from '../dist/adapter/scope/astgrep-languages.js';
import { SourceLines, textLineSpan } from '../dist/adapter/scope/lines.js';
import { protobuf } from '../dist/adapter/scope/protobuf.js';
import type { JsonValue, ScopeMatch, ScopeSelector } from '../dist/index.js';

type LineSpan = NonNullable<ScopeMatch['lines']>;

interface MatchProjection {
  readonly id: string;
  readonly source: string;
  readonly lines?: LineSpan;
  readonly data?: JsonValue;
  readonly captures?: Readonly<Record<string, string | readonly string[]>>;
}

type AstGrepOptions = Parameters<typeof astGrep>[0];

function astGrepWith(options: Record<string, unknown>): ScopeSelector<JsonValue> {
  return astGrep(options as unknown as AstGrepOptions);
}

async function select(
  selector: ScopeSelector<JsonValue>,
  filepath: string,
  source: string,
): Promise<readonly MatchProjection[]> {
  const matches = await selector({ filepath, source });
  return matches.map((match) => {
    const projection: {
      id: string;
      source: string;
      lines?: LineSpan;
      data?: JsonValue;
      captures?: Readonly<Record<string, string | readonly string[]>>;
    } = { id: match.id, source: match.source };
    if (match.lines !== undefined) projection.lines = match.lines;
    if (match.data !== undefined) projection.data = match.data;
    if (match.captures !== undefined) projection.captures = match.captures;
    return projection;
  });
}

async function selectionError(
  selector: ScopeSelector<JsonValue>,
  filepath: string,
  source: string,
): Promise<string> {
  try {
    await selector({ filepath, source });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

function caughtError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected the call to throw');
}

test('SourceLines reports 1-based inclusive lines and drops trailing record separators', () => {
  const lines = new SourceLines('a\r\nb\rc\nd');
  assert.deepEqual(lines.span(0, 1), { start: 1, end: 1 });
  assert.deepEqual(lines.span(3, 4), { start: 2, end: 2 });
  assert.deepEqual(lines.span(5, 6), { start: 3, end: 3 });
  assert.deepEqual(lines.span(7, 8), { start: 4, end: 4 });
  assert.deepEqual(lines.span(0, 3), { start: 1, end: 1 }, 'a CRLF separator belongs to the line it ends');
  assert.deepEqual(lines.span(3, 5), { start: 2, end: 2 }, 'a lone CR separator belongs to the line it ends');
  assert.deepEqual(lines.span(0, 8), { start: 1, end: 4 });
  assert.deepEqual(lines.span(0, 0), { start: 1, end: 1 }, 'an empty range collapses to its start line');

  assert.deepEqual(new SourceLines('').span(0, 0), { start: 1, end: 1 });
  assert.deepEqual(new SourceLines('x').span(0, 1), { start: 1, end: 1 });
  assert.deepEqual(new SourceLines('a\nb').span(0, 2), { start: 1, end: 1 });
  assert.deepEqual(new SourceLines('a\r\nb').span(0, 3), { start: 1, end: 1 });
  assert.deepEqual(new SourceLines('a\r\nb').span(3, 4), { start: 2, end: 2 });
  assert.deepEqual(new SourceLines('a\n\nb').span(0, 3), { start: 1, end: 2 });
  assert.deepEqual(new SourceLines('a\n\nb').span(3, 4), { start: 3, end: 3 });
});

test('textLineSpan counts line breaks from a start line for LF, CRLF, and lone CR', () => {
  assert.deepEqual(textLineSpan(1, 'one line'), { start: 1, end: 1 });
  assert.deepEqual(textLineSpan(4, 'func f() {\n\tx\n}'), { start: 4, end: 6 });
  assert.deepEqual(textLineSpan(2, 'a\n'), { start: 2, end: 2 });
  assert.deepEqual(textLineSpan(2, 'a\r\n'), { start: 2, end: 2 });
  assert.deepEqual(textLineSpan(2, 'a\r'), { start: 2, end: 2 });
  assert.deepEqual(textLineSpan(7, 'a\r\nb\rc\nd'), { start: 7, end: 10 });
  assert.deepEqual(textLineSpan(3, ''), { start: 3, end: 3 });
  assert.deepEqual(
    textLineSpan(5, '\n\n'),
    { start: 5, end: 6 },
    'only the final record separator is dropped, never a meaningful blank line',
  );
  assert.deepEqual(textLineSpan(1, '\n\n\n'), { start: 1, end: 3 }, 'three breaks lose one separator and keep two blank lines');
  assert.deepEqual(textLineSpan(1, '\n\n'), new SourceLines('\n\n').span(0, 2), 'both helpers count the same lines');
  assert.deepEqual(textLineSpan(9, 'x\r\n'), { start: 9, end: 9 });
  assert.deepEqual(textLineSpan(1, 'a\n\rb'), { start: 1, end: 3 });
  assert.deepEqual(textLineSpan(1, 'a\n\rb'), new SourceLines('a\n\rb').span(0, 4));
});

const GO_SOURCE = `package store

type Cart struct {
\titems []string
}

func addTags(tags []string) []string {
\tout := make([]string, len(tags))
\tfor _, tag := range tags {
\t\tout = append(out, tag)
\t}
\treturn out
}

func (c *Cart) Add(items ...string) {
\tc.items = make([]string, 0, len(items))
\tfor _, item := range items {
\t\tc.items = append(c.items, item)
\t}
}

func (c *Cart) Remove(items ...string) {
\tfor _, item := range items {
\t\tc.items = append(c.items, item)
\t}
}
`;

const GO_DUPLICATE_NAMES = `package store

func helper(values []int) []int {
\tout := []int{}
\tfor _, v := range values {
\t\tout = append(out, v)
\t}
\treturn out
}

func helper(values []int) []int {
\tout := []int{}
\tfor _, v := range values {
\t\tout = append(out, v)
\t}
\treturn out
}

func helperFull(values []int) []int {
\treturn values
}
`;

const TS_NESTED = `function outer() {
  function inner() {
    return 1;
  }
  return inner();
}
`;

function appendDeclarations(): ScopeSelector<JsonValue> {
  return astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: { pattern: 'append($SLICE, $$$ARGS)', stopBy: 'end' },
    },
  });
}

test('ast-grep selects Go functions and methods with receiver identities and captures', async () => {
  assert.deepEqual(await select(appendDeclarations(), 'internal/store/cart.go', GO_SOURCE), [
    {
      id: 'function_declaration:addTags',
      source:
        'func addTags(tags []string) []string {\n\tout := make([]string, len(tags))\n\tfor _, tag := range tags {\n\t\tout = append(out, tag)\n\t}\n\treturn out\n}',
      captures: { SLICE: 'out', ARGS: ['tag'] },
      lines: { start: 7, end: 13 },
    },
    {
      id: 'method_declaration:Cart.Add',
      source:
        'func (c *Cart) Add(items ...string) {\n\tc.items = make([]string, 0, len(items))\n\tfor _, item := range items {\n\t\tc.items = append(c.items, item)\n\t}\n}',
      captures: { SLICE: 'c.items', ARGS: ['item'] },
      lines: { start: 15, end: 20 },
    },
    {
      id: 'method_declaration:Cart.Remove',
      source:
        'func (c *Cart) Remove(items ...string) {\n\tfor _, item := range items {\n\t\tc.items = append(c.items, item)\n\t}\n}',
      captures: { SLICE: 'c.items', ARGS: ['item'] },
      lines: { start: 22, end: 26 },
    },
  ]);
});

test('ast-grep disambiguates repeated declaration identities with collision suffixes', async () => {
  const matches = await select(appendDeclarations(), 'internal/store/helpers.go', GO_DUPLICATE_NAMES);
  assert.deepEqual(
    matches.map((match) => match.id),
    ['function_declaration:helper', 'function_declaration:helper#1'],
  );
  assert.deepEqual(
    matches.map((match) => match.lines),
    [
      { start: 3, end: 9 },
      { start: 11, end: 17 },
    ],
  );
  assert.equal(new Set(matches.map((match) => match.id)).size, matches.length);
  assert.deepEqual(matches[0]?.captures, { SLICE: 'out', ARGS: ['v'] });
  assert.deepEqual(matches[1]?.captures, { SLICE: 'out', ARGS: ['v'] });
  assert.equal(matches[0]?.source, matches[1]?.source, 'only the identity differs, never the text');
});

test('ast-grep composes nested declaration identities and omits absent data', async () => {
  const matches = await select(
    astGrep({ language: 'typescript', rule: { kind: 'function_declaration' } }),
    'src/nested.ts',
    TS_NESTED,
  );
  assert.equal(matches[0]?.data, undefined, 'ast-grep scopes carry no data payload');
  assert.deepEqual(matches, [
    {
      id: 'function_declaration:outer',
      source: 'function outer() {\n  function inner() {\n    return 1;\n  }\n  return inner();\n}',
      captures: {},
      lines: { start: 1, end: 6 },
    },
    {
      id: 'function_declaration:outer/function_declaration:inner',
      source: 'function inner() {\n    return 1;\n  }',
      captures: {},
      lines: { start: 2, end: 4 },
    },
  ]);
});

test('ast-grep uses TypeScript for angle assertions and TSX for JSX calls by filepath', async () => {
  const selector = astGrep({
    language: 'typescript',
    rule: { pattern: '$FUNCTION($$$ARGS)' },
  });
  const fixtures = [
    { filepath: 'value.ts', source: 'const value = <number>read(input);', functionName: 'read', args: ['input'] },
    { filepath: 'value.mts', source: 'const value = <number>read(input);', functionName: 'read', args: ['input'] },
    { filepath: 'value.cts', source: 'const value = <number>read(input);', functionName: 'read', args: ['input'] },
    { filepath: 'view.tsx', source: 'const view = <Widget title={format(name)} />;', functionName: 'format', args: ['name'] },
  ];

  for (const { filepath, source, functionName, args } of fixtures) {
    const matches = await select(selector, filepath, source);
    assert.deepEqual(matches.map(match => match.captures), [{ FUNCTION: functionName, ARGS: args }], filepath);
    assert.deepEqual(matches.map(match => match.lines), [{ start: 1, end: 1 }], filepath);
  }
});

test('ast-grep dispatches TypeScript aliases but preserves explicitly selected other grammars', async () => {
  const aliased = astGrep({ language: 'TS', rule: { pattern: '$FUNCTION($$$ARGS)' } });
  const fixedTsx = astGrep({ language: 'tsx', rule: { pattern: '$FUNCTION($$$ARGS)' } });
  const fixedGo = astGrep({ language: 'go', rule: { pattern: 'append($SLICE, $$$ARGS)' } });
  const jsx = 'const view = <Widget title={format(name)} />;';
  assert.deepEqual(
    (await select(aliased, 'view.tsx', jsx)).map(match => match.captures),
    [{ FUNCTION: 'format', ARGS: ['name'] }],
  );
  assert.deepEqual(
    (await select(fixedTsx, 'view.ts', jsx)).map(match => match.captures),
    [{ FUNCTION: 'format', ARGS: ['name'] }],
  );
  assert.deepEqual(
    (await select(fixedGo, 'values.tsx', 'package example\nvar values = append(items, next)'))
      .map(match => match.captures),
    [{ SLICE: 'items', ARGS: ['next'] }],
  );
});

test('ast-grep TSX overrides replace rules, utilities, constraints, and capture names together', async () => {
  const selector = astGrep({
    language: 'typescript',
    rule: { matches: 'ANGLE' },
    utils: { ANGLE: { kind: 'type_assertion', pattern: '<number>$VALUE' } },
    constraints: { VALUE: { regex: '^read\\(' } },
    tsx: {
      rule: { matches: 'CALL' },
      utils: { CALL: { pattern: '$FUNCTION($$$ARGS)' } },
      constraints: { FUNCTION: { regex: '^format$' } },
    },
  });

  assert.deepEqual(
    (await select(selector, 'value.ts', 'const first = <number>read();\nconst second = <number>ignore();'))
      .map(match => ({ captures: match.captures, lines: match.lines })),
    [{ captures: { VALUE: 'read()' }, lines: { start: 1, end: 1 } }],
  );
  assert.deepEqual(
    (await select(selector, 'view.tsx', 'const view = <Widget title={format(name)} other={ignore()} />;'))
      .map(match => ({ captures: match.captures, lines: match.lines })),
    [{ captures: { FUNCTION: 'format', ARGS: ['name'] }, lines: { start: 1, end: 1 } }],
  );
});

test('ast-grep rejects malformed or inapplicable TSX overrides before selection', () => {
  const base = { language: 'typescript', rule: { kind: 'call_expression' } };
  for (const tsx of [
    null,
    [],
    {},
    { rule: [] },
    { rule: { kind: 'call_expression' }, constraints: [] },
    { rule: { kind: 'call_expression' }, utils: null },
    { rule: { kind: 'type_assertion' } },
  ]) {
    assert.throws(() => astGrepWith({ ...base, tsx }));
  }
  assert.throws(() => astGrepWith({
    language: 'go',
    rule: { kind: 'function_declaration' },
    tsx: { rule: { kind: 'call_expression' } },
  }));
});

test('ast-grep omits anonymous metavariables from captures', async () => {
  assert.deepEqual(
    await select(astGrep({ language: 'go', rule: { pattern: 'append($_, $_A)' } }), 'internal/store/cart.go', GO_SOURCE),
    [
      {
        id: 'call_expression#0',
        source: 'append(out, tag)',
        captures: {},
        lines: { start: 10, end: 10 },
      },
      {
        id: 'call_expression#1',
        source: 'append(c.items, item)',
        captures: {},
        lines: { start: 18, end: 18 },
      },
      {
        id: 'call_expression#2',
        source: 'append(c.items, item)',
        captures: {},
        lines: { start: 24, end: 24 },
      },
    ],
  );
});

test('ast-grep collects captures declared inside utils', async () => {
  const selector = astGrep({
    language: 'go',
    rule: { matches: 'APPEND' },
    utils: { APPEND: { pattern: 'append($SLICE, $$$ARGS)' } },
  });
  assert.deepEqual(await select(selector, 'internal/store/cart.go', GO_SOURCE), [
    {
      id: 'call_expression#0',
      source: 'append(out, tag)',
      captures: { SLICE: 'out', ARGS: ['tag'] },
      lines: { start: 10, end: 10 },
    },
    {
      id: 'call_expression#1',
      source: 'append(c.items, item)',
      captures: { SLICE: 'c.items', ARGS: ['item'] },
      lines: { start: 18, end: 18 },
    },
    {
      id: 'call_expression#2',
      source: 'append(c.items, item)',
      captures: { SLICE: 'c.items', ARGS: ['item'] },
      lines: { start: 24, end: 24 },
    },
  ]);
});

test('ast-grep forwards constraints to the native query', async () => {
  const constrained = astGrep({
    language: 'go',
    rule: { pattern: 'append($SLICE, $$$ARGS)' },
    constraints: { SLICE: { regex: '^c\\.' } },
  });
  assert.deepEqual(await select(constrained, 'internal/store/cart.go', GO_SOURCE), [
    {
      id: 'call_expression#0',
      source: 'append(c.items, item)',
      captures: { SLICE: 'c.items', ARGS: ['item'] },
      lines: { start: 18, end: 18 },
    },
    {
      id: 'call_expression#1',
      source: 'append(c.items, item)',
      captures: { SLICE: 'c.items', ARGS: ['item'] },
      lines: { start: 24, end: 24 },
    },
  ]);

  const kinded = astGrep({
    language: 'go',
    rule: { pattern: 'append($SLICE, $$$ARGS)' },
    constraints: { SLICE: { kind: 'selector_expression' } },
  });
  assert.deepEqual(await select(kinded, 'internal/store/cart.go', GO_SOURCE), [
    {
      id: 'call_expression#0',
      source: 'append(c.items, item)',
      captures: { SLICE: 'c.items', ARGS: ['item'] },
      lines: { start: 18, end: 18 },
    },
    {
      id: 'call_expression#1',
      source: 'append(c.items, item)',
      captures: { SLICE: 'c.items', ARGS: ['item'] },
      lines: { start: 24, end: 24 },
    },
  ]);
});

test('ast-grep keeps CRLF source text verbatim and counts those lines once', async () => {
  const source = `package store\n\nfunc addTags(tags []string) []string {\n\tout := make([]string, len(tags))\n\tfor _, tag := range tags {\n\t\tout = append(out, tag)\n\t}\n\treturn out\n}\n`.replaceAll(
    '\n',
    '\r\n',
  );
  assert.deepEqual(await select(appendDeclarations(), 'internal/store/cart.go', source), [
    {
      id: 'function_declaration:addTags',
      source:
        'func addTags(tags []string) []string {\r\n\tout := make([]string, len(tags))\r\n\tfor _, tag := range tags {\r\n\t\tout = append(out, tag)\r\n\t}\r\n\treturn out\r\n}',
      captures: { SLICE: 'out', ARGS: ['tag'] },
      lines: { start: 3, end: 9 },
    },
  ]);
});

const NATIVE_LANGUAGES: readonly string[] = ['css', 'html', 'javascript', 'tsx', 'typescript'];

const PACKAGED_LANGUAGES: readonly string[] = [
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

const LANGUAGE_ALIASES: readonly (readonly [string, string])[] = [
  ['cc', 'cpp'],
  ['c++', 'cpp'],
  ['cxx', 'cpp'],
  ['cs', 'csharp'],
  ['ex', 'elixir'],
  ['golang', 'go'],
  ['hs', 'haskell'],
  ['kt', 'kotlin'],
  ['md', 'markdown'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['rs', 'rust'],
  ['yml', 'yaml'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['ts', 'typescript'],
];

test('ast-grep resolves every catalog language name and alias to its parser language', () => {
  const catalog = [...NATIVE_LANGUAGES, ...PACKAGED_LANGUAGES];
  assert.equal(catalog.length, 31, 'five native plus twenty-six packaged languages');
  for (const language of catalog) {
    assert.equal(resolveAstGrepLanguage(language), language, language);
  }
  for (const [alias, canonical] of LANGUAGE_ALIASES) {
    assert.equal(resolveAstGrepLanguage(alias), canonical, alias);
    assert.equal(resolveAstGrepLanguage(alias.toUpperCase()), canonical, alias.toUpperCase());
  }
  assert.equal(resolveAstGrepLanguage('JavaScript'), 'javascript');
  assert.equal(resolveAstGrepLanguage('TSX'), 'tsx');
});

test('ast-grep leaves unknown language names for host-registered grammars', () => {
  assert.equal(resolveAstGrepLanguage('my-in-house-grammar'), 'my-in-house-grammar');
  assert.equal(resolveAstGrepLanguage('CustomLang'), 'CustomLang');
  assert.equal(resolveAstGrepLanguage('toString'), 'toString');
  assert.equal(resolveAstGrepLanguage('constructor'), 'constructor');
});

test('ast-grep registration record covers exactly the packaged grammars', () => {
  assert.deepEqual(Object.keys(createAstGrepLanguageRegistrations()).sort(), [...PACKAGED_LANGUAGES].sort());
});

test('ast-grep builds a working selector for every catalog language', async () => {
  for (const language of [...NATIVE_LANGUAGES, ...PACKAGED_LANGUAGES]) {
    const matches = await select(astGrep({ language, rule: { regex: 'x' } }), `fixture.${language}`, 'x');
    assert.ok(matches.length >= 1, `${language} returned no matches`);
    assert.deepEqual(matches.filter((match) => match.source === ''), [], `${language} produced an empty source`);
  }
});

test('ast-grep rejects malformed options and invalid native queries on construction', () => {
  assert.equal(
    caughtError(() => astGrepWith({ language: '', rule: { kind: 'function_declaration' } })).message,
    'ast-grep scope option language must be a non-empty string',
  );
  assert.match(caughtError(() => astGrepWith({ language: 'go', rule: { kind: 5 } })).message, /invalid type/);
  assert.equal(
    caughtError(() => astGrepWith({ language: 'go', rule: [] })).message,
    'ast-grep scope option rule must be a mapping',
  );
  assert.equal(
    caughtError(() => astGrepWith({ language: 'go', rule: { kind: 'x' }, constraints: [] })).message,
    'ast-grep scope option constraints must be a mapping',
  );
  assert.equal(
    caughtError(() => astGrepWith({ language: 'go', rule: { kind: 'x' }, utils: 5 })).message,
    'ast-grep scope option utils must be a mapping',
  );
  assert.match(
    caughtError(() => astGrepWith({ language: 'not-a-language', rule: { kind: 'x' } })).message,
    /not-a-language is not supported/,
  );
  assert.match(caughtError(() => astGrepWith({ language: 'go', rule: { regex: '(' } })).message, /regex/);
});

test('ast-grep reports an unusable one-shot registration instead of silently degrading', () => {
  const requireFromHere = createRequire(import.meta.url);
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const script = `
import { createRequire } from 'node:module';
import { parse, registerDynamicLanguage } from ${JSON.stringify(requireFromHere.resolve('@ast-grep/napi'))};
const requireFromTest = createRequire(${JSON.stringify(import.meta.url)});
const { resolveAstGrepLanguage } = await import(${JSON.stringify(
    new URL('../dist/adapter/scope/astgrep-languages.js', import.meta.url).href,
  )});
registerDynamicLanguage({ c: requireFromTest(${JSON.stringify(requireFromHere.resolve('@ast-grep/lang-c'))}) });
const host = { resolved: resolveAstGrepLanguage('c'), kind: parse('c', 'int main() {}').root().kind() };
let diagnostic = null;
try {
  resolveAstGrepLanguage('go');
} catch (error) {
  diagnostic = { name: error.name, message: error.message };
}
console.log(JSON.stringify({ host, diagnostic }));
`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('RK_') || key.startsWith('TYPESAFE_')) continue;
    env[key] = value;
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    host: { resolved: string; kind: string };
    diagnostic: { name: string; message: string } | null;
  };
  assert.equal(output.host.resolved, 'c');
  assert.equal(output.host.kind.length > 0, true, 'the host grammar keeps working');
  assert.ok(output.diagnostic, 'resolving a bundled language must fail loudly');
  assert.match(output.diagnostic.message, /already been called earlier in this process/);
  assert.match(output.diagnostic.message, /createAstGrepLanguageRegistrations/);
  assert.match(output.diagnostic.message, /'go'/);
});

const PROTO_MULTI = `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {
    option (google.api.http) = {
      get: "/v1/billing/invoices/{invoice_id}"
    };
  }

  rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);

  rpc CreateInvoice(CreateInvoiceRequest) returns (CreateInvoiceResponse) {
    option (google.api.http) = {
      post: "/v1/billing/invoices"
      additional_bindings {
        get: "/v1/billing/invoices/{invoice_id}/items"
      }
    };
  }
}
`;

const PROTO_UNANNOTATED = `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);
}
`;
test('protobuf maps root and empty-option source spans around unannotated RPCs', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$' }), 'unannotated.proto', PROTO_UNANNOTATED), [
    { id: '$', source: PROTO_UNANNOTATED, lines: { start: 1, end: 7 }, data: { options: {}, services: [{ id: 'acme.billing.v1.BillingService', name: 'BillingService', parent: null, options: {} }], rpcs: [rpcRecord('StreamInvoices', {})], messages: [], fields: [], oneofs: [], enums: [], enumValues: [], extensions: [] } },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs' }), 'unannotated.proto', PROTO_UNANNOTATED), [
    { id: '/rpcs', source: PROTO_UNANNOTATED, lines: { start: 1, end: 7 }, data: [rpcRecord('StreamInvoices', {})] },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*].id' }), 'unannotated.proto', PROTO_UNANNOTATED), [
    { id: 'acme.billing.v1.BillingService.StreamInvoices:/id', source: 'rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);', lines: { start: 6, end: 6 }, data: 'acme.billing.v1.BillingService.StreamInvoices' },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*].options' }), 'unannotated.proto', PROTO_UNANNOTATED), [
    { id: 'acme.billing.v1.BillingService.StreamInvoices:/options', source: 'rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);', lines: { start: 6, end: 6 }, data: {} },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*].options.*' }), 'unannotated.proto', PROTO_UNANNOTATED), []);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*].name' }), 'unannotated.proto', PROTO_UNANNOTATED), [
    { id: 'acme.billing.v1.BillingService.StreamInvoices:/name', source: 'StreamInvoices', lines: { start: 6, end: 6 }, data: 'StreamInvoices' },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*]' }), 'empty.proto', PROTO_NO_RPCS), []);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$' }), 'empty.proto', PROTO_NO_RPCS), [
    { id: '$', source: PROTO_NO_RPCS, lines: { start: 1, end: 3 }, data: { options: {}, services: [], rpcs: [], messages: [], fields: [], oneofs: [], enums: [], enumValues: [], extensions: [] } },
  ]);
});


const PROTO_NO_RPCS = `syntax = "proto3";

package acme.billing.v1;
`;

const PROTO_UNVALIDATED = `syntax = "proto3";

import "acme/unknown/v1/types.proto";

package acme.billing.v1;

message Invoice {
  unknown_field_type id = 1;
}

service BillingService {
  option (my.custom.service_option) = true;

  rpc GetInvoice(NonexistentRequest) returns (stream NonexistentResponse) {
    option (google.api.http) = {
      get: "/v1/billing/invoices"
      body: "*"
    };
    option (my.custom.method_option).value = 42;
  }
}
`;

const PROTO_PLAIN_LINES = [
  'syntax = "proto3";',
  'package acme.billing.v1;',
  'service BillingService {',
  '  rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {',
  '    option (google.api.http) = {',
  '      get: "/v1/billing/invoices"',
  '    };',
  '  }',
  '}',
].join('\n').concat('\n');

const PROTO_CR = PROTO_PLAIN_LINES.replaceAll('\n', '\r');
const PROTO_CRLF = PROTO_PLAIN_LINES.replaceAll('\n', '\r\n');

function rpcRecord(name: string, options: JsonValue): JsonValue {
  return { id: `acme.billing.v1.BillingService.${name}`, name, parent: 'acme.billing.v1.BillingService', options };
}

function protoRecord(id: string, name: string, parent: string | null, options: JsonValue): JsonValue {
  return { id, name, parent, options };
}

test('protobuf selects RPC records by default', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>(), 'proto/billing/v1/invoice.proto', PROTO_MULTI), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice',
      source:
        'rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {\n    option (google.api.http) = {\n      get: "/v1/billing/invoices/{invoice_id}"\n    };\n  }',
      lines: { start: 6, end: 10 },
      data: rpcRecord('GetInvoice', { 'google.api.http': { get: '/v1/billing/invoices/{invoice_id}' } }),
    },
    {
      id: 'acme.billing.v1.BillingService.StreamInvoices',
      source: 'rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);',
      lines: { start: 12, end: 12 },
      data: rpcRecord('StreamInvoices', {}),
    },
    {
      id: 'acme.billing.v1.BillingService.CreateInvoice',
      source:
        'rpc CreateInvoice(CreateInvoiceRequest) returns (CreateInvoiceResponse) {\n    option (google.api.http) = {\n      post: "/v1/billing/invoices"\n      additional_bindings {\n        get: "/v1/billing/invoices/{invoice_id}/items"\n      }\n    };\n  }',
      lines: { start: 14, end: 21 },
      data: rpcRecord('CreateInvoice', { 'google.api.http': { post: '/v1/billing/invoices', additional_bindings: { get: '/v1/billing/invoices/{invoice_id}/items' } } }),
    },
  ]);
});

const PROTO_PROTOTYPE_KEYS = `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc Block(BlockRequest) returns (BlockResponse) {
    option (google.api.http) = {
      get: "/v1/get"
      post: "/v1/post"
      put: "/v1/put"
      delete: "/v1/delete"
      patch: "/v1/patch"
      __proto__: "/v1/proto"
      toString: "/v1/string"
      constructor: "/v1/constructor"
      valueOf: "/v1/value"
      hasOwnProperty: "/v1/own"
      foo: "/v1/unknown"
    };
  }

  rpc Dotted(DottedRequest) returns (DottedResponse) {
    option (google.api.http).toString = "/v1/dotted-string";
    option (google.api.http).__proto__ = "/v1/dotted-proto";
    option (google.api.http).patch = "/v1/dotted-patch";
  }
}
`;

test('protobuf keeps prototype-named option keys as own data', async () => {
  const values = await select(protobuf<JsonValue>({ path: "$.rpcs[0].options['google.api.http']" }), 'prototype.proto', PROTO_PROTOTYPE_KEYS);
  const first = values[0]?.data;
  assert.ok(first && typeof first === 'object' && !Array.isArray(first));
  assert.deepEqual(Object.keys(first), ['get', 'post', 'put', 'delete', 'patch', '__proto__', 'toString', 'constructor', 'valueOf', 'hasOwnProperty', 'foo']);
  assert.equal(Object.getPrototypeOf(first), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(first, '__proto__')?.value, '/v1/proto');
  const second = (await select(protobuf<JsonValue>({ path: "$.rpcs[1].options['google.api.http']" }), 'prototype.proto', PROTO_PROTOTYPE_KEYS))[0]?.data;
  assert.ok(second && typeof second === 'object' && !Array.isArray(second));
  assert.deepEqual(Object.keys(second), ['toString', '__proto__', 'patch']);
});

test('protobuf extracts declarations without validating imports, types, or unknown options', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>(), 'x.proto', PROTO_UNVALIDATED), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice',
      source:
        'rpc GetInvoice(NonexistentRequest) returns (stream NonexistentResponse) {\n    option (google.api.http) = {\n      get: "/v1/billing/invoices"\n      body: "*"\n    };\n    option (my.custom.method_option).value = 42;\n  }',
      lines: { start: 14, end: 20 },
      data: rpcRecord('GetInvoice', { 'google.api.http': { get: '/v1/billing/invoices', body: '*' }, 'my.custom.method_option': { value: 42 } }),
    },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.services[*].options' }), 'x.proto', PROTO_UNVALIDATED), [
    { id: 'acme.billing.v1.BillingService:/options', source: 'option (my.custom.service_option) = true;', lines: { start: 12, end: 12 }, data: { 'my.custom.service_option': true } },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.fields[*].id' }), 'x.proto', PROTO_UNVALIDATED), [
    { id: 'acme.billing.v1.Invoice.id:/id', source: 'unknown_field_type id = 1;', lines: { start: 8, end: 8 }, data: 'acme.billing.v1.Invoice.id' },
  ]);
});

const PROTO_EVERYWHERE = `syntax = "proto3";

package acme.billing.v1;

option go_package = "acme/billing/v1;billingv1";
option (acme.file_owner) = "billing";

service BillingService {
  option (acme.service_tier) = 1;

  rpc GetInvoice(GetInvoiceRequest) returns (Invoice) {
    option deprecated = true;
  }
}

message Invoice {
  option (acme.table) = { name: "invoices" shard: 4 };

  string id = 1 [(validate.rules).string.uuid = true, deprecated = true];
  map<string, string> labels = 2 [(acme.redact) = true];

  oneof payer {
    option (acme.required_oneof) = true;
    string customer_id = 3 [(acme.ref) = "Customer"];
  }

  message Line {
    int64 amount = 1 [(validate.rules).int64 = { gte: -5, lte: 1e3 }];
  }

  enum Status {
    option allow_alias = true;
    STATUS_UNSPECIFIED = 0;
    STATUS_PAID = 1 [(acme.label) = "Paid"];
  }
}

extend google.protobuf.MethodOptions {
  Route route = 50001 [(acme.internal) = true];
}
`;

test('protobuf reads options on every declaration kind', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.options' }), 'everywhere.proto', PROTO_EVERYWHERE), [
    { id: '/options', source: 'option go_package = "acme/billing/v1;billingv1";\noption (acme.file_owner) = "billing";', lines: { start: 5, end: 6 }, data: { go_package: 'acme/billing/v1;billingv1', 'acme.file_owner': 'billing' } },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.services[*]' }), 'everywhere.proto', PROTO_EVERYWHERE), [
    { id: 'acme.billing.v1.BillingService', source: 'service BillingService {\n  option (acme.service_tier) = 1;\n\n  rpc GetInvoice(GetInvoiceRequest) returns (Invoice) {\n    option deprecated = true;\n  }\n}', lines: { start: 8, end: 14 }, data: protoRecord('acme.billing.v1.BillingService', 'BillingService', null, { 'acme.service_tier': 1 }) },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*].options.deprecated' }), 'everywhere.proto', PROTO_EVERYWHERE), [
    { id: 'acme.billing.v1.BillingService.GetInvoice:/options/deprecated', source: 'true', lines: { start: 12, end: 12 }, data: true },
  ]);

  const declarations: Readonly<Record<string, readonly { id: string; name: string; parent: string | null; options: JsonValue; lines: LineSpan }[]>> = {
    messages: [
      { id: 'acme.billing.v1.Invoice', name: 'Invoice', parent: null, options: { 'acme.table': { name: 'invoices', shard: 4 } }, lines: { start: 16, end: 36 } },
      { id: 'acme.billing.v1.Invoice.Line', name: 'Line', parent: 'acme.billing.v1.Invoice', options: {}, lines: { start: 27, end: 29 } },
    ],
    fields: [
      { id: 'acme.billing.v1.Invoice.id', name: 'id', parent: 'acme.billing.v1.Invoice', options: { 'validate.rules': { string: { uuid: true } }, deprecated: true }, lines: { start: 19, end: 19 } },
      { id: 'acme.billing.v1.Invoice.labels', name: 'labels', parent: 'acme.billing.v1.Invoice', options: { 'acme.redact': true }, lines: { start: 20, end: 20 } },
      { id: 'acme.billing.v1.Invoice.customer_id', name: 'customer_id', parent: 'acme.billing.v1.Invoice', options: { 'acme.ref': 'Customer' }, lines: { start: 24, end: 24 } },
      { id: 'acme.billing.v1.Invoice.Line.amount', name: 'amount', parent: 'acme.billing.v1.Invoice.Line', options: { 'validate.rules': { int64: { gte: -5, lte: 1000 } } }, lines: { start: 28, end: 28 } },
    ],
    oneofs: [
      { id: 'acme.billing.v1.Invoice.payer', name: 'payer', parent: 'acme.billing.v1.Invoice', options: { 'acme.required_oneof': true }, lines: { start: 22, end: 25 } },
    ],
    enums: [
      { id: 'acme.billing.v1.Invoice.Status', name: 'Status', parent: 'acme.billing.v1.Invoice', options: { allow_alias: true }, lines: { start: 31, end: 35 } },
    ],
    enumValues: [
      { id: 'acme.billing.v1.Invoice.Status.STATUS_UNSPECIFIED', name: 'STATUS_UNSPECIFIED', parent: 'acme.billing.v1.Invoice.Status', options: {}, lines: { start: 33, end: 33 } },
      { id: 'acme.billing.v1.Invoice.Status.STATUS_PAID', name: 'STATUS_PAID', parent: 'acme.billing.v1.Invoice.Status', options: { 'acme.label': 'Paid' }, lines: { start: 34, end: 34 } },
    ],
    extensions: [
      { id: 'acme.billing.v1.route', name: 'route', parent: null, options: { 'acme.internal': true }, lines: { start: 39, end: 39 } },
    ],
  };
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.extensions[0]' }), 'everywhere.proto', PROTO_EVERYWHERE), [
    { id: 'acme.billing.v1.route', source: 'Route route = 50001 [(acme.internal) = true];', lines: { start: 39, end: 39 }, data: protoRecord('acme.billing.v1.route', 'route', null, { 'acme.internal': true }) },
  ]);
  for (const [list, expected] of Object.entries(declarations)) {
    const matches = await select(protobuf<JsonValue>({ path: `$.${list}[*]` }), 'everywhere.proto', PROTO_EVERYWHERE);
    assert.deepEqual(matches.map(({ id, lines, data }) => ({ id, lines, data })), expected.map(({ id, name, parent, options, lines }) => ({ id, lines, data: protoRecord(id, name, parent, options) })), list);
  }
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.fields[0].options['validate.rules']" }), 'everywhere.proto', PROTO_EVERYWHERE), [
    { id: 'acme.billing.v1.Invoice.id:/options/validate.rules', source: '(validate.rules).string.uuid = true', lines: { start: 19, end: 19 }, data: { string: { uuid: true } } },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.fields[0].options['validate.rules'].string.uuid" }), 'everywhere.proto', PROTO_EVERYWHERE), [
    { id: 'acme.billing.v1.Invoice.id:/options/validate.rules/string/uuid', source: 'true', lines: { start: 19, end: 19 }, data: true },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.fields[0].options' }), 'everywhere.proto', PROTO_EVERYWHERE), [
    { id: 'acme.billing.v1.Invoice.id:/options', source: '(validate.rules).string.uuid = true, deprecated = true', lines: { start: 19, end: 19 }, data: { 'validate.rules': { string: { uuid: true } }, deprecated: true } },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.messages[0].options['acme.table']" }), 'everywhere.proto', PROTO_EVERYWHERE), [
    { id: 'acme.billing.v1.Invoice:/options/acme.table', source: '{ name: "invoices" shard: 4 }', lines: { start: 17, end: 17 }, data: { name: 'invoices', shard: 4 } },
  ]);
});

const PROTO_VALUES = `syntax = "proto2";

package acme.values;

message Holder {
  option (acme.values) = {
    text: "a" 'b' "\\x41\\u00e9"
    count: -42
    big: 9223372036854775807
    hex: 0x1F
    octal: 017
    ratio: .5
    tiny: -1e-5
    flag: false
    level: LEVEL_HIGH
    limit: -inf
    tags: ["x", "y"]
    empty: []
    item { id: 1 }
    item: { id: 2 }
    [acme.ext.note]: "n"
    any { [type.googleapis.com/acme.Thing] { id: 3 } }
  };
  optional group Result = 1 [deprecated = true] {
    optional string url = 2;
  }
}
`;

test('protobuf converts option values without a schema', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.messages[0].options['acme.values']" }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder:/options/acme.values', source: '{\n    text: "a" \'b\' "\\x41\\u00e9"\n    count: -42\n    big: 9223372036854775807\n    hex: 0x1F\n    octal: 017\n    ratio: .5\n    tiny: -1e-5\n    flag: false\n    level: LEVEL_HIGH\n    limit: -inf\n    tags: ["x", "y"]\n    empty: []\n    item { id: 1 }\n    item: { id: 2 }\n    [acme.ext.note]: "n"\n    any { [type.googleapis.com/acme.Thing] { id: 3 } }\n  }', lines: { start: 6, end: 23 }, data: { text: 'abAé', count: -42, big: '9223372036854775807', hex: '0x1F', octal: '017', ratio: 0.5, tiny: -1e-5, flag: false, level: 'LEVEL_HIGH', limit: '-inf', tags: ['x', 'y'], empty: [], item: [{ id: 1 }, { id: 2 }], 'acme.ext.note': 'n', any: { 'type.googleapis.com/acme.Thing': { id: 3 } } } },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.messages[0].options['acme.values'].item" }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder:/options/acme.values/item', source: '{ id: 1 }\n    item: { id: 2 }', lines: { start: 19, end: 20 }, data: [{ id: 1 }, { id: 2 }] },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.messages[0].options['acme.values'].empty" }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder:/options/acme.values/empty', source: '[]', lines: { start: 18, end: 18 }, data: [] },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.messages[0].options['acme.values'].tiny" }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder:/options/acme.values/tiny', source: '-1e-5', lines: { start: 13, end: 13 }, data: -1e-5 },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.messages[0].options['acme.values'].text" }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder:/options/acme.values/text', source: '"a" \'b\' "\\x41\\u00e9"', lines: { start: 7, end: 7 }, data: 'abAé' },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.messages[0].options['acme.values'].any['type.googleapis.com/acme.Thing'].id" }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder:/options/acme.values/any/type.googleapis.com~1acme.Thing/id', source: '3', lines: { start: 22, end: 22 }, data: 3 },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.messages[*]' }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder', source: 'message Holder {\n  option (acme.values) = {\n    text: "a" \'b\' "\\x41\\u00e9"\n    count: -42\n    big: 9223372036854775807\n    hex: 0x1F\n    octal: 017\n    ratio: .5\n    tiny: -1e-5\n    flag: false\n    level: LEVEL_HIGH\n    limit: -inf\n    tags: ["x", "y"]\n    empty: []\n    item { id: 1 }\n    item: { id: 2 }\n    [acme.ext.note]: "n"\n    any { [type.googleapis.com/acme.Thing] { id: 3 } }\n  };\n  optional group Result = 1 [deprecated = true] {\n    optional string url = 2;\n  }\n}', lines: { start: 5, end: 27 }, data: protoRecord('acme.values.Holder', 'Holder', null, { 'acme.values': { text: 'abAé', count: -42, big: '9223372036854775807', hex: '0x1F', octal: '017', ratio: 0.5, tiny: -1e-5, flag: false, level: 'LEVEL_HIGH', limit: '-inf', tags: ['x', 'y'], empty: [], item: [{ id: 1 }, { id: 2 }], 'acme.ext.note': 'n', any: { 'type.googleapis.com/acme.Thing': { id: 3 } } } }) },
    { id: 'acme.values.Holder.Result', source: 'optional group Result = 1 [deprecated = true] {\n    optional string url = 2;\n  }', lines: { start: 24, end: 26 }, data: protoRecord('acme.values.Holder.Result', 'Result', 'acme.values.Holder', {}) },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.fields[*]' }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder.result', source: 'optional group Result = 1 [deprecated = true] {\n    optional string url = 2;\n  }', lines: { start: 24, end: 26 }, data: protoRecord('acme.values.Holder.result', 'result', 'acme.values.Holder', { deprecated: true }) },
    { id: 'acme.values.Holder.Result.url', source: 'optional string url = 2;', lines: { start: 25, end: 25 }, data: protoRecord('acme.values.Holder.Result.url', 'url', 'acme.values.Holder.Result', {}) },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.fields[0].name' }), 'values.proto', PROTO_VALUES), [
    { id: 'acme.values.Holder.result:/name', source: 'Result', lines: { start: 24, end: 24 }, data: 'result' },
  ]);
});

const PROTO_HTTP = `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc ListInvoices(ListInvoicesRequest) returns (ListInvoicesResponse) {
    option (google.api.http) = {
      get: "/v1/invoices"
      additional_bindings { post: "/v1/invoices:search" body: "*" }
      additional_bindings {
        custom { kind: "HEAD" path: "/v1/invoices" }
      }
    };
  }

  rpc GetInvoice(GetInvoiceRequest) returns (Invoice) {
    option (google.api.http).get = "/v1/invoices/{id}";
    option (google.api.http).additional_bindings = { delete: "/v1/invoices/{id}" };
  }
}
`;

test('protobuf selects google.api.http through generic options', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.rpcs[*].options['google.api.http']" }), 'http.proto', PROTO_HTTP), [
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http', source: '{\n      get: "/v1/invoices"\n      additional_bindings { post: "/v1/invoices:search" body: "*" }\n      additional_bindings {\n        custom { kind: "HEAD" path: "/v1/invoices" }\n      }\n    }', lines: { start: 7, end: 13 }, data: { get: '/v1/invoices', additional_bindings: [{ post: '/v1/invoices:search', body: '*' }, { custom: { kind: 'HEAD', path: '/v1/invoices' } }] } },
    { id: 'acme.billing.v1.BillingService.GetInvoice:/options/google.api.http', source: 'option (google.api.http).get = "/v1/invoices/{id}";\n    option (google.api.http).additional_bindings = { delete: "/v1/invoices/{id}" };', lines: { start: 17, end: 18 }, data: { get: '/v1/invoices/{id}', additional_bindings: { delete: '/v1/invoices/{id}' } } },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.rpcs[*].options['google.api.http']..['get','put','post','delete','patch','path']" }), 'http.proto', PROTO_HTTP), [
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/get', source: '"/v1/invoices"', lines: { start: 8, end: 8 }, data: '/v1/invoices' },
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/additional_bindings/0/post', source: '"/v1/invoices:search"', lines: { start: 9, end: 9 }, data: '/v1/invoices:search' },
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/additional_bindings/1/custom/path', source: '"/v1/invoices"', lines: { start: 11, end: 11 }, data: '/v1/invoices' },
    { id: 'acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/get', source: '"/v1/invoices/{id}"', lines: { start: 17, end: 17 }, data: '/v1/invoices/{id}' },
    { id: 'acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/additional_bindings/delete', source: '"/v1/invoices/{id}"', lines: { start: 18, end: 18 }, data: '/v1/invoices/{id}' },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.rpcs[*].options['google.api.http']..custom.path" }), 'http.proto', PROTO_HTTP), [
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/additional_bindings/1/custom/path', source: '"/v1/invoices"', lines: { start: 11, end: 11 }, data: '/v1/invoices' },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.rpcs[0].options['google.api.http'].additional_bindings" }), 'http.proto', PROTO_HTTP), [
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/additional_bindings', source: '{ post: "/v1/invoices:search" body: "*" }\n      additional_bindings {\n        custom { kind: "HEAD" path: "/v1/invoices" }\n      }', lines: { start: 9, end: 12 }, data: [{ post: '/v1/invoices:search', body: '*' }, { custom: { kind: 'HEAD', path: '/v1/invoices' } }] },
  ]);
});

const PROTO_DOTTED_NAMES = `syntax = "proto3";

option features.field_presence = EXPLICIT;
option (acme.a).(acme.b).c = 1;
option (acme.tag) = "x";
option (acme.tag) = "y";
`;

test('protobuf merges dotted names and repeated statements', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.options' }), 'dotted.proto', PROTO_DOTTED_NAMES), [
    { id: '/options', source: 'option features.field_presence = EXPLICIT;\noption (acme.a).(acme.b).c = 1;\noption (acme.tag) = "x";\noption (acme.tag) = "y";', lines: { start: 3, end: 6 }, data: { features: { field_presence: 'EXPLICIT' }, 'acme.a': { 'acme.b': { c: 1 } }, 'acme.tag': ['x', 'y'] } },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.options['acme.tag']" }), 'dotted.proto', PROTO_DOTTED_NAMES), [
    { id: '/options/acme.tag', source: '"x";\noption (acme.tag) = "y"', lines: { start: 5, end: 6 }, data: ['x', 'y'] },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.options['acme.a']" }), 'dotted.proto', PROTO_DOTTED_NAMES), [
    { id: '/options/acme.a', source: 'option (acme.a).(acme.b).c = 1;', lines: { start: 4, end: 4 }, data: { 'acme.b': { c: 1 } } },
  ]);
});

test('protobuf selects HTTP verb and custom path leaves across single and repeated forms', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.rpcs[*].options['google.api.http']..['get','put','post','delete','patch','path']" }), 'http.proto', PROTO_HTTP), [
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/get', source: '"/v1/invoices"', lines: { start: 8, end: 8 }, data: '/v1/invoices' },
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/additional_bindings/0/post', source: '"/v1/invoices:search"', lines: { start: 9, end: 9 }, data: '/v1/invoices:search' },
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/additional_bindings/1/custom/path', source: '"/v1/invoices"', lines: { start: 11, end: 11 }, data: '/v1/invoices' },
    { id: 'acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/get', source: '"/v1/invoices/{id}"', lines: { start: 17, end: 17 }, data: '/v1/invoices/{id}' },
    { id: 'acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/additional_bindings/delete', source: '"/v1/invoices/{id}"', lines: { start: 18, end: 18 }, data: '/v1/invoices/{id}' },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.rpcs[*].options['google.api.http']..custom.path" }), 'http.proto', PROTO_HTTP), [
    { id: 'acme.billing.v1.BillingService.ListInvoices:/options/google.api.http/additional_bindings/1/custom/path', source: '"/v1/invoices"', lines: { start: 11, end: 11 }, data: '/v1/invoices' },
  ]);
});

test('protobuf selects dotted repeated option paths with escaped ids', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>({ path: "$.options['acme.tag']" }), 'dotted.proto', PROTO_DOTTED_NAMES), [
    { id: '/options/acme.tag', source: '"x";\noption (acme.tag) = "y"', lines: { start: 5, end: 6 }, data: ['x', 'y'] },
  ]);
});


test('protobuf reports parser errors through selection', async () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['unterminated string', 'service BillingService {\n  rpc GetInvoice(A) returns (B) {\n    option (google.api.http) = {\n      get: "/v1/billing/invoices\n    };\n  }\n}\n', 'Unterminated string literal in protobuf source'],
    ['unterminated block comment', '/* comment\nservice S {\n', 'Unterminated block comment in protobuf source'],
    ['malformed package', 'package 42;\n', 'Malformed package declaration in protobuf source'],
    ['malformed rpc declaration', 'service S {\n  rpc (A) returns (B);\n}\n', 'Malformed rpc declaration in protobuf source'],
    ['malformed rpc signature', 'service S {\n  rpc A returns (B);\n}\n', 'Malformed rpc signature in protobuf source'],
    ['unterminated rpc body', 'service S {\n  rpc A(C) returns (D) {\n', 'Unterminated rpc body in protobuf source'],
    ['unterminated service body', 'service S {\n', 'Unterminated service body in protobuf source'],
    ['malformed message', 'message {\n}\n', 'Malformed message declaration in protobuf source'],
    ['unterminated message body', 'message M {\n  string a = 1;\n', 'Unterminated message body in protobuf source'],
    ['malformed field', 'message M {\n  string name;\n}\n', 'Malformed field declaration in protobuf source'],
    ['malformed enum value', 'enum E {\n  A;\n}\n', 'Malformed enum value declaration in protobuf source'],
    ['unterminated option name', 'option (a.b', 'Unterminated option name in protobuf source'],
    ['missing equals', 'option (a.b) 1;\n', 'Expected "=" after option name in protobuf source'],
    ['missing value', 'option (a.b) = ;\n', 'Expected an option value in protobuf source'],
    ['missing semicolon', 'option (a.b) = 1\nmessage M {}\n', 'Expected ";" after option in protobuf source'],
    ['unterminated value', 'option (a.b) = { c: "x"\n', 'Unterminated option value in protobuf source'],
    ['malformed value', 'option (a) = { 42 };\n', 'Malformed option value in protobuf source'],
    ['unterminated inline options', 'message M {\n  string a = 1 [deprecated = true\n', 'Unterminated inline options in protobuf source'],
    ['option conflict', 'option (a) = 1;\noption (a).b = 2;\n', 'Option "a.b" sets a field inside a non-message value'],
  ];
  for (const [label, source, message] of cases) {
    assert.equal(await selectionError(protobuf<JsonValue>(), 'x.proto', source), message, label);
  }
});

test('protobuf reports lines consistently for LF, CRLF, and lone-CR sources', async () => {
  for (const [label, source] of [
    ['LF', PROTO_PLAIN_LINES],
    ['CRLF', PROTO_CRLF],
    ['lone CR', PROTO_CR],
  ] as const) {
    assert.deepEqual(
      (await select(protobuf<JsonValue>(), 'x.proto', source)).map((record) => record.lines),
      [{ start: 4, end: 8 }],
      label,
    );
    assert.deepEqual(
      await select(protobuf<JsonValue>({ path: "$.rpcs[*].options['google.api.http'].get" }), 'x.proto', source),
      [{ id: 'acme.billing.v1.BillingService.GetInvoice:/options/google.api.http/get', source: '"/v1/billing/invoices"', lines: { start: 6, end: 6 }, data: '/v1/billing/invoices' }],
      label,
    );
  }
});

test('protobuf validates the path option eagerly and defaults to every RPC record', async () => {
  assert.throws(() => protobuf<JsonValue>({ path: '' }), /path/i, 'empty path');
  assert.throws(() => protobuf<JsonValue>({ path: 'rpcs' }), /\$/, 'unrooted path must require the $ root');
  assert.throws(() => protobuf<JsonValue>({ path: '$[?(@.id)]' }), /executable/i, 'executable path');
  assert.throws(() => protobuf<JsonValue>({ path: '$.@' }), /unknown value type/i, 'library-reported path');
  for (const path of ['$.rpcs[*]', '$..rpcs', '$.rpcs[0]', "$.rpcs[*].options['google.api.http']..['get','put','post','delete','patch']"]) {
    assert.doesNotThrow(() => protobuf<JsonValue>({ path }), `path ${path}`);
  }
  assert.deepEqual(
    (await select(protobuf<JsonValue>(), 'x.proto', PROTO_MULTI)).map((match) => match.id),
    (await select(protobuf<JsonValue>({ path: '$.rpcs[*]' }), 'x.proto', PROTO_MULTI)).map((match) => match.id),
  );
});

test('protobuf rejects a null path', () => {
  assert.throws(() => protobuf({ path: null as unknown as string }), /path/i);
});
