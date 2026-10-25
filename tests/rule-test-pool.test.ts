import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CLI, createSandbox, runCli, writeFile } from './support.ts';

const sandbox = createSandbox('rulekeeper-test-pool-');
after(() => sandbox.cleanup());

async function startGate(): Promise<{ url: string; signal(key: string): void; close(): Promise<void> }> {
  const signaled = new Set<string>();
  const pending = new Map<string, ServerResponse[]>();
  const signal = (key: string): void => {
    signaled.add(key);
    for (const response of pending.get(key) ?? []) {
      response.statusCode = 204;
      response.end();
    }
    pending.delete(key);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const key = url.searchParams.get('key')!;
    if (request.method === 'GET' && url.pathname === '/wait') {
      if (signaled.has(key)) {
        response.statusCode = 204;
        response.end();
      } else {
        const waiters = pending.get(key);
        if (waiters) waiters.push(response);
        else pending.set(key, [response]);
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/signal') {
      signal(key);
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', listening.reject);
    listening.resolve();
  });
  await listening.promise;
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    signal,
    close: async () => {
      pending.clear();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    },
  };
}

function gateHelpers(url: string): string {
  return `const gateUrl = ${JSON.stringify(url)};
const waitFor = async key => {
  const response = await fetch(gateUrl + '/wait?key=' + encodeURIComponent(key));
  if (!response.ok) throw new Error('test gate request failed');
};
const signal = async key => {
  const response = await fetch(gateUrl + '/signal?key=' + encodeURIComponent(key), { method: 'POST' });
  if (!response.ok) throw new Error('test gate request failed');
};`;
}

function cases(names: readonly string[]): string {
  return names.map(name => `test(${JSON.stringify(name)}).withFiles({ 'inputs/one.txt': ${JSON.stringify(name)} }).passes()`).join(',\n');
}

test('test runs eight cases concurrently with explicit concurrency', { timeout: 30_000 }, async context => {
  const target = sandbox.isolated('explicit-eight');
  const names = Array.from({ length: 8 }, (_, index) => `case-${index}`);
  const markers = names.map(name => join(target.root, name));
  const gate = await startGate();
  context.after(() => gate.close());
  writeFile(join(target.cwd, '.rulekeeper/barrier.rule.ts'), `import { writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
${gateHelpers(gate.url)}
const markers = ${JSON.stringify(markers)};
export default class Barrier extends Rule {
  files = ['inputs/*.txt'];
  check = async subject => {
    const marker = ${JSON.stringify(target.root)} + '/' + subject.source;
    writeFileSync(marker, String(threadId));
    await signal(marker);
    await Promise.all(markers.map(waitFor));
    return pass();
  };
}
export const tests = [${cases(names)}];`);
  const pending = runCli(['test', '--concurrency', '8', '--timeout', '5s'], target);
  context.signal.addEventListener('abort', () => pending.terminate(), { once: true });
  const result = await pending;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const workers = markers.map(marker => Number(readFileSync(marker, 'utf8')));
  assert.equal(new Set(workers).size, 8);
  assert.ok(workers.every(id => id > 0));
});

test('test defaults to one reusable worker across cases and rule suites', { timeout: 30_000 }, async context => {
  const target = sandbox.isolated('default-one');
  const names = ['first-0', 'first-1', 'second-0', 'second-1'];
  for (const suite of ['first', 'second']) {
    writeFile(join(target.cwd, '.rulekeeper', `${suite}.rule.ts`), `import { writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
export default class Serial extends Rule {
  files = ['inputs/*.txt'];
  check = subject => {
    writeFileSync(${JSON.stringify(target.root)} + '/' + subject.source, String(threadId));
    return pass();
  };
}
export const tests = [${cases(names.filter(name => name.startsWith(suite)))}];`);
  }
  const pending = runCli(['test', '--timeout', '5s'], target);
  context.signal.addEventListener('abort', () => pending.terminate(), { once: true });
  const result = await pending;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const workers = names.map(name => Number(readFileSync(join(target.root, name), 'utf8')));
  assert.ok(workers.every(id => id > 0));
  assert.equal(new Set(workers).size, 1, 'all cases in both suites reuse the same worker');
});

test('test bounds worker count and reuses workers and shared helpers across rule suites', { timeout: 30_000 }, async context => {
  const target = sandbox.isolated('reuse');
  const gate = await startGate();
  context.after(() => gate.close());
  const imports = join(target.root, 'helper-imports.jsonl');
  writeFile(join(target.cwd, '.rulekeeper/shared.js'), `import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
appendFileSync(${JSON.stringify(imports)}, JSON.stringify(threadId) + '\\n');
export const worker = threadId;`);
  const suites = ['first', 'second'];
  for (const suite of suites) {
    const names = Array.from({ length: 4 }, (_, index) => `${suite}-${index}`);
    writeFile(join(target.cwd, '.rulekeeper', `${suite}.rule.ts`), `import { writeFileSync } from 'node:fs';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
import { worker } from './shared.js';
${gateHelpers(gate.url)}
export default class Reuse extends Rule {
  files = ['inputs/*.txt'];
  check = async subject => {
    const name = subject.source;
    const marker = ${JSON.stringify(target.root)} + '/' + name;
    writeFileSync(marker, String(worker));
    await signal(marker);
    const index = Number(name.at(-1));
    await waitFor(${JSON.stringify(target.root)} + '/' + name.slice(0, -1) + (index ^ 1));
    return pass();
  };
}
export const tests = [${cases(names)}];`);
  }
  const pending = runCli(['test', '--concurrency', '2', '--timeout', '5s'], target);
  context.signal.addEventListener('abort', () => pending.terminate(), { once: true });
  const result = await pending;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const suiteWorkers = suites.map(suite => new Set(Array.from({ length: 4 }, (_, index) => Number(readFileSync(join(target.root, `${suite}-${index}`), 'utf8')))));
  assert.equal(suiteWorkers[0]!.size, 2);
  assert.deepEqual(suiteWorkers[1], suiteWorkers[0]);
  const workerImports = readFileSync(imports, 'utf8').trim().split('\n').map(Number).filter(id => id > 0);
  assert.equal(workerImports.length, 2, 'each reusable worker imports the shared helper only once');
  assert.deepEqual(new Set(workerImports), suiteWorkers[0]);
});

test('test streams completed cases in declaration order before the suite finishes', { timeout: 20_000 }, async context => {
  const target = sandbox.isolated('ordered-output');
  const laterFinished = join(target.root, 'later-finished');
  const streamed = join(target.root, 'first-result-streamed');
  const gate = await startGate();
  context.after(() => gate.close());
  writeFile(join(target.cwd, '.rulekeeper/order.rule.ts'), `import { writeFileSync } from 'node:fs';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
${gateHelpers(gate.url)}
export default class Ordered extends Rule {
  files = ['inputs/*.txt'];
  check = async subject => {
    if (subject.source === 'first') await waitFor(${JSON.stringify(laterFinished)});
    if (subject.source === 'third') {
      writeFileSync(${JSON.stringify(laterFinished)}, 'second completed and third started');
      await signal(${JSON.stringify(laterFinished)});
      await waitFor(${JSON.stringify(streamed)});
    }
    return pass();
  };
}
export const tests = [${cases(['first', 'second', 'third'])}];`);
  const child = spawn(process.execPath, [CLI, 'test', '--concurrency', '2', '--timeout', '5s'], {
    cwd: target.cwd,
    env: target.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('PASS first (') && !existsSync(streamed)) {
      writeFile(streamed, 'released');
      gate.signal(streamed);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  child.on('error', reject);
  child.on('close', resolve);
  const status = await promise;
  assert.equal(status, 0, stderr || stdout);
  assert.equal(existsSync(streamed), true);
  assert.deepEqual((stdout.match(/^[├└]─ PASS \w+/gm) ?? []).map(line => line.split(' ').at(-1)), ['first', 'second', 'third']);
});

test('test cancels a hanging sibling on operational error and cleans every active root before exit', { timeout: 20_000 }, async context => {
  const target = sandbox.isolated('cancel-active');
  const hanging = join(target.root, 'hanging-root');
  const throwing = join(target.root, 'throwing-root');
  const unscheduled = join(target.root, 'must-not-start');
  const gate = await startGate();
  context.after(() => gate.close());
  writeFile(join(target.cwd, '.rulekeeper/cancel.rule.ts'), `import { writeFileSync } from 'node:fs';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
${gateHelpers(gate.url)}
export default class Cancel extends Rule {
  files = ['inputs/*.txt'];
  root;
  when({ project }) { this.root = project.root; return true; }
  check = async subject => {
    if (subject.source === 'hanging') {
      writeFileSync(${JSON.stringify(hanging)}, this.root);
      await signal(${JSON.stringify(hanging)});
      while (true) {}
    }
    if (subject.source === 'throwing') {
      writeFileSync(${JSON.stringify(throwing)}, this.root);
      await waitFor(${JSON.stringify(hanging)});
      // A real live handle proves cancellation terminates the worker rather than waiting for natural exit.
      setInterval(() => {}, 60_000);
      throw new Error('parallel policy exploded');
    }
    writeFileSync(${JSON.stringify(unscheduled)}, this.root);
    return pass();
  };
}
export const tests = [${cases(['hanging', 'throwing', 'unscheduled'])}];`);
  const pending = runCli(['test', '--concurrency', '2', '--timeout', '60m'], target);
  context.signal.addEventListener('abort', () => pending.terminate(), { once: true });
  const result = await pending;
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.match(result.stderr, /throwing/);
  assert.match(result.stderr, /parallel policy exploded/);
  assert.equal(existsSync(unscheduled), false);
  for (const marker of [hanging, throwing]) assert.equal(existsSync(readFileSync(marker, 'utf8')), false);
});

test('test cancels active cases when an idle worker crashes after emitting its result', { timeout: 20_000 }, async context => {
  const target = sandbox.isolated('idle-worker-error');
  const firstRoot = join(target.root, 'first-root');
  const hangingRoot = join(target.root, 'hanging-root');
  const release = join(target.root, 'release-background-error');
  const gate = await startGate();
  context.after(() => gate.close());
  writeFile(join(target.cwd, '.rulekeeper/background.rule.ts'), `import { writeFileSync } from 'node:fs';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
${gateHelpers(gate.url)}
export default class Background extends Rule {
  files = ['inputs/*.txt'];
  root;
  when({ project }) { this.root = project.root; return true; }
  check = async subject => {
    if (subject.source === 'hanging') {
      writeFileSync(${JSON.stringify(hangingRoot)}, this.root);
      await signal(${JSON.stringify(hangingRoot)});
      while (true) {}
    }
    writeFileSync(${JSON.stringify(firstRoot)}, this.root);
    await waitFor(${JSON.stringify(hangingRoot)});
    void waitFor(${JSON.stringify(release)}).then(() => {
      queueMicrotask(() => { throw new Error('idle worker exploded'); });
    });
    return pass();
  };
}
export const tests = [${cases(['first', 'hanging'])}];`);
  const child = spawn(process.execPath, [CLI, 'test', '--concurrency', '2', '--timeout', '60m'], {
    cwd: target.cwd,
    env: target.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  let stdout = '';
  let stderr = '';
  let firstCleanAtRelease = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('PASS first (') && !existsSync(release)) {
      firstCleanAtRelease = !existsSync(readFileSync(firstRoot, 'utf8'));
      writeFile(release, 'crash idle worker');
      gate.signal(release);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  child.on('error', reject);
  child.on('close', resolve);
  const status = await promise;
  assert.equal(status, 2, stderr || stdout);
  assert.equal(firstCleanAtRelease, true, 'the first worker must have finished its case before crashing');
  assert.match(stdout, /^├─ PASS first /m);
  assert.match(stderr, /idle worker exploded/);
  assert.doesNotMatch(stdout, /Time:/);
  for (const marker of [firstRoot, hangingRoot]) assert.equal(existsSync(readFileSync(marker, 'utf8')), false);
});

test('test replaces only a timed-out worker and reuses its healthy peer in the next suite', { timeout: 25_000 }, async context => {
  const target = sandbox.isolated('replace-timeout');
  const root = JSON.stringify(target.root);
  const names = ['hanging', 'healthy', 'next-first', 'next-second'];
  const gate = await startGate();
  context.after(() => gate.close());
  writeFile(join(target.cwd, '.rulekeeper/first.rule.ts'), `import { writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
${gateHelpers(gate.url)}
export default class Deadline extends Rule {
  files = ['inputs/*.txt'];
  root;
  when({ project }) { this.root = project.root; return true; }
  check = async subject => {
    const marker = ${root} + '/' + subject.source;
    writeFileSync(marker, JSON.stringify({ threadId, root: this.root }));
    await signal(marker);
    if (subject.source === 'hanging') {
      await waitFor(${root} + '/healthy');
      while (true) {}
    }
    return pass();
  };
}
export const tests = [${cases(names.slice(0, 2))}];`);
  writeFile(join(target.cwd, '.rulekeeper/second.rule.ts'), `import { writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
${gateHelpers(gate.url)}
export default class Recovery extends Rule {
  files = ['inputs/*.txt'];
  root;
  when({ project }) { this.root = project.root; return true; }
  check = async subject => {
    const marker = ${root} + '/' + subject.source;
    writeFileSync(marker, JSON.stringify({ threadId, root: this.root }));
    await signal(marker);
    await waitFor(${root} + '/' + (subject.source === 'next-first' ? 'next-second' : 'next-first'));
    return pass();
  };
}
export const tests = [${cases(names.slice(2))}];`);
  const pending = runCli(['test', '--concurrency', '2', '--timeout', '2s'], target);
  context.signal.addEventListener('abort', () => pending.terminate(), { once: true });
  const result = await pending;
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /FAIL hanging .*timeout/);
  for (const name of names.slice(1)) assert.ok(result.stdout.includes(`PASS ${name} (`), result.stdout);
  const records = names.map(name => JSON.parse(readFileSync(join(target.root, name), 'utf8')) as { threadId: number; root: string });
  const recoveredWorkers = new Set(records.slice(2).map(record => record.threadId));
  assert.equal(recoveredWorkers.size, 2);
  assert.equal(recoveredWorkers.has(records[0]!.threadId), false, 'the timed-out worker must be replaced');
  assert.equal(recoveredWorkers.has(records[1]!.threadId), true, 'the healthy worker must remain reusable');
  for (const record of records) assert.equal(existsSync(record.root), false, record.root);
});

test('test rejects concurrency values that are not positive safe integers', async context => {
  const target = sandbox.isolated('invalid-concurrency');
  writeFile(join(target.cwd, '.rulekeeper/text.rule.ts'), `import { Rule, pass, test } from '@alex-dbs/rulekeeper';
export default class Text extends Rule { files = ['inputs/*.txt']; check = () => pass(); }
export const tests = [${cases(['valid'])}];`);
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    await context.test(value, async () => {
      const result = await runCli(['test', `--concurrency=${value}`], target);
      assert.equal(result.status, 2, result.stdout || result.stderr);
      assert.match(result.stderr, /concurrency/);
      assert.equal(result.stdout.includes('PASS valid'), false);
    });
  }
});
