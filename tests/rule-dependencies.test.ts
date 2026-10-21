import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import nock from 'nock';

import { createRuleDependencyManager, dependencyDirectory, RegistryHttpsAgent } from '../dist/adapter/filesystem/dependencies.js';
import { createDependencyFixture, installDependencyRegistry, POLICY_MESSAGE_V1, POLICY_MESSAGE_V2 } from './dependency-support.ts';
import type { DependencyFixture, FixturePackage, RegistryRequest } from './dependency-support.ts';

interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [field: string]: unknown;
}
interface RuleLock {
  name: string;
  version: string;
  lockfileVersion: number;
  packages: Record<string, LockPackage>;
  [field: string]: unknown;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'rulekeeper-dependencies-')));
const fixture = createDependencyFixture(join(root, 'registry'));
let sequence = 0;
after(() => rmSync(root, { recursive: true, force: true }));

function setup(context: TestContext, registry: DependencyFixture = fixture) {
  const directory = join(root, `case-${sequence++}`, '.rulekeeper');
  const cacheRoot = join(dirname(directory), 'cache');
  mkdirSync(directory, { recursive: true });
  let network = installDependencyRegistry(registry);
  context.after(() => network.close());
  return {
    directory, cacheRoot,
    manager: createRuleDependencyManager({ cacheRoot }),
    get requests() { return network.requests; },
    network(mode: 'all' | 'tarballs' | 'offline', onRequest?: (request: RegistryRequest) => void): void {
      network.close();
      network = installDependencyRegistry(registry, { mode, ...(onRequest === undefined ? {} : { onRequest }) });
    },
  };
}

function readLock(directory: string): RuleLock {
  return JSON.parse(readFileSync(join(directory, 'rulekeeper.lock'), 'utf8')) as RuleLock;
}
function lockBytes(directory: string): string {
  return readFileSync(join(directory, 'rulekeeper.lock'), 'utf8');
}
function writeLock(directory: string, lock: RuleLock): void {
  writeFileSync(join(directory, 'rulekeeper.lock'), `${JSON.stringify(lock, null, 2)}\n`);
}
function node(lock: RuleLock, location: string): LockPackage {
  const entry = lock.packages[location];
  assert.ok(entry, `lock entry ${location} must exist`);
  return entry;
}
async function message(directory: string): Promise<string> {
  // A fresh consumer observes the mutable owner installation, not Node's prior module cache.
  return execFileSync(process.execPath, ['--input-type=module', '--eval',
    `const loaded = await import(${JSON.stringify(pathToFileURL(join(directory, 'node_modules/fixture-policy/index.js')).href)}); process.stdout.write(loaded.message);`,
  ], { encoding: 'utf8' });
}

function assertNoSharedTrees(cacheRoot: string): void {
  assert.equal(existsSync(join(cacheRoot, 'trees')), false);
}

test('adds exact direct and transitive versions, verifies real tarballs, and leaves application manifests alone', async context => {
  const target = setup(context);
  const applicationManifest = join(dirname(target.directory), 'package.json');
  writeFileSync(applicationManifest, '{"name":"untouched","dependencies":{"ambient":"9.0.0"}}\n');
  const before = readFileSync(applicationManifest, 'utf8');
  const ownerManifest = '{"name":"owner-untouched","dependencies":{"ambient":"99.0.0"}}\n';
  const ownerNpmLock = '{not a managed npm lock}\n';
  writeFileSync(join(target.directory, 'package.json'), ownerManifest);
  writeFileSync(join(target.directory, 'package-lock.json'), ownerNpmLock);
  const executablePath = process.env.PATH;
  process.env.PATH = '';
  context.after(() => {
    if (executablePath === undefined) delete process.env.PATH;
    else process.env.PATH = executablePath;
  });
  const prepared = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
  assert.equal(prepared.directory, target.directory);
  assert.deepEqual(prepared.directDependencies, ['fixture-policy']);
  assert.equal(readFileSync(applicationManifest, 'utf8'), before);
  assert.equal(readFileSync(join(target.directory, 'package.json'), 'utf8'), ownerManifest);
  assert.equal(readFileSync(join(target.directory, 'package-lock.json'), 'utf8'), ownerNpmLock);
  const lock = readLock(target.directory);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, 'rulekeeper-rules');
  assert.equal(lock.version, '1.0.0');
  assert.deepEqual(node(lock, '').dependencies, { 'fixture-policy': '1.0.0' });
  assert.equal(node(lock, 'node_modules/fixture-shared').version, '1.0.0');
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location === '') continue;
    assert.match(entry.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const artifact = fixture.artifacts.find(value => value.tarball === entry.resolved);
    assert.ok(artifact);
    assert.equal(entry.integrity, `sha512-${createHash('sha512').update(Buffer.from(artifact.bytes, 'base64')).digest('base64')}`);
  }
  assert.equal(lockBytes(target.directory), `${JSON.stringify(lock, null, 2)}\n`);
  for (const name of ['fixture-policy', 'fixture-shared']) {
    const path = join(prepared.directory, 'node_modules', name);
    assert.equal(lstatSync(path).isDirectory(), true);
    assert.equal(lstatSync(path).isSymbolicLink(), false);
  }
  assertNoSharedTrees(target.cacheRoot);
});

test('intact copied locks replay frozen tarballs and healthy cached loads remain offline without lock changes', async context => {
  const source = setup(context);
  await source.manager.change(source.directory, 'add', ['fixture-policy@1.0.0']);
  const directory = join(root, `copy-${sequence++}`, '.rulekeeper');
  mkdirSync(directory, { recursive: true });
  const committed = lockBytes(source.directory);
  writeFileSync(join(directory, 'rulekeeper.lock'), committed);
  const cacheRoot = join(dirname(directory), 'cache');
  source.network('tarballs');
  const prepared = await createRuleDependencyManager({ cacheRoot }).prepare(directory);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
  assert.ok(source.requests.length >= 2);
  assert.ok(source.requests.every(value => value.kind === 'tarball'));
  assert.equal(lockBytes(directory), committed);
  source.network('offline');
  rmSync(cacheRoot, { recursive: true, force: true });
  const cached = await createRuleDependencyManager({ cacheRoot }).prepare(directory);
  assert.equal(cached.key, prepared.key);
  assert.equal(cached.directory, prepared.directory);
  assert.equal(await message(cached.directory), POLICY_MESSAGE_V1);
  assert.deepEqual(source.requests, []);
  assert.equal(lockBytes(directory), committed);
  assert.equal(existsSync(cacheRoot), false, 'an intact installation needs no download cache');
  rmSync(join(directory, 'node_modules'), { recursive: true });
  await assert.rejects(createRuleDependencyManager({ cacheRoot }).prepare(directory));
  assert.equal(lockBytes(directory), committed);
  assert.equal(existsSync(join(directory, 'node_modules')), false);
});

test('missing locks are dependency-free and do not create cache files', async context => {
  const target = setup(context);
  target.network('offline');
  assert.deepEqual(await target.manager.prepare(target.directory), {
    directory: target.directory, directDependencies: [], key: 'empty',
  });
  assert.equal(existsSync(join(target.directory, 'node_modules')), false);
  assert.equal(existsSync(target.cacheRoot), false);
  assert.equal(existsSync(join(target.directory, 'rulekeeper.lock')), false);
  assert.deepEqual(target.requests, []);
});

test('ordinary preparation of an existing empty lock performs no filesystem writes or editor warnings', async context => {
  const target = setup(context);
  writeLock(target.directory, {
    name: 'rulekeeper-rules',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'rulekeeper-rules', version: '1.0.0', dependencies: {} } },
  });
  const committed = lockBytes(target.directory);
  const warnings: string[] = [];
  const manager = createRuleDependencyManager({ cacheRoot: target.cacheRoot, onWarning: warning => { warnings.push(warning); } });
  target.network('offline');
  const mkdir = context.mock.method(fsPromises, 'mkdir', () => {
    throw Object.assign(new Error('Empty-lock loading must not create a mutex, cache or editor directory'), { code: 'EACCES' });
  });
  const writeFile = context.mock.method(fsPromises, 'writeFile', () => {
    throw Object.assign(new Error('Empty-lock loading must not publish any files'), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await manager.prepare(target.directory), {
      directory: target.directory, directDependencies: [], key: 'empty',
    });
    assert.equal(mkdir.mock.callCount(), 0);
    assert.equal(writeFile.mock.callCount(), 0);
  } finally {
    mkdir.mock.restore();
    writeFile.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(warnings, []);
  assert.deepEqual(target.requests, []);
  assert.equal(existsSync(target.cacheRoot), false);
  assert.deepEqual(readdirSync(target.directory), ['rulekeeper.lock']);
  assert.equal(lockBytes(target.directory), committed);
});

test('a read-only empty-lock owner loads silently while explicit sync still establishes SDK editor access', async context => {
  const target = setup(context);
  writeLock(target.directory, {
    name: 'rulekeeper-rules',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'rulekeeper-rules', version: '1.0.0', dependencies: {} } },
  });
  const path = join(target.directory, 'rulekeeper.lock');
  const committed = lockBytes(target.directory);
  const warnings: string[] = [];
  const manager = createRuleDependencyManager({ cacheRoot: target.cacheRoot, onWarning: warning => { warnings.push(warning); } });
  target.network('offline');
  chmodSync(path, 0o444);
  chmodSync(target.directory, 0o555);
  try {
    assert.deepEqual(await manager.prepare(target.directory), {
      directory: target.directory, directDependencies: [], key: 'empty',
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(readdirSync(target.directory), ['rulekeeper.lock']);
    assert.equal(existsSync(target.cacheRoot), false);
  } finally {
    chmodSync(target.directory, 0o755);
    chmodSync(path, 0o644);
  }
  const synchronized = await manager.sync(target.directory);
  assert.equal(synchronized.directory, target.directory);
  assert.equal(synchronized.key, 'empty');
  assert.equal(lstatSync(join(target.directory, 'node_modules/@alex-dbs/rulekeeper')).isSymbolicLink(), true);
  assert.equal(existsSync(join(target.directory, 'node_modules/.rulekeeper-install.json')), true);
  assert.equal(existsSync(target.cacheRoot), false);
  assert.equal(lockBytes(target.directory), committed);
  assert.deepEqual(target.requests, []);
});

test('explicit sync replaces a previous owned installation with an empty committed graph offline', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  assert.equal(await message(target.directory), POLICY_MESSAGE_V1);
  const modules = join(target.directory, 'node_modules');
  const markerPath = join(modules, '.rulekeeper-install.json');
  const previousMarker = readFileSync(markerPath, 'utf8');
  const sdk = join(modules, '@alex-dbs/rulekeeper');
  const sdkTarget = realpathSync(sdk);
  const empty = readLock(target.directory);
  empty.packages = { '': { name: 'rulekeeper-rules', version: '1.0.0', dependencies: {} } };
  writeLock(target.directory, empty);
  const committed = lockBytes(target.directory);
  target.network('offline');

  assert.equal((await target.manager.prepare(target.directory)).key, 'empty');
  assert.equal(readFileSync(markerPath, 'utf8'), previousMarker);
  const synchronized = await target.manager.sync(target.directory);
  assert.deepEqual(synchronized, { directory: target.directory, directDependencies: [], key: 'empty' });
  assert.equal(lockBytes(target.directory), committed);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { key: string; installedLocations: string[] };
  assert.equal(marker.key, 'empty');
  assert.deepEqual(marker.installedLocations, []);
  const requireFromOwner = createRequire(join(target.directory, 'consumer.cjs'));
  for (const name of ['fixture-policy', 'fixture-shared']) {
    assert.equal(existsSync(join(modules, name)), false);
    assert.throws(() => requireFromOwner.resolve(name), { code: 'MODULE_NOT_FOUND' });
  }
  assert.equal(lstatSync(sdk).isSymbolicLink(), true);
  assert.equal(realpathSync(sdk), sdkTarget);
  const sdkManifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')) as { types: string };
  assert.equal(typeof sdkManifest.types, 'string');
  assert.equal(lstatSync(realpathSync(join(sdk, sdkManifest.types))).isFile(), true);
  assert.deepEqual(target.requests, []);
});

test('empty-lock sync preserves an unowned node_modules directory instead of claiming or replacing it', async context => {
  const target = setup(context);
  writeLock(target.directory, {
    name: 'rulekeeper-rules',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'rulekeeper-rules', version: '1.0.0', dependencies: {} } },
  });
  const committed = lockBytes(target.directory);
  const modules = join(target.directory, 'node_modules');
  mkdirSync(modules);
  const sentinel = join(modules, 'user-file');
  writeFileSync(sentinel, 'preserve');
  target.network('offline');
  await assert.rejects(target.manager.sync(target.directory), /node_modules.*conflict/i);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
  assert.deepEqual(readdirSync(modules), ['user-file']);
  assert.equal(lockBytes(target.directory), committed);
  assert.deepEqual(target.requests, []);
});

test('sync without a committed lock does not remove a previous owned dependency installation', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const markerPath = join(target.directory, 'node_modules/.rulekeeper-install.json');
  const previousMarker = readFileSync(markerPath, 'utf8');
  rmSync(join(target.directory, 'rulekeeper.lock'));
  target.network('offline');
  assert.equal((await target.manager.sync(target.directory)).key, 'empty');
  assert.equal(await message(target.directory), POLICY_MESSAGE_V1);
  assert.equal(readFileSync(markerPath, 'utf8'), previousMarker);
  assert.equal(existsSync(join(target.directory, 'rulekeeper.lock')), false);
  assert.deepEqual(target.requests, []);
});

test('upgrades and removes are explicit transactions and removing the last package retains an empty lock', async context => {
  const target = setup(context);
  const first = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  assert.equal(await message(first.directory), POLICY_MESSAGE_V1);
  const second = await target.manager.change(target.directory, 'add', ['fixture-policy@2.0.0']);
  assert.equal(await message(second.directory), POLICY_MESSAGE_V2);
  assert.notEqual(first.key, second.key);
  assert.equal(node(readLock(target.directory), 'node_modules/fixture-shared').version, '2.0.0');
  const removed = await target.manager.change(target.directory, 'remove', ['fixture-policy']);
  assert.deepEqual(removed.directDependencies, []);
  assert.equal(removed.directory, target.directory);
  assert.equal(removed.key, 'empty');
  assert.deepEqual(Object.keys(readLock(target.directory).packages), ['']);
  assert.deepEqual(node(readLock(target.directory), '').dependencies ?? {}, {});
  assert.equal(existsSync(join(target.directory, 'node_modules/fixture-policy')), false);
});

for (const specifier of ['fixture-policy', 'fixture-policy@latest', 'fixture-policy@^1.0.0']) {
  test(`resolves ${specifier} once and saves an exact direct version`, async context => {
    const target = setup(context);
    await target.manager.change(target.directory, 'add', [specifier]);
    const expected = specifier.includes('^') ? '1.0.0' : '2.0.0';
    assert.deepEqual(node(readLock(target.directory), '').dependencies, { 'fixture-policy': expected });
  });
}

for (const invalid of [
  ['fixture-policy@1.0.0', 'fixture-policy@2.0.0'],
  ['@alex-dbs/rulekeeper'], ['npm:fixture-policy@1.0.0'], ['alias@npm:fixture-policy@1.0.0'],
  ['git+https://github.com/example/policy.git'], ['file:../policy'], ['../policy'],
  ['https://registry.npmjs.org/fixture-policy/-/fixture-policy-1.0.0.tgz'], ['workspace:*'],
]) {
  test(`rejects disallowed or duplicate direct specifications before fetching: ${invalid.join(', ')}`, async context => {
    const target = setup(context);
    await assert.rejects(target.manager.change(target.directory, 'add', invalid));
    assert.equal(existsSync(join(target.directory, 'rulekeeper.lock')), false);
    assert.deepEqual(target.requests, []);
  });
}

test('invalid removes and failed acquisition preserve the exact old lock and usable tree', async context => {
  const target = setup(context);
  const prepared = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const committed = lockBytes(target.directory);
  for (const names of [['not-declared'], ['fixture-policy@1.0.0'], ['fixture-policy', 'fixture-policy']]) {
    await assert.rejects(target.manager.change(target.directory, 'remove', names));
    assert.equal(lockBytes(target.directory), committed);
  }
  for (const specifier of ['fixture-does-not-exist', 'fixture-bad-integrity', 'fixture-peer-one', 'fixture-off-origin', 'fixture-redirect']) {
    const additions = specifier === 'fixture-peer-one' ? ['fixture-peer-one', 'fixture-peer-two'] : [specifier];
    await assert.rejects(target.manager.change(target.directory, 'add', additions));
    assert.equal(lockBytes(target.directory), committed);
    assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
    assertNoSharedTrees(target.cacheRoot);
  }
});

for (const kind of ['git', 'file', 'url', 'alias']) {
  for (const field of ['dependencies', 'optionaldependencies', 'peerdependencies']) {
    test(`rejects transitive ${kind} specifications in ${field}`, async context => {
      const target = setup(context);
      await assert.rejects(target.manager.change(target.directory, 'add', [`fixture-source-${kind}-${field}`]));
      assert.equal(existsSync(join(target.directory, 'rulekeeper.lock')), false);
      assertNoSharedTrees(target.cacheRoot);
    });
  }
}

for (const name of ['fixture-preinstall', 'fixture-install', 'fixture-postinstall', 'fixture-native', 'fixture-addon', 'fixture-shrinkwrap', 'fixture-bundled', 'fixture-hidden-bundle', 'fixture-mismatch', 'fixture-optional-unsafe-root', 'fixture-omitted-unsafe-root']) {
  test(`rejects unsupported or inconsistent package contents: ${name}`, async context => {
    const target = setup(context);
    const marker = join(dirname(target.directory), 'lifecycle-executed');
    const previous = process.env.RK_DEPENDENCY_SCRIPT_MARKER;
    process.env.RK_DEPENDENCY_SCRIPT_MARKER = marker;
    context.after(() => {
      if (previous === undefined) delete process.env.RK_DEPENDENCY_SCRIPT_MARKER;
      else process.env.RK_DEPENDENCY_SCRIPT_MARKER = previous;
    });
    await assert.rejects(target.manager.change(target.directory, 'add', [name]));
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(target.directory, 'rulekeeper.lock')), false);
    assertNoSharedTrees(target.cacheRoot);
    assert.equal(readdirSync(target.directory).some(name => name.startsWith('.rulekeeper-deps-stage-')), false);
  });
}

test('rejects a hidden bundle even when its files occupy an actual locked nested child path', async context => {
  const target = setup(context);
  // The exact direct v1 pin forces this parent's v2 dependency into its own node_modules.
  await assert.rejects(
    target.manager.change(target.directory, 'add', ['fixture-shared@1.0.0', 'fixture-hidden-locked-bundle']),
    /node_modules|bundl/i,
  );
  assert.ok(target.requests.some(request => request.kind === 'tarball' && request.path.includes('/fixture-hidden-locked-bundle/')));
  assert.equal(existsSync(join(target.directory, 'rulekeeper.lock')), false);
  assertNoSharedTrees(target.cacheRoot);
  assert.equal(existsSync(join(target.directory, 'node_modules')), false);
});

test('publisher prepare/build scripts are accepted but never run; empty maps and optional overlap normalize like npm', async context => {
  const target = setup(context);
  const marker = join(dirname(target.directory), 'publisher-build-executed');
  const previous = process.env.RK_DEPENDENCY_SCRIPT_MARKER;
  process.env.RK_DEPENDENCY_SCRIPT_MARKER = marker;
  context.after(() => {
    if (previous === undefined) delete process.env.RK_DEPENDENCY_SCRIPT_MARKER;
    else process.env.RK_DEPENDENCY_SCRIPT_MARKER = previous;
  });
  const prepared = await target.manager.change(target.directory, 'add', ['fixture-empty', 'fixture-overlap', 'fixture-prepare']);
  assert.equal(existsSync(marker), false);
  assert.ok(prepared.directory);
  assert.equal(node(readLock(target.directory), 'node_modules/fixture-shared').version, '2.0.0');
  await target.manager.sync(target.directory);
});

test('an incompatible required child omits its entire optional-only parent branch', async context => {
  const target = setup(context);
  const prepared = await target.manager.change(target.directory, 'add', ['fixture-optional-root']);
  assert.ok(prepared.directory);
  const lock = readLock(target.directory);
  assert.ok(node(lock, 'node_modules/fixture-optional-parent'));
  assert.ok(node(lock, 'node_modules/fixture-engine'));
  assert.equal(existsSync(join(prepared.directory, 'node_modules/fixture-optional-root')), true);
  assert.equal(existsSync(join(prepared.directory, 'node_modules/fixture-shared')), true);
  assert.equal(existsSync(join(prepared.directory, 'node_modules/fixture-optional-parent')), false);
  assert.equal(existsSync(join(prepared.directory, 'node_modules/fixture-engine')), false);
  const marker = JSON.parse(readFileSync(join(prepared.directory, 'node_modules/.rulekeeper-install.json'), 'utf8')) as { installedLocations: string[] };
  assert.deepEqual(marker.installedLocations.toSorted(), ['node_modules/fixture-optional-root', 'node_modules/fixture-shared']);
  const committed = lockBytes(target.directory);
  await assert.rejects(target.manager.change(target.directory, 'add', ['fixture-required-optional-root']));
  assert.equal(lockBytes(target.directory), committed);
});

for (const name of ['fixture-engine', 'fixture-platform']) {
  test(`rejects incompatible required package ${name}`, async context => {
    const target = setup(context);
    await assert.rejects(target.manager.change(target.directory, 'add', [name]));
    assert.equal(existsSync(join(target.directory, 'rulekeeper.lock')), false);
  });
}

test('a compatible optional dependency integrity failure remains fatal and preserves the committed graph', async context => {
  const target = setup(context);
  const prepared = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const committed = lockBytes(target.directory);
  await assert.rejects(target.manager.change(target.directory, 'add', ['fixture-optional-integrity-root']));
  assert.equal(lockBytes(target.directory), committed);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
  assertNoSharedTrees(target.cacheRoot);
});

const repairableLocks: readonly [string, (lock: RuleLock) => void, string][] = [
  ['missing exact direct node', lock => { delete lock.packages['node_modules/fixture-policy']; }, POLICY_MESSAGE_V1],
  ['missing transitive node', lock => { delete lock.packages['node_modules/fixture-shared']; }, POLICY_MESSAGE_V1],
  ['stale direct target', lock => { node(lock, '').dependencies = { 'fixture-policy': '2.0.0' }; }, POLICY_MESSAGE_V2],
  ['incompatible transitive target', lock => {
    const artifact = fixture.artifacts.find(value => value.manifest.name === 'fixture-shared' && value.manifest.version === '2.0.0');
    assert.ok(artifact);
    Object.assign(node(lock, 'node_modules/fixture-shared'), { version: '2.0.0', resolved: artifact.tarball, integrity: artifact.integrity });
  }, POLICY_MESSAGE_V1],
  ['unreachable safe node', lock => {
    const artifact = fixture.artifacts.find(value => value.manifest.name === 'fixture-empty');
    assert.ok(artifact);
    lock.packages['node_modules/fixture-empty'] = { version: artifact.manifest.version, resolved: artifact.tarball, integrity: artifact.integrity };
  }, POLICY_MESSAGE_V1],
  ['forged graph flags', lock => {
    Object.assign(node(lock, 'node_modules/fixture-shared'), { optional: true, dev: true, devOptional: true });
  }, POLICY_MESSAGE_V1],
];

for (const operation of ['prepare', 'sync'] as const) {
  for (const [label, corrupt, expected] of repairableLocks) {
    test(`${operation} repairs ${label}, preserves exact root declarations, and publishes the actual policy graph`, async context => {
      const target = setup(context);
      await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
      const lock = readLock(target.directory);
      corrupt(lock);
      const exactRoot = { ...node(lock, '').dependencies };
      writeLock(target.directory, lock);
      const damaged = lockBytes(target.directory);
      target.network('all');
      const repaired = await target.manager[operation](target.directory);
      assert.equal(await message(repaired.directory), expected);
      const published = readLock(target.directory);
      assert.deepEqual(node(published, '').dependencies, exactRoot);
      assert.equal(node(published, 'node_modules/fixture-policy').version, exactRoot['fixture-policy']);
      assert.ok(repaired.directory);
      const policyLocation = 'node_modules/fixture-policy';
      const requireFromPolicy = createRequire(join(repaired.directory, policyLocation, 'index.js'));
      const sharedLocation = relative(repaired.directory, dirname(requireFromPolicy.resolve('fixture-shared/package.json'))).split(sep).join('/');
      assert.equal(node(published, policyLocation).dependencies?.['fixture-shared'], exactRoot['fixture-policy']);
      assert.equal(node(published, sharedLocation).version, node(published, policyLocation).dependencies?.['fixture-shared']);
      assert.notEqual(lockBytes(target.directory), damaged);
      const committed = lockBytes(target.directory);
      target.network('offline');
      const cached = await createRuleDependencyManager({ cacheRoot: target.cacheRoot }).prepare(target.directory);
      assert.equal(cached.directory, repaired.directory);
      assert.equal(await message(cached.directory), expected);
      assert.equal(lockBytes(target.directory), committed);
      assert.deepEqual(target.requests, []);
    });
  }
}

test('failed graph repair keeps the exact committed lock and previous local package files', async context => {
  const target = setup(context);
  const previous = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const lock = readLock(target.directory);
  node(lock, '').dependencies = { 'fixture-policy': '99.0.0' };
  delete lock.packages['node_modules/fixture-policy'];
  writeLock(target.directory, lock);
  const committed = lockBytes(target.directory);
  target.network('all');
  await assert.rejects(target.manager.prepare(target.directory));
  assert.ok(target.requests.some(request => request.kind === 'metadata'));
  assert.equal(lockBytes(target.directory), committed);
  assert.equal(await message(previous.directory), POLICY_MESSAGE_V1);
  assertNoSharedTrees(target.cacheRoot);
});

test('read-only intact installations load without writes, but a missing installation cannot use a cache-only fallback', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const committed = lockBytes(target.directory);
  const mkdir = fsPromises.mkdir;
  const intercepted = context.mock.method(fsPromises, 'mkdir', (...args: Parameters<typeof fsPromises.mkdir>) => {
    if (String(args[0]) === join(target.directory, '.rulekeeper-deps-write')) {
      return Promise.reject(Object.assign(new Error('injected read-only owner'), { code: 'EACCES' }));
    }
    return mkdir(...args);
  });
  syncBuiltinESMExports();
  try {
    target.network('offline');
    const prepared = await target.manager.prepare(target.directory);
    assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
    rmSync(join(target.directory, 'node_modules/fixture-shared'), { recursive: true });
    await assert.rejects(target.manager.prepare(target.directory), { code: 'EACCES' });
    await assert.rejects(target.manager.sync(target.directory), { code: 'EACCES' });
    assert.equal(lockBytes(target.directory), committed);
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const damage of ['missing package', 'wrong version', 'package symlink', 'missing required marker location'] as const) {
  test(`automatic preparation repairs ${damage} into actual owner package files`, async context => {
    const target = setup(context);
    const original = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
    const committed = lockBytes(target.directory);
    const shared = join(target.directory, 'node_modules/fixture-shared');
    if (damage === 'wrong version') {
      const path = join(shared, 'package.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...manifest, version: '99.0.0' }));
    } else if (damage === 'missing required marker location') {
      const path = join(target.directory, 'node_modules/.rulekeeper-install.json');
      const marker = JSON.parse(readFileSync(path, 'utf8')) as { installedLocations: string[] };
      marker.installedLocations = marker.installedLocations.filter(location => location !== 'node_modules/fixture-shared');
      writeFileSync(path, JSON.stringify(marker));
    } else {
      rmSync(shared, { recursive: true });
      if (damage === 'package symlink') {
        const unowned = join(dirname(target.directory), 'unowned-package');
        mkdirSync(unowned);
        writeFileSync(join(unowned, 'preserve'), 'user data');
        symlinkSync(unowned, shared);
        context.after(() => assert.equal(readFileSync(join(unowned, 'preserve'), 'utf8'), 'user data'));
      }
    }
    target.network('offline');
    const repaired = await target.manager.prepare(target.directory);
    assert.equal(repaired.key, original.key);
    assert.equal(lockBytes(target.directory), committed);
    assert.equal(lstatSync(shared).isDirectory(), true);
    assert.equal(lstatSync(shared).isSymbolicLink(), false);
    assert.equal(await message(repaired.directory), POLICY_MESSAGE_V1);
    assertNoSharedTrees(target.cacheRoot);
  });
}

const invalidLocks: readonly [string, (lock: RuleLock) => void][] = [
  ['old lock version', lock => { lock.lockfileVersion = 2; }],
  ['missing SHA-512', lock => { delete node(lock, 'node_modules/fixture-shared').integrity; }],
  ['weak integrity', lock => { node(lock, 'node_modules/fixture-shared').integrity = 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA='; }],
  ['malformed SHA-512', lock => { node(lock, 'node_modules/fixture-shared').integrity = 'sha512-AAAA'; }],
  ['nonexact root version', lock => { node(lock, '').dependencies = { 'fixture-policy': '^1.0.0' }; }],
  ['directory link', lock => { node(lock, 'node_modules/fixture-shared').link = true; }],
  ['bundled node', lock => { node(lock, 'node_modules/fixture-shared').inBundle = true; }],
  ['off-origin URL', lock => { node(lock, 'node_modules/fixture-shared').resolved = 'https://example.invalid/package.tgz'; }],
  ['HTTP URL', lock => { node(lock, 'node_modules/fixture-shared').resolved = 'http://registry.npmjs.org/package.tgz'; }],
  ['credentialed URL', lock => { node(lock, 'node_modules/fixture-shared').resolved = 'https://secret@registry.npmjs.org/package.tgz'; }],
  ['fragment URL', lock => { node(lock, 'node_modules/fixture-shared').resolved += '#fragment'; }],
  ['nonexact node version', lock => { node(lock, 'node_modules/fixture-shared').version = '^1.0.0'; }],
  ['transitive alias', lock => { node(lock, 'node_modules/fixture-policy').dependencies = { 'fixture-shared': 'npm:fixture-shared@1.0.0' }; }],
  ['optional forbidden source', lock => { node(lock, 'node_modules/fixture-policy').optionalDependencies = { bad: 'file:../bad' }; }],
  ['peer forbidden source', lock => { node(lock, 'node_modules/fixture-policy').peerDependencies = { bad: 'git+https://github.com/example/bad' }; }],
  ['mismatched explicit name', lock => { node(lock, 'node_modules/fixture-shared').name = 'another-package'; }],
  ...['overrides', 'packageExtensions'].map((field): [string, (lock: RuleLock) => void] => [
    `graph-changing ${field}`, lock => { node(lock, 'node_modules/fixture-policy')[field] = { 'fixture-shared': '*' }; },
  ]),
  ['acceptDependencies graph bypass', lock => {
    const policy = node(lock, 'node_modules/fixture-policy');
    policy.dependencies = { 'fixture-shared': '^1.0.0' };
    policy.acceptDependencies = { 'fixture-shared': '*' };
    const artifact = fixture.artifacts.find(value => value.manifest.name === 'fixture-shared' && value.manifest.version === '2.0.0');
    assert.ok(artifact);
    Object.assign(node(lock, 'node_modules/fixture-shared'), { version: '2.0.0', resolved: artifact.tarball, integrity: artifact.integrity });
  }],
  ...['scripts', 'workspaces', 'overrides', 'devDependencies', 'optionalDependencies', 'peerDependencies'].map((field): [string, (lock: RuleLock) => void] => [
    `forbidden root ${field}`, lock => { node(lock, '')[field] = field === 'workspaces' ? ['packages/*'] : { bad: '1.0.0' }; },
  ]),
];

for (const [label, corrupt] of invalidLocks) {
  test(`prepare rejects ${label} without network or lock repair`, async context => {
    const target = setup(context);
    await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
    const lock = readLock(target.directory);
    corrupt(lock);
    writeLock(target.directory, lock);
    const committed = lockBytes(target.directory);
    target.network('offline');
    await assert.rejects(createRuleDependencyManager({ cacheRoot: join(dirname(target.directory), 'fresh-cache') }).prepare(target.directory));
    assert.equal(lockBytes(target.directory), committed);
    assert.deepEqual(target.requests, []);
  });
}

for (const location of ['../escape', '/absolute/node_modules/bad', 'node_modules/../bad', 'node_modules\\bad', 'node_modules/@scope', 'node_modules/fixture-shared/lib/node_modules/bad']) {
  test(`rejects illegal package location ${location} before acquisition`, async context => {
    const target = setup(context);
    await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
    const lock = readLock(target.directory);
    lock.packages[location] = { ...node(lock, 'node_modules/fixture-shared') };
    writeLock(target.directory, lock);
    target.network('offline');
    await assert.rejects(createRuleDependencyManager({ cacheRoot: join(dirname(target.directory), 'fresh-cache') }).prepare(target.directory));
    assert.deepEqual(target.requests, []);
    assert.equal(existsSync(join(dirname(target.directory), 'escape')), false);
  });
}

test('does not trust optional flags to hide an incompatible required edge', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const lock = readLock(target.directory);
  node(lock, 'node_modules/fixture-shared').optional = true;
  node(lock, 'node_modules/fixture-shared').engines = { node: '>=999.0.0' };
  writeLock(target.directory, lock);
  target.network('offline');
  await assert.rejects(target.manager.prepare(target.directory));
});

test('rejects malformed, symlinked and nonregular committed locks', async context => {
  const target = setup(context);
  const path = join(target.directory, 'rulekeeper.lock');
  writeFileSync(path, '{not json');
  await assert.rejects(target.manager.prepare(target.directory));
  rmSync(path);
  mkdirSync(path);
  await assert.rejects(target.manager.prepare(target.directory));
  rmSync(path, { recursive: true });
  const elsewhere = join(dirname(target.directory), 'elsewhere.lock');
  writeFileSync(elsewhere, '{}');
  symlinkSync(elsewhere, path);
  const ruleFile = join(target.directory, 'policy.rule.ts');
  writeFileSync(ruleFile, 'export default {};');
  await assert.rejects(dependencyDirectory(ruleFile));
  await assert.rejects(target.manager.prepare(target.directory));
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.equal(readFileSync(elsewhere, 'utf8'), '{}');
  assert.deepEqual(target.requests, []);
});

test('dependency ownership follows canonical rule paths and stops at the nearest .rulekeeper boundary', async context => {
  const target = setup(context);
  const nested = join(target.directory, 'nested', 'policy.rule.ts');
  mkdirSync(dirname(nested), { recursive: true });
  writeFileSync(nested, 'export default {};');
  assert.equal(await dependencyDirectory(nested), target.directory);
  const owned = join(target.directory, 'nested');
  writeFileSync(join(owned, 'rulekeeper.lock'), '{}');
  assert.equal(await dependencyDirectory(nested), owned);
  const external = join(dirname(target.directory), 'custom', 'rule.ts');
  mkdirSync(dirname(external), { recursive: true });
  writeFileSync(external, 'export default {};');
  assert.equal(await dependencyDirectory(external), dirname(external));
  writeFileSync(join(dirname(target.directory), 'rulekeeper.lock'), '{}');
  assert.equal(await dependencyDirectory(external), dirname(target.directory));
  rmSync(join(owned, 'rulekeeper.lock'));
  assert.equal(await dependencyDirectory(nested), target.directory);
  const link = join(dirname(target.directory), 'linked-rule.ts');
  symlinkSync(nested, link);
  assert.equal(await dependencyDirectory(link), target.directory);
});

test('identical locks install independent owner files and keys, sharing only download artifacts', async context => {
  const target = setup(context);
  const first = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const other = join(dirname(target.directory), 'other', '.rulekeeper');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'rulekeeper.lock'), lockBytes(target.directory));
  const second = await target.manager.prepare(other);
  assert.notEqual(second.key, first.key);
  for (const directory of [target.directory, other]) {
    assert.equal(lstatSync(join(directory, 'node_modules/fixture-policy')).isSymbolicLink(), false);
    assert.equal(await message(directory), POLICY_MESSAGE_V1);
  }
  rmSync(join(other, 'node_modules'), { recursive: true });
  rmSync(target.cacheRoot, { recursive: true, force: true });
  target.network('offline');
  await assert.rejects(target.manager.prepare(other));
  assert.equal(await message(first.directory), POLICY_MESSAGE_V1);
  assert.equal(existsSync(join(other, 'node_modules')), false);
  assertNoSharedTrees(target.cacheRoot);
});

test('concurrent first preparations publish one complete owner installation', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const committed = lockBytes(target.directory);
  rmSync(join(target.directory, 'node_modules'), { recursive: true });
  const cacheRoot = join(dirname(target.directory), 'concurrent-cache');
  target.network('tarballs');
  const results = await Promise.all(Array.from({ length: 5 }, () => createRuleDependencyManager({ cacheRoot }).prepare(target.directory)));
  assert.equal(new Set(results.map(value => value.key)).size, 1);
  for (const result of results) assert.equal(await message(result.directory), POLICY_MESSAGE_V1);
  assert.equal(lockBytes(target.directory), committed);
  assertNoSharedTrees(cacheRoot);
  assert.equal(readdirSync(target.directory).some(name => name.startsWith('.rulekeeper-deps-stage-')), false);
  target.network('offline');
  assert.equal((await target.manager.prepare(target.directory)).key, results[0]?.key);
});

test('a missing ownership marker never permits replacement of user-owned package files', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  rmSync(join(target.directory, 'node_modules/.rulekeeper-install.json'));
  const sentinel = join(target.directory, 'node_modules/user-file');
  writeFileSync(sentinel, 'preserve');
  await assert.rejects(target.manager.sync(target.directory), /node_modules|owned|conflict/i);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
  assert.equal(await message(target.directory), POLICY_MESSAGE_V1);
});

test('the real HTTPS agent rejects off-origin hosts and ports before DNS/connect, without Nock', async () => {
  nock.restore();
  const agent = new RegistryHttpsAgent();
  try {
    for (const url of ['https://example.invalid/artifact.tgz', 'https://registry.npmjs.org:444/artifact.tgz', 'https://user:secret@example.invalid/artifact.tgz']) {
      let socketAssigned = false;
      const { promise, reject } = Promise.withResolvers<void>();
      try {
        const outgoing = request(url, { agent }, response => {
          response.resume();
          reject(new Error('guard unexpectedly issued an HTTPS request'));
        });
        outgoing.on('socket', () => { socketAssigned = true; });
        outgoing.on('error', reject);
        outgoing.end();
      } catch (error) { reject(error); }
      await assert.rejects(promise, /registry|origin|host|port|forbidden|allow/i);
      assert.equal(socketAssigned, false, 'rejected URL must never acquire a socket');
    }
  } finally {
    agent.destroy();
    nock.activate();
  }
});

test('nested packages with two transitive versions survive parent-before-child extraction', async context => {
  const target = setup(context);
  const prepared = await target.manager.change(target.directory, 'add', ['fixture-second', 'fixture-policy@1.0.0']);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
  assert.ok(prepared.directory);
  // Loading an extracted package by its runtime-selected path exercises its own nested dependencies.
  const second = await import(pathToFileURL(join(prepared.directory, 'node_modules/fixture-second/index.js')).href) as { message: string };
  assert.equal(second.message, 'shared dependency 2');
  const versions = Object.entries(readLock(target.directory).packages)
    .filter(([location]) => location.endsWith('node_modules/fixture-shared'))
    .map(([, entry]) => entry.version).sort();
  assert.deepEqual(versions, ['1.0.0', '2.0.0']);
  const names = Object.keys(node(readLock(target.directory), '').dependencies ?? {});
  assert.deepEqual(names, [...names].sort());
});

test('a failed local acquisition can retry the same lock successfully', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const manager = createRuleDependencyManager({ cacheRoot: join(dirname(target.directory), 'retry-cache') });
  const committed = lockBytes(target.directory);
  rmSync(join(target.directory, 'node_modules'), { recursive: true });
  target.network('offline');
  await assert.rejects(manager.prepare(target.directory));
  target.network('tarballs');
  const prepared = await manager.prepare(target.directory);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
  assert.equal(lockBytes(target.directory), committed);
  assert.ok(target.requests.every(value => value.kind === 'tarball'));
});

test('ordinary lock nodes need not have name fields and optional peer metadata is respected', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0', 'fixture-optional-peer']);
  const lock = readLock(target.directory);
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location !== '') delete entry.name;
  }
  writeLock(target.directory, lock);
  const committed = lockBytes(target.directory);
  target.network('tarballs');
  const prepared = await createRuleDependencyManager({ cacheRoot: join(dirname(target.directory), 'unnamed-cache') }).prepare(target.directory);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
  assert.equal(lockBytes(target.directory), committed);
});

test('a syntactically valid but incorrect locked SHA-512 cannot publish a partial tree', async context => {
  const target = setup(context);
  await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const lock = readLock(target.directory);
  node(lock, 'node_modules/fixture-shared').integrity = `sha512-${createHash('sha512').update('not the locked package').digest('base64')}`;
  writeLock(target.directory, lock);
  const committed = lockBytes(target.directory);
  const cacheRoot = join(dirname(target.directory), 'invalid-integrity-cache');
  target.network('tarballs');
  await assert.rejects(createRuleDependencyManager({ cacheRoot }).prepare(target.directory));
  assertNoSharedTrees(cacheRoot);
  assert.equal(lockBytes(target.directory), committed);
});

const mismatchedFields: readonly [string, unknown][] = [
  ['name', 'different-package'],
  ['version', '2.0.0'],
  ['dependencies', { 'fixture-shared': '1.0.0' }],
  ['optionalDependencies', { 'fixture-shared': '1.0.0' }],
  ['peerDependencies', { 'fixture-shared': '1.0.0' }],
  ['peerDependenciesMeta', { 'fixture-shared': { optional: true } }],
  ['engines', { node: '>=0.0.0' }],
  ['os', [process.platform]],
  ['cpu', [process.arch]],
  ['libc', ['glibc', 'musl']],
];
for (const [field, value] of mismatchedFields) {
  test(`compares normalized extracted ${field} against the reviewed lock`, async context => {
    const manifest = { name: `fixture-mismatch-${field.toLowerCase()}`, version: '1.0.0', type: 'module', main: './index.js' };
    const definitions: readonly FixturePackage[] = [{
      manifest,
      files: {
        'package.json': JSON.stringify({ ...manifest, [field]: value }),
        'index.js': 'export const value = "unused";\n',
      },
    }];
    const registry = createDependencyFixture(join(root, `mismatch-${sequence++}`), definitions);
    const target = setup(context, registry);
    await assert.rejects(target.manager.change(target.directory, 'add', [manifest.name]));
    assert.equal(existsSync(join(target.directory, 'rulekeeper.lock')), false);
    assertNoSharedTrees(target.cacheRoot);
  });
}

test('explicit policy ignores application npmrc, npm registry overrides, tokens and generic proxy environment', async context => {
  const target = setup(context);
  writeFileSync(join(dirname(target.directory), '.npmrc'), 'registry=https://private.example.invalid/\n//registry.npmjs.org/:_authToken=must-not-leak\n');
  const overrides = {
    npm_config_registry: 'https://private.example.invalid/',
    npm_config_userconfig: join(dirname(target.directory), '.npmrc'),
    NPM_TOKEN: 'must-not-leak',
    HTTPS_PROXY: 'http://proxy.example.invalid:9999',
    HTTP_PROXY: 'http://proxy.example.invalid:9999',
    ALL_PROXY: 'http://proxy.example.invalid:9999',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(name => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  context.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const prepared = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
  assert.ok(target.requests.length > 0);
  assert.ok(target.requests.every(value => value.kind !== 'unmatched'));
});

test('a concurrent external lock edit is preserved rather than overwritten by add', async context => {
  const target = setup(context);
  const prepared = await target.manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  const external = `${lockBytes(target.directory)} \n`;
  let edited = false;
  target.network('all', incoming => {
    if (incoming.kind !== 'metadata' || edited) return;
    edited = true;
    writeFileSync(join(target.directory, 'rulekeeper.lock'), external);
  });
  await assert.rejects(target.manager.change(target.directory, 'add', ['fixture-second']));
  assert.equal(edited, true, 'the external edit must occur at the transport barrier during resolution');
  assert.equal(lockBytes(target.directory), external);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
});

test('a download cache beneath a symlink ancestor supports frozen local installation replay', async context => {
  const target = setup(context);
  const physical = join(dirname(target.directory), 'physical-cache-parent');
  const linked = join(dirname(target.directory), 'linked-cache-parent');
  mkdirSync(physical);
  symlinkSync(physical, linked, 'dir');
  const cacheRoot = join(linked, 'dependencies');
  const manager = createRuleDependencyManager({ cacheRoot });
  const prepared = await manager.change(target.directory, 'add', ['fixture-policy@1.0.0']);
  assert.equal(await message(prepared.directory), POLICY_MESSAGE_V1);
  assert.ok(prepared.directory);
  assert.equal(prepared.directory, realpathSync(prepared.directory));
  assert.equal(prepared.directory, realpathSync(target.directory));
  const lock = readLock(target.directory);
  assert.deepEqual(node(lock, '').dependencies, { 'fixture-policy': '1.0.0' });
  assert.equal(node(lock, 'node_modules/fixture-policy').version, '1.0.0');
  assert.equal(node(lock, 'node_modules/fixture-shared').version, '1.0.0');
  const committed = lockBytes(target.directory);
  rmSync(join(target.directory, 'node_modules'), { recursive: true });
  const replayCache = join(linked, 'replay-dependencies');
  target.network('tarballs');
  const replayed = await createRuleDependencyManager({ cacheRoot: replayCache }).prepare(target.directory);
  assert.equal(await message(replayed.directory), POLICY_MESSAGE_V1);
  assert.ok(replayed.directory);
  assert.equal(replayed.directory, realpathSync(replayed.directory));
  assert.equal(lockBytes(target.directory), committed);
  assert.ok(target.requests.length >= 2);
  assert.ok(target.requests.every(incoming => incoming.kind === 'tarball'));
  target.network('offline');
  const cached = await createRuleDependencyManager({ cacheRoot: replayCache }).prepare(target.directory);
  assert.equal(cached.directory, replayed.directory);
  assert.ok(cached.directory);
  assert.equal(cached.directory, realpathSync(cached.directory));
  assert.equal(await message(cached.directory), POLICY_MESSAGE_V1);
  assert.deepEqual(target.requests, []);
});
