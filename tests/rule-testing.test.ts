import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createSandbox, runCli, startDecisionFixture, writeFile, type Sandbox } from './support.ts';

const sandbox = createSandbox('rulekeeper-testing-');
after(() => sandbox.cleanup());

const TEXT_RULE = `import { Rule, pass, test, violation } from 'rulekeeper';
export default class Text extends Rule {
  files = ['inputs/*.txt'];
  check = subject => subject.source.includes('BAD') ? violation('bad input') : pass();
}
`;

function writeRule(target: Sandbox, name: string, cases: string): string {
  return writeFile(join(target.cwd, '.rulekeeper', `${name}.rule.ts`), `${TEXT_RULE}\nexport const tests = [${cases}];\n`);
}

test('test runs fluent cases through selection, filtering and grouping with isolated state and files', async () => {
  const target = sandbox.isolated('pipeline');
  writeFile(join(target.cwd, '.rulekeeper/budget.rule.ts'), `import { Rule, scopes, pass, test, violation } from 'rulekeeper';
export default class Budget extends Rule {
  files = ['budgets/*.yml'];
  scope = scopes.yaml({ path: '$.budget' });
  group = 'folder';
  runs = 0;
  filter = subject => typeof subject.data === 'number';
  check = subject => {
    if (++this.runs !== 1) throw new Error('rule state leaked between cases');
    const total = subject.members.reduce((sum, member) => sum + member.data, 0);
    return total > 10 ? violation('budget exceeded') : pass();
  };
}
export const tests = [
  test('combined budget exceeds limit').withFiles({
    'budgets/one.yml': { budget: 6 },
    'budgets/two.yml': { budget: 6 },
  }).violates(),
  test('previous files do not leak').withFiles({ 'budgets/one.yml': { budget: 6 } }).passes(),
  test('literal YAML source').withFiles({ 'budgets/one.yml': 'budget: 12' }).violates(),
  test('zero is still applicable').withFiles({ 'budgets/one.yml': { budget: 0 } }).passes(),
  test('null is filtered out').withFiles({ 'budgets/one.yml': { budget: null } }).skips(),
  test('unmatched files are skipped').withFiles({ 'elsewhere/one.yml': { budget: 12 } }).skips(),
];
`);
  writeFile(join(target.cwd, 'budgets/working-tree.yml'), 'budget: 1000');
  writeFile(join(target.cwd, '.rulekeeper/no-tests.rule.ts'), TEXT_RULE);

  const result = await runCli(['test', '--concurrency', '1'], target);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const name of [
    'combined budget exceeds limit', 'previous files do not leak', 'literal YAML source',
    'zero is still applicable', 'null is filtered out', 'unmatched files are skipped',
  ]) assert.ok(result.stdout.includes(name), result.stdout);
  assert.equal(readFileSync(join(target.cwd, 'budgets/working-tree.yml'), 'utf8'), 'budget: 1000');
  assert.equal(existsSync(join(target.cwd, 'budgets/one.yml')), false);
});

test('test reports mismatches, continues to later cases, and does not run during check or validate', async () => {
  const target = sandbox.isolated('mismatch');
  writeRule(target, 'text', `
    test('wrong pass assertion').withFiles({ 'inputs/one.txt': 'BAD' }).passes(),
    test('later matching assertion').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
    test('wrong skip assertion').withFiles({ 'inputs/one.txt': 'GOOD' }).skips(),
  `);
  const result = await runCli(['test'], target);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  for (const value of ['wrong pass assertion', 'later matching assertion', 'wrong skip assertion', 'pass', 'violation', 'skipped']) {
    assert.ok(result.stdout.includes(value), result.stdout);
  }
  for (const args of [['validate'], ['check']]) {
    const ordinary = await runCli(args, target);
    assert.equal(ordinary.status, 0, ordinary.stderr || ordinary.stdout);
    assert.equal(ordinary.stdout.includes('wrong pass assertion'), false);
  }
});

test('test discovers local and home cases and explicit paths replace discovery', async () => {
  const target = sandbox.isolated('selection');
  const local = writeRule(target, 'local', `test('local case').withFiles({ 'inputs/a.txt': 'GOOD' }).passes()`);
  writeFile(join(target.home, '.rulekeeper/home.rule.ts'), `${TEXT_RULE}
export const tests = [test('home case').withFiles({ 'inputs/a.txt': 'GOOD' }).passes()];`);
  const discovered = await runCli(['test'], target);
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.ok(discovered.stdout.includes('local case'), discovered.stdout);
  assert.ok(discovered.stdout.includes('home case'), discovered.stdout);

  writeRule(target, 'other', `test('excluded failure').withFiles({ 'inputs/a.txt': 'BAD' }).passes()`);
  for (const path of [local, '.rulekeeper/local.rule.ts']) {
    const explicit = await runCli(['test', path], target);
    assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
    assert.ok(explicit.stdout.includes('local case'), explicit.stdout);
    assert.equal(explicit.stdout.includes('home case'), false);
    assert.equal(explicit.stdout.includes('excluded failure'), false);
  }
  const directory = await runCli(['test', '.rulekeeper'], target);
  assert.equal(directory.status, 1, directory.stderr || directory.stdout);
  assert.ok(directory.stdout.includes('excluded failure'), directory.stdout);
  assert.equal(directory.stdout.includes('home case'), false);
});

test('test rejects unfinished declarations without affecting ordinary rule validation', async () => {
  const target = sandbox.isolated('incomplete');
  writeRule(target, 'incomplete', `test('unfinished case').withFiles({ 'inputs/a.txt': 'GOOD' })`);
  const result = await runCli(['test'], target);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.ok(result.stderr.includes('incomplete'), result.stderr);
  assert.equal((await runCli(['validate'], target)).status, 0);
});

test('test fails when selected rules contain no test cases', async () => {
  const target = sandbox.isolated('no-cases');
  writeRule(target, 'empty', '');
  writeFile(join(target.cwd, '.rulekeeper/absent.rule.ts'), TEXT_RULE);
  const result = await runCli(['test'], target);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no.*test/i);
});

test('test rejects escaping fixture paths before writing outside its project', async t => {
  for (const absolute of [false, true]) {
    await t.test(absolute ? 'absolute path' : 'parent traversal', async () => {
      const target = sandbox.isolated('escape');
      const filename = `rulekeeper-escape-${randomUUID()}.txt`;
      const outside = join(tmpdir(), filename);
      t.after(() => rm(outside, { force: true }));
      const path = absolute ? outside : `../${filename}`;
      writeRule(target, 'escape', `test('escaping fixture').withFiles({ ${JSON.stringify(path)}: 'BAD' }).passes()`);
      const result = await runCli(['test'], target);
      assert.equal(result.status, 2, result.stdout || result.stderr);
      assert.ok(result.stderr.includes('escaping fixture'), result.stderr);
      assert.equal(existsSync(outside), false);
    });
  }
});

test('test removes temporary projects when rule execution fails and identifies the case', { timeout: 15_000 }, async context => {
  const target = sandbox.isolated('runtime-error');
  const marker = join(target.root, 'temporary-root.txt');
  writeFile(join(target.cwd, '.rulekeeper/throwing.rule.ts'), `import { writeFileSync } from 'node:fs';
import { Rule, pass, test } from 'rulekeeper';
export default class Throwing extends Rule {
  files = ['inputs/*.txt'];
  when({ project }) {
    writeFileSync(${JSON.stringify(marker)}, project.root);
    return true;
  }
  check = subject => {
    // A live worker handle must not prevent CLI exit after an operational error.
    setInterval(() => {}, 60_000);
    if (subject.source === 'GOOD') return pass();
    throw new Error('policy exploded');
  };
}
export const tests = [
  test('passes before operational error').withFiles({ 'inputs/a.txt': 'GOOD' }).passes(),
  test('exploding case').withFiles({ 'inputs/a.txt': 'BAD' }).passes(),
];`);
  const pending = runCli(['test', '--concurrency', '1'], target);
  context.signal.addEventListener('abort', () => pending.terminate(), { once: true });
  const result = await pending;
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.match(result.stdout, /^├─ PASS passes before operational error /m);
  assert.ok(result.stderr.includes('exploding case'), result.stderr);
  assert.ok(result.stderr.includes('policy exploded'), result.stderr);
  assert.equal(existsSync(readFileSync(marker, 'utf8')), false);
});

test('test never contacts an AI provider, even when credentials and an endpoint are configured', async t => {
  const target = sandbox.isolated('offline');
  const fixture = await startDecisionFixture();
  t.after(() => fixture.close());
  writeFile(join(target.cwd, '.rulekeeper/offline.rule.ts'), `import { Rule, ai, test } from 'rulekeeper';
export default class Offline extends Rule {
  files = ['inputs/*.txt'];
  check = ai({ rule: 'The input must be good.' });
}
export const tests = [test('offline case').withFiles({ 'inputs/a.txt': 'GOOD' }).passes()];`);
  const result = await runCli(['test'], target, fixture.env);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.ok(result.stderr.includes('offline case'), result.stderr);
  assert.equal(fixture.requests.length, 0);
});

test('test runs ordinary cases by default without executing opt-in AI cases', async t => {
  const target = sandbox.isolated('ai-opt-in');
  const fixture = await startDecisionFixture();
  t.after(() => fixture.close());
  writeFile(join(target.cwd, '.rulekeeper/mixed.rule.ts'), `import { Rule, pass, test } from 'rulekeeper';
export default class Mixed extends Rule {
  files = ['inputs/*.txt'];
  check = (subject, context) => subject.source === 'LOCAL' ? pass() : context.ai({ rule: 'The input must be good.' });
}
export const tests = [test('ordinary case').withFiles({ 'inputs/a.txt': 'LOCAL' }).passes()];
export const aiTests = [test('opt-in provider case').withFiles({ 'inputs/a.txt': 'GOOD' }).passes()];`);

  const result = await runCli(['test'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS ordinary case/);
  assert.equal(result.stdout.includes('opt-in provider case'), false);
  assert.equal(fixture.requests.length, 0);
});

test('test explains how to enable an explicitly selected AI-only rule', async t => {
  const target = sandbox.isolated('ai-only');
  const fixture = await startDecisionFixture();
  t.after(() => fixture.close());
  const path = writeFile(join(target.cwd, '.rulekeeper/live.rule.ts'), `import { Rule, ai, test } from 'rulekeeper';
export default class Live extends Rule {
  files = ['inputs/*.txt'];
  check = ai({ rule: 'The input must be good.' });
}
export const aiTests = [test('live case').withFiles({ 'inputs/a.txt': 'GOOD' }).passes()];`);

  const result = await runCli(['test', path], target, fixture.env);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.match(result.stderr, /--ai/);
  assert.equal(fixture.requests.length, 0);
});

test('test --ai compares HTTP decisions with expectations and preserves mixed case ordering', async t => {
  const target = sandbox.isolated('ai-decisions');
  const fixture = await startDecisionFixture();
  t.after(() => fixture.close());
  fixture.answer = (_request, index) => ({ probability: index === 0 ? 0.9 : 0.1 });
  const path = writeFile(join(target.cwd, '.rulekeeper/mixed.rule.ts'), `import { Rule, pass, test } from 'rulekeeper';
export default class Mixed extends Rule {
  files = ['inputs/*.txt'];
  check = (subject, context) => subject.source === 'LOCAL' ? pass() : context.ai({ rule: 'The input must be good.' });
}
export const tests = [test('local assertion').withFiles({ 'inputs/local.txt': 'LOCAL' }).passes()];
export const aiTests = [
  test('provider pass assertion').withFiles({ 'inputs/good.txt': 'GOOD' }).passes(),
  test('provider violation assertion').withFiles({ 'inputs/bad.txt': 'BAD' }).violates(),
];`);

  const matching = await runCli(['test', '--ai', '--concurrency', '1', path], target, fixture.env);
  assert.equal(matching.status, 0, matching.stderr || matching.stdout);
  assert.equal(fixture.requests.length, 2);
  for (const request of fixture.requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/systemone');
    assert.equal(request.authorization, `Bearer ${fixture.apiKey}`);
  }
  assert.match(matching.stdout, /├─ PASS local assertion /);
  assert.match(matching.stdout, /├─ PASS provider pass assertion /);
  assert.match(matching.stdout, /└─ PASS provider violation assertion /);
  assert.ok(matching.stdout.indexOf('local assertion') < matching.stdout.indexOf('provider pass assertion'), matching.stdout);
  assert.ok(matching.stdout.indexOf('provider pass assertion') < matching.stdout.indexOf('provider violation assertion'), matching.stdout);

  fixture.probability = 0.1;
  fixture.answer = () => ({});
  const mismatch = await runCli(['test', '--ai', '--concurrency', '1', path], target, fixture.env);
  assert.equal(mismatch.status, 1, mismatch.stderr || mismatch.stdout);
  assert.equal(fixture.requests.length, 4);
  assert.match(mismatch.stdout, /FAIL provider pass assertion /);
  assert.match(mismatch.stdout, /└─ PASS provider violation assertion /);
  assert.match(mismatch.stdout, /expected pass.*(?:got|actual).*violation/i);
});

test('test --ai never authorizes ordinary cases after a live case used the same worker', async t => {
  const target = sandbox.isolated('ai-permission');
  const fixture = await startDecisionFixture();
  t.after(() => fixture.close());
  const rule = `import { Rule, ai, test } from 'rulekeeper';
export default class Live extends Rule {
  files = ['inputs/*.txt'];
  check = ai({ rule: 'The input must be good.' });
}
`;
  writeFile(join(target.cwd, '.rulekeeper/a-live.rule.ts'), `${rule}
export const aiTests = [test('authorized live case').withFiles({ 'inputs/a.txt': 'GOOD' }).passes()];`);
  writeFile(join(target.cwd, '.rulekeeper/b-offline.rule.ts'), `${rule}
export const tests = [test('ordinary AI call').withFiles({ 'inputs/a.txt': 'GOOD' }).passes()];`);

  const result = await runCli(['test', '--ai', '--concurrency', '1'], target, fixture.env);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.match(result.stdout, /PASS authorized live case /);
  assert.ok(result.stderr.includes('ordinary AI call'), result.stderr);
  assert.equal(fixture.requests.length, 1);
});

test('test validates the aiTests export only when AI cases are selected', async () => {
  const target = sandbox.isolated('invalid-ai-tests');
  const path = writeFile(join(target.cwd, '.rulekeeper/invalid-ai.rule.ts'), `${TEXT_RULE}
export const tests = [test('ordinary valid case').withFiles({ 'inputs/a.txt': 'GOOD' }).passes()];
export const aiTests = {};
`);

  const ordinary = await runCli(['test', path], target);
  assert.equal(ordinary.status, 0, ordinary.stderr || ordinary.stdout);
  assert.match(ordinary.stdout, /PASS ordinary valid case/);
  const selected = await runCli(['test', '--ai', path], target);
  assert.equal(selected.status, 2, selected.stdout || selected.stderr);
  assert.match(selected.stderr, /aiTests.*array/i);
});
