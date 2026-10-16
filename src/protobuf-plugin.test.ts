import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protobufPlugin } from './adapter/scope/protobuf.ts';
import type { LineSpan } from './app/scope/types.ts';

const SELECT_ALL = protobufPlugin.compile({ path: '$.rpcs[*]' });
const FILE = 'proto/billing/v1/invoice.proto';

type Binding = { readonly method: string; readonly url: string };

function select(source: string) {
  return SELECT_ALL.select({ filepath: FILE, source });
}

function rpc(...lines: readonly string[]): string {
  return lines.join('\n');
}

function inService(statement: string, packageName = 'acme.billing.v1'): string {
  return `package ${packageName};\nservice S {\n  ${statement}\n}\n`;
}

// The plugin derives lines from parser offsets, so the expectation finds every occurrence of the
// statement in the full source text instead of trusting the snippet to be unique.
function statementLines(source: string, statement: string): readonly LineSpan[] {
  const breaks = statement.match(/\n/g);
  const spans: LineSpan[] = [];
  for (let index = source.indexOf(statement); index !== -1; index = source.indexOf(statement, index + statement.length)) {
    const start = source.slice(0, index).split('\n').length;
    spans.push({ start, end: start + (breaks === null ? 0 : breaks.length) });
  }
  return spans;
}

function expectedLines(source: string, statement: string): LineSpan {
  const spans = statementLines(source, statement);
  assert.equal(spans.length, 1, 'the statement must occur exactly once in the source');
  return spans[0]!;
}

function expectedContext(
  source: string,
  statement: string,
  name: string,
  bindings: readonly Binding[],
  packageName = 'acme.billing.v1',
  serviceName = 'S',
) {
  const id = [packageName, serviceName, name].filter(Boolean).join('.');
  return {
    id,
    source: statement,
    lines: expectedLines(source, statement),
    data: { id, package: packageName, service: serviceName, name, http: { bindings } },
  };
}

const GET_INVOICE_RPC = rpc(
  'rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {',
  '    option (google.api.http) = {',
  '      get: "/v1/billing/invoices/{invoice_id}"',
  '    };',
  '  }',
);

const BASIC_SOURCE = `syntax = "proto3";\n\npackage acme.billing.v1;\n\nservice BillingService {\n  ${GET_INVOICE_RPC}\n}\n`;

test('extracts one RPC with exact source and exact data', () => {
  assert.deepStrictEqual(select(BASIC_SOURCE), [
    {
      id: 'acme.billing.v1.BillingService.GetInvoice',
      source: GET_INVOICE_RPC,
      lines: expectedLines(BASIC_SOURCE, GET_INVOICE_RPC),
      data: {
        id: 'acme.billing.v1.BillingService.GetInvoice',
        package: 'acme.billing.v1',
        service: 'BillingService',
        name: 'GetInvoice',
        http: { bindings: [{ method: 'GET', url: '/v1/billing/invoices/{invoice_id}' }] },
      },
    },
  ]);
});

const RPC_FORMS: readonly { readonly label: string; readonly name: string; readonly statement: string }[] = [
  { label: 'semicolon body', name: 'Tail', statement: 'rpc Tail(TailRequest) returns (TailResponse);' },
  {
    label: 'streaming semicolon body',
    name: 'Watch',
    statement: 'rpc Watch(stream WatchRequest) returns (stream WatchResponse);',
  },
  { label: 'empty block body', name: 'Open', statement: 'rpc Open(OpenRequest) returns (OpenResponse) { }' },
  {
    label: 'block body with a trailing semicolon',
    name: 'Close',
    statement: 'rpc Close(CloseRequest) returns (CloseResponse) { };',
  },
  {
    label: 'block body without an annotation',
    name: 'Bare',
    statement: 'rpc Bare(BareRequest) returns (BareResponse) {\n    option deprecated = true;\n  }',
  },
];

test('preserves the exact source of every RPC form, unannotated RPCs included', () => {
  for (const item of RPC_FORMS) {
    const source = inService(item.statement);
    assert.deepStrictEqual(select(source), [expectedContext(source, item.statement, item.name, [])], item.label);
  }
});

const OPTION_CASES: readonly {
  readonly label: string;
  readonly name: string;
  readonly statement: string;
  readonly bindings: readonly Binding[];
}[] = [
  {
    label: 'aggregate with a body field and a nested additional binding',
    name: 'CreateInvoice',
    statement: rpc(
      'rpc CreateInvoice(CreateInvoiceRequest) returns (CreateInvoiceResponse) {',
      '    option (google.api.http) = {',
      '      post: "/v1/billing/invoices"',
      '      body: "*"',
      '      additional_bindings {',
      '        get: "/v1/billing/invoices/{invoice_id}"',
      '      }',
      '    };',
      '  }',
    ),
    bindings: [
      { method: 'POST', url: '/v1/billing/invoices' },
      { method: 'GET', url: '/v1/billing/invoices/{invoice_id}' },
    ],
  },
  {
    label: 'aggregate with nested custom bindings',
    name: 'Custom',
    statement: rpc(
      'rpc Custom(CustomRequest) returns (CustomResponse) {',
      '    option (google.api.http) = {',
      '      post: "/v1/billing/invoices" response_body: "*"',
      '      additional_bindings: {',
      '        custom {',
      '          kind: "BATCH"',
      '          path: "/v1/billing/invoices:batchGet"',
      '        }',
      '      }',
      '    };',
      '  }',
    ),
    bindings: [
      { method: 'POST', url: '/v1/billing/invoices' },
      { method: 'BATCH', url: '/v1/billing/invoices:batchGet' },
    ],
  },
  {
    label: 'list-form additional_bindings mixing aggregate and angle-bracket messages',
    name: 'List',
    statement: rpc(
      'rpc List(ListRequest) returns (ListResponse) {',
      '    option (google.api.http) = {',
      '      post: "/v1/items"',
      '      additional_bindings: [',
      '        { get: "/v1/items/{id}" },',
      '        < get: "/v1/items:lookup" >',
      '      ]',
      '      additional_bindings <',
      '        custom < kind: "BATCH" path: "/v1/items:batchGet" >',
      '      >',
      '    };',
      '  }',
    ),
    bindings: [
      { method: 'POST', url: '/v1/items' },
      { method: 'GET', url: '/v1/items/{id}' },
      { method: 'GET', url: '/v1/items:lookup' },
      { method: 'BATCH', url: '/v1/items:batchGet' },
    ],
  },
  {
    label: 'whole rule in angle-bracket form',
    name: 'Angle',
    statement: rpc(
      'rpc Angle(ARequest) returns (AResponse) {',
      '    option (google.api.http) = < get: "/v1/angle/{id}" >;',
      '  }',
    ),
    bindings: [{ method: 'GET', url: '/v1/angle/{id}' }],
  },
  {
    label: 'adjacent string literals in verb and custom fields',
    name: 'GetItem',
    statement: rpc(
      'rpc GetItem(GetRequest) returns (GetResponse) {',
      '    option (google.api.http) = {',
      '      get: "/v1/" "items/" "{id}"',
      '      additional_bindings: {',
      '        custom {',
      '          kind: "BATCH" "ED"',
      '          path: "/v1/" "items:batchGet"',
      '        }',
      '      }',
      '    };',
      '  }',
    ),
    bindings: [
      { method: 'GET', url: '/v1/items/{id}' },
      { method: 'BATCHED', url: '/v1/items:batchGet' },
    ],
  },
  {
    label: 'one dotted verb path',
    name: 'Dotted',
    statement: rpc(
      'rpc Dotted(DottedRequest) returns (DottedResponse) {',
      '    option (google.api.http).get = "/v1/items/{id}";',
      '  }',
    ),
    bindings: [{ method: 'GET', url: '/v1/items/{id}' }],
  },
  {
    label: 'dotted verb, body, additional_bindings and custom paths across option statements',
    name: 'Create',
    statement: rpc(
      'rpc Create(CreateRequest) returns (CreateResponse) {',
      '    option (google.api.http).post = "/v1/items";',
      '    option (google.api.http).body = "*";',
      '    option (google.api.http).additional_bindings.get = "/v1/items/{id}";',
      '    option (google.api.http).additional_bindings.custom.kind = "BATCH";',
      '    option (google.api.http).additional_bindings.custom.path = "/v1/items:batchGet";',
      '    option (google.api.http).custom.kind = "LOOKUP";',
      '    option (google.api.http).custom.path = "/v1/items:lookup";',
      '  }',
    ),
    bindings: [
      { method: 'POST', url: '/v1/items' },
      { method: 'GET', url: '/v1/items/{id}' },
      { method: 'BATCH', url: '/v1/items:batchGet' },
      { method: 'LOOKUP', url: '/v1/items:lookup' },
    ],
  },
  {
    label: 'dotted custom aggregate',
    name: 'Lookup',
    statement: rpc(
      'rpc Lookup(LookupRequest) returns (LookupResponse) {',
      '    option (google.api.http).custom = {',
      '      kind: "BATCH"',
      '      path: "/v1/items:batchGet"',
      '    };',
      '  }',
    ),
    bindings: [{ method: 'BATCH', url: '/v1/items:batchGet' }],
  },
  {
    label: 'dotted additional_bindings list',
    name: 'Batch',
    statement: rpc(
      'rpc Batch(BatchRequest) returns (BatchResponse) {',
      '    option (google.api.http).additional_bindings = [',
      '      { get: "/v1/items" },',
      '      < get: "/v1/items:lookup" >',
      '    ];',
      '  }',
    ),
    bindings: [
      { method: 'GET', url: '/v1/items' },
      { method: 'GET', url: '/v1/items:lookup' },
    ],
  },
  {
    label: 'interleaved dotted custom fields retain their additional binding',
    name: 'Interleaved',
    statement: rpc(
      'rpc Interleaved(A) returns (B) {',
      '    option (google.api.http).additional_bindings.custom.kind = "BATCH";',
      '    option (google.api.http).get = "/main";',
      '    option (google.api.http).custom.kind = "LOOKUP";',
      '    option (google.api.http).additional_bindings.custom.path = "/batch";',
      '    option (google.api.http).custom.path = "/lookup";',
      '    option (google.api.http).additional_bindings.get = "/later";',
      '  }',
    ),
    bindings: [
      { method: 'BATCH', url: '/batch' },
      { method: 'GET', url: '/main' },
      { method: 'LOOKUP', url: '/lookup' },
      { method: 'GET', url: '/later' },
    ],
  },
  {
    label: 'repeated aggregate and list bindings keep their custom drafts separate',
    name: 'Separate',
    statement: rpc(
      'rpc Separate(A) returns (B) {',
      '    option (google.api.http) = {',
      '      additional_bindings { custom { kind: "FIRST" } }',
      '      additional_bindings: [ < custom < kind: "SECOND" path: "/second" > > ]',
      '    };',
      '    option (google.api.http).get = "/main";',
      '    option (google.api.http).additional_bindings.custom.path = "/tail";',
      '    option (google.api.http).additional_bindings.custom.kind = "TAIL";',
      '  }',
    ),
    bindings: [
      { method: 'FIRST', url: '' },
      { method: 'SECOND', url: '/second' },
      { method: 'GET', url: '/main' },
      { method: 'TAIL', url: '/tail' },
    ],
  },
];

test('reads aggregate, angle-bracket, list and dotted google.api.http forms into ordered bindings', () => {
  for (const item of OPTION_CASES) {
    const source = inService(item.statement);
    assert.deepStrictEqual(
      select(source),
      [expectedContext(source, item.statement, item.name, item.bindings)],
      item.label,
    );
  }
});

test('comments and braces inside strings never corrupt statement boundaries', () => {
  const statement = rpc(
    'rpc Real(RealRequest) returns (RealResponse) {',
    '    option (google.api.http) = {',
    '      get: "/v1/real/{id}" // trailing brace } and \\"quote\\"',
    '    };',
    '  }',
  );
  const source = `package acme.billing.v1;\nservice S {\n  // rpc Fake(A) returns (B);\n  /* rpc Also(N) returns (M) { } */\n  # rpc Hash(H) returns (I);\n  ${statement}\n}\n`;
  assert.deepStrictEqual(select(source), [expectedContext(source, statement, 'Real', [{ method: 'GET', url: '/v1/real/{id}' }])]);
});

test('skips unknown angle-bracket options before a service and its real RPC', () => {
  const statement = 'rpc Real(A) returns (B);';
  const option = 'option (unknown) = < before: 1; service: "x"; text: "> }"; nested: < after: 2; > >;';
  const source = `${option}\nservice S {\n  ${option}\n  ${statement}\n}\n`;
  assert.deepStrictEqual(select(source), [expectedContext(source, statement, 'Real', [], '')]);
});

const ESCAPE_CASES: readonly { readonly label: string; readonly literal: string; readonly url: string }[] = [
  { label: 'simple escapes', literal: String.raw`"/v1/items/{id}?x=a\"b\\c"`, url: '/v1/items/{id}?x=a"b\\c' },
  // Octal and deliberately malformed escapes are quoted with explicit backslashes: a template
  // literal would have to treat them as invalid escape sequences rather than source text.
  { label: 'octal UTF-8 bytes', literal: '"/v1/caf\\303\\251/items"', url: '/v1/café/items' },
  { label: 'hex UTF-8 bytes', literal: String.raw`"/v1/caf\xc3\xa9/items"`, url: '/v1/café/items' },
  {
    label: 'octal bytes split across adjacent literals',
    literal: '"/v1/caf\\303" "\\251/items"',
    url: '/v1/café/items',
  },
  { label: 'hex bytes across adjacent literals', literal: String.raw`"/v1/\xe2" "" "\x82" "\xac/items"`, url: '/v1/€/items' },
  { label: 'malformed prefix before literal ASCII', literal: String.raw`"/v1/\xe2A"`, url: '/v1/�A' },
  { label: 'malformed prefix before escaped ASCII', literal: String.raw`"/v1/\xe2\x41"`, url: '/v1/�A' },
  { label: 'malformed prefix across adjacent literals', literal: String.raw`"/v1/\xe2" "\x41"`, url: '/v1/�A' },
  { label: 'malformed prefix before Unicode escape', literal: String.raw`"/v1/\xe2\u0041"`, url: '/v1/�A' },
  { label: 'truncated sequence before literal Unicode', literal: String.raw`"/v1/\xe2\x82café"`, url: '/v1/�café' },
  { label: 'truncated sequence before invalid byte', literal: String.raw`"/v1/\xe2\x82\xff"`, url: '/v1/��' },
  { label: 'unicode escapes', literal: String.raw`"/v1\u002fitems/\U0001F600"`, url: '/v1/items/\u{1F600}' },
  { label: 'literal Unicode', literal: '"/v1/café/😀/items"', url: '/v1/café/😀/items' },
];

test('decodes escape forms to the same URL as the equivalent literal Unicode', () => {
  for (const item of ESCAPE_CASES) {
    const statement = rpc(`rpc Get(E) returns (R) { option (google.api.http) = { get: ${item.literal} }; }`);
    const source = inService(statement);
    assert.deepStrictEqual(
      select(source),
      [expectedContext(source, statement, 'Get', [{ method: 'GET', url: item.url }])],
      item.label,
    );
  }
  const literal = rpc('rpc Get(E) returns (R) { option (google.api.http) = { get: "/v1/café/items" }; }');
  const escaped = rpc('rpc Get(E) returns (R) { option (google.api.http) = { get: "/v1/caf\\303\\251/items" }; }');
  assert.deepStrictEqual(select(inService(escaped))[0]!.data, select(inService(literal))[0]!.data);
});

test('rejects malformed, unterminated and out-of-range escapes', () => {
  const literals = ['"/v1/\\u12"', String.raw`"/v1/\U00110000"`, '"/v1/\\x"', '"unterminated'];
  for (const literal of literals) {
    const statement = rpc(`rpc Get(E) returns (R) { option (google.api.http) = { get: ${literal} }; }`);
    assert.throws(() => select(inService(statement)), literal);
  }
});

test('a byte-order mark never swallows the declaration it precedes', () => {
  const statement = rpc('rpc Get(E) returns (R) { option (google.api.http) = { get: "/v1/items" }; }');
  const bindings: readonly Binding[] = [{ method: 'GET', url: '/v1/items' }];
  const prefixed = `\uFEFFpackage acme.v1;\nservice S {\n  ${statement}\n}\n`;
  const contexts = select(prefixed);
  assert.deepStrictEqual(contexts, [expectedContext(prefixed, statement, 'Get', bindings, 'acme.v1')]);
  // Token spans stay in the original coordinates, so the source is an exact slice of the file.
  assert.ok(prefixed.includes(contexts[0]!.source));
  const withoutPackage = `\uFEFFservice S {\n  ${statement}\n}\n`;
  assert.deepStrictEqual(select(withoutPackage), [expectedContext(withoutPackage, statement, 'Get', bindings, '')]);
});

test('a missing package leaves an empty package field and a service-qualified id', () => {
  const statement = 'rpc Ping(PingRequest) returns (PingResponse);';
  const source = `service Health {\n  ${statement}\n}\n`;
  assert.deepStrictEqual(select(source), [expectedContext(source, statement, 'Ping', [], '', 'Health')]);
});

test('a package change alters both the id and the data for the same RPC source', () => {
  const before = select(inService(GET_INVOICE_RPC));
  const after = select(inService(GET_INVOICE_RPC, 'acme.billing.v2'));
  assert.equal(before[0]!.id, 'acme.billing.v1.S.GetInvoice');
  assert.equal(after[0]!.id, 'acme.billing.v2.S.GetInvoice');
  assert.equal(before[0]!.source, after[0]!.source);
  assert.notDeepStrictEqual(before[0]!.data, after[0]!.data);
});

test('applies a package declared after the service to every record', () => {
  const statement = 'rpc Ping(PingRequest) returns (PingResponse);';
  const source = `service S {\n  ${statement}\n}\npackage acme.health.v1;\n`;
  assert.deepStrictEqual(select(source), [expectedContext(source, statement, 'Ping', [], 'acme.health.v1')]);
});

test('orders records by declaration order across services', () => {
  const one = 'rpc First(FirstRequest) returns (FirstResponse);';
  const two = 'rpc Second(SecondRequest) returns (SecondResponse);';
  const source = `package acme.billing.v1;\nservice A {\n  ${one}\n}\nservice B {\n  ${two}\n}\n`;
  assert.deepStrictEqual(
    select(source).map((context) => context.id),
    ['acme.billing.v1.A.First', 'acme.billing.v1.B.Second'],
  );
});

test('places byte-identical RPCs at their own lines instead of locating them by snippet text', () => {
  const statement = 'rpc Ping(PingRequest) returns (PingResponse);';
  const source = `package acme.billing.v1;\nservice A {\n  ${statement}\n}\n\n\nservice B {\n  ${statement}\n}\n`;
  const spans = statementLines(source, statement);
  assert.equal(spans.length, 2);
  assert.notDeepStrictEqual(spans[0], spans[1]);
  assert.deepStrictEqual(select(source).map((context) => ({ id: context.id, lines: context.lines })), [
    { id: 'acme.billing.v1.A.Ping', lines: spans[0]! },
    { id: 'acme.billing.v1.B.Ping', lines: spans[1]! },
  ]);
});

test('selects records through non-default JSONPath selectors and returns nothing when unmatched', () => {
  const single = protobufPlugin.compile({ path: '$..rpcs[0]' });
  const first = single.select({ filepath: 'x.proto', source: BASIC_SOURCE });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.id, 'acme.billing.v1.BillingService.GetInvoice');
  const missing = protobufPlugin.compile({ path: '$.rpcs[7]' });
  assert.deepStrictEqual(missing.select({ filepath: 'x.proto', source: BASIC_SOURCE }), []);
  assert.deepStrictEqual(select(''), []);
});

test('selects HTTP URLs independently with exact source locations', () => {
  const source = inService(rpc(
    'rpc Publish(P) returns (Q) {',
    '    option (google.api.http) = {',
    '      post: "/v1/invoices"',
    '      additional_bindings {',
    '        get: "/public/v1/invoices/{invoice_id}/items"',
    '      }',
    '    };',
    '  }',
  ));
  const urls = protobufPlugin.compile({ path: '$.rpcs[*].http.bindings[*].url' });
  assert.deepStrictEqual(urls.select({ filepath: FILE, source }), [
    {
      id: 'acme.billing.v1.S.Publish:/http/bindings/0/url',
      source: '"/v1/invoices"',
      data: '/v1/invoices',
      lines: expectedLines(source, '"/v1/invoices"'),
    },
    {
      id: 'acme.billing.v1.S.Publish:/http/bindings/1/url',
      source: '"/public/v1/invoices/{invoice_id}/items"',
      data: '/public/v1/invoices/{invoice_id}/items',
      lines: expectedLines(source, '"/public/v1/invoices/{invoice_id}/items"'),
    },
  ]);
});

function selectPath(path: string, source: string) {
  return protobufPlugin.compile({ path }).select({ filepath: FILE, source });
}

const HTTP_OPTION = rpc(
  'option (google.api.http) = {',
  '      post: "/v1/invoices"',
  '      additional_bindings {',
  '        get: "/v1/invoices"',
  '      }',
  '    };',
);
const HTTP_SOURCE = inService(rpc('rpc Publish(P) returns (Q) {', `    ${HTTP_OPTION}`, '  }'));

test('selects HTTP URL leaves with RPC-relative ids and keeps repeated identities distinct', () => {
  const spans = statementLines(HTTP_SOURCE, '"/v1/invoices"');
  assert.equal(spans.length, 2);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[*].url', HTTP_SOURCE), [
    {
      id: 'acme.billing.v1.S.Publish:/http/bindings/0/url',
      source: '"/v1/invoices"',
      data: '/v1/invoices',
      lines: spans[0]!,
    },
    {
      id: 'acme.billing.v1.S.Publish:/http/bindings/1/url',
      source: '"/v1/invoices"',
      data: '/v1/invoices',
      lines: spans[1]!,
    },
  ]);
  assert.deepStrictEqual(
    selectPath('$.rpcs[*].http.bindings[0,0].url', HTTP_SOURCE).map((context) => context.id),
    [
      'acme.billing.v1.S.Publish:/http/bindings/0/url',
      'acme.billing.v1.S.Publish:/http/bindings/0/url',
    ],
  );
});

test('selects nested HTTP nodes with the annotation, binding, method and URL spans', () => {
  const optionLines = expectedLines(HTTP_SOURCE, HTTP_OPTION);
  const bindings: readonly Binding[] = [
    { method: 'POST', url: '/v1/invoices' },
    { method: 'GET', url: '/v1/invoices' },
  ];
  assert.deepStrictEqual(selectPath('$.rpcs[*].http', HTTP_SOURCE), [
    { id: 'acme.billing.v1.S.Publish:/http', source: HTTP_OPTION, data: { bindings }, lines: optionLines },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings', HTTP_SOURCE), [
    { id: 'acme.billing.v1.S.Publish:/http/bindings', source: HTTP_OPTION, data: bindings, lines: optionLines },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[1]', HTTP_SOURCE), [
    {
      id: 'acme.billing.v1.S.Publish:/http/bindings/1',
      source: 'get: "/v1/invoices"',
      data: { method: 'GET', url: '/v1/invoices' },
      lines: expectedLines(HTTP_SOURCE, 'get: "/v1/invoices"'),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[1].method', HTTP_SOURCE), [
    {
      id: 'acme.billing.v1.S.Publish:/http/bindings/1/method',
      source: 'get',
      data: 'GET',
      lines: expectedLines(HTTP_SOURCE, 'get: "/v1/invoices"'),
    },
  ]);
  assert.deepStrictEqual(
    selectPath('$..url', HTTP_SOURCE).map((context) => context.id),
    [
      'acme.billing.v1.S.Publish:/http/bindings/0/url',
      'acme.billing.v1.S.Publish:/http/bindings/1/url',
    ],
  );
});

test('keeps concatenated and escaped URL literals as their exact source span', () => {
  const literal = '"/v1/caf\\303" /* bytes */ "\\251/items"';
  const option = rpc('option (google.api.http) = {', `      get: ${literal}`, '    };');
  const source = inService(rpc('rpc Concat(P) returns (Q) {', `    ${option}`, '  }'));
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0]', source), [
    {
      id: 'acme.billing.v1.S.Concat:/http/bindings/0',
      source: `get: ${literal}`,
      data: { method: 'GET', url: '/v1/café/items' },
      lines: expectedLines(source, `get: ${literal}`),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0].url', source), [
    {
      id: 'acme.billing.v1.S.Concat:/http/bindings/0/url',
      source: literal,
      data: '/v1/café/items',
      lines: expectedLines(source, literal),
    },
  ]);

  const escaped = String.raw`"/v1\u002fitems/\U0001F600"`;
  const escapedSource = inService(rpc(`rpc Escaped(P) returns (Q) { option (google.api.http) = { get: ${escaped} }; }`));
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0].url', escapedSource), [
    {
      id: 'acme.billing.v1.S.Escaped:/http/bindings/0/url',
      source: escaped,
      data: '/v1/items/😀',
      lines: expectedLines(escapedSource, escaped),
    },
  ]);
});

test('selects dotted HTTP options with statement, field and literal spans', () => {
  const option = 'option (google.api.http).get = "/v1/items/{id}";';
  const source = inService(rpc('rpc Dotted(P) returns (Q) {', `    ${option}`, '  }'));
  assert.deepStrictEqual(selectPath('$.rpcs[*].http', source), [
    {
      id: 'acme.billing.v1.S.Dotted:/http',
      source: option,
      data: { bindings: [{ method: 'GET', url: '/v1/items/{id}' }] },
      lines: expectedLines(source, option),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0]', source), [
    {
      id: 'acme.billing.v1.S.Dotted:/http/bindings/0',
      source: 'get = "/v1/items/{id}"',
      data: { method: 'GET', url: '/v1/items/{id}' },
      lines: expectedLines(source, 'get = "/v1/items/{id}"'),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0].method', source), [
    {
      id: 'acme.billing.v1.S.Dotted:/http/bindings/0/method',
      source: 'get',
      data: 'GET',
      lines: expectedLines(source, 'get = "/v1/items/{id}"'),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0].url', source), [
    {
      id: 'acme.billing.v1.S.Dotted:/http/bindings/0/url',
      source: '"/v1/items/{id}"',
      data: '/v1/items/{id}',
      lines: expectedLines(source, 'get = "/v1/items/{id}"'),
    },
  ]);
});

test('selects custom HTTP bindings and falls back to the custom block for empty fields', () => {
  const option = rpc(
    'option (google.api.http) = {',
    '      custom {',
    '        kind: "BATCH"',
    '        path: "/v1/items:batchGet"',
    '      }',
    '      additional_bindings { custom { kind: "LOOKUP" } }',
    '    };',
  );
  const source = inService(rpc('rpc Batch(P) returns (Q) {', `    ${option}`, '  }'));
  const block = rpc('custom {', '        kind: "BATCH"', '        path: "/v1/items:batchGet"', '      }');
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0]', source), [
    {
      id: 'acme.billing.v1.S.Batch:/http/bindings/0',
      source: block,
      data: { method: 'BATCH', url: '/v1/items:batchGet' },
      lines: expectedLines(source, block),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0].method', source), [
    {
      id: 'acme.billing.v1.S.Batch:/http/bindings/0/method',
      source: '"BATCH"',
      data: 'BATCH',
      lines: expectedLines(source, '"BATCH"'),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0].url', source), [
    {
      id: 'acme.billing.v1.S.Batch:/http/bindings/0/url',
      source: '"/v1/items:batchGet"',
      data: '/v1/items:batchGet',
      lines: expectedLines(source, '"/v1/items:batchGet"'),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[1]', source), [
    {
      id: 'acme.billing.v1.S.Batch:/http/bindings/1',
      source: 'custom { kind: "LOOKUP" }',
      data: { method: 'LOOKUP', url: '' },
      lines: expectedLines(source, 'custom { kind: "LOOKUP" }'),
    },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[1].url', source), [
    {
      id: 'acme.billing.v1.S.Batch:/http/bindings/1/url',
      source: 'custom { kind: "LOOKUP" }',
      data: '',
      lines: expectedLines(source, 'custom { kind: "LOOKUP" }'),
    },
  ]);
});

test('falls back to the RPC span for HTTP nodes without an annotation', () => {
  const statement = 'rpc Bare(BareRequest) returns (BareResponse) { }';
  const source = inService(statement);
  const lines = expectedLines(source, statement);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http', source), [
    { id: 'acme.billing.v1.S.Bare:/http', source: statement, data: { bindings: [] }, lines },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings', source), [
    { id: 'acme.billing.v1.S.Bare:/http/bindings', source: statement, data: [], lines },
  ]);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[*].url', source), []);

  const deprecated = rpc(
    'rpc Legacy(LegacyRequest) returns (LegacyResponse) {',
    '    option deprecated = true;',
    '  }',
  );
  const deprecatedSource = inService(deprecated);
  assert.deepStrictEqual(selectPath('$.rpcs[*].http', deprecatedSource), [
    {
      id: 'acme.billing.v1.S.Legacy:/http',
      source: deprecated,
      data: { bindings: [] },
      lines: expectedLines(deprecatedSource, deprecated),
    },
  ]);

  const empty = inService(rpc('rpc Empty(P) returns (Q) { option (google.api.http) = { get: "" }; }'));
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0].url', empty), [
    {
      id: 'acme.billing.v1.S.Empty:/http/bindings/0/url',
      source: '""',
      data: '',
      lines: expectedLines(empty, '""'),
    },
  ]);
});

test('rejects selections outside an RPC record or its http annotation', () => {
  for (const path of ['$', '$.rpcs', '$.rpcs[*].id', '$.rpcs[*].package', '$.rpcs[*].service']) {
    assert.throws(() => selectPath(path, BASIC_SOURCE), path);
  }
});

test('keeps URL leaves whose value equals the property name', () => {
  const source = inService(rpc('rpc Literal(P) returns (Q) { option (google.api.http) = { get: "url" }; }'));
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[0].url', source), [
    {
      id: 'acme.billing.v1.S.Literal:/http/bindings/0/url',
      source: '"url"',
      data: 'url',
      lines: expectedLines(source, '"url"'),
    },
  ]);
});

test('rejects property-name projections and still resolves parent selections', () => {
  const source = inService(rpc('rpc Literal(P) returns (Q) { option (google.api.http) = { get: "url" }; }'));
  for (const path of [
    '$.rpcs[*].http.bindings[*].url~',
    '$.rpcs[*].http.bindings[*]~',
    '$.rpcs[*].http~',
    '$.rpcs[*]~',
    '$..url~',
  ]) {
    assert.throws(() => selectPath(path, source), path);
  }
  assert.deepStrictEqual(selectPath('$.rpcs[*].http.bindings[*].url^', HTTP_SOURCE), [
    {
      id: 'acme.billing.v1.S.Publish:/http/bindings/0',
      source: 'post: "/v1/invoices"',
      data: { method: 'POST', url: '/v1/invoices' },
      lines: expectedLines(HTTP_SOURCE, 'post: "/v1/invoices"'),
    },
    {
      id: 'acme.billing.v1.S.Publish:/http/bindings/1',
      source: 'get: "/v1/invoices"',
      data: { method: 'GET', url: '/v1/invoices' },
      lines: expectedLines(HTTP_SOURCE, 'get: "/v1/invoices"'),
    },
  ]);
});

test('rejects executable and malformed compile options', () => {
  assert.throws(() => protobufPlugin.compile({}));
  assert.throws(() => protobufPlugin.compile({ path: '' }));
  assert.throws(() => protobufPlugin.compile({ path: 'rpcs[*]' }));
  assert.throws(() => protobufPlugin.compile({ path: '$.rpcs[?(@.name=="x")]' }));
  assert.throws(() => protobufPlugin.compile({ path: '$.rpcs[(1)]' }));
  assert.throws(() => protobufPlugin.compile({ path: "$.rpcs['(1)']" }));
});

test('rejects selections that are not RPC records', () => {
  const names = protobufPlugin.compile({ path: '$.rpcs[*].name' });
  assert.throws(() => names.select({ filepath: 'x.proto', source: BASIC_SOURCE }));
  const array = protobufPlugin.compile({ path: '$.rpcs' });
  assert.throws(() => array.select({ filepath: 'x.proto', source: BASIC_SOURCE }));
});

test('throws on unterminated strings, comments, options and malformed RPCs', () => {
  const sources = [
    'package acme.billing.v1;\nservice S {\n  rpc A(P) returns (Q) {\n    option (google.api.http) = { get: "/oops\n    };\n  }\n}\n',
    'package acme.billing.v1;\n/* never closed\nservice S {}\n',
    'package acme.billing.v1;\nservice S {\n  rpc Broken(P) returns;\n}\n',
    'package acme.billing.v1;\nservice S {\n  rpc Truncated(P) returns (Q) {\n    option (google.api.http) = {\n',
    'package acme.billing.v1;\nservice S {\n  rpc Dotted(P) returns (Q) {\n    option (google.api.http).additional_bindings = [ { get: "/a" }\n  }\n}\n',
  ];
  for (const source of sources) assert.throws(() => select(source), source);
});
