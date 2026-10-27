import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { CLI, createSandbox, runCli, startDecisionFixture, writeFile } from './support.ts';

const sandbox = createSandbox('coderuler-test-output-');
after(() => sandbox.cleanup());

const RULE = `import { Rule, pass, test, violation } from '@alex-dbs/coderuler';
export default class Example extends Rule {
  files = ['inputs/*.txt'];
  check = async subject => {
    if (subject.source.startsWith('WAIT ')) {
      process.stdout.write('CASE_WAITING\\n');
      await fetch(subject.source.slice(5));
    }
    if (subject.source === 'THROW') throw new Error('later case exploded');
    return subject.source === 'BAD' ? violation('bad input') : pass();
  };
}
`;

function withoutTimings(output: string): string {
  return stripVTControlCharacters(output)
    .replace(/ \(\d+\.\d{2}(?:ms|s|min|h|d)\)(?=\n|$)/g, '')
    .replace(/Time: \d+\.\d{2}(?:ms|s|min|h|d)(?=\n|$)/g, 'Time: <duration>');
}

test('test prints completed results while the next case is still running', { timeout: 15_000 }, async context => {
  const target = sandbox.isolated('streaming');
  const released = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    void released.promise.then(() => response.end('continue'));
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  context.after(() => {
    released.resolve();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  writeFile(join(target.cwd, '.coderuler/example.rule.ts'), `${RULE}
export const tests = [
  test('completed first').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('blocked second').withFiles({ 'inputs/one.txt': 'WAIT http://127.0.0.1:${address.port}' }).passes(),
];`);
  const child = spawn(process.execPath, [CLI, 'test', '--concurrency', '1'], {
    cwd: target.cwd,
    env: target.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  let stdout = '';
  let stderr = '';
  const waiting = Promise.withResolvers<void>();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('CASE_WAITING')) waiting.resolve();
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const done = Promise.withResolvers<number | null>();
  child.once('error', done.reject);
  child.once('close', done.resolve);
  try {
    await Promise.race([
      waiting.promise,
      done.promise.then(() => { throw new Error(`CLI exited before the waiting case: ${stderr}`); }),
    ]);
    assert.ok(stdout.includes('completed first'), stdout);
    assert.match(stdout, /^├─ PASS completed first \(\d+\.\d{2}(?:ms|s|min|h|d)\)$/m);
    assert.equal(stdout.includes('blocked second'), false);
  } finally {
    released.resolve();
    assert.equal(await done.promise, 0, stderr);
  }
  assert.ok(stdout.includes('blocked second'), stdout);
  assert.match(stdout, /^└─ PASS blocked second \(\d+\.\d{2}(?:ms|s|min|h|d)\)$/m);
});

test('test keeps completed results visible when a later case throws', async () => {
  const target = sandbox.isolated('later-error');
  writeFile(join(target.cwd, '.coderuler/example.rule.ts'), `${RULE}
export const tests = [
  test('completed before error').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('exploding later case').withFiles({ 'inputs/one.txt': 'THROW' }).passes(),
];`);
  const result = await runCli(['test', '--concurrency', '1'], target);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stdout.includes('completed before error'), result.stdout);
  assert.ok(result.stderr.includes('exploding later case'), result.stderr);
  assert.ok(result.stderr.includes('later case exploded'), result.stderr);
});

test('test colors pass/fail results and totals without animating redirected output', async () => {
  const target = sandbox.isolated('colors');
  writeFile(join(target.cwd, '.coderuler/example.rule.ts'), `${RULE}
export const tests = [
  test('passing assertion').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('failing assertion').withFiles({ 'inputs/one.txt': 'BAD' }).passes(),
];`);
  const colored = await runCli(['test'], target, { FORCE_COLOR: '1', NO_COLOR: undefined });
  assert.equal(colored.status, 1, colored.stderr);
  assert.match(colored.stdout, /\u001b\[32mPASS/);
  assert.match(colored.stdout, /\u001b\[31mFAIL/);
  assert.match(colored.stdout, /\u001b\[1mexample/);
  assert.equal(colored.stderr, '');
  for (const env of [
    { NO_COLOR: '1', FORCE_COLOR: undefined },
    { FORCE_COLOR: '0', NO_COLOR: undefined },
    { TERM: 'dumb', FORCE_COLOR: undefined, NO_COLOR: undefined },
  ]) {
    const plain = await runCli(['test'], target, env);
    assert.equal(plain.status, 1, plain.stderr);
    assert.equal(withoutTimings(plain.stdout), withoutTimings(colored.stdout));
    assert.equal(plain.stderr, '');
  }
});

test('test groups cases under their rule and ends every rule with a final branch', async () => {
  const target = sandbox.isolated('tree');
  writeFile(join(target.cwd, '.coderuler/alpha.rule.ts'), `${RULE}
export const tests = [
  test('first child').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('last child').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
];`);
  writeFile(join(target.cwd, '.coderuler/beta.rule.ts'), `${RULE}
export const tests = [test('only child').withFiles({ 'inputs/one.txt': 'GOOD' }).passes()];`);
  const result = await runCli(['test'], target);
  assert.equal(result.status, 0, result.stderr);
  const lines = withoutTimings(result.stdout).split('\n').filter(Boolean);
  assert.deepEqual(lines.slice(0, 5), [
    'alpha',
    '├─ PASS first child',
    '└─ PASS last child',
    'beta',
    '└─ PASS only child',
  ]);
});

test('test redacts short credentials without corrupting colored headings or failure labels', async () => {
  const target = sandbox.isolated('short-secret');
  writeFile(join(target.cwd, '.coderuler/rule-1.rule.ts'), `${RULE}
export const tests = [test('case-1').withFiles({ 'inputs/one.txt': 'BAD' }).passes()];`);
  const result = await runCli(['test'], target, {
    TYPESAFE_API_KEY: '1',
    FORCE_COLOR: '1',
    NO_COLOR: undefined,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stdout.includes('\u001b[1mrule-[REDACTED]\u001b[22m'), result.stdout);
  assert.ok(result.stdout.includes('\u001b[31mFAIL\u001b[39m'), result.stdout);
  const text = stripVTControlCharacters(result.stdout);
  assert.equal(text.split('\n')[0], 'rule-[REDACTED]');
  assert.match(text, /^└─ FAIL case-\[REDACTED\] \(expected pass, actual violation\)/m);
  assert.match(text, /0 passed, \[REDACTED\] failed/);
  assert.equal(text.includes('rule-1'), false);
  assert.equal(text.includes('case-1'), false);
  assert.equal(result.stderr, '');
});

test('test --failures-only prints just the summary for passing cases and includes their duration', async () => {
  const target = sandbox.isolated('failures-only-passes');
  writeFile(join(target.cwd, '.coderuler/all-pass.rule.ts'), `${RULE}
export const tests = [
  test('hidden first pass').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('hidden second pass').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
];`);
  const result = await runCli(['test', '--failures-only', '--concurrency', '1'], target);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(withoutTimings(result.stdout), '2 passed, 0 failed  Time: <duration>\n');
  const duration = /Time: (\d+\.\d{2})(ms|s|min|h|d)\n$/.exec(result.stdout);
  assert.ok(duration, result.stdout);
  assert.ok(Number(duration[1]) > 0, result.stdout);
});

test('test --failures-only hides passing rules and closes failure trees before trailing passes', async () => {
  const target = sandbox.isolated('failures-only-trees');
  writeFile(join(target.cwd, '.coderuler/alpha.rule.ts'), `${RULE}
export const tests = [
  test('all-pass rule case').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
];`);
  writeFile(join(target.cwd, '.coderuler/beta.rule.ts'), `${RULE}
export const tests = [
  test('first mismatch').withFiles({ 'inputs/one.txt': 'BAD' }).passes(),
  test('hidden middle pass').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('last mismatch').withFiles({ 'inputs/one.txt': 'GOOD' }).violates(),
  test('hidden trailing pass').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
];`);
  writeFile(join(target.cwd, '.coderuler/gamma.rule.ts'), `${RULE}
export const tests = [
  test('only mismatch').withFiles({ 'inputs/one.txt': 'BAD' }).passes(),
  test('another hidden trailing pass').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
];`);
  const result = await runCli(['test', '--failures-only', '--concurrency', '2'], target);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.deepEqual(withoutTimings(result.stdout).split('\n').filter(Boolean), [
    'beta',
    '├─ FAIL first mismatch (expected pass, actual violation)',
    '└─ FAIL last mismatch (expected violation, actual pass)',
    'gamma',
    '└─ FAIL only mismatch (expected pass, actual violation)',
    '4 passed, 3 failed  Time: <duration>',
  ]);
});

test('test --failures-only flushes completed failures and totals before reporting a runtime error', async () => {
  const target = sandbox.isolated('failures-only-error');
  writeFile(join(target.cwd, '.coderuler/example.rule.ts'), `${RULE}
export const tests = [
  test('hidden completed pass').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('completed mismatch').withFiles({ 'inputs/one.txt': 'BAD' }).passes(),
  test('hidden later pass').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('exploding later case').withFiles({ 'inputs/one.txt': 'THROW' }).passes(),
  test('never reached').withFiles({ 'inputs/one.txt': 'BAD' }).passes(),
];`);
  const result = await runCli(['test', '--failures-only', '--concurrency', '1'], target);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.deepEqual(withoutTimings(result.stdout).split('\n').filter(Boolean), [
    'example',
    '└─ FAIL completed mismatch (expected pass, actual violation)',
    '2 passed, 1 failed  Time: <duration>',
  ]);
  assert.ok(result.stderr.includes('exploding later case'), result.stderr);
  assert.ok(result.stderr.includes('later case exploded'), result.stderr);
  assert.equal(result.stderr.includes('never reached'), false, result.stderr);
});

test('test --failures-only displays timeouts as failures and continues counting later passes', { timeout: 15_000 }, async context => {
  const target = sandbox.isolated('failures-only-timeout');
  writeFile(join(target.cwd, '.coderuler/deadline.rule.ts'), `import { Rule, pass, test } from '@alex-dbs/coderuler';
export default class Deadline extends Rule {
  files = ['inputs/*.txt'];
  check = subject => {
    if (subject.source === 'HANG') {
      while (true) {}
    }
    return pass();
  };
}
export const tests = [
  test('hidden before timeout').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('deadline exceeded').withFiles({ 'inputs/one.txt': 'HANG' }).passes(),
  test('hidden after timeout').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
];`);
  const pending = runCli(['test', '--failures-only', '--timeout', '2s', '--concurrency', '1'], target);
  context.signal.addEventListener('abort', () => pending.terminate(), { once: true });
  const result = await pending;
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.deepEqual(withoutTimings(result.stdout).split('\n').filter(Boolean), [
    'deadline',
    '└─ FAIL deadline exceeded (expected pass, actual timeout)',
    '2 passed, 1 failed  Time: <duration>',
  ]);
});

test('AI tests require --ai and can show all Jev scores', async context => {
  const target = sandbox.isolated('failures-only-ai');
  const fixture = await startDecisionFixture();
  context.after(() => fixture.close());
  fixture.answer = (_request, index) => ({ probability: index % 3 === 0 ? 0.1 : 0.9 });
  const path = writeFile(join(target.cwd, '.coderuler/mixed.rule.ts'), `import { Rule, ai, test } from '@alex-dbs/coderuler';
export default class Mixed extends Rule {
  files = ['inputs/*.txt'];
  check = ai({ instruction: 'The input must be good.' });
}
export const aiTests = [
  test('provider mismatch').withFiles({
    'inputs/one.txt': 'BAD',
    'inputs/two.txt': 'ALSO_BAD',
  }).passes(),
  test('provider pass').withFiles({ 'inputs/three.txt': 'GOOD' }).passes(),
];`);
  const unauthorized = await runCli(['test', '--failures-only', '--ai-scores', path], target, fixture.env);
  assert.equal(unauthorized.status, 2, unauthorized.stderr || unauthorized.stdout);
  assert.match(unauthorized.stderr, /run with --ai to include aiTests/);
  assert.equal(fixture.requests.length, 0);

  const live = await runCli(['test', '--failures-only', '--ai', '--concurrency', '1', path], target, fixture.env);
  assert.equal(live.status, 1, live.stderr || live.stdout);
  assert.equal(live.stderr, '');
  assert.deepEqual(withoutTimings(live.stdout).split('\n').filter(Boolean), [
    'mixed',
    '└─ FAIL provider mismatch (expected pass, actual violation)',
    '1 passed, 1 failed  Time: <duration>',
  ]);
  assert.doesNotMatch(live.stdout, /Jev scores?:/);
  assert.equal(fixture.requests.length, 3);

  const scored = await runCli(['test', '--ai', '--ai-scores', '--concurrency', '1', path], target, fixture.env);
  assert.equal(scored.status, 1, scored.stderr || scored.stdout);
  assert.equal(scored.stderr, '');
  assert.deepEqual(withoutTimings(scored.stdout).split('\n').filter(Boolean), [
    'mixed',
    '├─ FAIL provider mismatch (expected pass, actual violation) (Jev scores: 0.1, 0.9)',
    '└─ PASS provider pass (Jev score: 0.9)',
    '1 passed, 1 failed  Time: <duration>',
  ]);
  assert.equal(fixture.requests.length, 6);
});
