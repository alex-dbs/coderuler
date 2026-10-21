import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import npa from 'npm-package-arg';

import { ruleDependencyLockKey } from './dependencies.js';
import type { PreparedRuleDependencies } from './dependencies.js';

const SDK = '@alex-dbs/rulekeeper';
const SDK_ENTRY = new URL(import.meta.url.endsWith('.ts') ? '../../index.ts' : '../../index.js', import.meta.url).href;
// This prevents accidental ambient dependency borrowing, not deliberate escape:
// trusted rule code can still use Node APIs, absolute paths, or custom loaders.
const contexts = new Map<string, PreparedRuleDependencies>();
const commonJSDirectories = new Map<string, string>();
const sdkModules = new Set<string>();
const requireFromHere = createRequire(import.meta.url);

type Manifest = Record<string, unknown>;
interface ManagedPackage {
  readonly root: string;
  readonly name: string;
  readonly declarations: ReadonlySet<string>;
}
interface Installation {
  readonly dependencies: PreparedRuleDependencies;
  readonly marker: string;
  readonly root: string;
  readonly packages: readonly ManagedPackage[];
  readonly require: NodeJS.Require;
  readonly parentURL: string;
}
interface ImportScope {
  readonly parentURL: string;
  readonly require: NodeJS.Require;
  readonly metadata: string;
  readonly sourceMetadata: string;
  readonly denied: ReadonlyMap<string, string>;
  readonly sourceRoots: readonly string[];
}
const ownerKeys = new Map<string, string>();
const installations = new Map<string, Installation>();
const importScopes = new Map<string, ImportScope>();
const temporaryScopes = new Set<string>();

function record(value: unknown, label: string): Manifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Manifest;
}

function json(path: string): Manifest {
  return record(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}

function inside(root: string, filename: string): boolean {
  const path = relative(root, filename);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function filename(url: string | undefined): string | undefined {
  if (!url?.startsWith('file:')) return undefined;
  const path = fileURLToPath(url);
  try { return realpathSync(path); }
  catch (error) {
    // createRequire's synthetic parent need not exist on disk.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw error;
  }
}

function nameOf(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
}

function bare(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('#') && !isAbsolute(specifier) && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);
}

function contextKey(dependencies: PreparedRuleDependencies): string {
  return `${dependencies.directory}\0${dependencies.key}`;
}

function stale(dependencies: PreparedRuleDependencies, detail: string): Error {
  return new Error(`Rule dependencies changed or installation is in progress in ${dependencies.directory}: ${detail}; rerun the command after rulekeeper deps sync completes. If the write mutex is stale, remove it only after confirming its owner exited`);
}

function regularText(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error(`Not a regular, non-symlinked file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Not a regular file: ${path}`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function assertIdle(dependencies: PreparedRuleDependencies): void {
  const mutex = join(dependencies.directory, '.rulekeeper-deps-write');
  try { lstatSync(mutex); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw stale(dependencies, mutex);
  }
  throw stale(dependencies, mutex);
}

function snapshot(dependencies: PreparedRuleDependencies): { readonly lock: Manifest; readonly marker: Manifest } | undefined {
  const registeredKey = ownerKeys.get(dependencies.directory);
  if (registeredKey !== undefined && registeredKey !== dependencies.key) throw stale(dependencies, 'this process already loaded a different dependency snapshot for this owner');
  assertIdle(dependencies);
  try {
    let text: string | null = null;
    try { text = regularText(join(dependencies.directory, 'rulekeeper.lock')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const lock = text === null ? null : record(JSON.parse(text), 'rule dependency lock');
    if (ruleDependencyLockKey(lock, dependencies.directory) !== dependencies.key) throw new Error('committed lock no longer matches the prepared context');
    if (dependencies.key === 'empty') {
      if (dependencies.directDependencies.length !== 0) throw new Error('empty context has declared packages');
      assertIdle(dependencies);
      return undefined;
    }
    const packages = record(lock!['packages'], 'rule dependency lock packages');
    const direct = Object.keys(record(record(packages[''], 'root package')['dependencies'] ?? {}, 'direct dependencies')).sort();
    if (JSON.stringify(direct) !== JSON.stringify([...dependencies.directDependencies].sort())) throw new Error('direct dependencies no longer match');
    const modules = join(dependencies.directory, 'node_modules');
    if (!lstatSync(modules).isDirectory() || realpathSync(modules) !== modules) throw new Error(`invalid local package directory ${modules}`);
    const marker = record(JSON.parse(regularText(join(dependencies.directory, 'node_modules', '.rulekeeper-install.json'))), 'rule dependency installation marker');
    if (marker['version'] !== 1 || marker['key'] !== dependencies.key || !Array.isArray(marker['installedLocations'])) throw new Error('local installation marker no longer matches');
    if (direct.some(name => !(marker['installedLocations'] as unknown[]).includes(`node_modules/${name}`))) throw new Error('local installation omits a direct dependency');
    const installed = installations.get(contextKey(dependencies));
    if (installed !== undefined && installed.marker !== JSON.stringify(marker)) throw new Error('local installation metadata changed during this command');
    assertIdle(dependencies);
    return { lock: lock!, marker };
  } catch (error) {
    throw stale(dependencies, error instanceof Error ? error.message : String(error));
  }
}

export function assertRuleDependenciesCurrent(dependencies: PreparedRuleDependencies): void {
  snapshot(dependencies);
}

function installationFor(dependencies: PreparedRuleDependencies): Installation | undefined {
  const current = snapshot(dependencies);
  if (current === undefined) return undefined;
  const key = contextKey(dependencies);
  const existing = installations.get(key);
  if (existing !== undefined) return existing;
  const root = join(dependencies.directory, 'node_modules');
  const packages = record(current.lock['packages'], 'rule dependency lock packages');
  const installed: ManagedPackage[] = [];
  for (const location of current.marker['installedLocations'] as unknown[]) {
    if (typeof location !== 'string' || !/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(location)) {
      throw stale(dependencies, 'invalid installed package location');
    }
    const packageRoot = join(dependencies.directory, location);
    if (!inside(root, packageRoot) || realpathSync(packageRoot) !== packageRoot) throw stale(dependencies, `invalid package directory ${packageRoot}`);
    const manifest = record(packages[location], `lock package ${location}`);
    const declarations = new Set<string>();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (manifest[field] !== undefined) {
        for (const name of Object.keys(record(manifest[field], `${location} ${field}`))) declarations.add(name);
      }
    }
    const segments = location.split('/');
    const last = segments.at(-1)!;
    const scope = segments.at(-2)!;
    const name = scope.startsWith('@') ? `${scope}/${last}` : last;
    const actual = json(join(packageRoot, 'package.json'));
    if (actual['name'] !== name || actual['version'] !== manifest['version']) throw stale(dependencies, `package ${name} does not match the lock`);
    installed.push({ root: packageRoot, name, declarations });
  }
  installed.sort((left, right) => right.root.length - left.root.length);
  // Node stops package-scope/self-reference lookup at node_modules. Keep the
  // synthetic parent there so an ancestor application's exports cannot shadow
  // a declared dependency; Node still performs normal package/exports lookup.
  const parentURL = pathToFileURL(join(root, '.rulekeeper-resolve.cjs')).href;
  const installation = { dependencies, marker: JSON.stringify(current.marker), root, packages: installed, require: createRequire(parentURL), parentURL };
  installations.set(key, installation);
  return installation;
}

function managedPackage(installation: Installation, path: string): ManagedPackage | undefined {
  return installation.packages.find(pkg => inside(pkg.root, path));
}

function packageContext(path: string): { readonly installation: Installation; readonly pkg: ManagedPackage } | undefined {
  for (const installation of installations.values()) {
    if (!inside(installation.root, path)) continue;
    assertRuleDependenciesCurrent(installation.dependencies);
    const pkg = managedPackage(installation, path);
    if (pkg !== undefined) return { installation, pkg };
  }
  return undefined;
}

function conflict(path: string): Error {
  return new Error(`Rule helper ${path} has conflicting dependency contexts; use separate helper directories for rules with different locks`);
}

function reserveCommonJS(path: string, dependencies: PreparedRuleDependencies): void {
  const directory = dirname(path);
  const previous = commonJSDirectories.get(directory);
  if (previous !== undefined && previous !== contextKey(dependencies)) throw conflict(directory);
  for (const cached of Object.keys(requireFromHere.cache)) {
    const physical = filename(pathToFileURL(cached).href)!;
    if (dirname(physical) !== directory || sdkModules.has(physical)) continue;
    const owner = contexts.get(physical);
    if (owner === undefined) {
      throw new Error(`Rule helper directory ${directory} contains an already-loaded unowned CommonJS module ${physical}; use a separate helper directory`);
    }
    if (contextKey(owner) !== contextKey(dependencies)) throw conflict(directory);
  }
  commonJSDirectories.set(directory, contextKey(dependencies));
}
// Absolute public SDK entries are supported too (for example a caller-selected
// SDK copy). Only the public entry is exempted here, not every file in its
// containing package, which may itself contain authored rules.
function sdkEntry(path: string): boolean {
  if (sdkModules.has(path)) return true;
  if (path === filename(SDK_ENTRY)) {
    sdkModules.add(path);
    return true;
  }
  let directory = dirname(path);
  for (;;) {
    let manifest: Manifest;
    try { manifest = json(join(directory, 'package.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const above = dirname(directory);
      if (above === directory) return false;
      directory = above;
      continue;
    }
    if (manifest['name'] !== SDK) return false;
    const exports = manifest['exports'];
    const targets: unknown[] = [exports !== null && typeof exports === 'object' && !Array.isArray(exports) && '.' in exports ? (exports as Manifest)['.'] : exports ?? manifest['main']];
    while (targets.length > 0) {
      const target = targets.pop();
      if (typeof target === 'string' && filename(pathToFileURL(join(directory, target)).href) === path) {
        sdkModules.add(path);
        return true;
      }
      if (target !== null && typeof target === 'object') targets.push(...Object.values(target));
    }
    return false;
  }
}

function attach(path: string, dependencies: PreparedRuleDependencies): void {
  const previous = contexts.get(path);
  if (previous === undefined && (sdkEntry(path) || packageContext(path) !== undefined)) return;
  if (previous !== undefined && contextKey(previous) !== contextKey(dependencies)) throw conflict(path);
  if (previous === undefined && requireFromHere.cache[path] !== undefined) {
    throw new Error(`Rule helper ${path} is an already-loaded unowned CommonJS module; use a separate helper directory`);
  }
  contexts.set(path, dependencies);
  if (path.endsWith('.cjs') || requireFromHere.cache[path] !== undefined) reserveCommonJS(path, dependencies);
}

export function registerRuleDependencies(ruleFile: string, dependencies: PreparedRuleDependencies): void {
  installationFor(dependencies);
  attach(realpathSync(ruleFile), dependencies);
  ownerKeys.set(dependencies.directory, dependencies.key);
}

export function getRuleDependencies(ruleFile: string): PreparedRuleDependencies | undefined {
  return contexts.get(realpathSync(ruleFile));
}

function undeclared(name: string, dependencies: PreparedRuleDependencies): Error {
  return new Error(`Rule dependency ${name} is not declared in ${join(dependencies.directory, 'rulekeeper.lock')}; run rulekeeper deps add ${name}`);
}

function requireCondition(conditions: readonly string[]): boolean {
  const requiring = conditions.includes('require');
  if (requiring && conditions.includes('import')) throw new Error('Ambiguous rule dependency resolution: both import and require conditions are active');
  return requiring;
}

// Node, rather than a second implementation of its imports/conditions algorithm,
// resolves #imports in a package scope with managed dependencies. Source links
// canonicalize back to the real helpers without modifying the owner.
function importScope(parent: string, installation: Installation | undefined, dependencies: PreparedRuleDependencies): ImportScope | undefined {
  let directory = dirname(parent);
  let manifest: Manifest | undefined;
  for (;;) {
    try { manifest = json(join(directory, 'package.json')); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const above = dirname(directory);
    if (above === directory) return undefined;
    directory = above;
  }
  if (manifest['imports'] === undefined) return undefined;
  const key = `${directory}\0${contextKey(dependencies)}`;
  const existing = importScopes.get(key);
  if (existing !== undefined) return existing;
  // Resolution metadata is process-owned, including for read-only owners.
  const scope = mkdtempSync(join(realpathSync(tmpdir()), 'rulekeeper-resolution-'));
  temporaryScopes.add(scope);
  try {
    const denied = new Map<string, string>();
    const sourceRoots: string[] = [];
    const ownName = manifest['exports'] == null ? undefined : manifest['name'];
    let deniedDirectory: string | undefined;
    const restrictTargets = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const name = nameOf(value);
        if (!bare(value) || isBuiltin(value) || name === ownName || dependencies.directDependencies.includes(name)) return value;
        try {
          const candidate = name.replaceAll('*', 'rulekeeper-pattern');
          const parsed = npa(candidate);
          if (parsed.name !== candidate || !parsed.registry || parsed.rawSpec !== '*') return value;
        } catch { return value; }
        // Preserve Node's condition/array/pattern selection, but turn an
        // undeclared external target into an identifiable local resolution.
        // It can never reach application, NODE_PATH, or ancestor packages.
        deniedDirectory ??= mkdtempSync(join(scope, '.rulekeeper-denied-'));
        const marker = join(deniedDirectory, String(denied.size));
        writeFileSync(marker, '');
        denied.set(marker, name);
        return `./${relative(scope, marker).split(sep).join('/')}`;
      }
      if (Array.isArray(value)) return value.map(restrictTargets);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([name, target]) => [name, restrictTargets(target)]));
      }
      return value;
    };
    const metadata: Manifest = {};
    for (const field of ['name', 'type', 'imports', 'exports']) {
      if (manifest[field] !== undefined) metadata[field] = field === 'imports' ? restrictTargets(manifest[field]) : manifest[field];
    }
    writeFileSync(join(scope, 'package.json'), JSON.stringify(metadata));
    if (installation === undefined) mkdirSync(join(scope, 'node_modules'));
    else symlinkSync(installation.root, join(scope, 'node_modules'), 'junction');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'package.json') continue;
      // Avoid mirroring process-owned resolution storage back into itself.
      if (inside(join(directory, entry.name), scope)) continue;
      symlinkSync(join(directory, entry.name), join(scope, entry.name), entry.isDirectory() ? 'junction' : 'file');
      sourceRoots.push(filename(pathToFileURL(join(directory, entry.name)).href)!);
    }
    const parentURL = pathToFileURL(join(scope, '.rulekeeper-imports.cjs')).href;
    const prepared = {
      parentURL, require: createRequire(parentURL),
      metadata: join(scope, 'package.json'), sourceMetadata: join(directory, 'package.json'),
      denied, sourceRoots,
    };
    importScopes.set(key, prepared);
    return prepared;
  } catch (error) {
    rmSync(scope, { recursive: true, force: true });
    temporaryScopes.delete(scope);
    throw error;
  }
}

process.once('exit', () => {
  for (const scope of temporaryScopes) {
    try { rmSync(scope, { recursive: true, force: true }); } catch { /* Best-effort process-owned resolution cleanup. */ }
  }
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = filename(context.parentURL);
    const dependencies = parent === undefined || sdkModules.has(parent) ? undefined : contexts.get(parent);
    const owner = parent === undefined || sdkModules.has(parent) ? undefined : packageContext(parent);
    if (dependencies !== undefined) assertRuleDependenciesCurrent(dependencies);
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    if (specifier === SDK) {
      let result;
      try { result = nextResolve(specifier, context); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND' && (error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
        result = nextResolve(SDK_ENTRY, context);
      }
      const path = filename(result.url);
      if (path !== undefined) sdkModules.add(path);
      return result;
    }
    if (parent === undefined || (dependencies === undefined && owner === undefined)) return nextResolve(specifier, context);
    const requiring = requireCondition(context.conditions);
    if (owner !== undefined) {
      if (bare(specifier)) {
        const name = nameOf(specifier);
        if (name !== owner.pkg.name && !owner.pkg.declarations.has(name)) {
          throw new Error(`Managed package ${owner.pkg.name} imports undeclared dependency ${name}`);
        }
      }
      const result = nextResolve(specifier, context);
      const target = filename(result.url);
      if (target !== undefined && !inside(owner.installation.root, target)) {
        throw new Error(`Managed package ${owner.pkg.name} resolved ${specifier} outside its rule dependency node_modules`);
      }
      if (specifier.startsWith('#') && target !== undefined) {
        const imported = managedPackage(owner.installation, target);
        if (imported !== undefined && imported.name !== owner.pkg.name && !owner.pkg.declarations.has(imported.name)) {
          throw new Error(`Managed package ${owner.pkg.name} imports undeclared dependency ${imported.name}`);
        }
      }
      return result;
    }
    const prepared = dependencies!;
    const installation = installationFor(prepared);
    let result;
    if (bare(specifier)) {
      const name = nameOf(specifier);
      if (!prepared.directDependencies.includes(name) || installation === undefined) throw undeclared(name, prepared);
      result = requiring
        ? nextResolve(installation.require.resolve(specifier), context)
        : nextResolve(specifier, { ...context, parentURL: installation.parentURL });
      const target = filename(result.url);
      if (target === undefined || !inside(installation.root, target)) throw new Error(`Rule dependency ${name} resolved outside its prepared node_modules`);
      return result;
    }
    let scope: ImportScope | undefined;
    if (specifier.startsWith('#')) {
      scope = importScope(parent, installation, prepared);
      result = scope === undefined ? nextResolve(specifier, context) : requiring
        ? nextResolve(scope.require.resolve(specifier), context)
        : nextResolve(specifier, { ...context, parentURL: scope.parentURL });
      const denied = scope === undefined ? undefined : scope.denied.get(filename(result.url)!);
      if (denied !== undefined) throw undeclared(denied, prepared);
      if (scope !== undefined && filename(result.url) === scope.metadata) {
        result = nextResolve(requiring ? scope.sourceMetadata : pathToFileURL(scope.sourceMetadata).href, context);
      }
    } else result = nextResolve(specifier, context);
    const target = filename(result.url);
    if (target === undefined) return result;
    const pkg = installation === undefined ? undefined : managedPackage(installation, target);
    if (pkg !== undefined) {
      if (specifier.startsWith('#') && !prepared.directDependencies.includes(pkg.name)) throw undeclared(pkg.name, prepared);
      return result;
    }
    if (scope !== undefined && target !== scope.sourceMetadata && !scope.sourceRoots.some(root => inside(root, target))) {
      throw new Error(`Rule import ${specifier} resolved outside its source helpers and prepared node_modules`);
    }
    attach(target, prepared);
    return result;
  },
  load(url, context, nextLoad) {
    const path = filename(url);
    const dependencies = path === undefined ? undefined : contexts.get(path);
    if (dependencies !== undefined) assertRuleDependenciesCurrent(dependencies);
    if (path !== undefined) packageContext(path);
    const result = nextLoad(url, context);
    if (dependencies !== undefined) assertRuleDependenciesCurrent(dependencies);
    if (path !== undefined && dependencies !== undefined && result.format?.startsWith('commonjs')) {
      reserveCommonJS(path, dependencies);
    }
    return result;
  },
});
