import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { CLI, createSandbox, runCli, writeFile } from './support.ts';

const sandbox = createSandbox('rulekeeper-test-output-');
after(() => sandbox.cleanup());

const RULE = `import { Rule, pass, test, violation } from 'rulekeeper';
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
  writeFile(join(target.cwd, '.rulekeeper/example.rule.ts'), `${RULE}
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
  writeFile(join(target.cwd, '.rulekeeper/example.rule.ts'), `${RULE}
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
  writeFile(join(target.cwd, '.rulekeeper/example.rule.ts'), `${RULE}
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
  writeFile(join(target.cwd, '.rulekeeper/alpha.rule.ts'), `${RULE}
export const tests = [
  test('first child').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('last child').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
];`);
  writeFile(join(target.cwd, '.rulekeeper/beta.rule.ts'), `${RULE}
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
  writeFile(join(target.cwd, '.rulekeeper/rule-1.rule.ts'), `${RULE}
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
