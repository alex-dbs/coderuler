import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  runCli,
  soleEntry,
  startDecisionFixture,
  startSchedulingFixture,
  writeFile,
  yamlRule,
  type CliPresentationOptions,
  type CliResult,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
  type SchedulingFixture,
} from '../tests/support.ts';

const HUMAN: CliPresentationOptions = { json: false };

let backend!: DecisionFixture;
let scheduler!: SchedulingFixture;
let sandbox!: SandboxRoot;
let held!: SandboxRoot;

before(async () => {
  backend = await startDecisionFixture();
  scheduler = await startSchedulingFixture();
  sandbox = createSandbox('rulekeeper-check-output-', backend.env);
  held = createSandbox('rulekeeper-check-output-held-', scheduler.env);
});

after(async () => {
  sandbox.cleanup();
  held.cleanup();
  await backend.close();
  await scheduler.close();
});

function writeSources(project: Sandbox, sources: Readonly<Record<string, string>>): void {
  for (const [filepath, source] of Object.entries(sources)) writeFile(join(project.cwd, filepath), source);
}

function assertNoAnsi(result: CliResult, label: string): void {
  assert.doesNotMatch(result.stdout, /\u001b/, `${label}: stdout must stay free of terminal control`);
  assert.doesNotMatch(result.stderr, /\u001b/, `${label}: stderr must stay free of terminal control`);
}

async function runHeld(
  fixture: SchedulingFixture,
  project: Sandbox,
  args: readonly string[],
  expected: number,
  overrides: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const run = runCli(args, project, overrides, HUMAN);
  await fixture.waitForRequests(expected);
  fixture.releaseAll();
  return run;
}

const NARROW_COLUMNS = [24, 32] as const;

function narrowStdout(project: Sandbox, columns: number): NodeJS.ProcessEnv {
  const preload = `--import=data:text/javascript,${encodeURIComponent(`process.stdout.isTTY=true;process.stdout.columns=${columns};`)}`;
  const inherited = project.env.NODE_OPTIONS;
  return {
    ...project.env,
    NODE_OPTIONS: inherited === undefined || inherited === '' ? preload : `${inherited} ${preload}`,
    FORCE_COLOR: '0',
  };
}

test('a plain human summary reports the rule and scope counts without terminal control', async () => {
  backend.reset();
  const project = sandbox.isolated('human-summary');
  writeFile(
    join(project.rules, 'matched.yaml'),
    yamlRule('Matched review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(
    join(project.rules, 'unmatched.yaml'),
    yamlRule('Unmatched review', 'Review nothing.', { included: ['nothing/**/*.yaml'] }),
  );
  writeSources(project, {
    'src/a.yaml': '{service: {name: alpha}}',
    'src/b.yaml': '{service: {name: beta}}',
  });

  const result = await runCli(['check', '.', '--rules', project.rules], project, {}, HUMAN);

  assert.strictEqual(result.status, 0, `human summary: expected success (stderr: ${result.stderr})`);
  assertNoAnsi(result, 'human summary');
  assert.notStrictEqual(result.stdout.trim(), '', 'the human summary must print on stdout');
  assert.match(result.stdout, /pass/i, 'the summary must report how many decisions passed');
  assert.match(result.stdout, /violat/i, 'the summary must report the violation count');
  assert.doesNotMatch(result.stdout, /Review every source\./, 'the summary must not dump the rule text');
  assert.doesNotMatch(result.stdout, /\{service:/, 'the summary must not dump the source it read');
  assert.strictEqual(backend.requests.length, 2, 'both selected scopes must be decided once');
  backend.reset();
});

test('the human summary prints the violating source and withholds the passing scope', async () => {
  scheduler.reset();
  const project = held.isolated('human-mixed');
  const rulePath = writeFile(
    join(project.rules, 'mixed.yaml'),
    yamlRule('Mixed review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeSources(project, {
    'src/a.yaml': '{service: {name: alpha}}',
    'src/b.yaml': '{service: {name: REDACT-ME}}',
  });
  const probabilities: Record<string, number> = { 'src/a.yaml': 0.9, 'src/b.yaml': 0.1 };
  scheduler.answer = (request) => {
    const probability = probabilities[request.key];
    if (probability === undefined) throw new Error(`${request.key} was not expected to be decided`);
    return { probability };
  };

  const result = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 2);

  assert.strictEqual(result.status, 0, `mixed summary: violations must not change the exit code (stderr: ${result.stderr})`);
  assertNoAnsi(result, 'mixed summary');
  const namesRule = ['Mixed review', rulePath, 'mixed.yaml'].some(name => result.stdout.includes(name));
  assert.ok(namesRule, 'the summary must name the rule that was violated');
  assert.match(result.stdout, /violat/i, 'the summary must report the violation count');
  assert.match(result.stdout, /src[/\\]b\.yaml:1-1/, 'the summary must locate the violating scope in its file');
  assert.ok(
    result.stdout.includes('1 | {service: {name: REDACT-ME}}'),
    `the summary must print the violating source with its file line number (stdout: ${JSON.stringify(result.stdout)})`,
  );
  assert.doesNotMatch(result.stdout, /alpha/, 'the summary must never print a scope that followed the rule');
  assert.doesNotMatch(result.stdout, /src[/\\]a\.yaml/, 'a passing scope must not be listed at all');
  assert.doesNotMatch(result.stdout, /\u2026/, 'the summary must not truncate the source it prints');
  assert.strictEqual(scheduler.requests.length, 2, 'each selected scope must be decided once');
  scheduler.reset();
});

test('the human summary names a violating group by its type and path', async () => {
  scheduler.reset();
  const project = held.isolated('human-group');
  const rulePath = writeFile(
    join(project.rules, 'groups.yaml'),
    [
      "version: 'v1'",
      "name: 'Grouped review'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$.items[*]'",
      "  key: '$.id'",
      'decision:',
      '  group_by: file',
      'rule: Review the selected items as one group.',
      '',
    ].join('\n'),
  );
  writeSources(project, {
    'src/a.yaml': 'items:\n  - id: a\n  - id: b\n',
    'src/b.yaml': 'items:\n  - id: c\n  - id: d\n',
  });
  const probabilities: Record<string, number> = { 'group:file:src/a.yaml': 0.9, 'group:file:src/b.yaml': 0.1 };
  scheduler.answer = (request) => {
    const probability = probabilities[request.key];
    if (probability === undefined) throw new Error(`${request.key} was not expected to be decided`);
    return { probability };
  };

  const result = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 2);

  assert.strictEqual(result.status, 0, `grouped summary: expected success (stderr: ${result.stderr})`);
  assertNoAnsi(result, 'grouped summary');
  assert.match(result.stdout, /src[/\\]b\.yaml/, 'a violating group must be named by its path');
  assert.match(result.stdout, /violat/i, 'the summary must report the group violation');
  assert.match(result.stdout, /src[/\\]b\.yaml:2-2/, 'the group must locate its first member scope');
  assert.match(result.stdout, /src[/\\]b\.yaml:3-3/, 'the group must locate its second member scope');
  assert.match(result.stdout, /2 \| id: c/, 'the group must print the source of its first member scope');
  assert.match(result.stdout, /3 \| id: d/, 'the group must print the source of its second member scope');
  assert.doesNotMatch(result.stdout, /id: a/, 'a passing group member must not be printed');
  assert.strictEqual(scheduler.requests.length, 2, 'each group must be decided once, never per member scope');
  scheduler.reset();
});

test('a rule-provided title is attached to the violating scope, not to the model', async () => {
  scheduler.reset();
  const project = held.isolated('human-rule-title');
  const rulePath = writeFile(
    join(project.rules, 'titled.yaml'),
    [
      "version: 'v1'",
      "name: 'Resource review'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$'",
      "title: 'Every service must pin its memory request and limit.'",
      "rule: 'Review every source.'",
      '',
    ].join('\n'),
  );
  writeSources(project, {
    'src/a.yaml': '{service: {name: alpha}}',
    'src/b.yaml': '{service: {name: REDACT-ME}}',
  });
  const probabilities: Record<string, number> = { 'src/a.yaml': 0.9, 'src/b.yaml': 0.1 };
  scheduler.answer = (request) => {
    const probability = probabilities[request.key];
    if (probability === undefined) throw new Error(`${request.key} was not expected to be decided`);
    return { probability };
  };

  const result = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 2);

  assert.strictEqual(result.status, 0, `titled summary: expected success (stderr: ${result.stderr})`);
  assertNoAnsi(result, 'titled summary');
  assert.match(
    result.stdout,
    /Resource review[^\n]*Every service must pin its memory request and limit\./,
    'the rule-provided title must follow the rule identity of the violation it explains',
  );
  assert.doesNotMatch(result.stdout, /testmodel/, 'the title must not be attributed to the deciding model');
  assert.doesNotMatch(result.stdout, /alpha/, 'the passing scope must not be printed');
  assert.strictEqual(scheduler.requests.length, 2, 'each selected scope must be decided once');
  scheduler.reset();
});

test('identical scopes are located by their own line instead of by their text', async () => {
  scheduler.reset();
  const project = held.isolated('human-duplicate-source');
  const rulePath = writeFile(
    join(project.rules, 'duplicates.yaml'),
    [
      "version: 'v1'",
      "name: 'Duplicate review'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$.items[*]'",
      "rule: 'Review every item.'",
      '',
    ].join('\n'),
  );
  writeSources(project, { 'src/duplicate.yaml': 'items:\n  - id: dup\n  - id: dup\n' });
  scheduler.answer = () => ({ probability: 0.1 });

  const result = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 2);

  assert.strictEqual(result.status, 0, `duplicate summary: expected success (stderr: ${result.stderr})`);
  assertNoAnsi(result, 'duplicate summary');
  assert.match(result.stdout, /src[/\\]duplicate\.yaml:2-2/, 'the first duplicate must be located on its own line');
  assert.match(result.stdout, /src[/\\]duplicate\.yaml:3-3/, 'the second duplicate must be located on its own line');
  assert.strictEqual(
    [...result.stdout.matchAll(/id: dup/g)].length,
    2,
    `each duplicate must be printed exactly once with its own line (stdout: ${JSON.stringify(result.stdout)})`,
  );
  assert.strictEqual(scheduler.requests.length, 2, 'each duplicate must be decided once');
  scheduler.reset();
});

test('the printed source keeps line numbers, indentation and tabs while stripping terminal control', async () => {
  scheduler.reset();
  const project = held.isolated('human-source-control');
  const rulePath = writeFile(
    join(project.rules, 'control.yaml'),
    yamlRule('Control review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeSources(project, { 'src/control.yaml': 'service:\n  name: "a\tb"\n  note: "\u001b[31mhazard\u001b[0m"\n' });
  scheduler.answer = () => ({ probability: 0.1 });

  const result = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 1);

  assert.strictEqual(result.status, 0, `control summary: expected success (stderr: ${result.stderr})`);
  assertNoAnsi(result, 'control summary');
  assert.match(result.stdout, /^ {4}1 \| service:$/m, 'the source block must start on the file line it was taken from');
  assert.match(result.stdout, /^ {4}2 \|  {2}name: "a\tb"$/m, 'the source block must keep its tabs and indentation');
  assert.match(result.stdout, /^ {4}3 \|  {2}note: "hazard"$/m, 'terminal control must not survive into the printed source');
  assert.strictEqual(scheduler.requests.length, 1, 'the selected scope must be decided once');
  scheduler.reset();
});

test('the human summary colors violations and passes only when the stream supports color', async () => {
  scheduler.reset();
  const project = held.isolated('human-color');
  const rulePath = writeFile(
    join(project.rules, 'color.yaml'),
    yamlRule('Colored review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeSources(project, {
    'src/a.yaml': '{service: {name: alpha}}',
    'src/b.yaml': '{service: {name: REDACT-ME}}',
  });
  const probabilities: Record<string, number> = { 'src/a.yaml': 0.9, 'src/b.yaml': 0.1 };
  const answer: SchedulingFixture['answer'] = (request) => {
    const probability = probabilities[request.key];
    if (probability === undefined) throw new Error(`${request.key} was not expected to be decided`);
    return { probability };
  };
  scheduler.answer = answer;

  const plain = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 2, {
    FORCE_COLOR: '0',
    NO_COLOR: undefined,
    NODE_DISABLE_COLORS: undefined,
  });
  assert.strictEqual(plain.status, 0, `plain color run: expected success (stderr: ${plain.stderr})`);
  assertNoAnsi(plain, 'plain color run');

  scheduler.reset();
  scheduler.answer = answer;

  const colored = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 2, {
    FORCE_COLOR: '1',
    NO_COLOR: undefined,
    NODE_DISABLE_COLORS: undefined,
  });
  assert.strictEqual(colored.status, 0, `colored run: expected success (stderr: ${colored.stderr})`);
  assert.match(colored.stdout, /\u001b\[31m/, 'violations must be red');
  assert.match(colored.stdout, /\u001b\[32m/, 'passes must be green');
  assert.doesNotMatch(colored.stdout, /\u001b\[33m/, 'a fully reported run must not warn');
  assert.ok(
    colored.stdout.includes('\n    1 | {service: {name: REDACT-ME}}\n'),
    `printed source must stay ordinary text (stdout: ${JSON.stringify(colored.stdout)})`,
  );
  scheduler.reset();
});

test('a run that matches no scope asks for no decision and says so without claiming compliance', async () => {
  backend.reset();
  const project = sandbox.isolated('human-no-match');
  const rulePath = writeFile(
    join(project.rules, 'unmatched.yaml'),
    yamlRule('Unmatched review', 'Review nothing.', { included: ['nothing/**/*.yaml'] }),
  );
  writeSources(project, { 'src/a.yaml': '{service: {name: alpha}}' });

  const result = await runCli(['check', '.', '--rules', rulePath], project, {}, HUMAN);

  assert.strictEqual(result.status, 0, `no-match summary: expected success (stderr: ${result.stderr})`);
  assertNoAnsi(result, 'no-match summary');
  assert.match(result.stdout, /no matching scopes/i, 'an empty selection must say so explicitly');
  assert.doesNotMatch(result.stdout, /complian/i, 'an empty selection must not claim compliance');
  assert.strictEqual(backend.requests.length, 0, 'nothing selected means nothing was asked');
  backend.reset();
});

test('check --json keeps the result array on stdout and writes nothing to stderr', async () => {
  backend.reset();
  const project = sandbox.isolated('json-output');
  const rulePath = writeFile(
    join(project.rules, 'decided.yaml'),
    yamlRule('Decided review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeSources(project, {
    'src/a.yaml': '{service: {name: alpha}}',
    'src/b.yaml': '{service: {name: beta}}',
  });

  const result = await runCli(['check', '.', '--rules', rulePath], project);

  const entry = soleEntry(result, 'json output');
  assert.strictEqual(result.stderr, '', 'JSON output must leave stderr quiet');
  assertNoAnsi(result, 'json output');
  assert.deepStrictEqual(entry.decisions, [
    { filepath: 'src/a.yaml', scopeId: '0:', follows: true, probability: 0.9, model: 'testmodel' },
    { filepath: 'src/b.yaml', scopeId: '0:', follows: true, probability: 0.9, model: 'testmodel' },
  ]);
  backend.reset();
});

test('a failing check writes nothing to stdout in either presentation', async () => {
  backend.reset();
  const project = sandbox.isolated('human-failure');
  const rulePath = writeFile(
    join(project.rules, 'keyed.yaml'),
    yamlRule('Keyed review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeSources(project, { 'src/a.yaml': '{service: {name: alpha}}' });

  const withoutKey: NodeJS.ProcessEnv = {
    TYPESAFE_API_KEY: undefined,
  };

  const human = await runCli(['check', '.', '--rules', rulePath], project, withoutKey, HUMAN);
  assertFailed(human, 'failing human run');
  assertNoAnsi(human, 'failing human run');

  const json = await runCli(['check', '.', '--rules', rulePath], project, withoutKey);
  assertFailed(json, 'failing JSON run');
  assertNoAnsi(json, 'failing JSON run');

  assert.strictEqual(backend.requests.length, 0, 'a missing key must fail before any request');
  backend.reset();
});

test('a narrow terminal still shows the full rule identity and the violation count of a scope summary', async () => {
  const ruleName = 'Révision données — vérifier chaque fichier';
  const violating = ['src/données/é.yaml', 'src/données/è.yaml', 'src/données/ê.yaml'];
  const passing = ['src/données/à.yaml', 'src/données/ç.yaml'];

  for (const columns of NARROW_COLUMNS) {
    scheduler.reset();
    const project = held.isolated(`narrow-scope-${columns}`);
    const rulePath = writeFile(
      join(project.rules, 'narrow.yaml'),
      yamlRule(ruleName, 'Review every source.', { included: ['**/*.yaml'] }),
    );
    const probabilities: Record<string, number> = {};
    const sources: Record<string, string> = {};
    for (const filepath of violating) {
      probabilities[filepath] = 0.1;
      sources[filepath] = '{service: {name: violated}}';
    }
    for (const filepath of passing) {
      probabilities[filepath] = 0.9;
      sources[filepath] = '{service: {name: accepted}}';
    }
    writeSources(project, sources);
    scheduler.answer = (request) => {
      const probability = probabilities[request.key];
      if (probability === undefined) throw new Error(`${request.key} was not expected to be decided`);
      return { probability };
    };

    const label = `scope summary at ${columns} columns`;
    const result = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 5, narrowStdout(project, columns));

    assert.strictEqual(result.status, 0, `${label}: expected success (stderr: ${result.stderr})`);
    assertNoAnsi(result, label);
    const summary = result.stdout.replace(/\s+/g, ' ');
    assert.ok(summary.includes(ruleName), `${label}: the summary must name the rule in full (stdout: ${JSON.stringify(result.stdout)})`);
    for (const filepath of violating) {
      assert.ok(summary.includes(filepath), `${label}: the summary must name the violating ${filepath} in full`);
    }
    assert.doesNotMatch(result.stdout, /\u2026/, `${label}: the summary must not truncate a line a wider terminal would show`);
    assert.strictEqual(scheduler.requests.length, 5, `${label}: every scope must be decided once`);
  }
  scheduler.reset();
});

test('a narrow terminal still shows the full group identity and the violation count of a grouped summary', async () => {
  const ruleName = 'Règle groupée — 名前 groupes';
  const violating = 'src/données/b.yaml';

  for (const columns of NARROW_COLUMNS) {
    scheduler.reset();
    const project = held.isolated(`narrow-group-${columns}`);
    const rulePath = writeFile(
      join(project.rules, 'narrow-groups.yaml'),
      [
        "version: 'v1'",
        `name: '${ruleName}'`,
        'files:',
        '  included:',
        "    - '**/*.yaml'",
        'scope:',
        '  format: yaml',
        "  path: '$.items[*]'",
        "  key: '$.id'",
        'decision:',
        '  group_by: file',
        'rule: Review the selected items as one group.',
        '',
      ].join('\n'),
    );
    writeSources(project, {
      'src/données/a.yaml': 'items:\n  - id: a\n  - id: b\n',
      [violating]: 'items:\n  - id: c\n  - id: d\n',
    });
    const probabilities: Record<string, number> = { 'group:file:src/données/a.yaml': 0.9, [`group:file:${violating}`]: 0.1 };
    scheduler.answer = (request) => {
      const probability = probabilities[request.key];
      if (probability === undefined) throw new Error(`${request.key} was not expected to be decided`);
      return { probability };
    };

    const label = `grouped summary at ${columns} columns`;
    const result = await runHeld(scheduler, project, ['check', '.', '--rules', rulePath], 2, narrowStdout(project, columns));

    assert.strictEqual(result.status, 0, `${label}: expected success (stderr: ${result.stderr})`);
    assertNoAnsi(result, label);
    const summary = result.stdout.replace(/\s+/g, ' ');
    assert.ok(summary.includes(ruleName), `${label}: the summary must name the rule in full (stdout: ${JSON.stringify(result.stdout)})`);
    assert.doesNotMatch(result.stdout, /\u2026/, `${label}: the summary must not truncate a line a wider terminal would show`);
    assert.strictEqual(scheduler.requests.length, 2, `${label}: every group must be decided once`);
  }
  scheduler.reset();
});
