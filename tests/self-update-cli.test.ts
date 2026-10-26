import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { test } from 'node:test';

import { createSandbox, isolatedEnv, ROOT, runCli } from './support.ts';

const PACKAGE = '@alex-dbs/coderuler';
const OLD_VERSION = '71.2.3';
const NEW_VERSION = '72.3.4';

interface Result {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Result> {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<Result>();
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text; });
  child.once('error', reject);
  child.once('close', status => resolveResult({ status, stdout, stderr }));
  return promise;
}

async function npmCli(): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try {
      const executable = await realpath(join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm'));
      const cli = process.platform === 'win32'
        ? join(dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : executable;
      await access(cli);
      return cli;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('The self-update consumer tests require npm on PATH');
}

function globalRoot(prefix: string): string {
  return process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
}

function installedPackage(prefix: string): string {
  return join(globalRoot(prefix), '@alex-dbs', 'coderuler');
}

test('installed CLI versions and global self-updates stay within the active npm installation', { timeout: 180_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coderuler-self-update-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const app = join(root, 'app');
  const fixture = join(root, 'fixture');
  for (const directory of [home, app, fixture]) await mkdir(directory, { recursive: true });
  const appManifest = '{"name":"unrelated-application","private":true,"version":"99.8.7"}\n';
  const appLock = '{"lockfileVersion":3,"packages":{}}\n';
  await writeFile(join(app, 'package.json'), appManifest);
  await writeFile(join(app, 'package-lock.json'), appLock);
  await writeFile(join(app, '.env'), 'TYPESAFE_API_KEY=not-a-real-key\n');
  await cp(join(ROOT, 'dist'), join(fixture, 'dist'), { recursive: true });
  const env = isolatedEnv(home);
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_config_')) delete env[key];
  }
  Object.assign(env, {
    npm_config_cache: join(root, 'cache'),
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_globalconfig: join(home, 'global.npmrc'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0',
  });
  const npm = await npmCli();
  const pack = async (version: string): Promise<string> => {
    await writeFile(join(fixture, 'package.json'), JSON.stringify({
      name: PACKAGE, version, type: 'module', bin: { coderuler: 'dist/cli.js' }, files: ['dist'],
    }));
    const result = await run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts'], fixture, env);
    assert.equal(result.status, 0, result.stderr);
    const packed = JSON.parse(result.stdout) as { filename: string }[];
    return join(fixture, packed[0]!.filename);
  };
  const oldTarball = await pack(OLD_VERSION);
  const newTarball = await readFile(await pack(NEW_VERSION));
  const requests: string[] = [];
  let forbidden = false;
  let registry = '';
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (forbidden) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'self-update fixture forbids installation' }));
      return;
    }
    if (request.url === '/coderuler.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(newTarball);
      return;
    }
    if (decodeURIComponent(request.url ?? '').toLowerCase() === `/${PACKAGE}`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        name: PACKAGE,
        'dist-tags': { latest: NEW_VERSION },
        versions: { [NEW_VERSION]: {
          name: PACKAGE, version: NEW_VERSION, type: 'module', bin: { coderuler: 'dist/cli.js' },
          dist: {
            tarball: `${registry}/coderuler.tgz`,
            integrity: `sha512-${createHash('sha512').update(newTarball).digest('base64')}`,
          },
        } },
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  t.after(() => {
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    return closed.promise;
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  registry = `http://127.0.0.1:${address.port}`;
  await writeFile(join(home, '.npmrc'), `registry=${registry}\n`);

  const install = async (label: string): Promise<string> => {
    const prefix = join(root, label);
    const result = await run(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--ignore-scripts', oldTarball], app, env);
    assert.equal(result.status, 0, result.stderr);
    await symlink(join(ROOT, 'node_modules'), join(globalRoot(prefix), '@alex-dbs', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return prefix;
  };
  const active = await install('active-prefix');
  const other = await install('other-prefix');
  const cli = (packageRoot: string, args: readonly string[], overrides: NodeJS.ProcessEnv = {}) =>
    run(process.execPath, [join(packageRoot, 'dist', 'cli.js'), ...args], app, { ...env, npm_config_prefix: active, ...overrides });
  const version = async (prefix: string, expected: string): Promise<void> => {
    const result = await cli(installedPackage(prefix), ['--version'], { PATH: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${expected}\n`);
    assert.equal(result.stderr, '');
  };

  await t.test('version reads installed metadata without npm or rules, including -V', async t => {
    await mkdir(join(app, '.coderuler'));
    await writeFile(join(app, '.coderuler', 'broken.ts'), 'throw new Error("rules must not load");');
    await rm(join(app, '.env'));
    await mkdir(join(app, '.env'));
    t.after(() => rm(join(app, '.env'), { recursive: true, force: true }));
    await version(active, OLD_VERSION);
    const result = await cli(installedPackage(active), ['-V'], { PATH: '' });
    assert.deepEqual(result, { status: 0, stdout: `${OLD_VERSION}\n`, stderr: '' });
    assert.equal(requests.length, 0);
  });

  await t.test('local and inactive-global copies refuse without changing either global copy', async () => {
    const local = join(app, 'node_modules', '@alex-dbs', 'coderuler');
    await mkdir(dirname(local), { recursive: true });
    await cp(fixture, local, { recursive: true, filter: source => !source.endsWith('.tgz') });
    const manifest = JSON.parse(await readFile(join(local, 'package.json'), 'utf8')) as { version: string };
    manifest.version = OLD_VERSION;
    await writeFile(join(local, 'package.json'), JSON.stringify(manifest));
    await symlink(join(ROOT, 'node_modules'), join(local, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await cli(local, ['update']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /npm install --save-dev @alex-dbs\/coderuler@latest/);
    const linkedPrefix = join(root, 'linked-prefix');
    const linkedPackage = installedPackage(linkedPrefix);
    await mkdir(dirname(linkedPackage), { recursive: true });
    await symlink(local, linkedPackage, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await cli(local, ['update'], { npm_config_prefix: linkedPrefix });
    assert.equal(linked.status, 2, linked.stderr);
    assert.match(linked.stderr, /npm install --save-dev @alex-dbs\/coderuler@latest/);
    const inactive = await cli(installedPackage(other), ['update']);
    assert.equal(inactive.status, 2, inactive.stderr);
    assert.match(inactive.stderr, /global|installation/i);
    const source = await cli(ROOT, ['update']);
    assert.equal(source.status, 2, source.stderr);
    assert.match(source.stderr, /npm install/);
    assert.equal(requests.length, 0);
    await version(active, OLD_VERSION);
    await version(other, OLD_VERSION);
  });

  await t.test('real npm update changes only the running global copy and preserves user registry configuration', async () => {
    await writeFile(join(home, '.npmrc'), `registry=${registry}\nprefix=${active}\n`);
    const result = await cli(installedPackage(active), ['update'], {
      npm_config_prefix: undefined,
      npm_config_userconfig: relative(app, join(home, '.npmrc')),
    });
    assert.equal(result.status, 0, result.stderr);
    await version(active, NEW_VERSION);
    await version(other, OLD_VERSION);
    assert.equal(await readFile(join(app, 'package.json'), 'utf8'), appManifest);
    assert.equal(await readFile(join(app, 'package-lock.json'), 'utf8'), appLock);
    const localManifest = JSON.parse(await readFile(join(app, 'node_modules', '@alex-dbs', 'coderuler', 'package.json'), 'utf8')) as { version: string };
    assert.equal(localManifest.version, OLD_VERSION);
  });

  await t.test('npm registry failures propagate a nonzero status without changing installed metadata', async () => {
    const failure = await install('failure-prefix');
    forbidden = true;
    const result = await cli(installedPackage(failure), ['update'], { npm_config_prefix: failure, npm_config_cache: join(root, 'failure-cache') });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /403|forbids installation/);
    await version(failure, OLD_VERSION);
    assert.equal(await readFile(join(app, 'package.json'), 'utf8'), appManifest);
    assert.equal(await readFile(join(app, 'package-lock.json'), 'utf8'), appLock);
  });
});

test('a version-named check target still loads the project environment', async t => {
  const sandbox = createSandbox('coderuler-version-target-');
  t.after(() => sandbox.cleanup());
  const target = sandbox.isolated('check');
  await mkdir(join(target.cwd, '.coderuler'));
  await writeFile(join(target.cwd, '.env'), 'CODERULER_TEST_VALUE=loaded\n');
  await writeFile(join(target.cwd, '--version'), 'selected content\n');
  await writeFile(join(target.cwd, '.coderuler', 'environment.rule.ts'), `
import { Rule, pass, violation } from '@alex-dbs/coderuler';
export default class Environment extends Rule {
  files = ['--version'];
  check = () => process.env.CODERULER_TEST_VALUE === 'loaded'
    ? pass() : violation('Project environment was not loaded');
}
`);
  const result = await runCli(['check', '--json', '--output-all', '--', '--version'], target, {
    CODERULER_TEST_VALUE: undefined,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    reports: { name: string; evaluations: { result: { status: string } }[] }[];
  };
  assert.equal(output.reports.find(report => report.name === 'environment')?.evaluations[0]?.result.status, 'pass');
});
