import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createSandbox, parseCheckOutput, reportNamed, ROOT, runCli, writeFile, type Sandbox } from './support.ts';

const sandbox = createSandbox('rulekeeper-cli-loading-');
const unavailableForStartup = [
  'axios',
  'yaml',
  'jsonc-parser',
  'jsonpath-plus',
  'csv-parse/sync',
  'string-width',
  'npm-package-arg',
  'npm-install-checks',
  'ssri',
  '@npmcli/arborist',
  'pacote',
];
const installedVersion = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

after(() => sandbox.cleanup());

function unavailableDependencies(packages: readonly string[]): NodeJS.ProcessEnv {
  const hook = `import { registerHooks } from 'node:module';\nconst denied = new Set(${JSON.stringify(packages)});\nregisterHooks({ resolve(specifier, context, nextResolve) { if (denied.has(specifier)) throw new Error('unavailable optional dependency: ' + specifier); return nextResolve(specifier, context); } });`;
  return {
    NODE_DISABLE_COMPILE_CACHE: '1',
    NODE_COMPILE_CACHE: undefined,
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(hook)}`,
  };
}

async function runUnavailable(args: readonly string[], target: Sandbox, packages = unavailableForStartup) {
  return runCli(args, target, unavailableDependencies(packages));
}

test('help and version do not load unused dependencies', async () => {
  const cases = [
    { args: ['--help'], expected: 'Usage: rulekeeper' },
    { args: ['inspect', '--help'], expected: 'Usage: rulekeeper inspect' },
    { args: ['--version'], expected: installedVersion },
  ] as const;

  for (const [index, entry] of cases.entries()) {
    const result = await runUnavailable(entry.args, sandbox.isolated(`help-${index}`));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(entry.expected), result.stdout);
  }
});

test('unknown command options are rejected before loading unused dependencies', async () => {
  const result = await runUnavailable(['check', '--bogus'], sandbox.isolated('unknown-option'));
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown option.*--bogus/);
  assert.ok(!result.stderr.includes('unavailable optional dependency'), result.stderr);
});

test('semantic format conflicts are rejected before loading command dependencies', async () => {
  const cases = [
    { args: ['check', '--json', '--jsonl'], expected: '--json and --jsonl are mutually exclusive' },
    { args: ['inspect', 'example', '--json', '--raw'], expected: '--json, --raw are mutually exclusive' },
  ] as const;

  for (const [index, entry] of cases.entries()) {
    const result = await runUnavailable(entry.args, sandbox.isolated(`format-conflict-${index}`));
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(entry.expected), result.stderr);
    assert.ok(!result.stderr.includes('unavailable optional dependency'), result.stderr);
  }
});

test('local checks do not require AI or dependency-management packages', async () => {
  const target = sandbox.isolated('local-check');
  writeFile(join(target.cwd, 'inputs/a.txt'), 'GOOD');
  writeFile(join(target.cwd, 'inputs/b.txt'), 'BAD');
  writeFile(join(target.cwd, '.rulekeeper/smoke.rule.ts'), `
import { Rule, pass, violation } from '@alex-dbs/rulekeeper';
export default class Smoke extends Rule {
  files = ['inputs/*.txt'];
  check = subject => subject.source === 'BAD' ? violation('bad input') : pass();
}
`);

  const result = await runUnavailable(
    ['check', '--json', '--output-all'],
    target,
    ['axios', '@npmcli/arborist', 'pacote'],
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const report = reportNamed(parseCheckOutput(result, 'lazy local check'), 'smoke', 'lazy local check');
  const evaluations = report.evaluations.map(evaluation => {
    assert.equal(evaluation.subject.kind, 'scope');
    return {
      filepath: evaluation.subject.filepath,
      status: evaluation.result.status,
      message: evaluation.result.message,
    };
  });
  assert.deepEqual(evaluations.map(({ filepath, status }) => [filepath, status]), [
    ['inputs/a.txt', 'pass'],
    ['inputs/b.txt', 'violation'],
  ]);
  assert.equal(evaluations[1]?.message, 'bad input');
});
