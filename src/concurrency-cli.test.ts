import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  entries,
  groupedDecisionKey,
  runCli,
  soleEntry,
  startDecisionFixture,
  startSchedulingFixture,
  writeFile,
  yamlRule,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
  type SchedulingFixture,
} from '../tests/support.ts';

const MODEL = 'testmodel';
const THRESHOLD = 0.5;

let backend!: DecisionFixture;
let scheduler!: SchedulingFixture;
let plain!: SandboxRoot;
let held!: SandboxRoot;

before(async () => {
  backend = await startDecisionFixture();
  scheduler = await startSchedulingFixture();
  plain = createSandbox('rulekeeper-concurrency-plain-', backend.env);
  held = createSandbox('rulekeeper-concurrency-held-', scheduler.env);
});

after(async () => {
  plain.cleanup();
  held.cleanup();
  await backend.close();
  await scheduler.close();
});

function writeSources(project: Sandbox, keys: readonly string[]): void {
  for (const key of keys) writeFile(join(project.cwd, key), `service:\n  name: ${key.replaceAll('/', '-')}\n`);
}

function answerPerKey(keys: readonly string[]): Map<string, number> {
  return new Map(keys.map((key, index) => [key, (index + 1) / (keys.length + 1)]));
}

function setAnswers(fixture: SchedulingFixture, probabilities: ReadonlyMap<string, number>): void {
  fixture.answer = (request) => {
    const probability = probabilities.get(request.key);
    if (probability === undefined) throw new Error(`${request.key} was not expected to be decided`);
    return { probability };
  };
}

function expectedScopeDecisions(keys: readonly string[], probabilities: ReadonlyMap<string, number>): unknown[] {
  return keys.map((key) => {
    const probability = probabilities.get(key)!;
    return { filepath: key, scopeId: '0:', follows: probability > THRESHOLD, probability, model: MODEL };
  });
}

function groupedRule(options: {
  readonly groupBy: 'file' | 'folder' | 'project';
  readonly included: readonly string[];
  readonly scopePath: string;
  readonly key?: string;
}): string {
  const lines = ["version: 'v1'", 'files:', '  included:'];
  for (const glob of options.included) lines.push(`    - '${glob}'`);
  lines.push('scope:', '  format: yaml', `  path: '${options.scopePath}'`);
  if (options.key !== undefined) lines.push(`  key: '${options.key}'`);
  lines.push(
    'decision:',
    `  group_by: ${options.groupBy}`,
    'check:',
    "  rule: 'Review the selected sources as one group.'",
    '',
  );
  return lines.join('\n');
}

function items(ids: readonly string[]): string {
  return `${['items:', ...ids.map(id => `  - id: ${id}`)].join('\n')}\n`;
}

async function drainRequests(fixture: SchedulingFixture, total: number, wave: number): Promise<void> {
  while (fixture.requests.length < total) {
    fixture.releaseAll();
    await fixture.waitForRequests(Math.min(fixture.requests.length + wave, total));
  }
  fixture.releaseAll();
}

test('check runs eight decisions at once by default', async () => {
  scheduler.reset();
  scheduler.limit = 8;
  const project = held.isolated('default-limit');
  const rulePath = writeFile(
    join(project.rules, 'every.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  const keys = Array.from({ length: 10 }, (_, index) => `src/f${String(index).padStart(2, '0')}.yaml`);
  writeSources(project, keys);
  const probabilities = answerPerKey(keys);
  setAnswers(scheduler, probabilities);

  const run = runCli(['check', '.', '--rules', rulePath, '--threshold', String(THRESHOLD)], project);
  try {
    await scheduler.waitForRequests(8);
    assert.deepStrictEqual(
      [...scheduler.heldKeys()].sort(),
      keys.slice(0, 8).sort(),
      'the opening wave must be the first eight sources',
    );

    scheduler.releaseAll();
    await scheduler.waitForRequests(keys.length);
    scheduler.releaseAll();
    const result = await run;

    assert.strictEqual(scheduler.peak, 8, 'the default limit must keep exactly eight decisions in flight');
    assert.strictEqual(scheduler.violations, 0, 'more than the default eight decisions were in flight at once');
    assert.strictEqual(scheduler.requests.length, keys.length, 'every source must be decided exactly once');
    assert.deepStrictEqual(soleEntry(result, 'default limit').decisions, expectedScopeDecisions(keys, probabilities));
  } finally {
    scheduler.releaseAll();
  }
});

test('check keeps one decision limit across every rule', async () => {
  scheduler.reset();
  scheduler.limit = 2;
  const project = held.isolated('shared-limit');
  const directories = ['a', 'b', 'c'];
  const keysByRule = directories.map(directory => [0, 1, 2, 3].map(index => `${directory}/f${index}.yaml`));
  for (const [index, directory] of directories.entries()) {
    writeFile(
      join(project.rules, `${directory}.yaml`),
      yamlRule(`Review the ${directory} sources.`, { included: [`${directory}/**/*.yaml`] }),
    );
    writeSources(project, keysByRule[index]!);
  }
  const keys = keysByRule.flat();
  const probabilities = answerPerKey(keys);
  setAnswers(scheduler, probabilities);

  const run = runCli(['check', '.', '--rules', project.rules, '--concurrency', '2', '--threshold', String(THRESHOLD)], project);
  try {
    await scheduler.waitForRequests(2);
    await drainRequests(scheduler, keys.length, 2);
    const result = await run;

    assert.strictEqual(scheduler.peak, 2, '--concurrency 2 must keep two decisions in flight throughout the run');
    assert.strictEqual(scheduler.violations, 0, 'the limit is global, so it must hold for every wave, not only the first');

    const list = entries(result, 'shared limit');
    assert.deepStrictEqual(list.map(entry => entry.name), ['a', 'b', 'c']);
    for (const [index, entry] of list.entries()) {
      assert.deepStrictEqual(entry.decisions, expectedScopeDecisions(keysByRule[index]!, probabilities), `${entry.name}: wrong decisions`);
    }
    assert.strictEqual(scheduler.requests.length, keys.length, 'each rule must decide its own sources exactly once');
  } finally {
    scheduler.releaseAll();
  }
});

test('check runs one decision at a time with --concurrency 1', async () => {
  scheduler.reset();
  scheduler.limit = 1;
  const project = held.isolated('serial-limit');
  const rulePath = writeFile(
    join(project.rules, 'serial.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  const keys = ['src/a.yaml', 'src/b.yaml', 'src/c.yaml', 'src/d.yaml'];
  writeSources(project, keys);
  const probabilities = answerPerKey(keys);
  setAnswers(scheduler, probabilities);

  const run = runCli(['check', '.', '--rules', rulePath, '--concurrency', '1', '--threshold', String(THRESHOLD)], project);
  try {
    for (const [index, key] of keys.entries()) {
      await scheduler.waitForRequests(index + 1);
      assert.deepStrictEqual(scheduler.heldKeys(), [key], `decision ${index + 1} must be the only one in flight`);
      scheduler.release(key);
    }
    const result = await run;

    assert.strictEqual(scheduler.peak, 1, '--concurrency 1 must never overlap two decisions');
    assert.strictEqual(scheduler.violations, 0, '--concurrency 1 must never overlap two decisions');
    assert.deepStrictEqual(soleEntry(result, 'serial limit').decisions, expectedScopeDecisions(keys, probabilities));
  } finally {
    scheduler.releaseAll();
  }
});

test('check decides scope and grouped rules from one shared pool', async () => {
  scheduler.reset();
  scheduler.limit = 3;
  const project = held.isolated('grouped-limit');
  writeFile(
    join(project.rules, 'a-scope.yaml'),
    yamlRule('Review every scope.', { included: ['scoped/**/*.yaml'] }),
  );
  writeFile(
    join(project.rules, 'b-grouped.yaml'),
    groupedRule({
      groupBy: 'file',
      included: ['grouped/**/*.yaml'],
      scopePath: '$.items[*]',
      key: '$.id',
    }),
  );
  const scopeKeys = ['scoped/a.yaml', 'scoped/b.yaml', 'scoped/c.yaml', 'scoped/d.yaml', 'scoped/e.yaml', 'scoped/f.yaml'];
  writeSources(project, scopeKeys);
  const groupedFiles = [
    { path: 'grouped/one.yaml', ids: ['one', 'two'] },
    { path: 'grouped/two.yaml', ids: ['three', 'four'] },
    { path: 'grouped/three.yaml', ids: ['five', 'six'] },
  ];
  for (const file of groupedFiles) writeFile(join(project.cwd, file.path), items(file.ids));
  const groupedInFilepathOrder = [...groupedFiles].sort((left, right) => (left.path < right.path ? -1 : 1));

  const keys = [...scopeKeys, ...groupedInFilepathOrder.map(file => groupedDecisionKey([file.path]))];
  const probabilities = answerPerKey(keys);
  setAnswers(scheduler, probabilities);

  const run = runCli(['check', '.', '--rules', project.rules, '--concurrency', '3', '--threshold', String(THRESHOLD)], project);
  try {
    await scheduler.waitForRequests(3);
    await drainRequests(scheduler, keys.length, 3);
    const result = await run;

    assert.strictEqual(scheduler.peak, 3, '--concurrency 3 must keep three decisions in flight throughout the run');
    assert.strictEqual(scheduler.violations, 0, 'scope and group decisions must share the one limit for every wave');
    assert.strictEqual(scheduler.requests.length, 9, 'six scopes plus three groups must be nine decisions');
    assert.deepStrictEqual(
      [...scheduler.requests.map(request => request.key)].sort(),
      [...keys].sort(),
      'a group must be decided once, never per member scope',
    );

    const list = entries(result, 'grouped limit');
    assert.deepStrictEqual(list.map(entry => entry.name), ['a-scope', 'b-grouped']);
    assert.deepStrictEqual(list[0]!.decisions, expectedScopeDecisions(scopeKeys, probabilities));
    assert.deepStrictEqual(
      list[1]!.decisions,
      groupedInFilepathOrder.map((file) => {
        const probability = probabilities.get(groupedDecisionKey([file.path]))!;
        return {
          group: { type: 'file', path: file.path },
          members: file.ids.map(id => ({ filepath: file.path, scopeId: `0:${id}` })),
          follows: probability > THRESHOLD,
          probability,
          model: MODEL,
        };
      }),
    );
  } finally {
    scheduler.releaseAll();
  }
});

test('check maps decisions that complete out of order back to their own review', async () => {
  scheduler.reset();
  const project = held.isolated('out-of-order');
  writeFile(
    join(project.rules, 'a-scope.yaml'),
    yamlRule('Review every scope.', { included: ['scoped/**/*.yaml'] }),
  );
  writeFile(
    join(project.rules, 'b-grouped.yaml'),
    groupedRule({ groupBy: 'project', included: ['grouped/**/*.yaml'], scopePath: '$' }),
  );
  const scopeKeys = ['scoped/a.yaml', 'scoped/b.yaml', 'scoped/c.yaml'];
  writeSources(project, scopeKeys);
  writeFile(join(project.cwd, 'grouped', 'one.yaml'), 'service:\n  name: one\n');
  writeFile(join(project.cwd, 'grouped', 'two.yaml'), 'service:\n  name: two\n');
  const groupKey = groupedDecisionKey(['grouped/one.yaml', 'grouped/two.yaml']);
  const probabilities = answerPerKey([...scopeKeys, groupKey]);
  setAnswers(scheduler, probabilities);

  const run = runCli(['check', '.', '--rules', project.rules, '--threshold', String(THRESHOLD)], project);
  try {
    await scheduler.waitForRequests(4);
    assert.strictEqual(scheduler.peak, 4, 'the whole run must be in flight before any reply is sent');
    for (const key of [...scheduler.heldKeys()].reverse()) scheduler.release(key);
    const result = await run;

    assert.strictEqual(scheduler.requests.length, 4, 'the scope rule and the grouped rule each decided once');
    const list = entries(result, 'out-of-order');
    assert.deepStrictEqual(
      list[0]!.decisions,
      expectedScopeDecisions(scopeKeys, probabilities),
      'a reply that arrived out of order must still decide its own scope',
    );
    const groupProbability = probabilities.get(groupKey)!;
    assert.deepStrictEqual(list[1]!.decisions, [
      {
        group: { type: 'project', path: '.' },
        members: [
          { filepath: 'grouped/one.yaml', scopeId: '0:' },
          { filepath: 'grouped/two.yaml', scopeId: '0:' },
        ],
        follows: groupProbability > THRESHOLD,
        probability: groupProbability,
        model: MODEL,
      },
    ]);
  } finally {
    scheduler.releaseAll();
  }
});

test('check writes nothing when a decision fails while the others are still in flight', async () => {
  scheduler.reset();
  const project = held.isolated('inflight-failure');
  const rulePath = writeFile(
    join(project.rules, 'atomic.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  const keys = ['src/a.yaml', 'src/b.yaml', 'src/c.yaml'];
  writeSources(project, keys);
  scheduler.answer = request => (request.key === 'src/b.yaml' ? { status: 500 } : { probability: 0.9 });

  const run = runCli(['check', '.', '--rules', rulePath], project);
  try {
    await scheduler.waitForRequests(keys.length);
    assert.strictEqual(scheduler.active, keys.length, 'the run must ask for every source without waiting for replies');
    scheduler.release('src/b.yaml');
    assert.strictEqual(scheduler.active, 2, 'the decisions already in flight must be left to finish');
    scheduler.release('src/a.yaml');
    scheduler.release('src/c.yaml');
    const result = await run;

    assertFailed(result, 'failed decision beside in-flight decisions');
    assert.strictEqual(scheduler.requests.length, keys.length, 'the failed decision must not be retried');
  } finally {
    scheduler.releaseAll();
  }
});

test('check takes no further decision after a failure with --concurrency 1', async () => {
  scheduler.reset();
  scheduler.limit = 1;
  const project = held.isolated('sequential-failure');
  const rulePath = writeFile(
    join(project.rules, 'sequential.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  const keys = ['src/a.yaml', 'src/b.yaml', 'src/c.yaml', 'src/d.yaml'];
  writeSources(project, keys);
  scheduler.answer = request => (request.key === 'src/b.yaml' ? { status: 500 } : { probability: 0.9 });

  const run = runCli(['check', '.', '--rules', rulePath, '--concurrency', '1'], project);
  try {
    await scheduler.waitForRequests(1);
    assert.deepStrictEqual(scheduler.heldKeys(), ['src/a.yaml']);
    scheduler.release('src/a.yaml');
    await scheduler.waitForRequests(2);
    assert.deepStrictEqual(scheduler.heldKeys(), ['src/b.yaml']);
    scheduler.release('src/b.yaml');
    const result = await run;

    assertFailed(result, 'sequential decision failure');
    await scheduler.waitForSilence();
    assert.strictEqual(scheduler.requests.length, 2, 'no decision may be taken after the failure was observed');
  } finally {
    scheduler.releaseAll();
  }
});

test('check rejects an unusable --concurrency before deciding anything', async () => {
  backend.reset();
  const project = plain.isolated('invalid-limit');
  const rulePath = writeFile(
    join(project.rules, 'valid.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');

  const rejected = ['0', '-1', '+2', '1.5', '1e2', '0x10', 'abc', '', ' 2', '2 ', 'NaN', 'Infinity', '99999999999999999999'];
  for (const value of rejected) {
    const label = `--concurrency ${JSON.stringify(value)}`;
    const result = await runCli(['check', '.', '--rules', rulePath, '--concurrency', value], project);
    assertFailed(result, label);
    assert.match(result.stderr, /--concurrency/, `${label}: the message must name the option`);
  }
  assert.strictEqual(backend.requests.length, 0, 'an unusable limit must fail before any request');

  const accepted = await runCli(['check', '.', '--rules', rulePath, '--concurrency', '08'], project);
  assert.strictEqual(accepted.status, 0, `--concurrency 08 must be accepted (stderr: ${accepted.stderr})`);
  assert.strictEqual(backend.requests.length, 1, 'the accepted run must still decide its one source');
});

test('check fails before any decision when it cannot prepare every source', async () => {
  backend.reset();
  const cases: readonly (readonly [string, string, (project: Sandbox) => readonly string[]])[] = [
    [
      'a source that cannot be parsed',
      '4',
      (project) => {
        const rulePath = writeFile(
          join(project.rules, 'parse.yaml'),
          yamlRule('Review every source.', { included: ['**/*.yaml'] }),
        );
        writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');
        writeFile(join(project.cwd, 'src', 'b.yaml'), 'a: [unclosed\n');
        return ['check', '.', '--rules', rulePath];
      },
    ],
    [
      'a grouping the project root cannot name',
      '2',
      (project) => {
        const rulePath = writeFile(
          join(project.rules, 'outside.yaml'),
          groupedRule({ groupBy: 'folder', included: ['../outside.yaml'], scopePath: '$' }),
        );
        writeFile(join(project.cwd, '..', 'outside.yaml'), 'service:\n  name: outside\n');
        return ['check', '..', '--rules', rulePath];
      },
    ],
    [
      'a target that does not exist',
      '8',
      (project) => {
        const rulePath = writeFile(
          join(project.rules, 'missing.yaml'),
          yamlRule('Review every source.', { included: ['**/*.yaml'] }),
        );
        return ['check', 'absent', '--rules', rulePath];
      },
    ],
  ];

  for (const [label, concurrency, setup] of cases) {
    const project = plain.isolated('preflight');
    const result = await runCli([...setup(project), '--concurrency', concurrency], project);
    assertFailed(result, label);
  }
  assert.strictEqual(backend.requests.length, 0, 'a run that cannot prepare its sources must decide nothing');
});
