import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createRuleDependencyManager, type RuleDependencyManager } from '../dist/adapter/filesystem/dependencies.js';
import { prepareRuleDependencySdk, publishRuleDependencyInstallation, withRuleDependencyDirectoryLock } from '../dist/adapter/filesystem/dependency-installation.js';
import { createDependencyFixture, dependencyFixtureEnvironment, installDependencyRegistry, POLICY_MESSAGE_V1, POLICY_MESSAGE_V2 } from './dependency-support.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'coderuler-installation-')));
const fixture = createDependencyFixture(join(root, 'registry'));
const markerName = '.coderuler-install.json';
const sdk = '@alex-dbs/coderuler';
const firstKey = 'a'.repeat(64);
const secondKey = 'b'.repeat(64);
let sequence = 0;
after(() => rmSync(root, { recursive: true, force: true }));

function owner(): string {
  const path = join(root, `owner-${sequence++}`, '.coderuler');
  mkdirSync(path, { recursive: true });
  return path;
}
function tree(nodeModules: string, key: string, value: string): void {
  mkdirSync(join(nodeModules, 'fixture-policy'), { recursive: true });
  writeFileSync(join(nodeModules, 'fixture-policy', 'index.js'), `export const message = ${JSON.stringify(value)};\n`);
  writeFileSync(join(nodeModules, markerName), JSON.stringify({ version: 1, key, installedLocations: ['node_modules/fixture-policy'] }));
}
function stage(directory: string, key = secondKey): string {
  const path = mkdtempSync(join(directory, '.coderuler-stage-'));
  tree(join(path, 'node_modules'), key, 'next');
  writeFileSync(join(path, 'package.json'), '{"name":"internal-stage-only"}');
  writeFileSync(join(path, 'package-lock.json'), '{"lockfileVersion":3}');
  return path;
}
function previous(directory: string): void {
  tree(join(directory, 'node_modules'), firstKey, 'previous');
  writeFileSync(join(directory, 'coderuler.lock'), 'previous lock\n');
}
function marker(directory: string): { version: number; key: string; sdkTarget?: string } {
  return JSON.parse(readFileSync(join(directory, 'node_modules', markerName), 'utf8'));
}
function intercept(context: TestContext, name: 'rename' | 'mkdir' | 'rm' | 'writeFile', handler: (args: readonly unknown[], original: (...args: unknown[]) => Promise<unknown>) => Promise<unknown>): void {
  const methods = fsPromises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = methods[name]!;
  methods[name] = (...args: unknown[]) => handler(args, original);
  syncBuiltinESMExports();
  context.after(() => { methods[name] = original; syncBuiltinESMExports(); });
}
function manager(context: TestContext, directory: string): RuleDependencyManager {
  const registry = installDependencyRegistry(fixture);
  context.after(() => registry.close());
  return createRuleDependencyManager({ cacheRoot: join(dirname(directory), 'cache') });
}
async function installedMessage(directory: string): Promise<string> {
  const path = join(directory, 'node_modules', 'fixture-policy', 'index.js');
  const module = await import(`${pathToFileURL(path).href}?case=${sequence++}`) as { message: string };
  return module.message;
}
function sdkPackage(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: sdk, version: '0.0.0-local', type: 'module', exports: { '.': { import: './public.js' } } }));
  writeFileSync(join(path, 'public.js'), 'export const localSDK = true;\n');
}

test('publishes real package directories and commits lock last without exposing synthesized manifests', async context => {
  const directory = owner();
  previous(directory);
  writeFileSync(join(directory, 'package.json'), '{"name":"user-application"}\n');
  writeFileSync(join(directory, 'package-lock.json'), 'user lock\n');
  const staged = stage(directory);
  intercept(context, 'rename', async (args, original) => {
    if (String(args[1]) === join(directory, 'coderuler.lock')) {
      assert.equal(marker(directory).key, secondKey);
      assert.equal(readFileSync(join(directory, 'coderuler.lock'), 'utf8'), 'previous lock\n');
    }
    return original(...args);
  });
  await withRuleDependencyDirectoryLock(directory, () => publishRuleDependencyInstallation({ directory, stage: staged, previousLock: 'previous lock\n', nextLock: 'next lock\n' }));
  assert.equal(lstatSync(join(directory, 'node_modules', 'fixture-policy')).isSymbolicLink(), false);
  assert.equal(marker(directory).key, secondKey);
  assert.equal(readFileSync(join(directory, 'coderuler.lock'), 'utf8'), 'next lock\n');
  assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), '{"name":"user-application"}\n');
  assert.equal(readFileSync(join(directory, 'package-lock.json'), 'utf8'), 'user lock\n');
  assert.equal(existsSync(staged), false);
});

for (const failure of ['directory', 'lock'] as const) {
  test(`failure before ${failure} publication restores the previous installed graph`, async context => {
    const directory = owner();
    previous(directory);
    const staged = stage(directory);
    let injected = false;
    const destination = join(directory, failure === 'directory' ? 'node_modules' : 'coderuler.lock');
    intercept(context, 'rename', async (args, original) => {
      if (!injected && String(args[1]) === destination) { injected = true; throw new Error('injected publication failure'); }
      return original(...args);
    });
    await assert.rejects(withRuleDependencyDirectoryLock(directory, () => publishRuleDependencyInstallation({ directory, stage: staged, previousLock: 'previous lock\n', nextLock: 'next lock\n' })), /injected publication failure/);
    assert.equal(marker(directory).key, firstKey);
    assert.equal(readFileSync(join(directory, 'node_modules', 'fixture-policy', 'index.js'), 'utf8'), 'export const message = "previous";\n');
    assert.equal(readFileSync(join(directory, 'coderuler.lock'), 'utf8'), 'previous lock\n');
    assert.equal(existsSync(staged), false);
  });
}

test('postcommit cleanup and mutex release failures warn without reporting the install failed', async context => {
  const directory = owner();
  previous(directory);
  const staged = stage(directory);
  const warnings: string[] = [];
  intercept(context, 'rm', async (args, original) => {
    if ([staged, join(directory, '.coderuler-deps-write')].includes(String(args[0]))) throw new Error('injected cleanup failure');
    return original(...args);
  });
  const onWarning = (message: string): void => { warnings.push(message); };
  await withRuleDependencyDirectoryLock(directory, () => publishRuleDependencyInstallation({ directory, stage: staged, previousLock: 'previous lock\n', nextLock: 'next lock\n', onWarning }), onWarning);
  assert.equal(marker(directory).key, secondKey);
  assert.equal(readFileSync(join(directory, 'coderuler.lock'), 'utf8'), 'next lock\n');
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(message => message.includes('committed')));
});

test('external lock edits survive publication rejection and the previous tree is restored', async context => {
  const directory = owner();
  previous(directory);
  const staged = stage(directory);
  intercept(context, 'rename', async (args, original) => {
    const result = await original(...args);
    if (String(args[0]) === join(staged, 'node_modules')) writeFileSync(join(directory, 'coderuler.lock'), 'external lock edit\n');
    return result;
  });
  await assert.rejects(publishRuleDependencyInstallation({ directory, stage: staged, previousLock: 'previous lock\n', nextLock: 'next lock\n' }), /installation conflict/);
  assert.equal(marker(directory).key, firstKey);
  assert.equal(readFileSync(join(directory, 'coderuler.lock'), 'utf8'), 'external lock edit\n');
});

test('rollback preserves a concurrently replaced installed directory and its old recovery backup', async context => {
  const directory = owner();
  previous(directory);
  const staged = stage(directory);
  const displaced = join(directory, 'externally-displaced');
  intercept(context, 'rename', async (args, original) => {
    if (String(args[1]) === join(directory, 'coderuler.lock')) {
      await original(join(directory, 'node_modules'), displaced);
      mkdirSync(join(directory, 'node_modules'));
      writeFileSync(join(directory, 'node_modules', 'user.txt'), 'preserve me');
      throw new Error('concurrent directory replacement');
    }
    return original(...args);
  });
  await assert.rejects(publishRuleDependencyInstallation({ directory, stage: staged, previousLock: 'previous lock\n', nextLock: 'next lock\n' }), error => {
    assert.ok(String(error).includes(staged));
    return /Preserved recovery files/.test(String(error));
  });
  assert.equal(readFileSync(join(directory, 'node_modules', 'user.txt'), 'utf8'), 'preserve me');
  assert.equal(existsSync(join(staged, 'previous-node_modules', markerName)), true);
  assert.equal(readFileSync(join(directory, 'coderuler.lock'), 'utf8'), 'previous lock\n');
});

test('rollback refuses a changed marker even when the directory inode is unchanged', async context => {
  const directory = owner();
  previous(directory);
  const staged = stage(directory);
  intercept(context, 'rename', async (args, original) => {
    if (String(args[1]) === join(directory, 'coderuler.lock')) {
      writeFileSync(join(directory, 'node_modules', markerName), JSON.stringify({ version: 1, key: 'c'.repeat(64), installedLocations: [] }));
      writeFileSync(join(directory, 'node_modules', 'user.txt'), 'new owner');
      throw new Error('marker changed');
    }
    return original(...args);
  });
  await assert.rejects(publishRuleDependencyInstallation({ directory, stage: staged, previousLock: 'previous lock\n', nextLock: 'next lock\n' }), /Preserved recovery files/);
  assert.equal(readFileSync(join(directory, 'node_modules', 'user.txt'), 'utf8'), 'new owner');
  assert.equal(existsSync(join(staged, 'previous-node_modules')), true);
});

test('unmarked user node_modules is never adopted or deleted', async () => {
  const directory = owner();
  mkdirSync(join(directory, 'node_modules'));
  writeFileSync(join(directory, 'node_modules', 'user.txt'), 'user data');
  const staged = stage(directory);
  await assert.rejects(publishRuleDependencyInstallation({ directory, stage: staged, previousLock: null, nextLock: 'next lock' }), /node_modules.*installation conflict/);
  assert.equal(readFileSync(join(directory, 'node_modules', 'user.txt'), 'utf8'), 'user data');
  assert.equal(existsSync(join(directory, 'coderuler.lock')), false);
  assert.equal(existsSync(staged), false);
});

for (const unsafe of ['node_modules', 'scope'] as const) {
  test(`SDK sync preserves symlinked ${unsafe} targets`, async () => {
    const directory = owner();
    const outside = join(root, `outside-${sequence++}`);
    mkdirSync(outside);
    writeFileSync(join(outside, 'user.txt'), 'outside');
    if (unsafe === 'scope') mkdirSync(join(directory, 'node_modules'));
    symlinkSync(outside, unsafe === 'scope' ? join(directory, 'node_modules', '@alex-dbs') : join(directory, 'node_modules'), 'dir');
    await assert.rejects(prepareRuleDependencySdk(directory, join(directory, 'node_modules')), /installation conflict/);
    assert.equal(readFileSync(join(outside, 'user.txt'), 'utf8'), 'outside');
    assert.equal(existsSync(join(outside, 'coderuler')), false);
  });
}

test('SDK-only sync preserves an unowned local SDK with public-only exports and user files', async () => {
  const directory = owner();
  const local = join(directory, 'node_modules', sdk);
  sdkPackage(local);
  writeFileSync(join(directory, 'node_modules', 'user.txt'), 'user files');
  assert.equal(await prepareRuleDependencySdk(directory, join(directory, 'node_modules')), undefined);
  assert.equal(lstatSync(local).isSymbolicLink(), false);
  assert.equal(readFileSync(join(directory, 'node_modules', 'user.txt'), 'utf8'), 'user files');
  assert.equal(existsSync(join(directory, 'node_modules', markerName)), false);
  assert.equal(existsSync(join(directory, 'coderuler.lock')), false);
});

test('SDK resolution prefers an ancestor SDK using its public import-only entry, without package.json exports', async () => {
  const directory = owner();
  const local = join(dirname(directory), 'node_modules', sdk);
  sdkPackage(local);
  const target = await prepareRuleDependencySdk(directory, join(directory, 'node_modules'));
  assert.equal(target, realpathSync(local));
  assert.equal(resolve(dirname(join(directory, 'node_modules', sdk)), readlinkSync(join(directory, 'node_modules', sdk))), target);
  assert.equal(marker(directory).sdkTarget, target);
  assert.equal(marker(directory).key, 'empty');
  assert.equal(existsSync(join(directory, 'coderuler.lock')), false);
});

test('SDK-only sync refreshes a broken generated link to the running SDK', async () => {
  const directory = owner();
  const leaf = join(directory, 'node_modules', sdk);
  mkdirSync(dirname(leaf), { recursive: true });
  const obsolete = join(root, 'removed-sdk-installation');
  symlinkSync(obsolete, leaf, 'dir');
  writeFileSync(join(directory, 'node_modules', markerName), JSON.stringify({ version: 1, key: 'empty', installedLocations: [], sdkTarget: obsolete }));
  const target = await prepareRuleDependencySdk(directory, join(directory, 'node_modules'));
  assert.ok(target && existsSync(target));
  assert.notEqual(target, obsolete);
  assert.equal(marker(directory).sdkTarget, target);
  assert.equal(realpathSync(leaf), target);
});

test('failed SDK marker publication restores the previous owned SDK link and remains retryable', async context => {
  const directory = owner();
  const leaf = join(directory, 'node_modules', sdk);
  mkdirSync(dirname(leaf), { recursive: true });
  const obsolete = join(root, 'previous-sdk-installation');
  symlinkSync(obsolete, leaf, 'dir');
  writeFileSync(join(directory, 'node_modules', markerName), JSON.stringify({ version: 1, key: 'empty', installedLocations: [], sdkTarget: obsolete }));
  let injected = false;
  intercept(context, 'rename', async (args, original) => {
    if (!injected && String(args[1]) === join(directory, 'node_modules', markerName)) {
      injected = true;
      throw new Error('injected SDK marker failure');
    }
    return original(...args);
  });
  await assert.rejects(prepareRuleDependencySdk(directory, join(directory, 'node_modules')), /injected SDK marker failure/);
  assert.equal(resolve(dirname(leaf), readlinkSync(leaf)), obsolete);
  assert.equal(marker(directory).sdkTarget, obsolete);
  const target = await prepareRuleDependencySdk(directory, join(directory, 'node_modules'));
  assert.ok(target && existsSync(target));
  assert.equal(realpathSync(leaf), target);
});

for (const failure of ['writeFile', 'rename'] as const) {
  test(`fresh SDK-only sync retries after ${failure} failure and can add a package`, async context => {
    const directory = owner();
    const managed = manager(context, directory);
    const modules = join(directory, 'node_modules');
    writeFileSync(join(directory, 'user.txt'), 'preserve user files');
    let injected = false;
    intercept(context, failure, async (args, original) => {
      const destination = String(args[failure === 'writeFile' ? 0 : 1]);
      if (!injected && (failure === 'writeFile' ? destination.endsWith(`/${markerName}`) : destination === modules)) {
        injected = true;
        throw Object.assign(new Error('injected SDK bootstrap failure'), { code: 'EACCES' });
      }
      return original(...args);
    });
    await assert.rejects(managed.sync(directory), /injected SDK bootstrap failure/);
    assert.equal(injected, true);
    assert.equal(existsSync(modules), false);
    assert.equal(existsSync(join(directory, 'coderuler.lock')), false);
    assert.equal(existsSync(join(directory, '.coderuler-deps-write')), false);
    assert.equal(readFileSync(join(directory, 'user.txt'), 'utf8'), 'preserve user files');
    assert.equal((await managed.sync(directory)).key, 'empty');
    assert.equal(marker(directory).key, 'empty');
    assert.equal(realpathSync(join(modules, sdk)), marker(directory).sdkTarget);
    await managed.change(directory, 'add', ['fixture-policy@1.0.0']);
    assert.equal(await installedMessage(directory), POLICY_MESSAGE_V1);
    assert.equal(readFileSync(join(directory, 'user.txt'), 'utf8'), 'preserve user files');
  });
}

test('failed fresh SDK bootstrap preserves a concurrently created user node_modules', async context => {
  const directory = owner();
  const managed = manager(context, directory);
  const modules = join(directory, 'node_modules');
  let injected = false;
  intercept(context, 'writeFile', async (args, original) => {
    if (!injected && String(args[0]).endsWith(`/${markerName}`)) {
      injected = true;
      mkdirSync(modules);
      writeFileSync(join(modules, 'user.txt'), 'preserve user modules');
      throw Object.assign(new Error('injected SDK bootstrap failure'), { code: 'EACCES' });
    }
    return original(...args);
  });
  await assert.rejects(managed.sync(directory), /injected SDK bootstrap failure/);
  assert.equal(readFileSync(join(modules, 'user.txt'), 'utf8'), 'preserve user modules');
  assert.equal(existsSync(join(modules, markerName)), false);
  await managed.sync(directory);
  assert.equal(readFileSync(join(modules, 'user.txt'), 'utf8'), 'preserve user modules');
  assert.equal(existsSync(join(modules, markerName)), false);
  await assert.rejects(managed.change(directory, 'add', ['fixture-policy@1.0.0']), /installation conflict/);
  assert.equal(readFileSync(join(modules, 'user.txt'), 'utf8'), 'preserve user modules');
  assert.equal(existsSync(join(directory, 'coderuler.lock')), false);
});

test('SDK-only sync does not claim unrelated user files when adding editor access', async () => {
  const directory = owner();
  mkdirSync(join(directory, 'node_modules'));
  writeFileSync(join(directory, 'node_modules', 'user.txt'), 'preserve');
  await prepareRuleDependencySdk(directory, join(directory, 'node_modules'));
  assert.equal(readFileSync(join(directory, 'node_modules', 'user.txt'), 'utf8'), 'preserve');
  assert.equal(existsSync(join(directory, 'node_modules', markerName)), false);
});

test('manager publishes dotted direct and scoped package directories and their usable installation marker', async context => {
  const directory = owner();
  const dottedFixture = createDependencyFixture(join(root, `dotted-registry-${sequence++}`), [
    {
      manifest: { name: 'fixture.policy', version: '1.0.0', type: 'module', main: './index.js', dependencies: { '@fixture.scope/typed.package': '1.0.0' } },
      files: { 'index.js': 'import { value } from "@fixture.scope/typed.package"; export const message = "dotted policy: " + value;\n' },
    },
    {
      manifest: { name: '@fixture.scope/typed.package', version: '1.0.0', type: 'module', main: './index.js' },
      files: { 'index.js': 'export const value = "dotted scoped dependency";\n' },
    },
  ]);
  const registry = installDependencyRegistry(dottedFixture);
  context.after(() => registry.close());
  const managed = createRuleDependencyManager({ cacheRoot: join(dirname(directory), 'cache') });
  const prepared = await managed.change(directory, 'add', ['fixture.policy@1.0.0', '@fixture.scope/typed.package@1.0.0']);
  assert.equal(marker(directory).key, prepared.key);
  for (const name of ['fixture.policy', '@fixture.scope/typed.package']) {
    assert.equal(lstatSync(join(directory, 'node_modules', name)).isDirectory(), true);
    assert.equal(lstatSync(join(directory, 'node_modules', name)).isSymbolicLink(), false);
  }
  const module = await import(pathToFileURL(join(directory, 'node_modules', 'fixture.policy', 'index.js')).href) as { message: string };
  assert.equal(module.message, 'dotted policy: dotted scoped dependency');
  assert.equal((await managed.prepare(directory)).key, prepared.key);
});

test('concurrent first preparations install one coherent local graph and healthy offline prepare stays read-only', async context => {
  const source = owner();
  const managed = manager(context, source);
  await managed.change(source, 'add', ['fixture-policy@1.0.0']);
  const directory = owner();
  writeFileSync(join(directory, 'coderuler.lock'), readFileSync(join(source, 'coderuler.lock')));
  const [first, second] = await Promise.all([managed.prepare(directory), managed.prepare(directory)]);
  assert.equal(first.key, second.key);
  assert.equal(first.directory, directory);
  assert.equal(lstatSync(join(directory, 'node_modules', 'fixture-policy')).isSymbolicLink(), false);
  assert.equal(await installedMessage(directory), POLICY_MESSAGE_V1);
  intercept(context, 'mkdir', async (args, original) => {
    if (String(args[0]) === join(directory, '.coderuler-deps-write')) throw new Error('healthy prepare must not write');
    return original(...args);
  });
  const offline = createRuleDependencyManager({ cacheRoot: join(root, `unusable-cache-${sequence++}`) });
  assert.equal((await offline.prepare(directory)).key, first.key);
});

test('prepare waits for an active add and re-evaluates the installed key after the mutex', async context => {
  const directory = owner();
  const managed = manager(context, directory);
  const old = await managed.change(directory, 'add', ['fixture-policy@1.0.0']);
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let paused = false;
  intercept(context, 'rename', async (args, original) => {
    if (!paused && String(args[1]) === join(directory, 'coderuler.lock')) {
      paused = true;
      reached.resolve();
      await resume.promise;
    }
    return original(...args);
  });
  const updating = managed.change(directory, 'add', ['fixture-policy@2.0.0']);
  await reached.promise;
  let prepared = false;
  const preparing = managed.prepare(directory).then(value => { prepared = true; return value; });
  await Promise.resolve();
  assert.equal(prepared, false);
  resume.resolve();
  const [updated, ready] = await Promise.all([updating, preparing]);
  assert.notEqual(updated.key, old.key);
  assert.equal(ready.key, updated.key);
  assert.equal(await installedMessage(directory), POLICY_MESSAGE_V2);
});

test('mutex never removes another owner token and warns honestly after a successful action', async () => {
  const directory = owner();
  const warnings: string[] = [];
  await withRuleDependencyDirectoryLock(directory, async () => {
    writeFileSync(join(directory, '.coderuler-deps-write', 'owner.json'), JSON.stringify({ pid: process.pid, token: 'external-owner' }));
  }, message => warnings.push(message));
  assert.equal(existsSync(join(directory, '.coderuler-deps-write')), true);
  assert.equal(warnings.length, 1);
});

test('busy or dead mutex requires explicit confirmed-owner cleanup, never automatic reclamation', async context => {
  const directory = owner();
  const mutex = join(directory, '.coderuler-deps-write');
  mkdirSync(mutex);
  writeFileSync(join(mutex, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'dead-test-owner' }));
  const now = Date.now;
  let calls = 0;
  Date.now = () => now() + (calls++ > 0 ? 31_000 : 0);
  context.after(() => { Date.now = now; });
  await assert.rejects(withRuleDependencyDirectoryLock(directory, async () => { assert.fail('must not enter busy mutex'); }), /owner PID 99999999.*confirming its owner exited/);
  assert.equal(existsSync(mutex), true);
  Date.now = now;
  rmSync(mutex, { recursive: true });
  assert.equal(await withRuleDependencyDirectoryLock(directory, async () => 'ready'), 'ready');
});

const interruptedRunner = join(root, 'interrupted-install.mjs');
writeFileSync(interruptedRunner, String.raw`
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const rename = promises.rename;
promises.rename = async (...args) => {
  const result = await rename(...args);
  if (String(args[1]) === join(config.directory, 'node_modules')) {
    const resume = Promise.withResolvers();
    process.once('message', resume.resolve);
    process.send({ installed: true });
    await resume.promise;
  }
  return result;
};
syncBuiltinESMExports();
const { createRuleDependencyManager } = await import(config.managerURL);
await createRuleDependencyManager({cacheRoot: config.cacheRoot}).change(config.directory, 'add', ['fixture-policy@2.0.0']);
`);

test('interrupted install exposes no wrong graph and explicit sync repairs after confirmed-dead mutex cleanup', async context => {
  const directory = owner();
  const managed = manager(context, directory);
  const before = await managed.change(directory, 'add', ['fixture-policy@1.0.0']);
  const oldLock = readFileSync(join(directory, 'coderuler.lock'), 'utf8');
  const config = join(root, `interrupted-${sequence++}.json`);
  writeFileSync(config, JSON.stringify({ directory, cacheRoot: join(dirname(directory), 'cache'), managerURL: new URL('../dist/adapter/filesystem/dependencies.js', import.meta.url).href }));
  const child = spawn(process.execPath, [interruptedRunner, config], { env: { ...process.env, ...dependencyFixtureEnvironment(fixture) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const barrier = Promise.withResolvers<void>();
  child.once('message', () => barrier.resolve());
  child.once('error', barrier.reject);
  child.once('exit', () => barrier.reject(new Error('child exited before install barrier')));
  await barrier.promise;
  const exited = Promise.withResolvers<void>();
  child.once('exit', () => exited.resolve());
  child.kill('SIGKILL');
  await exited.promise;
  assert.equal(readFileSync(join(directory, 'coderuler.lock'), 'utf8'), oldLock);
  assert.notEqual(marker(directory).key, before.key);
  // Load the resolver only after the interrupted install, exercising its cold-start ownership boundary.
  const { registerRuleDependencies } = await import('../dist/adapter/filesystem/rule-resolution.js');
  const rule = join(directory, 'stale.rule.mjs');
  writeFileSync(rule, 'import {message} from "fixture-policy"; export {message};\n');
  await assert.rejects(async () => {
    registerRuleDependencies(rule, before);
    await import(pathToFileURL(rule).href);
  }, /in.progress|changed|stale|deps sync|rerun/i);
  assert.equal(existsSync(join(directory, '.coderuler-deps-write')), true);
  rmSync(join(directory, '.coderuler-deps-write'), { recursive: true });
  await assert.rejects(async () => {
    registerRuleDependencies(rule, before);
    await import(pathToFileURL(rule).href);
  }, /changed|stale|deps sync|rerun|installation/i);
  const ready = await managed.sync(directory);
  assert.equal(ready.key, before.key);
  assert.equal(await installedMessage(directory), POLICY_MESSAGE_V1);
  assert.equal(readFileSync(join(directory, 'coderuler.lock'), 'utf8'), oldLock);
});
