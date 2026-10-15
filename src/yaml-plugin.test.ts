import assert from 'node:assert/strict';
import { test } from 'node:test';

import { yamlPlugin } from './adapter/scope/yaml.ts';

const FILEPATH = 'charts/app/values.yaml';

const CONTAINERS = [
  'containers:',
  '  - {name: payments-api, request: 512Mi, limit: 1024Mi}',
  '  - {name: ledger, request: 1Gi, limit: 2Gi}',
  '',
].join('\n');

test('a path with a key emits complete data, exact source and document-scoped ids', () => {
  const scope = yamlPlugin.compile({ path: '$.containers[*]', key: '$.name' });
  const scopes = scope.select({ filepath: FILEPATH, source: CONTAINERS });

  assert.deepStrictEqual(scopes.map(entry => entry.id), ['0:payments-api', '0:ledger']);
  assert.deepStrictEqual(scopes.map(entry => entry.source), [
    '{name: payments-api, request: 512Mi, limit: 1024Mi}',
    '{name: ledger, request: 1Gi, limit: 2Gi}',
  ]);
  assert.deepStrictEqual(scopes[0]?.data, { name: 'payments-api', request: '512Mi', limit: '1024Mi' });
  assert.ok(!('captures' in (scopes[0] ?? {})));
});

test('without a key the id is the document index and the JSON Pointer', () => {
  const scope = yamlPlugin.compile({ path: '$.containers[*]' });
  const scopes = scope.select({ filepath: FILEPATH, source: CONTAINERS });

  assert.deepStrictEqual(scopes.map(entry => entry.id), ['0:/containers/0', '0:/containers/1']);
});

test('the root selector uses the empty JSON Pointer and exact document source', () => {
  const scope = yamlPlugin.compile({ path: '$' });
  const scopes = scope.select({ filepath: FILEPATH, source: 'a: 1\n' });

  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.id, '0:');
  assert.equal(scopes[0]?.source, 'a: 1\n');
  assert.deepStrictEqual(scopes[0]?.data, { a: 1 });
});

test('reports the absolute line span of the selected node, clamped to its last character', () => {
  const byKey = yamlPlugin.compile({ path: '$.containers[*]', key: '$.name' }).select({ filepath: FILEPATH, source: CONTAINERS });
  assert.deepStrictEqual(byKey.map(entry => entry.lines), [
    { start: 2, end: 2 },
    { start: 3, end: 3 },
  ]);

  // The document node of `a: 1\n` ends after the trailing newline, which is still line 1.
  const root = yamlPlugin.compile({ path: '$' }).select({ filepath: FILEPATH, source: 'a: 1\n' });
  assert.deepStrictEqual(root.map(entry => entry.lines), [{ start: 1, end: 1 }]);

  const crlf = yamlPlugin.compile({ path: '$.*' }).select({ filepath: FILEPATH, source: 'a: 1\r\nb: 2\r\n' });
  assert.deepStrictEqual(crlf.map(entry => entry.lines), [
    { start: 1, end: 1 },
    { start: 2, end: 2 },
  ]);

  const block = yamlPlugin
    .compile({ path: '$.containers[*]' })
    .select({ filepath: FILEPATH, source: 'containers:\n  - name: api\n    resources:\n      limits:\n        memory: 1Gi\n' });
  assert.deepStrictEqual(block.map(entry => entry.lines), [{ start: 2, end: 5 }]);
});

test('locates every selection at its own lines, aliases and repeated snippets included', () => {
  const aliased = yamlPlugin.compile({ path: '$.containers[*]' }).select({
    filepath: FILEPATH,
    source: 'defaults: &defaults {request: 512Mi, limit: 1Gi}\ncontainers:\n  - {<<: *defaults, name: api}\n  - *defaults\n',
  });
  assert.deepStrictEqual(aliased.map(entry => entry.lines), [
    { start: 3, end: 3 },
    { start: 4, end: 4 },
  ]);

  const repeated = [
    'containers:',
    '  - {name: api, request: 1, limit: 2}',
    '---',
    'containers:',
    '  - {name: api, request: 1, limit: 2}',
    '',
  ].join('\n');
  const scopes = yamlPlugin.compile({ path: '$.containers[*]' }).select({ filepath: FILEPATH, source: repeated });
  assert.equal(scopes[0]?.source, scopes[1]?.source);
  assert.deepStrictEqual(scopes.map(entry => entry.lines), [
    { start: 2, end: 2 },
    { start: 5, end: 5 },
  ]);
});

test('the document index distinguishes scopes from separate documents', () => {
  const source = [
    'containers:',
    '  - {name: alpha, request: 1, limit: 2}',
    '---',
    'containers:',
    '  - {name: beta, request: 3, limit: 4}',
    '',
  ].join('\n');
  const scope = yamlPlugin.compile({ path: '$.containers[*]', key: '$.name' });

  assert.deepStrictEqual(scope.select({ filepath: FILEPATH, source }).map(entry => entry.id), ['0:alpha', '1:beta']);
});

test('an empty source has no scopes', () => {
  const scope = yamlPlugin.compile({ path: '$.containers[*]', key: '$.name' });
  assert.deepStrictEqual(scope.select({ filepath: FILEPATH, source: '' }), []);
});

test('a selector that matches nothing has no scopes', () => {
  const scope = yamlPlugin.compile({ path: '$.missing[*]' });
  assert.deepStrictEqual(scope.select({ filepath: FILEPATH, source: CONTAINERS }), []);
});

test('aliases keep the alias spelling as source while data resolves the anchor', () => {
  const source = [
    'defaults: &defaults {request: 512Mi, limit: 1Gi}',
    'containers:',
    '  - {<<: *defaults, name: api}',
    '  - *defaults',
    '',
  ].join('\n');
  const scope = yamlPlugin.compile({ path: '$.containers[*]' });
  const scopes = scope.select({ filepath: FILEPATH, source });

  assert.deepStrictEqual(scopes.map(entry => entry.id), ['0:/containers/0', '0:/containers/1']);
  assert.equal(scopes[0]?.source, '{<<: *defaults, name: api}');
  assert.deepStrictEqual(scopes[0]?.data, { name: 'api', request: '512Mi', limit: '1Gi' });
  assert.equal(scopes[1]?.source, '*defaults');
  assert.deepStrictEqual(scopes[1]?.data, { request: '512Mi', limit: '1Gi' });
});

test('changing an anchored value changes the resolved data', () => {
  const scope = yamlPlugin.compile({ path: '$.containers[*]' });
  const small = scope.select({ filepath: FILEPATH, source: 'defaults: &d {request: 512Mi}\ncontainers:\n  - *d\n' });
  const large = scope.select({ filepath: FILEPATH, source: 'defaults: &d {request: 2Gi}\ncontainers:\n  - *d\n' });

  assert.deepStrictEqual(small[0]?.data, { request: '512Mi' });
  assert.deepStrictEqual(large[0]?.data, { request: '2Gi' });
  assert.equal(small[0]?.source, large[0]?.source);
});

test('nested aliases stop at the alias budget instead of expanding without bound', () => {
  const scope = yamlPlugin.compile({ path: '$' });
  const bomb = [
    'a0: &a0 [x]',
    ...Array.from({ length: 8 }, (_, index) => `a${index + 1}: &a${index + 1} [*a${index}, *a${index}]`),
    '',
  ].join('\n');

  assert.throws(() => scope.select({ filepath: FILEPATH, source: bomb }), Error);
});

test('a __proto__ mapping key stays an own key instead of polluting the prototype', () => {
  const scope = yamlPlugin.compile({ path: '$' });
  const scopes = scope.select({ filepath: FILEPATH, source: '__proto__: {polluted: true}\nname: api\n' });
  const data: unknown = scopes[0]?.data;

  assert.ok(data !== null && typeof data === 'object');
  assert.ok(Object.hasOwn(data, '__proto__'));
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(data, '__proto__')?.value, { polluted: true });
});

test('absent fields stay absent in data instead of being invented', () => {
  const scope = yamlPlugin.compile({ path: '$.containers[*]', key: '$.name' });
  const scopes = scope.select({ filepath: FILEPATH, source: 'containers:\n  - {name: api, limit: 1Gi}\n' });

  assert.deepStrictEqual(scopes[0]?.data, { name: 'api', limit: '1Gi' });
});

test('malformed YAML source errors instead of yielding empty scopes', () => {
  const scope = yamlPlugin.compile({ path: '$.containers[*]' });
  assert.throws(() => scope.select({ filepath: FILEPATH, source: 'containers:\n  - {name: api\n' }), Error);
});

test('a malformed stream with no document errors instead of yielding no scopes', () => {
  const scope = yamlPlugin.compile({ path: '$' });
  assert.throws(() => scope.select({ filepath: FILEPATH, source: '%YAML bad\n' }), Error);
});

test('a non-finite scalar in data errors', () => {
  const scope = yamlPlugin.compile({ path: '$.value' });
  assert.throws(() => scope.select({ filepath: FILEPATH, source: 'value: .inf\n' }), Error);
});

test('a key that misses, matches several values or is not scalar errors', () => {
  const missing = yamlPlugin.compile({ path: '$.containers[*]', key: '$.id' });
  assert.throws(() => missing.select({ filepath: FILEPATH, source: CONTAINERS }), Error);

  const tooMany = yamlPlugin.compile({ path: '$.containers[*]', key: '$.*' });
  assert.throws(() => tooMany.select({ filepath: FILEPATH, source: CONTAINERS }), Error);

  const notScalar = yamlPlugin.compile({ path: '$.containers[*]', key: '$' });
  assert.throws(() => notScalar.select({ filepath: FILEPATH, source: CONTAINERS }), Error);
});

test('a key selector at the root still resolves zero and the empty string', () => {
  const scope = yamlPlugin.compile({ path: '$.services[*]', key: '$' });
  const scopes = scope.select({ filepath: FILEPATH, source: 'services:\n  - ""\n  - 0\n' });

  assert.deepStrictEqual(scopes.map(entry => entry.id), ['0:', '0:0']);
  assert.deepStrictEqual(scopes.map(entry => entry.data), ['', 0]);
  assert.deepStrictEqual(scopes.map(entry => entry.source), ['""', '0']);
});

test('compile rejects missing, empty and non-string options', () => {
  assert.throws(() => yamlPlugin.compile({}), Error);
  assert.throws(() => yamlPlugin.compile({ path: '' }), Error);
  assert.throws(() => yamlPlugin.compile({ path: 1 }), Error);
  assert.throws(() => yamlPlugin.compile({ path: '$', key: '' }), Error);
});

const EXECUTABLE_SELECTORS: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  { path: '$[?(@.name)]' },
  { path: '$[(1)]' },
  { path: '$.containers[?(@.limit)]' },
  { path: "$.items['(0)']" },
  { path: '$', key: '$[?(@.name)]' },
  { path: '$.items[*]', key: "$['(0)']" },
];

for (const options of EXECUTABLE_SELECTORS) {
  test(`compile rejects executable JSONPath in ${JSON.stringify(options)}`, () => {
    assert.throws(() => yamlPlugin.compile(options), Error);
  });
}

test('a quoted key that is not executable still selects its own node', () => {
  const scope = yamlPlugin.compile({ path: "$.items['a(b)']" });
  const scopes = scope.select({ filepath: FILEPATH, source: "items:\n  'a(b)': 1\n" });

  assert.deepStrictEqual(scopes.map(entry => entry.id), ['0:/items/a(b)']);
  assert.deepStrictEqual(scopes.map(entry => entry.source), ['1']);
  assert.deepStrictEqual(scopes.map(entry => entry.data), [1]);
});

test('a merge sequence applies earlier sources first with explicit keys winning', () => {
  const source = [
    'first: &first {shared: first, x: 1}',
    'second: &second {shared: second, y: 2}',
    'merged: {<<: [*first, *second], x: 9}',
    '',
  ].join('\n');
  const scopes = yamlPlugin.compile({ path: '$.merged' }).select({ filepath: FILEPATH, source });

  assert.equal(scopes[0]?.source, '{<<: [*first, *second], x: 9}');
  assert.deepStrictEqual(scopes[0]?.data, { shared: 'first', x: 9, y: 2 });
});

test('mapping keys resolve through JSON Pointer escapes', () => {
  const scopes = yamlPlugin
    .compile({ path: '$.*' })
    .select({ filepath: FILEPATH, source: "'a/b': 1\n'a~b': 2\n" });

  assert.deepStrictEqual(scopes.map(entry => entry.id), ['0:/a~1b', '0:/a~0b']);
  assert.deepStrictEqual(scopes.map(entry => entry.source), ['1', '2']);
  assert.deepStrictEqual(scopes.map(entry => entry.data), [1, 2]);
});

test('a non-finite scalar mapping key is stringified rather than rejected', () => {
  const scopes = yamlPlugin
    .compile({ path: '$.*' })
    .select({ filepath: FILEPATH, source: '.inf: 1\n.nan: 2\n' });

  assert.deepStrictEqual(scopes.map(entry => entry.id), ['0:/Infinity', '0:/NaN']);
  assert.deepStrictEqual(scopes.map(entry => entry.data), [1, 2]);
});
