import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONCURRENCY, mapConcurrent, parseConcurrency } from './app/concurrency.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: unknown };

function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    value => ({ ok: true, value }) as const,
    failure => ({ ok: false, failure }) as const,
  );
}

function flush(): Promise<void> {
  return new Promise<void>(resolve => {
    setImmediate(() => {
      resolve();
    });
  });
}

test('parseConcurrency accepts decimal digits and keeps leading zeros', () => {
  assert.equal(parseConcurrency('1'), 1);
  assert.equal(parseConcurrency('8'), DEFAULT_CONCURRENCY);
  assert.equal(parseConcurrency('08'), 8);
  assert.equal(parseConcurrency('0008'), 8);
  assert.equal(parseConcurrency('42'), 42);
  assert.equal(parseConcurrency('9007199254740991'), 9007199254740991);
});

test('parseConcurrency rejects zero, signs, fractions, exponent, hex, whitespace, names and overflow', () => {
  const rejected = [
    '',
    '0',
    '00',
    '-1',
    '+1',
    '1.5',
    '.5',
    '1e3',
    '1E3',
    '0x10',
    '0b1',
    '1_000',
    ' 4',
    '4 ',
    '4\n',
    '8\n',
    '8\r\n',
    '8\t',
    'Infinity',
    '-Infinity',
    'NaN',
    'abc',
    '9007199254740992',
    '1'.repeat(30),
  ];
  for (const value of rejected) {
    assert.throws(() => parseConcurrency(value), (error: unknown) => {
      assert.match((error as Error).message, /--concurrency/);
      return true;
    }, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('mapConcurrent resolves an empty result without invoking the mapper', async () => {
  let calls = 0;
  const results = await mapConcurrent([], 4, async () => {
    calls += 1;
    return 0;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test('mapConcurrent validates the limit before mapping anything, even for no items', async () => {
  let calls = 0;
  const mapper = async (item: number): Promise<number> => {
    calls += 1;
    return item;
  };
  const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  for (const concurrency of invalid) {
    await assert.rejects(mapConcurrent([1, 2], concurrency, mapper), (error: unknown) => {
      assert.match((error as Error).message, /--concurrency/);
      return true;
    });
    await assert.rejects(mapConcurrent([], concurrency, mapper), (error: unknown) => {
      assert.match((error as Error).message, /--concurrency/);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('mapConcurrent keeps at most the limit in flight and refills a freed worker', async () => {
  const items = [0, 1, 2, 3, 4, 5, 6];
  const gates = items.map(() => deferred<string>());
  const started: number[] = [];
  let active = 0;
  let peak = 0;

  const running = mapConcurrent(items, 3, async (_item, index) => {
    started.push(index);
    active += 1;
    peak = Math.max(peak, active);
    const value = await gates[index]!.promise;
    active -= 1;
    return value;
  });

  await flush();
  assert.deepEqual(started, [0, 1, 2]);

  gates[0]!.resolve('a');
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(peak, 3);

  gates[2]!.resolve('c');
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);

  gates[1]!.resolve('b');
  gates[3]!.resolve('d');
  gates[4]!.resolve('e');
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);

  gates[5]!.resolve('f');
  gates[6]!.resolve('g');

  assert.deepEqual(await running, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(peak, 3);
});

test('mapConcurrent never starts more mappers than there are items', async () => {
  const gates: Record<string, Deferred<string>> = {
    first: deferred<string>(),
    second: deferred<string>(),
  };
  const started: string[] = [];
  let active = 0;
  let peak = 0;

  const running = mapConcurrent(['first', 'second'], DEFAULT_CONCURRENCY, async item => {
    started.push(item);
    active += 1;
    peak = Math.max(peak, active);
    const value = await gates[item]!.promise;
    active -= 1;
    return value;
  });

  await flush();
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(peak, 2);

  gates['first']!.resolve('one');
  gates['second']!.resolve('two');

  assert.deepEqual(await running, ['one', 'two']);
  assert.equal(peak, 2);
});

test('mapConcurrent preserves input order when later jobs finish first', async () => {
  const items = ['first', 'second', 'third'];
  const gates = items.map(() => deferred<string>());

  const running = mapConcurrent(items, 3, async (item, index) => {
    const value = await gates[index]!.promise;
    return `${item}:${value}`;
  });

  await flush();
  gates[2]!.resolve('c');
  await flush();
  gates[1]!.resolve('b');
  await flush();
  gates[0]!.resolve('a');

  assert.deepEqual(await running, ['first:a', 'second:b', 'third:c']);
});

test('mapConcurrent runs one mapper at a time, in input order, for a single worker', async () => {
  const order: number[] = [];
  const results = await mapConcurrent([10, 20, 30], 1, async (item, index) => {
    order.push(index);
    return item + index;
  });
  assert.deepEqual(order, [0, 1, 2]);
  assert.deepEqual(results, [10, 21, 32]);
});

test('mapConcurrent stops scheduling after an async failure and waits for the active mapper', async () => {
  const items = [0, 1, 2, 3, 4, 5];
  const gate = deferred<number>();
  const failure = new Error('mapper failed');
  const started: number[] = [];

  const running = mapConcurrent(items, 2, async (_item, index) => {
    started.push(index);
    if (index === 1) throw failure;
    return gate.promise;
  });
  const outcome = settle(running);

  await flush();
  assert.deepEqual(started, [0, 1]);

  let finished = false;
  void outcome.then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false);

  gate.resolve(0);
  const settled = await outcome;
  if (settled.ok) assert.fail('expected the first failure to reject');
  assert.strictEqual(settled.failure, failure);
  assert.deepEqual(started, [0, 1]);
});

test('mapConcurrent rejects with a synchronous mapper throw and starts no further jobs', async () => {
  const failure = new Error('thrown before any await');
  const calls: number[] = [];

  const settled = await settle(
    mapConcurrent([0, 1, 2, 3], 2, item => {
      calls.push(item);
      if (item === 0) throw failure;
      return Promise.resolve(item);
    }),
  );

  if (settled.ok) assert.fail('expected the synchronous throw to reject');
  assert.strictEqual(settled.failure, failure);
  assert.deepEqual(calls, [0]);
});

test('mapConcurrent rejects with an undefined failure value, synchronously or not', async () => {
  const settledAsync = await settle(
    mapConcurrent([0, 1, 2], 2, item =>
      item === 1 ? Promise.reject(undefined) : Promise.resolve(item),
    ),
  );
  if (settledAsync.ok) assert.fail('expected the rejected mapper to reject the pool');
  assert.strictEqual(settledAsync.failure, undefined);

  const settledSync = await settle(
    mapConcurrent([0, 1, 2], 2, () => {
      throw undefined;
    }),
  );
  if (settledSync.ok) assert.fail('expected the throwing mapper to reject the pool');
  assert.strictEqual(settledSync.failure, undefined);
});

test('mapConcurrent reports the first observed failure, not a later one', async () => {
  const first = new Error('first');
  const second = new Error('second');
  const gates = [deferred<number>(), deferred<number>()];

  const running = mapConcurrent([0, 1], 2, async (_item, index) => gates[index]!.promise);
  const outcome = settle(running);

  await flush();
  gates[1]!.reject(second);
  await flush();
  gates[0]!.reject(first);

  const settled = await outcome;
  if (settled.ok) assert.fail('expected the pool to reject');
  assert.strictEqual(settled.failure, second);
});
