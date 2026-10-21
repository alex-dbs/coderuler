import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nock from 'nock';
import { create } from 'tar';

export const REGISTRY = 'https://registry.npmjs.org';
export const POLICY_MESSAGE_V1 = 'Fixture policy 1: shared dependency 1';
export const POLICY_MESSAGE_V2 = 'Fixture policy 2: shared dependency 2';

export interface FixtureManifest {
  readonly name: string;
  readonly version: string;
  readonly [field: string]: unknown;
}

export interface FixturePackage {
  readonly manifest: FixtureManifest;
  readonly files?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly integrity?: string;
  readonly tarball?: string;
  readonly redirect?: string;
}

export interface RegistryArtifact {
  readonly manifest: FixtureManifest;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly tarball: string;
  readonly integrity: string;
  readonly bytes: string;
  readonly redirect?: string;
}

export interface DependencyFixture {
  readonly artifacts: readonly RegistryArtifact[];
  readonly configuration: string;
}

export interface RegistryRequest {
  readonly kind: 'metadata' | 'tarball' | 'unmatched';
  readonly path: string;
}

const esm = { type: 'module', main: './index.js' };
const emptyModule = { 'index.js': 'export const value = "fixture";\n' };

export function fixturePackages(): readonly FixturePackage[] {
  const packages: FixturePackage[] = [];
  for (const version of ['1.0.0', '2.0.0']) {
    const major = version[0];
    packages.push({
      manifest: { name: 'fixture-shared', version, ...esm },
      files: { 'index.js': `export const message = 'shared dependency ${major}';\n` },
    }, {
      manifest: { name: 'fixture-policy', version, ...esm, dependencies: { 'fixture-shared': version } },
      files: {
        'index.js': `import { message as shared } from 'fixture-shared';\nexport const message = 'Fixture policy ${major}: ' + shared;\n`,
        'hidden.rule.ts': 'throw new Error("package rules must never be discovered");\n',
      },
    });
  }
  packages.push({
    manifest: { name: 'fixture-second', version: '1.0.0', ...esm, dependencies: { 'fixture-shared': '2.0.0' } },
    files: { 'index.js': "export { message } from 'fixture-shared';\n" },
  });
  packages.push({
    manifest: {
      name: '@fixture/typed', version: '1.0.0', type: 'module',
      exports: { '.': { types: './index.d.ts', import: './index.js', require: './index.cjs' } },
    },
    files: {
      'index.js': 'export const format = value => `esm:${value}`;\n',
      'index.cjs': 'exports.format = value => `cjs:${value}`;\n',
      'index.d.ts': 'export declare function format(value: string): string;\n',
      'private.js': 'export const secret = true;\n',
    },
  });
  const add = (name: string, fields: Record<string, unknown> = {}, files: Readonly<Record<string, string>> = emptyModule): void => {
    packages.push({ manifest: { name, version: '1.0.0', ...esm, ...fields }, files });
  };
  add('fixture-empty', { dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {} });
  add('fixture-overlap', { dependencies: { 'fixture-shared': '1.0.0' }, optionalDependencies: { 'fixture-shared': '2.0.0' } });
  add('fixture-engine', { engines: { node: '>=999.0.0' } });
  add('fixture-platform', { os: ['!darwin', '!linux', '!win32', '!freebsd', '!openbsd', '!aix', '!sunos', '!android'] });
  add('fixture-optional-parent', { dependencies: { 'fixture-engine': '1.0.0' } });
  add('fixture-optional-root', { optionalDependencies: { 'fixture-optional-parent': '1.0.0' }, dependencies: { 'fixture-shared': '1.0.0' } });
  add('fixture-required-optional-root', { dependencies: { 'fixture-optional-parent': '1.0.0' }, optionalDependencies: { 'fixture-engine': '1.0.0' } });
  add('fixture-optional-peer', { peerDependencies: { 'fixture-engine': '1.0.0' }, peerDependenciesMeta: { 'fixture-engine': { optional: true } } });
  add('fixture-peer-one', { peerDependencies: { 'fixture-shared': '1.0.0' } });
  add('fixture-peer-two', { peerDependencies: { 'fixture-shared': '2.0.0' } });
  const marker = 'require("node:fs").writeFileSync(process.env.RK_DEPENDENCY_SCRIPT_MARKER, "executed")';
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    add(`fixture-${lifecycle}`, { scripts: { [lifecycle]: `node -e '${marker}'` } });
  }
  add('fixture-prepare', { scripts: { prepare: `node -e '${marker}'`, build: `node -e '${marker}'` } });
  add('fixture-native', {}, { ...emptyModule, 'binding.gyp': '{}' });
  add('fixture-addon', {}, { ...emptyModule, 'addon.node': 'not a native binary' });
  add('fixture-shrinkwrap', {}, { ...emptyModule, 'npm-shrinkwrap.json': '{"lockfileVersion":3}' });
  add('fixture-bundled', { bundleDependencies: ['fixture-shared'], dependencies: { 'fixture-shared': '1.0.0' } }, {
    ...emptyModule,
    'node_modules/fixture-shared/package.json': '{"name":"fixture-shared","version":"1.0.0"}',
    'node_modules/fixture-shared/index.js': 'module.exports = {};\n',
  });
  add('fixture-hidden-bundle', {}, { ...emptyModule, 'node_modules/hidden/index.js': 'module.exports = {};\n' });
  add('fixture-hidden-locked-bundle', { dependencies: { 'fixture-shared': '2.0.0' } }, {
    'index.js': "export { message } from 'fixture-shared';\n",
    'node_modules/fixture-shared/package.json': JSON.stringify({ name: 'fixture-shared', version: '2.0.0', ...esm }),
    'node_modules/fixture-shared/index.js': 'export const message = "hidden bundled replacement";\n',
  });
  add('fixture-optional-unsafe-root', { optionalDependencies: { 'fixture-install': '1.0.0' } });
  add('fixture-omitted-unsafe', { engines: { node: '>=999.0.0' }, scripts: { install: `node -e '${marker}'` } });
  add('fixture-omitted-unsafe-root', { optionalDependencies: { 'fixture-omitted-unsafe': '1.0.0' } });
  const sources = {
    git: 'git+https://github.com/example/forbidden.git',
    file: 'file:../forbidden',
    url: 'https://registry.npmjs.org/fixture-shared/-/fixture-shared-1.0.0.tgz',
    alias: 'npm:fixture-shared@1.0.0',
  };
  for (const [kind, specifier] of Object.entries(sources)) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      add(`fixture-source-${kind}-${field.toLowerCase()}`, { [field]: { 'fixture-forbidden': specifier } });
    }
  }
  packages.push({ manifest: { name: 'fixture-bad-integrity', version: '1.0.0', ...esm }, files: emptyModule, integrity: `sha512-${createHash('sha512').update('different artifact').digest('base64')}` });
  add('fixture-optional-integrity-root', { optionalDependencies: { 'fixture-bad-integrity': '1.0.0' } });
  packages.push({ manifest: { name: 'fixture-off-origin', version: '1.0.0', ...esm }, files: emptyModule, tarball: 'https://example.invalid/fixture.tgz' });
  packages.push({ manifest: { name: 'fixture-redirect', version: '1.0.0', ...esm }, files: emptyModule, redirect: 'https://example.invalid/fixture.tgz' });
  packages.push({ manifest: { name: 'fixture-mismatch', version: '1.0.0', ...esm, dependencies: { 'fixture-shared': '1.0.0' } }, files: emptyModule, metadata: { dependencies: {} } });
  return packages;
}

export function createDependencyFixture(directory: string, definitions: readonly FixturePackage[] = fixturePackages()): DependencyFixture {
  mkdirSync(directory, { recursive: true });
  const artifacts = definitions.map((definition, index): RegistryArtifact => {
    const root = join(directory, `source-${index}`);
    const packageDirectory = join(root, 'package');
    mkdirSync(packageDirectory, { recursive: true });
    const files = { 'package.json': `${JSON.stringify(definition.manifest, null, 2)}\n`, ...(definition.files ?? emptyModule) };
    for (const [filename, source] of Object.entries(files)) {
      const target = join(packageDirectory, filename);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const archive = join(directory, `artifact-${index}.tgz`);
    create({ cwd: root, file: archive, sync: true, gzip: true, portable: true, mtime: new Date(0) }, ['package']);
    const bytes = readFileSync(archive);
    const basename = definition.manifest.name.split('/').at(-1);
    const artifact: RegistryArtifact = {
      manifest: definition.manifest,
      metadata: { ...definition.manifest, ...definition.metadata },
      tarball: definition.tarball ?? `${REGISTRY}/${definition.manifest.name}/-/${basename}-${definition.manifest.version}.tgz`,
      integrity: definition.integrity ?? `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      bytes: bytes.toString('base64'),
      ...(definition.redirect === undefined ? {} : { redirect: definition.redirect }),
    };
    return artifact;
  });
  const configuration = join(directory, 'registry.json');
  writeFileSync(configuration, JSON.stringify(artifacts));
  return { artifacts, configuration };
}

export function installDependencyRegistry(
  fixture: Pick<DependencyFixture, 'artifacts'>,
  options: { readonly mode?: 'all' | 'tarballs' | 'offline'; readonly requestLog?: string; readonly onRequest?: (request: RegistryRequest) => void } = {},
): { readonly requests: RegistryRequest[]; close(): void } {
  const requests: RegistryRequest[] = [];
  const record = (request: RegistryRequest): void => {
    requests.push(request);
    if (options.requestLog !== undefined) appendFileSync(options.requestLog, `${JSON.stringify(request)}\n`);
    options.onRequest?.(request);
  };
  const unmatched = (incoming: Request): void => { record({ kind: 'unmatched', path: incoming.url }); };
  nock.emitter.on('no match', unmatched);
  nock.disableNetConnect();
  const scope = nock(REGISTRY).persist().matchHeader('authorization', value => value === null);
  if (options.mode !== 'offline') {
    for (const artifact of fixture.artifacts) {
      const url = new URL(artifact.tarball);
      if (url.origin !== REGISTRY) continue;
      scope.get(url.pathname).reply(() => {
        record({ kind: 'tarball', path: url.pathname });
        return artifact.redirect === undefined
          ? [200, Buffer.from(artifact.bytes, 'base64'), { 'Content-Type': 'application/octet-stream' }]
          : [302, '', { Location: artifact.redirect }];
      });
    }
  }
  if ((options.mode ?? 'all') === 'all') {
    const names = [...new Set(fixture.artifacts.map(artifact => artifact.manifest.name))];
    for (const name of names) {
      const versions = fixture.artifacts.filter(artifact => artifact.manifest.name === name);
      const metadata = {
        _id: name,
        name,
        'dist-tags': { latest: versions.at(-1)?.manifest.version },
        versions: Object.fromEntries(versions.map(artifact => [artifact.manifest.version, {
          ...artifact.metadata,
          dist: { tarball: artifact.tarball, integrity: artifact.integrity, shasum: createHash('sha1').update(Buffer.from(artifact.bytes, 'base64')).digest('hex') },
        }])),
      };
      scope.get(path => {
        try { return decodeURIComponent(path).toLowerCase() === `/${name}`.toLowerCase(); } catch { return false; }
      }).query(true).reply(200, () => {
        record({ kind: 'metadata', path: `/${name}` });
        return metadata;
      });
    }
    scope.get(/.*/).reply(404, (uri: string) => {
      record({ kind: 'unmatched', path: uri });
      return { error: 'fixture package not found' };
    });
  }
  return {
    requests,
    close(): void {
      nock.emitter.off('no match', unmatched);
      nock.cleanAll();
      nock.enableNetConnect();
    },
  };
}

export function dependencyFixtureEnvironment(
  fixture: DependencyFixture,
  options: { readonly mode?: 'all' | 'tarballs' | 'offline'; readonly requestLog?: string; readonly nodeOptions?: string } = {},
): NodeJS.ProcessEnv {
  const preload = fileURLToPath(new URL('./dependency-preload.ts', import.meta.url));
  return {
    NODE_OPTIONS: `${options.nodeOptions ?? ''} --import=${JSON.stringify(preload)}`.trim(),
    RK_DEPENDENCY_FIXTURE: fixture.configuration,
    RK_DEPENDENCY_FIXTURE_MODE: options.mode ?? 'all',
    ...(options.requestLog === undefined ? {} : { RK_DEPENDENCY_REQUEST_LOG: options.requestLog }),
  };
}
