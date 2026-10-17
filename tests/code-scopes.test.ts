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
import { readRpcRecords } from '../dist/adapter/scope/protobuf-parser.js';
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

const PROTO_NO_RPCS = `syntax = "proto3";

package acme.billing.v1;
`;

const PROTO_DOTTED_VERB = `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {
    option (google.api.http).get = "/v1/billing/invoices";
  }
}
`;

const PROTO_EMPTY_URL = `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {
    option (google.api.http) = {
      get: ""
    };
  }
}
`;

const PROTO_CUSTOM_BLOCK = `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {
    option (google.api.http) = {
      custom {
        kind: "HEAD"
        path: "/v1/billing/invoices"
      }
    };
  }
}
`;

const PROTO_CUSTOM_DOTTED = `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {
    option (google.api.http).custom.kind = "HEAD";
    option (google.api.http).custom.path = "/v1/billing/invoices";
  }
}
`;

const PROTO_NESTED_BINDINGS = `syntax = "proto3";

package acme.billing.v1;

/* Billing
   invoices. */
service BillingService {
  // Lists invoices with list and nested additional bindings.
  rpc ListInvoices(ListInvoicesRequest) returns (ListInvoicesResponse) {
    option (google.api.http) = {
      # search form
      get: "/v1/billing/invoices?filter=open\\u0026sort=asc"
      additional_bindings: [
        { post: "/v1/billing/invoices\\/search" }
        {
          custom {
            kind: "HEAD"
            path: '/v1/billing/invoices/head'
          }
        }
        { patch: "/v1/billing/invoices/patch"
          additional_bindings {
            delete: "/v1/billing/invoices/{invoice_id}"
          }
        }
      ]
    };
  }
}
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

function billingRecord(id: string, name: string, bindings: JsonValue): JsonValue {
  return { id, package: 'acme.billing.v1', service: 'BillingService', name, http: { bindings } };
}

test('protobuf selects RPC records by default', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>(), 'proto/billing/v1/invoice.proto', PROTO_MULTI), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice',
      source:
        'rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {\n    option (google.api.http) = {\n      get: "/v1/billing/invoices/{invoice_id}"\n    };\n  }',
      lines: { start: 6, end: 10 },
      data: billingRecord('acme.billing.v1.BillingService.GetInvoice', 'GetInvoice', [
        { method: 'GET', url: '/v1/billing/invoices/{invoice_id}' },
      ]),
    },
    {
      id: 'acme.billing.v1.BillingService.StreamInvoices',
      source: 'rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);',
      lines: { start: 12, end: 12 },
      data: billingRecord('acme.billing.v1.BillingService.StreamInvoices', 'StreamInvoices', []),
    },
    {
      id: 'acme.billing.v1.BillingService.CreateInvoice',
      source:
        'rpc CreateInvoice(CreateInvoiceRequest) returns (CreateInvoiceResponse) {\n    option (google.api.http) = {\n      post: "/v1/billing/invoices"\n      additional_bindings {\n        get: "/v1/billing/invoices/{invoice_id}/items"\n      }\n    };\n  }',
      lines: { start: 14, end: 21 },
      data: billingRecord('acme.billing.v1.BillingService.CreateInvoice', 'CreateInvoice', [
        { method: 'POST', url: '/v1/billing/invoices' },
        { method: 'GET', url: '/v1/billing/invoices/{invoice_id}/items' },
      ]),
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

test('protobuf keeps standard verbs and skips prototype-named unknown fields', async () => {
  const bindings = await select(
    protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*]' }),
    'proto/billing/v1/prototype.proto',
    PROTO_PROTOTYPE_KEYS,
  );
  assert.deepEqual(
    bindings.map(binding => binding.data),
    [
      { method: 'GET', url: '/v1/get' },
      { method: 'POST', url: '/v1/post' },
      { method: 'PUT', url: '/v1/put' },
      { method: 'DELETE', url: '/v1/delete' },
      { method: 'PATCH', url: '/v1/patch' },
      { method: 'PATCH', url: '/v1/dotted-patch' },
    ],
  );
});

test('protobuf selects url leaves across additional bindings in source order', async () => {
  const selector = protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*].url' });
  assert.deepEqual(await select(selector, 'proto/billing/v1/invoice.proto', PROTO_MULTI), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url',
      source: '"/v1/billing/invoices/{invoice_id}"',
      lines: { start: 8, end: 8 },
      data: '/v1/billing/invoices/{invoice_id}',
    },
    {
      id: 'acme.billing.v1.BillingService.CreateInvoice:/http/bindings/0/url',
      source: '"/v1/billing/invoices"',
      lines: { start: 16, end: 16 },
      data: '/v1/billing/invoices',
    },
    {
      id: 'acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/url',
      source: '"/v1/billing/invoices/{invoice_id}/items"',
      lines: { start: 18, end: 18 },
      data: '/v1/billing/invoices/{invoice_id}/items',
    },
  ]);
});

test('protobuf selects http, bindings, binding, method, and url subtrees', async () => {
  assert.deepEqual(
    await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*].method' }), 'x.proto', PROTO_MULTI),
    [
      {
        id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/method',
        source: 'get',
        lines: { start: 8, end: 8 },
        data: 'GET',
      },
      {
        id: 'acme.billing.v1.BillingService.CreateInvoice:/http/bindings/0/method',
        source: 'post',
        lines: { start: 16, end: 16 },
        data: 'POST',
      },
      {
        id: 'acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/method',
        source: 'get',
        lines: { start: 18, end: 18 },
        data: 'GET',
      },
    ],
  );

  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*]' }), 'x.proto', PROTO_MULTI), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0',
      source: 'get: "/v1/billing/invoices/{invoice_id}"',
      lines: { start: 8, end: 8 },
      data: { method: 'GET', url: '/v1/billing/invoices/{invoice_id}' },
    },
    {
      id: 'acme.billing.v1.BillingService.CreateInvoice:/http/bindings/0',
      source: 'post: "/v1/billing/invoices"',
      lines: { start: 16, end: 16 },
      data: { method: 'POST', url: '/v1/billing/invoices' },
    },
    {
      id: 'acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1',
      source: 'get: "/v1/billing/invoices/{invoice_id}/items"',
      lines: { start: 18, end: 18 },
      data: { method: 'GET', url: '/v1/billing/invoices/{invoice_id}/items' },
    },
  ]);

  const getInvoiceOption = 'option (google.api.http) = {\n      get: "/v1/billing/invoices/{invoice_id}"\n    };';
  const createInvoiceOption =
    'option (google.api.http) = {\n      post: "/v1/billing/invoices"\n      additional_bindings {\n        get: "/v1/billing/invoices/{invoice_id}/items"\n      }\n    };';
  const createInvoiceBindings = [
    { method: 'POST', url: '/v1/billing/invoices' },
    { method: 'GET', url: '/v1/billing/invoices/{invoice_id}/items' },
  ];

  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*].http' }), 'x.proto', PROTO_MULTI), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice:/http',
      source: getInvoiceOption,
      lines: { start: 7, end: 9 },
      data: { bindings: [{ method: 'GET', url: '/v1/billing/invoices/{invoice_id}' }] },
    },
    {
      id: 'acme.billing.v1.BillingService.StreamInvoices:/http',
      source: 'rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);',
      lines: { start: 12, end: 12 },
      data: { bindings: [] },
    },
    {
      id: 'acme.billing.v1.BillingService.CreateInvoice:/http',
      source: createInvoiceOption,
      lines: { start: 15, end: 20 },
      data: { bindings: createInvoiceBindings },
    },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings' }), 'x.proto', PROTO_MULTI), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings',
      source: getInvoiceOption,
      lines: { start: 7, end: 9 },
      data: [{ method: 'GET', url: '/v1/billing/invoices/{invoice_id}' }],
    },
    {
      id: 'acme.billing.v1.BillingService.StreamInvoices:/http/bindings',
      source: 'rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);',
      lines: { start: 12, end: 12 },
      data: [],
    },
    {
      id: 'acme.billing.v1.BillingService.CreateInvoice:/http/bindings',
      source: createInvoiceOption,
      lines: { start: 15, end: 20 },
      data: createInvoiceBindings,
    },
  ]);
});

test('protobuf keeps unannotated RPCs with empty bindings and no url leaves', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>(), 'x.proto', PROTO_UNANNOTATED), [
    {
      id: 'acme.billing.v1.BillingService.StreamInvoices',
      source: 'rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);',
      lines: { start: 6, end: 6 },
      data: billingRecord('acme.billing.v1.BillingService.StreamInvoices', 'StreamInvoices', []),
    },
  ]);
  assert.deepEqual(
    await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*].url' }), 'x.proto', PROTO_UNANNOTATED),
    [],
  );
  assert.deepEqual(
    await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*]' }), 'x.proto', PROTO_UNANNOTATED),
    [],
  );
});

test('protobuf reads dotted option assignments', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>(), 'x.proto', PROTO_DOTTED_VERB), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice',
      source:
        'rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {\n    option (google.api.http).get = "/v1/billing/invoices";\n  }',
      lines: { start: 6, end: 8 },
      data: billingRecord('acme.billing.v1.BillingService.GetInvoice', 'GetInvoice', [
        { method: 'GET', url: '/v1/billing/invoices' },
      ]),
    },
  ]);
  assert.deepEqual(
    await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*].url' }), 'x.proto', PROTO_DOTTED_VERB),
    [
      {
        id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url',
        source: '"/v1/billing/invoices"',
        lines: { start: 7, end: 7 },
        data: '/v1/billing/invoices',
      },
    ],
  );
});

test('protobuf keeps empty URL values as real selections', async () => {
  assert.deepEqual(
    await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*].url' }), 'x.proto', PROTO_EMPTY_URL),
    [
      {
        id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url',
        source: '""',
        lines: { start: 8, end: 8 },
        data: '',
      },
    ],
  );
});

test('protobuf reads custom http bindings in block and dotted forms', async () => {
  const url = '$.rpcs[*].http.bindings[*].url';
  const method = '$.rpcs[*].http.bindings[*].method';

  assert.deepEqual(await select(protobuf<JsonValue>({ path: url }), 'x.proto', PROTO_CUSTOM_BLOCK), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url',
      source: '"/v1/billing/invoices"',
      lines: { start: 10, end: 10 },
      data: '/v1/billing/invoices',
    },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: method }), 'x.proto', PROTO_CUSTOM_BLOCK), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/method',
      source: '"HEAD"',
      lines: { start: 9, end: 9 },
      data: 'HEAD',
    },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: url }), 'x.proto', PROTO_CUSTOM_DOTTED), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url',
      source: '"/v1/billing/invoices"',
      lines: { start: 8, end: 8 },
      data: '/v1/billing/invoices',
    },
  ]);
  assert.deepEqual(await select(protobuf<JsonValue>({ path: method }), 'x.proto', PROTO_CUSTOM_DOTTED), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/method',
      source: '"HEAD"',
      lines: { start: 7, end: 7 },
      data: 'HEAD',
    },
  ]);
});

test('protobuf reads comments, escaped strings, and list or nested additional bindings', async () => {
  const recordId = 'acme.billing.v1.BillingService.ListInvoices';
  const recordSource = [
    'rpc ListInvoices(ListInvoicesRequest) returns (ListInvoicesResponse) {',
    '    option (google.api.http) = {',
    '      # search form',
    '      get: "/v1/billing/invoices?filter=open\\u0026sort=asc"',
    '      additional_bindings: [',
    '        { post: "/v1/billing/invoices\\/search" }',
    '        {',
    '          custom {',
    '            kind: "HEAD"',
    "            path: '/v1/billing/invoices/head'",
    '          }',
    '        }',
    '        { patch: "/v1/billing/invoices/patch"',
    '          additional_bindings {',
    '            delete: "/v1/billing/invoices/{invoice_id}"',
    '          }',
    '        }',
    '      ]',
    '    };',
    '  }',
  ].join('\n');

  assert.deepEqual(await select(protobuf<JsonValue>(), 'x.proto', PROTO_NESTED_BINDINGS), [
    {
      id: recordId,
      source: recordSource,
      lines: { start: 9, end: 28 },
      data: billingRecord(recordId, 'ListInvoices', [
        { method: 'GET', url: '/v1/billing/invoices?filter=open&sort=asc' },
        { method: 'POST', url: '/v1/billing/invoices/search' },
        { method: 'HEAD', url: '/v1/billing/invoices/head' },
        { method: 'PATCH', url: '/v1/billing/invoices/patch' },
        { method: 'DELETE', url: '/v1/billing/invoices/{invoice_id}' },
      ]),
    },
  ]);

  assert.deepEqual(
    await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*].url' }), 'x.proto', PROTO_NESTED_BINDINGS),
    [
      {
        id: `${recordId}:/http/bindings/0/url`,
        source: '"/v1/billing/invoices?filter=open\\u0026sort=asc"',
        lines: { start: 12, end: 12 },
        data: '/v1/billing/invoices?filter=open&sort=asc',
      },
      {
        id: `${recordId}:/http/bindings/1/url`,
        source: '"/v1/billing/invoices\\/search"',
        lines: { start: 14, end: 14 },
        data: '/v1/billing/invoices/search',
      },
      {
        id: `${recordId}:/http/bindings/2/url`,
        source: "'/v1/billing/invoices/head'",
        lines: { start: 18, end: 18 },
        data: '/v1/billing/invoices/head',
      },
      {
        id: `${recordId}:/http/bindings/3/url`,
        source: '"/v1/billing/invoices/patch"',
        lines: { start: 21, end: 21 },
        data: '/v1/billing/invoices/patch',
      },
      {
        id: `${recordId}:/http/bindings/4/url`,
        source: '"/v1/billing/invoices/{invoice_id}"',
        lines: { start: 23, end: 23 },
        data: '/v1/billing/invoices/{invoice_id}',
      },
    ],
  );

  assert.deepEqual(
    readRpcRecords(PROTO_NESTED_BINDINGS).map((record) =>
      record.spans.bindings.map((binding) => ({
        span: PROTO_NESTED_BINDINGS.slice(binding.span.start, binding.span.end),
        method: PROTO_NESTED_BINDINGS.slice(binding.method.start, binding.method.end),
        url: PROTO_NESTED_BINDINGS.slice(binding.url.start, binding.url.end),
      })),
    ),
    [
      [
        {
          span: 'get: "/v1/billing/invoices?filter=open\\u0026sort=asc"',
          method: 'get',
          url: '"/v1/billing/invoices?filter=open\\u0026sort=asc"',
        },
        { span: 'post: "/v1/billing/invoices\\/search"', method: 'post', url: '"/v1/billing/invoices\\/search"' },
        {
          span: 'custom {\n            kind: "HEAD"\n            path: \'/v1/billing/invoices/head\'\n          }',
          method: '"HEAD"',
          url: "'/v1/billing/invoices/head'",
        },
        { span: 'patch: "/v1/billing/invoices/patch"', method: 'patch', url: '"/v1/billing/invoices/patch"' },
        {
          span: 'delete: "/v1/billing/invoices/{invoice_id}"',
          method: 'delete',
          url: '"/v1/billing/invoices/{invoice_id}"',
        },
      ],
    ],
  );
});

test('protobuf rejects selections outside the RPC and http subtrees', async () => {
  for (const path of ['$', '$.rpcs', '$.rpcs[*].id']) {
    const message = await selectionError(protobuf<JsonValue>({ path }), 'x.proto', PROTO_MULTI);
    assert.match(message, /not an RPC record or its http annotation/, path);
  }
});

test('protobuf rejects forbidden pointers even when no RPC matched the selection', async () => {
  for (const path of ['$', '$.rpcs']) {
    const message = await selectionError(protobuf<JsonValue>({ path }), 'x.proto', PROTO_NO_RPCS);
    assert.match(message, /not an RPC record or its http annotation/, path);
  }
  assert.deepEqual(await select(protobuf<JsonValue>(), 'x.proto', PROTO_NO_RPCS), []);
  assert.deepEqual(
    await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*].url' }), 'x.proto', PROTO_NO_RPCS),
    [],
  );
});

test('protobuf extracts RPCs without validating imports, types, or unknown options', async () => {
  assert.deepEqual(await select(protobuf<JsonValue>(), 'x.proto', PROTO_UNVALIDATED), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice',
      source:
        'rpc GetInvoice(NonexistentRequest) returns (stream NonexistentResponse) {\n    option (google.api.http) = {\n      get: "/v1/billing/invoices"\n      body: "*"\n    };\n    option (my.custom.method_option).value = 42;\n  }',
      lines: { start: 14, end: 20 },
      data: billingRecord('acme.billing.v1.BillingService.GetInvoice', 'GetInvoice', [
        { method: 'GET', url: '/v1/billing/invoices' },
      ]),
    },
  ]);
});

test('protobuf reader reports normalized records with exact source spans', () => {
  const records = readRpcRecords(PROTO_DOTTED_VERB);
  assert.deepEqual(records, [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice',
      source:
        'rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {\n    option (google.api.http).get = "/v1/billing/invoices";\n  }',
      start: 73,
      end: 200,
      data: {
        id: 'acme.billing.v1.BillingService.GetInvoice',
        package: 'acme.billing.v1',
        service: 'BillingService',
        name: 'GetInvoice',
        http: { bindings: [{ method: 'GET', url: '/v1/billing/invoices' }] },
      },
      spans: {
        http: { start: 142, end: 196 },
        bindings: [
          { span: { start: 167, end: 195 }, method: { start: 167, end: 170 }, url: { start: 173, end: 195 } },
        ],
      },
    },
  ]);
  assert.equal(PROTO_DOTTED_VERB.slice(73, 200), records[0]?.source);

  const unannotated = readRpcRecords(PROTO_UNANNOTATED);
  assert.deepEqual(unannotated[0]?.spans, { http: { start: 73, end: 148 }, bindings: [] });
  assert.deepEqual(unannotated[0]?.data.http.bindings, []);
  assert.deepEqual(readRpcRecords('syntax = "proto3";\n'), [], 'a source without services has no records');
});

test('protobuf reader reports lexical, RPC, and annotation errors', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    [
      'unterminated string',
      'service BillingService {\n  rpc GetInvoice(A) returns (B) {\n    option (google.api.http) = {\n      get: "/v1/billing/invoices\n    };\n  }\n}\n',
      'Unterminated string literal in protobuf source',
    ],
    ['unterminated block comment', '/* comment\nservice S {\n', 'Unterminated block comment in protobuf source'],
    ['malformed package', 'package 42;\n', 'Malformed package declaration in protobuf source'],
    [
      'malformed rpc declaration',
      'service S {\n  rpc (A) returns (B);\n}\n',
      'Malformed rpc declaration in protobuf source',
    ],
    ['malformed rpc signature', 'service S {\n  rpc A returns (B);\n}\n', 'Malformed rpc signature in protobuf source'],
    ['unterminated rpc body', 'service S {\n  rpc A(C) returns (D) {\n', 'Unterminated rpc body in protobuf source'],
    ['unterminated service body', 'service S {\n', 'Unterminated service body in protobuf source'],
    [
      'expected string literal',
      'service S {\n  rpc A(C) returns (D) {\n    option (google.api.http) = {\n      get: 42\n    };\n  }\n}\n',
      'Expected a string literal in google.api.http option',
    ],
    [
      'unterminated http option',
      'service S {\n  rpc A(C) returns (D) {\n    option (google.api.http) = {\n      get: "/x"\n',
      'Unterminated google.api.http option in protobuf source',
    ],
    [
      'unterminated additional bindings',
      'service S {\n  rpc A(C) returns (D) {\n    option (google.api.http).additional_bindings = [ { get: "/x" }\n',
      'Unterminated additional_bindings list in protobuf source',
    ],
    [
      'unterminated custom binding',
      'service S {\n  rpc A(C) returns (D) {\n    option (google.api.http).custom = { kind: "HEAD"\n',
      'Unterminated custom http binding in protobuf source',
    ],
  ];
  for (const [label, source, message] of cases) {
    assert.equal(caughtError(() => readRpcRecords(source)).message, message, label);
  }
});

test('protobuf selector reports parser errors through selection', async () => {
  const message = await selectionError(
    protobuf<JsonValue>(),
    'x.proto',
    'service BillingService {\n  rpc (A) returns (B);\n}\n',
  );
  assert.equal(message, 'Malformed rpc declaration in protobuf source');
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
      await select(protobuf<JsonValue>({ path: '$.rpcs[*].http.bindings[*].url' }), 'x.proto', source),
      [
        {
          id: 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url',
          source: '"/v1/billing/invoices"',
          lines: { start: 6, end: 6 },
          data: '/v1/billing/invoices',
        },
      ],
      label,
    );
  }
});

test('protobuf validates the path option eagerly and defaults to every RPC record', async () => {
  assert.throws(() => protobuf<JsonValue>({ path: '' }), /path/i, 'empty path');
  assert.throws(() => protobuf<JsonValue>({ path: 'rpcs' }), /\$/, 'unrooted path must require the $ root');
  assert.throws(() => protobuf<JsonValue>({ path: '$[?(@.id)]' }), /executable/i, 'executable path');
  assert.throws(() => protobuf<JsonValue>({ path: '$.@' }), /unknown value type/i, 'library-reported path');
  for (const path of ['$.rpcs[*]', '$..rpcs', '$.rpcs[0]', '$.rpcs[*].http.bindings[*].url']) {
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
