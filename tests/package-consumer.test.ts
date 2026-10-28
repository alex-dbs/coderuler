import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDependencyFixture, dependencyFixtureEnvironment, fixturePackages, POLICY_MESSAGE_V1, type DependencyFixture } from './dependency-support.ts';

const REPO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const PACKAGE_NAME = '@alex-dbs/coderuler';
const DEFAULT_TIMEOUT = 900_000;

interface PackedFile {
  readonly path: string;
}

interface PackedEntry {
  readonly filename: string;
  readonly files: readonly PackedFile[];
}

interface RunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout?: number;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface SubjectShape {
  readonly kind: string;
  readonly filepath?: string;
}

interface ResultShape {
  readonly status: string;
  readonly message?: string;
}

interface EvaluationShape {
  readonly subject: SubjectShape;
  readonly result: ResultShape;
}

interface ReportEntry {
  readonly name: string;
  readonly ruleFile: string;
  readonly status: string;
  readonly durationMs: number;
  readonly reason?: string;
  readonly evaluations: readonly EvaluationShape[];
}

interface ProbeResult {
  readonly resolved: string;
  readonly selectors: readonly string[];
  readonly ruleIsFunction: boolean;
  readonly brand: boolean;
  readonly helpers: readonly string[];
  readonly registrations: string;
}

interface IdentityResult {
  readonly sameClass: boolean;
  readonly appBrand: boolean;
  readonly copyBrand: boolean;
  readonly crossInstanceof: boolean;
}

interface InstalledManifest {
  readonly type: string;
  readonly types: string;
  readonly exports: Readonly<Record<string, { readonly types?: string; readonly import?: string }>>;
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}

interface Consumer {
  readonly root: string;
  readonly app: string;
  readonly vendorSdk: string;
  readonly homeApp: string;
  readonly cleanHome: string;
  readonly ruleHome: string;
  readonly gitless: string;
  readonly tarball: string;
  readonly packedPaths: readonly string[];
  readonly globalPrefix: string;
  readonly globalModules: string;
  readonly globalApp: string;
  readonly globalHome: string;
  readonly localPreferenceApp: string;
  readonly globalIsolationApp: string;
  readonly missingImportApp: string;
  readonly missingHome: string;
  readonly ambientApp: string;
  readonly registry: DependencyFixture;
}

const SHARED_HELPER_SOURCE = `export const LICENSE_PATTERN = /Copyright ..../;
`;

const LICENSE_RULE_SOURCE = `import { Rule, regex } from '@alex-dbs/coderuler';
import { LICENSE_PATTERN } from './helpers/shared.js';

export default class LicenseRule extends Rule {
  files = ['src/*.ts'];
  check = regex({ pattern: LICENSE_PATTERN, violationMessage: 'Missing copyright header' });
}
`;

const CONTRACT_RULE_SOURCE = `import { Rule, regex } from '@alex-dbs/coderuler';

export default class ContractRule extends Rule {
  files = ['src/*.ts'];
  check = regex({ pattern: /export (const|function)/, violationMessage: 'Source files must export a const or function' });
}
`;

const HEADERED_SOURCE = `// Copyright 2026 Example Corp
export const headered = true;
`;

const HEADERLESS_SOURCE = `export const headerless = true;
`;

const NO_EXPORT_SOURCE = `// Copyright 2026 Example Corp
const internal = 1;
`;

const TYPED_CONSUMER_SOURCE = `import {
  Rule,
  ai,
  pass,
  regex,
  scopes,
  violation,
  type CheckContext,
  type CheckResult,
  type Grouping,
  type JsonValue,
  type ProjectContext,
  type ScopeMatch,
  type ScopeSelector,
  type ScopeSubject,
  type SelectionContext,
  type SourceFile,
  type Subject,
} from '@alex-dbs/coderuler';

export class InfraPlacement extends Rule {
  files = ['internal/infra/**/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }] },
  });

  async when({ project }: ProjectContext): Promise<boolean> {
    return (await project.stat('internal/adapter'))?.kind === 'directory';
  }

  check = ai({
    rule: 'Infrastructure functions implement technical concerns, not business policy or application orchestration.',
    violationMessage: 'This function belongs outside infrastructure',
  });
}

interface ServiceConfig {
  readonly name: string;
  readonly port: number;
}

export class ServicePorts extends Rule<ServiceConfig> {
  files = ['config/*.json'];
  scope = scopes.json<ServiceConfig>({ path: '$.services[*]' });
  group: Grouping = { by: 'folder', level: 0 };

  filter(subject: ScopeSubject<ServiceConfig>, context: ProjectContext): boolean {
    context.trace('port', subject.data?.port ?? null);
    return subject.data !== undefined && subject.data.port > 0;
  }

  check = async (subject: Subject<ServiceConfig>): Promise<CheckResult> => {
    if (subject.kind === 'group') {
      return subject.members.length > 0 ? pass() : violation('No service ports in this folder');
    }
    return subject.data !== undefined && subject.data.port < 1024
      ? violation('Privileged port ' + String(subject.data.port))
      : pass();
  };
}

const envScope: ScopeSelector<JsonValue> = (file: SourceFile): readonly ScopeMatch<JsonValue>[] => [
  { id: '$', source: file.source },
];

export class EnvRule extends Rule {
  files = ['*.env'];
  scope = envScope;
  check = ai<JsonValue>({
    rule: 'Environment files list only uppercase keys.',
    examples: { good: ['PORT=8080'], bad: ['port=8080'] },
    input: (subject) =>
      subject.kind === 'scope'
        ? { filepath: subject.filepath, text: subject.source }
        : { files: subject.members.length },
  });
}

export class DocsRule extends Rule {
  files = ['docs/*.md'];
  check = regex({ pattern: /^# /m, violationMessage: 'Docs must start with a heading' });

  async when({ project }: ProjectContext): Promise<boolean> {
    return project.hasFiles('docs/*.md');
  }

  async select(context: SelectionContext): Promise<readonly ScopeSubject<JsonValue>[]> {
    return context.select<{ title: string }>({
      files: this.files,
      scope: scopes.yaml<{ title: string }>({ path: '$.title' }),
    });
  }
}

export class ServiceTableRule extends Rule {
  files = ['**/*.md'];
  check = async (subject: Subject<JsonValue>, context: CheckContext<JsonValue>): Promise<CheckResult> => {
    if (subject.kind !== 'scope') return violation('grouped subjects are not supported here');
    const rows = await context.project.readCsv('data/services.csv');
    context.trace('csv rows', rows.length);
    return rows.length > 0 ? pass() : violation('service table is empty');
  };
}
`;

const PROBE_SOURCE = `import { Rule, ai, regex, pass, violation, scopes, createAstGrepLanguageRegistrations } from '@alex-dbs/coderuler';
const brand = Symbol.for('coderuler.Rule');
console.log(JSON.stringify({
  resolved: import.meta.resolve('@alex-dbs/coderuler'),
  selectors: Object.keys(scopes).sort(),
  ruleIsFunction: typeof Rule === 'function',
  brand: Rule.prototype[brand] === true,
  helpers: [ai, regex, pass, violation].map(value => typeof value),
  registrations: typeof createAstGrepLanguageRegistrations,
}));
`;

const GLOBAL_RULE_SOURCE = `import { Rule, pass, scopes, test, violation } from '@alex-dbs/coderuler';

export default class GlobalRule extends Rule {
  files = ['src/*.txt'];
  scope = scopes.yaml({ path: '$' });

  check = (subject) => (subject.data?.verdict === 'BAD' ? violation('bad global input') : pass());
}

export const tests = [
  test('global pass').withFiles({ 'src/ok.txt': 'verdict: GOOD' }).passes(),
  test('global violation').withFiles({ 'src/bad.txt': 'verdict: BAD' }).violates(),
];
`;

const GLOBAL_HOME_RULE_SOURCE = `import { Rule, pass, test, violation } from '@alex-dbs/coderuler';

export default class GlobalHomeRule extends Rule {
  files = ['notes/*.txt'];
  check = (subject) => (subject.source.includes('BAD') ? violation('bad home input') : pass());
}

export const tests = [
  test('home global pass').withFiles({ 'notes/ok.txt': 'GOOD' }).passes(),
  test('home global violation').withFiles({ 'notes/bad.txt': 'BAD' }).violates(),
];
`;

const LOCAL_PREFERENCE_RULE_SOURCE = `import { Rule, FIXTURE_LOCAL_MARKER, pass, scopes, test, violation } from '@alex-dbs/coderuler';
import { parse } from 'yaml';
import { createRequire } from 'node:module';

const requiredYaml = createRequire(import.meta.url)('yaml');
if (FIXTURE_LOCAL_MARKER !== 'fixture-local-copy') {
  throw new Error('rule import resolved outside the project-local SDK: ' + String(FIXTURE_LOCAL_MARKER));
}

export default class LocalPreferenceRule extends Rule {
  files = ['src/*.txt'];
  scope = scopes.yaml({ path: '$' });

  check = (subject) => {
    const local = parse(subject.source);
    if (local.localYamlMarker !== 'fixture-managed-yaml-esm') {
      throw new Error('direct yaml import did not select the managed ESM export');
    }
    if (requiredYaml.parse(subject.source).localYamlMarker !== 'fixture-managed-yaml-cjs') {
      throw new Error('helper require did not select the managed CommonJS export');
    }
    return subject.data?.verdict === 'BAD' ? violation('bad local input') : pass();
  };
}

export const tests = [
  test('project-local SDK and dependency case').withFiles({ 'src/ok.txt': 'verdict: GOOD' }).passes(),
  test('project-local SDK parses YAML with its own dependency').withFiles({ 'src/bad.txt': 'verdict: BAD' }).violates(),
];
`;

const MANAGED_YAML_MANIFEST = {
  name: 'yaml', version: '1.0.0', type: 'module',
  exports: { '.': { import: './index.js', require: './index.cjs' } },
};
const MANAGED_YAML_FILES = {
  'index.js': `export const parse = (source) => ({ localYamlMarker: 'fixture-managed-yaml-esm', source });\n`,
  'index.cjs': `exports.parse = (source) => ({ localYamlMarker: 'fixture-managed-yaml-cjs', source });\n`,
  'util.js': 'export const privateUtility = true;\n',
};

const MISSING_IMPORT_RULE_SOURCE = `import '@alex-dbs/coderuler-fixture-missing';
import { Rule } from '@alex-dbs/coderuler';

export default class MissingImportRule extends Rule {
  files = ['src/*.txt'];
  check = () => ({ status: 'pass' });
}
`;

const MISSING_RELATIVE_RULE_SOURCE = `import './rules.js';
import { Rule } from '@alex-dbs/coderuler';

export default class MissingRelativeRule extends Rule {
  files = ['src/*.txt'];
  check = () => ({ status: 'pass' });
}
`;

const EXPORT_RESTRICTION_RULE_SOURCE = `import 'yaml/util';
import { Rule } from '@alex-dbs/coderuler';

export default class ExportRestrictionRule extends Rule {
  files = ['src/*.txt'];
  check = () => ({ status: 'pass' });
}
`;

const DIRECT_YAML_RULE_SOURCE = `import 'yaml';
import { Rule } from '@alex-dbs/coderuler';

export default class DirectYamlRule extends Rule {
  files = ['src/*.txt'];
  check = () => ({ status: 'pass' });
}
`;

const REQUIRED_EXPORT_RESTRICTION_RULE_SOURCE = `import { createRequire } from 'node:module';
import { Rule } from '@alex-dbs/coderuler';

createRequire(import.meta.url)('yaml/util');

export default class RequiredExportRestrictionRule extends Rule {
  files = ['src/*.txt'];
  check = () => ({ status: 'pass' });
}
`;

const REQUIRED_YAML_RULE_SOURCE = `import './helpers/required-yaml.js';
import { Rule } from '@alex-dbs/coderuler';

export default class RequiredYamlRule extends Rule {
  files = ['src/*.txt'];
  check = () => ({ status: 'pass' });
}
`;

const REQUIRED_YAML_HELPER_SOURCE = `import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const requiredYaml = require('yaml');
`;

const BORROWER_RULE_SOURCE = `import 'coderuler-fixture-borrower';
import { Rule } from '@alex-dbs/coderuler';

export default class BorrowerRule extends Rule {
  files = ['src/*.txt'];
  check = () => ({ status: 'pass' });
}
`;

const BORROWER_MANIFEST = {
  name: 'coderuler-fixture-borrower', version: '1.0.0', type: 'module', exports: { '.': './index.js' },
};
const BORROWER_INDEX_SOURCE = `import { parseDocument } from 'yaml';

export const borrowedParser = typeof parseDocument;
`;

async function writeFixtureLock(directory: string, registry: DependencyFixture, names: readonly string[]): Promise<void> {
  const artifacts = names.map(name => {
    const artifact = registry.artifacts.find(candidate => candidate.manifest.name === name);
    assert.ok(artifact !== undefined, `missing registry fixture for ${name}`);
    return artifact;
  });
  const dependencies = Object.fromEntries(artifacts.map(artifact => [artifact.manifest.name, artifact.manifest.version]));
  await writeFile(join(directory, 'coderuler.lock'), `${JSON.stringify({
    name: 'coderuler-rules',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'coderuler-rules', version: '1.0.0', dependencies },
      ...Object.fromEntries(artifacts.map(artifact => [`node_modules/${artifact.manifest.name}`, {
        version: artifact.manifest.version, resolved: artifact.tarball, integrity: artifact.integrity,
      }])),
    },
  }, null, 2)}\n`);
}

const cleanupPaths: string[] = [];
let consumer: Consumer;

after(async () => {
  await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
});

function run(command: string, args: readonly string[], options: RunOptions): RunResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status === null) throw new Error(`${command} was killed before finishing: ${result.signal ?? 'unknown signal'}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runNpm(args: readonly string[], cwd: string, timeout?: number): RunResult {
  const options: RunOptions = timeout === undefined ? { cwd, env: process.env } : { cwd, env: process.env, timeout };
  const execPath = process.env.npm_execpath;
  if (execPath !== undefined && execPath.endsWith('.js')) return run(process.execPath, [execPath, ...args], options);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

const CREDENTIAL_PREFIXES = ['RK_', 'TYPESAFE_', 'OPENAI_'];
const PROXY_KEYS: Readonly<Record<string, true>> = {
  http_proxy: true,
  https_proxy: true,
  no_proxy: true,
  all_proxy: true,
};

function isolatedEnv(home: string, extra: Readonly<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CREDENTIAL_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (PROXY_KEYS[key.toLowerCase()] === true) continue;
    if (key === 'NODE_PATH' || key === 'NODE_OPTIONS' || key === 'NODE_V8_COVERAGE') continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.PATH = dirname(process.execPath);
  env.NO_COLOR = '1';
  delete env.FORCE_COLOR;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  env.XDG_CONFIG_HOME = join(home, '.config');
  return env;
}

function runCli(app: string, args: readonly string[], options: { readonly cwd: string; readonly home: string; readonly extra?: Readonly<NodeJS.ProcessEnv> }): RunResult {
  const bin = join(app, 'node_modules', '.bin', 'coderuler');
  assert.ok(existsSync(bin), `installed CLI missing at ${bin}`);
  const env = options.extra === undefined ? isolatedEnv(options.home) : isolatedEnv(options.home, options.extra);
  return run(bin, args, { cwd: options.cwd, env });
}

function runSourceCli(
  args: readonly string[],
  options: { readonly cwd: string; readonly home: string; readonly registry: DependencyFixture; readonly mode?: 'all' | 'offline' },
): RunResult {
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  return run(process.execPath, [tsx, join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
    cwd: options.cwd,
    env: isolatedEnv(options.home, {
      ...dependencyFixtureEnvironment(options.registry, { mode: options.mode ?? 'offline' }),
      RK_DEPENDENCY_CACHE: join(options.home, 'dependency-cache'),
    }),
  });
}

function runGlobalCli(args: readonly string[], options: { readonly cwd: string; readonly home: string; readonly extra?: Readonly<NodeJS.ProcessEnv> }): RunResult {
  const env = isolatedEnv(options.home, {
    ...dependencyFixtureEnvironment(consumer.registry, { mode: 'tarballs' }),
    RK_DEPENDENCY_CACHE: join(consumer.root, 'dependency-cache'),
    ...options.extra,
  });
  if (process.platform === 'win32') {
    const bin = join(consumer.globalPrefix, 'coderuler.cmd');
    assert.ok(existsSync(bin), `globally installed CLI missing at ${bin}`);
    const cli = join(consumer.globalModules, PACKAGE_NAME, 'dist', 'cli.js');
    return run(process.execPath, [cli, ...args], { cwd: options.cwd, env });
  }
  const bin = join(consumer.globalPrefix, 'bin', 'coderuler');
  assert.ok(existsSync(bin), `globally installed CLI missing at ${bin}`);
  return run(bin, args, { cwd: options.cwd, env });
}

function firstPackEntry(stdout: string): PackedEntry {
  const start = stdout.indexOf('[');
  assert.notEqual(start, -1, `unexpected npm pack output: ${stdout}`);
  const parsed: unknown = JSON.parse(stdout.slice(start));
  assert.ok(Array.isArray(parsed), `npm pack --json must print an array: ${stdout}`);
  const entry: unknown = parsed[0];
  assert.ok(entry !== null && typeof entry === 'object', `npm pack --json printed no entry: ${stdout}`);
  return entry as PackedEntry;
}

function parseReport(stdout: string): readonly ReportEntry[] {
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), `check --json must print an envelope: ${stdout}`);
  const envelope = parsed as Record<string, unknown>;
  const durationMs = envelope['durationMs'];
  assert.ok(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0);
  assert.ok(Array.isArray(envelope['reports']), `check --json reports must be an array: ${stdout}`);
  for (const [index, entry] of envelope['reports'].entries()) {
    assert.ok(entry !== null && typeof entry === 'object' && !Array.isArray(entry), `report ${index} must be an object`);
    const ruleDurationMs = (entry as Record<string, unknown>)['durationMs'];
    assert.ok(
      typeof ruleDurationMs === 'number' && Number.isFinite(ruleDurationMs) && ruleDurationMs >= 0,
      `report ${index}.durationMs must be a finite nonnegative number`,
    );
  }
  return envelope['reports'] as readonly ReportEntry[];
}

function reportFor(report: readonly ReportEntry[], name: string): ReportEntry {
  const entry = report.find((candidate) => candidate.name === name);
  assert.ok(entry !== undefined, `rule "${name}" missing from report: ${JSON.stringify(report)}`);
  return entry;
}

function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

const PACKAGE_METADATA_PATTERN = /^(readme|license|licence|changelog)(\.[a-z0-9]+)*$/i;

function isPackagedEntry(path: string): boolean {
  if (path.startsWith('dist/')) return true;
  if (path === 'skills/coderuler-new-rule/SKILL.md') return true;
  if (path === 'skills/coderuler-new-rule/reference.md') return true;
  if (path === 'package.json') return true;
  return !path.includes('/') && PACKAGE_METADATA_PATTERN.test(path);
}

async function listFiles(dir: string, base: string = dir): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, base)));
    else if (entry.isFile()) files.push(relative(base, absolute));
  }
  return files.sort();
}

function homeRuleSource(indexUrl: string): string {
  return [
    `import { Rule, regex } from '${indexUrl}';`,
    '',
    'export default class HomeRule extends Rule {',
    "  files = ['src/*.ts'];",
    "  check = regex({ pattern: /Copyright ..../, violationMessage: 'Home rule: missing copyright header' });",
    '}',
    '',
  ].join('\n');
}

function identitySource(indexUrl: string): string {
  return [
    "import { Rule } from '@alex-dbs/coderuler';",
    `const copy = await import('${indexUrl}');`,
    "const brand = Symbol.for('coderuler.Rule');",
    'process.stdout.write(JSON.stringify({',
    '  sameClass: Rule === copy.Rule,',
    '  appBrand: Rule.prototype[brand] === true,',
    '  copyBrand: copy.Rule.prototype[brand] === true,',
    '  crossInstanceof: new (class extends copy.Rule {})() instanceof Rule,',
    '}));',
    '',
  ].join('\n');
}

before(async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'coderuler-consumer-'));
  cleanupPaths.push(root);

  const packed = runNpm(['pack', '--json', '--pack-destination', root], REPO_ROOT, DEFAULT_TIMEOUT);
  assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
  const packEntry = firstPackEntry(packed.stdout);
  const tarball = join(root, packEntry.filename);
  assert.ok(existsSync(tarball), `tarball missing at ${tarball}`);

  const app = join(root, 'app');
  const vendorSdk = join(app, 'vendor', 'node_modules', PACKAGE_NAME);
  const homeApp = join(root, 'home-app');
  const cleanHome = join(root, 'clean-home');
  const ruleHome = join(root, 'rule-home');
  const gitless = join(root, 'gitless');
  const globalPrefix = join(root, 'global-prefix');
  const globalApp = join(root, 'global-app');
  const globalHome = join(root, 'global-home');
  const localPreferenceApp = join(root, 'local-preference-app');
  const globalIsolationApp = join(root, 'global-isolation-app');
  const missingImportApp = join(root, 'missing-import-app');
  const missingHome = join(root, 'missing-home');
  const ambientApp = join(root, 'ambient-app');
  const registry = createDependencyFixture(join(root, 'registry'), [
    { manifest: MANAGED_YAML_MANIFEST, files: MANAGED_YAML_FILES },
    { manifest: BORROWER_MANIFEST, files: { 'index.js': BORROWER_INDEX_SOURCE } },
    ...fixturePackages().filter(fixture => fixture.manifest.name === '@fixture/typed'),
  ]);

  await mkdir(app, { recursive: true });
  await mkdir(join(app, '.coderuler', 'helpers'), { recursive: true });
  await mkdir(join(app, 'src'), { recursive: true });
  await mkdir(join(homeApp, 'src'), { recursive: true });
  await mkdir(join(ruleHome, '.coderuler'), { recursive: true });
  await mkdir(join(gitless, 'src'), { recursive: true });
  await mkdir(cleanHome, { recursive: true });
  await mkdir(globalPrefix, { recursive: true });
  await mkdir(join(globalApp, '.coderuler'), { recursive: true });
  await mkdir(join(globalHome, '.coderuler'), { recursive: true });
  await mkdir(join(localPreferenceApp, '.coderuler'), { recursive: true });
  await mkdir(join(globalIsolationApp, '.coderuler', 'helpers'), { recursive: true });
  await mkdir(join(missingImportApp, '.coderuler'), { recursive: true });
  await mkdir(missingHome, { recursive: true });
  await mkdir(join(ambientApp, '.coderuler'), { recursive: true });
  await mkdir(join(ambientApp, 'node_modules', 'yaml'), { recursive: true });
  await writeFile(join(ambientApp, 'node_modules', 'yaml', 'package.json'), `${JSON.stringify(MANAGED_YAML_MANIFEST)}\n`);
  for (const [filename, source] of Object.entries(MANAGED_YAML_FILES)) {
    await writeFile(join(ambientApp, 'node_modules', 'yaml', filename), source);
  }
  await writeFixtureLock(join(localPreferenceApp, '.coderuler'), registry, ['yaml']);
  await writeFixtureLock(join(missingImportApp, '.coderuler'), registry, ['yaml']);
  await writeFixtureLock(join(globalIsolationApp, '.coderuler'), registry, ['coderuler-fixture-borrower']);

  const relativeTarball = relative(app, tarball).split(sep).join('/');
  await writeFile(
    join(app, 'package.json'),
    `${JSON.stringify({ name: 'coderuler-consumer', private: true, type: 'module', dependencies: { [PACKAGE_NAME]: `file:${relativeTarball}` } }, null, 2)}\n`,
  );
  await writeFile(join(app, '.coderuler', 'helpers', 'shared.js'), SHARED_HELPER_SOURCE);
  await writeFile(join(app, '.coderuler', 'license.rule.ts'), LICENSE_RULE_SOURCE);
  await writeFile(join(app, '.coderuler', 'contract.rule.js'), CONTRACT_RULE_SOURCE);
  await writeFile(join(app, 'src', 'clean.ts'), HEADERED_SOURCE);
  await writeFile(join(app, 'src', 'headerless.ts'), HEADERLESS_SOURCE);
  await writeFile(join(app, 'src', 'no-export.ts'), NO_EXPORT_SOURCE);
  await writeFile(join(app, 'typed-consumer.ts'), TYPED_CONSUMER_SOURCE);
  await writeFile(join(app, 'probe.mjs'), PROBE_SOURCE);
  await writeFile(join(homeApp, 'src', 'thing.ts'), HEADERLESS_SOURCE);
  await writeFile(join(gitless, 'src', 'bare.ts'), HEADERLESS_SOURCE);
  await writeFile(join(globalApp, '.coderuler', 'global.rule.ts'), GLOBAL_RULE_SOURCE);
  await writeFile(join(globalHome, '.coderuler', 'home.global.rule.mjs'), GLOBAL_HOME_RULE_SOURCE);
  await writeFile(join(localPreferenceApp, '.coderuler', 'preference.rule.mjs'), LOCAL_PREFERENCE_RULE_SOURCE);
  await writeFile(join(globalIsolationApp, '.coderuler', 'direct-yaml.rule.mjs'), DIRECT_YAML_RULE_SOURCE);
  await writeFile(join(globalIsolationApp, '.coderuler', 'required-yaml.rule.mjs'), REQUIRED_YAML_RULE_SOURCE);
  await writeFile(join(globalIsolationApp, '.coderuler', 'helpers', 'required-yaml.js'), REQUIRED_YAML_HELPER_SOURCE);
  await writeFile(join(globalIsolationApp, '.coderuler', 'borrower.rule.mjs'), BORROWER_RULE_SOURCE);
  await writeFile(join(ambientApp, '.coderuler', 'direct-yaml.rule.mjs'), DIRECT_YAML_RULE_SOURCE);
  await writeFile(join(missingImportApp, '.coderuler', 'broken.rule.mjs'), MISSING_IMPORT_RULE_SOURCE);
  await writeFile(join(missingImportApp, '.coderuler', 'missing-relative.rule.mjs'), MISSING_RELATIVE_RULE_SOURCE);
  await writeFile(join(missingImportApp, '.coderuler', 'restricted.rule.mjs'), EXPORT_RESTRICTION_RULE_SOURCE);
  await writeFile(join(missingImportApp, '.coderuler', 'required-restricted.rule.mjs'), REQUIRED_EXPORT_RESTRICTION_RULE_SOURCE);
  assert.equal(
    existsSync(join(globalIsolationApp, '.coderuler', 'node_modules', 'yaml')),
    false,
    'the isolation fixture must not carry a local yaml package',
  );
  for (const project of [globalApp, localPreferenceApp, globalIsolationApp, missingImportApp, ambientApp]) {
    await writeFile(
      join(project, 'package.json'),
      `${JSON.stringify({ name: 'coderuler-global-fixture', private: true, type: 'module' }, null, 2)}\n`,
    );
  }

  const install = runNpm(['install', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel', 'error'], app, DEFAULT_TIMEOUT);
  assert.equal(install.status, 0, `npm install failed: ${install.stderr}`);
  assert.ok(existsSync(join(app, 'node_modules', PACKAGE_NAME, 'dist', 'index.js')), 'installed package is missing dist/index.js');

  const installGlobal = runNpm(
    ['install', '--global', '--prefix', globalPrefix, '--no-audit', '--no-fund', '--prefer-offline', '--loglevel', 'error', tarball],
    root,
    DEFAULT_TIMEOUT,
  );
  assert.equal(installGlobal.status, 0, `npm install --global failed: ${installGlobal.stderr}`);
  const globalRoot = runNpm(['root', '--global', '--prefix', globalPrefix], root);
  assert.equal(globalRoot.status, 0, `npm root --global failed: ${globalRoot.stderr}`);
  const globalModules = globalRoot.stdout.trim();
  assert.ok(globalModules !== '', 'npm root --global printed no path');
  assert.ok(
    existsSync(join(globalModules, PACKAGE_NAME, 'dist', 'cli.js')),
    `globally installed package missing under ${globalModules}`,
  );
  const globalSdkEntry = join(globalModules, PACKAGE_NAME, 'dist', 'index.js');
  const globalSdkYaml = createRequire(pathToFileURL(globalSdkEntry)).resolve('yaml');
  assert.ok(globalSdkYaml.startsWith(globalModules), `global SDK must resolve yaml from its installation: ${globalSdkYaml}`);

  const localSdk = join(localPreferenceApp, 'node_modules', PACKAGE_NAME);
  await cp(join(globalModules, PACKAGE_NAME), localSdk, { recursive: true, dereference: true });
  const localIndex = join(localSdk, 'dist', 'index.js');
  const localSdkYaml = createRequire(pathToFileURL(localIndex)).resolve('yaml');
  assert.ok(localSdkYaml.startsWith(localSdk), `project-local SDK must resolve yaml from its own tree: ${localSdkYaml}`);
  await writeFile(
    localIndex,
    `${await readFile(localIndex, 'utf8')}\nexport const FIXTURE_LOCAL_MARKER = 'fixture-local-copy';\n`,
  );

  await mkdir(dirname(vendorSdk), { recursive: true });
  await cp(join(app, 'node_modules', PACKAGE_NAME), vendorSdk, { recursive: true, dereference: true });

  const vendorIndex = join(vendorSdk, 'dist', 'index.js');
  assert.ok(existsSync(vendorIndex), `separate SDK copy missing at ${vendorIndex}`);
  await writeFile(join(ruleHome, '.coderuler', 'home.rule.mjs'), homeRuleSource(pathToFileURL(vendorIndex).href));
  await writeFile(join(app, 'identity.mjs'), identitySource(pathToFileURL(vendorIndex).href));

  consumer = {
    root,
    app,
    vendorSdk,
    homeApp,
    cleanHome,
    ruleHome,
    gitless,
    tarball,
    packedPaths: packEntry.files.map((file) => file.path),
    globalPrefix,
    globalModules,
    globalApp,
    globalHome,
    localPreferenceApp,
    globalIsolationApp,
    missingImportApp,
    missingHome,
    ambientApp,
    registry,
  };
});

test('the source CLI runs SDK-only rules through tsx and syncs the running SDK without an application install', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'coderuler-source-sdk-'));
  cleanupPaths.push(root);
  const cwd = join(root, 'app');
  const home = join(root, 'home');
  const directory = join(cwd, '.coderuler');
  await mkdir(directory, { recursive: true });
  await mkdir(home);
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(cwd, 'input.txt'), 'source input\n');
  await writeFile(join(directory, 'source.rule.ts'), `import { Rule, violation } from '@alex-dbs/coderuler';
export default class SourceRule extends Rule {
  files = ['input.txt'];
  check = () => violation('Source SDK policy');
}
`);
  const options = { cwd, home, registry: createDependencyFixture(join(root, 'registry'), []) };
  const assertSourceReport = (result: RunResult): void => {
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.deepEqual(parseReport(result.stdout).map(entry => ({
      name: entry.name,
      status: entry.status,
      evaluations: entry.evaluations.map(evaluation => ({
        filepath: evaluation.subject.filepath,
        result: evaluation.result,
      })),
    })), [{
      name: 'source',
      status: 'violation',
      evaluations: [{ filepath: 'input.txt', result: { status: 'violation', message: 'Source SDK policy' } }],
    }]);
  };
  assertSourceReport(runSourceCli(['check', '--json'], options));
  assert.equal(existsSync(join(directory, 'node_modules')), false, 'SDK-only loading must not need editor links');
  const synced = runSourceCli(['deps', 'sync'], options);
  assert.equal(synced.status, 0, `${synced.stdout}\n${synced.stderr}`);
  assert.equal(synced.stdout, `Rule dependencies ready: ${directory}\n`);
  assert.equal(synced.stderr, '');
  const sdk = join(directory, 'node_modules', PACKAGE_NAME);
  assert.equal((await lstat(sdk)).isSymbolicLink(), true);
  assert.equal(await realpath(sdk), REPO_ROOT);
  assertSourceReport(runSourceCli(['check', '--json'], options));
  assert.equal(existsSync(join(directory, 'coderuler.lock')), false);
  assert.equal(existsSync(join(home, 'dependency-cache')), false);
  assert.equal(existsSync(join(cwd, 'node_modules')), false);
});

test('the source CLI adds managed packages without a local SDK and checks and tests their real imports through tsx', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'coderuler-source-deps-'));
  cleanupPaths.push(root);
  const cwd = join(root, 'app');
  const home = join(root, 'home');
  const directory = join(cwd, '.coderuler');
  await mkdir(directory, { recursive: true });
  await mkdir(home);
  const manifest = '{"type":"module"}\n';
  await writeFile(join(cwd, 'package.json'), manifest);
  await writeFile(join(cwd, 'input.txt'), 'BAD\n');
  await writeFile(join(directory, 'policy.rule.ts'), `import { Rule, pass, test, violation } from '@alex-dbs/coderuler';
import { message } from 'fixture-policy';
export default class Policy extends Rule {
  files = ['input.txt'];
  check = subject => subject.source.includes('BAD') ? violation(message) : pass();
}
export const tests = [
  test('source policy passes').withFiles({ 'input.txt': 'GOOD' }).passes(),
  test('source policy violates').withFiles({ 'input.txt': 'BAD' }).violates(),
];
`);
  const registry = createDependencyFixture(join(root, 'registry'), fixturePackages().filter(fixture =>
    ['fixture-policy', 'fixture-shared'].includes(fixture.manifest.name) && fixture.manifest.version === '1.0.0'));
  const options = { cwd, home, registry };
  assert.equal(existsSync(join(directory, 'node_modules')), false);
  assert.equal(existsSync(join(cwd, 'node_modules')), false);
  const added = runSourceCli(['deps', 'add', 'fixture-policy@1.0.0'], { ...options, mode: 'all' });
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  assert.equal(added.stdout, `Added fixture-policy@1.0.0\n${join(directory, 'coderuler.lock')}\n`);
  assert.equal(added.stderr, '');
  assert.equal(await realpath(join(directory, 'node_modules', PACKAGE_NAME)), REPO_ROOT);
  for (const name of ['fixture-policy', 'fixture-shared']) {
    const installed = join(directory, 'node_modules', name);
    assert.equal((await lstat(installed)).isDirectory(), true);
    assert.equal((await lstat(installed)).isSymbolicLink(), false);
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert.equal(installedManifest.name, name);
    assert.equal(installedManifest.version, '1.0.0');
  }
  const committed = await readFile(join(directory, 'coderuler.lock'), 'utf8');
  const checked = runSourceCli(['check', '--json'], options);
  assert.equal(checked.status, 1, `${checked.stdout}\n${checked.stderr}`);
  assert.equal(checked.stderr, '');
  assert.deepEqual(parseReport(checked.stdout).map(entry => ({
    name: entry.name,
    status: entry.status,
    evaluations: entry.evaluations.map(evaluation => ({
      filepath: evaluation.subject.filepath,
      result: evaluation.result,
    })),
  })), [{
    name: 'policy',
    status: 'violation',
    evaluations: [{ filepath: 'input.txt', result: { status: 'violation', message: POLICY_MESSAGE_V1 } }],
  }]);
  const tested = runSourceCli(['test', '--concurrency', '2'], options);
  assert.equal(tested.status, 0, `${tested.stdout}\n${tested.stderr}`);
  assert.match(tested.stdout, /2 passed, 0 failed/);
  assert.equal(await readFile(join(directory, 'coderuler.lock'), 'utf8'), committed);
  assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), manifest);
  assert.equal(existsSync(join(cwd, 'node_modules')), false);
  assert.equal(existsSync(join(cwd, 'package-lock.json')), false);
});

test('the packed tarball ships the built package and bundled authoring skill', () => {
  const { packedPaths } = consumer;
  assert.ok(packedPaths.includes('package.json'), `package.json missing from tarball: ${packedPaths.join(', ')}`);
  assert.ok(packedPaths.includes('dist/index.js'), `dist/index.js missing from tarball: ${packedPaths.join(', ')}`);
  assert.ok(packedPaths.includes('dist/index.d.ts'), `dist/index.d.ts missing from tarball: ${packedPaths.join(', ')}`);
  assert.ok(packedPaths.includes('dist/cli.js'), `dist/cli.js missing from tarball: ${packedPaths.join(', ')}`);
  assert.ok(packedPaths.includes('skills/coderuler-new-rule/SKILL.md'), 'SKILL.md missing from tarball');
  assert.ok(packedPaths.includes('skills/coderuler-new-rule/reference.md'), 'skill reference missing from tarball');
  for (const path of packedPaths) {
    assert.ok(isPackagedEntry(path), `unexpected tarball entry: ${path}`);
    assert.ok(!/(^|\/)(old|src|tests|benchmarks|scripts|docs|node_modules|coverage|\.coderuler)(\/|$)/.test(path), `archived or source path packed: ${path}`);
    assert.ok(!/(^|\/)\.env(\.|$)/.test(path), `credential file packed: ${path}`);
    assert.ok(!path.endsWith('.ts') || path.endsWith('.d.ts'), `TypeScript source packed: ${path}`);
  }
});

test('the installed package is importable through its public entry with no repository self-reference', async () => {
  const probe = run(process.execPath, ['probe.mjs'], { cwd: consumer.app, env: isolatedEnv(consumer.cleanHome) });
  assert.equal(probe.status, 0, probe.stderr);
  const result = parseJsonOutput<ProbeResult>(probe.stdout);
  const installedRoot = join(consumer.app, 'node_modules', PACKAGE_NAME);
  assert.equal(result.resolved, pathToFileURL(join(installedRoot, 'dist', 'index.js')).href);
  assert.ok(!result.resolved.includes(REPO_ROOT), `resolution fell back to the repository: ${result.resolved}`);
  assert.deepEqual([...result.selectors], ['astGrep', 'csv', 'file', 'json', 'protobuf', 'yaml']);
  assert.equal(result.ruleIsFunction, true);
  assert.equal(result.brand, true);
  assert.deepEqual([...result.helpers], ['function', 'function', 'function', 'function']);
  assert.equal(result.registrations, 'function');

  const appManifest = parseJsonOutput<{ readonly dependencies: Readonly<Record<string, string>> }>(
    await readFile(join(consumer.app, 'package.json'), 'utf8'),
  );
  const spec = appManifest.dependencies[PACKAGE_NAME];
  assert.ok(spec !== undefined && spec.startsWith('file:') && spec.endsWith('.tgz'), `consumer must depend on the packed tarball, got ${String(spec)}`);
  assert.ok(!spec.includes(REPO_ROOT), `consumer must not depend on the repository path: ${spec}`);
});

test('the installed package carries executable dist declarations, a runnable bin, and the authoring skill', async () => {
  const installedRoot = join(consumer.app, 'node_modules', PACKAGE_NAME);
  const installedPhysical = await realpath(installedRoot);
  assert.ok(installedPhysical.startsWith(consumer.root), `installed package escapes the temp root: ${installedPhysical}`);
  const files = await listFiles(installedRoot);
  for (const file of files) {
    assert.ok(isPackagedEntry(file), `unexpected installed file: ${file}`);
    assert.ok(!file.endsWith('.ts') || file.endsWith('.d.ts'), `TypeScript source installed: ${file}`);
  }
  assert.ok(files.includes(join('dist', 'index.d.ts')), `missing declaration: ${files.join(', ')}`);
  assert.ok(files.includes(join('dist', 'cli.js')), `missing CLI entry: ${files.join(', ')}`);

  const manifest = parseJsonOutput<InstalledManifest>(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.types, './dist/index.d.ts');
  assert.deepEqual([...manifest.files], ['dist', 'skills/coderuler-new-rule']);
  assert.equal(manifest.dependencies['skills'], '1.7.2');
  const entry = manifest.exports['.'];
  assert.ok(entry !== undefined, 'package exports must declare the public entry');
  assert.equal(entry.import, './dist/index.js');
  assert.equal(entry.types, './dist/index.d.ts');

  const bin = join(consumer.app, 'node_modules', '.bin', 'coderuler');
  assert.ok(existsSync(bin), `installed bin missing at ${bin}`);
  assert.notEqual(statSync(bin).mode & 0o111, 0, 'installed bin is not executable');
});

test('the installed authoring skill preserves its companion reference and relative link', async () => {
  const bundled = join(consumer.app, 'node_modules', PACKAGE_NAME, 'skills', 'coderuler-new-rule');
  const source = join(REPO_ROOT, 'skills', 'coderuler-new-rule');
  const skill = await readFile(join(bundled, 'SKILL.md'), 'utf8');
  const reference = await readFile(join(bundled, 'reference.md'), 'utf8');
  assert.equal(skill, await readFile(join(source, 'SKILL.md'), 'utf8'));
  assert.equal(reference, await readFile(join(source, 'reference.md'), 'utf8'));
  assert.match(skill, /\]\((?:\.\/)?reference\.md\)/);
});

test('consumer environments override ambient Claude configuration with the isolated home', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = join(consumer.root, 'ambient-claude-config');
    const home = join(consumer.root, 'isolated-claude-home');
    assert.equal(isolatedEnv(home).CLAUDE_CONFIG_DIR, join(home, '.claude'));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('the released CLI installs and refreshes its bundled skill outside the repository without a skills binary on PATH', async () => {
  const project = join(consumer.root, 'skill-project');
  const home = join(consumer.root, 'skill-home');
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  const extra = { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
  const bundled = join(consumer.app, 'node_modules', PACKAGE_NAME, 'skills', 'coderuler-new-rule');
  const installed = join(project, '.claude', 'skills', 'coderuler-new-rule');
  const install = runCli(consumer.app, ['skill', 'install', '--agent', 'claude-code', '--yes', '--copy'], {
    cwd: project, home, extra,
  });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  for (const file of ['SKILL.md', 'reference.md']) {
    assert.equal(await readFile(join(installed, file), 'utf8'), await readFile(join(bundled, file), 'utf8'));
  }
  const lock = await readFile(join(project, 'skills-lock.json'), 'utf8');
  assert.ok(lock.includes('node_modules/@alex-dbs/coderuler/skills/coderuler-new-rule'), `skill source must point into the installed package: ${lock}`);
  assert.ok(!lock.includes(REPO_ROOT), `skill source must not point at the repository: ${lock}`);

  const unrelated = join(project, '.claude', 'skills', 'unrelated', 'SKILL.md');
  await mkdir(dirname(unrelated), { recursive: true });
  await writeFile(unrelated, '---\nname: unrelated\ndescription: unrelated skill\n---\nLeave this alone.\n');
  await writeFile(join(installed, 'reference.md'), 'stale reference\n');
  const update = runCli(consumer.app, ['skill', 'update', '--project', '--agent', 'claude-code', '--copy'], {
    cwd: project, home, extra,
  });
  assert.equal(update.status, 0, `${update.stdout}\n${update.stderr}`);
  assert.equal(await readFile(join(installed, 'reference.md'), 'utf8'), await readFile(join(bundled, 'reference.md'), 'utf8'));
  assert.equal(await readFile(unrelated, 'utf8'), '---\nname: unrelated\ndescription: unrelated skill\n---\nLeave this alone.\n');
  assert.ok(!existsSync(join(home, '.claude', 'skills', 'coderuler-new-rule')), 'project commands must not install globally');
});

test('the released CLI installs and refreshes the bundled skill globally from an unrelated cwd', async () => {
  const project = join(consumer.root, 'global-skill-project');
  const home = join(consumer.root, 'global-skill-home');
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  const extra = { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
  const args = ['--global', '--agent', 'universal', '--copy'];
  const install = runCli(consumer.app, ['skill', 'install', ...args, '--yes'], { cwd: project, home, extra });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const installed = join(home, '.agents', 'skills', 'coderuler-new-rule');
  await writeFile(join(installed, 'reference.md'), 'stale global reference\n');
  const update = runCli(consumer.app, ['skill', 'update', ...args], { cwd: project, home, extra });
  assert.equal(update.status, 0, `${update.stdout}\n${update.stderr}`);
  const bundled = join(consumer.app, 'node_modules', PACKAGE_NAME, 'skills', 'coderuler-new-rule');
  assert.equal(await readFile(join(installed, 'reference.md'), 'utf8'), await readFile(join(bundled, 'reference.md'), 'utf8'));
  assert.ok(!existsSync(join(project, '.agents', 'skills', 'coderuler-new-rule')), 'global commands must not install in the project');
});

test('the installed CLI runs a TypeScript rule on real files and reports pass by exit 0', () => {
  const runResult = runCli(consumer.app, ['check', 'src/clean.ts', '--rules', '.coderuler/license.rule.ts', '--json', '--output-all'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
    extra: { RK_BACKEND: 'not-a-real-backend', TYPESAFE_DEFAULT_MODEL: '' },
  });
  assert.equal(runResult.status, 0, runResult.stderr);
  const report = parseReport(runResult.stdout);
  const entry = reportFor(report, 'license');
  assert.equal(entry.status, 'pass');
  assert.equal(relative(consumer.app, entry.ruleFile), join('.coderuler', 'license.rule.ts'));
  assert.equal(entry.evaluations.length, 1);
  assert.equal(entry.evaluations[0]?.subject.filepath, 'src/clean.ts');
  assert.equal(entry.evaluations[0]?.result.status, 'pass');
});

test('the installed CLI reports a violation from a TypeScript rule with exit 1', () => {
  const runResult = runCli(consumer.app, ['check', 'src/headerless.ts', '--rules', '.coderuler/license.rule.ts', '--json'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
  });
  assert.equal(runResult.status, 1, runResult.stderr);
  const report = parseReport(runResult.stdout);
  const entry = reportFor(report, 'license');
  assert.equal(entry.status, 'violation');
  const evaluation = entry.evaluations[0];
  assert.ok(evaluation !== undefined, 'violation report must carry an evaluation');
  assert.equal(evaluation.subject.filepath, 'src/headerless.ts');
  assert.equal(evaluation.result.status, 'violation');
  assert.equal(evaluation.result.message, 'Missing copyright header');
});

test('the installed CLI human output names the violating file and message before exiting 1', () => {
  const runResult = runCli(consumer.app, ['check', 'src/headerless.ts', '--rules', '.coderuler/license.rule.ts'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
  });
  assert.equal(runResult.status, 1, runResult.stderr);
  assert.match(runResult.stdout, /src\/headerless\.ts/);
  assert.match(runResult.stdout, /Missing copyright header/);
});

test('the installed CLI loads a plain JavaScript rule through a bare package import', () => {
  const violation = runCli(consumer.app, ['check', 'src/no-export.ts', '--rules', '.coderuler/contract.rule.js', '--json'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
  });
  assert.equal(violation.status, 1, violation.stderr);
  const entry = reportFor(parseReport(violation.stdout), 'contract');
  assert.equal(entry.status, 'violation');
  assert.equal(entry.evaluations[0]?.subject.filepath, 'src/no-export.ts');
  assert.equal(entry.evaluations[0]?.result.message, 'Source files must export a const or function');

  const passing = runCli(consumer.app, ['check', 'src/clean.ts', '--rules', '.coderuler/contract.rule.js', '--json', '--output-all'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
  });
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(reportFor(parseReport(passing.stdout), 'contract').status, 'pass');
});

test('the installed CLI discovers both rules, ignores the helper module, and validates them', () => {
  const check = runCli(consumer.app, ['check', '.', '--json', '--output-all'], { cwd: consumer.app, home: consumer.cleanHome });
  assert.equal(check.status, 1, check.stderr);
  const report = parseReport(check.stdout);
  assert.deepEqual(
    report.map((entry) => entry.name).sort(),
    ['contract', 'license'],
  );
  for (const entry of report) {
    assert.equal(entry.status, 'violation', `${entry.name} should violate under the fixture sources`);
    assert.ok(entry.ruleFile.startsWith(consumer.app), `rule file outside the project: ${entry.ruleFile}`);
    for (const evaluation of entry.evaluations) {
      assert.ok(!(evaluation.subject.filepath ?? '').startsWith('.coderuler/'), `rule file was selected as a source: ${String(evaluation.subject.filepath)}`);
    }
  }

  const validate = runCli(consumer.app, ['validate', '.coderuler'], { cwd: consumer.app, home: consumer.cleanHome });
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /Valid rule: license/);
  assert.match(validate.stdout, /Valid rule: contract/);
});

test('the installed CLI runs in a project without Git or repository metadata', () => {
  assert.equal(existsSync(join(consumer.gitless, '.git')), false);
  assert.equal(existsSync(join(consumer.app, '.git')), false);
  const runResult = runCli(
    consumer.app,
    ['check', '.', '--rules', join(consumer.app, '.coderuler', 'license.rule.ts'), '--json'],
    { cwd: consumer.gitless, home: consumer.cleanHome },
  );
  assert.equal(runResult.status, 1, runResult.stderr);
  const entry = reportFor(parseReport(runResult.stdout), 'license');
  assert.equal(entry.evaluations[0]?.subject.filepath, 'src/bare.ts');
  assert.equal(entry.evaluations[0]?.result.status, 'violation');
});

test('the globally installed CLI loads rules without local dependencies while the SDK resolves its own YAML parser', () => {
  assert.equal(existsSync(join(consumer.globalApp, 'node_modules')), false, 'the global fixture project must not carry local dependencies');
  const result = runGlobalCli(['test', '--concurrency', '2'], {
    cwd: consumer.globalApp,
    home: consumer.globalHome,
    extra: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const name of ['global pass', 'global violation', 'home global pass', 'home global violation']) {
    assert.ok(result.stdout.includes(name), `${name} missing from output: ${result.stdout}`);
  }
  assert.match(result.stdout, /4 passed, 0 failed/);
});

test('the globally installed CLI prefers the project-local SDK and acquires locked ESM/CommonJS dependencies independently', async () => {
  const directory = join(consumer.localPreferenceApp, '.coderuler');
  const lockPath = join(directory, 'coderuler.lock');
  const committedLock = await readFile(lockPath, 'utf8');
  const applicationManifest = await readFile(join(consumer.localPreferenceApp, 'package.json'), 'utf8');
  const localSdk = join(consumer.localPreferenceApp, 'node_modules', PACKAGE_NAME, 'dist/index.js');
  const localSdkSource = await readFile(localSdk, 'utf8');
  const requestLog = join(consumer.root, 'preference-requests.jsonl');
  const cache = join(consumer.root, 'preference-cache');
  assert.equal(existsSync(join(consumer.localPreferenceApp, '.coderuler', 'node_modules', 'yaml')), false);
  const result = runGlobalCli(['test'], {
    cwd: consumer.localPreferenceApp,
    home: consumer.missingHome,
    extra: {
      DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
      RK_DEPENDENCY_CACHE: cache, RK_DEPENDENCY_REQUEST_LOG: requestLog,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /project-local SDK and dependency case/);
  assert.match(result.stdout, /project-local SDK parses YAML with its own dependency/);
  assert.match(result.stdout, /2 passed, 0 failed/);
  assert.equal(await readFile(lockPath, 'utf8'), committedLock, 'loading must not rewrite the committed dependency graph');
  const requests = (await readFile(requestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; path: string });
  assert.deepEqual(requests, [{ kind: 'tarball', path: '/yaml/-/yaml-1.0.0.tgz' }]);
  const managedYaml = join(directory, 'node_modules', 'yaml');
  assert.equal(await realpath(managedYaml), managedYaml);
  assert.equal((await lstat(managedYaml)).isDirectory(), true);
  assert.equal((await lstat(managedYaml)).isSymbolicLink(), false);
  assert.equal(await readFile(join(consumer.localPreferenceApp, 'package.json'), 'utf8'), applicationManifest);
  assert.equal(await readFile(localSdk, 'utf8'), localSdkSource);
  assert.deepEqual(await readdir(join(consumer.localPreferenceApp, 'node_modules')), ['@alex-dbs'], 'acquisition must preserve the existing user SDK without installing application dependencies');
  await rm(cache, { recursive: true });
  const offline = runGlobalCli(['test', '--concurrency', '2'], {
    cwd: consumer.localPreferenceApp,
    home: consumer.missingHome,
    extra: {
      ...dependencyFixtureEnvironment(consumer.registry, { mode: 'offline' }),
      RK_DEPENDENCY_CACHE: cache,
    },
  });
  assert.equal(offline.status, 0, `${offline.stdout}\n${offline.stderr}`);
  assert.match(offline.stdout, /2 passed, 0 failed/);
  assert.equal(existsSync(cache), false, 'installed packed CLI loading must not recreate the download cache');
  assert.equal(await readFile(lockPath, 'utf8'), committedLock);
});

test('the packed CLI installs typed rule packages locally, repairs them offline, and leaves application files untouched', async () => {
  const app = join(consumer.root, 'packed-managed-app');
  const home = join(consumer.root, 'packed-managed-home');
  const directory = join(app, '.coderuler');
  const cache = join(consumer.root, 'packed-managed-downloads');
  await mkdir(app, { recursive: true });
  await mkdir(home, { recursive: true });
  const manifest = '{"name":"packed-managed-consumer","private":true,"type":"module"}\n';
  await writeFile(join(app, 'package.json'), manifest);
  const added = runGlobalCli(['deps', 'add', '@fixture/typed@1.0.0'], {
    cwd: app, home,
    extra: {
      ...dependencyFixtureEnvironment(consumer.registry, { mode: 'all' }),
      RK_DEPENDENCY_CACHE: cache,
    },
  });
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  assert.equal(added.stdout, `Added @fixture/typed@1.0.0
${join(directory, 'coderuler.lock')}
`);
  assert.equal(added.stderr, '');
  const committed = await readFile(join(directory, 'coderuler.lock'), 'utf8');
  const offline = {
    ...dependencyFixtureEnvironment(consumer.registry, { mode: 'offline' }),
    RK_DEPENDENCY_CACHE: cache,
  };
  const synced = runGlobalCli(['deps', 'sync'], { cwd: app, home, extra: offline });
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(synced.stdout, `Rule dependencies ready: ${directory}\n`);
  const typedPackage = join(directory, 'node_modules/@fixture/typed');
  assert.equal((await lstat(typedPackage)).isDirectory(), true);
  assert.equal((await lstat(typedPackage)).isSymbolicLink(), false);
  const filename = join(directory, 'typed.rule.ts');
  const source = `import { Rule, violation } from '@alex-dbs/coderuler';
import { format } from '@fixture/typed';
export default class Typed extends Rule {
  files = ['input.txt'];
  check = () => violation(format('packed'));
}
`;
  await writeFile(filename, source);
  await writeFile(join(app, 'input.txt'), 'input\n');
  const tsc = join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
  const compilerArguments = [tsc, '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2024', '--skipLibCheck', filename];
  const valid = run(process.execPath, compilerArguments, { cwd: app, env: isolatedEnv(home) });
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  await writeFile(filename, source.replace("format('packed')", 'format(42)'));
  const invalid = run(process.execPath, compilerArguments, { cwd: app, env: isolatedEnv(home) });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /Argument of type 'number' is not assignable to parameter of type 'string'/);
  await writeFile(filename, source);
  await rm(typedPackage, { recursive: true });
  const repaired = runGlobalCli(['deps', 'sync'], { cwd: app, home, extra: offline });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal((await lstat(typedPackage)).isDirectory(), true);
  assert.equal(await readFile(join(directory, 'coderuler.lock'), 'utf8'), committed);
  await rm(cache, { recursive: true });
  const checked = runGlobalCli(['check', '--json'], { cwd: app, home, extra: offline });
  assert.equal(checked.status, 1, `${checked.stdout}\n${checked.stderr}`);
  assert.equal(checked.stderr, '');
  assert.equal(reportFor(parseReport(checked.stdout), 'typed').status, 'violation');
  assert.equal(reportFor(parseReport(checked.stdout), 'typed').evaluations[0]?.result.message, 'esm:packed');
  assert.equal(existsSync(cache), false);
  const removed = runGlobalCli(['deps', 'remove', '@fixture/typed'], { cwd: app, home, extra: offline });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.stdout, `Removed @fixture/typed
${join(directory, 'coderuler.lock')}
`);
  assert.equal(existsSync(typedPackage), false);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'coderuler.lock'), 'utf8')).packages[''].dependencies ?? {}, {});
  assert.equal(await readFile(join(app, 'package.json'), 'utf8'), manifest);
  for (const untouched of ['node_modules', 'package-lock.json', 'tsconfig.json']) {
    assert.equal(existsSync(join(app, untouched)), false, `rule dependency commands must not create application ${untouched}`);
  }
});

test('the globally installed CLI does not resolve direct bare rule imports from its own packages', () => {
  const result = runGlobalCli(['validate', '.coderuler/direct-yaml.rule.mjs'], {
    cwd: consumer.globalIsolationApp,
    home: consumer.missingHome,
    extra: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.ok(!result.stderr.includes(consumer.globalModules), `rule imports must not reach the CLI installation: ${result.stderr}`);
});

test('the globally installed CLI rejects an application package when the rule has no dependency lock', async () => {
  const app = consumer.ambientApp;
  const manifest = await readFile(join(app, 'package.json'), 'utf8');
  const available = run(process.execPath, ['--input-type=module', '-e', "import { parse } from 'yaml'; process.stdout.write(parse('').localYamlMarker);"], {
    cwd: app, env: isolatedEnv(consumer.missingHome),
  });
  assert.equal(available.status, 0, available.stderr);
  assert.equal(available.stdout, 'fixture-managed-yaml-esm', 'the ambient copy must otherwise be importable by the application');
  const result = runGlobalCli(['validate', '.coderuler/direct-yaml.rule.mjs'], { cwd: app, home: consumer.missingHome });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.ok(!result.stderr.includes(consumer.globalModules), `rule imports must not reach the CLI installation: ${result.stderr}`);
  assert.equal(existsSync(join(app, '.coderuler', 'coderuler.lock')), false, 'loading must not synthesize a dependency lock');
  assert.equal(await readFile(join(app, 'package.json'), 'utf8'), manifest);
});

test('the globally installed CLI does not resolve bare helper require calls from its own packages', () => {
  const result = runGlobalCli(['validate', '.coderuler/required-yaml.rule.mjs'], {
    cwd: consumer.globalIsolationApp,
    home: consumer.missingHome,
    extra: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.ok(!result.stderr.includes(consumer.globalModules), `helper require calls must not reach the CLI installation: ${result.stderr}`);
});

test('the globally installed CLI does not resolve packages required by user dependencies', () => {
  const result = runGlobalCli(['validate', '.coderuler/borrower.rule.mjs'], {
    cwd: consumer.globalIsolationApp,
    home: consumer.missingHome,
    extra: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.ok(!result.stderr.includes(consumer.globalModules), `user dependencies must not reach the CLI installation: ${result.stderr}`);
});

test('the globally installed CLI reports bare imports missing from the rule location as failures', () => {
  const result = runGlobalCli(['validate', '.coderuler/broken.rule.mjs'], {
    cwd: consumer.missingImportApp,
    home: consumer.missingHome,
    extra: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /@alex-dbs\/coderuler-fixture-missing/);
  assert.ok(!result.stderr.includes(consumer.globalModules), `missing imports must not reach the CLI installation: ${result.stderr}`);
});

test('the globally installed CLI keeps missing relative rule imports relative to the rule file', () => {
  const cliRules = join(consumer.globalModules, PACKAGE_NAME, 'dist', 'adapter', 'filesystem', 'rules.js');
  assert.ok(existsSync(cliRules), `relative-boundary regression fixture missing at ${cliRules}`);
  const result = runGlobalCli(['validate', '.coderuler/missing-relative.rule.mjs'], {
    cwd: consumer.missingImportApp,
    home: consumer.missingHome,
    extra: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.ok(
    result.stderr.includes(join(consumer.missingImportApp, '.coderuler', 'rules.js')),
    `${result.stderr}\nrelative import must resolve beside the rule, not inside the CLI package`,
  );
});

test('the globally installed CLI enforces managed package export maps for ESM imports and CommonJS requires', () => {
  for (const filename of ['restricted.rule.mjs', 'required-restricted.rule.mjs']) {
    const result = runGlobalCli(['validate', `.coderuler/${filename}`], {
      cwd: consumer.missingImportApp,
      home: consumer.missingHome,
      extra: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' },
    });
    assert.equal(result.status, 2, `${filename}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /(?:yaml\/util|['"]\.\/util['"])/);
    assert.ok(!result.stderr.includes(consumer.globalModules), `private subpaths must not reach the CLI installation: ${result.stderr}`);
  }
});

test('no statistics database or rule cache is created under the isolated home', async () => {
  const leftovers = await listFiles(consumer.cleanHome);
  assert.deepEqual([...leftovers], []);
});

test('a typed consumer compiles against the installed declarations with the repository TypeScript', () => {
  const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  assert.ok(existsSync(tsc), `repository TypeScript missing at ${tsc}`);
  const compile = run(
    process.execPath,
    [
      tsc,
      '--noEmit',
      '--strict',
      '--target',
      'es2024',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--skipLibCheck',
      '--noUncheckedIndexedAccess',
      '--exactOptionalPropertyTypes',
      '--noUnusedLocals',
      '--noUnusedParameters',
      '--verbatimModuleSyntax',
      'typed-consumer.ts',
    ],
    { cwd: consumer.app, env: isolatedEnv(consumer.cleanHome) },
  );
  assert.equal(compile.status, 0, `${compile.stdout}${compile.stderr}`);
  assert.doesNotMatch(compile.stdout, /error TS/, compile.stdout);
});

test('a home rule extending a separate physical SDK copy loads in the project CLI through the shared brand', () => {
  const identity = run(process.execPath, ['identity.mjs'], { cwd: consumer.app, env: isolatedEnv(consumer.cleanHome) });
  assert.equal(identity.status, 0, identity.stderr);
  const classes = parseJsonOutput<IdentityResult>(identity.stdout);
  assert.equal(classes.sameClass, false, 'the two SDK copies must be physically distinct modules');
  assert.equal(classes.appBrand, true);
  assert.equal(classes.copyBrand, true);
  assert.equal(classes.crossInstanceof, false);

  const runResult = runCli(consumer.app, ['check', '.', '--json'], { cwd: consumer.homeApp, home: consumer.ruleHome });
  assert.equal(runResult.status, 1, runResult.stderr);
  const report = parseReport(runResult.stdout);
  assert.deepEqual(
    report.map((entry) => entry.name),
    ['home'],
  );
  const entry = reportFor(report, 'home');
  assert.equal(relative(consumer.ruleHome, entry.ruleFile), join('.coderuler', 'home.rule.mjs'));
  assert.equal(entry.status, 'violation');
  assert.equal(entry.evaluations[0]?.subject.filepath, 'src/thing.ts');
  assert.equal(entry.evaluations[0]?.result.message, 'Home rule: missing copyright header');
});
