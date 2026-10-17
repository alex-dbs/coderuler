import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const PACKAGE_NAME = 'rulekeeper';
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
  readonly name: string;
  readonly type: string;
  readonly types: string;
  readonly exports: Readonly<Record<string, { readonly types?: string; readonly import?: string }>>;
  readonly bin: Readonly<Record<string, string>>;
  readonly files: readonly string[];
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
}

const SHARED_HELPER_SOURCE = `export const LICENSE_PATTERN = /Copyright ..../;
`;

const LICENSE_RULE_SOURCE = `import { Rule, regex } from 'rulekeeper';
import { LICENSE_PATTERN } from './helpers/shared.js';

export default class LicenseRule extends Rule {
  files = ['src/*.ts'];
  check = regex({ pattern: LICENSE_PATTERN, violationMessage: 'Missing copyright header' });
}
`;

const CONTRACT_RULE_SOURCE = `import { Rule, regex } from 'rulekeeper';

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
} from 'rulekeeper';

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

const PROBE_SOURCE = `import { Rule, ai, regex, pass, violation, scopes, createAstGrepLanguageRegistrations } from 'rulekeeper';

const brand = Symbol.for('rulekeeper.Rule');
process.stdout.write(JSON.stringify({
  resolved: import.meta.resolve('rulekeeper'),
  selectors: Object.keys(scopes).sort(),
  ruleIsFunction: typeof Rule === 'function',
  brand: Rule.prototype[brand] === true,
  helpers: [ai, regex, pass, violation].map((value) => typeof value),
  registrations: typeof createAstGrepLanguageRegistrations,
}));
`;

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

const CREDENTIAL_PREFIXES = ['RK_', 'TYPESAFE_'];
const PROXY_KEYS: Readonly<Record<string, true>> = {
  http_proxy: true,
  https_proxy: true,
  no_proxy: true,
  all_proxy: true,
};

function isolatedEnv(home: string, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
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
  env.PATH = dirname(process.execPath);
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function runCli(app: string, args: readonly string[], options: { readonly cwd: string; readonly home: string; readonly extra?: Readonly<Record<string, string>> }): RunResult {
  const bin = join(app, 'node_modules', '.bin', PACKAGE_NAME);
  assert.ok(existsSync(bin), `installed CLI missing at ${bin}`);
  const env = options.extra === undefined ? isolatedEnv(options.home) : isolatedEnv(options.home, options.extra);
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
  assert.ok(Array.isArray(parsed), `check --json must print a bare array: ${stdout}`);
  return parsed as readonly ReportEntry[];
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
    "import { Rule } from 'rulekeeper';",
    `const copy = await import('${indexUrl}');`,
    "const brand = Symbol.for('rulekeeper.Rule');",
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
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rulekeeper-consumer-'));
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

  await mkdir(app, { recursive: true });
  await mkdir(join(app, '.rulekeeper', 'helpers'), { recursive: true });
  await mkdir(join(app, 'src'), { recursive: true });
  await mkdir(join(homeApp, 'src'), { recursive: true });
  await mkdir(join(ruleHome, '.rulekeeper'), { recursive: true });
  await mkdir(join(gitless, 'src'), { recursive: true });
  await mkdir(cleanHome, { recursive: true });

  const relativeTarball = relative(app, tarball).split(sep).join('/');
  await writeFile(
    join(app, 'package.json'),
    `${JSON.stringify({ name: 'rulekeeper-consumer', private: true, type: 'module', dependencies: { [PACKAGE_NAME]: `file:${relativeTarball}` } }, null, 2)}\n`,
  );
  await writeFile(join(app, '.rulekeeper', 'helpers', 'shared.js'), SHARED_HELPER_SOURCE);
  await writeFile(join(app, '.rulekeeper', 'license.rule.ts'), LICENSE_RULE_SOURCE);
  await writeFile(join(app, '.rulekeeper', 'contract.rule.js'), CONTRACT_RULE_SOURCE);
  await writeFile(join(app, 'src', 'clean.ts'), HEADERED_SOURCE);
  await writeFile(join(app, 'src', 'headerless.ts'), HEADERLESS_SOURCE);
  await writeFile(join(app, 'src', 'no-export.ts'), NO_EXPORT_SOURCE);
  await writeFile(join(app, 'typed-consumer.ts'), TYPED_CONSUMER_SOURCE);
  await writeFile(join(app, 'probe.mjs'), PROBE_SOURCE);
  await writeFile(join(homeApp, 'src', 'thing.ts'), HEADERLESS_SOURCE);
  await writeFile(join(gitless, 'src', 'bare.ts'), HEADERLESS_SOURCE);

  const install = runNpm(['install', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel', 'error'], app, DEFAULT_TIMEOUT);
  assert.equal(install.status, 0, `npm install failed: ${install.stderr}`);
  assert.ok(existsSync(join(app, 'node_modules', PACKAGE_NAME, 'dist', 'index.js')), 'installed package is missing dist/index.js');

  await mkdir(dirname(vendorSdk), { recursive: true });
  await cp(join(app, 'node_modules', PACKAGE_NAME), vendorSdk, { recursive: true, dereference: true });

  const vendorIndex = join(vendorSdk, 'dist', 'index.js');
  assert.ok(existsSync(vendorIndex), `separate SDK copy missing at ${vendorIndex}`);
  await writeFile(join(ruleHome, '.rulekeeper', 'home.rule.mjs'), homeRuleSource(pathToFileURL(vendorIndex).href));
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
  };
});

test('the packed tarball ships only the built package', () => {
  const { packedPaths } = consumer;
  assert.ok(packedPaths.includes('package.json'), `package.json missing from tarball: ${packedPaths.join(', ')}`);
  assert.ok(packedPaths.includes('dist/index.js'), `dist/index.js missing from tarball: ${packedPaths.join(', ')}`);
  assert.ok(packedPaths.includes('dist/index.d.ts'), `dist/index.d.ts missing from tarball: ${packedPaths.join(', ')}`);
  assert.ok(packedPaths.includes('dist/cli.js'), `dist/cli.js missing from tarball: ${packedPaths.join(', ')}`);
  for (const path of packedPaths) {
    assert.ok(isPackagedEntry(path), `unexpected tarball entry: ${path}`);
    assert.ok(!/(^|\/)(old|src|tests|benchmarks|scripts|docs|node_modules|coverage|\.rulekeeper)(\/|$)/.test(path), `archived or source path packed: ${path}`);
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

test('the installed package carries only executable dist declarations and a runnable bin', async () => {
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
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.types, './dist/index.d.ts');
  assert.deepEqual([...manifest.files], ['dist']);
  const entry = manifest.exports['.'];
  assert.ok(entry !== undefined, 'package exports must declare the public entry');
  assert.equal(entry.import, './dist/index.js');
  assert.equal(entry.types, './dist/index.d.ts');
  assert.equal(manifest.bin[PACKAGE_NAME], './dist/cli.js');

  const bin = join(consumer.app, 'node_modules', '.bin', PACKAGE_NAME);
  assert.ok(existsSync(bin), `installed bin missing at ${bin}`);
  assert.notEqual(statSync(bin).mode & 0o111, 0, 'installed bin is not executable');
});

test('the installed CLI runs a TypeScript rule on real files and reports pass by exit 0', () => {
  const runResult = runCli(consumer.app, ['check', 'src/clean.ts', '--rules', '.rulekeeper/license.rule.ts', '--json'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
    extra: { RK_BACKEND: 'not-a-real-backend', TYPESAFE_DEFAULT_MODEL: '' },
  });
  assert.equal(runResult.status, 0, runResult.stderr);
  const report = parseReport(runResult.stdout);
  const entry = reportFor(report, 'license');
  assert.equal(entry.status, 'pass');
  assert.equal(relative(consumer.app, entry.ruleFile), join('.rulekeeper', 'license.rule.ts'));
  assert.equal(entry.evaluations.length, 1);
  assert.equal(entry.evaluations[0]?.subject.filepath, 'src/clean.ts');
  assert.equal(entry.evaluations[0]?.result.status, 'pass');
});

test('the installed CLI reports a violation from a TypeScript rule with exit 1', () => {
  const runResult = runCli(consumer.app, ['check', 'src/headerless.ts', '--rules', '.rulekeeper/license.rule.ts', '--json'], {
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
  const runResult = runCli(consumer.app, ['check', 'src/headerless.ts', '--rules', '.rulekeeper/license.rule.ts'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
  });
  assert.equal(runResult.status, 1, runResult.stderr);
  assert.match(runResult.stdout, /src\/headerless\.ts/);
  assert.match(runResult.stdout, /Missing copyright header/);
});

test('the installed CLI loads a plain JavaScript rule through a bare package import', () => {
  const violation = runCli(consumer.app, ['check', 'src/no-export.ts', '--rules', '.rulekeeper/contract.rule.js', '--json'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
  });
  assert.equal(violation.status, 1, violation.stderr);
  const entry = reportFor(parseReport(violation.stdout), 'contract');
  assert.equal(entry.status, 'violation');
  assert.equal(entry.evaluations[0]?.subject.filepath, 'src/no-export.ts');
  assert.equal(entry.evaluations[0]?.result.message, 'Source files must export a const or function');

  const passing = runCli(consumer.app, ['check', 'src/clean.ts', '--rules', '.rulekeeper/contract.rule.js', '--json'], {
    cwd: consumer.app,
    home: consumer.cleanHome,
  });
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(reportFor(parseReport(passing.stdout), 'contract').status, 'pass');
});

test('the installed CLI discovers both rules, ignores the helper module, and validates them', () => {
  const check = runCli(consumer.app, ['check', '.', '--json'], { cwd: consumer.app, home: consumer.cleanHome });
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
      assert.ok(!(evaluation.subject.filepath ?? '').startsWith('.rulekeeper/'), `rule file was selected as a source: ${String(evaluation.subject.filepath)}`);
    }
  }

  const validate = runCli(consumer.app, ['validate', '.rulekeeper'], { cwd: consumer.app, home: consumer.cleanHome });
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /Valid rule: license/);
  assert.match(validate.stdout, /Valid rule: contract/);
});

test('the installed CLI runs in a project without Git or repository metadata', () => {
  assert.equal(existsSync(join(consumer.gitless, '.git')), false);
  assert.equal(existsSync(join(consumer.app, '.git')), false);
  const runResult = runCli(
    consumer.app,
    ['check', '.', '--rules', join(consumer.app, '.rulekeeper', 'license.rule.ts'), '--json'],
    { cwd: consumer.gitless, home: consumer.cleanHome },
  );
  assert.equal(runResult.status, 1, runResult.stderr);
  const entry = reportFor(parseReport(runResult.stdout), 'license');
  assert.equal(entry.evaluations[0]?.subject.filepath, 'src/bare.ts');
  assert.equal(entry.evaluations[0]?.result.status, 'violation');
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
  assert.equal(relative(consumer.ruleHome, entry.ruleFile), join('.rulekeeper', 'home.rule.mjs'));
  assert.equal(entry.status, 'violation');
  assert.equal(entry.evaluations[0]?.subject.filepath, 'src/thing.ts');
  assert.equal(entry.evaluations[0]?.result.message, 'Home rule: missing copyright header');
});
