import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  createSandbox,
  parseCheckOutput,
  runCli,
  writeFile,
  type CheckReportShape,
  type Sandbox,
} from './support.ts';

const sandbox = createSandbox('coderuler-cli-diff-');
after(() => sandbox.cleanup());

function git(target: Sandbox, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: target.cwd,
    env: { ...target.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function files(target: Sandbox, entries: Readonly<Record<string, string>>): void {
  for (const [path, contents] of Object.entries(entries)) writeFile(join(target.cwd, path), contents);
}

function rule(target: Sandbox, name: string, fields = '', pattern = 'src/**/*.txt'): void {
  writeFile(join(target.cwd, '.coderuler', `${name}.rule.ts`), `import { Rule, pass, violation, scopes } from '@alex-dbs/coderuler';
export default class Local extends Rule {
  files = [${JSON.stringify(pattern)}];
  ${fields}
  check = subject => subject.kind === 'scope' && subject.source.includes('BAD') ? violation('Bad content') : pass();
}
`);
}

function commit(target: Sandbox): string {
  git(target, 'add', '--all');
  git(target, 'commit', '-m', 'fixture');
  return git(target, 'rev-parse', 'HEAD');
}

function repository(label: string): Sandbox {
  const target = sandbox.isolated(label);
  files(target, { '.gitignore': 'node_modules/\n' });
  git(target, 'init', '--initial-branch=main');
  git(target, 'config', 'user.name', 'CodeRuler tests');
  git(target, 'config', 'user.email', 'tests@example.invalid');
  git(target, 'config', 'commit.gpgsign', 'false');
  return target;
}

async function check(target: Sandbox, ...args: string[]): Promise<readonly CheckReportShape[]> {
  return parseCheckOutput(await runCli(['check', ...args, '--json', '--output-all'], target), args.join(' ') || 'normal');
}

function scopes(reports: readonly CheckReportShape[]): readonly unknown[] {
  return reports.flatMap(report => report.evaluations.map(({ subject, result }) => {
    assert.equal(subject.kind, 'scope');
    if (subject.kind !== 'scope') throw new Error('Expected a scope');
    return { filepath: subject.filepath, source: subject.source, status: result.status };
  })).sort((a, b) => a.filepath.localeCompare(b.filepath));
}

function groups(reports: readonly CheckReportShape[]): readonly unknown[] {
  return reports.flatMap(report => report.evaluations.map(({ subject }) => {
    assert.equal(subject.kind, 'group');
    if (subject.kind !== 'group') throw new Error('Expected a group');
    return {
      rule: report.name,
      ...subject.group,
      members: subject.members.map(member => ({ filepath: member.filepath, source: member.source })),
    };
  }));
}

function skipped(reports: readonly CheckReportShape[], names: readonly string[]): void {
  assert.deepEqual(reports.map(({ name, status, evaluations }) => ({ name, status, evaluations })),
    names.map(name => ({ name, status: 'skipped', evaluations: [] })));
}

test('normal checks include unchanged violations while diff checks evaluate only changed files', async () => {
  const target = repository('subset');
  rule(target, 'local');
  files(target, { 'src/unchanged.txt': 'BAD unchanged\n', 'src/changed.txt': 'clean before\n' });
  commit(target);
  files(target, { 'src/changed.txt': 'clean after\n' });

  const normal = await runCli(['check', '--json', '--output-all'], target);
  assert.equal(normal.status, 1, normal.stderr);
  assert.deepEqual(scopes(parseCheckOutput(normal, 'normal')), [
    { filepath: 'src/changed.txt', source: 'clean after\n', status: 'pass' },
    { filepath: 'src/unchanged.txt', source: 'BAD unchanged\n', status: 'violation' },
  ]);

  const diff = await runCli(['check', '--diff-only', '--json', '--output-all'], target);
  assert.equal(diff.status, 0, diff.stderr);
  assert.deepEqual(scopes(parseCheckOutput(diff, 'diff')), [
    { filepath: 'src/changed.txt', source: 'clean after\n', status: 'pass' },
  ]);
});

test('diff compares the explicit base directly with committed, staged, unstaged and untracked current files', async () => {
  const target = repository('states');
  rule(target, 'local');
  files(target, {
    'src/committed.txt': 'before\n',
    'src/staged.txt': 'before\n',
    'src/unstaged.txt': 'before\n',
    'src/unchanged.txt': 'BAD unchanged\n',
  });
  const base = commit(target);
  files(target, { 'src/committed.txt': 'committed\n' });
  commit(target);
  files(target, { 'src/staged.txt': 'staged\n' });
  git(target, 'add', '--', 'src/staged.txt');
  files(target, { 'src/unstaged.txt': 'unstaged\n', 'src/untracked.txt': 'untracked\n' });

  assert.deepEqual(scopes(await check(target, '--diff-only', '--base', base)), [
    { filepath: 'src/committed.txt', source: 'committed\n', status: 'pass' },
    { filepath: 'src/staged.txt', source: 'staged\n', status: 'pass' },
    { filepath: 'src/unstaged.txt', source: 'unstaged\n', status: 'pass' },
    { filepath: 'src/untracked.txt', source: 'untracked\n', status: 'pass' },
  ]);
  assert.deepEqual(scopes(await check(target, '--diff-only')), [
    { filepath: 'src/staged.txt', source: 'staged\n', status: 'pass' },
    { filepath: 'src/unstaged.txt', source: 'unstaged\n', status: 'pass' },
    { filepath: 'src/untracked.txt', source: 'untracked\n', status: 'pass' },
  ]);
});

test('scope and file groups retain every current scope in a changed file', async () => {
  const target = repository('whole-scopes');
  const fields = "scope = scopes.json({ path: '$.items[*]' });";
  rule(target, 'scoped', fields, 'src/*.json');
  rule(target, 'file-group', `${fields}\n  group = 'file';`, 'src/*.json');
  files(target, { 'src/changed.json': '{"items":["before","BAD unchanged"]}\n' });
  commit(target);
  files(target, { 'src/changed.json': '{"items":["after","BAD unchanged"]}\n' });

  const reports = await check(target, '--diff-only');
  assert.deepEqual(reports.map(report => ({
    name: report.name,
    kinds: report.evaluations.map(({ subject }) => subject.kind),
    data: report.evaluations.flatMap(({ subject }) => subject.kind === 'group'
      ? subject.members.map(member => member.data)
      : [subject.data]),
  })), [
    { name: 'file-group', kinds: ['group'], data: ['after', 'BAD unchanged'] },
    { name: 'scoped', kinds: ['scope', 'scope'], data: ['after', 'BAD unchanged'] },
  ]);
});

test('case-only file renames evaluate physical scope, custom-selector and file-group subjects', async t => {
  const target = repository('case-file-rename');
  if (!existsSync(join(target.cwd, 'PACKAGE.JSON'))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  git(target, 'config', 'core.ignorecase', 'true');
  rule(target, 'scoped', '', 'assets/*.txt');
  rule(target, 'file-group', "group = 'file';", 'assets/*.txt');
  rule(target, 'custom', `async select(context) {
    return Promise.all((await context.project.glob(this.files)).map(async filepath => ({
      kind: 'scope', filepath, id: 'custom', source: await context.project.readText(filepath),
    })));
  }`, 'assets/*.txt');
  files(target, { 'assets/UPPER.txt': 'before\n', 'assets/unchanged.txt': 'unchanged\n' });
  commit(target);
  renameSync(join(target.cwd, 'assets/UPPER.txt'), join(target.cwd, 'assets/intermediate.txt'));
  renameSync(join(target.cwd, 'assets/intermediate.txt'), join(target.cwd, 'assets/upper.txt'));
  files(target, { 'assets/upper.txt': 'BAD changed\n' });

  const reports = await check(target, '--diff-only');
  assert.deepEqual(reports.filter(report => report.name !== 'file-group').map(report => ({
    name: report.name,
    scopes: scopes([report]),
  })), ['custom', 'scoped'].map(name => ({
    name,
    scopes: [{ filepath: 'assets/upper.txt', source: 'BAD changed\n', status: 'violation' }],
  })));
  assert.deepEqual(groups(reports.filter(report => report.name === 'file-group')), [{
    rule: 'file-group', type: 'file', path: 'assets/upper.txt',
    members: [{ filepath: 'assets/upper.txt', source: 'BAD changed\n' }],
  }]);
});

test('case-renamed reserved directories follow physical spelling for surviving groups', async t => {
  for (const [before, after] of [['OLD', 'old'], ['old', 'OLD']] as const) {
    const target = repository(`case-reserved-${before}`);
    if (!existsSync(join(target.cwd, 'PACKAGE.JSON'))) {
      t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
      return;
    }
    git(target, 'config', 'core.ignorecase', 'true');
    rule(target, 'folder', "group = 'folder';", '**/*.txt');
    rule(target, 'project', "group = 'project';", '**/*.txt');
    files(target, { [`${before}/hidden.txt`]: 'before\n', 'src/keep.txt': 'unchanged\n' });
    commit(target);
    renameSync(join(target.cwd, before), join(target.cwd, 'intermediate'));
    renameSync(join(target.cwd, 'intermediate'), join(target.cwd, after));
    files(target, { [`${after}/hidden.txt`]: 'changed\n' });

    const reports = await check(target, '--diff-only');
    if (after === 'old') {
      skipped(reports, ['folder', 'project']);
    } else {
      assert.deepEqual(groups(reports), [
        {
          rule: 'folder', type: 'folder', path: 'OLD',
          members: [{ filepath: 'OLD/hidden.txt', source: 'changed\n' }],
        },
        {
          rule: 'project', type: 'project', path: '.',
          members: [
            { filepath: 'OLD/hidden.txt', source: 'changed\n' },
            { filepath: 'src/keep.txt', source: 'unchanged\n' },
          ],
        },
      ]);
    }
  }
});

test('deleted descendants of case-renamed ancestors trigger the physical surviving folder', async t => {
  const target = repository('case-deleted-descendant');
  if (!existsSync(join(target.cwd, 'PACKAGE.JSON'))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  git(target, 'config', 'core.ignorecase', 'true');
  rule(target, 'folder', "group = 'folder';", '**/*.txt');
  files(target, { 'FOLDER/keep.txt': 'unchanged\n', 'FOLDER/missing/deleted.config': 'metadata\n' });
  commit(target);
  renameSync(join(target.cwd, 'FOLDER'), join(target.cwd, 'intermediate'));
  renameSync(join(target.cwd, 'intermediate'), join(target.cwd, 'folder'));
  rmSync(join(target.cwd, 'folder/missing'), { recursive: true });

  assert.deepEqual(groups(await check(target, '--diff-only')), [{
    rule: 'folder', type: 'folder', path: 'folder',
    members: [{ filepath: 'folder/keep.txt', source: 'unchanged\n' }],
  }]);
});

test('affected folders retain unchanged members, untouched folders skip, and project groups retain all members', async () => {
  const target = repository('groups');
  rule(target, 'folder', "group = 'folder';");
  rule(target, 'project', "group = 'project';");
  files(target, {
    'src/dev/a.txt': 'before\n',
    'src/dev/b.txt': 'unchanged dev\n',
    'src/prod/c.txt': 'unchanged prod\n',
  });
  commit(target);
  files(target, { 'src/dev/a.txt': 'after\n' });

  assert.deepEqual(groups(await check(target, '--diff-only')), [
    {
      rule: 'folder', type: 'folder', path: 'src/dev',
      members: [
        { filepath: 'src/dev/a.txt', source: 'after\n' },
        { filepath: 'src/dev/b.txt', source: 'unchanged dev\n' },
      ],
    },
    {
      rule: 'project', type: 'project', path: '.',
      members: [
        { filepath: 'src/dev/a.txt', source: 'after\n' },
        { filepath: 'src/dev/b.txt', source: 'unchanged dev\n' },
        { filepath: 'src/prod/c.txt', source: 'unchanged prod\n' },
      ],
    },
  ]);
});

test('deleted nonmember paths still trigger their folder and project groups', async () => {
  const target = repository('deleted-only');
  rule(target, 'folder', "group = 'folder';");
  rule(target, 'project', "group = 'project';");
  files(target, {
    'src/dev/keep.txt': 'dev\n',
    'src/dev/deleted.config': 'old metadata\n',
    'src/prod/keep.txt': 'prod\n',
  });
  commit(target);
  git(target, 'rm', '--', 'src/dev/deleted.config');

  assert.deepEqual(groups(await check(target, '--diff-only')), [
    {
      rule: 'folder', type: 'folder', path: 'src/dev',
      members: [{ filepath: 'src/dev/keep.txt', source: 'dev\n' }],
    },
    {
      rule: 'project', type: 'project', path: '.',
      members: [
        { filepath: 'src/dev/keep.txt', source: 'dev\n' },
        { filepath: 'src/prod/keep.txt', source: 'prod\n' },
      ],
    },
  ]);
});

test('renames trigger both the old and new folders without resurrecting old members', async () => {
  const target = repository('renamed');
  rule(target, 'folder', "group = 'folder';");
  files(target, {
    'src/dev/keep.txt': 'dev\n',
    'src/dev/moved.txt': 'moving\n',
    'src/prod/keep.txt': 'prod\n',
  });
  commit(target);
  git(target, 'mv', '--', 'src/dev/moved.txt', 'src/prod/moved.txt');

  assert.deepEqual(groups(await check(target, '--diff-only')), [
    {
      rule: 'folder', type: 'folder', path: 'src/dev',
      members: [{ filepath: 'src/dev/keep.txt', source: 'dev\n' }],
    },
    {
      rule: 'folder', type: 'folder', path: 'src/prod',
      members: [
        { filepath: 'src/prod/keep.txt', source: 'prod\n' },
        { filepath: 'src/prod/moved.txt', source: 'moving\n' },
      ],
    },
  ]);
});

test('folder levels trigger the ancestor group and retain members in sibling directories', async () => {
  const target = repository('folder-level');
  rule(target, 'folder', "group = { by: 'folder', level: -1 };");
  files(target, {
    'src/dev/one/a.txt': 'before\n',
    'src/dev/two/b.txt': 'sibling\n',
    'src/prod/one/c.txt': 'untouched\n',
  });
  commit(target);
  files(target, { 'src/dev/one/a.txt': 'after\n' });

  assert.deepEqual(groups(await check(target, '--diff-only')), [{
    rule: 'folder', type: 'folder', path: 'src/dev',
    members: [
      { filepath: 'src/dev/one/a.txt', source: 'after\n' },
      { filepath: 'src/dev/two/b.txt', source: 'sibling\n' },
    ],
  }]);
});

test('an empty diff skips file, folder and project rules', async () => {
  const target = repository('empty');
  rule(target, 'file');
  rule(target, 'folder', "group = 'folder';");
  rule(target, 'project', "group = 'project';");
  files(target, { 'src/a.txt': 'BAD unchanged\n' });
  commit(target);

  skipped(await check(target, '--diff-only'), ['file', 'folder', 'project']);
});

test('target narrowing excludes outside changes from project and folder triggers', async () => {
  const target = repository('target');
  rule(target, 'folder', "group = { by: 'folder', level: -1 };");
  rule(target, 'project', "group = 'project';");
  files(target, {
    'src/in/a.txt': 'inside\n',
    'src/in/b.txt': 'unchanged\n',
    'src/out/c.txt': 'outside\n',
    'src/in-old/prefix.txt': 'prefix\n',
  });
  commit(target);
  files(target, { 'src/out/c.txt': 'changed outside\n', 'src/in-old/prefix.txt': 'changed prefix\n' });
  skipped(await check(target, 'src/in', '--diff-only'), ['folder', 'project']);

  files(target, { 'src/in/a.txt': 'changed inside\n' });
  assert.deepEqual(groups(await check(target, 'src/in', '--diff-only')), [
    {
      rule: 'folder', type: 'folder', path: 'src',
      members: [
        { filepath: 'src/in/a.txt', source: 'changed inside\n' },
        { filepath: 'src/in/b.txt', source: 'unchanged\n' },
      ],
    },
    {
      rule: 'project', type: 'project', path: '.',
      members: [
        { filepath: 'src/in/a.txt', source: 'changed inside\n' },
        { filepath: 'src/in/b.txt', source: 'unchanged\n' },
      ],
    },
  ]);
  assert.deepEqual(groups(await check(target, 'src/in/b.txt', '--diff-only')), []);
});

test('deleted changes outside the target do not trigger a project group', async () => {
  const target = repository('deleted-target');
  rule(target, 'project', "group = 'project';");
  files(target, {
    'src/in/keep.txt': 'inside\n',
    'src/in/metadata.config': 'inside metadata\n',
    'src/out/deleted.config': 'outside metadata\n',
  });
  commit(target);
  git(target, 'rm', '--', 'src/out/deleted.config');
  skipped(await check(target, 'src/in', '--diff-only'), ['project']);
  git(target, 'rm', '--', 'src/in/metadata.config');
  assert.deepEqual(groups(await check(target, 'src/in', '--diff-only')), [{
    rule: 'project', type: 'project', path: '.',
    members: [{ filepath: 'src/in/keep.txt', source: 'inside\n' }],
  }]);
});

test('nested project cwd uses project-relative paths rather than repository-relative paths', async () => {
  const outer = repository('nested');
  const target = { ...outer, cwd: join(outer.cwd, 'packages', 'app') };
  rule(target, 'local');
  files(target, {
    'package.json': '{"type":"module"}\n',
    'src/changed.txt': 'before\n',
    'src/unchanged.txt': 'BAD unchanged\n',
  });
  files(outer, { 'src/outside.txt': 'outside\n' });
  const base = commit(outer);
  files(outer, { 'src/outside.txt': 'changed outside\n' });
  skipped(await check(target, '--diff-only'), ['local']);

  files(target, { 'src/changed.txt': 'after\n' });
  assert.deepEqual(scopes(await check(target, 'src', '--diff-only', '--base', base)), [
    { filepath: 'src/changed.txt', source: 'after\n', status: 'pass' },
  ]);
});

test('custom selectors cannot evaluate unchanged subjects during diff checks', async () => {
  const target = repository('custom-select');
  rule(target, 'custom', `async select(context) {
    return Promise.all(['src/changed.txt', 'src/unchanged.txt'].map(async filepath => ({
      kind: 'scope', filepath, id: 'custom', source: await context.project.readText(filepath),
    })));
  }`);
  files(target, { 'src/changed.txt': 'before\n', 'src/unchanged.txt': 'BAD unchanged\n' });
  commit(target);
  files(target, { 'src/changed.txt': 'after\n' });

  assert.deepEqual(scopes(await check(target, '--diff-only')), [
    { filepath: 'src/changed.txt', source: 'after\n', status: 'pass' },
  ]);
});

test('Git paths containing spaces and newlines round-trip without splitting or quoting', async () => {
  const target = repository('unusual-paths');
  rule(target, 'local');
  const space = 'src/with spaces.txt';
  const newline = 'src/with\nnewline.txt';
  files(target, { [space]: 'before\n', [newline]: 'before\n' });
  commit(target);
  files(target, { [space]: 'after space\n', [newline]: 'after newline\n', 'src/new\nfile name.txt': 'new\n' });
  git(target, 'add', '--', space);

  const actual = scopes(await check(target, '--diff-only'));
  assert.deepEqual(actual, [
    { filepath: 'src/new\nfile name.txt', source: 'new\n', status: 'pass' },
    { filepath: newline, source: 'after newline\n', status: 'pass' },
    { filepath: space, source: 'after space\n', status: 'pass' },
  ].sort((a, b) => a.filepath.localeCompare(b.filepath)));
});

test('reserved changes and deletions skip groups until an eligible path is deleted', async () => {
  const target = repository('reserved');
  rule(target, 'folder', "group = 'folder';");
  rule(target, 'project', "group = 'project';");
  files(target, {
    'src/keep.txt': 'unchanged\n',
    'src/metadata.config': 'eligible metadata\n',
    'old/legacy.txt': 'before\n',
    'dist/generated.txt': 'before\n',
    'coverage/report.txt': 'before\n',
    'node_modules/pkg/tracked.txt': 'before\n',
    'old/deleted.txt': 'reserved deletion\n',
  });
  git(target, 'add', '--force', '--', 'node_modules/pkg/tracked.txt');
  commit(target);
  files(target, {
    'old/legacy.txt': 'after\n',
    'dist/generated.txt': 'after\n',
    'coverage/report.txt': 'after\n',
    'node_modules/pkg/tracked.txt': 'after\n',
    '.coderuler/helper.ts': 'export const helper = true;\n',
  });
  git(target, 'rm', '--', 'old/deleted.txt');
  assert.deepEqual(groups(await check(target, '--diff-only')), []);
  git(target, 'rm', '--', 'src/metadata.config');
  assert.deepEqual(groups(await check(target, '--diff-only')), [
    {
      rule: 'folder', type: 'folder', path: 'src',
      members: [{ filepath: 'src/keep.txt', source: 'unchanged\n' }],
    },
    {
      rule: 'project', type: 'project', path: '.',
      members: [{ filepath: 'src/keep.txt', source: 'unchanged\n' }],
    },
  ]);
});

test('invalid base, nonrepositories and base without diff-only exit with usage status 2', async () => {
  const target = repository('errors');
  rule(target, 'local');
  files(target, { 'src/a.txt': 'clean\n' });
  commit(target);
  const nonrepo = sandbox.isolated('nonrepo');
  rule(nonrepo, 'local');
  files(nonrepo, { 'src/a.txt': 'clean\n' });

  const normal = await runCli(['check', '--json', '--output-all'], nonrepo);
  assert.equal(normal.status, 0, normal.stderr);
  for (const [project, args] of [
    [target, ['--diff-only', '--base', 'missing-ref']],
    [nonrepo, ['--diff-only']],
    [target, ['--base', 'HEAD']],
  ] as const) {
    const result = await runCli(['check', ...args, '--json', '--output-all'], project);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
    assert.notEqual(result.stderr.trim(), '', args.join(' '));
  }
});

test('an explicit ref compares against that tree rather than its merge base with HEAD', async () => {
  const target = repository('base-tree');
  rule(target, 'local');
  files(target, { 'src/a.txt': 'current main\n' });
  commit(target);
  git(target, 'checkout', '-b', 'comparison');
  files(target, { 'src/a.txt': 'other branch\n' });
  commit(target);
  git(target, 'checkout', 'main');

  skipped(await check(target, '--diff-only'), ['local']);
  assert.deepEqual(scopes(await check(target, '--diff-only', '--base', 'comparison')), [
    { filepath: 'src/a.txt', source: 'current main\n', status: 'pass' },
  ]);
});

test('staged changes reverted in the worktree are unchanged relative to the base', async () => {
  const target = repository('reverted-index');
  rule(target, 'local');
  files(target, { 'src/a.txt': 'BAD original\n' });
  commit(target);
  files(target, { 'src/a.txt': 'staged edit\n' });
  git(target, 'add', '--', 'src/a.txt');
  files(target, { 'src/a.txt': 'BAD original\n' });

  skipped(await check(target, '--diff-only'), ['local']);
});

test('files named old or dist and nested dist directories remain eligible', async () => {
  const target = repository('reserved-names');
  rule(target, 'local', '', 'src/**/*');
  files(target, {
    'src/old': 'before\n',
    'src/dist': 'before\n',
    'src/nested/dist/keep.txt': 'before\n',
  });
  commit(target);
  files(target, {
    'src/old': 'old filename\n',
    'src/dist': 'dist filename\n',
    'src/nested/dist/keep.txt': 'nested dist\n',
  });

  assert.deepEqual(scopes(await check(target, '--diff-only')), [
    { filepath: 'src/dist', source: 'dist filename\n', status: 'pass' },
    { filepath: 'src/nested/dist/keep.txt', source: 'nested dist\n', status: 'pass' },
    { filepath: 'src/old', source: 'old filename\n', status: 'pass' },
  ]);
});

test('changing an explicitly loaded rule outside .coderuler does not trigger its project group', async () => {
  const target = repository('explicit-rule-change');
  const ruleFile = 'rules/explicit.rule.ts';
  const source = `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Explicit extends Rule {
  files = ['src/**/*.txt'];
  group = 'project';
  check = pass;
}
`;
  files(target, { [ruleFile]: source, 'src/unchanged.txt': 'unchanged source\n' });
  commit(target);
  files(target, { [ruleFile]: `${source}\n// Rule-only edit.\n` });

  assert.deepEqual(groups(await check(target, '--rules', ruleFile)), [{
    rule: 'explicit', type: 'project', path: '.',
    members: [{ filepath: 'src/unchanged.txt', source: 'unchanged source\n' }],
  }]);
  skipped(await check(target, '--rules', ruleFile, '--diff-only'), ['explicit']);
});
