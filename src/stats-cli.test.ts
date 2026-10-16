import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  createSandbox,
  runCli,
  startDecisionFixture,
  writeFile,
  yamlRule,
  type CliResult,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
} from '../tests/support.ts';

interface Totals {
  readonly runs: number;
  readonly rules: number;
  readonly verifications: number;
  readonly violations: number;
  readonly elapsedMs: number;
}

interface ProjectRow extends Totals {
  readonly project: string;
}

interface Snapshot {
  readonly total: Totals;
  readonly projects: readonly ProjectRow[];
}

const ZERO: Totals = { runs: 0, rules: 0, verifications: 0, violations: 0, elapsedMs: 0 };

let sandbox!: SandboxRoot;
let backend!: DecisionFixture;

before(async () => {
  backend = await startDecisionFixture();
  sandbox = createSandbox('rulekeeper-stats-', backend.env);
});

after(async () => {
  sandbox.cleanup();
  await backend.close();
});

function snapshotOf(result: CliResult): Snapshot {
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Snapshot;
}

function ruleFor(project: Sandbox, file: string, included: readonly string[]): string {
  return writeFile(join(project.rules, file), yamlRule('Review the source.', { included }));
}

test('stats reports an explicit empty state and a zero snapshot without creating the database', async () => {
  const project = sandbox.isolated('stats-empty');

  const human = await runCli(['stats'], project, {}, { json: false });
  assert.strictEqual(human.status, 0, human.stderr);
  assert.notStrictEqual(human.stdout.trim(), '', 'the empty state must be reported explicitly');
  assert.ok(!human.stdout.includes('GLOBAL'), 'an empty state must not fabricate a totals row');

  const machine = snapshotOf(await runCli(['stats', '--json'], project));
  assert.deepStrictEqual(machine, { total: ZERO, projects: [] });
  assert.strictEqual(
    existsSync(join(project.home, '.rulekeeper', 'stats.sqlite')),
    false,
    'reading an absent statistic store must not create the database',
  );
});

test('a successful check is aggregated under its project and shown in the global table', async () => {
  const project = sandbox.isolated('stats-record');
  const rulePath = ruleFor(project, 'record.yaml', ['**/*.yaml']);
  writeFile(join(project.cwd, 'app.yaml'), '{name: api}');

  const checked = await runCli(['check', '.', '--rules', rulePath], project);
  assert.strictEqual(checked.status, 0, checked.stderr);

  const machine = snapshotOf(await runCli(['stats', '--json'], project));
  assert.strictEqual(machine.total.runs, 1);
  assert.strictEqual(machine.total.rules, 1);
  assert.strictEqual(machine.total.verifications, 1);
  assert.strictEqual(machine.total.violations, 0);
  assert.ok(machine.total.elapsedMs >= 0, 'the summed elapsed time must be a non-negative number');
  assert.strictEqual(machine.projects.length, 1);
  assert.strictEqual(machine.projects[0]!.project, project.cwd);
  assert.strictEqual(machine.projects[0]!.runs, 1);
  assert.strictEqual(machine.projects[0]!.verifications, 1);

  const human = await runCli(['stats'], project, {}, { json: false });
  assert.strictEqual(human.status, 0, human.stderr);
  assert.ok(human.stdout.includes('GLOBAL'), 'the table must label the global totals');
  assert.ok(human.stdout.includes(project.cwd), 'the table must name the project path');
});

test('a run that selects nothing still records its run and enabled rule with zero decisions', async () => {
  backend.reset();
  const project = sandbox.isolated('stats-no-match');
  const rulePath = ruleFor(project, 'no-match.yaml', ['**/*.ts']);
  writeFile(join(project.cwd, 'app.yaml'), '{name: api}');

  const checked = await runCli(['check', '.', '--rules', rulePath], project);
  assert.strictEqual(checked.status, 0, checked.stderr);
  assert.strictEqual(backend.requests.length, 0, 'a no-match run must not reach the provider');

  const machine = snapshotOf(await runCli(['stats', '--json'], project));
  assert.strictEqual(machine.total.runs, 1);
  assert.strictEqual(machine.total.rules, 1);
  assert.strictEqual(machine.total.verifications, 0);
  assert.strictEqual(machine.total.violations, 0);
});

test('the global row sums every recorded project', async () => {
  const project = sandbox.isolated('stats-sum');
  const rulePath = ruleFor(project, 'sum.yaml', ['**/*.yaml']);
  writeFile(join(project.cwd, 'one.yaml'), '{name: api}');
  assert.strictEqual((await runCli(['check', '.', '--rules', rulePath], project)).status, 0);

  const second: Sandbox = { ...project, cwd: join(project.cwd, 'second') };
  mkdirSync(second.cwd, { recursive: true });
  writeFile(join(second.cwd, 'two.yaml'), '{name: api}');
  assert.strictEqual((await runCli(['check', '.', '--rules', rulePath], second)).status, 0);

  const machine = snapshotOf(await runCli(['stats', '--json'], project));
  assert.deepStrictEqual(
    machine.projects.map((row) => row.project),
    [project.cwd, second.cwd].sort(),
    'projects must be listed in deterministic path order',
  );
  assert.strictEqual(machine.projects.length, 2);
  assert.strictEqual(machine.total.runs, 2);
  assert.strictEqual(machine.total.rules, 2);
  assert.strictEqual(
    machine.total.verifications,
    machine.projects.reduce((sum, row) => sum + row.verifications, 0),
    'the global total must equal the sum of every project',
  );
});

test('stats reset clears every recorded aggregate', async () => {
  const project = sandbox.isolated('stats-reset');
  const rulePath = ruleFor(project, 'reset.yaml', ['**/*.yaml']);
  writeFile(join(project.cwd, 'app.yaml'), '{name: api}');

  assert.strictEqual((await runCli(['check', '.', '--rules', rulePath], project)).status, 0);
  assert.strictEqual(snapshotOf(await runCli(['stats', '--json'], project)).total.runs, 1);

  const reset = await runCli(['stats', 'reset'], project, {}, { json: false });
  assert.strictEqual(reset.status, 0, reset.stderr);

  assert.deepStrictEqual(snapshotOf(await runCli(['stats', '--json'], project)), { total: ZERO, projects: [] });
});

test('the table escapes control characters in project paths while JSON keeps the raw path', async () => {
  const project = sandbox.isolated('stats-escape');
  const rulePath = ruleFor(project, 'escape.yaml', ['**/*.yaml']);
  const weird: Sandbox = { ...project, cwd: join(project.cwd, 'odd\u0007dir') };
  mkdirSync(weird.cwd, { recursive: true });
  writeFile(join(weird.cwd, 'app.yaml'), '{name: api}');
  assert.strictEqual((await runCli(['check', '.', '--rules', rulePath], weird)).status, 0);

  const human = await runCli(['stats'], project, {}, { json: false });
  assert.strictEqual(human.status, 0, human.stderr);
  assert.ok(
    !/[\u0000-\u0008\u000e-\u001f\u007f]/.test(human.stdout),
    'the table must not emit raw control characters',
  );
  assert.ok(!human.stdout.includes('odd\u0007dir'), 'the table must replace the control character in the path');
  assert.ok(human.stdout.includes('odd') && human.stdout.includes('dir'), 'the path stays recognizable');

  const machine = snapshotOf(await runCli(['stats', '--json'], project));
  assert.strictEqual(machine.projects.length, 1);
  assert.strictEqual(machine.projects[0]!.project, weird.cwd, 'JSON must keep the unmodified project path');
});
