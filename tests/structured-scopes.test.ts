import assert from 'node:assert/strict';
import { test } from 'node:test';

import { csv, parseCsv } from '../dist/adapter/scope/csv.js';
import { file } from '../dist/adapter/scope/file.js';
import { json, parseJson } from '../dist/adapter/scope/json.js';
import { yaml, parseYaml } from '../dist/adapter/scope/yaml.js';
import { wholeFileScope } from '../dist/app/selection.js';
import type { ScopeMatch, ScopeSelector, SourceFile } from '../dist/index.js';

interface LineSpan {
  readonly start: number;
  readonly end: number;
}

interface Observed {
  readonly id: string;
  readonly source: string;
  readonly lines?: LineSpan;
  readonly data?: unknown;
}

function plainData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => plainData(item));
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: plainData((value as Record<string, unknown>)[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  }
  return value;
}

function assertPrototypeSafe(value: unknown, label: string): void {
  assert.ok(value !== null && typeof value === 'object', `${label} is an object`);
  const prototype: unknown = Object.getPrototypeOf(value);
  assert.ok(
    prototype === Object.prototype || prototype === null,
    `${label} is prototype-safe, got prototype ${String(prototype)}`,
  );
}

function observe(match: Observed): Record<string, unknown> {
  return { id: match.id, source: match.source, data: plainData(match.data), lines: match.lines };
}

function scope(id: string, source: string, lines: LineSpan, data?: unknown): Record<string, unknown> {
  return { id, source, data, lines };
}

function collect<T>(
  selector: ScopeSelector<T>,
  source: string,
  filepath = 'input.txt',
): Promise<readonly ScopeMatch<T>[]> {
  return Promise.resolve().then(() => selector({ filepath, source }));
}

function normalizeRow(data: unknown): unknown {
  if (data === undefined) return undefined;
  if (Array.isArray(data)) return [...(data as readonly string[])];
  return { ...(data as Readonly<Record<string, string>>) };
}

function csvSighting(match: Observed): Record<string, unknown> {
  return { id: match.id, source: match.source, data: normalizeRow(match.data), lines: match.lines };
}

test('the file selector produces one scope holding the complete text', async () => {
  const selector = file();
  assert.equal(typeof selector, 'function');
  const matches = await collect(selector, 'first\nsecond\n');
  assert.deepStrictEqual(matches.map(observe), [
    scope('$', 'first\nsecond\n', { start: 1, end: 2 }),
  ]);
  assert.equal(Object.hasOwn(matches[0]!, 'data'), false);
});

test('the file selector covers empty, single-line, and terminated text', async () => {
  const selector = file();
  assert.deepStrictEqual((await collect(selector, '')).map(observe), [
    scope('$', '', { start: 1, end: 1 }),
  ]);
  assert.deepStrictEqual((await collect(selector, 'a')).map(observe), [
    scope('$', 'a', { start: 1, end: 1 }),
  ]);
  assert.deepStrictEqual((await collect(selector, 'a\nb')).map(observe), [
    scope('$', 'a\nb', { start: 1, end: 2 }),
  ]);
  assert.deepStrictEqual((await collect(selector, 'a\nb\n')).map(observe), [
    scope('$', 'a\nb\n', { start: 1, end: 2 }),
  ]);
  assert.deepStrictEqual((await collect(selector, 'a\n\nb')).map(observe), [
    scope('$', 'a\n\nb', { start: 1, end: 3 }),
  ]);
});

test('the file selector counts LF, CRLF, and lone CR breaks', async () => {
  const selector = file();
  assert.deepStrictEqual((await collect(selector, 'a\r\nb')).map(observe), [
    scope('$', 'a\r\nb', { start: 1, end: 2 }),
  ]);
  assert.deepStrictEqual((await collect(selector, 'a\r\nb\r\n')).map(observe), [
    scope('$', 'a\r\nb\r\n', { start: 1, end: 2 }),
  ]);
  assert.deepStrictEqual((await collect(selector, 'a\rb')).map(observe), [
    scope('$', 'a\rb', { start: 1, end: 2 }),
  ]);
});

test('the file selector delegates to the shared whole-file scope', async () => {
  for (const source of ['', 'a', 'a\nb\n', 'a\n\nb', 'a\r\nb\r\n', 'a\rb']) {
    const input: SourceFile = { filepath: 'input.txt', source };
    assert.deepStrictEqual(
      (await collect(file(), source)).map(observe),
      wholeFileScope(input).map(observe),
      `whole-file scope for ${JSON.stringify(source)}`,
    );
  }
});

const NESTED_JSON = '{"a": {"b": [1, 2]}}\n';
const MULTILINE_JSON = '{\n  "a": [\n    1,\n    2\n  ]\n}\n';
const KEYED_JSON = '{"a/b": 1, "~x": 3}';
const KEYED_JSON_ITEMS = '{\n  "items": [\n    {"n": 2},\n    {"n": 3}\n  ]\n}\n';

test('the json selector slices the exact text of a nested value', async () => {
  const selector = json({ path: '$.a.b[1]' });
  assert.equal(typeof selector, 'function');
  assert.deepStrictEqual((await collect(selector, NESTED_JSON)).map(observe), [
    scope('/a/b/1', '2', { start: 1, end: 1 }, 2),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$.a.b[0]' }), NESTED_JSON)).map(observe), [
    scope('/a/b/0', '1', { start: 1, end: 1 }, 1),
  ]);
});

test('the json selector slices container nodes and the document root', async () => {
  assert.deepStrictEqual((await collect(json({ path: '$' }), NESTED_JSON)).map(observe), [
    scope('$', '{"a": {"b": [1, 2]}}', { start: 1, end: 1 }, { a: { b: [1, 2] } }),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$.a' }), NESTED_JSON)).map(observe), [
    scope('/a', '{"b": [1, 2]}', { start: 1, end: 1 }, { b: [1, 2] }),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$.a.b' }), NESTED_JSON)).map(observe), [
    scope('/a/b', '[1, 2]', { start: 1, end: 1 }, [1, 2]),
  ]);
  assert.deepStrictEqual((await collect(json(), NESTED_JSON)).map(observe), [
    scope('$', '{"a": {"b": [1, 2]}}', { start: 1, end: 1 }, { a: { b: [1, 2] } }),
  ]);
});

test('the json selector keeps falsy roots and falsy nested values real', async () => {
  const falsy: readonly (readonly [string, unknown])[] = [
    ['0', 0],
    ['false', false],
    ['null', null],
    ['""', ''],
  ];
  for (const [source, data] of falsy) {
    assert.deepStrictEqual(
      (await collect(json({ path: '$' }), source)).map(observe),
      [scope('$', source, { start: 1, end: 1 }, data)],
      `json root ${source}`,
    );
  }
  assert.deepStrictEqual((await collect(json({ path: '$.a.b' }), '{"a": {"b": ""}}')).map(observe), [
    scope('/a/b', '""', { start: 1, end: 1 }, ''),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$.a.b' }), '{"a": {"b": 0}}')).map(observe), [
    scope('/a/b', '0', { start: 1, end: 1 }, 0),
  ]);
});

test('the json selector locates values across CRLF, lone CR, and multiline text', async () => {
  assert.deepStrictEqual((await collect(json({ path: '$.a' }), '{\r\n  "a": 1\r\n}\r\n')).map(observe), [
    scope('/a', '1', { start: 2, end: 2 }, 1),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$.a' }), '{\r  "a": 1\r}\r')).map(observe), [
    scope('/a', '1', { start: 2, end: 2 }, 1),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$.a' }), MULTILINE_JSON)).map(observe), [
    scope('/a', '[\n    1,\n    2\n  ]', { start: 2, end: 5 }, [1, 2]),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$.a[1]' }), MULTILINE_JSON)).map(observe), [
    scope('/a/1', '2', { start: 4, end: 4 }, 2),
  ]);
});

test('the json selector keeps escaped string slices next to decoded data', async () => {
  assert.deepStrictEqual((await collect(json({ path: '$.a' }), '{"a": "x\\ty"}')).map(observe), [
    scope('/a', '"x\\ty"', { start: 1, end: 1 }, 'x\ty'),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$' }), '"scalar"')).map(observe), [
    scope('$', '"scalar"', { start: 1, end: 1 }, 'scalar'),
  ]);
});

test('the json selector decodes escaped and numeric object keys', async () => {
  assert.deepStrictEqual((await collect(json({ path: '$["a/b"]' }), KEYED_JSON)).map(observe), [
    scope('/a~1b', '1', { start: 1, end: 1 }, 1),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$["~x"]' }), KEYED_JSON)).map(observe), [
    scope('/~0x', '3', { start: 1, end: 1 }, 3),
  ]);
  assert.deepStrictEqual((await collect(json({ path: "$['1']" }), '{"1": 2}')).map(observe), [
    scope('/1', '2', { start: 1, end: 1 }, 2),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$[1]' }), '[10, 20]')).map(observe), [
    scope('/1', '20', { start: 1, end: 1 }, 20),
  ]);
});

test('the json selector uses a key selector value as the scope id', async () => {
  assert.deepStrictEqual(
    (await collect(json({ path: '$.items[*]', key: '$.n' }), KEYED_JSON_ITEMS)).map(observe),
    [
      scope('2', '{"n": 2}', { start: 3, end: 3 }, { n: 2 }),
      scope('3', '{"n": 3}', { start: 4, end: 4 }, { n: 3 }),
    ],
  );
  assert.deepStrictEqual(
    (await collect(json({ path: '$.items[*]', key: '$.n' }), '{"items": [{"n": 0}]}')).map(observe),
    [scope('0', '{"n": 0}', { start: 1, end: 1 }, { n: 0 })],
  );
  await assert.rejects(
    () => collect(json({ path: '$.items[*]', key: '$.n' }), '{"items": [{"n": {}}]}'),
    /string or finite number/i,
    'non-scalar key',
  );
  await assert.rejects(
    () => collect(json({ path: '$.items[*]', key: '$.zz' }), '{"items": [{"n": 1}]}'),
    /exactly one/i,
    'missing key',
  );
});

test('the json selector resolves __proto__ keys without touching prototypes', async () => {
  assert.deepStrictEqual(
    (await collect(json({ path: "$['__proto__']['x']" }), '{"__proto__": {"x": 5}, "b": 2}')).map(observe),
    [scope('/__proto__/x', '5', { start: 1, end: 1 }, 5)],
  );
  const matches = await collect(json({ path: '$' }), '{"__proto__": 1, "b": 2}');
  const data = matches[0]?.data;
  assert.ok(data !== null && typeof data === 'object');
  assertPrototypeSafe(data, 'json root data');
  assert.ok(Object.hasOwn(data, '__proto__'));
  assert.deepStrictEqual(plainData(data), plainData(JSON.parse('{"__proto__": 1, "b": 2}')));
  assert.equal(({} as Record<string, unknown>)['x'], undefined);
});

test('the json selector evaluates recursive paths without invented constraints', async () => {
  assert.deepStrictEqual((await collect(json({ path: '$..a2' }), '{"a": {"a2": 7}, "z": 8}')).map(observe), [
    scope('/a/a2', '7', { start: 1, end: 1 }, 7),
  ]);
});

test('the json selector maps reserved property names to genuine JSON pointers', async () => {
  assert.deepStrictEqual((await collect(json({ path: '$..*' }), '{"~":1,"other":2}')).map(observe), [
    scope('/~0', '1', { start: 1, end: 1 }, 1),
    scope('/other', '2', { start: 1, end: 1 }, 2),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$.*' }), '{"^":"x"}')).map(observe), [
    scope('/^', '"x"', { start: 1, end: 1 }, 'x'),
  ]);
  assert.deepStrictEqual(
    (await collect(json({ path: '$..*' }), '{"~":0,"^":false,"@z()":null,"e":""}')).map(observe),
    [
      scope('/~0', '0', { start: 1, end: 1 }, 0),
      scope('/^', 'false', { start: 1, end: 1 }, false),
      scope('/@z()', 'null', { start: 1, end: 1 }, null),
      scope('/e', '""', { start: 1, end: 1 }, ''),
    ],
  );
});

test('the json selector keeps reserved names distinct in nested objects and arrays', async () => {
  assert.deepStrictEqual((await collect(json({ path: '$..*' }), '{"a":{"b":{"~":1}}}')).map(observe), [
    scope('/a', '{"b":{"~":1}}', { start: 1, end: 1 }, { b: { '~': 1 } }),
    scope('/a/b', '{"~":1}', { start: 1, end: 1 }, { '~': 1 }),
    scope('/a/b/~0', '1', { start: 1, end: 1 }, 1),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$..*' }), '{"~":[1]}')).map(observe), [
    scope('/~0', '[1]', { start: 1, end: 1 }, [1]),
    scope('/~0/0', '1', { start: 1, end: 1 }, 1),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$..*' }), '{"a":{"~":{"b":1}}}')).map(observe), [
    scope('/a', '{"~":{"b":1}}', { start: 1, end: 1 }, { '~': { b: 1 } }),
    scope('/a/~0', '{"b":1}', { start: 1, end: 1 }, { b: 1 }),
    scope('/a/~0/b', '1', { start: 1, end: 1 }, 1),
  ]);
  assert.deepStrictEqual((await collect(json({ path: '$..*' }), '{"a/b":{"~x":{"~":2}}}')).map(observe), [
    scope('/a~1b', '{"~x":{"~":2}}', { start: 1, end: 1 }, { '~x': { '~': 2 } }),
    scope('/a~1b/~0x', '{"~":2}', { start: 1, end: 1 }, { '~': 2 }),
    scope('/a~1b/~0x/~0', '2', { start: 1, end: 1 }, 2),
  ]);
});

test('the json selector returns no subjects for supported paths without matches', async () => {
  assert.deepStrictEqual(await collect(json({ path: '$.missing' }), '{"a": 1}'), []);
  assert.deepStrictEqual(await collect(json({ path: '$.a[0]' }), '{"a": 1}'), []);
  assert.deepStrictEqual(await collect(json({ path: '$.a.b' }), '{"a": 1}'), []);
});

test('the json selector rejects malformed documents instead of recovering them', async () => {
  const malformed = ['', '  ', '{"a": 1,}', '{"a": /* c */ 1}', '{"a": 1} // c', '{"a":', '{'];
  for (const source of malformed) {
    await assert.rejects(
      () => collect(json({ path: '$' }), source),
      /JSON|parse|empty/i,
      `json source ${JSON.stringify(source)}`,
    );
  }
});

test('the json selector rejects duplicate object keys', async () => {
  await assert.rejects(
    () => collect(json({ path: '$.a' }), '{"a": 1, "a": 2}'),
    /duplicate|unique|JSON/i,
    'duplicate key',
  );
  await assert.rejects(
    () => collect(json({ path: '$' }), '{"a": {"b": 1, "b": 2}}'),
    /duplicate|unique|JSON/i,
    'nested duplicate key',
  );
});

test('the json selector rejects non-finite numbers', async () => {
  await assert.rejects(
    () => collect(json({ path: '$.a' }), '{"a": 1e999}'),
    /finite|JSON/i,
    'non-finite number',
  );
});

test('the json factory validates its JSONPath options eagerly', () => {
  assert.throws(() => json({ path: '' }), /path/i, 'empty path');
  assert.throws(() => json({ path: 1 as unknown as string }), /path/i, 'non-string path');
  assert.throws(() => json({ path: 'a.b' }), /path|\$/i, 'unrooted path');
  assert.throws(() => json({ path: '$.a[?(@.b)]' }), /executable/i, 'executable filter path');
  assert.throws(() => json({ path: '$[(@)]' }), /executable/i, 'executable expression path');
  assert.throws(() => json({ key: '' }), /key/i, 'empty key');
  assert.throws(() => json({ key: '$[?(@)]' }), /executable/i, 'executable key');
});

test('the json factory rejects a null path', () => {
  assert.throws(() => json({ path: null as unknown as string }), /path/i);
});

test('a library-reported JSONPath error surfaces from evaluation', async () => {
  await assert.rejects(
    async () => collect(json({ path: '$.@' }), '{"a": 1}'),
    /unknown value type/i,
    'library error',
  );
});

test('the json factory surfaces a library-reported path error at construction', () => {
  assert.throws(() => json({ path: '$.@' }), /unknown value type/i, 'library-reported path');
  assert.throws(() => json({ key: '$.@' }), /unknown value type/i, 'library-reported key');
  assert.throws(() => json({ path: '$.a[?(@.b)]' }), /executable/i, 'executable path');
  assert.throws(() => json({ key: '$[?(@)]' }), /executable/i, 'executable key');
});

test('the json factory keeps the permissive paths jsonpath-plus itself accepts', () => {
  const permissive = [
    '$',
    '$.a',
    '$.a.b',
    '$..b',
    '$..*',
    '$.*',
    '$.a[0]',
    '$.a[*]',
    '$.a[*].b',
    '$[0]',
    '$["a b"]',
    "$['a']['b']",
  ];
  for (const path of permissive) {
    assert.doesNotThrow(() => json({ path }), `path ${path}`);
    assert.doesNotThrow(() => json({ key: path }), `key ${path}`);
  }
});

test('parseJson returns strict JSON values including falsy roots', () => {
  assert.deepStrictEqual(plainData(parseJson('{"a": [1, {"b": null}]}')), { a: [1, { b: null }] });
  assert.equal(parseJson('0'), 0);
  assert.equal(parseJson('false'), false);
  assert.equal(parseJson('null'), null);
  assert.equal(parseJson('""'), '');
});

test('parseJson preserves a __proto__ key as an own property', () => {
  const value = parseJson('{"__proto__": 1, "b": 2}');
  assert.ok(value !== null && typeof value === 'object');
  assertPrototypeSafe(value, 'parsed json');
  assert.ok(Object.hasOwn(value, '__proto__'));
  assert.deepStrictEqual(plainData(value), plainData(JSON.parse('{"__proto__": 1, "b": 2}')));
});

test('parseJson rejects every strict-JSON violation', () => {
  const malformed = ['', '  ', '{"a": 1,}', '{"a": /* c */ 1}', '{"a": 1} // c', '{"a":', '{', '[]}'];
  for (const source of malformed) {
    assert.throws(() => parseJson(source), /JSON|parse|empty/i, `json source ${JSON.stringify(source)}`);
  }
});

const MULTI_DOC_YAML = 'a: 1\n---\nb: 2\n';
const MERGE_YAML = 'base: &b\n  x: 1\nuse:\n  <<: *b\n  y: 2\n';
const ALIAS_YAML = 'base: &b\n  x: 1\nuse: *b\n';
const NESTED_ALIAS_YAML = 'a: &a [1,2]\nb: &b [*a,*a]\nc: &c [*b,*b]\n';
const KEYED_YAML = 'items:\n  - n: 2\n  - n: 3\n';
const ALIAS_BLOWUP_YAML = [
  'a: &a [1,2]',
  'b: &b [*a,*a]',
  'c: &c [*b,*b]',
  'd: &d [*c,*c]',
  'e: &e [*d,*d]',
  'f: &f [*e,*e]',
  'g: &g [*f,*f]',
  'h: &h [*g,*g]',
  'i: &i [*h,*h]',
  'j: &j [*i,*i]',
  '',
].join('\n');

test('the yaml selector maps document pointers to exact source slices', async () => {
  const selector = yaml({ path: '$.b' });
  assert.equal(typeof selector, 'function');
  assert.deepStrictEqual((await collect(selector, 'a: 1\nb: two\n')).map(observe), [
    scope('0:/b', 'two', { start: 2, end: 2 }, 'two'),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), 'a: 1\n')).map(observe), [
    scope('0:', 'a: 1\n', { start: 1, end: 1 }, { a: 1 }),
  ]);
  assert.deepStrictEqual((await collect(yaml(), 'a: 1\n')).map(observe), [
    scope('0:', 'a: 1\n', { start: 1, end: 1 }, { a: 1 }),
  ]);
});

test('the yaml selector prefixes ids with the document index', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), MULTI_DOC_YAML)).map(observe), [
    scope('0:', 'a: 1\n', { start: 1, end: 1 }, { a: 1 }),
    scope('1:', 'b: 2\n', { start: 3, end: 3 }, { b: 2 }),
  ]);
});

test('the yaml selector skips empty documents without renumbering later ones', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), 'a: 1\n---\n---\nb: 2\n')).map(observe), [
    scope('0:', 'a: 1\n', { start: 1, end: 1 }, { a: 1 }),
    scope('2:', 'b: 2\n', { start: 4, end: 4 }, { b: 2 }),
  ]);
  for (const source of ['---\n---\n', '---\n', '', '# comment\n']) {
    assert.deepStrictEqual(
      await collect(yaml({ path: '$' }), source),
      [],
      `no yaml subjects for ${JSON.stringify(source)}`,
    );
  }
});

test('the yaml selector keeps explicit null, false, zero, and empty strings', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), 'null\n')).map(observe), [
    scope('0:', 'null', { start: 1, end: 1 }, null),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), 'false\n')).map(observe), [
    scope('0:', 'false', { start: 1, end: 1 }, false),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), '0\n')).map(observe), [
    scope('0:', '0', { start: 1, end: 1 }, 0),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$.k' }), "k: ''\n")).map(observe), [
    scope('0:/k', "''", { start: 1, end: 1 }, ''),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$.k' }), 'k: null\n')).map(observe), [
    scope('0:/k', 'null', { start: 1, end: 1 }, null),
  ]);
});

test('the yaml selector keeps explicitly tagged empty scalars', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), '!!str\n')).map(observe), [
    scope('0:', '', { start: 1, end: 1 }, ''),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), '!!null\n')).map(observe), [
    scope('0:', '', { start: 1, end: 1 }, null),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$' }), '--- !!str\n')).map(observe), [
    scope('0:', '', { start: 1, end: 1 }, ''),
  ]);
});

test('the yaml selector resolves aliases and merge keys with exact source', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$.use' }), MERGE_YAML)).map(observe), [
    scope('0:/use', '<<: *b\n  y: 2\n', { start: 4, end: 5 }, { x: 1, y: 2 }),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$.use' }), ALIAS_YAML)).map(observe), [
    scope('0:/use', '*b', { start: 3, end: 3 }, { x: 1 }),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$.c' }), NESTED_ALIAS_YAML)).map(observe), [
    scope('0:/c', '[*b,*b]', { start: 3, end: 3 }, [[[1, 2], [1, 2]], [[1, 2], [1, 2]]]),
  ]);
});

test('the yaml selector maps inherited alias and merge descendants to their original source', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$.use.x' }), MERGE_YAML)).map(observe), [
    scope('0:/use/x', '1', { start: 2, end: 2 }, 1),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$.use.x' }), ALIAS_YAML)).map(observe), [
    scope('0:/use/x', '1', { start: 2, end: 2 }, 1),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$.use.y' }), MERGE_YAML)).map(observe), [
    scope('0:/use/y', '2', { start: 5, end: 5 }, 2),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$.c[1][0][1]' }), NESTED_ALIAS_YAML)).map(observe), [
    scope('0:/c/1/0/1', '2', { start: 1, end: 1 }, 2),
  ]);
});

test('the yaml selector maps reserved property names to genuine document pointers', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$..*' }), "'~': 1\nother: 2\n")).map(observe), [
    scope('0:/~0', '1', { start: 1, end: 1 }, 1),
    scope('0:/other', '2', { start: 2, end: 2 }, 2),
  ]);
  assert.deepStrictEqual(
    (await collect(yaml({ path: '$..*' }), "base: &b\n  '~': 1\nuse: *b\n")).map(observe),
    [
      scope('0:/base', "'~': 1\n", { start: 2, end: 2 }, { '~': 1 }),
      scope('0:/use', '*b', { start: 3, end: 3 }, { '~': 1 }),
      scope('0:/base/~0', '1', { start: 2, end: 2 }, 1),
      scope('0:/use/~0', '1', { start: 2, end: 2 }, 1),
    ],
  );
});

test('the yaml selector preserves alias traversal occurrences for recursive scalar queries', async () => {
  const source = "'~':\n  x: &o\n    v: 1\nx: *o\n";
  const matches = await collect(yaml({ path: '$..v' }), source);
  assert.deepStrictEqual(matches.map(observe), [
    scope('0:/~0/x/v', '1', { start: 3, end: 3 }, 1),
    scope('0:/x/v', '1', { start: 3, end: 3 }, 1),
  ]);
});

test('the yaml selector preserves alias traversal occurrences for recursive wildcard queries', async () => {
  const source = "'~':\n  x: &o\n    v: 1\nx: *o\n";
  const matches = await collect(yaml({ path: '$..*' }), source);
  assert.deepStrictEqual(matches.map(observe), [
    scope('0:/~0', 'x: &o\n    v: 1\n', { start: 2, end: 3 }, { x: { v: 1 } }),
    scope('0:/x', '*o', { start: 4, end: 4 }, { v: 1 }),
    scope('0:/~0/x', 'v: 1\n', { start: 3, end: 3 }, { v: 1 }),
    scope('0:/~0/x/v', '1', { start: 3, end: 3 }, 1),
    scope('0:/x/v', '1', { start: 3, end: 3 }, 1),
  ]);
});

test('the yaml selector distinguishes aliases reached entirely through reserved names', async () => {
  const source = "'~': &o\n  '^': 1\n'^': *o\n";
  assert.deepStrictEqual((await collect(yaml({ path: '$..*' }), source)).map(observe), [
    scope('0:/~0', "'^': 1\n", { start: 2, end: 2 }, { '^': 1 }),
    scope('0:/^', '*o', { start: 3, end: 3 }, { '^': 1 }),
    scope('0:/~0/^', '1', { start: 2, end: 2 }, 1),
    scope('0:/^/^', '1', { start: 2, end: 2 }, 1),
  ]);
});

test('the yaml selector preserves aliased array positions with repeated scalar values', async () => {
  const source = "base: &a [1, 1]\n'~': *a\n'^': *a\n";
  const matches = await collect(yaml({ path: '$..*' }), source);
  assert.deepStrictEqual(matches.map(observe), [
    scope('0:/base', '[1, 1]', { start: 1, end: 1 }, [1, 1]),
    scope('0:/~0', '*a', { start: 2, end: 2 }, [1, 1]),
    scope('0:/^', '*a', { start: 3, end: 3 }, [1, 1]),
    scope('0:/base/0', '1', { start: 1, end: 1 }, 1),
    scope('0:/base/1', '1', { start: 1, end: 1 }, 1),
    scope('0:/~0/0', '1', { start: 1, end: 1 }, 1),
    scope('0:/~0/1', '1', { start: 1, end: 1 }, 1),
    scope('0:/^/0', '1', { start: 1, end: 1 }, 1),
    scope('0:/^/1', '1', { start: 1, end: 1 }, 1),
  ]);
});

test('the yaml selector locates keyed scalars after CRLF breaks', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$.b' }), 'a: 1\r\nb: 2\r\n')).map(observe), [
    scope('0:/b', '2', { start: 2, end: 2 }, 2),
  ]);
});

test('the yaml selector keeps block scalar text and spans', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$.a' }), 'a: |\n  l1\n  l2\nb: 2\n')).map(observe), [
    scope('0:/a', '|\n  l1\n  l2\n', { start: 1, end: 3 }, 'l1\nl2\n'),
  ]);
});

test('the yaml selector rejects non-JSON-compatible data', async () => {
  await assert.rejects(
    () => collect(yaml({ path: '$.a' }), 'a: &c\n  self: *c\n'),
    /cycl/i,
    'cyclic alias',
  );
  await assert.rejects(() => collect(yaml({ path: '$.a' }), 'a: .inf\n'), /finite/i, 'non-finite value');
  await assert.rejects(() => collect(yaml({ path: '$' }), '.nan\n'), /finite/i, 'non-finite root');
  await assert.rejects(
    () => collect(yaml({ path: '$.a' }), 'a: !!set\n  ? x\n'),
    /JSON-compatible|unsupported/i,
    'unsupported value',
  );
  await assert.rejects(
    () => collect(yaml({ path: '$.j' }), ALIAS_BLOWUP_YAML),
    /alias/i,
    'excessive alias count',
  );
});

test('the yaml selector reports parse errors in any document', async () => {
  await assert.rejects(
    () => collect(yaml({ path: '$.a' }), 'a: 1\n---\nb: [1,\n'),
    /parse/i,
    'error in a later document even when the path matched earlier',
  );
  await assert.rejects(
    () => collect(yaml({ path: '$.a' }), 'a: 1\na: 2\n'),
    /parse|unique/i,
    'duplicate key error',
  );
});

test('the yaml selector uses a key selector value as the scope id', async () => {
  assert.deepStrictEqual(
    (await collect(yaml({ path: '$.items[*]', key: '$.n' }), KEYED_YAML)).map(observe),
    [
      scope('0:2', 'n: 2\n', { start: 2, end: 2 }, { n: 2 }),
      scope('0:3', 'n: 3\n', { start: 3, end: 3 }, { n: 3 }),
    ],
  );
});

test('the yaml selector keys falsy roots from their own data', async () => {
  assert.deepStrictEqual((await collect(yaml({ path: '$', key: '$' }), '0\n')).map(observe), [
    scope('0:0', '0', { start: 1, end: 1 }, 0),
  ]);
  assert.deepStrictEqual((await collect(yaml({ path: '$', key: '$' }), "''\n")).map(observe), [
    scope('0:', "''", { start: 1, end: 1 }, ''),
  ]);
  await assert.rejects(
    () => collect(yaml({ path: '$', key: '$' }), 'false\n'),
    /string or finite number/i,
    'boolean key',
  );
  await assert.rejects(
    () => collect(yaml({ path: '$', key: '$' }), 'null\n'),
    /string or finite number/i,
    'null key',
  );
});

test('the yaml selector rejects keys that are missing, multi-valued, or non-scalar', async () => {
  await assert.rejects(
    () => collect(yaml({ path: '$.items[*]', key: '$.n' }), 'items:\n  - n: {}\n'),
    /string or finite number/i,
    'object key',
  );
  await assert.rejects(
    () => collect(yaml({ path: '$.items[*]', key: '$.zz' }), 'items:\n  - n: 1\n'),
    /exactly one/i,
    'missing key',
  );
  await assert.rejects(
    () => collect(yaml({ path: '$.items[*]', key: '$..n' }), 'items:\n  - n: 1\n    m: {n: 2}\n'),
    /exactly one/i,
    'multi-valued key',
  );
});

test('the yaml selector leaves duplicate keyed ids to the engine', async () => {
  const matches = await collect(yaml({ path: '$.items[*]', key: '$.n' }), 'items:\n  - n: 1\n  - n: 1\n');
  assert.deepStrictEqual(matches.map(observe), [
    scope('0:1', 'n: 1\n', { start: 2, end: 2 }, { n: 1 }),
    scope('0:1', 'n: 1\n', { start: 3, end: 3 }, { n: 1 }),
  ]);
});

test('the yaml factory validates its JSONPath options eagerly', () => {
  assert.throws(() => yaml({ path: '' }), /path/i, 'empty path');
  assert.throws(() => yaml({ path: 1 as unknown as string }), /path/i, 'non-string path');
  assert.throws(() => yaml({ path: 'a.b' }), /path|\$/i, 'unrooted path');
  assert.throws(() => yaml({ path: '$.a[?(@.b)]' }), /executable/i, 'executable path');
  assert.throws(() => yaml({ key: '' }), /key/i, 'empty key');
  assert.throws(() => yaml({ key: '$[?(@)]' }), /executable/i, 'executable key');
});

test('the yaml factory rejects a null path', () => {
  assert.throws(() => yaml({ path: null as unknown as string }), /path/i);
});

test('the yaml factory surfaces a library-reported path error at construction', () => {
  assert.throws(() => yaml({ path: '$.@' }), /unknown value type/i, 'library-reported path');
  assert.throws(() => yaml({ key: '$.@' }), /unknown value type/i, 'library-reported key');
  assert.throws(() => yaml({ path: '$.a[?(@.b)]' }), /executable/i, 'executable path');
  assert.throws(() => yaml({ key: '$[?(@)]' }), /executable/i, 'executable key');
});

test('the yaml factory keeps the permissive paths jsonpath-plus itself accepts', () => {
  const permissive = [
    '$',
    '$.a',
    '$.a.b',
    '$..b',
    '$..*',
    '$.*',
    '$.a[0]',
    '$.a[*]',
    '$.a[*].b',
    '$[0]',
    '$["a b"]',
    "$['a']['b']",
  ];
  for (const path of permissive) {
    assert.doesNotThrow(() => yaml({ path }), `path ${path}`);
    assert.doesNotThrow(() => yaml({ key: path }), `key ${path}`);
  }
});

test('parseYaml returns one value per nonempty document in order', () => {
  assert.deepStrictEqual(parseYaml(MULTI_DOC_YAML), [{ a: 1 }, { b: 2 }]);
  assert.deepStrictEqual(parseYaml('a: 1\n---\n'), [{ a: 1 }]);
  assert.deepStrictEqual(parseYaml('---\n---\n'), []);
  assert.deepStrictEqual(parseYaml(''), []);
  assert.deepStrictEqual(parseYaml('null\n'), [null]);
  assert.deepStrictEqual(parseYaml("k: ''\n"), [{ k: '' }]);
});

test('parseYaml resolves aliases and merge keys into JSON-compatible data', () => {
  assert.deepStrictEqual(parseYaml(MERGE_YAML), [{ base: { x: 1 }, use: { x: 1, y: 2 } }]);
  assert.deepStrictEqual(parseYaml(NESTED_ALIAS_YAML), [
    { a: [1, 2], b: [[1, 2], [1, 2]], c: [[[1, 2], [1, 2]], [[1, 2], [1, 2]]] },
  ]);
});

test('parseYaml rejects parse, duplicate-key, and non-JSON data', () => {
  assert.throws(() => parseYaml('a: 1\n---\nb: [1,\n'), /parse/i, 'later document error');
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /parse|unique/i, 'duplicate keys');
  assert.throws(() => parseYaml('a: &c\n  self: *c\n'), /cycl/i, 'cyclic alias');
  assert.throws(() => parseYaml('a: .inf\n'), /finite/i, 'non-finite number');
  assert.throws(() => parseYaml('a: !!set\n  ? x\n'), /JSON-compatible|unsupported/i, 'unsupported value');
});

test('parseYaml keeps explicitly tagged empty scalars', () => {
  assert.deepStrictEqual(parseYaml('!!str\n'), ['']);
  assert.deepStrictEqual(parseYaml('!!null\n'), [null]);
  assert.deepStrictEqual(parseYaml('--- !!str x\n'), ['x']);
  assert.deepStrictEqual(parseYaml('---\n---\n'), []);
});

const QUOTED_CSV = 'name,note\n"a,1","q""q"\nplain,simple\n';
const MULTILINE_CSV = 'id,text\n1,"line1\nline2"\n';
const SPACING_CSV = 'a,b\n 1 ,x\n';
const BOM_CSV = '\uFEFFa,b\n1,2\n';
const BLANK_CSV = 'a,b\n1,2\n\n3,4\n';
const KEYED_CSV = 'name,value\nalpha,1\nbeta,2\n';

test('the csv selector keeps quoted separators, escaped quotes, and exact slices', async () => {
  const selector = csv();
  assert.equal(typeof selector, 'function');
  assert.deepStrictEqual((await collect(selector, QUOTED_CSV)).map(csvSighting), [
    scope('row:1', '"a,1","q""q"', { start: 2, end: 2 }, { name: 'a,1', note: 'q"q' }),
    scope('row:2', 'plain,simple', { start: 3, end: 3 }, { name: 'plain', note: 'simple' }),
  ]);
});

test('the csv selector spans multiline fields on their physical lines', async () => {
  assert.deepStrictEqual((await collect(csv(), MULTILINE_CSV)).map(csvSighting), [
    scope('row:1', '1,"line1\nline2"', { start: 2, end: 3 }, { id: '1', text: 'line1\nline2' }),
  ]);
});

test('the csv selector keeps field values uncast and untrimmed', async () => {
  assert.deepStrictEqual((await collect(csv(), SPACING_CSV)).map(csvSighting), [
    scope('row:1', ' 1 ,x', { start: 2, end: 2 }, { a: ' 1 ', b: 'x' }),
  ]);
});

test('the csv selector handles LF, CRLF, and lone CR records', async () => {
  assert.deepStrictEqual((await collect(csv(), 'a,b\n1,2\n3,4\n')).map(csvSighting), [
    scope('row:1', '1,2', { start: 2, end: 2 }, { a: '1', b: '2' }),
    scope('row:2', '3,4', { start: 3, end: 3 }, { a: '3', b: '4' }),
  ]);
  assert.deepStrictEqual((await collect(csv(), 'a,b\r\n1,2\r\n3,4\r\n')).map(csvSighting), [
    scope('row:1', '1,2', { start: 2, end: 2 }, { a: '1', b: '2' }),
    scope('row:2', '3,4', { start: 3, end: 3 }, { a: '3', b: '4' }),
  ]);
  assert.deepStrictEqual((await collect(csv(), 'a,b\r1,2\r3,4\r')).map(csvSighting), [
    scope('row:1', '1,2', { start: 2, end: 2 }, { a: '1', b: '2' }),
    scope('row:2', '3,4', { start: 3, end: 3 }, { a: '3', b: '4' }),
  ]);
});

test('the csv selector never attributes blank lines to the next record', async () => {
  assert.deepStrictEqual((await collect(csv(), BLANK_CSV)).map(csvSighting), [
    scope('row:1', '1,2', { start: 2, end: 2 }, { a: '1', b: '2' }),
    scope('row:2', '3,4', { start: 4, end: 4 }, { a: '3', b: '4' }),
  ]);
  assert.deepStrictEqual((await collect(csv(), 'a,b\n1,2\n\n1,2\n')).map(csvSighting), [
    scope('row:1', '1,2', { start: 2, end: 2 }, { a: '1', b: '2' }),
    scope('row:2', '1,2', { start: 4, end: 4 }, { a: '1', b: '2' }),
  ]);
});

test('the csv selector strips a leading BOM from header names', async () => {
  assert.deepStrictEqual((await collect(csv(), BOM_CSV)).map(csvSighting), [
    scope('row:1', '1,2', { start: 2, end: 2 }, { a: '1', b: '2' }),
  ]);
});

test('the csv selector yields no subjects for empty or header-only input', async () => {
  for (const source of ['', 'a,b\n', 'a,b', '\uFEFFa,b\n']) {
    assert.deepStrictEqual(await collect(csv(), source), [], `no csv subjects for ${JSON.stringify(source)}`);
  }
});

test('the csv selector returns positional rows when headers are disabled', async () => {
  assert.deepStrictEqual((await collect(csv({ headers: false }), '1,2\n3,4\n')).map(csvSighting), [
    scope('row:1', '1,2', { start: 1, end: 1 }, ['1', '2']),
    scope('row:2', '3,4', { start: 2, end: 2 }, ['3', '4']),
  ]);
});

test('the csv selector honours an alternate delimiter', async () => {
  assert.deepStrictEqual((await collect(csv({ delimiter: ';' }), 'a;b\n1;2\n')).map(csvSighting), [
    scope('row:1', '1;2', { start: 2, end: 2 }, { a: '1', b: '2' }),
  ]);
  assert.deepStrictEqual((await collect(csv({ delimiter: '\t' }), 'a\tb\n1\t2\n')).map(csvSighting), [
    scope('row:1', '1\t2', { start: 2, end: 2 }, { a: '1', b: '2' }),
  ]);
});

test('the csv selector keeps exact text for multibyte delimiters and content', async () => {
  assert.deepStrictEqual((await collect(csv({ delimiter: 'é' }), 'aéb\n1é2\n')).map(csvSighting), [
    scope('row:1', '1é2', { start: 2, end: 2 }, { a: '1', b: '2' }),
  ]);
  assert.deepStrictEqual((await collect(csv(), 'a,b\né,2\n')).map(csvSighting), [
    scope('row:1', 'é,2', { start: 2, end: 2 }, { a: 'é', b: '2' }),
  ]);
  assert.deepStrictEqual(
    (await collect(csv({ delimiter: 'é', headers: false }), '1é2\n')).map(csvSighting),
    [scope('row:1', '1é2', { start: 1, end: 1 }, ['1', '2'])],
  );
});

test('the csv selector and parser preserve supplementary delimiters with keyed UTF-8 multiline rows', async () => {
  const source = '\uFEFFid😀text\r\nα😀"café😀\r\n雪"\r\n\r\nβ😀fin🚀\r\n';
  const options = { delimiter: '😀', key: 'id' };
  assert.deepStrictEqual((await collect(csv(options), source)).map(csvSighting), [
    scope('α', 'α😀"café😀\r\n雪"', { start: 2, end: 3 }, { id: 'α', text: 'café😀\r\n雪' }),
    scope('β', 'β😀fin🚀', { start: 5, end: 5 }, { id: 'β', text: 'fin🚀' }),
  ]);
  assert.deepStrictEqual(parseCsv(source, options).map(normalizeRow), [
    { id: 'α', text: 'café😀\r\n雪' },
    { id: 'β', text: 'fin🚀' },
  ]);
});

test('the csv factory and parser reject delimiters containing multiple Unicode code points', () => {
  for (const delimiter of ['😀x', 'e\u0301']) {
    assert.throws(() => csv({ delimiter }), /delimiter/i, delimiter);
    assert.throws(() => parseCsv('a,b\n1,2\n', { delimiter }), /delimiter/i, delimiter);
  }
});

test('the csv selector uses a key column value as the scope id', async () => {
  assert.deepStrictEqual((await collect(csv({ key: 'name' }), KEYED_CSV)).map(csvSighting), [
    scope('alpha', 'alpha,1', { start: 2, end: 2 }, { name: 'alpha', value: '1' }),
    scope('beta', 'beta,2', { start: 3, end: 3 }, { name: 'beta', value: '2' }),
  ]);
});

test('the csv selector rejects unknown, blank, and duplicate keys', async () => {
  await assert.rejects(
    () => collect(csv({ key: 'nope' }), KEYED_CSV),
    /key|column|header/i,
    'unknown key',
  );
  await assert.rejects(
    () => collect(csv({ key: 'name' }), 'name,value\n,1\n'),
    /blank|empty|missing/i,
    'blank key value',
  );
  await assert.rejects(
    () => collect(csv({ key: 'name' }), 'name,value\nalpha,1\nalpha,2\n'),
    /duplicate|unique/i,
    'duplicate key ids',
  );
});

test('the csv selector protects rows from a __proto__ header', async () => {
  const matches = await collect(csv(), '__proto__,b\n1,2\n');
  const record = matches[0]?.data as Readonly<Record<string, string>> | undefined;
  assert.ok(record !== undefined);
  assertPrototypeSafe(record, 'csv row');
  assert.ok(Object.hasOwn(record, '__proto__'));
  assert.equal(record['__proto__'], '1');
  assert.equal(record['b'], '2');
  assert.deepStrictEqual({ ...record }, JSON.parse('{"__proto__": "1", "b": "2"}'));
  assert.equal(({} as Record<string, unknown>)['b'], undefined);
});

test('the csv selector rejects ragged records and unclosed quotes', async () => {
  await assert.rejects(() => collect(csv(), 'a,b\n1,2,3\n'), /length|column|field/i, 'extra field');
  await assert.rejects(() => collect(csv(), 'a,b\n1\n'), /length|column|field/i, 'missing field');
  await assert.rejects(() => collect(csv(), 'a,b\n"x,2\n'), /quote/i, 'unclosed quote');
});

test('the csv selector rejects duplicate and empty header names', async () => {
  await assert.rejects(() => collect(csv(), 'a,a\n1,2\n'), /duplicate|column|header/i, 'duplicate header');
  await assert.rejects(() => collect(csv(), 'a,\n1,2\n'), /column|header|empty/i, 'empty header');
});

test('the csv factory validates its options eagerly', () => {
  assert.throws(() => csv({ delimiter: '' }), /delimiter/i, 'empty delimiter');
  assert.throws(() => csv({ delimiter: 'ab' }), /delimiter/i, 'multi-character delimiter');
  assert.throws(() => csv({ delimiter: '"' }), /delimiter/i, 'quote delimiter');
  assert.throws(() => csv({ delimiter: '\n' }), /delimiter/i, 'newline delimiter');
  assert.throws(() => csv({ delimiter: '\r' }), /delimiter/i, 'carriage-return delimiter');
  assert.throws(() => csv({ key: '' }), /key/i, 'empty key');
  assert.throws(() => csv({ headers: false, key: 'name' }), /key/i, 'key without headers');
});

test('the csv factory rejects null headers', () => {
  assert.throws(() => csv({ headers: null as unknown as boolean }), /headers/i);
});

test('the csv factory rejects a null delimiter', () => {
  assert.throws(() => csv({ delimiter: null as unknown as string }), /delimiter/i);
});

test('parseCsv rejects null option fields', () => {
  assert.throws(() => parseCsv(KEYED_CSV, { headers: null as unknown as boolean }), /headers/i);
  assert.throws(() => parseCsv(KEYED_CSV, { delimiter: null as unknown as string }), /delimiter/i);
});

test('parseCsv returns rows without scope metadata', () => {
  assert.deepStrictEqual(parseCsv('a,b\n1,2\n').map(normalizeRow), [{ a: '1', b: '2' }]);
  assert.deepStrictEqual(parseCsv('1,2\n', { headers: false }).map(normalizeRow), [['1', '2']]);
  assert.deepStrictEqual(parseCsv('a;b\n1;2\n', { delimiter: ';' }).map(normalizeRow), [{ a: '1', b: '2' }]);
  assert.deepStrictEqual(parseCsv('aéb\n1é2\n', { delimiter: 'é' }).map(normalizeRow), [{ a: '1', b: '2' }]);
  assert.deepStrictEqual(parseCsv('\uFEFFa,b\n1,2\n').map(normalizeRow), [{ a: '1', b: '2' }]);
});

test('parseCsv preserves quoted separators, quotes, and multiline fields', () => {
  assert.deepStrictEqual(parseCsv('a,b\n"x,1","q""q"\n').map(normalizeRow), [{ a: 'x,1', b: 'q"q' }]);
  assert.deepStrictEqual(parseCsv('a,b\n1,"l1\nl2"\n').map(normalizeRow), [{ a: '1', b: 'l1\nl2' }]);
  assert.deepStrictEqual(parseCsv(' 1 ,x\n', { headers: false }).map(normalizeRow), [[' 1 ', 'x']]);
  assert.deepStrictEqual(parseCsv('a,b\n1,2\n\n3,4\n').map(normalizeRow), [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
});

test('parseCsv rejects malformed input and empty documents', () => {
  assert.deepStrictEqual(parseCsv(''), []);
  assert.deepStrictEqual(parseCsv('a,b\n'), []);
  assert.throws(() => parseCsv('a,b\n1,2,3\n'), /length|column|field/i, 'ragged record');
  assert.throws(() => parseCsv('a,b\n"x,2\n'), /quote/i, 'unclosed quote');
  assert.throws(() => parseCsv('a,a\n1,2\n'), /duplicate|column|header/i, 'duplicate header');
  assert.throws(() => parseCsv('a,\n1,2\n'), /column|header|empty/i, 'empty header');
});
