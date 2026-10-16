import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  groupedDecisionKey,
  isMapping,
  runCli,
  soleEntry,
  startDecisionFixture,
  startSchedulingFixture,
  writeFile,
  yamlRule,
  type CheckEntry,
  type CliPresentationOptions,
  type CliResult,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
  type SchedulingFixture,
} from '../tests/support.ts';

import { checkCommand } from './adapter/cli/check.ts';
import type { Check } from './app/check.ts';

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
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(
    join(project.rules, 'unmatched.yaml'),
    yamlRule('Review nothing.', { included: ['nothing/**/*.yaml'] }),
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
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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
  const namesRule = ['mixed', rulePath, 'mixed.yaml'].some(name => result.stdout.includes(name));
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
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$.items[*]'",
      "  key: '$.id'",
      'decision:',
      '  group_by: file',
      'check:',
      '  rule: Review the selected items as one group.',
      '',
    ].join('\n'),
  );
  writeSources(project, {
    'src/a.yaml': 'items:\n  - id: a\n  - id: b\n',
    'src/b.yaml': 'items:\n  - id: c\n  - id: d\n',
  });
  const probabilities: Record<string, number> = {
    [groupedDecisionKey(['src/a.yaml'])]: 0.9,
    [groupedDecisionKey(['src/b.yaml'])]: 0.1,
  };
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

test('a rule-provided violation message is sanitized and attached only to the violating scope', async () => {
  scheduler.reset();
  const project = held.isolated('human-rule-message');
  const rulePath = writeFile(
    join(project.rules, 'message.yaml'),
    [
      "version: 'v1'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$'",
      'check:',
      "  rule: 'Review every source.'",
      '  violation-message: "Every service must pin its memory\\t request and limit.\\u009f"',
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

  assert.strictEqual(result.status, 0, `message summary: expected success (stderr: ${result.stderr})`);
  assertNoAnsi(result, 'message summary');
  assert.match(
    result.stdout,
    /message[^\n]*Every service must pin its memory request and limit\./,
    'the static violation message must follow the identity of the violating rule',
  );
  assert.doesNotMatch(result.stdout, /testmodel/, 'the message must not be attributed to the deciding model');
  assert.doesNotMatch(result.stdout, /[\u007f-\u009f]/);
  for (const request of scheduler.requests) {
    assert.doesNotMatch(JSON.stringify(request.body), /Every service must pin|violationMessage|violation-message/);
  }
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
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$.items[*]'",
      'check:',
      "  rule: 'Review every item.'",
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
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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

function serviceRule(): string {
  return [
    "version: 'v1'",
    'files:',
    '  included:',
    "    - '**/*.yaml'",
    'scope:',
    '  format: yaml',
    "  path: '$.service'",
    'check:',
    "  rule: 'Review every service block.'",
    '',
  ].join('\n');
}

function scopeOf(entry: CheckEntry, filepath: string, where: string): Record<string, unknown> {
  for (const context of entry.contexts) {
    if (!isMapping(context)) throw new Error(`${where}: every context must be a JSON mapping`);
    if (context.filepath !== filepath) continue;
    if (!isMapping(context.scope)) throw new Error(`${where}: the context of ${filepath} must carry a scope mapping`);
    return context.scope;
  }
  throw new Error(`${where}: expected a JSON context for ${filepath}`);
}

function renderedSourceLines(stdout: string): string[] {
  return [...stdout.matchAll(/^ {4}(?:\d+ \| .*|\u2026)$/gm)].map(match => match[0]!);
}

function renderedLine(line: number, text: string): string {
  return `    ${line} | ${text}`;
}

const ELLIPSIS_LINE = '    \u2026';

const FIVE_LINE_FILE = [
  'version: 1',
  'service:',
  '  name: alpha',
  '  tier: gold',
  '  owner: platform',
  '  region: eu',
  '  note: boundary-five',
  '',
].join('\n');

const FIVE_LINE_SOURCE = 'name: alpha\n  tier: gold\n  owner: platform\n  region: eu\n  note: boundary-five\n';

const SIX_LINE_FILE = [
  'version: 1',
  'service:',
  '  name: alpha',
  '  tier: gold',
  '  owner: platform',
  '  region: eu',
  '  note: boundary-six',
  '  tail: hidden-tail-six',
  '',
].join('\n');

const SIX_LINE_SOURCE = 'name: alpha\n  tier: gold\n  owner: platform\n  region: eu\n  note: boundary-six\n  tail: hidden-tail-six\n';

const BLANK_TAIL_FILE = [
  'version: 1',
  'service:',
  '  name: alpha',
  '  tier: gold',
  '  owner: platform',
  '  region: eu',
  '  note: boundary-blank',
  '',
  '  tail: hidden-tail-blank',
  '',
].join('\n');

const BLANK_TAIL_SOURCE = 'name: alpha\n  tier: gold\n  owner: platform\n  region: eu\n  note: boundary-blank\n\n  tail: hidden-tail-blank\n';

const ALPHA_FILE = [
  'version: 1',
  'service:',
  '  name: alpha',
  '  tier: gold',
  '  owner: platform',
  '  region: eu',
  '  note: alpha-note',
  '  tail: hidden-tail-alpha',
  '',
].join('\n');

const ALPHA_SOURCE = 'name: alpha\n  tier: gold\n  owner: platform\n  region: eu\n  note: alpha-note\n  tail: hidden-tail-alpha\n';

const BETA_FILE = [
  'version: 1',
  'service:',
  '  name: beta',
  '  tier: gold',
  '  owner: platform',
  '  region: eu',
  '  note: beta-note',
  '  tail: hidden-tail-beta',
  '  extra: hidden-extra-beta',
  '',
].join('\n');

const BETA_SOURCE = 'name: beta\n  tier: gold\n  owner: platform\n  region: eu\n  note: beta-note\n  tail: hidden-tail-beta\n  extra: hidden-extra-beta\n';

test('an excerpt of exactly five lines prints every line and no ellipsis', async () => {
  backend.reset();
  backend.probability = 0.1;
  const label = 'five-line excerpt';
  const project = sandbox.isolated('excerpt-five');
  const rulePath = writeFile(join(project.rules, 'excerpt-five.yaml'), serviceRule());
  writeSources(project, { 'src/five-lines.yaml': FIVE_LINE_FILE });

  const human = await runCli(['check', '.', '--rules', rulePath], project, {}, HUMAN);

  assert.strictEqual(human.status, 0, `${label}: expected success (stderr: ${human.stderr})`);
  assertNoAnsi(human, label);
  assert.deepStrictEqual(
    renderedSourceLines(human.stdout),
    [
      renderedLine(3, 'name: alpha'),
      renderedLine(4, '  tier: gold'),
      renderedLine(5, '  owner: platform'),
      renderedLine(6, '  region: eu'),
      renderedLine(7, '  note: boundary-five'),
    ],
    `${label}: a five-line excerpt must print all five lines and no ellipsis (stdout: ${JSON.stringify(human.stdout)})`,
  );
  assert.match(
    human.stdout,
    /src[/\\]five-lines\.yaml:3-7/,
    'the five-line excerpt must keep the full scope range',
  );
  assert.strictEqual(backend.requests.length, 1, 'the selected scope must be decided once');

  const json = await runCli(['check', '.', '--rules', rulePath], project);
  const entry = soleEntry(json, `${label} (json)`);
  const scope = scopeOf(entry, 'src/five-lines.yaml', `${label} (json)`);
  assert.deepStrictEqual(scope.lines, { start: 3, end: 7 }, `${label}: JSON must keep the full scope range`);
  assert.strictEqual(scope.source, FIVE_LINE_SOURCE, `${label}: JSON must keep the untruncated source`);
  assert.strictEqual(backend.requests.length, 2, 'the JSON run must decide the same scope once');
  assert.ok(
    JSON.stringify(backend.requests.at(-1)!.body).includes('boundary-five'),
    'the decision must send the source it was given',
  );
  backend.reset();
});

test('an excerpt of six lines prints the first five lines, then a separate ellipsis, and keeps the full range', async () => {
  backend.reset();
  backend.probability = 0.1;
  const label = 'six-line excerpt';
  const project = sandbox.isolated('excerpt-six');
  const rulePath = writeFile(join(project.rules, 'excerpt-six.yaml'), serviceRule());
  writeSources(project, { 'src/six-lines.yaml': SIX_LINE_FILE });

  const human = await runCli(['check', '.', '--rules', rulePath], project, {}, HUMAN);

  assert.strictEqual(human.status, 0, `${label}: expected success (stderr: ${human.stderr})`);
  assertNoAnsi(human, label);
  assert.deepStrictEqual(
    renderedSourceLines(human.stdout),
    [
      renderedLine(3, 'name: alpha'),
      renderedLine(4, '  tier: gold'),
      renderedLine(5, '  owner: platform'),
      renderedLine(6, '  region: eu'),
      renderedLine(7, '  note: boundary-six'),
      ELLIPSIS_LINE,
    ],
    `${label}: a six-line excerpt must print its first five lines then one separate ellipsis (stdout: ${JSON.stringify(human.stdout)})`,
  );
  assert.ok(
    human.stdout.indexOf('note: boundary-six') < human.stdout.indexOf('\u2026'),
    'the ellipsis must follow the fifth printed line',
  );
  assert.match(
    human.stdout,
    /src[/\\]six-lines\.yaml:3-8/,
    'the truncated excerpt must keep the full scope range, not the printed one',
  );
  assert.doesNotMatch(human.stdout, /hidden-tail-six/, 'the sixth source line must not be printed');
  assert.strictEqual(backend.requests.length, 1, 'the selected scope must be decided once');

  const json = await runCli(['check', '.', '--rules', rulePath], project);
  const entry = soleEntry(json, `${label} (json)`);
  const scope = scopeOf(entry, 'src/six-lines.yaml', `${label} (json)`);
  assert.deepStrictEqual(scope.lines, { start: 3, end: 8 }, `${label}: JSON must keep the full scope range`);
  assert.strictEqual(
    scope.source,
    SIX_LINE_SOURCE,
    `${label}: JSON must keep the untruncated source, hidden tail included`,
  );
  assert.strictEqual(backend.requests.length, 2, 'the JSON run must decide the same scope once');
  assert.ok(
    JSON.stringify(backend.requests.at(-1)!.body).includes('hidden-tail-six'),
    'the decision must send the hidden tail it was given',
  );
  backend.reset();
});

test('an excerpt marks truncation even when the first hidden line is blank', async () => {
  backend.reset();
  backend.probability = 0.1;
  const label = 'blank-tail excerpt';
  const project = sandbox.isolated('excerpt-blank-tail');
  const rulePath = writeFile(join(project.rules, 'excerpt-blank-tail.yaml'), serviceRule());
  writeSources(project, { 'src/blank-tail.yaml': BLANK_TAIL_FILE });

  const human = await runCli(['check', '.', '--rules', rulePath], project, {}, HUMAN);

  assert.strictEqual(human.status, 0, `${label}: expected success (stderr: ${human.stderr})`);
  assertNoAnsi(human, label);
  assert.deepStrictEqual(
    renderedSourceLines(human.stdout),
    [
      renderedLine(3, 'name: alpha'),
      renderedLine(4, '  tier: gold'),
      renderedLine(5, '  owner: platform'),
      renderedLine(6, '  region: eu'),
      renderedLine(7, '  note: boundary-blank'),
      ELLIPSIS_LINE,
    ],
    `${label}: a blank hidden line must not hide the truncation (stdout: ${JSON.stringify(human.stdout)})`,
  );
  assert.match(
    human.stdout,
    /src[/\\]blank-tail\.yaml:3-9/,
    'the truncated excerpt must keep the full scope range, not the printed one',
  );
  assert.doesNotMatch(human.stdout, /hidden-tail-blank/, 'the hidden tail after the blank line must not be printed');
  assert.strictEqual(backend.requests.length, 1, 'the selected scope must be decided once');

  const json = await runCli(['check', '.', '--rules', rulePath], project);
  const entry = soleEntry(json, `${label} (json)`);
  const scope = scopeOf(entry, 'src/blank-tail.yaml', `${label} (json)`);
  assert.deepStrictEqual(scope.lines, { start: 3, end: 9 }, `${label}: JSON must keep the full scope range`);
  assert.strictEqual(
    scope.source,
    BLANK_TAIL_SOURCE,
    `${label}: JSON must keep the untruncated source, blank line included`,
  );
  assert.strictEqual(backend.requests.length, 2, 'the JSON run must decide the same scope once');
  assert.ok(
    JSON.stringify(backend.requests.at(-1)!.body).includes('hidden-tail-blank'),
    'the decision must send the hidden tail it was given',
  );
  backend.reset();
});

test('a folder group excerpt caps every file at five lines and still prints each file and label', async () => {
  backend.reset();
  backend.probability = 0.1;
  const label = 'folder group excerpt';
  const project = sandbox.isolated('excerpt-group');
  const rulePath = writeFile(
    join(project.rules, 'excerpt-group.yaml'),
    [
      "version: 'v1'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$.service'",
      'decision:',
      '  group_by: folder',
      'check:',
      "  rule: 'Review the folder as one group.'",
      '',
    ].join('\n'),
  );
  writeSources(project, {
    'src/generated/values-alpha.yaml': ALPHA_FILE,
    'src/generated/values-beta.yaml': BETA_FILE,
  });

  const human = await runCli(['check', '.', '--rules', rulePath], project, {}, HUMAN);

  assert.strictEqual(human.status, 0, `${label}: expected success (stderr: ${human.stderr})`);
  assertNoAnsi(human, label);
  assert.deepStrictEqual(
    renderedSourceLines(human.stdout),
    [
      renderedLine(3, 'name: alpha'),
      renderedLine(4, '  tier: gold'),
      renderedLine(5, '  owner: platform'),
      renderedLine(6, '  region: eu'),
      renderedLine(7, '  note: alpha-note'),
      ELLIPSIS_LINE,
      renderedLine(3, 'name: beta'),
      renderedLine(4, '  tier: gold'),
      renderedLine(5, '  owner: platform'),
      renderedLine(6, '  region: eu'),
      renderedLine(7, '  note: beta-note'),
      ELLIPSIS_LINE,
    ],
    `${label}: every file must stay printed, each capped at five lines with its own ellipsis (stdout: ${JSON.stringify(human.stdout)})`,
  );
  assert.match(
    human.stdout,
    /src[/\\]generated[/\\]values-alpha\.yaml:3-8/,
    `${label}: the first file must be labelled with its full scope range`,
  );
  assert.match(
    human.stdout,
    /src[/\\]generated[/\\]values-beta\.yaml:3-9/,
    `${label}: the second file must be labelled with its full scope range`,
  );
  assert.doesNotMatch(human.stdout, /hidden-tail-alpha/, `${label}: the hidden tail of the first file must not be printed`);
  assert.doesNotMatch(human.stdout, /hidden-tail-beta/, `${label}: the hidden tail of the second file must not be printed`);
  assert.doesNotMatch(human.stdout, /hidden-extra-beta/, `${label}: the deepest hidden line must not be printed`);
  assert.strictEqual(backend.requests.length, 1, `${label}: the folder must be decided once, never once per file`);

  const json = await runCli(['check', '.', '--rules', rulePath], project);
  const entry = soleEntry(json, `${label} (json)`);
  assert.strictEqual(entry.contexts.length, 2, `${label}: both files must stay in the JSON contexts`);
  const alpha = scopeOf(entry, 'src/generated/values-alpha.yaml', `${label} (json)`);
  assert.deepStrictEqual(alpha.lines, { start: 3, end: 8 }, `${label}: the first file must keep its full range`);
  assert.strictEqual(alpha.source, ALPHA_SOURCE, `${label}: the first file must keep its untruncated source`);
  const beta = scopeOf(entry, 'src/generated/values-beta.yaml', `${label} (json)`);
  assert.deepStrictEqual(beta.lines, { start: 3, end: 9 }, `${label}: the second file must keep its full range`);
  assert.strictEqual(beta.source, BETA_SOURCE, `${label}: the second file must keep its untruncated source`);
  assert.strictEqual(backend.requests.length, 2, `${label}: the JSON run must decide the folder once`);
  const sent = JSON.stringify(backend.requests.at(-1)!.body);
  for (const content of [
    'hidden-tail-alpha',
    'hidden-extra-beta',
    'src/generated/values-alpha.yaml',
    'src/generated/values-beta.yaml',
  ]) {
    assert.ok(sent.includes(content), `${label}: the grouped decision must send ${content}`);
  }
  backend.reset();
});

test('the human summary colors violations and passes only when the stream supports color', async () => {
  scheduler.reset();
  const project = held.isolated('human-color');
  const rulePath = writeFile(
    join(project.rules, 'color.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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
    yamlRule('Review nothing.', { included: ['nothing/**/*.yaml'] }),
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
    `${yamlRule('Review every source.', { included: ['**/*.yaml'] })}  violation-message: 'Pin service resources.'\n`,
  );
  writeSources(project, {
    'src/a.yaml': '{service: {name: alpha}}',
    'src/b.yaml': '{service: {name: beta}}',
  });

  const result = await runCli(['check', '.', '--rules', rulePath], project);

  const entry = soleEntry(result, 'json output');
  assert.strictEqual(result.stderr, '', 'JSON output must leave stderr quiet');
  assertNoAnsi(result, 'json output');
  const [reported]: unknown[] = JSON.parse(result.stdout);
  assert.ok(isMapping(reported));
  assert.strictEqual(reported.violationMessage, 'Pin service resources.');
  assert.ok(!('title' in reported), 'the deprecated metadata key must not leak into JSON reports');
  for (const request of backend.requests) {
    assert.doesNotMatch(JSON.stringify(request.body), /Pin service resources|violationMessage|violation-message/);
  }
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
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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

function recordingStream(into: string[]): (chunk: string | Uint8Array) => boolean {
  return chunk => {
    into.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
}

function assertReportFailure(stderr: readonly string[], written: number, where: string): void {
  const failing = stderr.filter(chunk => chunk.includes('run.failed'));
  assert.strictEqual(failing.length, 1, `${where}: the report failure must be logged exactly once (stderr: ${JSON.stringify(stderr)})`);
  assert.strictEqual(failing[0], '[debug] run.failed phase="report" reason="Error"\n', `${where}: the loss must be named as the report phase`);
  const separator = stderr.indexOf('\n');
  assert.ok(separator !== -1 && separator < stderr.indexOf(failing[0]!), `${where}: the blank diagnostic separator must precede the failure`);
  assert.strictEqual(written, 1, `${where}: the failed report must not be retried`);
}

function assertSeparatorFailure(stderr: readonly string[], written: number, where: string): void {
  const failing = stderr.filter(chunk => chunk.includes('run.failed'));
  assert.strictEqual(failing.length, 1, `${where}: the separator failure must be logged exactly once (stderr: ${JSON.stringify(stderr)})`);
  assert.strictEqual(failing[0], '[debug] run.failed phase="decisions" reason="Error"\n', `${where}: the loss must be named as the decisions phase`);
  assert.strictEqual(stderr.includes('\n'), false, `${where}: a separator that failed to write must not be retried`);
  assert.strictEqual(written, 0, `${where}: a failed separator must not be followed by a report`);
}

test('a JSON report that fails after a successful check logs the report phase once and rethrows', async (t) => {
  const failure = new Error('stdout is closed');
  const stderr: string[] = [];
  let written = 0;
  t.mock.method(process.stderr, 'write', recordingStream(stderr));
  t.mock.method(process.stdout, 'write', () => {
    written += 1;
    throw failure;
  });
  const application: Check = async () => [];

  await assert.rejects(
    () => checkCommand(application, '.', { json: true, debug: true }),
    (error: unknown) => error === failure,
  );

  assert.ok(stderr[0]!.startsWith('[debug] run.start '), `the run must still announce itself (stderr: ${JSON.stringify(stderr)})`);
  assertReportFailure(stderr, written, 'JSON report');
});

test('a human report that fails after a successful check logs the report phase once and rethrows', async (t) => {
  const failure = new Error('stdout is closed');
  const stderr: string[] = [];
  let written = 0;
  t.mock.method(process.stderr, 'write', recordingStream(stderr));
  t.mock.method(process.stdout, 'write', () => {
    written += 1;
    throw failure;
  });
  const application: Check = async () => [];

  await assert.rejects(
    () => checkCommand(application, '.', { debug: true }),
    (error: unknown) => error === failure,
  );

  assertReportFailure(stderr, written, 'human report');
});

test('a separator that fails once logs the decisions phase once and never reports', async (t) => {
  const failure = new Error('stderr is closed');
  const stderr: string[] = [];
  let written = 0;
  let separatorFailed = false;
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text === '\n' && !separatorFailed) {
      separatorFailed = true;
      throw failure;
    }
    stderr.push(text);
    return true;
  });
  t.mock.method(process.stdout, 'write', () => {
    written += 1;
    return true;
  });
  const application: Check = async () => [];

  await assert.rejects(
    () => checkCommand(application, '.', { json: true, debug: true }),
    (error: unknown) => error === failure,
  );

  assert.ok(stderr[0]!.startsWith('[debug] run.start '), `the run must still announce itself (stderr: ${JSON.stringify(stderr)})`);
  assertSeparatorFailure(stderr, written, 'separator');
});

test('a pipeline failure stays the application diagnostic and never reaches stdout or the report phase', async (t) => {
  const failure = new Error('rules are broken');
  const stderr: string[] = [];
  const stdout: string[] = [];
  t.mock.method(process.stderr, 'write', recordingStream(stderr));
  t.mock.method(process.stdout, 'write', recordingStream(stdout));
  const application: Check = async () => {
    throw failure;
  };

  await assert.rejects(
    () => checkCommand(application, '.', { json: true, debug: true }),
    (error: unknown) => error === failure,
  );

  assert.doesNotMatch(stderr.join(''), /run\.failed/, 'the application owns the pipeline failure diagnostic');
  assert.strictEqual(stderr.includes('\n'), false, 'a failed pipeline must not emit the blank diagnostic separator');
  assert.deepStrictEqual(stdout, [], 'a failed check must write nothing to stdout');
});

test('a narrow terminal still shows the full rule identity and the violation count of a scope summary', async () => {
  const ruleName = 'Révision données — vérifier chaque fichier';
  const violating = ['src/données/é.yaml', 'src/données/è.yaml', 'src/données/ê.yaml'];
  const passing = ['src/données/à.yaml', 'src/données/ç.yaml'];

  for (const columns of NARROW_COLUMNS) {
    scheduler.reset();
    const project = held.isolated(`narrow-scope-${columns}`);
    const rulePath = writeFile(
      join(project.rules, `${ruleName}.yaml`),
      yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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
      join(project.rules, `${ruleName}.yaml`),
      [
        "version: 'v1'",
        'files:',
        '  included:',
        "    - '**/*.yaml'",
        'scope:',
        '  format: yaml',
        "  path: '$.items[*]'",
        "  key: '$.id'",
        'decision:',
        '  group_by: file',
        'check:',
        '  rule: Review the selected items as one group.',
        '',
      ].join('\n'),
    );
    writeSources(project, {
      'src/données/a.yaml': 'items:\n  - id: a\n  - id: b\n',
      [violating]: 'items:\n  - id: c\n  - id: d\n',
    });
    const probabilities: Record<string, number> = {
      [groupedDecisionKey(['src/données/a.yaml'])]: 0.9,
      [groupedDecisionKey([violating])]: 0.1,
    };
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
