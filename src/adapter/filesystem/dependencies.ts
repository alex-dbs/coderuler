import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { Agent } from 'node:https';
import type { ClientRequest, RequestOptions } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Arborist from '@npmcli/arborist';
import PackageJson from '@npmcli/package-json';
import { currentEnv } from 'npm-install-checks';
import npa from 'npm-package-arg';
import pacote from 'pacote';
import { parse as parseIntegrity } from 'ssri';
import { prepareRuleDependencySdk, publishRuleDependencyInstallation, withRuleDependencyDirectoryLock } from './dependency-installation.js';

export interface PreparedRuleDependencies {
  readonly directory: string;
  readonly directDependencies: readonly string[];
  readonly key: string;
}

export interface RuleDependencyManager {
  prepare(directory: string): Promise<PreparedRuleDependencies>;
  change(directory: string, operation: 'add' | 'remove', packages: readonly string[]): Promise<PreparedRuleDependencies & { readonly directVersions: Readonly<Record<string, string>> }>;
  sync(directory: string): Promise<PreparedRuleDependencies>;
}

const registry = 'https://registry.npmjs.org/';
const lockName = 'rulekeeper.lock';
const sdkName = '@alex-dbs/rulekeeper';
const markerName = '.rulekeeper-install.json';
const rootIdentity = { name: 'rulekeeper-rules', version: '1.0.0' };
const forbiddenRootFields = ['scripts', 'workspaces', 'overrides', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'];
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const compatibilityFields = ['engines', 'os', 'cpu', 'libc'] as const;

type Manifest = Record<string, unknown>;
interface Lock {
  readonly lockfileVersion: number;
  readonly packages: Record<string, Manifest>;
}
interface Snapshot {
  readonly text: string;
  readonly lock: Lock;
  readonly direct: Record<string, string>;
  readonly key: string;
}
interface Installation {
  readonly snapshot: Snapshot;
  readonly stage: string;
}

function code(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function object(value: unknown, label: string): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Manifest;
}

function packageName(name: string): void {
  const parsed = npa(name);
  if (parsed.name !== name || !parsed.registry || parsed.rawSpec !== '*') throw new Error(`Invalid dependency name ${JSON.stringify(name)}`);
}

function exactVersion(name: string, value: unknown): string {
  if (typeof value !== 'string') throw new Error(`${name}: an exact package version is required`);
  const spec = npa.resolve(name, value);
  if (spec.type !== 'version' || spec.fetchSpec !== value) throw new Error(`${name}: an exact package version is required`);
  return value;
}

function hasBundledDependencies(value: unknown): boolean {
  return value !== undefined && value !== false && (!Array.isArray(value) || value.length > 0);
}

function dependencyMap(manifest: Manifest, field: string, label: string): Record<string, string> {
  const value = manifest[field];
  if (value === undefined) return {};
  const result: Record<string, string> = Object.create(null);
  for (const [name, specifier] of Object.entries(object(value, `${label} ${field}`))) {
    packageName(name);
    if (typeof specifier !== 'string') throw new Error(`${label}: invalid ${field} specification for ${name}`);
    const parsed = npa.resolve(name, specifier);
    if (!parsed.registry || !['version', 'range', 'tag'].includes(parsed.type)) {
      throw new Error(`${label}: unsupported dependency source for ${name}; only public npm registry packages are supported`);
    }
    result[name] = specifier;
  }
  return result;
}

function locationName(location: string): string {
  const parts = location.split('/');
  let name = '';
  for (let index = 0; index < parts.length;) {
    if (parts[index++] !== 'node_modules') throw new Error(`Invalid lock package location ${JSON.stringify(location)}`);
    const part = parts[index++];
    if (!part) throw new Error(`Invalid lock package location ${JSON.stringify(location)}`);
    name = part.startsWith('@') ? `${part}/${parts[index++] ?? ''}` : part;
    packageName(name);
  }
  if (!name || location.includes('\\')) throw new Error(`Invalid lock package location ${JSON.stringify(location)}`);
  return name;
}

function validateIntegrity(value: unknown, label: string): void {
  if (typeof value !== 'string') throw new Error(`${label}: missing SHA-512 integrity`);
  const parsed = parseIntegrity(value, { strict: true });
  if (!parsed?.sha512?.length || parsed.sha512.some(hash => Buffer.from(hash.digest, 'base64').length !== 64)) {
    throw new Error(`${label}: invalid SHA-512 integrity`);
  }
}

function validateUrl(value: unknown, label: string): void {
  if (typeof value !== 'string') throw new Error(`${label}: missing locked npm tarball URL`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label}: invalid locked npm tarball URL`); }
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.hash) {
    throw new Error(`${label}: tarballs must use https://registry.npmjs.org without credentials or fragments`);
  }
}

function validateLock(text: string, directory: string): Snapshot {
  let parsed: Manifest;
  try { parsed = object(JSON.parse(text) as unknown, 'Rule dependency lock'); }
  catch (error) { throw new Error('Invalid rulekeeper.lock JSON; regenerate it with rulekeeper deps add', { cause: error }); }
  if (parsed.lockfileVersion !== 3) throw new Error('rulekeeper.lock must use npm lockfileVersion 3');
  const packages = object(parsed.packages, 'rulekeeper.lock packages') as Record<string, Manifest>;
  const root = object(packages[''], 'rulekeeper.lock root package');
  if (parsed.name !== rootIdentity.name || parsed.version !== rootIdentity.version || root.name !== rootIdentity.name || root.version !== rootIdentity.version) {
    throw new Error('rulekeeper.lock must use the rulekeeper-rules@1.0.0 root identity');
  }
  for (const field of forbiddenRootFields) {
    if (root[field] !== undefined || parsed[field] !== undefined) throw new Error(`rulekeeper.lock root ${field} is not supported`);
  }
  for (const field of Object.keys(root)) {
    if (!['name', 'version', 'dependencies'].includes(field)) throw new Error(`rulekeeper.lock root ${field} is not supported`);
  }
  const direct = dependencyMap(root, 'dependencies', 'rulekeeper.lock root');
  for (const [name, version] of Object.entries(direct)) {
    if (name === sdkName) throw new Error(`${sdkName}: the SDK comes from the selected Rulekeeper installation`);
    exactVersion(name, version);
  }
  for (const [location, unknownEntry] of Object.entries(packages)) {
    if (location === '') continue;
    const name = locationName(location);
    const entry = object(unknownEntry, `rulekeeper.lock ${location}`);
    exactVersion(name, entry.version);
    if (entry.name !== undefined && entry.name !== name) throw new Error(`${name}: package aliases are unsupported`);
    for (const field of ['acceptDependencies', 'overrides', 'workspaces', 'packageExtensions', 'packageExtensionsHash', 'npmExtensionHash']) {
      if (entry[field] !== undefined) throw new Error(`${name}: unsupported graph metadata ${field}`);
    }
    if (entry.link || entry.inBundle || hasBundledDependencies(entry.bundleDependencies) || hasBundledDependencies(entry.bundledDependencies) || entry.hasShrinkwrap || entry.patched || entry.packageExtensionsApplied || entry.npmExtensionApplied) {
      throw new Error(`${name}: linked, bundled and shrinkwrapped packages are unsupported`);
    }
    if (entry.hasInstallScript) throw new Error(`${name}: install scripts are unsupported; choose a package without install-time build artifacts`);
    validateIntegrity(entry.integrity, name);
    validateUrl(entry.resolved, name);
    for (const field of dependencyFields) dependencyMap(entry, field, name);
    if (entry.peerDependenciesMeta !== undefined) {
      for (const [peer, metadata] of Object.entries(object(entry.peerDependenciesMeta, `${name} peerDependenciesMeta`))) {
        packageName(peer);
        const peerMetadata = object(metadata, `${name} peer metadata for ${peer}`);
        if (peerMetadata.optional !== undefined && typeof peerMetadata.optional !== 'boolean') throw new Error(`${name}: invalid optional peer metadata for ${peer}`);
      }
    }
    if (entry.engines !== undefined) {
      if (Object.values(object(entry.engines, `${name} engines`)).some(value => typeof value !== 'string')) throw new Error(`${name}: invalid engines metadata`);
    }
    for (const field of ['os', 'cpu', 'libc']) {
      const value = entry[field];
      if (value !== undefined && typeof value !== 'string' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new Error(`${name}: invalid ${field} metadata`);
    }
  }
  return { text, lock: { lockfileVersion: 3, packages }, direct, key: ruleDependencyLockKey(parsed, directory) };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function ruleDependencyLockKey(parsed: Manifest | null, directory: string): string {
  if (parsed === null) return 'empty';
  const packages = object(parsed.packages, 'rulekeeper.lock packages');
  const root = object(packages[''], 'rulekeeper.lock root package');
  if (Object.keys(packages).length === 1 && Object.keys(dependencyMap(root, 'dependencies', 'rulekeeper.lock root')).length === 0) return 'empty';
  return createHash('sha256').update(JSON.stringify([
    canonicalJson(parsed), directory, 1, process.version, process.platform, process.arch, currentEnv.libc(process.platform) ?? '',
  ])).digest('hex');
}

export async function readRuleDependencyLock(directory: string): Promise<string | null> {
  const path = join(directory, lockName);
  let handle;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path}: dependency lock must be a regular, non-symlinked file`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw new Error(`${path}: dependency lock must be a regular file`);
    return await handle.readFile('utf8');
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

async function ensureDependencyIgnore(directory: string): Promise<void> {
  const path = join(directory, '.gitignore');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path}: dependency ignore must be a regular, non-symlinked file`);
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
  const handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${path}: dependency ignore must be a regular file`);
    const text = await handle.readFile('utf8');
    if (/^\/?node_modules\/?\r?$/m.test(text)) return;
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    await handle.writeFile(`${text.length > 0 && !text.endsWith('\n') ? newline : ''}/node_modules/${newline}`);
  } finally { await handle.close(); }
}

export async function dependencyDirectory(ruleFile: string): Promise<string> {
  const initial = dirname(await realpath(ruleFile));
  let directory = initial;
  for (;;) {
    if (await readRuleDependencyLock(directory) !== null || basename(directory) === '.rulekeeper') return directory;
    const parent = dirname(directory);
    if (parent === directory) return initial;
    directory = parent;
  }
}

export class RegistryHttpsAgent extends Agent {
  addRequest(request: ClientRequest, options: RequestOptions): void {
    const host = options.hostname ?? options.host;
    if (host !== 'registry.npmjs.org' || (options.protocol !== undefined && options.protocol !== 'https:') || (options.port !== undefined && String(options.port) !== '443')) {
      throw new Error('Rule dependency transport permits only https://registry.npmjs.org:443');
    }
    const prototype = Agent.prototype as unknown as { addRequest(request: ClientRequest, options: RequestOptions): void };
    prototype.addRequest.call(this, request, options);
  }
}

const agent = new RegistryHttpsAgent();
const policy = {
  registry, allowGit: 'none', allowRemote: 'none', allowFile: 'none', allowDirectory: 'none', allowRegistry: 'all',
  ignoreScripts: true, strictSSL: true, replaceRegistryHost: 'never', agent, proxy: null, noProxy: '*',
  binLinks: false, audit: false, fund: false, workspacesEnabled: false, lockfileVersion: 3,
};

function rootPackage(direct: Record<string, string>): Manifest {
  return { ...rootIdentity, dependencies: Object.fromEntries(Object.entries(direct).sort(([a], [b]) => a.localeCompare(b))) };
}

function emptyLock(): string {
  return `${JSON.stringify({ ...rootIdentity, lockfileVersion: 3, requires: true, packages: { '': rootPackage({}) } }, null, 2)}\n`;
}

async function stageLock(path: string, snapshot: Snapshot): Promise<void> {
  await writeFile(join(path, 'package.json'), `${JSON.stringify(rootPackage(snapshot.direct), null, 2)}\n`);
  await writeFile(join(path, 'package-lock.json'), snapshot.text);
}

async function inspectArtifacts(directory: string, label: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === 'node_modules') {
      throw new Error(`${label}: unsupported package artifact node_modules; bundled dependencies are unsupported`);
    }
    if (entry.name === 'binding.gyp' || entry.name.endsWith('.node') || entry.name === 'npm-shrinkwrap.json') {
      throw new Error(`${label}: unsupported package artifact ${entry.name}; install-time builds, native addons, bundled dependencies and shrinkwraps are unsupported`);
    }
    if (entry.isDirectory()) await inspectArtifacts(path, label);
  }
}

function comparable(manifest: Manifest, field: string): unknown {
  if (dependencyFields.includes(field as typeof dependencyFields[number]) || field === 'peerDependenciesMeta') return manifest[field] ?? {};
  const value = manifest[field];
  if (value && typeof value === 'object' && Object.keys(value).length === 0) return undefined;
  return value;
}

async function validateExtracted(directory: string, location: string, locked: Manifest): Promise<void> {
  const name = locationName(location);
  let raw: Manifest;
  try { raw = object(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as unknown, `${name} package.json`); }
  catch (error) { throw new Error(`${name}: invalid extracted package.json`, { cause: error }); }
  const scripts = raw.scripts === undefined ? {} : object(raw.scripts, `${name} scripts`);
  if (['preinstall', 'install', 'postinstall'].some(script => Object.hasOwn(scripts, script))) {
    throw new Error(`${name}: install scripts are unsupported; choose a package without install-time build artifacts`);
  }
  if (hasBundledDependencies(raw.bundleDependencies) || hasBundledDependencies(raw.bundledDependencies)) throw new Error(`${name}: bundled dependencies are unsupported`);
  await inspectArtifacts(directory, name);
  const normalized = await new PackageJson().fromContent(structuredClone(raw)).normalize({ steps: PackageJson.normalizeSteps.filter(step => step !== '_attributes') });
  const manifest = normalized.content;
  for (const field of dependencyFields) dependencyMap(manifest, field, name);
  if (manifest.name !== name || manifest.version !== locked.version) throw new Error(`${name}: extracted package name or version does not match rulekeeper.lock`);
  for (const field of [...dependencyFields, 'peerDependenciesMeta', ...compatibilityFields]) {
    if (!isDeepStrictEqual(comparable(manifest, field), comparable(locked, field))) throw new Error(`${name}: extracted ${field} does not match rulekeeper.lock`);
  }
}

async function regularDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function installedLocally(directory: string, snapshot: Snapshot): Promise<boolean> {
  try {
    const modules = join(directory, 'node_modules');
    if (!await regularDirectory(modules)) return false;
    const markerPath = join(modules, markerName);
    const stat = await lstat(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const marker = object(JSON.parse(await readFile(markerPath, 'utf8')) as unknown, 'Rule dependency installation marker');
    if (marker.version !== 1 || marker.key !== snapshot.key || !Array.isArray(marker.installedLocations)) return false;
    const locations = new Set<string>();
    for (const location of marker.installedLocations) {
      if (typeof location !== 'string' || !location || !snapshot.lock.packages[location] || locations.has(location)) return false;
      locations.add(location);
      let path = directory;
      for (const segment of location.split('/')) {
        path = join(path, segment);
        if (!await regularDirectory(path)) return false;
      }
      const packagePath = join(path, 'package.json');
      const packageStat = await lstat(packagePath);
      if (!packageStat.isFile() || packageStat.isSymbolicLink()) return false;
      const manifest = object(JSON.parse(await readFile(packagePath, 'utf8')) as unknown, packagePath);
      if (manifest.name !== locationName(location) || manifest.version !== snapshot.lock.packages[location]!.version) return false;
    }
    // Completion metadata cannot hide a missing direct or required transitive package.
    for (const location of ['', ...locations]) {
      const manifest = snapshot.lock.packages[location]!;
      const optional = manifest.optionalDependencies ?? {};
      const required = new Set(Object.keys(manifest.dependencies ?? {}).filter(name => !Object.hasOwn(optional, name)));
      const peerMetadata = manifest.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined;
      for (const name of Object.keys(manifest.peerDependencies ?? {})) {
        if (!peerMetadata?.[name]?.optional) required.add(name);
      }
      for (const name of required) {
        let parent = location;
        let found = false;
        for (;;) {
          if (locations.has(`${parent ? `${parent}/` : ''}node_modules/${name}`)) { found = true; break; }
          if (!parent) break;
          const split = parent.lastIndexOf('/node_modules/');
          parent = split < 0 ? '' : parent.slice(0, split);
        }
        if (!found) return false;
      }
    }
    return true;
  } catch (error) {
    if (code(error) && !['ENOENT', 'ENOTDIR'].includes(code(error)!)) throw error;
    return false;
  }
}

async function install(directory: string, cacheRoot: string, previous: Snapshot, request?: { readonly add?: readonly string[]; readonly rm?: readonly string[] }): Promise<Installation> {
  const stage = await realpath(await mkdtemp(join(directory, '.rulekeeper-deps-stage-')));
  try {
    let snapshot = previous;
    let expected: string[] = [];
    // An explicitly empty lock needs only an SDK installation, not npm graph work.
    if (request || previous.key !== 'empty') {
      await stageLock(stage, previous);
      const arborist = new Arborist({ ...policy, engineStrict: true, savePrefix: '', path: stage, cache: join(cacheRoot, 'tarballs') });
      const tree = await arborist.buildIdealTree(request);
      const exact: Record<string, string> = Object.create(null);
      for (const name of Object.keys(dependencyMap(tree.package, 'dependencies', 'resolved root')).sort()) {
        const edge = tree.edgesOut.get(name);
        if (!edge?.to || !edge.valid) throw new Error(`${name}: resolution did not produce a compatible direct package`);
        exact[name] = exactVersion(name, edge.to.version);
        if (!request && exact[name] !== previous.direct[name]) throw new Error(`${name}: repair changed an exact direct dependency`);
      }
      tree.package = rootPackage(exact);
      tree.meta.add(tree);
      const serialized = `${JSON.stringify(JSON.parse(tree.meta.toString()) as unknown, null, 2)}\n`;
      snapshot = validateLock(isDeepStrictEqual(JSON.parse(previous.text), JSON.parse(serialized)) ? previous.text : serialized, directory);
      const nodes = [...tree.inventory.values()].filter(node => node.location).map(node => ({ location: node.location, omitted: node.inert }));
      expected = nodes.filter(node => !node.omitted).map(node => node.location);
      for (const node of tree.inventory.values()) {
        for (const edge of node.edgesOut.values()) {
          if (!edge.valid && !(edge.peer && edge.optional && !edge.to)) {
            throw new Error(`${node.location || 'rulekeeper.lock root'}: package resolution failed for dependency ${edge.name}`);
          }
        }
      }
      for (const node of nodes) {
        const entry = snapshot.lock.packages[node.location]!;
        const audit = await mkdtemp(join(stage, '.audit-'));
        try {
          // Inspect each raw artifact in isolation, including npm's omitted optional branches.
          await pacote.extract(entry.resolved as string, audit, { ...policy, allowRemote: 'all', integrity: entry.integrity, cache: join(cacheRoot, 'tarballs') });
          await validateExtracted(audit, node.location, entry);
        } finally { await rm(audit, { recursive: true, force: true }); }
      }
      await writeFile(join(stage, 'package.json'), `${JSON.stringify(rootPackage(exact), null, 2)}\n`);
      const actual = await arborist.reify({ save: false });
      for (const location of expected) {
        if (!actual.inventory.get(location) || !await pathExists(join(stage, location))) {
          throw new Error(`${locationName(location)}: locked package acquisition failed; run rulekeeper deps sync after correcting the package or cache`);
        }
      }
    }
    const modules = join(stage, 'node_modules');
    await mkdir(modules, { recursive: true });
    const sdkTarget = await prepareRuleDependencySdk(directory, modules);
    await writeFile(join(modules, markerName), `${JSON.stringify({
      version: 1, key: snapshot.key, installedLocations: expected.sort(),
      ...(sdkTarget === undefined ? {} : { sdkTarget }),
    }, null, 2)}\n`);
    return { snapshot, stage };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function prepared(directory: string, snapshot: Snapshot | null): PreparedRuleDependencies {
  return {
    directory,
    directDependencies: Object.keys(snapshot?.direct ?? {}).sort(), key: snapshot?.key ?? 'empty',
  };
}

function parsedPackages(operation: 'add' | 'remove', packages: readonly string[]): string[] {
  if (packages.length === 0) throw new Error(`rulekeeper deps ${operation} requires at least one package`);
  const names = new Set<string>();
  return packages.map(value => {
    const parsed = npa(value);
    if (!parsed.name || !parsed.registry || !['version', 'range', 'tag'].includes(parsed.type)) throw new Error(`${JSON.stringify(value)}: only public npm package names, versions, ranges and tags are supported`);
    const name = parsed.name;
    if (operation === 'remove' && value !== name) throw new Error(`${JSON.stringify(value)}: remove requires an unversioned direct package name`);
    if (name === sdkName) throw new Error(`${sdkName}: the SDK comes from the selected Rulekeeper installation`);
    if (names.has(name)) throw new Error(`${name}: duplicate package in dependency command`);
    names.add(name);
    return value;
  });
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (code(error) === 'ENOENT') return false; throw error; }
}

export function createRuleDependencyManager(options: {
  readonly cacheRoot?: string;
  readonly onWarning?: (message: string) => void;
} = {}): RuleDependencyManager {
  const cacheRoot = resolve(options.cacheRoot ?? join(homedir(), '.cache', 'rulekeeper', 'dependencies'));
  const snapshotAt = async (directory: string): Promise<Snapshot | null> => {
    const text = await readRuleDependencyLock(directory);
    try { return text === null ? null : validateLock(text, directory); }
    catch (error) {
      const detail = error instanceof Error ? error.message : 'invalid lock contents';
      throw new Error(`${join(directory, lockName)}: ${detail}; use rulekeeper deps add to regenerate the lock`, { cause: error });
    }
  };
  const publish = async (directory: string, previousLock: string | null, installation: Installation): Promise<PreparedRuleDependencies> => {
    try {
      if (await readRuleDependencyLock(directory) !== previousLock) throw new Error(`${join(directory, lockName)}: dependency lock changed during installation; rerun rulekeeper deps sync`);
      await ensureDependencyIgnore(directory);
    } catch (error) {
      await rm(installation.stage, { recursive: true, force: true });
      throw error;
    }
    // Publication takes ownership of staging, including any rollback backup.
    await publishRuleDependencyInstallation({
      directory, stage: installation.stage, previousLock, nextLock: installation.snapshot.text,
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    });
    return prepared(directory, installation.snapshot);
  };
  const prepare = async (input: string, explicit: boolean): Promise<PreparedRuleDependencies> => {
    const directory = await realpath(input);
    if (!explicit && !await pathExists(join(directory, '.rulekeeper-deps-write'))) {
      const snapshot = await snapshotAt(directory);
      if ((!snapshot || snapshot.key === 'empty' || await installedLocally(directory, snapshot))
        && !await pathExists(join(directory, '.rulekeeper-deps-write'))
        && await readRuleDependencyLock(directory) === (snapshot?.text ?? null)) return prepared(directory, snapshot);
    }
    return withRuleDependencyDirectoryLock(directory, async () => {
      const snapshot = await snapshotAt(directory);
      if (!snapshot) {
        if (explicit) await prepareRuleDependencySdk(directory, join(directory, 'node_modules'));
        return prepared(directory, snapshot);
      }
      if (snapshot.key === 'empty' && !explicit) return prepared(directory, snapshot);
      if (await installedLocally(directory, snapshot)) {
        if (explicit) {
          await prepareRuleDependencySdk(directory, join(directory, 'node_modules'));
          await ensureDependencyIgnore(directory);
        }
        return prepared(directory, snapshot);
      }
      return publish(directory, snapshot.text, await install(directory, cacheRoot, snapshot));
    }, options.onWarning);
  };
  return {
    prepare: directory => prepare(directory, false),
    sync: directory => prepare(directory, true),
    async change(input, operation, requested) {
      const packages = parsedPackages(operation, requested);
      if (operation === 'add') await mkdir(input, { recursive: true });
      const directory = await realpath(input);
      return withRuleDependencyDirectoryLock(directory, async () => {
        const previous = await readRuleDependencyLock(directory);
        const snapshot = validateLock(previous ?? emptyLock(), directory);
        if (operation === 'remove') {
          for (const name of packages) if (!Object.hasOwn(snapshot.direct, name)) throw new Error(`${name}: not a declared direct dependency`);
        }
        const installation = await install(directory, cacheRoot, snapshot, operation === 'add' ? { add: packages } : { rm: packages });
        const result = await publish(directory, previous, installation);
        return { ...result, directVersions: installation.snapshot.direct };
      }, options.onWarning);
    },
  };
}
