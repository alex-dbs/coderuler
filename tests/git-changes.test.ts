import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { changedFiles } from '../dist/adapter/git/changes.js';
import { createSandbox, writeFile } from './support.ts';

const sandboxes = createSandbox('rulekeeper-git-changes-');
after(() => sandboxes.cleanup());

function repository(label: string) {
  const sandbox = sandboxes.isolated(label);
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: sandbox.cwd,
    env: sandbox.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Rulekeeper Tests');
  git('config', 'user.email', 'rulekeeper@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFile(join(sandbox.cwd, '.gitignore'), 'node_modules/\nignored/\n');
  return { ...sandbox, git };
}

test('Git changes compare the base directly with staged, unstaged and untracked worktree paths', async () => {
  const repo = repository('working-tree');
  for (const path of ['staged.txt', 'unstaged.txt', 'deleted.txt', 'old name.txt', 'restored.txt']) {
    writeFile(join(repo.cwd, path), 'base\n');
  }
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  writeFile(join(repo.cwd, 'staged.txt'), 'staged\n');
  writeFile(join(repo.cwd, 'restored.txt'), 'staged\n');
  repo.git('add', 'staged.txt', 'restored.txt');
  writeFile(join(repo.cwd, 'restored.txt'), 'base\n');
  writeFile(join(repo.cwd, 'unstaged.txt'), 'unstaged\n');
  rmSync(join(repo.cwd, 'deleted.txt'));
  renameSync(join(repo.cwd, 'old name.txt'), join(repo.cwd, 'new\nname.txt'));
  repo.git('add', '--', 'old name.txt', 'new\nname.txt');
  writeFile(join(repo.cwd, 'untracked\nfile.txt'), 'new\n');
  writeFile(join(repo.cwd, 'ignored', 'hidden.txt'), 'ignored\n');

  assert.deepEqual([...await changedFiles(repo.cwd, 'HEAD')].sort(), [
    'deleted.txt', 'new\nname.txt', 'old name.txt', 'staged.txt',
    'unstaged.txt', 'untracked\nfile.txt',
  ].sort());
});

test('Git changes use the explicit base and paths relative to a nested project root', async () => {
  const repo = repository('nested-base');
  writeFile(join(repo.cwd, 'nested', 'committed.txt'), 'base\n');
  writeFile(join(repo.cwd, 'outside.txt'), 'base\n');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  const base = repo.git('rev-parse', 'HEAD');
  writeFile(join(repo.cwd, 'nested', 'committed.txt'), 'committed\n');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'later');
  writeFile(join(repo.cwd, 'outside.txt'), 'outside\n');
  writeFile(join(repo.cwd, 'nested', 'new file.txt'), 'new\n');

  assert.deepEqual([...await changedFiles(join(repo.cwd, 'nested'), base)].sort(), [
    'committed.txt', 'new file.txt',
  ]);
  assert.deepEqual([...await changedFiles(join(repo.cwd, 'nested'), 'HEAD')], ['new file.txt']);
});

test('Git changes reject invalid bases, option-like bases and nonrepositories', async () => {
  const repo = repository('invalid-base');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  for (const base of ['missing-ref', '--help', 'HEAD --name-only']) {
    await assert.rejects(changedFiles(repo.cwd, base), /Git.*base|base.*Git/);
  }
  const plain = sandboxes.isolated('not-a-repository');
  await assert.rejects(changedFiles(plain.cwd, 'HEAD'), /not a git repository/i);
});

test('Git changes stream path lists larger than subprocess buffer defaults', async () => {
  const repo = repository('large-output');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  const directory = 'a'.repeat(160);
  mkdirSync(join(repo.cwd, directory));
  const paths = Array.from({ length: 5_000 }, (_, index) => `${directory}/${String(index).padStart(5, '0')}-${'b'.repeat(75)}.txt`);
  for (const path of paths) writeFile(join(repo.cwd, path), 'new\n');

  assert.deepEqual([...await changedFiles(repo.cwd, 'HEAD')].sort(), paths.sort());
});

test('Git changes retain normal traversal boundaries even for deleted reserved paths', async () => {
  const repo = repository('reserved-paths');
  const excluded = [
    'old/deleted.txt', 'nested/node_modules/deleted.txt', '.rulekeeper/deleted.txt',
    'dist/deleted.txt', 'coverage/deleted.txt',
  ];
  const included = ['nested/dist/changed.txt', 'nested/coverage/changed.txt', 'notes/old', 'notes/dist'];
  for (const path of [...excluded, ...included]) writeFile(join(repo.cwd, path), 'base\n');
  repo.git('add', '.');
  repo.git('add', '--force', '--', ...excluded);
  repo.git('commit', '--quiet', '-m', 'base');
  for (const path of excluded) rmSync(join(repo.cwd, path));
  for (const path of included) writeFile(join(repo.cwd, path), 'changed\n');
  writeFile(join(repo.cwd, 'old', 'new.txt'), 'new\n');
  writeFile(join(repo.cwd, 'dist', 'new.txt'), 'new\n');

  assert.deepEqual([...await changedFiles(repo.cwd, 'HEAD')].sort(), included.sort());
});

test('Git changes exclude current symlinks and descendants without dropping eligible deletions', async () => {
  const repo = repository('symlink-paths');
  for (const path of ['modified.txt', 'folder/tracked.txt', 'removed.txt']) {
    writeFile(join(repo.cwd, path), 'base\n');
  }
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  const external = join(repo.root, 'external');
  writeFile(join(external, 'tracked.txt'), 'outside\n');
  rmSync(join(repo.cwd, 'modified.txt'));
  rmSync(join(repo.cwd, 'folder'), { recursive: true });
  rmSync(join(repo.cwd, 'removed.txt'));
  symlinkSync(join(external, 'tracked.txt'), join(repo.cwd, 'modified.txt'));
  symlinkSync(join(external, 'tracked.txt'), join(repo.cwd, 'untracked.txt'));
  symlinkSync(external, join(repo.cwd, 'folder'), 'dir');

  assert.deepEqual([...await changedFiles(repo.cwd, 'HEAD')], ['removed.txt']);
});

test('Git changes use physical spelling for case-only renames and deleted descendants', async t => {
  const repo = repository('case-renames');
  if (!existsSync(join(repo.cwd, 'PACKAGE.JSON'))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  repo.git('config', 'core.ignorecase', 'true');
  for (const path of ['assets/UPPER.txt', 'FOLDER/keep.txt', 'FOLDER/missing/deleted.config']) {
    writeFile(join(repo.cwd, path), 'base\n');
  }
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  renameSync(join(repo.cwd, 'assets/UPPER.txt'), join(repo.cwd, 'assets/intermediate.txt'));
  renameSync(join(repo.cwd, 'assets/intermediate.txt'), join(repo.cwd, 'assets/upper.txt'));
  renameSync(join(repo.cwd, 'FOLDER'), join(repo.cwd, 'intermediate'));
  renameSync(join(repo.cwd, 'intermediate'), join(repo.cwd, 'folder'));
  writeFile(join(repo.cwd, 'assets/upper.txt'), 'changed\n');
  writeFile(join(repo.cwd, 'folder/keep.txt'), 'changed\n');
  rmSync(join(repo.cwd, 'folder/missing'), { recursive: true });

  assert.deepEqual([...await changedFiles(repo.cwd, 'HEAD')].sort(), [
    'assets/upper.txt', 'folder/keep.txt', 'folder/missing/deleted.config',
  ]);
});

test('Git changes apply reserved exclusions to physical directory spelling, including deletions', async t => {
  for (const [before, after] of [['OLD', 'old'], ['old', 'OLD']] as const) {
    const repo = repository(`case-reserved-${before}`);
    if (!existsSync(join(repo.cwd, 'PACKAGE.JSON'))) {
      t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
      return;
    }
    repo.git('config', 'core.ignorecase', 'true');
    writeFile(join(repo.cwd, before, 'hidden.txt'), 'base\n');
    writeFile(join(repo.cwd, before, 'missing/deleted.config'), 'base\n');
    repo.git('add', '.');
    repo.git('commit', '--quiet', '-m', 'base');
    renameSync(join(repo.cwd, before), join(repo.cwd, 'intermediate'));
    renameSync(join(repo.cwd, 'intermediate'), join(repo.cwd, after));
    writeFile(join(repo.cwd, after, 'hidden.txt'), 'changed\n');
    rmSync(join(repo.cwd, after, 'missing'), { recursive: true });

    assert.deepEqual([...await changedFiles(repo.cwd, 'HEAD')].sort(), after === 'old' ? [] : [
      'OLD/hidden.txt', 'OLD/missing/deleted.config',
    ]);
  }
});

test('Git changes retain uppercase physical names without weakening symlink boundaries', async () => {
  const repo = repository('physical-uppercase');
  for (const path of ['OLD/UPPER.txt', 'assets/UPPER.txt', 'links/removed.txt']) {
    writeFile(join(repo.cwd, path), 'base\n');
  }
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  writeFile(join(repo.cwd, 'OLD/UPPER.txt'), 'changed\n');
  writeFile(join(repo.cwd, 'assets/UPPER.txt'), 'changed\n');
  rmSync(join(repo.cwd, 'links'), { recursive: true });
  symlinkSync(join(repo.cwd, 'OLD'), join(repo.cwd, 'links'), 'dir');

  assert.deepEqual([...await changedFiles(repo.cwd, 'HEAD')].sort(), [
    'OLD/UPPER.txt', 'assets/UPPER.txt',
  ]);
});
