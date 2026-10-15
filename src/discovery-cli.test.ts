/**
 * End-to-end tests for rule discovery through the real `check` and `validate` commands. Every case
 * spawns Node on the absolute root `index.ts` from an isolated working directory whose
 * `HOME`/`USERPROFILE` point at an isolated home, so discovery sees only the two `.rulekeeper` roots
 * the case creates and never the real user's `~/.rulekeeper`. The case's decision backend is a real
 * HTTP server this process runs on a loopback port, so a check that selects a context is answered
 * locally and never reaches a real backend. Only the real rule and source files are materialized;
 * the expectations are the file-mode contexts the rules select. The lexical order and determinism of
 * a root's own rule listing are pinned by the CLI suite's rules-directory case, so only the
 * discovery-specific behavior — both roots, same names, fallbacks and validation — is exercised
 * here.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  entries,
  fileContext,
  runCli,
  soleEntry,
  startDecisionFixture,
  writeFile,
  type DecisionFixture,
  type SandboxRoot,
} from '../tests/support.ts';

/** A rule whose version is not v1, so it fails to compile wherever it is discovered. */
const INVALID_RULE = [
  "version: 'v2'",
  'name: Unsupported rule version',
  'files:',
  '  included:',
  "    - '**/*.ts'",
  'scope:',
  '  format: yaml',
  "  path: '$'",
  'rule: Review the change.',
  '',
].join('\n');

let sandbox!: SandboxRoot;
let backend!: DecisionFixture;

before(async () => {
  backend = await startDecisionFixture();
  sandbox = createSandbox('rulekeeper-discovery-', backend.env);
});

after(async () => {
  sandbox.cleanup();
  await backend.close();
});

/** One whole-file rule over the config YAML tree, selecting the document root; optionally changed. */
function wholeFileRule(name: string, rule: string, changed = false): string {
  const lines = [
    "version: 'v1'",
    `name: '${name}'`,
    'files:',
    '  included:',
    "    - 'config/**/*.yaml'",
    'scope:',
    '  format: yaml',
    "  path: '$'",
  ];
  if (changed) lines.push('  changed: true');
  lines.push(`rule: '${rule}'`, '');
  return lines.join('\n');
}

test('default check applies a nested local rule and the home rule together', async () => {
  const project = sandbox.isolated('both-roots');
  const localRule = writeFile(
    join(project.cwd, '.rulekeeper', 'scopes', 'deep', 'local.yaml'),
    wholeFileRule('Local review', 'Review from the project root.'),
  );
  const homeRule = writeFile(
    join(project.home, '.rulekeeper', 'home.yaml'),
    wholeFileRule('Home review', 'Review from the user root.'),
  );
  const source = '{service: {name: api}}';
  writeFile(join(project.cwd, 'config', 'a.yaml'), source);

  const list = entries(await runCli(['check'], project), 'local and home roots');

  // Local root first, then home; the recursive local rule at depth is still discovered.
  assert.deepStrictEqual(list.map(entry => entry.ruleFile), [localRule, homeRule]);
  assert.deepStrictEqual(list.map(entry => entry.name), ['Local review', 'Home review']);
  assert.deepStrictEqual(list.map(entry => entry.rule), [
    'Review from the project root.',
    'Review from the user root.',
  ]);
  for (const entry of list) assert.deepStrictEqual(entry.contexts, [fileContext('config/a.yaml', source)]);
});

test('default check keeps same-name rules from both roots instead of overriding one', async () => {
  const project = sandbox.isolated('same-name');
  const shared = wholeFileRule('Shared review', 'Review shared.');
  const localRule = writeFile(join(project.cwd, '.rulekeeper', 'rules', 'shared.yaml'), shared);
  const homeRule = writeFile(join(project.home, '.rulekeeper', 'rules', 'shared.yaml'), shared);
  writeFile(join(project.cwd, 'config', 'a.yaml'), '{a: 1}');

  const list = entries(await runCli(['check'], project), 'same name and relative path');

  assert.deepStrictEqual(list.map(entry => entry.ruleFile), [localRule, homeRule]);
  assert.deepStrictEqual(list.map(entry => entry.name), ['Shared review', 'Shared review']);
});

test('default check ignores scope.changed because it reviews one source text', async () => {
  const project = sandbox.isolated('changed');
  writeFile(
    join(project.cwd, '.rulekeeper', 'changed.yaml'),
    wholeFileRule('Changed review', 'Review changed scopes.', true),
  );
  const source = '{replicas: 2}';
  writeFile(join(project.cwd, 'config', 'a.yaml'), source);

  const entry = soleEntry(await runCli(['check'], project), 'changed rule');

  assert.deepStrictEqual(entry.contexts, [fileContext('config/a.yaml', source)]);
});

test('default check still discovers rules from the working directory when the target is a subdirectory', async () => {
  const project = sandbox.isolated('target-subdirectory');
  const localRule = writeFile(
    join(project.cwd, '.rulekeeper', 'local.yaml'),
    wholeFileRule('Local only', 'Review local only.'),
  );
  const source = '{a: 1}';
  writeFile(join(project.cwd, 'config', 'a.yaml'), source);
  writeFile(join(project.cwd, 'other', 'b.yaml'), '{b: 2}');

  const entry = soleEntry(await runCli(['check', 'config'], project), 'subdirectory target');

  assert.strictEqual(entry.ruleFile, localRule);
  assert.deepStrictEqual(entry.contexts, [fileContext('config/a.yaml', source)]);
});

test('default check falls back to the discovery root that exists', async () => {
  const cases: readonly (readonly [string, 'local' | 'home'])[] = [
    ['absent home root', 'local'],
    ['absent local root', 'home'],
  ];

  for (const [label, root] of cases) {
    const project = sandbox.isolated('single-root');
    const ruleFile =
      root === 'local'
        ? writeFile(join(project.cwd, '.rulekeeper', 'local.yaml'), wholeFileRule('Local only', 'Review local only.'))
        : writeFile(join(project.home, '.rulekeeper', 'home.yaml'), wholeFileRule('Home only', 'Review home only.'));
    writeFile(join(project.cwd, 'config', 'a.yaml'), '{a: 1}');

    const entry = soleEntry(await runCli(['check'], project), label);

    assert.strictEqual(entry.ruleFile, ruleFile, `${label}: wrong discovery root`);
  }
});

test('check and validate fail without stdout when a discovered rule is invalid', async () => {
  for (const command of ['check', 'validate'] as const) {
    const project = sandbox.isolated('invalid-discovered');
    writeFile(join(project.cwd, '.rulekeeper', 'good.yaml'), wholeFileRule('Good', 'Review good.'));
    writeFile(join(project.home, '.rulekeeper', 'bad.yaml'), INVALID_RULE);
    writeFile(join(project.cwd, 'config', 'a.yaml'), '{a: 1}');

    assertFailed(await runCli([command], project), `${command} with an invalid discovered rule`);
  }
});

test('an explicit rules path bypasses discovery even when a discovered rule is broken', async () => {
  const project = sandbox.isolated('explicit-rules');
  writeFile(join(project.cwd, '.rulekeeper', 'broken.yaml'), INVALID_RULE);
  const rulePath = writeFile(join(project.cwd, 'explicit.yaml'), wholeFileRule('Explicit', 'Review explicit.'));
  const source = '{a: 1}';
  writeFile(join(project.cwd, 'config', 'a.yaml'), source);

  const entry = soleEntry(await runCli(['check', 'config', '--rules', rulePath], project), 'explicit rules path');

  assert.strictEqual(entry.ruleFile, rulePath);
  assert.strictEqual(entry.name, 'Explicit');
  assert.deepStrictEqual(entry.contexts, [fileContext('config/a.yaml', source)]);
});
