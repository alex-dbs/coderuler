import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFilter } from './filter.ts';
import type { ScopeMatch } from './plugins/index.ts';
import type { JsonValue } from './plugins/types.ts';

const BASE: ScopeMatch = { id: 's', source: 'text' };

function accepts(path: string, fields: ScopeMatch): boolean {
  return compileFilter({ non_empty: path }).applies(fields);
}

test('a rule without a filter accepts every scope', () => {
  const filter = compileFilter(undefined);
  assert.equal(filter.applies(BASE), true);
  assert.equal(filter.applies({ ...BASE, data: { a: 1 } }), true);
});

test('non_empty is true exactly for a present, non-empty selected value', () => {
  const wrapper: ScopeMatch = {
    ...BASE,
    data: {
      text: 'value', blank: '', space: ' ', zero: 0, no: false,
      list: [1], emptyList: [], map: { key: 1 }, emptyMap: {}, nil: null,
    },
  };
  for (const path of [
    '$.data.text', '$.data.space', '$.data.zero', '$.data.no', '$.data.list', '$.data.map', '$', '$.id', '$.source',
  ]) {
    assert.equal(accepts(path, wrapper), true, `${path} selects a present value`);
  }
  for (const path of ['$.data.blank', '$.data.emptyList', '$.data.emptyMap', '$.data.nil', '$.data.missing']) {
    assert.equal(accepts(path, wrapper), false, `${path} selects nothing present`);
  }
});

test('an absent wrapper field is empty, never an error', () => {
  for (const path of ['$.data', '$.data.missing', '$..anything', '$.captures.NAME', '$.captures.NAME[*]']) {
    assert.equal(accepts(path, BASE), false, `${path} selects nothing present`);
  }
  assert.equal(accepts('$', BASE), true);
});

test('wildcards aggregate their selected nodes, and emptiness is judged per node', () => {
  const cases: readonly [label: string, path: string, data: JsonValue, expected: boolean][] = [
    ['one element of two is non-empty', '$.data.items[*].name', { items: [{ name: '' }, { name: 'a' }] }, true],
    ['one indexed element', '$.data.items[1].name', { items: [{ name: '' }, { name: 'a' }] }, true],
    ['every selected element is blank', '$.data.items[*]', { items: ['', ''] }, false],
    ['an element holding zero is present', '$.data.items[*]', { items: [0] }, true],
    ['no element was selected at all', '$.data.items[*]', { items: [] }, false],
    ['one of two elements is a non-empty object', '$.data.items[*]', { items: [{}, { a: 1 }] }, true],
    // The node the selector chose decides, never the elements inside it.
    ['the whole array is present', '$.data.tags', { tags: [''] }, true],
    ['the array holds only a blank element', '$.data.tags[*]', { tags: [''] }, false],
    ['the array is empty', '$.data.tags', { tags: [] }, false],
    ['the array holds only zero', '$.data.tags[*]', { tags: [0] }, true],
  ];
  for (const [label, path, data, expected] of cases) {
    assert.equal(accepts(path, { ...BASE, data }), expected, label);
  }
});

test('captures are reachable through the wrapper', () => {
  const wrapper: ScopeMatch = { ...BASE, captures: { NAME: 'a', LIST: ['x'], EMPTY: [], BLANK: '' } };
  assert.equal(accepts('$.captures.NAME', wrapper), true);
  assert.equal(accepts('$.captures.LIST[*]', wrapper), true);
  assert.equal(accepts('$.captures.EMPTY[*]', wrapper), false);
  assert.equal(accepts('$.captures.BLANK', wrapper), false);
  assert.equal(accepts('$.captures.MISSING', wrapper), false);
});

test('all, any and not compose over one scope', () => {
  const both: ScopeMatch = { ...BASE, data: { a: 1, b: 2 } };
  const onlyA: ScopeMatch = { ...BASE, data: { a: 1 } };
  const neither: ScopeMatch = { ...BASE, data: {} };
  const a = { non_empty: '$.data.a' };
  const b = { non_empty: '$.data.b' };

  const notB = compileFilter({ all: [a, { not: b }] });
  assert.equal(notB.applies(onlyA), true);
  assert.equal(notB.applies(both), false);
  assert.equal(notB.applies(neither), false);

  const either = compileFilter({ any: [a, b] });
  assert.equal(either.applies(both), true);
  assert.equal(either.applies(onlyA), true);
  assert.equal(either.applies(neither), false);

  const neitherOfThem = compileFilter({ not: { any: [a, b] } });
  assert.equal(neitherOfThem.applies(neither), true);
  assert.equal(neitherOfThem.applies(onlyA), false);

  const nested = compileFilter({ all: [{ any: [a, b] }, { not: { all: [a, b] } }] });
  assert.equal(nested.applies(both), false);
  assert.equal(nested.applies(onlyA), true);
});

test('a filter is exactly one known operator per mapping', () => {
  const invalid: unknown[] = [
    null, 'non_empty', 7, true, [], ['non_empty'],
    {}, { where: '$.data' }, { nonempty: '$.data' }, { NonEmpty: '$.data' },
    { non_empty: '$.data', all: [] }, { not: { non_empty: '$.data' }, any: [] },
  ];
  for (const filter of invalid) {
    assert.throws(() => compileFilter(filter), Error, `${JSON.stringify(filter)} is not one operator`);
  }
});

test('all and any require a non-empty sequence of valid filters', () => {
  const invalid: unknown[] = [
    undefined, null, 'non_empty', 7, {}, [], [null], ['$.data'], [{}], [{ nope: '$' }],
    [{ non_empty: 7 }], [{ non_empty: '$' }, {}], [{ all: [] }],
  ];
  for (const group of invalid) {
    assert.throws(() => compileFilter({ all: group }), Error);
    assert.throws(() => compileFilter({ any: group }), Error);
  }
  assert.equal(compileFilter({ all: [{ non_empty: '$.data.a' }] }).applies({ ...BASE, data: { a: 1 } }), true);
  assert.equal(compileFilter({ any: [{ non_empty: '$.data.a' }] }).applies({ ...BASE, data: {} }), false);
});

test('not requires exactly one valid nested filter', () => {
  for (const nested of [undefined, null, 'non_empty', 7, [], {}, { nope: '$' }, { non_empty: 7 }, { not: undefined }]) {
    assert.throws(() => compileFilter({ not: nested }), Error);
  }
  assert.equal(compileFilter({ not: { non_empty: '$.data.a' } }).applies({ ...BASE, data: {} }), true);
});

test('non_empty rejects malformed, unrooted and executable JSONPath', () => {
  const invalid: unknown[] = [
    '', 'data.value', 7, null, [], '$[?(@.name)]', '$.a[?(1)]', '$.items[?(@.limit)]', '$[(1)]', "$['(0)']",
  ];
  for (const path of invalid) {
    assert.throws(() => compileFilter({ non_empty: path }), Error, `${String(path)} is not a safe rooted path`);
  }
});

test('a cyclic filter mapping is rejected, a shared but acyclic one is not', () => {
  const self: Record<string, unknown> = {};
  self.not = self;
  assert.throws(() => compileFilter(self), Error);

  const throughGroup: Record<string, unknown> = {};
  throughGroup.all = [throughGroup];
  assert.throws(() => compileFilter(throughGroup), Error);

  // The same mapping used twice is a DAG, not a cycle: both branches must compile.
  const shared = { non_empty: '$.data.a' };
  const tautology = compileFilter({ any: [shared, { not: shared }] });
  assert.equal(tautology.applies({ ...BASE, data: { a: 1 } }), true);
  assert.equal(tautology.applies({ ...BASE, data: {} }), true);
});
