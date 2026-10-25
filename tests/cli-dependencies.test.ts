import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  createDependencyFixture,
  dependencyFixtureEnvironment,
  POLICY_MESSAGE_V1,
  POLICY_MESSAGE_V2,
  type RegistryRequest,
} from './dependency-support.ts';
import { CLI, ROOT, createSandbox, parseCheckOutput, writeFile, type CliResult, type Sandbox } from './support.ts';

const sandbox = createSandbox('rulekeeper-cli-dependencies-');
const registry = createDependencyFixture(join(sandbox.root, 'registry'));
after(() => sandbox.cleanup());
let invocation = 0;

function target(label: string): Sandbox {
  const result = sandbox.isolated(label);
  // Unlike the general CLI helper, these consumers must have no application SDK or dependency tree.
  rmSync(join(result.cwd, 'node_modules'), { recursive: true, force: true });
  return result;
}

async function cli(
  consumer: Sandbox,
  args: readonly string[],
  mode: 'all' | 'tarballs' | 'offline' = 'all',
  overrides: NodeJS.ProcessEnv = {},
  onSpawn?: (child: ChildProcess) => void,
): Promise<CliResult & { requests: readonly RegistryRequest[] }> {
  const requestLog = join(consumer.root, `requests-${invocation++}.jsonl`);
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: consumer.cwd,
    env: {
      ...consumer.env,
      ...dependencyFixtureEnvironment(registry, { mode, requestLog }),
      RK_DEPENDENCY_CACHE: 'dependency-cache',
      // The CLI runs by absolute Node path; neither npm nor any other executable is available.
      PATH: join(consumer.root, 'no-executables'),
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe', onSpawn ? 'ipc' : 'ignore'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (text: string) => { stdout += text; });
  child.stderr!.setEncoding('utf8').on('data', (text: string) => { stderr += text; });
  const completion = Promise.withResolvers<number | null>();
  child.on('error', completion.reject);
  child.on('close', completion.resolve);
  onSpawn?.(child);
  const status = await completion.promise;
  const requests = existsSync(requestLog)
    ? readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as RegistryRequest)
    : [];
  return { status, stdout, stderr, requests };
}

function policy(consumer: Sandbox): string {
  writeFile(join(consumer.cwd, 'inputs/working.txt'), 'BAD');
  return writeFile(join(consumer.cwd, '.rulekeeper/policy.rule.ts'), `import { Rule, pass, test, violation } from '@alex-dbs/rulekeeper';
import { message } from 'fixture-policy';
export default class Policy extends Rule {
  files = ['inputs/*.txt'];
  check = subject => subject.source.includes('BAD') ? violation(message) : pass();
}
export const tests = [
  test('locked policy passes').withFiles({ 'inputs/good.txt': 'GOOD' }).passes(),
  test('locked policy violates').withFiles({ 'inputs/bad.txt': 'BAD' }).violates(),
];
`);
}

function lock(consumer: Sandbox): string {
  return readFileSync(join(consumer.cwd, '.rulekeeper/rulekeeper.lock'), 'utf8');
}

function assertPolicy(result: CliResult, message: string): void {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const reports = parseCheckOutput(result, 'managed dependency policy');
  assert.deepEqual(reports.map(report => ({
    name: report.name,
    status: report.status,
    evaluations: report.evaluations.map(entry => ({ filepath: entry.subject.kind === 'scope' ? entry.subject.filepath : '', result: entry.result })),
  })), [{ name: 'policy', status: 'violation', evaluations: [{ filepath: 'inputs/working.txt', result: { status: 'violation', message } }] }]);
}

test('deps add in a fresh consumer acquires exact direct/transitive packages without npm or application changes', async () => {
  const consumer = target('fresh');
  policy(consumer);
  const manifest = readFileSync(join(consumer.cwd, 'package.json'), 'utf8');
  const applicationIgnore = writeFile(join(consumer.cwd, '.gitignore'), 'application-only/\n');
  execFileSync('git', ['init', '--quiet'], { cwd: consumer.cwd, env: consumer.env });
  const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.stdout, `Added fixture-policy@1.0.0\n${join(consumer.cwd, '.rulekeeper/rulekeeper.lock')}\n`);
  assert.equal(added.stderr, '');
  assert.equal(readFileSync(join(consumer.cwd, 'package.json'), 'utf8'), manifest);
  assert.equal(existsSync(join(consumer.cwd, 'node_modules')), false);
  assert.equal(existsSync(join(consumer.cwd, 'package-lock.json')), false);
  assert.equal(readFileSync(applicationIgnore, 'utf8'), 'application-only/\n');
  assert.equal(readFileSync(join(consumer.cwd, '.rulekeeper/.gitignore'), 'utf8'), '/node_modules/\n');
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: consumer.cwd,
    env: consumer.env,
    input: '.rulekeeper/node_modules/fixture-policy/package.json\n.rulekeeper/rulekeeper.lock\n.rulekeeper/policy.rule.ts\n.rulekeeper/.gitignore\n',
    encoding: 'utf8',
  });
  assert.equal(ignored, '.rulekeeper/node_modules/fixture-policy/package.json\n');
  const parsed = JSON.parse(lock(consumer));
  assert.equal(parsed.lockfileVersion, 3);
  assert.deepEqual(parsed.packages[''].dependencies, { 'fixture-policy': '1.0.0' });
  for (const name of ['fixture-policy', 'fixture-shared']) {
    const entry = parsed.packages[`node_modules/${name}`];
    const artifact = registry.artifacts.find(artifact => artifact.manifest.name === name && artifact.manifest.version === '1.0.0')!;
    assert.equal(entry.version, '1.0.0');
    assert.equal(entry.integrity, artifact.integrity);
    assert.match(entry.integrity, /^sha512-/);
  }
  assert.ok(existsSync(join(consumer.cwd, 'dependency-cache/tarballs')), 'relative RK_DEPENDENCY_CACHE must resolve against invocation cwd');
  assert.deepEqual(readdirSync(join(consumer.cwd, 'dependency-cache')), ['tarballs']);
  for (const name of ['fixture-policy', 'fixture-shared']) {
    const installed = lstatSync(join(consumer.cwd, '.rulekeeper/node_modules', name));
    assert.equal(installed.isDirectory(), true);
    assert.equal(installed.isSymbolicLink(), false);
  }
  assertPolicy(await cli(consumer, ['check', '--json']), POLICY_MESSAGE_V1);
});

test('intact copied rules and lock replay tarballs, then check and concurrent inline workers run entirely offline', async () => {
  const original = target('copy-origin');
  const rule = policy(original);
  assert.equal((await cli(original, ['deps', 'add', 'fixture-policy@1.0.0'])).status, 0);
  const committed = lock(original);
  const copy = target('copy-clean');
  writeFile(join(copy.cwd, '.rulekeeper/policy.rule.ts'), readFileSync(rule, 'utf8'));
  writeFile(join(copy.cwd, '.rulekeeper/rulekeeper.lock'), committed);
  writeFile(join(copy.cwd, 'inputs/working.txt'), 'BAD');
  const first = await cli(copy, ['check', '--json'], 'tarballs');
  assertPolicy(first, POLICY_MESSAGE_V1);
  assert.deepEqual(first.requests.map(request => request.kind).sort(), ['tarball', 'tarball']);
  assert.equal(lock(copy), committed);
  rmSync(join(copy.cwd, 'dependency-cache'), { recursive: true });
  const offline = await cli(copy, ['check', '--json'], 'offline');
  assertPolicy(offline, POLICY_MESSAGE_V1);
  assert.deepEqual(offline.requests, []);
  const tested = await cli(copy, ['test', '--concurrency', '2'], 'offline');
  assert.equal(tested.status, 0, tested.stderr || tested.stdout);
  assert.match(tested.stdout, /2 passed, 0 failed/);
  assert.deepEqual(tested.requests, []);
  assert.equal(lock(copy), committed);
  assert.equal(existsSync(join(copy.cwd, 'dependency-cache')), false, 'installed check and workers must not recreate the download cache');
  assert.equal(existsSync(join(copy.cwd, 'node_modules')), false);

  const unavailable = target('copy-offline-empty');
  policy(unavailable);
  writeFile(join(unavailable.cwd, '.rulekeeper/rulekeeper.lock'), committed);
  const failed = await cli(unavailable, ['check', '--json'], 'offline');
  assert.equal(failed.status, 2, failed.stdout);
  assert.equal(failed.stdout, '');
  assert.equal(lock(unavailable), committed);
  assert.equal(existsSync(join(unavailable.cwd, '.rulekeeper/node_modules')), false);
  assert.equal(existsSync(join(unavailable.cwd, '.rulekeeper/.gitignore')), false);
});

for (const [label, args, missing] of [
  ['explicit sync', ['deps', 'sync'], 'fixture-policy'],
  ['automatic check', ['check', '--json'], 'fixture-shared'],
] as const) {
  test(`${label} repairs missing locked packages, persists exact declarations, and executes the golden policy offline afterwards`, async () => {
    const consumer = target(`repair-${missing}`);
    policy(consumer);
    const manifest = readFileSync(join(consumer.cwd, 'package.json'), 'utf8');
    const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
    assert.equal(added.status, 0, added.stderr);
    const damaged = JSON.parse(lock(consumer));
    delete damaged.packages[`node_modules/${missing}`];
    const unused = registry.artifacts.find(artifact => artifact.manifest.name === 'fixture-empty');
    assert.ok(unused);
    damaged.packages['node_modules/fixture-empty'] = { version: unused.manifest.version, resolved: unused.tarball, integrity: unused.integrity };
    const damagedBytes = `${JSON.stringify(damaged, null, 2)}\n`;
    writeFile(join(consumer.cwd, '.rulekeeper/rulekeeper.lock'), damagedBytes);
    const repaired = await cli(consumer, args);
    if (label === 'automatic check') assertPolicy(repaired, POLICY_MESSAGE_V1);
    else {
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.equal(repaired.stdout, `Rule dependencies ready: ${join(consumer.cwd, '.rulekeeper')}\n`);
      assert.equal(repaired.stderr, '');
    }
    assert.ok(repaired.requests.some(request => request.kind === 'metadata'), 'missing graph nodes must use real registry resolution');
    const committed = lock(consumer);
    assert.notEqual(committed, damagedBytes);
    const parsed = JSON.parse(committed);
    assert.deepEqual(parsed.packages[''].dependencies, { 'fixture-policy': '1.0.0' });
    assert.deepEqual(Object.keys(parsed.packages).toSorted(), ['', 'node_modules/fixture-policy', 'node_modules/fixture-shared']);
    assert.equal(parsed.packages['node_modules/fixture-policy'].version, '1.0.0');
    assert.equal(parsed.packages['node_modules/fixture-shared'].version, '1.0.0');
    const offline = await cli(consumer, ['check', '--json'], 'offline');
    assertPolicy(offline, POLICY_MESSAGE_V1);
    assert.deepEqual(offline.requests, []);
    assert.equal(lock(consumer), committed);
    assert.equal(readFileSync(join(consumer.cwd, 'package.json'), 'utf8'), manifest);
    assert.equal(existsSync(join(consumer.cwd, 'node_modules')), false);
    assert.equal(existsSync(join(consumer.cwd, 'package-lock.json')), false);
  });
}

for (const args of [['deps', 'sync'], ['check', '--json']]) {
  test(`${args.join(' ')} repairs deleted local packages from cached downloads and persists a usable installation`, async () => {
    const consumer = target('repair-local-installation');
    policy(consumer);
    const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
    assert.equal(added.status, 0, added.stderr);
    const committed = lock(consumer);
    const nodeModules = join(consumer.cwd, '.rulekeeper/node_modules');
    rmSync(join(nodeModules, 'fixture-shared'), { recursive: true });
    const repaired = await cli(consumer, args, 'offline');
    if (args[0] === 'check') assertPolicy(repaired, POLICY_MESSAGE_V1);
    else {
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.equal(repaired.stdout, `Rule dependencies ready: ${join(consumer.cwd, '.rulekeeper')}\n`);
      assert.equal(repaired.stderr, '');
    }
    assert.deepEqual(repaired.requests, []);
    assert.equal(lock(consumer), committed);
    assert.equal(lstatSync(join(nodeModules, 'fixture-shared')).isDirectory(), true);
    assert.equal(lstatSync(join(nodeModules, 'fixture-shared')).isSymbolicLink(), false);
    rmSync(join(consumer.cwd, 'dependency-cache'), { recursive: true });
    assertPolicy(await cli(consumer, ['check', '--json'], 'offline'), POLICY_MESSAGE_V1);
    assert.equal(existsSync(join(consumer.cwd, 'dependency-cache')), false);
  });
}

for (const args of [['deps', 'sync'], ['check', '--json']]) {
  test(`${args.join(' ')} preserves old committed bytes when graph repair cannot resolve an exact root`, async () => {
    const consumer = target('repair-resolution-failure');
    policy(consumer);
    const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
    assert.equal(added.status, 0, added.stderr);
    const healthy = lock(consumer);
    const damaged = JSON.parse(healthy);
    damaged.packages[''].dependencies = { 'fixture-policy': '99.0.0' };
    delete damaged.packages['node_modules/fixture-policy'];
    const committed = `${JSON.stringify(damaged, null, 2)}\n`;
    writeFile(join(consumer.cwd, '.rulekeeper/rulekeeper.lock'), committed);
    const failed = await cli(consumer, args);
    assert.equal(failed.status, 2, failed.stdout);
    assert.equal(failed.stdout, '');
    assert.ok(failed.requests.some(request => request.kind === 'metadata'));
    assert.equal(lock(consumer), committed);
    writeFile(join(consumer.cwd, '.rulekeeper/rulekeeper.lock'), healthy);
    assertPolicy(await cli(consumer, ['check', '--json'], 'offline'), POLICY_MESSAGE_V1);
  });

  test(`${args.join(' ')} preserves old committed bytes and user-owned installation conflicts during graph repair`, async () => {
    const consumer = target('repair-editor-conflict');
    policy(consumer);
    const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
    assert.equal(added.status, 0, added.stderr);
    const damaged = JSON.parse(lock(consumer));
    delete damaged.packages['node_modules/fixture-shared'];
    const committed = `${JSON.stringify(damaged, null, 2)}\n`;
    writeFile(join(consumer.cwd, '.rulekeeper/rulekeeper.lock'), committed);
    const nodeModules = join(consumer.cwd, '.rulekeeper/node_modules');
    rmSync(nodeModules, { recursive: true });
    const userFile = writeFile(join(nodeModules, 'user-owned.txt'), 'preserve me\n');
    const failed = await cli(consumer, args);
    assert.equal(failed.status, 2, failed.stdout);
    assert.equal(failed.stdout, '');
    assert.equal(lock(consumer), committed);
    assert.equal(readFileSync(userFile, 'utf8'), 'preserve me\n');
    assert.equal(lstatSync(nodeModules).isDirectory(), true);
    rmSync(nodeModules, { recursive: true });
    const retried = await cli(consumer, ['deps', 'sync']);
    assert.equal(retried.status, 0, retried.stderr);
    assertPolicy(await cli(consumer, ['check', '--json'], 'offline'), POLICY_MESSAGE_V1);
  });
}

test('explicit add updates behavior and remove denies ambient application copies and removes managed packages', async () => {
  const consumer = target('update-remove');
  policy(consumer);
  assert.equal((await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0'])).status, 0);
  const updated = await cli(consumer, ['deps', 'add', 'fixture-policy@2.0.0']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(updated.stdout, `Added fixture-policy@2.0.0\n${join(consumer.cwd, '.rulekeeper/rulekeeper.lock')}\n`);
  assertPolicy(await cli(consumer, ['check', '--json'], 'offline'), POLICY_MESSAGE_V2);
  assert.equal(JSON.parse(lock(consumer)).packages['node_modules/fixture-shared'].version, '2.0.0');
  writeFile(join(consumer.cwd, 'node_modules/fixture-policy/package.json'), '{"name":"fixture-policy","version":"99.0.0","type":"module","main":"index.js"}');
  writeFile(join(consumer.cwd, 'node_modules/fixture-policy/index.js'), 'export const message = "ambient application dependency";');
  const removed = await cli(consumer, ['deps', 'remove', 'fixture-policy'], 'offline');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.stdout, `Removed fixture-policy\n${join(consumer.cwd, '.rulekeeper/rulekeeper.lock')}\n`);
  assert.deepEqual(JSON.parse(lock(consumer)).packages[''].dependencies ?? {}, {});
  assert.equal(existsSync(join(consumer.cwd, '.rulekeeper/node_modules/fixture-policy')), false);
  assert.ok(existsSync(join(consumer.cwd, 'node_modules/fixture-policy/index.js')));
  const denied = await cli(consumer, ['check', '--json'], 'offline');
  assert.equal(denied.status, 2, denied.stdout);
  assert.equal(denied.stdout, '');
  assert.match(denied.stderr, /rulekeeper deps add fixture-policy/);
});

for (const [operation, packages, directVersions] of [
  ['add', ['fixture-policy@2.0.0'], { 'fixture-policy': '2.0.0' }],
  ['remove', ['fixture-policy'], {}],
] as const) {
  test(`deps add reports its own committed version after another ${operation} commits before it returns`, { timeout: 30_000 }, async context => {
    const consumer = target(`committed-output-${operation}`);
    const mutex = join(consumer.cwd, '.rulekeeper/.rulekeeper-deps-write');
    const lockPath = join(consumer.cwd, '.rulekeeper/rulekeeper.lock');
    const preload = writeFile(join(consumer.root, 'pause-after-mutex-release.mjs'), `import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = promises.rm;
let paused = false;
promises.rm = async (path, ...args) => {
  const result = await original(path, ...args);
  if (!paused && String(path) === ${JSON.stringify(mutex)}) {
    paused = true;
    const { promise, resolve, reject } = Promise.withResolvers();
    const disconnected = () => reject(new Error('parent disconnected before resuming committed add'));
    const resume = message => {
      if (message !== 'resume') return;
      process.off('message', resume);
      process.off('disconnect', disconnected);
      process.disconnect();
      resolve();
    };
    process.on('message', resume);
    process.once('disconnect', disconnected);
    process.send('mutex-released');
    await promise;
  }
  return result;
};
syncBuiltinESMExports();
`);
    const ready = Promise.withResolvers<void>();
    let firstChild: ChildProcess | undefined;
    let finished = false;
    const stop = () => { firstChild?.kill(); };
    context.signal.addEventListener('abort', stop, { once: true });
    const nodeOptions = dependencyFixtureEnvironment(registry).NODE_OPTIONS;
    const first = cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0'], 'all', {
      NODE_OPTIONS: `${nodeOptions} --import=${JSON.stringify(pathToFileURL(preload).href)}`,
    }, child => {
      firstChild = child;
      child.on('message', message => {
        if (message === 'mutex-released') ready.resolve();
      });
    });
    try {
      await Promise.race([
        ready.promise,
        first.then(result => {
          throw new Error(`first add exited before releasing its mutex: ${result.status}\n${result.stderr}${result.stdout}`);
        }),
      ]);
      assert.equal(existsSync(mutex), false, 'the barrier must run after the real owner mutex is removed');
      assert.deepEqual(JSON.parse(lock(consumer)).packages[''].dependencies, { 'fixture-policy': '1.0.0' });
      const second = await cli(consumer, ['deps', operation, ...packages]);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stderr, '');
      assert.equal(second.stdout, `${operation === 'add' ? 'Added fixture-policy@2.0.0' : 'Removed fixture-policy'}\n${lockPath}\n`);
      const committed = lock(consumer);
      assert.deepEqual(JSON.parse(committed).packages[''].dependencies ?? {}, directVersions);
      assert.ok(firstChild?.connected);
      firstChild.send('resume');
      const added = await first;
      finished = true;
      assert.equal(added.status, 0, added.stderr);
      assert.equal(added.stderr, '');
      assert.equal(added.stdout, `Added fixture-policy@1.0.0\n${lockPath}\n`);
      assert.equal(lock(consumer), committed, 'reporting the first result must not restore its superseded lock');
    } finally {
      context.signal.removeEventListener('abort', stop);
      if (!finished) {
        if (firstChild?.connected) firstChild.send('resume', () => {});
        firstChild?.kill();
        await first.catch(() => {});
      }
    }
  });
}

for (const [specifier, version] of [['fixture-policy', '2.0.0'], ['fixture-policy@latest', '2.0.0'], ['fixture-policy@^1.0.0', '1.0.0']]) {
  test(`deps add ${specifier} saves the selected exact version`, async () => {
    const consumer = target('specifier');
    const added = await cli(consumer, ['deps', 'add', specifier!]);
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(JSON.parse(lock(consumer)).packages[''].dependencies, { 'fixture-policy': version });
    assert.equal(added.stdout, `Added fixture-policy@${version}\n${join(consumer.cwd, '.rulekeeper/rulekeeper.lock')}\n`);
  });
}

test('invalid and missing dependency commands fail with exit 2 and preserve a usable committed graph', async () => {
  const consumer = target('invalid');
  policy(consumer);
  assert.equal((await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0'])).status, 0);
  const committed = lock(consumer);
  const commands = [
    ['deps'], ['deps', 'unknown'], ['deps', 'add'], ['deps', 'remove'], ['deps', 'sync', 'extra'],
    ['deps', 'sync', '--global', '--directory', '.rulekeeper'],
    ['deps', 'add', 'fixture-policy@1', '--global', '--directory', '.rulekeeper'],
    ['deps', 'remove', 'fixture-policy@1.0.0'], ['deps', 'remove', 'fixture-unknown'],
    ['deps', 'add', 'fixture-policy@1', 'fixture-policy@2'],
    ['deps', 'add', 'fixture-missing@1.0.0'], ['deps', 'add', 'fixture-bad-integrity@1.0.0'],
    ['deps', 'add', 'fixture-source-git-dependencies@1.0.0'],
    ['deps', 'add', 'fixture-peer-one@1.0.0', 'fixture-peer-two@1.0.0'],
  ];
  for (const args of commands) {
    const failed = await cli(consumer, args);
    assert.equal(failed.status, 2, `${args.join(' ')}\n${failed.stdout}\n${failed.stderr}`);
    assert.equal(lock(consumer), committed, args.join(' '));
  }
  assertPolicy(await cli(consumer, ['check', '--json'], 'offline'), POLICY_MESSAGE_V1);
});

test('remove and sync require an existing directory and a malformed lock is never rewritten', async () => {
  const consumer = target('missing-lock');
  for (const args of [['deps', 'sync'], ['deps', 'remove', 'fixture-policy']]) {
    const failed = await cli(consumer, args, 'offline');
    assert.equal(failed.status, 2, failed.stdout);
    assert.equal(existsSync(join(consumer.cwd, '.rulekeeper')), false);
  }
  const malformed = '{broken lock';
  writeFile(join(consumer.cwd, '.rulekeeper/rulekeeper.lock'), malformed);
  policy(consumer);
  for (const args of [['deps', 'sync'], ['deps', 'add', 'fixture-policy@1.0.0'], ['check', '--json']]) {
    const failed = await cli(consumer, args, 'offline');
    assert.equal(failed.status, 2, failed.stdout);
    assert.match(failed.stderr, /rulekeeper\.lock/);
    assert.equal(lock(consumer), malformed);
  }
});

for (const empty of [false, true]) {
  test(`explicit sync creates a missing local ignore for an existing ${empty ? 'empty' : 'healthy'} lock without changing application ignores`, async () => {
    const consumer = target(empty ? 'empty-lock-ignore' : 'healthy-lock-ignore');
    policy(consumer);
    const applicationIgnore = writeFile(join(consumer.cwd, '.gitignore'), 'application-only/\n');
    const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
    assert.equal(added.status, 0, added.stderr);
    if (empty) {
      const removed = await cli(consumer, ['deps', 'remove', 'fixture-policy'], 'offline');
      assert.equal(removed.status, 0, removed.stderr);
      assert.deepEqual(JSON.parse(lock(consumer)).packages[''].dependencies ?? {}, {});
    }
    const committed = lock(consumer);
    const ignore = join(consumer.cwd, '.rulekeeper/.gitignore');
    rmSync(ignore, { force: true });
    if (!empty) {
      assertPolicy(await cli(consumer, ['check', '--json'], 'offline'), POLICY_MESSAGE_V1);
      assert.equal(existsSync(ignore), false, 'healthy ordinary loading must not write an ignore file');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const synced = await cli(consumer, ['deps', 'sync'], 'offline');
      assert.equal(synced.status, 0, synced.stderr);
      assert.deepEqual(synced.requests, []);
      assert.equal(readFileSync(ignore, 'utf8'), '/node_modules/\n');
      assert.equal(lock(consumer), committed);
      assert.equal(readFileSync(applicationIgnore, 'utf8'), 'application-only/\n');
    }
  });
}

test('add and repeated sync preserve custom ignore lines and their newline style', async () => {
  const consumer = target('custom-ignore');
  const original = '# Keep local files\r\nscratch/';
  const ignore = writeFile(join(consumer.cwd, '.rulekeeper/.gitignore'), original);
  const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
  assert.equal(added.status, 0, added.stderr);
  const expected = `${original}\r\n/node_modules/\r\n`;
  assert.equal(readFileSync(ignore, 'utf8'), expected);
  for (let attempt = 0; attempt < 2; attempt++) {
    const synced = await cli(consumer, ['deps', 'sync'], 'offline');
    assert.equal(synced.status, 0, synced.stderr);
    assert.equal(readFileSync(ignore, 'utf8'), expected);
  }
});

for (const pattern of ['node_modules', '/node_modules', 'node_modules/', '/node_modules/']) {
  test(`repeated add and sync retain an existing ${pattern} ignore without duplicating it`, async () => {
    const consumer = target('existing-ignore');
    const original = `# Keep custom ignores\nscratch/\n${pattern}`;
    const ignore = writeFile(join(consumer.cwd, '.rulekeeper/.gitignore'), original);
    for (const args of [['deps', 'add', 'fixture-policy@1.0.0'], ['deps', 'sync'], ['deps', 'add', 'fixture-policy@1.0.0'], ['deps', 'sync']]) {
      const result = await cli(consumer, args, args[1] === 'sync' ? 'offline' : 'all');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(ignore, 'utf8'), original);
    }
  });
}

test('add and sync refuse a symlinked local ignore without changing its target or the committed installation', async () => {
  const consumer = target('symlink-ignore');
  policy(consumer);
  const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
  assert.equal(added.status, 0, added.stderr);
  const committed = lock(consumer);
  const ignore = join(consumer.cwd, '.rulekeeper/.gitignore');
  rmSync(ignore, { force: true });
  const outside = writeFile(join(consumer.root, 'outside-ignore'), 'outside-only/\n');
  symlinkSync(outside, ignore);
  for (const args of [['deps', 'add', 'fixture-policy@2.0.0'], ['deps', 'sync']]) {
    const failed = await cli(consumer, args);
    assert.equal(failed.status, 2, failed.stdout);
    assert.match(failed.stderr, /\.gitignore/);
    assert.equal(readFileSync(outside, 'utf8'), 'outside-only/\n');
    assert.equal(lstatSync(ignore).isSymbolicLink(), true);
    assert.equal(lock(consumer), committed);
    assertPolicy(await cli(consumer, ['check', '--json'], 'offline'), POLICY_MESSAGE_V1);
  }
});

test('SDK-only sync exposes the running SDK without creating a lock, cache or application installation', async () => {
  const consumer = target('sdk-sync');
  const directory = join(consumer.cwd, '.rulekeeper');
  mkdirSync(directory);
  const synced = await cli(consumer, ['deps', 'sync'], 'offline');
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(synced.stdout, `Rule dependencies ready: ${directory}\n`);
  assert.deepEqual(synced.requests, []);
  assert.ok(lstatSync(join(directory, 'node_modules/@alex-dbs/rulekeeper')).isSymbolicLink());
  assert.equal(existsSync(join(directory, 'rulekeeper.lock')), false);
  assert.equal(existsSync(join(directory, '.gitignore')), false);
  assert.equal(existsSync(join(consumer.cwd, '.gitignore')), false);
  assert.equal(existsSync(join(consumer.cwd, 'dependency-cache')), false);
  assert.equal(existsSync(join(consumer.cwd, 'node_modules')), false);
  const repeated = await cli(consumer, ['deps', 'sync'], 'offline');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, synced.stdout);
  assert.equal(existsSync(join(directory, '.gitignore')), false);
});

test('global and cwd-relative explicit directories select separate owners', async () => {
  const consumer = target('owners');
  const applicationIgnore = writeFile(join(consumer.cwd, '.gitignore'), 'application-only/\n');
  const global = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0', '--global']);
  assert.equal(global.status, 0, global.stderr);
  assert.equal(global.stdout, `Added fixture-policy@1.0.0\n${join(consumer.home, '.rulekeeper/rulekeeper.lock')}\n`);
  assert.equal(existsSync(join(consumer.cwd, '.rulekeeper')), false);
  assert.equal(readFileSync(join(consumer.home, '.rulekeeper/.gitignore'), 'utf8'), '/node_modules/\n');
  const directory = 'custom/rules';
  const explicit = await cli(consumer, ['deps', 'add', 'fixture-policy@2.0.0', '--directory', directory]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, `Added fixture-policy@2.0.0\n${join(consumer.cwd, directory, 'rulekeeper.lock')}\n`);
  assert.equal(readFileSync(join(consumer.cwd, directory, '.gitignore'), 'utf8'), '/node_modules/\n');
  const synced = await cli(consumer, ['deps', 'sync', '--directory', directory], 'offline');
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(synced.stdout, `Rule dependencies ready: ${join(consumer.cwd, directory)}\n`);
  const globalSync = await cli(consumer, ['deps', 'sync', '--global'], 'offline');
  assert.equal(globalSync.status, 0, globalSync.stderr);
  assert.equal(globalSync.stdout, `Rule dependencies ready: ${join(consumer.home, '.rulekeeper')}\n`);
  assert.equal(existsSync(join(consumer.cwd, 'node_modules')), false);
  assert.equal(readFileSync(applicationIgnore, 'utf8'), 'application-only/\n');
  assert.equal(existsSync(join(consumer.cwd, '.rulekeeper')), false);
  const globalModules = join(consumer.home, '.rulekeeper/node_modules');
  const customModules = join(consumer.cwd, directory, 'node_modules');
  assert.equal(lstatSync(join(globalModules, 'fixture-policy')).isDirectory(), true);
  assert.equal(lstatSync(join(customModules, 'fixture-policy')).isDirectory(), true);
  assert.equal(JSON.parse(readFileSync(join(globalModules, 'fixture-policy/package.json'), 'utf8')).version, '1.0.0');
  assert.equal(JSON.parse(readFileSync(join(customModules, 'fixture-policy/package.json'), 'utf8')).version, '2.0.0');
  assert.notEqual(
    JSON.parse(readFileSync(join(globalModules, '.rulekeeper-install.json'), 'utf8')).key,
    JSON.parse(readFileSync(join(customModules, '.rulekeeper-install.json'), 'utf8')).key,
  );
});

test('deps sync provides actual typed package and SDK declarations to strict NodeNext TypeScript', async () => {
  const consumer = target('typed-editor');
  const added = await cli(consumer, ['deps', 'add', '@fixture/typed@1.0.0']);
  assert.equal(added.status, 0, added.stderr);
  const synced = await cli(consumer, ['deps', 'sync'], 'offline');
  assert.equal(synced.status, 0, synced.stderr);
  const filename = join(consumer.cwd, '.rulekeeper/typed.rule.ts');
  const source = `import { Rule, violation } from '@alex-dbs/rulekeeper';
import { format } from '@fixture/typed';
export default class Typed extends Rule {
  files = ['inputs/*.txt'];
  check = () => violation(format('typed'));
}
`;
  writeFile(filename, source);
  const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
  const args = [tsc, '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2024', '--skipLibCheck', filename];
  const valid = execFileSync(process.execPath, args, { cwd: consumer.cwd, env: consumer.env, encoding: 'utf8' });
  assert.equal(valid, '');
  writeFile(filename, source.replace("format('typed')", 'format(42)'));
  let invalid: { status?: number; stdout?: string; stderr?: string } | undefined;
  try {
    execFileSync(process.execPath, args, { cwd: consumer.cwd, env: consumer.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    invalid = error as typeof invalid;
  }
  assert.ok(typeof invalid?.status === 'number' && invalid.status !== 0, 'wrong typed usage must fail compilation');
  assert.match(invalid?.stdout ?? '', /Argument of type 'number' is not assignable to parameter of type 'string'/);
  assert.equal(existsSync(join(consumer.cwd, 'node_modules')), false);
  assert.equal(existsSync(join(consumer.cwd, 'tsconfig.json')), false);
  assert.equal(lstatSync(join(consumer.cwd, '.rulekeeper/node_modules/@fixture/typed')).isDirectory(), true);
  assert.equal(lstatSync(join(consumer.cwd, '.rulekeeper/node_modules/@fixture/typed')).isSymbolicLink(), false);
  assert.equal(lstatSync(join(consumer.cwd, '.rulekeeper/node_modules/@alex-dbs/rulekeeper')).isSymbolicLink(), true);
  assert.ok(existsSync(join(consumer.cwd, '.rulekeeper/node_modules/.rulekeeper-install.json')));
});

for (const installed of [true, false]) {
  test(`read-only owner ${installed ? 'loads a healthy local installation without writes' : 'rejects a missing installation despite warm downloads'}`, async () => {
    const consumer = target(installed ? 'readonly-installed' : 'readonly-missing');
    policy(consumer);
    const added = await cli(consumer, ['deps', 'add', 'fixture-policy@1.0.0']);
    assert.equal(added.status, 0, added.stderr);
    const directory = join(consumer.cwd, '.rulekeeper');
    const committed = lock(consumer);
    const markerPath = join(directory, 'node_modules/.rulekeeper-install.json');
    const marker = readFileSync(markerPath, 'utf8');
    rmSync(join(directory, '.gitignore'), { force: true });
    if (!installed) rmSync(join(directory, 'node_modules'), { recursive: true });
    const attempts = join(consumer.root, 'readonly-attempts.jsonl');
    const preload = writeFile(join(consumer.root, 'readonly-owner.mjs'), `import promises from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';
const protectedRoots = ${JSON.stringify([directory, join(consumer.cwd, 'dependency-cache')])};
for (const method of ['mkdir', 'writeFile', 'appendFile', 'rename', 'rm', 'rmdir', 'unlink', 'symlink', 'link', 'copyFile', 'cp', 'chmod', 'chown', 'truncate', 'utimes']) {
  const original = promises[method];
  promises[method] = async (...args) => {
    const paths = method === 'rename' || method === 'link' || method === 'copyFile' || method === 'cp' ? args.slice(0, 2) : args.slice(0, 1);
    if (paths.some(path => protectedRoots.some(root => resolve(String(path)) === root || resolve(String(path)).startsWith(root + sep)))) {
      appendFileSync(${JSON.stringify(attempts)}, JSON.stringify({ method, path: String(args[0]) }) + '\\n');
      throw Object.assign(new Error('injected read-only dependency owner'), { code: 'EACCES' });
    }
    return original(...args);
  };
}
syncBuiltinESMExports();
`);
    const nodeOptions = dependencyFixtureEnvironment(registry, { mode: 'offline' }).NODE_OPTIONS;
    const result = await cli(consumer, ['check', '--json'], 'offline', {
      NODE_OPTIONS: `${nodeOptions} --import=${JSON.stringify(pathToFileURL(preload).href)}`,
    });
    if (installed) {
      assertPolicy(result, POLICY_MESSAGE_V1);
      assert.equal(existsSync(attempts), false, 'healthy installed loading must not even attempt owner/cache writes');
      assert.equal(readFileSync(markerPath, 'utf8'), marker);
      assert.equal(existsSync(join(directory, '.gitignore')), false);
    } else {
      assert.equal(result.status, 2, result.stdout);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /read-only|EACCES|permission/i);
      assert.ok(existsSync(attempts), 'missing installation must require a writable owner');
      assert.equal(existsSync(join(directory, 'node_modules')), false);
    }
    assert.deepEqual(result.requests, []);
    assert.equal(lock(consumer), committed);
  });
}
