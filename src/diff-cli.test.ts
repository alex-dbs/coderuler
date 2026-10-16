import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  entries,
  GOLDEN_ROOT,
  isMapping,
  requireString,
  runCli,
  runGit,
  soleEntry,
  startDecisionFixture,
  writeFile,
  type CheckEntry,
  type CliResult,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
} from '../tests/support.ts';

const MEMORY_RATIO_RULE = join(GOLDEN_ROOT, 'memory-ratio', 'rule.yaml');

let sandbox!: SandboxRoot;
let backend!: DecisionFixture;

before(async () => {
  backend = await startDecisionFixture();
  sandbox = createSandbox('rulekeeper-diff-', backend.env);
});

after(async () => {
  sandbox.cleanup();
  await backend.close();
});

function createRepo(label: string, branch = 'main'): Sandbox {
  const repo = sandbox.isolated(label);
  runGit(repo.cwd, ['init', '-q', '-b', branch], repo.env);
  return repo;
}

function move(repo: Sandbox, from: string, to: string): void {
  const target = join(repo.cwd, to);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(join(repo.cwd, from), target);
}

function commit(repo: Sandbox, message: string): void {
  runGit(repo.cwd, ['add', '-A'], repo.env);
  runGit(repo.cwd, ['commit', '-q', '-m', message], repo.env);
}

function revParse(repo: Sandbox, rev: string): string {
  return runGit(repo.cwd, ['rev-parse', rev], repo.env).trim();
}

function checkoutNew(repo: Sandbox, name: string): void {
  runGit(repo.cwd, ['checkout', '-q', '-b', name], repo.env);
}

function publish(repo: Sandbox, name: string, sha: string): void {
  runGit(repo.cwd, ['update-ref', `refs/remotes/origin/${name}`, sha], repo.env);
}

function container(name: string, limit: string, request = '512Mi'): string {
  return [
    `  - name: ${name}`,
    `    image: registry.example.com/${name}:1.0.0`,
    '    resources:',
    '      requests:',
    `        memory: ${request}`,
    '      limits:',
    `        memory: ${limit}`,
  ].join('\n');
}

function values(...containers: readonly string[]): string {
  return `${['containers:', ...containers].join('\n')}\n`;
}

function containerData(name: string, limit: string, request = '512Mi'): unknown {
  return {
    name,
    image: `registry.example.com/${name}:1.0.0`,
    resources: { requests: { memory: request }, limits: { memory: limit } },
  };
}

function containersRule(included: readonly string[], changed?: boolean): string {
  const lines = ["version: 'v1'", 'files:', '  included:'];
  for (const glob of included) lines.push(`    - '${glob}'`);
  lines.push('scope:', '  format: yaml', "  path: '$.containers[*]'", "  key: '$.name'");
  if (changed === false) lines.push('  changed: false');
  lines.push('check:', "  rule: 'Review the container memory settings.'");
  return `${lines.join('\n')}\n`;
}

function memoryLine(value: string): string {
  return `        memory: ${value}`;
}

interface ParsedContext {
  readonly filepath: string;
  readonly id: string;
  readonly data: unknown;
  readonly diff: string | undefined;
}

interface DiffContext extends ParsedContext {
  readonly diff: string;
}

function toContext(value: unknown, where: string): ParsedContext {
  if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
  const scope = value.scope;
  if (!isMapping(scope)) throw new Error(`${where}.scope must be a mapping`);
  const diff = value.diff;
  if (diff !== undefined && typeof diff !== 'string') throw new Error(`${where}.diff must be a string`);
  return {
    filepath: requireString(value.filepath, `${where}.filepath`),
    id: requireString(scope.id, `${where}.scope.id`),
    data: scope.data,
    diff,
  };
}

function contextsOf(entry: CheckEntry, label: string): ParsedContext[] {
  return entry.contexts.map((value: unknown, index: number) => toContext(value, `${label}.contexts[${index}]`));
}

function diffContexts(result: CliResult, label: string): DiffContext[] {
  const entry = soleEntry(result, label);
  return contextsOf(entry, label).map((context, index) => {
    const { diff } = context;
    if (diff === undefined) throw new Error(`${label}.contexts[${index}] carries no per-file diff`);
    return { filepath: context.filepath, id: context.id, data: context.data, diff };
  });
}

function filepaths(contexts: readonly ParsedContext[]): string[] {
  return contexts.map(context => context.filepath);
}

test('check --diff-only compares against the inferred default base or the one named with --base', async () => {
  const repo = createRepo('named-base');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
  writeFile(join(repo.cwd, 'charts/lib/values.yaml'), values(container('lib', '1Gi')));
  commit(repo, 'base');
  const base = revParse(repo, 'HEAD');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '2Gi')));
  commit(repo, 'app change');
  const fork = revParse(repo, 'HEAD');
  writeFile(join(repo.cwd, 'charts/lib/values.yaml'), values(container('lib', '2Gi')));
  commit(repo, 'lib change');
  publish(repo, 'main', base);
  runGit(repo.cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo.env);
  publish(repo, 'my-branch', fork);

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const cases: readonly (readonly [string, readonly string[], readonly string[]])[] = [
    ['inferred default base', [], ['charts/app/values.yaml', 'charts/lib/values.yaml']],
    ['explicit --base origin/my-branch', ['--base', 'origin/my-branch'], ['charts/lib/values.yaml']],
  ];

  for (const [label, baseArgs, expected] of cases) {
    const contexts = contextsOf(
      soleEntry(await runCli(['check', '.', '--rules', rulePath, '--diff-only', ...baseArgs], repo), label),
      label,
    );
    assert.deepStrictEqual(filepaths(contexts), expected, `${label}: wrong files`);
    for (const context of contexts) {
      assert.deepStrictEqual(context.data, containerData(context.id.slice(2), '2Gi'), `${label}: wrong scope data`);
      assert.ok(context.diff!.includes(`-${memoryLine('1Gi')}`), `${label}: expected the base limit line`);
      assert.ok(context.diff!.includes(`+${memoryLine('2Gi')}`), `${label}: expected the head limit line`);
    }
  }
});

test('check --diff-only compares from the merge base so a base-only change is excluded', async () => {
  const repo = createRepo('merge-base');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '2Gi')));
  commit(repo, 'feature change');
  // The base branch advances on its own: a two-dot diff would report this file as removed.
  runGit(repo.cwd, ['checkout', '-q', 'main'], repo.env);
  writeFile(join(repo.cwd, 'charts/side/values.yaml'), values(container('side', '5Gi')));
  commit(repo, 'base only');
  runGit(repo.cwd, ['checkout', '-q', 'feature'], repo.env);

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const contexts = contextsOf(
    soleEntry(await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo), 'merge-base'),
    'merge-base',
  );

  assert.deepStrictEqual(filepaths(contexts), ['charts/app/values.yaml']);
});

test('check --diff-only reviews frozen HEAD snapshots and ignores the dirty working tree', async () => {
  const repo = createRepo('dirty-tree');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '2Gi')));
  commit(repo, 'feature change');
  // The working tree diverges in every way the diff-only mode must ignore: a dirty edit, a staged
  // addition and a plain untracked file.
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '3Gi')));
  writeFile(join(repo.cwd, 'charts/staged/values.yaml'), values(container('staged', '4Gi')));
  runGit(repo.cwd, ['add', 'charts/staged/values.yaml'], repo.env);
  writeFile(join(repo.cwd, 'charts/untracked/values.yaml'), values(container('untracked', '5Gi')));

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const contexts = contextsOf(
    soleEntry(
      await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
      'dirty-tree diff',
    ),
    'dirty-tree diff',
  );
  assert.deepStrictEqual(filepaths(contexts), ['charts/app/values.yaml']);
  assert.deepStrictEqual(
    contexts[0]!.data,
    containerData('app', '2Gi'),
    'dirty-tree: expected the committed HEAD snapshot',
  );
  assert.ok(contexts[0]!.diff!.includes(`-${memoryLine('1Gi')}`), 'dirty-tree: expected the committed base line');
  assert.ok(contexts[0]!.diff!.includes(`+${memoryLine('2Gi')}`), 'dirty-tree: expected the committed head line');
  assert.ok(!contexts[0]!.diff!.includes('3Gi'), 'dirty-tree: the dirty edit leaked into the patch');

  // The normal check still reads the working tree: the dirty edit is what a file-mode review sees.
  const normal = contextsOf(
    soleEntry(await runCli(['check', '.', '--rules', rulePath], repo), 'dirty-tree normal'),
    'dirty-tree normal',
  );
  const app = normal.find(context => context.filepath === 'charts/app/values.yaml');
  assert.ok(app !== undefined, 'dirty-tree: expected the file-mode context');
  assert.deepStrictEqual(app.data, containerData('app', '3Gi'));
});

test('check --diff-only keeps a changed scope request and skips the untouched sibling', async () => {
  const repo = createRepo('sibling-scopes');
  writeFile(
    join(repo.cwd, 'charts/payments-api/values.yaml'),
    values(container('payments-api', '1Gi'), container('ledger', '512Mi', '256Mi')),
  );
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(
    join(repo.cwd, 'charts/payments-api/values.yaml'),
    values(container('payments-api', '2Gi'), container('ledger', '512Mi', '256Mi')),
  );
  commit(repo, 'limit change');

  const contexts = diffContexts(
    await runCli(['check', '.', '--rules', MEMORY_RATIO_RULE, '--diff-only', '--base', 'main'], repo),
    'sibling-scopes',
  );
  assert.strictEqual(contexts.length, 1, 'sibling-scopes: expected only the changed container');
  assert.strictEqual(contexts[0]!.filepath, 'charts/payments-api/values.yaml');
  assert.strictEqual(contexts[0]!.id, '0:payments-api');
  // The limit changed while the request did not: the whole scope is retained, request included.
  assert.deepStrictEqual(contexts[0]!.data, {
    name: 'payments-api',
    image: 'registry.example.com/payments-api:1.0.0',
    resources: { requests: { memory: '512Mi' }, limits: { memory: '2Gi' } },
  });
  assert.ok(contexts[0]!.diff.includes(`-${memoryLine('1Gi')}`), 'sibling-scopes: expected the base limit');
  assert.ok(contexts[0]!.diff.includes(`+${memoryLine('2Gi')}`), 'sibling-scopes: expected the head limit');
});

test('check --diff-only still restricts a scope.changed false rule to changed scopes', async () => {
  const repo = createRepo('changed-false');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi'), container('other', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '2Gi'), container('other', '1Gi')));
  commit(repo, 'app change');

  const rulePath = writeFile(
    join(repo.rules, 'unchanged-scope.yaml'),
    containersRule(['charts/**/*.yaml'], false),
  );
  const diff = contextsOf(
    soleEntry(await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo), 'changed-false diff'),
    'changed-false diff',
  );
  assert.deepStrictEqual(diff.map(context => context.id), ['0:app'], 'changed-false: diff-only ignored the option');

  // File mode has no base, so `changed: false` carries no meaning there and both scopes are reviewed.
  const file = contextsOf(
    soleEntry(await runCli(['check', '.', '--rules', rulePath], repo), 'changed-false file'),
    'changed-false file',
  );
  assert.deepStrictEqual(file.map(context => context.id), ['0:app', '0:other']);
});

test('check --diff-only narrows the changed scopes to the positional target', async () => {
  const repo = createRepo('narrow-target');
  writeFile(join(repo.cwd, 'charts/a/values.yaml'), values(container('a', '1Gi')));
  writeFile(join(repo.cwd, 'charts/b/values.yaml'), values(container('b', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/a/values.yaml'), values(container('a', '2Gi')));
  writeFile(join(repo.cwd, 'charts/b/values.yaml'), values(container('b', '2Gi')));
  commit(repo, 'bump both');

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
    [['charts'], ['charts/a/values.yaml', 'charts/b/values.yaml']],
    [['charts/a'], ['charts/a/values.yaml']],
    [['charts/b/values.yaml'], ['charts/b/values.yaml']],
  ];
  for (const [target, expected] of cases) {
    const label = `narrow-target ${target.join(' ')}`;
    const contexts = contextsOf(
      soleEntry(await runCli(['check', ...target, '--rules', rulePath, '--diff-only', '--base', 'main'], repo), label),
      label,
    );
    assert.deepStrictEqual(filepaths(contexts), expected);
  }
});

test('check --diff-only reports the scopes of an added file', async () => {
  const repo = createRepo('added-file');
  writeFile(join(repo.cwd, 'charts/base/values.yaml'), values(container('base', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/new/values.yaml'), values(container('new', '2Gi')));
  commit(repo, 'add new');

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const contexts = diffContexts(
    await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
    'added-file',
  );
  assert.deepStrictEqual(filepaths(contexts), ['charts/new/values.yaml']);
  assert.strictEqual(contexts[0]!.id, '0:new');
  assert.deepStrictEqual(contexts[0]!.data, containerData('new', '2Gi'));
  assert.ok(contexts[0]!.diff.includes(`+${memoryLine('2Gi')}`), 'added-file: expected the added limit line');
});

test('check --diff-only emits nothing for a deleted file and accepts an absent target', async () => {
  const repo = createRepo('deleted-file');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
  writeFile(join(repo.cwd, 'charts/gone/values.yaml'), values(container('gone', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  rmSync(join(repo.cwd, 'charts/gone'), { recursive: true, force: true });
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '2Gi')));
  commit(repo, 'delete gone, bump app');

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const contexts = contextsOf(
    soleEntry(
      await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
      'deleted-file whole',
    ),
    'deleted-file whole',
  );
  assert.deepStrictEqual(filepaths(contexts), ['charts/app/values.yaml']);

  // The deleted directory no longer exists in the working tree, but it lies inside the repository,
  // so it is a valid target whose deleted scopes yield no contexts.
  const target = await runCli(['check', 'charts/gone', '--rules', rulePath, '--diff-only', '--base', 'main'], repo);
  const targetEntry = soleEntry(target, 'deleted-file target');
  assert.deepStrictEqual(targetEntry.contexts, []);
});

test('check --diff-only emits nothing for a pure rename of an unchanged scope', async () => {
  const repo = createRepo('pure-rename');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  move(repo, 'charts/app/values.yaml', 'charts/moved/values.yaml');
  commit(repo, 'move');

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const entry = soleEntry(
    await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
    'pure-rename',
  );

  assert.deepStrictEqual(entry.contexts, []);
});

test('check --diff-only treats a rename into a newly matched path as an addition', async () => {
  const repo = createRepo('rename-new-path');
  writeFile(join(repo.cwd, 'other/values.yaml'), values(container('legacy', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  move(repo, 'other/values.yaml', 'charts/moved/values.yaml');
  commit(repo, 'move into scope');

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const contexts = diffContexts(
    await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
    'rename-new-path',
  );
  assert.deepStrictEqual(filepaths(contexts), ['charts/moved/values.yaml']);
  assert.strictEqual(contexts[0]!.id, '0:legacy');
  assert.deepStrictEqual(contexts[0]!.data, containerData('legacy', '1Gi'));
});

test('check --diff-only reports the changed scope of a rename that also edits content', async () => {
  const repo = createRepo('rename-edited');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  move(repo, 'charts/app/values.yaml', 'charts/moved/values.yaml');
  writeFile(join(repo.cwd, 'charts/moved/values.yaml'), values(container('app', '2Gi')));
  commit(repo, 'move and bump');

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const contexts = diffContexts(
    await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
    'rename-edited',
  );
  assert.deepStrictEqual(filepaths(contexts), ['charts/moved/values.yaml']);
  assert.strictEqual(contexts[0]!.id, '0:app');
  assert.deepStrictEqual(contexts[0]!.data, containerData('app', '2Gi'));
});

test('check --diff-only handles filepaths with spaces, globs and tabs', async () => {
  const repo = createRepo('path-safety');
  const spaced = 'charts/my app/values v1.yaml';
  const globbed = 'charts/a[b]/values.yaml';
  const tabbed = join('charts', 'tab\there', 'values.yaml');
  writeFile(join(repo.cwd, spaced), values(container('space', '1Gi')));
  writeFile(join(repo.cwd, globbed), values(container('bracket', '1Gi')));
  writeFile(join(repo.cwd, tabbed), values(container('tab', '1Gi')));
  writeFile(join(repo.cwd, 'charts/plain/values.yaml'), values(container('plain', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, spaced), values(container('space', '2Gi')));
  writeFile(join(repo.cwd, globbed), values(container('bracket', '2Gi')));
  writeFile(join(repo.cwd, tabbed), values(container('tab', '2Gi')));
  commit(repo, 'bump three');

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const contexts = diffContexts(
    await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
    'path-safety',
  );
  assert.deepStrictEqual(filepaths(contexts), ['charts/a[b]/values.yaml', spaced, tabbed]);
  for (const context of contexts) {
    assert.deepStrictEqual(context.data, containerData(context.id.slice(2), '2Gi'));
    assert.ok(context.diff.includes(`+${memoryLine('2Gi')}`), `path-safety: ${context.filepath} carries no patch`);
  }
});

test('check --diff-only decides each changed scope and sends the context it reviewed', async () => {
  backend.reset();
  const repo = createRepo('decided-diff');
  const source = values(container('app', '2Gi'), container('side', '1Gi'));
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi'), container('side', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), source);
  commit(repo, 'app change');

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const entry = soleEntry(
    await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
    'diff decisions',
  );

  const contexts = contextsOf(entry, 'diff decisions');
  assert.strictEqual(contexts.length, 1, 'diff decisions: expected only the changed scope');
  // Each decision names the context it reviewed, so a report ties back to its own scope.
  assert.deepStrictEqual(entry.decisions, [
    { filepath: 'charts/app/values.yaml', scopeId: '0:app', follows: true, probability: 0.9, model: 'testmodel' },
  ]);
  assert.ok(contexts[0]!.diff!.includes(`+${memoryLine('2Gi')}`), 'diff decisions: expected the changed line');

  assert.strictEqual(backend.requests.length, 1, 'the changed scope is what was decided');
  const body = backend.requests[0]!.body;
  if (!isMapping(body)) throw new Error('the decision request must be a JSON mapping');
  // The scope is sent data-first: its location, its per-file patch and the data selected for it,
  // with the raw source text left out because the parsed data already carries the scope.
  const reviewed = contexts[0]!;
  assert.deepStrictEqual(
    body.state,
    { filepath: reviewed.filepath, diff: reviewed.diff, scope: { id: reviewed.id, data: reviewed.data } },
    'the request must carry the context the report does',
  );
  backend.reset();
});

test('check --diff-only skips vcs, dependency and rule directories', async () => {
  const repo = createRepo('skipped-dirs');
  writeFile(join(repo.cwd, 'src/app/values.yaml'), values(container('app', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'src/app/values.yaml'), values(container('app', '2Gi')));
  writeFile(join(repo.cwd, 'node_modules/pkg/values.yaml'), values(container('pkg', '1Gi')));
  writeFile(join(repo.cwd, '.rulekeeper/values.yaml'), values(container('rules', '1Gi')));
  commit(repo, 'bump app, add dependency and rule files');

  const rulePath = writeFile(join(repo.rules, 'any.yaml'), containersRule(['**/*.yaml']));
  const contexts = contextsOf(
    soleEntry(await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo), 'skipped-dirs'),
    'skipped-dirs',
  );

  assert.deepStrictEqual(filepaths(contexts), ['src/app/values.yaml']);
});

test('check --diff-only skips symlink and submodule entries', async () => {
  const repo = createRepo('skipped-modes');
  writeFile(join(repo.cwd, 'charts/real/values.yaml'), values(container('real', '1Gi')));
  commit(repo, 'base');
  const base = revParse(repo, 'HEAD');
  // A symlink (mode 120000) and a gitlink (mode 160000), committed beside a regular file.
  symlinkSync('real/values.yaml', join(repo.cwd, 'charts', 'link.yaml'));
  runGit(repo.cwd, ['add', '-A'], repo.env);
  runGit(repo.cwd, ['update-index', '--add', '--cacheinfo', `160000,${base},charts/sub`], repo.env);
  runGit(repo.cwd, ['commit', '-q', '-m', 'add link and submodule'], repo.env);
  const pinned = revParse(repo, 'HEAD');

  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/real/values.yaml'), values(container('real', '2Gi')));
  rmSync(join(repo.cwd, 'charts', 'link.yaml'));
  symlinkSync('real/other.yaml', join(repo.cwd, 'charts', 'link.yaml'));
  runGit(repo.cwd, ['add', '-A'], repo.env);
  runGit(repo.cwd, ['update-index', '--add', '--cacheinfo', `160000,${pinned},charts/sub`], repo.env);
  runGit(repo.cwd, ['commit', '-q', '-m', 'change link, bump real'], repo.env);

  const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  const contexts = diffContexts(
    await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'main'], repo),
    'skipped-modes',
  );
  assert.deepStrictEqual(filepaths(contexts), ['charts/real/values.yaml']);
  assert.deepStrictEqual(contexts[0]!.data, containerData('real', '2Gi'));
});

test('check --diff-only fails before reading any source', async () => {
  interface FailureCase {
    readonly label: string;
    readonly branch?: string;
    readonly prepare?: (repo: Sandbox) => void;
    readonly args: (rulePath: string) => readonly string[];
  }

  const cases: readonly FailureCase[] = [
    { label: 'a base without --diff-only', args: (rule) => ['check', '.', '--rules', rule, '--base', 'main'] },
    {
      label: 'a base ref that does not resolve',
      args: (rule) => ['check', '.', '--rules', rule, '--diff-only', '--base', 'no-such-ref'],
    },
    {
      label: 'a directory outside a Git repository',
      prepare: (repo) => rmSync(join(repo.cwd, '.git'), { recursive: true, force: true }),
      args: (rule) => ['check', '.', '--rules', rule, '--diff-only', '--base', 'main'],
    },
    { label: 'no default base branch', branch: 'work', args: (rule) => ['check', '.', '--rules', rule, '--diff-only'] },
    {
      label: 'a base that shares no history with HEAD',
      prepare: (repo) => {
        runGit(repo.cwd, ['checkout', '-q', '--orphan', 'orphan'], repo.env);
        runGit(repo.cwd, ['commit', '-q', '--allow-empty', '-m', 'orphan'], repo.env);
        runGit(repo.cwd, ['checkout', '-q', 'main'], repo.env);
      },
      args: (rule) => ['check', '.', '--rules', rule, '--diff-only', '--base', 'orphan'],
    },
    {
      label: 'a target outside the repository',
      args: (rule) => ['check', '..', '--rules', rule, '--diff-only', '--base', 'main'],
    },
  ];

  for (const { label, branch, prepare, args } of cases) {
    const repo = createRepo('failure', branch);
    writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
    commit(repo, 'base');
    prepare?.(repo);
    const rulePath = writeFile(join(repo.rules, 'containers.yaml'), containersRule(['charts/**/*.yaml']));

    assertFailed(await runCli(args(rulePath), repo), label);
  }
});

test('check --diff-only still discovers rules from both roots', async () => {
  const repo = createRepo('discovery');
  writeFile(join(repo.cwd, '.rulekeeper/containers.yaml'), containersRule(['charts/**/*.yaml']));
  writeFile(join(repo.home, '.rulekeeper', 'containers.yaml'), containersRule(['charts/**/*.yaml']));
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '2Gi')));
  commit(repo, 'feature change');

  const list = entries(await runCli(['check', '.', '--diff-only', '--base', 'main'], repo), 'discovery');

  assert.deepStrictEqual(list.map(entry => entry.name), ['containers', 'containers']);
  for (const entry of list) {
    const contexts = contextsOf(entry, `discovery ${entry.name}`);
    assert.deepStrictEqual(filepaths(contexts), ['charts/app/values.yaml']);
    assert.deepStrictEqual(contexts[0]!.data, containerData('app', '2Gi'));
  }
});

test('check --diff-only applies every rule of an explicit rules directory', async () => {
  const repo = createRepo('rules-dir');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '1Gi')));
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), values(container('app', '2Gi')));
  commit(repo, 'feature change');
  writeFile(join(repo.rules, 'a.yaml'), containersRule(['charts/**/*.yaml']));
  writeFile(join(repo.rules, 'b.yaml'), containersRule(['charts/**/*.yaml']));

  const list = entries(
    await runCli(['check', '.', '--rules', repo.rules, '--diff-only', '--base', 'main'], repo),
    'rules-dir',
  );

  assert.deepStrictEqual(list.map(entry => entry.name), ['a', 'b']);
  for (const entry of list) {
    const contexts = contextsOf(entry, `rules-dir ${entry.name}`);
    assert.deepStrictEqual(filepaths(contexts), ['charts/app/values.yaml']);
    assert.deepStrictEqual(contexts[0]!.data, containerData('app', '2Gi'));
  }
});

test('check --diff-only never reviews a descriptor an explicit --rules link resolves to', async () => {
  const repo = createRepo('rule-alias');
  // A whole-document rule that selects every YAML source, its own descriptor file included. The two
  // committed versions differ inside the document, so a leaked descriptor is a visible context.
  const rule = (instruction: string): string =>
    [
      "version: 'v1'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$'",
      'check:',
      `  rule: '${instruction}'`,
      '',
    ].join('\n');
  writeFile(join(repo.cwd, 'rules/policy.yaml'), rule('Review every source from the base copy.'));
  writeFile(join(repo.cwd, 'data.yaml'), 'value: 42\n');
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'rules/policy.yaml'), rule('Review every source once aliased.'));
  writeFile(join(repo.cwd, 'data.yaml'), 'value: 43\n');
  commit(repo, 'change rule and data');
  // Untracked links to that descriptor: the rule is loaded through them and no committed path
  // names them, so the descriptor must be excluded by the path they resolve to.
  symlinkSync(join(repo.cwd, 'rules/policy.yaml'), join(repo.cwd, 'alias.yaml'));
  symlinkSync(join(repo.cwd, 'rules'), join(repo.cwd, 'aliasdir'));

  for (const alias of ['alias.yaml', 'aliasdir']) {
    const label = `rule-alias ${alias}`;
    const contexts = diffContexts(
      await runCli(['check', '.', '--rules', alias, '--diff-only', '--base', 'main'], repo),
      label,
    );
    assert.deepStrictEqual(filepaths(contexts), ['data.yaml'], `${label}: wrong files`);
    assert.strictEqual(contexts[0]!.id, '0:', `${label}: wrong scope id`);
    assert.deepStrictEqual(contexts[0]!.data, { value: 43 }, `${label}: wrong scope data`);
    assert.ok(contexts[0]!.diff.includes('-value: 42'), `${label}: expected the base line`);
    assert.ok(contexts[0]!.diff.includes('+value: 43'), `${label}: expected the head line`);
  }
});
