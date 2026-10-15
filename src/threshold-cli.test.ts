import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  entries,
  runCli,
  soleEntry,
  startDecisionFixture,
  writeFile,
  yamlRule,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
} from '../tests/support.ts';

const MODEL = 'testmodel';

let backend!: DecisionFixture;
let sandbox!: SandboxRoot;

before(async () => {
  backend = await startDecisionFixture();
  sandbox = createSandbox('rulekeeper-threshold-', backend.env);
});

after(async () => {
  sandbox.cleanup();
  await backend.close();
});

function writeScopeCase(project: Sandbox): string {
  const rulePath = writeFile(
    join(project.rules, 'threshold.yaml'),
    yamlRule('Threshold review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');
  return rulePath;
}

function groupedRule(name: string): string {
  return [
    "version: 'v1'",
    `name: '${name}'`,
    'files:',
    '  included:',
    "    - 'charts/**/*.yaml'",
    'scope:',
    '  format: yaml',
    "  path: '$'",
    'decision:',
    '  group_by: folder',
    'rule: Review the selected sources as one group.',
    '',
  ].join('\n');
}

test('check decides strictly above the effective threshold', async () => {
  const project = sandbox.isolated('effective');
  const rulePath = writeScopeCase(project);
  const args = ['check', '.', '--rules', rulePath];

  const cases: readonly (readonly [string, readonly string[], NodeJS.ProcessEnv, number, boolean])[] = [
    ['the default threshold does not pass a tie at 0.4', [], {}, 0.4, false],
    ['the default threshold passes above 0.4', [], {}, 0.4000001, true],
    ['RK_THRESHOLD raises the bar', [], { RK_THRESHOLD: '0.8' }, 0.7, false],
    ['RK_THRESHOLD is passed above its value', [], { RK_THRESHOLD: '0.8' }, 0.9, true],
    ['a setting of zero is honored rather than read as absent', [], { RK_THRESHOLD: '0' }, 0.4, true],
    ['a setting of zero still fails an exact zero', [], { RK_THRESHOLD: '0' }, 0, false],
    ['--threshold lowers the bar', ['--threshold', '0.2'], {}, 0.3, true],
    ['--threshold fails at its own value', ['--threshold', '0.3'], {}, 0.3, false],
    ['--threshold outranks RK_THRESHOLD', ['--threshold', '0.2'], { RK_THRESHOLD: '0.9' }, 0.5, true],
    ['a supplied zero outranks a setting', ['--threshold', '0'], { RK_THRESHOLD: '0.9' }, 0.4, true],
    ['the boundary of one fails an exact one', ['--threshold', '1'], {}, 1, false],
    ['a threshold of one also rejects probabilities below one', ['--threshold', '1'], {}, 0.9999999, false],
  ];

  for (const [label, extra, env, probability, follows] of cases) {
    backend.reset();
    backend.probability = probability;
    const entry = soleEntry(await runCli([...args, ...extra], project, env), label);
    assert.deepStrictEqual(
      entry.decisions,
      [{ filepath: 'src/a.yaml', scopeId: '0:', follows, probability, model: MODEL }],
      label,
    );
    assert.strictEqual(backend.requests.length, 1, `${label}: the run must ask for exactly one decision`);
  }
});

test('check refuses an unusable threshold before deciding anything', async () => {
  backend.reset();
  const project = sandbox.isolated('invalid');
  const rulePath = writeScopeCase(project);
  const args = ['check', '.', '--rules', rulePath];

  for (const value of ['', '   ', 'abc', 'NaN', 'Infinity', '-0.5', '1.5', '2', '0.5.5']) {
    const label = `--threshold ${JSON.stringify(value)}`;
    const result = await runCli([...args, '--threshold', value], project);
    assertFailed(result, label);
    assert.match(result.stderr, /--threshold/, `${label}: the message must name the option`);
  }

  assertFailed(await runCli([...args, '--threshold'], project), '--threshold without a value');

  for (const value of ['', '  ', 'abc', 'NaN', 'Infinity', '-1', '1.5', '2']) {
    const label = `RK_THRESHOLD ${JSON.stringify(value)}`;
    const result = await runCli(args, project, { RK_THRESHOLD: value });
    assertFailed(result, label);
    assert.match(result.stderr, /RK_THRESHOLD/, `${label}: the message must name the setting`);
  }

  assert.strictEqual(backend.requests.length, 0, 'an unusable threshold must fail before any request');
});

test('a usable --threshold outranks an unusable RK_THRESHOLD', async () => {
  backend.reset();
  const project = sandbox.isolated('override-invalid-setting');
  const rulePath = writeScopeCase(project);
  backend.probability = 0.6;

  const entry = soleEntry(
    await runCli(['check', '.', '--rules', rulePath, '--threshold', '0.5'], project, { RK_THRESHOLD: 'abc' }),
    'a supplied threshold beside an unusable setting',
  );

  assert.deepStrictEqual(entry.decisions, [
    { filepath: 'src/a.yaml', scopeId: '0:', follows: true, probability: 0.6, model: MODEL },
  ]);
  assert.strictEqual(backend.requests.length, 1, 'the run must still decide its one source');
});

test('--debug reports the effective threshold and where it came from', async () => {
  backend.reset();
  backend.probability = 0.9;
  const project = sandbox.isolated('debug-threshold');
  const rulePath = writeScopeCase(project);
  const args = ['check', '.', '--rules', rulePath, '--debug'];

  const fromSetting = await runCli(args, project, { RK_THRESHOLD: '0.7' });
  entries(fromSetting, 'debug threshold from the setting');
  assert.match(fromSetting.stderr, /\[debug\] decision\.threshold threshold=0\.7 source="env"/);

  const fromFlag = await runCli([...args, '--threshold', '0.2'], project);
  entries(fromFlag, 'debug threshold from the flag');
  assert.match(fromFlag.stderr, /\[debug\] decision\.threshold threshold=0\.2 source="flag"/);

  const fromDefault = await runCli(args, project);
  entries(fromDefault, 'debug threshold from the default');
  assert.match(fromDefault.stderr, /\[debug\] decision\.threshold threshold=0\.4 source="default"/);
});

test('check judges a group against the same threshold policy as a scope', async () => {
  const project = sandbox.isolated('grouped');
  const rulePath = writeFile(join(project.rules, 'grouped.yaml'), groupedRule('Grouped review'));
  writeFile(join(project.cwd, 'charts', 'a.yaml'), 'name: a\n');
  writeFile(join(project.cwd, 'charts', 'b.yaml'), 'name: b\n');

  const members = [
    { filepath: 'charts/a.yaml', scopeId: '0:' },
    { filepath: 'charts/b.yaml', scopeId: '0:' },
  ];

  const cases: readonly (readonly [string, readonly string[], NodeJS.ProcessEnv, number, boolean])[] = [
    ['the default threshold ties the group at 0.4', [], {}, 0.4, false],
    ['a setting below the group answer', [], { RK_THRESHOLD: '0.4' }, 0.5, true],
    ['a supplied threshold above the group answer', ['--threshold', '0.8'], {}, 0.5, false],
  ];

  for (const [label, extra, env, probability, follows] of cases) {
    backend.reset();
    backend.probability = probability;
    const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath, ...extra], project, env), label);
    assert.deepStrictEqual(
      entry.decisions,
      [{ group: { type: 'folder', path: 'charts' }, members, follows, probability, model: MODEL }],
      label,
    );
    assert.strictEqual(backend.requests.length, 1, `${label}: a group must be decided once`);
  }
});
