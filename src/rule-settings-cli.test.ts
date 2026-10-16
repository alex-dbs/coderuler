import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  entries,
  isMapping,
  runCli,
  soleEntry,
  startDecisionFixture,
  writeFile,
  yamlRule,
  type DecisionFixture,
  type SandboxRoot,
} from '../tests/support.ts';

let backend!: DecisionFixture;
let sandbox!: SandboxRoot;

before(async () => {
  backend = await startDecisionFixture();
  sandbox = createSandbox('rulekeeper-rule-settings-', backend.env);
});

after(async () => {
  sandbox.cleanup();
  await backend.close();
});

function ruleWith(included: readonly string[], extra: readonly string[] = []): string {
  const lines = ["version: 'v1'", 'files:', '  included:'];
  for (const glob of included) lines.push(`    - '${glob}'`);
  lines.push('scope:', '  format: yaml', "  path: '$'", ...extra, 'check:', "  rule: 'Review every source.'", '');
  return lines.join('\n');
}

function followedByName(list: readonly { readonly name: string; readonly decisions: readonly { readonly follows: boolean }[] }[]) {
  return new Map(list.map((entry) => [entry.name, entry.decisions.map(({ follows }) => follows)]));
}

function askedModels(): string[] {
  return backend.requests
    .map((request) => (isMapping(request.body) ? request.body.model : undefined))
    .map((model) => (typeof model === 'string' ? model : ''))
    .sort();
}

test('two rules in one run decide with their own model and threshold', async () => {
  backend.reset();
  backend.probability = 0.9;
  const project = sandbox.isolated('two-rules');
  writeFile(join(project.rules, 'loose.yaml'), ruleWith(['src/loose/**/*.yaml'], [
    'settings:',
    '  threshold: 0.2',
    "  model: 'loose-model'",
  ]));
  writeFile(join(project.rules, 'strict.yaml'), ruleWith(['src/strict/**/*.yaml'], [
    'settings:',
    '  threshold: 0.95',
    "  model: 'strict-model'",
  ]));
  writeFile(join(project.cwd, 'src', 'loose', 'a.yaml'), 'name: a\n');
  writeFile(join(project.cwd, 'src', 'strict', 'b.yaml'), 'name: b\n');

  const list = entries(await runCli(['check', '.', '--rules', project.rules], project), 'two rules');

  assert.deepStrictEqual(
    [...followedByName(list)],
    [['loose', [true]], ['strict', [false]]],
    'a shared answer of 0.9 must pass one rule threshold and fail the other',
  );
  assert.deepStrictEqual(askedModels(), ['loose-model', 'strict-model'], 'each rule must ask with its own model');
  assert.deepStrictEqual(
    list.map(({ decisions }) => decisions.map(({ model }) => model)),
    [[backend.model], [backend.model]],
    'the answer model stays the one the backend reported',
  );
});

test('a valid rule backend masks an unsupported environment backend while the environment alone stays refused', async () => {
  backend.reset();
  backend.probability = 0.9;
  const project = sandbox.isolated('backend-masking');
  const maskedPath = writeFile(join(project.rules, 'masked.yaml'), ruleWith(['**/*.yaml'], [
    'settings:',
    '  backend: jev',
    '  threshold: 0.2',
  ]));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: a\n');

  const entry = soleEntry(
    await runCli(['check', '.', '--rules', maskedPath], project, { RK_BACKEND: 'other' }),
    'a rule backend beside an unsupported environment backend',
  );
  assert.deepStrictEqual(entry.decisions, [
    { filepath: 'src/a.yaml', scopeId: '0:', follows: true, probability: 0.9, model: backend.model },
  ]);
  assert.strictEqual(backend.requests.length, 1, 'the masked backend must still decide');

  const plainPath = writeFile(join(project.rules, 'plain.yaml'), yamlRule('Review every source.', { included: ['**/*.yaml'] }));
  const refused = await runCli(['check', '.', '--rules', plainPath], project, { RK_BACKEND: 'other' });
  assertFailed(refused, 'an unmasked unsupported backend');
  assert.match(refused.stderr, /Unknown decision backend 'other'/);
  assert.strictEqual(backend.requests.length, 1, 'a refused run must send nothing');
});

test('--threshold outranks a rule threshold, which outranks an unusable environment setting', async () => {
  backend.reset();
  backend.probability = 0.7;
  const project = sandbox.isolated('threshold-precedence');
  const rulePath = writeFile(join(project.rules, 'precedence.yaml'), ruleWith(['**/*.yaml'], [
    'settings:',
    '  threshold: 0.8',
  ]));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: a\n');

  const fromRule = soleEntry(
    await runCli(['check', '.', '--rules', rulePath], project, { RK_THRESHOLD: 'abc' }),
    'a rule threshold over an unusable environment setting',
  );
  assert.deepStrictEqual(fromRule.decisions, [
    { filepath: 'src/a.yaml', scopeId: '0:', follows: false, probability: 0.7, model: backend.model },
  ]);
  assert.strictEqual(backend.requests.length, 1);

  const fromFlag = soleEntry(
    await runCli(['check', '.', '--rules', rulePath, '--threshold', '0.5'], project, { RK_THRESHOLD: 'abc' }),
    'a supplied threshold over a rule threshold and an unusable environment setting',
  );
  assert.deepStrictEqual(fromFlag.decisions, [
    { filepath: 'src/a.yaml', scopeId: '0:', follows: true, probability: 0.7, model: backend.model },
  ]);
  assert.strictEqual(backend.requests.length, 2);

  const debug = await runCli(['check', '.', '--rules', rulePath, '--debug'], project);
  entries(debug, 'a rule threshold on the debug level');
  assert.match(debug.stderr, /\[debug\] decision\.threshold threshold=0\.8 source="rule"/);
});

test('a rule that survives no filter never reaches the provider', async () => {
  backend.reset();
  backend.probability = 0.9;
  const project = sandbox.isolated('no-survivor');
  const rulePath = writeFile(join(project.rules, 'filtered.yaml'), ruleWith(['**/*.yaml'], [
    'filter:',
    '  non_empty: $.data.name',
  ]));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  port: 8080\n');

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'a fully filtered rule');

  assert.deepStrictEqual(entry.contexts, []);
  assert.deepStrictEqual(entry.decisions, []);
  assert.strictEqual(backend.requests.length, 0, 'a rule with no surviving scope must not ask the provider');
});

test('check reports nothing and sends nothing when every rule is disabled', async () => {
  backend.reset();
  const project = sandbox.isolated('all-disabled');
  writeFile(join(project.rules, 'off.yaml'), ruleWith(['**/*.yaml'], ['enabled: false']));
  writeFile(join(project.rules, 'also-off.yaml'), ruleWith(['**/*.yaml'], ['enabled: false']));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: a\n');

  const result = await runCli(['check', '.', '--rules', project.rules], project);

  assert.deepStrictEqual(entries(result, 'a fully disabled run'), []);
  assert.strictEqual(backend.requests.length, 0, 'a disabled rule must not reach the provider');
});

test('check still prints a summary when every rule is disabled', async () => {
  backend.reset();
  const project = sandbox.isolated('all-disabled-human');
  writeFile(join(project.rules, 'off.yaml'), ruleWith(['**/*.yaml'], ['enabled: false']));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: a\n');

  const result = await runCli(['check', '.', '--rules', project.rules], project, {}, { json: false });

  assert.strictEqual(result.status, 0, `a fully disabled run must succeed (stderr: ${result.stderr})`);
  assert.ok(result.stdout.trim() !== '', 'the run must still print its summary');
  assert.strictEqual(backend.requests.length, 0);
});

test('a fully disabled run performs no revision work either', async () => {
  backend.reset();
  const project = sandbox.isolated('all-disabled-diff');
  const offPath = writeFile(join(project.rules, 'off.yaml'), ruleWith(['**/*.yaml'], ['enabled: false']));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: a\n');

  // There is no repository here: a run that reached the diff phase could not succeed.
  const result = await runCli(['check', '.', '--rules', offPath, '--diff-only'], project);
  assert.deepStrictEqual(entries(result, 'a fully disabled diff run'), []);

  const onPath = writeFile(join(project.rules, 'on.yaml'), ruleWith(['**/*.yaml']));
  const control = await runCli(['check', '.', '--rules', onPath, '--diff-only'], project);
  assert.notStrictEqual(control.status, 0, 'the same diff run with an enabled rule must reach the missing repository');

  assert.strictEqual(backend.requests.length, 0);
});

test('check keeps deciding the enabled rules of a mixed run and never reviews a disabled descriptor', async () => {
  backend.reset();
  backend.probability = 0.9;
  const project = sandbox.isolated('mixed');
  const descriptors = join(project.cwd, 'rules');
  writeFile(join(descriptors, 'off.yaml'), ruleWith(['**/*.yaml'], ['enabled: false']));
  writeFile(join(descriptors, 'on.yaml'), ruleWith(['**/*.yaml']));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: a\n');

  const list = entries(await runCli(['check', '.', '--rules', descriptors], project), 'a mixed run');

  assert.deepStrictEqual(list.map(({ name }) => name), ['on'], 'a disabled rule must be absent from the report');
  assert.strictEqual(
    list[0]!.contexts.length,
    1,
    'the enabled rule must review only the source, never the descriptor files',
  );
  assert.strictEqual(backend.requests.length, 1);
});

test('inspect reports a disabled rule as disabled without scanning or deciding', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-disabled');
  const rulePath = writeFile(join(project.rules, 'off.yaml'), ruleWith(['**/*.yaml'], ['enabled: false']));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: a\n');

  const result = await runCli(['inspect', rulePath, '.'], project, {}, { json: false });
  const output = `${result.stdout}${result.stderr}`;

  assert.strictEqual(result.status, 0, `a disabled inspection must succeed (stderr: ${result.stderr})`);
  assert.match(output, /disabled/i, 'the report must say the rule is disabled');
  assert.doesNotMatch(output, /compliant/i, 'a disabled rule must never be reported as compliant');
  assert.strictEqual(backend.requests.length, 0, 'a disabled inspection must not reach the provider');
});

test('validate still compiles a disabled rule', async () => {
  const project = sandbox.isolated('validate-disabled');
  const rulePath = writeFile(join(project.rules, 'off.yaml'), ruleWith(['**/*.yaml'], ['enabled: false']));

  const result = await runCli(['validate', rulePath], project, {}, { json: false });

  assert.strictEqual(result.status, 0, `a disabled rule must still validate (stderr: ${result.stderr})`);
  assert.ok(result.stdout.includes('Valid rule: off '), 'validate must report disabled rules instead of silently skipping them');
});

test('validate refuses an unsupported rule backend', async () => {
  const project = sandbox.isolated('validate-backend');
  const rulePath = writeFile(join(project.rules, 'bad.yaml'), ruleWith(['**/*.yaml'], [
    'settings:',
    '  backend: other',
  ]));

  const result = await runCli(['validate', rulePath], project, {}, { json: false });

  assertFailed(result, 'an unsupported rule backend');
  assert.match(result.stderr, /rule\.settings\.backend/);
});

test('a rule without settings keeps the defaults of the environment', async () => {
  backend.reset();
  backend.probability = 0.9;
  const project = sandbox.isolated('defaults');
  const rulePath = writeFile(join(project.rules, 'plain.yaml'), yamlRule('Review every source.', { included: ['**/*.yaml'] }));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: a\n');

  const entry = soleEntry(
    await runCli(['check', '.', '--rules', rulePath], project, { TYPESAFE_DEFAULT_MODEL: 'env-model' }),
    'a rule without settings',
  );

  assert.deepStrictEqual(entry.decisions, [
    { filepath: 'src/a.yaml', scopeId: '0:', follows: true, probability: 0.9, model: backend.model },
  ]);
  assert.deepStrictEqual(askedModels(), ['env-model'], 'the configured environment model must stay in charge');
});
