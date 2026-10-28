import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { collectChanges } from '../dist/adapter/git/changes.js';
import { createSandbox, writeFile } from './support.ts';

const sandboxes = createSandbox('coderuler-git-changes-');
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
  git('config', 'user.name', 'CodeRuler Tests');
  git('config', 'user.email', 'coderuler@example.test');
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

  assert.deepEqual([...(await collectChanges(repo.cwd, 'HEAD')).changedFiles].sort(), [
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

  assert.deepEqual([...(await collectChanges(join(repo.cwd, 'nested'), base)).changedFiles].sort(), [
    'committed.txt', 'new file.txt',
  ]);
  assert.deepEqual([...(await collectChanges(join(repo.cwd, 'nested'), 'HEAD')).changedFiles], ['new file.txt']);
});

test('Git changes reject invalid bases, option-like bases and nonrepositories', async () => {
  const repo = repository('invalid-base');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  for (const base of ['missing-ref', '--help', 'HEAD --name-only']) {
    await assert.rejects(collectChanges(repo.cwd, base), /Git.*base|base.*Git/);
  }
  const plain = sandboxes.isolated('not-a-repository');
  await assert.rejects(collectChanges(plain.cwd, 'HEAD'), /not a git repository/i);
});

test('Git changes stream path lists larger than subprocess buffer defaults', async () => {
  const repo = repository('large-output');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  const directory = 'a'.repeat(160);
  mkdirSync(join(repo.cwd, directory));
  const paths = Array.from({ length: 5_000 }, (_, index) => `${directory}/${String(index).padStart(5, '0')}-${'b'.repeat(75)}.txt`);
  for (const path of paths) writeFile(join(repo.cwd, path), 'old\n');
  const largePath = 'large-patch.txt';
  writeFile(join(repo.cwd, largePath), Array.from({ length: 15_000 }, (_, index) => `old ${String(index).padStart(5, '0')} ${'x'.repeat(80)}\n`).join(''));
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  for (const path of paths) writeFile(join(repo.cwd, path), 'new\n');
  writeFile(join(repo.cwd, largePath), Array.from({ length: 15_000 }, (_, index) => `new ${String(index).padStart(5, '0')} ${'y'.repeat(80)}\n`).join(''));

  const changes = await collectChanges(repo.cwd, 'HEAD');
  assert.deepEqual([...changes.changedFiles].sort(), [...paths, largePath].sort());
  assert.deepEqual(changes.changedLines.get(paths[0]!), [{ start: 1, end: 1 }]);
  assert.deepEqual(changes.changedLines.get(paths.at(-1)!), [{ start: 1, end: 1 }]);
  assert.deepEqual(changes.changedLines.get(largePath), [{ start: 1, end: 15_000 }]);
});

test('Git changes retain normal traversal boundaries even for deleted reserved paths', async () => {
  const repo = repository('reserved-paths');
  const excluded = [
    'old/deleted.txt', 'nested/node_modules/deleted.txt', '.coderuler/deleted.txt',
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

  assert.deepEqual([...(await collectChanges(repo.cwd, 'HEAD')).changedFiles].sort(), included.sort());
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

  assert.deepEqual([...(await collectChanges(repo.cwd, 'HEAD')).changedFiles], ['removed.txt']);
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

  const changes = await collectChanges(repo.cwd, 'HEAD');
  assert.deepEqual([...changes.changedFiles].sort(), [
    'assets/upper.txt', 'folder/keep.txt', 'folder/missing/deleted.config',
  ]);
  assert.deepEqual(changes.changedLines.get('assets/upper.txt'), [{ start: 1, end: 1 }]);
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

    assert.deepEqual([...(await collectChanges(repo.cwd, 'HEAD')).changedFiles].sort(), after === 'old' ? [] : [
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

  assert.deepEqual([...(await collectChanges(repo.cwd, 'HEAD')).changedFiles].sort(), [
    'OLD/UPPER.txt', 'assets/UPPER.txt',
  ]);
});
test('Git changes collect exact ranges for tracked and untracked text', async () => {
  const repo = repository('line-ranges');
  writeFile(join(repo.cwd, 'replace.txt'), 'one\ntwo\nthree\n');
  writeFile(join(repo.cwd, 'separated.txt'), 'a\nb\nc\nd\ne\n');
  writeFile(join(repo.cwd, 'delete.txt'), 'gone\nstay\n');
  writeFile(join(repo.cwd, 'complete-delete.txt'), 'gone\n');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  writeFile(join(repo.cwd, 'replace.txt'), 'one\nchanged\nthree\n');
  writeFile(join(repo.cwd, 'separated.txt'), 'A\nb\nc\nD\ne\n');
  writeFile(join(repo.cwd, 'delete.txt'), 'stay\n');
  rmSync(join(repo.cwd, 'complete-delete.txt'));
  writeFile(join(repo.cwd, 'untracked-final-newline.txt'), 'a\nb\n');
  writeFile(join(repo.cwd, 'untracked-no-final-newline.txt'), 'a\nb');
  writeFile(join(repo.cwd, 'untracked-empty.txt'), '');

  const changes = await collectChanges(repo.cwd, 'HEAD');
  assert.deepEqual(changes.changedLines.get('replace.txt'), [{ start: 2, end: 2 }]);
  assert.deepEqual(changes.changedLines.get('separated.txt'), [
    { start: 1, end: 1 }, { start: 4, end: 4 },
  ]);
  assert.deepEqual(changes.changedLines.get('delete.txt'), []);
  assert.deepEqual(changes.changedLines.get('complete-delete.txt'), []);
  assert.deepEqual(changes.changedLines.get('untracked-final-newline.txt'), [{ start: 1, end: 2 }]);
  assert.deepEqual(changes.changedLines.get('untracked-no-final-newline.txt'), [{ start: 1, end: 2 }]);
  assert.deepEqual(changes.changedLines.get('untracked-empty.txt'), []);
  for (const path of ['delete.txt', 'complete-delete.txt']) assert.ok(changes.changedFiles.has(path));
});

test('Git changes mark binary and conversion-attributed line data unavailable', async () => {
  const repo = repository('unavailable-lines');
  writeFile(join(repo.cwd, 'mode-only.txt'), 'same\n');
  writeFileSync(join(repo.cwd, 'tracked-binary.bin'), Buffer.from([0, 1, 2]));
  writeFile(join(repo.cwd, 'filtered.txt'), 'before\nkeep\n');
  writeFile(join(repo.cwd, 'encoding.txt'), 'plain\n');
  writeFile(join(repo.cwd, 'attributed-mode-only.txt'), 'stable\n');
  writeFile(join(repo.cwd, '.gitattributes'), 'filtered.txt filter=drop-first\nencoding.txt working-tree-encoding=UTF-8\nattributed-mode-only.txt filter=identity\n');

  repo.git('config', 'filter.identity.clean', 'cat');
  repo.git('config', 'filter.identity.smudge', 'cat');
  repo.git('config', 'filter.drop-first.clean', 'tail -n +2');
  repo.git('config', 'filter.drop-first.smudge', 'cat');
  repo.git('add', '.');
  repo.git('update-index', '--chmod=+x', 'mode-only.txt');
  repo.git('update-index', '--chmod=+x', 'attributed-mode-only.txt');
  repo.git('commit', '--quiet', '-m', 'base');
  writeFileSync(join(repo.cwd, 'tracked-binary.bin'), Buffer.from([0, 3, 4]));
  writeFileSync(join(repo.cwd, 'untracked-binary.bin'), Buffer.from([0, 5]));
  writeFile(join(repo.cwd, 'filtered.txt'), 'after\nkeep changed\n');
  writeFile(join(repo.cwd, 'encoding.txt'), 'converted\n');
  writeFile(join(repo.cwd, 'ordinary.txt'), 'new\n');
  repo.git('update-index', '--chmod=-x', 'mode-only.txt');
  repo.git('update-index', '--chmod=-x', 'attributed-mode-only.txt');


  const changes = await collectChanges(repo.cwd, 'HEAD');
  for (const path of ['tracked-binary.bin', 'filtered.txt', 'encoding.txt', 'untracked-binary.bin']) {
    assert.ok(changes.changedFiles.has(path));
    assert.equal(changes.changedLines.has(path), false, path);
  }
  assert.deepEqual(changes.changedLines.get('ordinary.txt'), [{ start: 1, end: 1 }]);
  assert.deepEqual(changes.changedLines.get('mode-only.txt'), []);
  assert.deepEqual(changes.changedLines.get('attributed-mode-only.txt'), []);
});

test('Git changes mark untracked binary replacements unavailable', async () => {
  const repo = repository('binary-replacement');
  writeFile(join(repo.cwd, 'binary.bin'), 'tracked text\n');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  repo.git('rm', '--cached', '--quiet', 'binary.bin');
  writeFileSync(join(repo.cwd, 'binary.bin'), Buffer.from([0, 1, 2]));

  const changes = await collectChanges(repo.cwd, 'HEAD');

  assert.ok(changes.changedFiles.has('binary.bin'));
  assert.equal(changes.changedLines.has('binary.bin'), false);
});

test('Git changes ignore inherited diff context and preserve unusual raw paths', async () => {
  const repo = repository('diff-context-and-paths');
  const paths = ['space name.txt', 'tab\tname.txt', 'line\nbreak.txt', 'café.txt', 'patch-like.txt'];
  for (const path of paths) writeFile(join(repo.cwd, path), 'old\nline\n');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  for (const path of paths.slice(0, 4)) writeFile(join(repo.cwd, path), 'old\nnew\n');
  writeFile(join(repo.cwd, 'patch-like.txt'), 'diff --git a/x b/x\n@@ -1 +1 @@\nold\nnew\n');

  const changes = await collectChanges(repo.cwd, 'HEAD', { ...repo.env, GIT_DIFF_OPTS: '--unified=3' });
  for (const path of paths.slice(0, 4)) assert.deepEqual(changes.changedLines.get(path), [{ start: 2, end: 2 }]);
  assert.deepEqual(changes.changedLines.get('patch-like.txt'), [{ start: 1, end: 2 }, { start: 4, end: 4 }]);

});

test('Git changes reject unresolved conflicts', async () => {
  const repo = repository('conflicts');
  writeFile(join(repo.cwd, 'conflict.txt'), 'base\n');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  const defaultBranch = repo.git('branch', '--show-current');
  repo.git('checkout', '-qb', 'other');
  writeFile(join(repo.cwd, 'conflict.txt'), 'other\n');
  repo.git('commit', '--quiet', '-am', 'other');
  repo.git('checkout', '-q', defaultBranch);
  writeFile(join(repo.cwd, 'conflict.txt'), 'main\n');
  repo.git('commit', '--quiet', '-am', 'main');
  try { repo.git('merge', 'other'); } catch { /* merge conflict is the fixture */ }
  await assert.rejects(collectChanges(repo.cwd, 'HEAD'), /Cannot collect changed lines: resolve Git conflicts first\./);
});
test('Git changes keep rename deletion and addition path ranges separate', async () => {
  const repo = repository('rename-ranges');
  writeFile(join(repo.cwd, 'old.txt'), 'old\n');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  renameSync(join(repo.cwd, 'old.txt'), join(repo.cwd, 'new.txt'));
  writeFile(join(repo.cwd, 'new.txt'), 'first\nsecond\n');

  const changes = await collectChanges(repo.cwd, 'HEAD');
  assert.deepEqual(changes.changedLines.get('old.txt'), []);
  assert.deepEqual(changes.changedLines.get('new.txt'), [{ start: 1, end: 2 }]);
});

test('Git changes count CRLF and missing-final-newline tracked text correctly', async () => {
  const repo = repository('line-endings');
  writeFile(join(repo.cwd, 'crlf.txt'), 'one\r\ntwo\r\n');
  writeFile(join(repo.cwd, 'no-final-newline.txt'), 'one\ntwo');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  writeFile(join(repo.cwd, 'crlf.txt'), 'one\r\nchanged\r\n');
  writeFile(join(repo.cwd, 'no-final-newline.txt'), 'one\nchanged');

  const changes = await collectChanges(repo.cwd, 'HEAD');
  assert.deepEqual(changes.changedLines.get('crlf.txt'), [{ start: 2, end: 2 }]);
  assert.deepEqual(changes.changedLines.get('no-final-newline.txt'), [{ start: 2, end: 2 }]);
});
test('Git changes consume both blocks of a symlink-to-regular type change', async () => {
  const repo = repository('type-change');
  writeFile(join(repo.cwd, 'switch.txt'), 'symlink target\n');
  writeFile(join(repo.cwd, 'following.txt'), 'old\n');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'base');
  rmSync(join(repo.cwd, 'switch.txt'));
  symlinkSync('external-target.txt', join(repo.cwd, 'switch.txt'));
  repo.git('add', '-A');
  repo.git('commit', '--quiet', '-m', 'symlink');
  rmSync(join(repo.cwd, 'switch.txt'));
  writeFile(join(repo.cwd, 'switch.txt'), 'regular\nadded\n');
  writeFile(join(repo.cwd, 'following.txt'), 'new\n');

  const changes = await collectChanges(repo.cwd, 'HEAD');
  assert.deepEqual(changes.changedLines.get('switch.txt'), [{ start: 1, end: 2 }]);
  assert.deepEqual(changes.changedLines.get('following.txt'), [{ start: 1, end: 1 }]);
});
