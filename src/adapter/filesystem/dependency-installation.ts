import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdkName = '@alex-dbs/rulekeeper';
const markerName = '.rulekeeper-install.json';
interface Marker {
  readonly version: 1;
  readonly key: string;
  readonly installedLocations: readonly string[];
  readonly sdkTarget?: string;
}
interface Installation { readonly identity: string; readonly marker: Marker; readonly text: string }
function code(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
function conflict(path: string): Error {
  return new Error(`${path}: rule dependency installation conflict; preserve user files and resolve the conflict before running rulekeeper deps sync`);
}
async function stat(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error) { if (code(error) === 'ENOENT') return null; throw error; }
}
async function regularText(path: string): Promise<string | null> {
  const info = await stat(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw conflict(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw conflict(path);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function directory(path: string, create = false): Promise<boolean> {
  let info = await stat(path);
  if (!info && create) {
    try { await mkdir(path); } catch (error) { if (code(error) !== 'EEXIST') throw error; }
    info = await stat(path);
  }
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflict(path);
  return true;
}
async function installation(path: string): Promise<Installation | null> {
  if (!await directory(path)) return null;
  const markerPath = join(path, markerName);
  const text = await regularText(markerPath);
  if (text === null) throw conflict(path);
  let marker: Marker;
  try { marker = JSON.parse(text) as Marker; } catch { throw conflict(markerPath); }
  if (!marker || marker.version !== 1 || typeof marker.key !== 'string' || !/^(?:empty|[a-f0-9]{64})$/.test(marker.key)
    || !Array.isArray(marker.installedLocations) || !marker.installedLocations.every(location => typeof location === 'string'
      && /^(?:node_modules\/(?:@[^/\\]+\/)?[^/\\]+)(?:\/node_modules\/(?:@[^/\\]+\/)?[^/\\]+)*$/.test(location)
      && location.split('/').every(segment => segment !== '.' && segment !== '..'))
    || (marker.sdkTarget !== undefined && (typeof marker.sdkTarget !== 'string' || !isAbsolute(marker.sdkTarget)))) throw conflict(markerPath);
  const info = await lstat(path, { bigint: true });
  const markerInfo = await lstat(markerPath, { bigint: true });
  return { identity: `${info.dev}:${info.ino}:${markerInfo.dev}:${markerInfo.ino}`, marker, text };
}
async function unchanged(path: string, expected: Installation): Promise<boolean> {
  try {
    const actual = await installation(path);
    return actual?.identity === expected.identity && actual.text === expected.text;
  } catch { return false; }
}
function warn(onWarning: ((message: string) => void) | undefined, message: string): void {
  // A committed operation must not become a reported failure even if a warning sink throws.
  try { onWarning?.(message); } catch { /* Publication has already committed. */ }
}

export async function withRuleDependencyDirectoryLock<T>(
  ownerDirectory: string,
  action: () => Promise<T>,
  onWarning?: (message: string) => void,
): Promise<T> {
  ownerDirectory = await realpath(ownerDirectory);
  const mutex = join(ownerDirectory, '.rulekeeper-deps-write');
  const token = randomUUID();
  const owner = join(mutex, 'owner.json');
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await mkdir(mutex); break; }
    catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        let pid: unknown;
        try {
          const value: unknown = JSON.parse(await regularText(owner) ?? '{}');
          if (value && typeof value === 'object' && 'pid' in value) pid = value.pid;
        } catch { /* Owner may be publishing its record. */ }
        throw new Error(`${mutex}: dependency directory busy or stale${typeof pid === 'number' ? ` (owner PID ${pid})` : ''}; remove the mutex only after confirming its owner exited, then run rulekeeper deps sync`);
      }
      await setTimeout(50);
    }
  }
  let succeeded = false;
  try {
    await writeFile(owner, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
    const result = await action();
    succeeded = true;
    return result;
  } finally {
    let releaseError: unknown;
    try {
      const recorded = JSON.parse(await regularText(owner) ?? '{}') as { token?: unknown };
      if (recorded.token !== token) throw new Error(`${mutex}: dependency mutex ownership changed; refusing to remove another owner's mutex`);
      await rm(mutex, { recursive: true });
    } catch (error) { releaseError = error; }
    if (releaseError !== undefined && succeeded) warn(onWarning, `Rule dependencies committed, but could not release ${mutex}: ${String(releaseError)}`);
  }
}

async function packageRoot(entry: string): Promise<string> {
  let path = dirname(await realpath(entry));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name === sdkName) return path;
    } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    const above = dirname(path);
    if (above === path) throw new Error(`${entry}: cannot locate the Rulekeeper SDK package`);
    path = above;
  }
}
function sdkEntry(ownerDirectory: string): string {
  const probe = `rulekeeper-installation-sdk:${randomUUID()}`;
  const parentURL = pathToFileURL(join(ownerDirectory, '.rulekeeper-sdk.js')).href;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === probe ? nextResolve(sdkName, { ...context, parentURL, conditions: ['node', 'import'] }) : nextResolve(specifier, context);
    },
  });
  try { return fileURLToPath(import.meta.resolve(probe)); }
  finally { hook.deregister(); }
}
async function linkTarget(path: string): Promise<string | undefined> {
  if (!(await stat(path))?.isSymbolicLink()) return undefined;
  return resolve(dirname(path), await readlink(path));
}
async function localSdk(ownerDirectory: string): Promise<string> {
  const search = createRequire(pathToFileURL(join(ownerDirectory, '.rulekeeper-sdk.js'))).resolve.paths(sdkName) ?? [];
  for (const modules of search) {
    const candidate = join(modules, sdkName);
    if (!await stat(candidate)) continue;
    const markerText = await regularText(join(modules, markerName));
    if (markerText !== null) {
      let marker: Marker;
      try { marker = JSON.parse(markerText) as Marker; } catch { throw conflict(join(modules, markerName)); }
      if (marker.version === 1 && marker.sdkTarget !== undefined && await linkTarget(candidate) === marker.sdkTarget) continue;
    }
    try {
      const root = await packageRoot(sdkEntry(dirname(modules)));
      if (root === await realpath(candidate)) return root;
    } catch (error) {
      if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(code(error) ?? '')) throw error;
    }
  }
  return packageRoot(fileURLToPath(import.meta.url));
}

/** Called under the owner mutex. Only the SDK may be a generated package link. */
export async function prepareRuleDependencySdk(ownerDirectory: string, nodeModules: string): Promise<string | undefined> {
  const generated = !await directory(nodeModules);
  if (generated && nodeModules === join(ownerDirectory, 'node_modules')) {
    // Publish SDK-only ownership with its directory, so failed initialization leaves no unowned files.
    const temporary = join(ownerDirectory, `.rulekeeper-sdk-${randomUUID()}`);
    await mkdir(temporary);
    try {
      const target = await prepareRuleDependencySdk(ownerDirectory, temporary);
      if (target === undefined) throw conflict(temporary);
      const marker: Marker = { version: 1, key: 'empty', installedLocations: [], sdkTarget: target };
      await writeFile(join(temporary, markerName), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
      if (await stat(nodeModules)) throw conflict(nodeModules);
      await rename(temporary, nodeModules);
      return target;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (generated) await directory(nodeModules, true);
  const markerPath = join(nodeModules, markerName);
  const text = await regularText(markerPath);
  const owned = text === null ? null : await installation(nodeModules);
  const scope = join(nodeModules, '@alex-dbs');
  await directory(scope, true);
  const leaf = join(scope, 'rulekeeper');
  const existing = await stat(leaf);
  if (existing && (owned?.marker.sdkTarget === undefined || await linkTarget(leaf) !== owned.marker.sdkTarget)) return undefined;
  const target = await localSdk(ownerDirectory);
  if (nodeModules !== join(ownerDirectory, 'node_modules') && target.startsWith(`${join(ownerDirectory, 'node_modules')}/`)) {
    throw conflict(join(ownerDirectory, 'node_modules', sdkName));
  }
  if (!existing || await linkTarget(leaf) !== target) {
    const temporary = join(scope, `.rulekeeper-sdk-${randomUUID()}`);
    try {
      await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir');
      if (existing && await linkTarget(leaf) !== owned?.marker.sdkTarget) throw conflict(leaf);
      if (!existing && await stat(leaf)) throw conflict(leaf);
      await rename(temporary, leaf);
    } finally { await rm(temporary, { force: true }); }
  }
  // Direct SDK-only sync may operate on an unowned directory. Do not claim its user files.
  if (nodeModules === join(ownerDirectory, 'node_modules') && owned) {
    const marker: Marker = { ...owned.marker, sdkTarget: target };
    const temporary = join(nodeModules, `.rulekeeper-marker-${randomUUID()}`);
    try {
      await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
      if (!await unchanged(nodeModules, owned)) throw conflict(markerPath);
      await rename(temporary, markerPath);
    } catch (error) {
      const previousTarget = owned.marker.sdkTarget;
      if (previousTarget !== undefined && previousTarget !== target) {
        if (!await unchanged(nodeModules, owned) || await linkTarget(leaf) !== target) throw conflict(leaf);
        const restore = join(scope, `.rulekeeper-sdk-${randomUUID()}`);
        try {
          await symlink(previousTarget, restore, process.platform === 'win32' ? 'junction' : 'dir');
          if (await linkTarget(leaf) !== target) throw conflict(leaf);
          await rename(restore, leaf);
        } finally { await rm(restore, { force: true }); }
      }
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }
  return target;
}

/** Takes ownership of stage. The caller holds the owner mutex throughout publication. */
export async function publishRuleDependencyInstallation(options: {
  readonly directory: string;
  readonly stage: string;
  readonly previousLock: string | null;
  readonly nextLock: string;
  readonly onWarning?: (message: string) => void;
}): Promise<void> {
  const { directory: ownerDirectory, stage, previousLock, nextLock, onWarning } = options;
  const modules = join(ownerDirectory, 'node_modules');
  const stagedModules = join(stage, 'node_modules');
  const backup = join(stage, 'previous-node_modules');
  const lock = join(ownerDirectory, 'rulekeeper.lock');
  const temporaryLock = join(stage, 'next-rulekeeper.lock');
  let old: Installation | null = null;
  let published: Installation | null = null;
  let movedOld = false;
  if (dirname(stage) !== ownerDirectory || !await directory(stage)) throw conflict(stage);
  try {
    const next = await installation(stagedModules);
    if (!next) throw conflict(stagedModules);
    if (await regularText(lock) !== previousLock) throw conflict(lock);
    old = await installation(modules);
    if (await stat(backup)) throw conflict(backup);
    if (nextLock !== previousLock) await writeFile(temporaryLock, nextLock, { flag: 'wx' });
    if (old) {
      if (!await unchanged(modules, old)) throw conflict(modules);
      await rename(modules, backup);
      movedOld = true;
    }
    if (await stat(modules)) throw conflict(modules);
    await rename(stagedModules, modules);
    published = next;
    if (!await unchanged(modules, published)) throw conflict(modules);
    if (await regularText(lock) !== previousLock) throw conflict(lock);
    if (nextLock !== previousLock) await rename(temporaryLock, lock);
  } catch (error) {
    try {
      if (published) {
        if (!await unchanged(modules, published)) throw conflict(modules);
        await rename(modules, stagedModules);
      }
      if (movedOld) {
        if (await stat(modules) || !old || !await unchanged(backup, old)) throw conflict(modules);
        await rename(backup, modules);
      }
    } catch (rollbackError) {
      throw new Error(`${String(error)}; could not restore the previous installation: ${String(rollbackError)}. Preserved recovery files at ${stage}; resolve the conflict and run rulekeeper deps sync`, { cause: error });
    }
    try { await rm(stage, { recursive: true, force: true }); }
    catch (cleanupError) { warn(onWarning, `Could not clean failed rule dependency stage ${stage}: ${String(cleanupError)}`); }
    throw error;
  }
  try { await rm(stage, { recursive: true, force: true }); }
  catch (error) { warn(onWarning, `Rule dependencies committed, but could not clean ${stage}: ${String(error)}`); }
}
