import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { LoadedRule, RuleSelection } from '../dist/app/ports.js';
import { createRuleDependencyManager, type PreparedRuleDependencies, type RuleDependencyManager } from '../dist/adapter/filesystem/dependencies.js';
import { getRuleDependencies } from '../dist/adapter/filesystem/rule-resolution.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';
import { runRuleTests } from '../dist/adapter/filesystem/rule-tests.js';
import type { RuleTestWorkerMessage, RuleTestWorkerRequest } from '../dist/adapter/filesystem/rule-test-worker.js';
import { createDependencyFixture, fixturePackages, installDependencyRegistry, POLICY_MESSAGE_V1, POLICY_MESSAGE_V2, type RegistryRequest } from './dependency-support.ts';

let root: string;
let manager: RuleDependencyManager;
let registry: { readonly requests: readonly RegistryRequest[]; close(): void };
const locks = new Map<number, string>();
let sequence = 0;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'coderuler-resolution-')));
  const fixture = createDependencyFixture(join(root, 'registry'), [
    ...fixturePackages(),
    {
      manifest: {
        name: 'fixture-exports', version: '1.0.0', type: 'module',
        exports: { '.': './index.js', './part': './part.js' },
        imports: { '#internal': './internal.js' },
        dependencies: { '@fixture/typed': '1.0.0' },
      },
      files: {
        'index.js': "import { format } from '@fixture/typed'; import { internal } from '#internal'; import { part } from 'fixture-exports/part'; export const value = format(internal + ':' + part);\n",
        'internal.js': "export const internal = 'package';\n",
        'part.js': "export const part = 'part';\n",
      },
    },
    {
      manifest: { name: 'fixture-borrower', version: '1.0.0', type: 'module', main: './index.js' },
      files: { 'index.js': "export { format } from '@fixture/typed';\n" },
    },
  ]);
  registry = installDependencyRegistry(fixture);
  manager = createRuleDependencyManager({ cacheRoot: join(root, 'cache') });
  for (const version of [1, 2]) {
    const directory = join(root, `template-${version}`, '.coderuler');
    await mkdir(directory, { recursive: true });
    await manager.change(directory, 'add', [`fixture-policy@${version}.0.0`, '@fixture/typed@1.0.0']);
    locks.set(version, await readFile(join(directory, 'coderuler.lock'), 'utf8'));
  }
});

after(async () => {
  registry?.close();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function put(file: string, source: string): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source);
  return file;
}

async function project(label: string, version?: number): Promise<string> {
  const directory = join(root, `${++sequence}-${label}`);
  await mkdir(join(directory, '.coderuler'), { recursive: true });
  await put(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  if (version !== undefined) {
    const lock = locks.get(version);
    assert.ok(lock);
    await put(join(directory, '.coderuler', 'coderuler.lock'), lock);
  }
  return directory;
}

function selection(directory: string): RuleSelection {
  return { root: directory, invocationCwd: directory };
}

async function installedDependencies(directory: string): Promise<PreparedRuleDependencies> {
  const owner = join(directory, '.coderuler');
  const dependencies = await manager.prepare(owner);
  for (const name of dependencies.directDependencies) {
    const stats = await lstat(join(owner, 'node_modules', name));
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.isSymbolicLink(), false);
  }
  return dependencies;
}

async function loadPrepared(directory: string, dependencies: PreparedRuleDependencies): Promise<readonly LoadedRule[]> {
  return createRuleLoader({ home: join(root, 'empty-home'), preparedDependencies: dependencies }).load(selection(directory));
}

function observed(entry: LoadedRule | undefined): unknown {
  assert.ok(entry);
  return Reflect.get(entry.rule, 'observed');
}

function rule(imports: string, expression: string): string {
  return `import { Rule, pass } from '@alex-dbs/coderuler';
${imports}
export default class ContextRule extends Rule {
  files = ['**/*.txt'];
  observed = ${expression};
  check = () => pass();
}
`;
}

function errorText(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) messages.push(current.message);
  return messages.join(' | ');
}

async function rejects(run: () => Promise<unknown>, ...patterns: readonly RegExp[]): Promise<void> {
  await assert.rejects(run, error => {
    const text = errorText(error);
    assert.ok(text.length > 0, String(error));
    for (const pattern of patterns) assert.match(text, pattern);
    return true;
  });
}

test('ESM and real CommonJS helpers select distinct conditional exports from owner-local packages', async () => {
  const directory = await project('conditions', 1);
  const owner = join(directory, '.coderuler');
  await put(join(directory, 'external', 'helper.cjs'), "exports.value = require('@fixture/typed').format('helper');\n");
  await put(join(owner, 'conditional.rule.mjs'), rule(
    "import { format } from '@fixture/typed'; import helper from '../external/helper.cjs'; import { message } from 'fixture-policy';",
    "[format('direct'), helper.value, message]",
  ));
  const dependencies = await installedDependencies(directory);
  const requests = registry.requests.length;
  const loaded = await loadPrepared(directory, dependencies);
  assert.deepEqual(observed(loaded[0]), ['esm:direct', 'cjs:helper', POLICY_MESSAGE_V1]);
  assert.equal(registry.requests.length, requests, 'resolution uses the local installation without acquisition');
  assert.equal(existsSync(join(owner, 'node_modules')), true);
});

for (const commonjs of [false, true]) {
  test(`an application's package self-reference cannot shadow a managed ${commonjs ? 'CommonJS require' : 'ESM import'}`, async () => {
    const directory = await project(`app-self-reference-${commonjs}`, 1);
    const owner = join(directory, '.coderuler');
    const marker = join(directory, 'app-executed');
    await put(join(directory, 'package.json'), JSON.stringify({
      name: '@fixture/typed', version: '99.0.0', type: 'module',
      exports: { '.': { import: './app.js', require: './app.cjs' } },
    }));
    await put(join(directory, 'app.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export const format = () => 'application';\n`);
    await put(join(directory, 'app.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.format = () => 'application';\n`);
    if (commonjs) await put(join(directory, 'external', 'helper.cjs'), "exports.value = require('@fixture/typed').format('managed');\n");
    await put(join(owner, 'self-reference.rule.mjs'), rule(
      commonjs ? "import helper from '../external/helper.cjs';" : "import { format } from '@fixture/typed';",
      commonjs ? 'helper.value' : "format('managed')",
    ));
    const dependencies = await installedDependencies(directory);
    const loaded = await loadPrepared(directory, dependencies);
    assert.equal(observed(loaded[0]), commonjs ? 'cjs:managed' : 'esm:managed');
    assert.equal(existsSync(marker), false, 'application self-reference code must not execute');
  });
}

for (const commonjs of [false, true]) {
  test(`private export-map subpaths fail for ${commonjs ? 'CommonJS require' : 'ESM import'}`, async () => {
    const directory = await project(`private-${commonjs}`, 1);
    if (commonjs) await put(join(directory, '.coderuler', 'private.cjs'), "module.exports = require('@fixture/typed/private.js');\n");
    await put(join(directory, '.coderuler', 'private.rule.mjs'), rule(
      commonjs ? "import './private.cjs';" : "import '@fixture/typed/private.js';", 'null',
    ));
    const dependencies = await installedDependencies(directory);
    await rejects(() => loadPrepared(directory, dependencies), /private\.js/, /export/i);
  });
}

for (const [locked, commonjs] of [[false, false], [false, true], [true, false], [true, true]] as const) {
  test(`undeclared application packages cannot be borrowed by ${commonjs ? 'CommonJS' : 'ESM'} ${locked ? 'with a different declared dependency' : 'without a lock'}`, async () => {
    const directory = await project(`ambient-${locked}-${commonjs}`, locked ? 1 : undefined);
    await put(join(directory, 'node_modules', 'ambient-only', 'package.json'), JSON.stringify({
      name: 'ambient-only', type: 'module', exports: { import: './index.js', require: './index.cjs' },
    }));
    const marker = join(directory, 'ambient-executed');
    await put(join(directory, 'node_modules', 'ambient-only', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export const value = true;\n`);
    await put(join(directory, 'node_modules', 'ambient-only', 'index.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.value = true;\n`);
    if (commonjs) await put(join(directory, '.coderuler', 'ambient.cjs'), "exports.value = require('ambient-only').value;\n");
    await put(join(directory, '.coderuler', 'ambient.rule.mjs'), rule(
      commonjs ? "import { value } from './ambient.cjs';" : "import { value } from 'ambient-only';", 'value',
    ));
    const dependencies = await installedDependencies(directory);
    await rejects(() => loadPrepared(directory, dependencies), /ambient-only/, /coderuler deps add ambient-only/);
    assert.equal(existsSync(marker), false);
    if (!locked) {
      assert.equal(dependencies.key, 'empty');
      assert.equal(existsSync(join(directory, '.coderuler', 'coderuler.lock')), false);
    }
  });
}

test('a rule-test companion cannot borrow an undeclared application package', async () => {
  const directory = await project('ambient-test-companion');
  await put(join(directory, 'node_modules', 'ambient-only', 'package.json'), JSON.stringify({
    name: 'ambient-only', type: 'module', exports: './index.js',
  }));
  const marker = join(directory, 'ambient-test-executed');
  await put(join(directory, 'node_modules', 'ambient-only', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export const value = true;\n`);
  await put(join(directory, '.coderuler', 'ambient.rule.mjs'), rule('', 'null'));
  await put(join(directory, '.coderuler', 'ambient.test.mjs'), `import { test } from '@alex-dbs/coderuler';
import { value } from 'ambient-only';
export const tests = [test('ambient package').withFiles({ 'input.txt': String(value) }).passes()];
`);
  const dependencies = await installedDependencies(directory);
  const loaded = await loadPrepared(directory, dependencies);
  await rejects(() => runRuleTests(loaded, undefined, 10_000, 1), /ambient-only/, /undeclared|declar|dependency/i);
  assert.equal(existsSync(marker), false, 'undeclared application package code must not execute');
});

test('a transitive dependency is not a direct rule import even when hoisted in local node_modules', async () => {
  const directory = await project('transitive-boundary', 1);
  await put(join(directory, '.coderuler', 'transitive.rule.mjs'), rule("import { message } from 'fixture-shared';", 'message'));
  await rejects(() => installedDependencies(directory).then(dependencies => loadPrepared(directory, dependencies)), /fixture-shared/, /coderuler deps add fixture-shared/);
});

test('the CLI installation does not supply undeclared runtime packages to a CommonJS helper', async () => {
  const directory = await project('cli-isolation');
  await put(join(directory, '.coderuler', 'helper.cjs'), "module.exports = require('yaml');\n");
  await put(join(directory, '.coderuler', 'yaml.rule.mjs'), rule("import helper from './helper.cjs';", 'helper'));
  const dependencies = await installedDependencies(directory);
  await rejects(() => loadPrepared(directory, dependencies), /yaml/, /coderuler deps add yaml/);
});

test('relative, file URL and package #imports helpers retain the real rule context outside its owner directory', async () => {
  const directory = await project('helper-context', 1);
  const fileHelper = await put(join(directory, 'file-helper', 'value.mjs'), "import { format } from '@fixture/typed'; export const value = format('file');\n");
  await put(join(directory, 'relative-helper', 'value.mjs'), "import { format } from '@fixture/typed'; export const value = format('relative');\n");
  await put(join(directory, 'import-helper', 'value.mjs'), "import { format } from '@fixture/typed'; export const value = format('imports');\n");
  await put(join(directory, 'package.json'), JSON.stringify({
    type: 'module', imports: { '#context': './import-helper/value.mjs', '#declared': '@fixture/typed' },
  }));
  await put(join(directory, '.coderuler', 'helpers.rule.mjs'), rule(
    `import { value as relative } from '../relative-helper/value.mjs'; import { value as file } from ${JSON.stringify(pathToFileURL(fileHelper).href)}; import { value as contextual } from '#context'; import { format } from '#declared';`,
    "[relative, file, contextual, format('alias')]",
  ));
  const dependencies = await installedDependencies(directory);
  const loaded = await loadPrepared(directory, dependencies);
  assert.deepEqual(observed(loaded[0]), ['esm:relative', 'esm:file', 'esm:imports', 'esm:alias']);
});
test('rule #imports cannot disguise an undeclared application dependency', async () => {
  const directory = await project('ambient-imports', 1);
  await put(join(directory, 'package.json'), JSON.stringify({ type: 'module', imports: { '#ambient': 'ambient-only' } }));
  await put(join(directory, 'node_modules', 'ambient-only', 'package.json'), JSON.stringify({ name: 'ambient-only', type: 'module', exports: './index.js' }));
  await put(join(directory, 'node_modules', 'ambient-only', 'index.js'), 'export const value = "ambient";\n');
  await put(join(directory, '.coderuler', 'imports.rule.mjs'), rule("import { value } from '#ambient';", 'value'));
  const dependencies = await installedDependencies(directory);
  await rejects(() => loadPrepared(directory, dependencies), /ambient|#ambient/i, /declar|managed|tree|dependency/i);
});

for (const local of [false, true]) {
  for (const sync of [false, true]) {
    test(`SDK #imports retain supported public export selection with ${local ? 'an installed local SDK' : 'the running SDK fallback'} ${sync ? 'after explicit sync' : 'without a lock or editor links'}`, async () => {
      const directory = await project(`sdk-imports-${local}-${sync}`, sync ? 1 : undefined);
      const owner = join(directory, '.coderuler');
      const metadata = JSON.stringify({
        type: 'commonjs',
        imports: {
          '#sdk': '@alex-dbs/coderuler',
          '#conditional': { import: '@alex-dbs/coderuler', require: './helpers/conditional.cjs' },
          '#require-conditional': { import: './helpers/conditional.mjs', require: '@alex-dbs/coderuler' },
          '#sdk-array': ['../invalid-target', '@alex-dbs/coderuler'],
          '#sdk-pattern/*': '@alex-dbs/coderuler',
        },
      });
      await put(join(directory, 'package.json'), metadata);
      if (local) {
        const sdk = join(directory, 'node_modules', '@alex-dbs', 'coderuler');
        const running = new URL('../dist/index.js', import.meta.url);
        await put(join(sdk, 'package.json'), JSON.stringify({
          name: '@alex-dbs/coderuler', version: '9.8.7', type: 'module',
          exports: { '.': { import: './index.js', require: './index.cjs' } },
        }));
        await put(join(sdk, 'index.js'), `export * from ${JSON.stringify(running.href)}; export const selectedSdk = 'local-esm';\n`);
        await put(join(sdk, 'index.cjs'), `Object.assign(exports, require(${JSON.stringify(fileURLToPath(running))}), { selectedSdk: 'local-cjs' });\n`);
      }
      await put(join(directory, 'helpers', 'conditional.mjs'), "export const value = 'helper-esm';\n");
      await put(join(directory, 'helpers', 'conditional.cjs'), "exports.value = 'helper-cjs';\n");
      await put(join(directory, 'helpers', 'alias.mjs'), "import * as sdk from '#sdk'; export const value = sdk.selectedSdk ?? 'running';\n");
      await put(join(directory, 'helpers', 'alias.cjs'), "exports.value = require('#sdk').selectedSdk ?? 'running';\n");
      await put(join(owner, 'esm.rule.mjs'), `import { Rule, pass } from '#sdk';
import { Rule as DirectRule } from '@alex-dbs/coderuler';
import * as sdk from '#sdk';
import * as conditional from '#conditional';
import * as alternative from '#require-conditional';
import * as array from '#sdk-array';
import * as pattern from '#sdk-pattern/public';
import { value } from '../helpers/alias.mjs';
export default class extends Rule {
  files = ['**/*.txt'];
  observed = { selected: sdk.selectedSdk ?? 'running', direct: Rule === DirectRule, conditional: conditional.Rule === Rule, alternative: alternative.value, array: array.Rule === Rule, pattern: pattern.Rule === Rule, helper: value };
  check = () => pass();
}
`);
      // An absent SDK supports the existing absolute-entry fallback. Once sync
      // exposes the running package, its import-only exports prohibit require.
      if (local || !sync) await put(join(owner, 'cjs.rule.js'), `const sdk = require('#sdk');
const { Rule, pass } = sdk;
const direct = require('@alex-dbs/coderuler');
const conditional = require('#require-conditional');
const alternative = require('#conditional');
const array = require('#sdk-array');
const pattern = require('#sdk-pattern/public');
const helper = require('../helpers/alias.cjs');
module.exports = class extends Rule {
  files = ['**/*.txt'];
  observed = { selected: sdk.selectedSdk ?? 'running', direct: Rule === direct.Rule, conditional: conditional.Rule === Rule, alternative: alternative.value, array: array.Rule === Rule, pattern: pattern.Rule === Rule, helper: helper.value };
  check = () => pass();
};
`);
      const dependencies = sync ? await manager.sync(owner) : await manager.prepare(owner);
      assert.equal(dependencies.key === 'empty', !sync);
      assert.equal(existsSync(join(owner, 'coderuler.lock')), sync);
      assert.equal(existsSync(join(owner, 'node_modules')), sync);
      if (sync) assert.equal((await lstat(join(owner, 'node_modules', '@alex-dbs', 'coderuler'))).isSymbolicLink(), true);
      const loaded = await loadPrepared(directory, dependencies);
      assert.equal(loaded.length, local || !sync ? 2 : 1);
      for (const entry of loaded) {
        const commonjs = entry.name === 'cjs';
        const selected = local ? `local-${commonjs ? 'cjs' : 'esm'}` : 'running';
        assert.deepEqual(observed(entry), {
          selected, direct: true, conditional: true, alternative: `helper-${commonjs ? 'cjs' : 'esm'}`,
          array: true, pattern: true, helper: selected,
        });
      }
      assert.equal(await readFile(join(directory, 'package.json'), 'utf8'), metadata, 'resolution leaves project metadata unchanged');
    });
  }
}

for (const specifier of ['@alex-dbs/coderuler', '#sdk']) {
  test(`CommonJS ${specifier} preserves the running SDK's unavailable require export after sync`, async () => {
    const directory = await project(`sdk-require-exports-${specifier.startsWith('#') ? 'alias' : 'direct'}`);
    const owner = join(directory, '.coderuler');
    await put(join(directory, 'package.json'), JSON.stringify({
      type: 'commonjs', imports: { '#sdk': '@alex-dbs/coderuler' },
    }));
    await put(join(owner, 'require.rule.js'), `const { Rule, pass } = require(${JSON.stringify(specifier)});
module.exports = class extends Rule {
  files = ['**/*.txt'];
  check = () => pass();
};
`);
    const dependencies = await manager.sync(owner);
    assert.equal((await lstat(join(owner, 'node_modules', '@alex-dbs', 'coderuler'))).isSymbolicLink(), true);
    await assert.rejects(() => loadPrepared(directory, dependencies), error => {
      for (let current = error; current instanceof Error; current = current.cause) {
        if ((current as NodeJS.ErrnoException).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
          assert.match(current.message, /@alex-dbs[/\\]coderuler/);
          return true;
        }
      }
      assert.fail(`Expected Node's package exports error, received: ${errorText(error)}`);
    });
  });
}

for (const commonjs of [false, true]) {
  test(`SDK #imports do not exempt private subpaths for ${commonjs ? 'CommonJS' : 'ESM'}`, async () => {
    const directory = await project(`sdk-private-alias-${commonjs}`);
    await put(join(directory, 'package.json'), JSON.stringify({
      type: 'module', imports: { '#sdk-private': '@alex-dbs/coderuler/private' },
    }));
    const sdk = join(directory, 'node_modules', '@alex-dbs', 'coderuler');
    await put(join(sdk, 'package.json'), JSON.stringify({
      name: '@alex-dbs/coderuler', type: 'module',
      exports: { '.': './index.js', './private': { import: './private.js', require: './private.cjs' } },
    }));
    await put(join(sdk, 'index.js'), `export * from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};\n`);
    const marker = join(directory, 'sdk-private-executed');
    await put(join(sdk, 'private.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export const value = true;\n`);
    await put(join(sdk, 'private.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.value = true;\n`);
    if (commonjs) await put(join(directory, 'helpers', 'private.cjs'), "exports.value = require('#sdk-private').value;\n");
    await put(join(directory, '.coderuler', 'private.rule.mjs'), rule(
      commonjs ? "import { value } from '../helpers/private.cjs';" : "import { value } from '#sdk-private';", 'value',
    ));
    const dependencies = await installedDependencies(directory);
    await rejects(() => loadPrepared(directory, dependencies), /@alex-dbs\/coderuler/, /not declared/);
    assert.equal(existsSync(marker), false);
  });
}

test('CommonJS #imports select the require condition and local CJS exports', async () => {
  const directory = await project('cjs-declared-imports', 1);
  await put(join(directory, 'package.json'), JSON.stringify({
    type: 'module',
    imports: { '#declared': { import: 'fixture-policy', require: '@fixture/typed' } },
  }));
  await put(join(directory, 'helpers', 'alias.cjs'), "exports.value = require('#declared').format('conditional-alias');\n");
  await put(join(directory, '.coderuler', 'imports.rule.mjs'), rule(
    "import helper from '../helpers/alias.cjs';", 'helper.value',
  ));
  const dependencies = await installedDependencies(directory);
  const requests = registry.requests.length;
  const loaded = await loadPrepared(directory, dependencies);
  assert.equal(observed(loaded[0]), 'cjs:conditional-alias');
  assert.equal(existsSync(join(directory, '.coderuler', 'node_modules')), true);
  assert.equal(registry.requests.length, requests);
});

test('CommonJS #imports cannot borrow an app-installed package through a conditional alias', async () => {
  const directory = await project('cjs-ambient-imports', 1);
  await put(join(directory, 'package.json'), JSON.stringify({
    type: 'module',
    imports: { '#ambient': { import: '@fixture/typed', require: 'ambient-only' } },
  }));
  const marker = join(directory, 'ambient-alias-executed');
  await put(join(directory, 'node_modules', 'ambient-only', 'package.json'), JSON.stringify({
    name: 'ambient-only', exports: './index.cjs',
  }));
  await put(join(directory, 'node_modules', 'ambient-only', 'index.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.value = 'ambient';\n`,
  );
  await put(join(directory, 'helpers', 'alias.cjs'), "exports.value = require('#ambient').value;\n");
  await put(join(directory, '.coderuler', 'imports.rule.mjs'), rule(
    "import helper from '../helpers/alias.cjs';", 'helper.value',
  ));
  const dependencies = await installedDependencies(directory);
  await rejects(() => loadPrepared(directory, dependencies), /ambient/i);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(directory, '.coderuler', 'node_modules')), true);
});

for (const commonjs of [false, true]) {
  test(`an empty dependency context rejects ${commonjs ? 'CommonJS' : 'ESM'} #imports to an app-linked workspace package`, async () => {
    const directory = await project(`empty-workspace-alias-${commonjs}`);
    await put(join(directory, 'package.json'), JSON.stringify({
      type: 'module', imports: { '#ambient': 'ambient-only' },
    }));
    const workspace = join(directory, 'workspace', 'ambient-only');
    const marker = join(directory, 'workspace-package-executed');
    await put(join(workspace, 'package.json'), JSON.stringify({
      name: 'ambient-only', type: 'module', exports: { import: './index.js', require: './index.cjs' },
    }));
    await put(join(workspace, 'index.js'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export const value = 'workspace';\n`,
    );
    await put(join(workspace, 'index.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.value = 'workspace';\n`,
    );
    await mkdir(join(directory, 'node_modules'), { recursive: true });
    await symlink(workspace, join(directory, 'node_modules', 'ambient-only'), 'dir');
    if (commonjs) await put(join(directory, 'helpers', 'alias.cjs'), "exports.value = require('#ambient').value;\n");
    await put(join(directory, '.coderuler', 'workspace.rule.mjs'), rule(
      commonjs ? "import { value } from '../helpers/alias.cjs';" : "import { value } from '#ambient';", 'value',
    ));
    const dependencies = await installedDependencies(directory);
    assert.equal(dependencies.key, 'empty');
    await rejects(() => loadPrepared(directory, dependencies), /ambient-only/, /not declared/i);
    assert.equal(existsSync(marker), false, 'an app-linked workspace is not a contextual rule helper');
    assert.equal(existsSync(join(directory, '.coderuler', 'coderuler.lock')), false);
  });
}

for (const commonjs of [false, true]) {
  test(`managed ${commonjs ? 'CommonJS' : 'ESM'} #imports expose the original package.json as data without authorizing its dependencies`, async () => {
    const directory = await project(`original-metadata-${commonjs}`, 1);
    const manifest = {
      name: 'workspace-application',
      version: '7.2.1',
      type: 'module',
      imports: { '#metadata': './package.json' },
      policyConfiguration: { threshold: 17, labels: ['original', 'application'] },
      dependencies: { 'ambient-only': '1.0.0' },
    };
    await put(join(directory, 'package.json'), JSON.stringify(manifest));
    if (commonjs) await put(join(directory, 'helpers', 'metadata.cjs'),
      "exports.metadata = require('#metadata'); exports.value = require('@fixture/typed').format('metadata');\n",
    );
    await put(join(directory, '.coderuler', 'metadata.rule.mjs'), rule(
      commonjs
        ? "import { metadata, value } from '../helpers/metadata.cjs';"
        : "import metadata from '#metadata' with { type: 'json' }; import { format } from '@fixture/typed'; const value = format('metadata');",
      '{ metadata, value }',
    ));
    const dependencies = await installedDependencies(directory);
    const loaded = await loadPrepared(directory, dependencies);
    assert.deepEqual(observed(loaded[0]), { metadata: manifest, value: `${commonjs ? 'cjs' : 'esm'}:metadata` });
    assert.equal(existsSync(join(directory, '.coderuler', 'node_modules')), true);

    const marker = join(directory, 'manifest-dependency-executed');
    await put(join(directory, 'node_modules', 'ambient-only', 'package.json'), JSON.stringify({
      name: 'ambient-only', type: 'module', exports: { import: './index.js', require: './index.cjs' },
    }));
    await put(join(directory, 'node_modules', 'ambient-only', 'index.js'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export const value = 'ambient';\n`,
    );
    await put(join(directory, 'node_modules', 'ambient-only', 'index.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.value = 'ambient';\n`,
    );
    if (commonjs) await put(join(directory, 'helpers', 'undeclared.cjs'), "exports.value = require('ambient-only').value;\n");
    await put(join(directory, '.coderuler', 'undeclared.rule.mjs'), rule(
      commonjs ? "import { value } from '../helpers/undeclared.cjs';" : "import { value } from 'ambient-only';", 'value',
    ));
    await rejects(() => loadPrepared(directory, dependencies), /ambient-only/, /not declared/i);
    assert.equal(existsSync(marker), false);
  });
}

test('missing relative helpers remain relative to the rule rather than the CLI or installed packages', async () => {
  const directory = await project('missing-relative', 1);
  const missing = join(directory, '.coderuler', 'missing-helper.mjs');
  await put(join(directory, '.coderuler', 'missing.rule.mjs'), `import { Rule, pass } from '@alex-dbs/coderuler';\nimport './missing-helper.mjs';\nexport default class Missing extends Rule {\n  files = ['*.txt'];\n  check = () => pass();\n}\n`);
  const dependencies = await installedDependencies(directory);
  await rejects(() => loadPrepared(directory, dependencies), new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('managed packages retain their own relative, #imports, self and declared dependency resolution', async () => {
  const directory = await project('package-context');
  await manager.change(join(directory, '.coderuler'), 'add', ['fixture-exports@1.0.0']);
  await put(join(directory, '.coderuler', 'package.rule.mjs'), rule("import { value } from 'fixture-exports';", 'value'));
  const dependencies = await installedDependencies(directory);
  const loaded = await loadPrepared(directory, dependencies);
  assert.equal(observed(loaded[0]), 'esm:package:part');
});

test('a managed package cannot borrow an undeclared dependency merely because another direct package installed it', async () => {
  const directory = await project('package-ambient');
  await manager.change(join(directory, '.coderuler'), 'add', ['fixture-borrower@1.0.0', '@fixture/typed@1.0.0']);
  await put(join(directory, '.coderuler', 'borrower.rule.mjs'), rule("import { format } from 'fixture-borrower';", "format('borrowed')"));
  const dependencies = await installedDependencies(directory);
  await rejects(() => loadPrepared(directory, dependencies), /fixture-borrower/, /@fixture\/typed/, /declar|dependency/i);
});

test('home and project rules with different locks execute their own helpers in the same process and reusable worker', async () => {
  const directory = await project('project-workers', 1);
  const home = await project('home-workers', 2);
  const marker = join(directory, 'worker-results.jsonl');
  for (const [owner, name, message] of [[directory, 'project', POLICY_MESSAGE_V1], [home, 'home', POLICY_MESSAGE_V2]] as const) {
    await put(join(owner, 'helpers', 'policy.mjs'), "export { message } from 'fixture-policy';\n");
    await put(join(owner, '.coderuler', `${name}.rule.mjs`), `import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { Rule, pass, test } from '@alex-dbs/coderuler';
import { message } from '../helpers/policy.mjs';
export default class Versioned extends Rule {
  files = ['inputs/*.txt'];
  observed = message;
  check = subject => {
    if (message !== subject.source) throw new Error('wrong dependency version: ' + message);
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ threadId, message }) + '\\n');
    return pass();
  };
}
export const tests = [
  test('${name} first').withFiles({ 'inputs/a.txt': ${JSON.stringify(message)} }).passes(),
];
`);
    await put(join(owner, '.coderuler', `${name}.test.mjs`), `import { test } from '@alex-dbs/coderuler';
import { message } from 'fixture-policy';
export const tests = [
  test('${name} second').withFiles({ 'inputs/a.txt': message }).passes(),
];
`);
  }
  const loaded = await createRuleLoader({ home, dependencies: manager }).load(selection(directory));
  assert.deepEqual(loaded.map(observed), [POLICY_MESSAGE_V1, POLICY_MESSAGE_V2]);
  assert.notEqual(getRuleDependencies(loaded[0]!.ruleFile)?.key, getRuleDependencies(loaded[1]!.ruleFile)?.key);
  const requests = registry.requests.length;
  const results = await runRuleTests(loaded, undefined, 10_000, 1);
  assert.deepEqual(results.map(result => result.actual), ['pass', 'pass', 'pass', 'pass']);
  const records = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { threadId: number; message: string });
  assert.deepEqual(records.map(record => record.message), [POLICY_MESSAGE_V1, POLICY_MESSAGE_V1, POLICY_MESSAGE_V2, POLICY_MESSAGE_V2]);
  assert.equal(new Set(records.map(record => record.threadId)).size, 1, 'all four cases reuse the same worker');
  assert.ok(records.every(record => record.threadId > 0));
  assert.equal(registry.requests.length, requests, 'workers consume prepared contexts rather than resolving or acquiring');
});

test('a canonical shared ESM helper cannot be reused by equal locks in distinct owners through a symlink alias', async () => {
  const first = await project('shared-first', 1);
  const second = await project('shared-second', 1);
  const helper = await put(join(root, `shared-${sequence}`, 'helper.mjs'), "export { message } from 'fixture-policy';\n");
  const alias = join(second, 'helper-alias.mjs');
  await symlink(helper, alias);
  await put(join(first, '.coderuler', 'first.rule.mjs'), rule(`import { message } from ${JSON.stringify(pathToFileURL(helper).href)};`, 'message'));
  await put(join(second, '.coderuler', 'second.rule.mjs'), rule("import { message } from '../helper-alias.mjs';", 'message'));
  assert.equal(observed((await loadPrepared(first, await installedDependencies(first)))[0]), POLICY_MESSAGE_V1);
  const dependencies = await installedDependencies(second);
  await rejects(() => loadPrepared(second, dependencies), /helper\.mjs/, /conflict|different|multiple|incompatible/i);
});

for (const extension of ['cjs', 'js']) {
  test(`sibling CommonJS .${extension} helpers reserve their physical directory before a conflicting module executes`, async () => {
    const first = await project(`cjs-first-${extension}`, 1);
    const second = await project(`cjs-second-${extension}`, 2);
    const shared = join(root, `cjs-shared-${sequence}`);
    await put(join(shared, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    const marker = join(shared, 'second-executed');
    const helperA = await put(join(shared, `first.${extension}`), "exports.value = require('@fixture/typed').format('first');\n");
    const helperB = await put(join(shared, `second.${extension}`), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.value = require('@fixture/typed').format('second');\n`);
    await put(join(first, '.coderuler', 'first.rule.mjs'), rule(`import helper from ${JSON.stringify(pathToFileURL(helperA).href)};`, 'helper.value'));
    await put(join(second, '.coderuler', 'second.rule.mjs'), rule(`import helper from ${JSON.stringify(pathToFileURL(helperB).href)};`, 'helper.value'));
    assert.equal(observed((await loadPrepared(first, await installedDependencies(first)))[0]), 'cjs:first');
    const dependencies = await installedDependencies(second);
    await rejects(() => loadPrepared(second, dependencies), /conflict|different|multiple|incompatible/i);
    assert.equal(existsSync(marker), false, 'the conflicting sibling must be rejected before running its body');
  });
}

test('an already-loaded unowned CommonJS sibling prevents claiming that directory', async () => {
  const directory = await project('unowned-cache', 1);
  const shared = join(directory, 'shared');
  await put(join(shared, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const unowned = await put(join(shared, 'unowned.js'), 'module.exports = { unowned: true };\n');
  const owned = await put(join(shared, 'owned.js'), "exports.value = require('@fixture/typed').format('owned');\n");
  const require = createRequire(import.meta.url);
  assert.deepEqual(require(unowned), { unowned: true });
  assert.ok(require.cache[unowned]);
  await put(join(directory, '.coderuler', 'owned.rule.mjs'), rule(`import helper from ${JSON.stringify(pathToFileURL(owned).href)};`, 'helper.value'));
  const dependencies = await installedDependencies(directory);
  try {
    await rejects(() => loadPrepared(directory, dependencies), /unowned|already.loaded|cache/i, /CommonJS|commonjs|directory/i);
  } finally {
    delete require.cache[unowned];
  }
});

test('identical locks in distinct owners cannot share a CommonJS helper directory', async () => {
  const first = await project('equal-cjs-first', 1);
  const second = await project('equal-cjs-second', 1);
  const shared = join(root, `equal-cjs-${sequence}`);
  const helperA = await put(join(shared, 'first.cjs'), "exports.value = require('@fixture/typed').format('first');\n");
  const helperB = await put(join(shared, 'second.cjs'), "exports.value = require('@fixture/typed').format('second');\n");
  for (const [directory, helper] of [[first, helperA], [second, helperB]]) {
    assert.ok(directory && helper);
    await put(join(directory, '.coderuler', 'equal.rule.mjs'), rule(`import helper from ${JSON.stringify(pathToFileURL(helper).href)};`, 'helper.value'));
  }
  const firstDependencies = await installedDependencies(first);
  const secondDependencies = await installedDependencies(second);
  assert.notEqual(firstDependencies.key, secondDependencies.key);
  assert.equal(observed((await loadPrepared(first, firstDependencies))[0]), 'cjs:first');
  await rejects(() => loadPrepared(second, secondDependencies), /conflicting dependency contexts/);
});

test('identical locks preserve each owner directory and its unowned project-local SDK preference', async () => {
  const projects = [await project('local-sdk-first', 1), await project('local-sdk-second', 1)];
  const contexts: PreparedRuleDependencies[] = [];
  const sdkEntry = new URL('../dist/index.js', import.meta.url).href;
  for (const [index, directory] of projects.entries()) {
    const sdk = join(directory, 'node_modules', '@alex-dbs', 'coderuler');
    await put(join(sdk, 'package.json'), JSON.stringify({ name: '@alex-dbs/coderuler', version: '1.0.0', type: 'module', exports: './index.js' }));
    await put(join(sdk, 'node_modules', 'sdk-private', 'package.json'), JSON.stringify({ name: 'sdk-private', type: 'module', exports: './index.js' }));
    await put(join(sdk, 'node_modules', 'sdk-private', 'index.js'), `export const selectedSdk = 'local-${index}';\n`);
    await put(join(sdk, 'index.js'), `export * from ${JSON.stringify(sdkEntry)}; export { selectedSdk } from 'sdk-private';\n`);
    await put(join(directory, '.coderuler', 'sdk.rule.mjs'), rule("import { selectedSdk } from '@alex-dbs/coderuler'; import { format } from '@fixture/typed';", "[selectedSdk, format('same-lock')]"));
    const context = await installedDependencies(directory);
    contexts.push(context);
    const loaded = await loadPrepared(directory, context);
    assert.deepEqual(observed(loaded[0]), [`local-${index}`, 'esm:same-lock']);
    assert.equal(getRuleDependencies(loaded[0]!.ruleFile)?.directory, await realpath(join(directory, '.coderuler')));
  }
  assert.notEqual(contexts[0]?.key, contexts[1]?.key);
  assert.notEqual(contexts[0]?.directory, contexts[1]?.directory);
});

test('physical node_modules trees containing package .rule.ts files are excluded from rule discovery', async () => {
  const directory = await project('package-discovery', 1);
  await put(join(directory, '.coderuler', 'only.rule.mjs'), rule("import { message } from 'fixture-policy';", 'message'));
  const dependencies = await installedDependencies(directory);
  assert.equal(existsSync(join(dependencies.directory, 'node_modules', 'fixture-policy', 'hidden.rule.ts')), true);
  const marker = join(directory, 'package-rule-executed');
  await put(join(directory, '.coderuler', 'node_modules', 'physical-package', 'hidden.rule.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('package discovery escaped');\n`);
  const loaded = await loadPrepared(directory, dependencies);
  assert.deepEqual(loaded.map(entry => entry.name), ['only']);
  assert.equal(observed(loaded[0]), POLICY_MESSAGE_V1);
  assert.equal(existsSync(marker), false);
});

test('a read-only owner executes its already-installed local packages without writes or network', async () => {
  const directory = await project('readonly', 1);
  const owner = join(directory, '.coderuler');
  await put(join(directory, 'package.json'), JSON.stringify({ type: 'module', imports: { '#typed': '@fixture/typed' } }));
  await put(join(owner, 'readonly.rule.mjs'), rule("import { format } from '#typed';", "format('readonly')"));
  await installedDependencies(directory);
  const marker = await readFile(join(owner, 'node_modules', '.coderuler-install.json'), 'utf8');
  const requests = registry.requests.length;
  const unusedCache = join(directory, 'unused-download-cache');
  await chmod(owner, 0o555);
  try {
    const warnings: string[] = [];
    const readonlyManager = createRuleDependencyManager({ cacheRoot: unusedCache, onWarning: warning => warnings.push(warning) });
    const loaded = await createRuleLoader({ home: join(root, 'empty-home'), dependencies: readonlyManager }).load(selection(directory));
    assert.equal(observed(loaded[0]), 'esm:readonly');
    assert.equal(existsSync(join(owner, 'node_modules')), true);
    assert.deepEqual(warnings, []);
    assert.equal(registry.requests.length, requests);
    assert.equal(existsSync(unusedCache), false);
    assert.equal(await readFile(join(owner, 'node_modules', '.coderuler-install.json'), 'utf8'), marker);
  } finally {
    await chmod(owner, 0o755);
  }
});

function startWorker(prelude = ''): Worker {
  const module = new URL('../dist/adapter/filesystem/rule-test-worker.js', import.meta.url).href;
  // The prelude must populate require.cache before the worker installs its real loader hooks.
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(`${prelude}\nawait import(${JSON.stringify(module)});`)}`));
}

async function requestWorker(worker: Worker, request: RuleTestWorkerRequest): Promise<RuleTestWorkerMessage> {
  const result = Promise.withResolvers<RuleTestWorkerMessage>();
  const onMessage = (message: RuleTestWorkerMessage) => {
    if (message.id === request.id) result.resolve(message);
  };
  const onError = (error: Error) => result.reject(error);
  const onExit = (code: number) => result.reject(new Error(`Worker exited before a result: ${code}`));
  worker.on('message', onMessage);
  worker.on('error', onError);
  worker.on('exit', onExit);
  try {
    worker.postMessage(request);
    return await result.promise;
  } finally {
    worker.off('message', onMessage);
    worker.off('error', onError);
    worker.off('exit', onExit);
  }
}

for (const extension of ['mjs', 'cjs', 'js']) {
  test(`reused workers retain conflicting ${extension === 'mjs' ? 'shared ESM helper' : `CommonJS .${extension} directory`} guards`, { timeout: 30_000 }, async context => {
    const first = await project(`worker-first-${extension}`, 1);
    const second = await project(`worker-second-${extension}`, 2);
    const shared = join(root, `worker-shared-${sequence}`);
    await put(join(shared, 'package.json'), JSON.stringify({ type: extension === 'mjs' ? 'module' : 'commonjs' }));
    const commonjs = extension !== 'mjs';
    const helperA = await put(join(shared, `first.${extension}`), commonjs
      ? "exports.message = require('@fixture/typed').format('worker');\n"
      : "export { message } from 'fixture-policy';\n");
    const marker = join(shared, 'second-executed');
    const helperB = commonjs ? await put(join(shared, `second.${extension}`),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); exports.message = require('@fixture/typed').format('worker');\n`,
    ) : helperA;
    const firstRule = await put(join(first, '.coderuler', 'first.rule.mjs'), rule(
      `import { message } from ${JSON.stringify(pathToFileURL(helperA).href)}; if (message !== ${JSON.stringify(commonjs ? 'cjs:worker' : POLICY_MESSAGE_V1)}) throw new Error('wrong first worker dependency');`, 'message',
    ));
    const secondRule = await put(join(second, '.coderuler', 'second.rule.mjs'), rule(
      `import { message } from ${JSON.stringify(pathToFileURL(helperB).href)};`, 'message',
    ));
    const firstDependencies = await installedDependencies(first);
    const secondDependencies = await installedDependencies(second);
    const worker = startWorker();
    context.signal.addEventListener('abort', () => { void worker.terminate(); }, { once: true });
    try {
      const firstResult = await requestWorker(worker, {
        id: 1, root: join(first, 'inline-fixture'), ruleFile: firstRule,
        files: { 'inputs/one.txt': 'input' }, ai: false, dependencies: firstDependencies,
      });
      assert.deepEqual(firstResult, { id: 1, outcome: { actual: 'pass' } });
      const secondResult = await requestWorker(worker, {
        id: 2, root: join(second, 'inline-fixture'), ruleFile: secondRule,
        files: { 'inputs/one.txt': 'input' }, ai: false, dependencies: secondDependencies,
      });
      assert.ok('error' in secondResult, JSON.stringify(secondResult));
      assert.match(secondResult.error, /conflict|different|multiple|incompatible/i);
      assert.equal(existsSync(marker), false);
    } finally {
      await worker.terminate();
    }
  });
}

test('a worker refuses a CommonJS directory populated in require.cache before it received a rule context', { timeout: 30_000 }, async context => {
  const directory = await project('worker-unowned-cache', 1);
  const shared = join(directory, 'shared');
  await put(join(shared, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const unowned = await put(join(shared, 'unowned.js'), 'module.exports = true;\n');
  const helper = await put(join(shared, 'owned.js'), "exports.value = require('@fixture/typed').format('owned');\n");
  const ruleFile = await put(join(directory, '.coderuler', 'owned.rule.mjs'), rule(
    `import helper from ${JSON.stringify(pathToFileURL(helper).href)};`, 'helper.value',
  ));
  const dependencies = await installedDependencies(directory);
  const worker = startWorker(`import { createRequire } from 'node:module'; createRequire(${JSON.stringify(import.meta.url)})(${JSON.stringify(unowned)});`);
  context.signal.addEventListener('abort', () => { void worker.terminate(); }, { once: true });
  try {
    const result = await requestWorker(worker, {
      id: 1, root: join(directory, 'inline-fixture'), ruleFile,
      files: { 'inputs/one.txt': 'input' }, ai: false, dependencies,
    });
    assert.ok('error' in result, JSON.stringify(result));
    assert.match(result.error, /unowned|already.loaded|cache/i);
    assert.match(result.error, /CommonJS|commonjs|directory/i);
  } finally {
    await worker.terminate();
  }
});

for (const mutation of ['lock', 'marker', 'locations', 'mutex'] as const) {
  test(`prepared parent and reused/fresh workers reject ${mutation} changes before cached rule execution`, { timeout: 30_000 }, async context => {
    const directory = await project(`stale-${mutation}`, 1);
    const owner = join(directory, '.coderuler');
    const ruleFile = await put(join(owner, 'stale.rule.mjs'), rule(
      "import { message } from 'fixture-policy';", 'message',
    ));
    const dependencies = await installedDependencies(directory);
    assert.equal(observed((await loadPrepared(directory, dependencies))[0]), POLICY_MESSAGE_V1);
    const worker = startWorker();
    const freshWorker = startWorker();
    context.signal.addEventListener('abort', () => { void worker.terminate(); void freshWorker.terminate(); }, { once: true });
    const request = {
      root: join(directory, 'inline-fixture'), ruleFile,
      files: { 'inputs/one.txt': 'input' }, ai: false, dependencies,
    };
    try {
      assert.deepEqual(await requestWorker(worker, { ...request, id: 1 }), { id: 1, outcome: { actual: 'pass' } });
      if (mutation === 'lock') {
        await put(join(owner, 'coderuler.lock'), locks.get(2)!);
      } else if (mutation === 'mutex') {
        await mkdir(join(owner, '.coderuler-deps-write'));
      } else {
        const path = join(owner, 'node_modules', '.coderuler-install.json');
        const marker = JSON.parse(await readFile(path, 'utf8')) as { key: string; installedLocations: string[] };
        if (mutation === 'marker') marker.key = 'changed-installation';
        else marker.installedLocations = [];
        await put(path, JSON.stringify(marker));
      }
      await rejects(() => loadPrepared(directory, dependencies), /changed|in progress/, /rerun/, /deps sync/);
      for (const [target, id] of [[worker, 2], [freshWorker, 3]] as const) {
        const result = await requestWorker(target, { ...request, id });
        assert.ok('error' in result, JSON.stringify(result));
        assert.match(result.error, /changed|in progress/);
        assert.match(result.error, /rerun.*deps sync/);
        if (mutation === 'mutex') {
          assert.match(result.error, /\.coderuler-deps-write/);
          assert.match(result.error, /confirming its owner exited/);
        }
      }
    } finally {
      await worker.terminate();
      await freshWorker.terminate();
    }
  });
}

test('a running rule cannot resolve a dependency while local publication holds the mutex', async () => {
  const directory = await project('running-stale', 1);
  const owner = join(directory, '.coderuler');
  // A delayed import intentionally exercises resolution after the initial load.
  await put(join(owner, 'dynamic.rule.mjs'), rule('', "async () => (await import('fixture-policy')).message"));
  const dependencies = await installedDependencies(directory);
  const read = observed((await loadPrepared(directory, dependencies))[0]) as () => Promise<string>;
  assert.equal(await read(), POLICY_MESSAGE_V1);
  const mutex = join(owner, '.coderuler-deps-write');
  await mkdir(mutex);
  try {
    await rejects(read, /installation is in progress/, /\.coderuler-deps-write/, /rerun/);
  } finally {
    await rm(mutex, { recursive: true });
  }
});

test('a fresh prepared context cannot reuse modules from a replaced local installation in the same process', async () => {
  const directory = await project('replaced-in-process', 1);
  const owner = join(directory, '.coderuler');
  await put(join(owner, 'first.rule.mjs'), rule("import { message } from 'fixture-policy';", 'message'));
  assert.equal(observed((await loadPrepared(directory, await installedDependencies(directory)))[0]), POLICY_MESSAGE_V1);
  const replacement = await manager.change(owner, 'add', ['fixture-policy@2.0.0']);
  await put(join(owner, 'second.rule.mjs'), rule("import { message } from 'fixture-policy';", 'message'));
  await rejects(() => loadPrepared(directory, replacement), /already loaded a different dependency snapshot/, /rerun/);
});
