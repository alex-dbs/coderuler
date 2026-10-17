import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createProject, resolveTarget } from '../dist/adapter/filesystem/project.js';
import {
  createSandbox,
  expectFailure,
  parseCheckOutput,
  runCli,
  writeFile as writeSandboxFile,
} from './support.ts';

const cliSandbox = createSandbox('rulekeeper-project-');
after(() => cliSandbox.cleanup());

const TESTS_DIR = await realpath(fileURLToPath(new URL('.', import.meta.url)));
const tempRoots: string[] = [];

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(TESTS_DIR, `.tmp-${label}-`));
  tempRoots.push(root);
  return root;
}

const TREE: readonly (readonly [string, string])[] = [
  ['a.txt', 'alpha'],
  ['nested/b.txt', 'beta'],
  ['nested/deep/c.txt', 'gamma'],
  ['external/excluded.txt', 'excluded'],
  ['old/legacy.txt', 'legacy'],
  ['dist/note.txt', 'dist note'],
  ['coverage/note.txt', 'coverage note'],
  ['node_modules/pkg/index.js', 'export default {};\n'],
  ['node_modules/pkg/note.txt', 'pkg note'],
  ['.git/config', '[core]\n'],
  ['.git/note.txt', 'git note'],
  ['.rulekeeper/local.rule.mjs', 'export default 1;\n'],
  ['.rulekeeper/note.txt', 'rule note'],
  ['data.json', '{"name":"x","list":[1,2]}\n'],
  ['empty.json', ''],
  ['comment.json', '// nope\n{"a":1}\n'],
  ['trailing.json', '{"a":1,}\n'],
  ['duplicate.json', '{"k":1,"k":2}\n'],
  [
    'values.yaml',
    '# leading comment\n---\na: 1\n---\n# comment only\n---\nnull\n---\nfalse\n---\n0\n',
  ],
  ['broken.yaml', '---\na: 1\n---\nb: [1, 2\n'],
  ['rows.csv', 'name,age\nx,1\ny,2\n'],
  ['quoted.csv', 'a,b\n"x,1","he said ""hi"""\n'],
  ['multiline.csv', 'a,b\n"line1\nline2",z\n'],
  ['noheaders.csv', '1,2\n3,4\n'],
  ['semi.csv', 'name;age\nx;1\n'],
  ['bom.csv', '\uFEFFname,age\nx,1\n'],
  ['blank.csv', 'a,b\n\n1,2\n\n3,4\n'],
  ['header-only.csv', 'a,b\n'],
  ['empty.csv', ''],
  ['ragged.csv', 'a,b\n1,2,3\n'],
  ['duplicate-headers.csv', 'a,a\n1,2\n'],
  ['blank-header.csv', 'a,,b\n1,2,3\n'],
  ['crlf.csv', 'a,b\r\n1,2\r\n'],
  ['cr.csv', 'a,b\r1,2\r'],
];

async function makeProjectRoot(label: string): Promise<string> {
  const root = await makeTempRoot(label);
  for (const [relPath, content] of TREE) {
    const file = join(root, relPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await writeFile(join(root, 'bin.dat'), Buffer.from([0x61, 0xff, 0x62]));
  await mkdir(join(root, 'empty-dir'), { recursive: true });
  await symlink(join(root, 'a.txt'), join(root, 'link.txt'));
  await symlink(join(root, 'nested'), join(root, 'linkdir'));
  return root;
}

const BOUNDARY_TREE: readonly (readonly [string, string])[] = [
  ['notes/old', 'old note'],
  ['notes/node_modules', 'module note'],
  ['notes/dist', 'nested dist note'],
  ['notes/coverage', 'nested coverage note'],
  ['dist', 'root dist file'],
  ['node_modules', 'root module file'],
  ['..notes.txt', 'dotted note'],
  ['..data/input.txt', 'dotted data'],
  ['bom.txt', '\uFEFFalpha'],
  ['bom-only.txt', '\uFEFF'],
  ['ordinary/file.txt', 'ordinary file'],
  ['old/legacy.txt', 'legacy'],
  ['.git/config', '[core]\n'],
];

async function makeBoundaryRoot(label: string): Promise<string> {
  const root = await makeTempRoot(label);
  for (const [relPath, content] of BOUNDARY_TREE) {
    const file = join(root, relPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await writeFile(join(root, 'bin.dat'), Buffer.from([0x61, 0xff, 0x62]));
  await symlink(join(root, 'ordinary'), join(root, 'alias'));
  await symlink(join(root, 'old'), join(root, 'alias-old'));
  await symlink(join(root, 'ordinary/file.txt'), join(root, 'link.txt'));
  return root;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

async function expectReject(
  label: string,
  run: () => Promise<unknown>,
  ...fragments: readonly string[]
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `${label}: expected a rejection`);
  const text = errorText(caught);
  for (const fragment of fragments) {
    assert.ok(
      text.includes(fragment),
      `${label}: expected ${JSON.stringify(text)} to include ${JSON.stringify(fragment)}`,
    );
  }
}

test('exposes the resolved absolute project root', async () => {
  const root = await makeProjectRoot('root');
  const project = createProject(root);
  assert.ok(isAbsolute(project.root));
  assert.equal(await realpath(project.root), await realpath(root));
});

test('glob returns existing eligible files in lexical order and skips excluded trees', async () => {
  const root = await makeProjectRoot('glob');
  const project = createProject(root);

  assert.deepStrictEqual(await project.glob('**/*.txt'), [
    'a.txt',
    'external/excluded.txt',
    'nested/b.txt',
    'nested/deep/c.txt',
  ]);
  assert.deepStrictEqual(await project.glob('*.txt'), ['a.txt']);
  assert.deepStrictEqual(await project.glob(['external/**/*.txt', 'nested/**/*.txt']), [
    'external/excluded.txt',
    'nested/b.txt',
    'nested/deep/c.txt',
  ]);
});

test('skips generated directories only at the project root', async () => {
  const root = await makeProjectRoot('root-generated');
  const project = createProject(root);
  await mkdir(join(root, 'nested/dist'), { recursive: true });
  await writeFile(join(root, 'nested/dist/note.txt'), 'nested dist');
  await mkdir(join(root, 'src/coverage'), { recursive: true });
  await writeFile(join(root, 'src/coverage/note.txt'), 'nested coverage');

  assert.deepStrictEqual(await project.glob('nested/**/*.txt'), [
    'nested/b.txt',
    'nested/deep/c.txt',
    'nested/dist/note.txt',
  ]);
  assert.deepStrictEqual(await project.glob('src/coverage/**/*.txt'), ['src/coverage/note.txt']);
  assert.equal(await project.readText('nested/dist/note.txt'), 'nested dist');
  assert.deepStrictEqual(await project.glob('**/*.txt'), [
    'a.txt',
    'external/excluded.txt',
    'nested/b.txt',
    'nested/deep/c.txt',
    'nested/dist/note.txt',
    'src/coverage/note.txt',
  ]);

  await expectReject('root dist target', () => project.glob('dist/**/*.txt'), 'dist/');
  await expectReject('root coverage target', () => project.glob('coverage/**/*.txt'), 'coverage/');
  await expectReject('root generated read', () => project.readText('coverage/note.txt'), 'coverage/');
});

test('read helpers return isolated parsed values per call', async () => {
  const root = await makeProjectRoot('parsed-isolation');
  const project = createProject(root);

  const json = (await project.readJson('data.json')) as { name: string; list: number[] };
  json.name = 'mutated';
  json.list.push(3);
  assert.deepStrictEqual(await project.readJson('data.json'), { name: 'x', list: [1, 2] });

  const yaml = (await project.readYaml('values.yaml')) as { a: number }[];
  const firstDoc = yaml[0];
  assert.ok(firstDoc);
  firstDoc.a = 99;
  yaml.push({ a: 2 });
  assert.deepStrictEqual(await project.readYaml('values.yaml'), [{ a: 1 }, null, false, 0]);

  const csv = (await project.readCsv('rows.csv')) as Record<string, string>[];
  const firstRow = csv[0];
  assert.ok(firstRow);
  firstRow.name = 'mutated';
  firstRow.age = '9';
  csv.push({ name: 'z', age: '9' });
  assert.deepStrictEqual(await project.readCsv('rows.csv'), [
    { name: 'x', age: '1' },
    { name: 'y', age: '2' },
  ]);

  assert.equal(await project.readText('data.json'), '{"name":"x","list":[1,2]}\n');
});

test('glob honours excludeFiles, reports no matches, and mirrors into hasFiles', async () => {
  const root = await makeProjectRoot('glob-exclude');
  const project = createProject(root, { excludeFiles: [join(root, 'external/excluded.txt')] });

  assert.deepStrictEqual(await project.glob('**/*.txt'), [
    'a.txt',
    'nested/b.txt',
    'nested/deep/c.txt',
  ]);
  assert.deepStrictEqual(await project.glob('**/*.nope'), []);
  assert.equal(await project.hasFiles('nested/**/*.txt'), true);
  assert.equal(await project.hasFiles('**/*.nope'), false);
});

test('glob rejects explicit targets outside the root or inside excluded trees', async () => {
  const root = await makeProjectRoot('glob-safety');
  const project = createProject(root);

  await expectReject('archived target', () => project.glob('old/legacy.txt'), 'old/legacy.txt');
  await expectReject('git target', () => project.glob('.git/config'), '.git/config');
  await expectReject('escape target', () => project.glob('../outside.txt'), 'outside.txt');
  await expectReject('absolute target', () => project.glob('/etc/hostname'));
});

test('stat distinguishes files, directories, and missing paths, and propagates other errors', async () => {
  const root = await makeProjectRoot('stat');
  const project = createProject(root);

  assert.deepStrictEqual(await project.stat('a.txt'), { kind: 'file' });
  assert.deepStrictEqual(await project.stat('nested/b.txt'), { kind: 'file' });
  assert.deepStrictEqual(await project.stat('nested'), { kind: 'directory' });
  assert.deepStrictEqual(await project.stat('empty-dir'), { kind: 'directory' });
  assert.equal(await project.stat('missing.txt'), undefined);

  await expectReject('path through a file', () => project.stat('a.txt/child'), 'a.txt/child');
  await expectReject('symlink', () => project.stat('link.txt'), 'link.txt');
  await expectReject('archived directory', () => project.stat('old'), 'old');
  await expectReject('escape', () => project.stat('../outside.txt'), 'outside.txt');
  await expectReject('absolute', () => project.stat('/etc/hostname'));
});

test('readText decodes strict UTF-8 files only', async () => {
  const root = await makeProjectRoot('read-text');
  const project = createProject(root);

  assert.equal(await project.readText('a.txt'), 'alpha');
  assert.equal(await project.readText('nested/b.txt'), 'beta');
  assert.equal(await project.readText('multiline.csv'), 'a,b\n"line1\nline2",z\n');

  await expectReject('missing file', () => project.readText('missing.txt'), 'missing.txt');
  await expectReject('directory', () => project.readText('nested'), 'nested');
  await expectReject('invalid utf-8', () => project.readText('bin.dat'), 'bin.dat');
  await expectReject('symlink', () => project.readText('link.txt'), 'link.txt');
  await expectReject('escape', () => project.readText('../outside.txt'), 'outside.txt');
  await expectReject('absolute', () => project.readText('/etc/hostname'));
  await expectReject('reserved path', () => project.readText('.git/config'), '.git');
});

test('readText rejects a path that leaves the root through a symlinked directory', async () => {
  const root = await makeProjectRoot('read-text-escape');
  const outside = await makeTempRoot('read-text-outside');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(outside, join(root, 'escape-dir'));
  const project = createProject(root);

  await expectReject(
    'symlinked directory escape',
    () => project.readText('escape-dir/secret.txt'),
    'escape-dir/secret.txt',
  );
});

test('readJson parses strict JSON and returns a fresh value per call', async () => {
  const root = await makeProjectRoot('json');
  const project = createProject(root);

  assert.deepStrictEqual(await project.readJson('data.json'), { name: 'x', list: [1, 2] });
  const first = await project.readJson('data.json');
  const second = await project.readJson('data.json');
  assert.notStrictEqual(first, second);
  assert.deepStrictEqual(first, second);

  for (const file of ['empty.json', 'comment.json', 'trailing.json', 'duplicate.json']) {
    await expectReject(file, () => project.readJson(file), file);
  }
  await expectReject('missing json', () => project.readJson('missing.json'), 'missing.json');
});

test('readYaml returns one value per nonempty document in document order', async () => {
  const root = await makeProjectRoot('yaml');
  const project = createProject(root);

  assert.deepStrictEqual(await project.readYaml('values.yaml'), [{ a: 1 }, null, false, 0]);
  const first = await project.readYaml('values.yaml');
  const second = await project.readYaml('values.yaml');
  assert.notStrictEqual(first, second);
  assert.deepStrictEqual(first, second);

  await expectReject('broken yaml', () => project.readYaml('broken.yaml'), 'broken.yaml');
  await expectReject('missing yaml', () => project.readYaml('missing.yaml'), 'missing.yaml');
});

test('readCsv parses headers, quoting, multiline fields, and headerless rows', async () => {
  const root = await makeProjectRoot('csv');
  const project = createProject(root);

  assert.deepStrictEqual(await project.readCsv('rows.csv'), [
    { name: 'x', age: '1' },
    { name: 'y', age: '2' },
  ]);
  assert.deepStrictEqual(await project.readCsv('quoted.csv'), [
    { a: 'x,1', b: 'he said "hi"' },
  ]);
  assert.deepStrictEqual(await project.readCsv('multiline.csv'), [
    { a: 'line1\nline2', b: 'z' },
  ]);
  assert.deepStrictEqual(await project.readCsv('noheaders.csv', { headers: false }), [
    ['1', '2'],
    ['3', '4'],
  ]);
  assert.deepStrictEqual(await project.readCsv('semi.csv', { delimiter: ';' }), [
    { name: 'x', age: '1' },
  ]);
});

test('readCsv handles BOM, CRLF, lone CR, blank lines, and header-only or empty input', async () => {
  const root = await makeProjectRoot('csv-lines');
  const project = createProject(root);

  assert.deepStrictEqual(await project.readCsv('bom.csv'), [{ name: 'x', age: '1' }]);
  assert.deepStrictEqual(await project.readCsv('crlf.csv'), [{ a: '1', b: '2' }]);
  assert.deepStrictEqual(await project.readCsv('cr.csv'), [{ a: '1', b: '2' }]);
  assert.deepStrictEqual(await project.readCsv('blank.csv'), [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
  assert.deepStrictEqual(await project.readCsv('header-only.csv'), []);
  assert.deepStrictEqual(await project.readCsv('empty.csv'), []);
});

test('readCsv reports malformed records and invalid options', async () => {
  const root = await makeProjectRoot('csv-errors');
  const project = createProject(root);

  await expectReject('ragged row', () => project.readCsv('ragged.csv'), 'ragged.csv');
  await expectReject(
    'duplicate headers',
    () => project.readCsv('duplicate-headers.csv'),
    'duplicate-headers.csv',
  );
  await expectReject('blank header', () => project.readCsv('blank-header.csv'), 'blank-header.csv');
  await expectReject('missing csv', () => project.readCsv('missing.csv'), 'missing.csv');
  await expectReject('directory', () => project.readCsv('nested'), 'nested');
  await expectReject('multi character delimiter', () =>
    project.readCsv('rows.csv', { delimiter: 'ab' }),
  );
  await expectReject('newline delimiter', () => project.readCsv('rows.csv', { delimiter: '\n' }));
  await expectReject('quote delimiter', () => project.readCsv('rows.csv', { delimiter: '"' }));
});

test('reuses one lazy file inventory and one source text cache per run', async () => {
  const root = await makeProjectRoot('cache');
  const project = createProject(root);
  const expected = ['a.txt', 'external/excluded.txt', 'nested/b.txt', 'nested/deep/c.txt'];

  assert.deepStrictEqual(await project.glob('**/*.txt'), expected);
  await writeFile(join(root, 'late.txt'), 'late');
  assert.deepStrictEqual(await project.glob('**/*.txt'), expected);

  assert.equal(await project.readText('a.txt'), 'alpha');
  await writeFile(join(root, 'a.txt'), 'changed');
  assert.equal(await project.readText('a.txt'), 'alpha');
});

test('keeps regular files eligible when they carry a reserved directory name', async () => {
  const root = await makeBoundaryRoot('reserved-names-as-files');
  const project = createProject(root);

  assert.deepStrictEqual(await project.glob('**/*'), [
    'bin.dat',
    'bom-only.txt',
    'bom.txt',
    'dist',
    'node_modules',
    'notes/coverage',
    'notes/dist',
    'notes/node_modules',
    'notes/old',
    'ordinary/file.txt',
  ]);

  for (const [file, content] of [
    ['dist', 'root dist file'],
    ['node_modules', 'root module file'],
    ['notes/old', 'old note'],
    ['notes/node_modules', 'module note'],
    ['notes/dist', 'nested dist note'],
    ['notes/coverage', 'nested coverage note'],
  ] as const) {
    assert.equal(await project.readText(file), content, `readText(${file})`);
    assert.deepStrictEqual(await project.stat(file), { kind: 'file' }, `stat(${file})`);
  }

  for (const file of ['dist', 'node_modules', 'notes/old', 'notes/node_modules'] as const) {
    assert.deepStrictEqual(await project.glob(file), [file], `glob(${file})`);
    assert.equal(await project.hasFiles(file), true, `hasFiles(${file})`);
  }
  assert.deepStrictEqual(await project.glob('notes/*'), [
    'notes/coverage',
    'notes/dist',
    'notes/node_modules',
    'notes/old',
  ]);
  assert.equal(await project.hasFiles(['**/*.nope', 'notes/old']), true);

  await expectReject('archived directory glob', () => project.glob('old'), 'reserved directory');
  await expectReject('archived descendant glob', () => project.glob('old/legacy.txt'), 'old/legacy.txt');
  await expectReject('git directory glob', () => project.glob('.git/config'), '.git/config');
  await expectReject('archived hasFiles', () => project.hasFiles('old'), 'reserved directory');

  await expectReject('archived directory file', () => project.readText('old/legacy.txt'), 'old/legacy.txt');
  await expectReject('git directory file', () => project.stat('.git/config'), '.git/config');
});

test('rejects paths that pass through a symlinked directory', async () => {
  const root = await makeBoundaryRoot('symlinked-directories');
  const project = createProject(root);

  await expectReject(
    'read through an ordinary directory alias',
    () => project.readText('alias/file.txt'),
    'file.txt',
  );
  await expectReject(
    'stat through an ordinary directory alias',
    () => project.stat('alias/file.txt'),
    'file.txt',
  );
  await expectReject(
    'read through an archive directory alias',
    () => project.readText('alias-old/legacy.txt'),
    'legacy.txt',
  );
  await expectReject(
    'stat through an archive directory alias',
    () => project.stat('alias-old/legacy.txt'),
    'legacy.txt',
  );
  await expectReject(
    'target through an ordinary directory alias',
    () => resolveTarget(root, 'alias/file.txt'),
    'file.txt',
  );
  await expectReject(
    'target through an archive directory alias',
    () => resolveTarget(root, 'alias-old/legacy.txt'),
    'legacy.txt',
  );

  await expectReject('stat on a directory alias', () => project.stat('alias'), 'alias', 'symbolic link');
  await expectReject(
    'target on a directory alias',
    () => resolveTarget(root, 'alias'),
    'alias',
    'symbolic link',
  );
  await expectReject(
    'read through a final symlink',
    () => project.readText('link.txt'),
    'link.txt',
    'symbolic link',
  );
});

test('accepts dotted names that only look like a parent escape', async () => {
  const root = await makeBoundaryRoot('dotted-names');
  const project = createProject(root);

  assert.deepStrictEqual(await project.glob('..notes.txt'), ['..notes.txt']);
  assert.equal(await project.readText('..notes.txt'), 'dotted note');
  assert.deepStrictEqual(await project.stat('..notes.txt'), { kind: 'file' });

  assert.deepStrictEqual(await project.glob('..data/*.txt'), ['..data/input.txt']);
  assert.equal(await project.readText('..data/input.txt'), 'dotted data');
  assert.deepStrictEqual(await project.stat('..data'), { kind: 'directory' });

  const fileTarget = await resolveTarget(root, '..notes.txt');
  assert.equal(fileTarget.kind, 'file');
  assert.equal(fileTarget.path, '..notes.txt');
  assert.equal(fileTarget.contains('..notes.txt'), true);
  assert.equal(fileTarget.contains('ordinary/file.txt'), false);

  const directoryTarget = await resolveTarget(root, '..data');
  assert.equal(directoryTarget.kind, 'directory');
  assert.equal(directoryTarget.path, '..data');
  assert.equal(directoryTarget.contains('..data/input.txt'), true);

  await expectReject('parent escape read', () => project.readText('../outside.txt'), 'outside.txt');
  await expectReject('parent escape stat', () => project.stat('../outside.txt'), 'outside.txt');
  await expectReject('parent escape glob', () => project.glob('../outside.txt'), '../outside.txt');
  await expectReject('parent escape target', () => resolveTarget(root, '..'), 'outside');
  await expectReject(
    'parent escape file target',
    () => resolveTarget(root, '../outside.txt'),
    'outside.txt',
  );
});

test('resolveTarget accepts absolute paths inside the invocation root', async () => {
  const root = await makeProjectRoot('absolute-target');

  const file = await resolveTarget(root, join(root, 'a.txt'));
  assert.equal(file.kind, 'file');
  assert.equal(file.path, 'a.txt');
  assert.equal(file.contains('a.txt'), true);

  const directory = await resolveTarget(root, join(root, 'nested'));
  assert.equal(directory.kind, 'directory');
  assert.equal(directory.path, 'nested');
  assert.equal(directory.contains('nested/deep/c.txt'), true);

  const rootItself = await resolveTarget(root, root);
  assert.equal(rootItself.kind, 'directory');
  assert.equal(rootItself.path, '.');
  assert.equal(rootItself.contains('a.txt'), true);

  await expectReject('absolute outside the root', () => resolveTarget(root, join(root, '..', 'outside.txt')), 'outside');
  await expectReject('absolute reserved directory', () => resolveTarget(root, join(root, 'old')), 'reserved');
  await expectReject('absolute symlinked directory', () => resolveTarget(root, join(root, 'linkdir')), 'symbolic link');
  await expectReject('absolute symlinked file', () => resolveTarget(root, join(root, 'link.txt')), 'symbolic link');
});

test('resolveTarget accepts an absolute target spelled through a symlinked ancestor', async () => {
  const physicalRoot = await realpath(await makeProjectRoot('alias-target'));
  const holder = await makeTempRoot('alias-holder');
  const alias = join(holder, 'project');
  await symlink(physicalRoot, alias);

  const viaAlias = await resolveTarget(physicalRoot, join(alias, 'nested', 'b.txt'));
  assert.equal(viaAlias.kind, 'file');
  assert.equal(viaAlias.path, 'nested/b.txt');
  assert.equal(viaAlias.contains('nested/b.txt'), true);

  const directory = await resolveTarget(physicalRoot, join(alias, 'nested'));
  assert.equal(directory.kind, 'directory');
  assert.equal(directory.path, 'nested');
});

test('resolveTarget still rejects symlinks, reserved dirs, and outsiders under an alias', async () => {
  const physicalRoot = await realpath(await makeProjectRoot('alias-guard'));
  const holder = await makeTempRoot('alias-guard-holder');
  const alias = join(holder, 'project');
  await symlink(physicalRoot, alias);
  const outsider = join(holder, 'outsider.txt');
  await writeFile(outsider, 'outside');

  await expectReject(
    'final symlink via alias',
    () => resolveTarget(physicalRoot, join(alias, 'link.txt')),
    'symbolic link',
  );
  await expectReject(
    'alias used as the final target',
    () => resolveTarget(physicalRoot, alias),
    'symbolic link',
  );
  await expectReject(
    'in-root intermediate symlink via alias',
    () => resolveTarget(physicalRoot, join(alias, 'linkdir', 'b.txt')),
    'symbolic link',
  );
  await expectReject(
    'reserved directory via alias',
    () => resolveTarget(physicalRoot, join(alias, 'old')),
    'reserved',
  );
  await expectReject('outsider via alias prefix', () => resolveTarget(physicalRoot, outsider), 'outside');
  await expectReject(
    'outsider beside the alias',
    () => resolveTarget(physicalRoot, join(holder, 'missing', 'deep.txt')),
    'outside',
  );

  const subdirAlias = join(holder, 'subdir');
  await symlink(join(physicalRoot, 'nested'), subdirAlias);
  await expectReject(
    'alias that jumps straight into a root subdirectory',
    () => resolveTarget(physicalRoot, join(subdirAlias, 'b.txt')),
    'outside',
  );
});

test('resolveTarget accepts a physical root reached through the platform temp alias', async () => {
  const spelled = await mkdtemp(join('/tmp', 'rk-alias-'));
  tempRoots.push(spelled);
  const physical = await realpath(spelled);
  await mkdir(join(physical, 'src'), { recursive: true });

  const target = await resolveTarget(physical, join(spelled, 'src'));
  assert.equal(target.kind, 'directory');
  assert.equal(target.path, 'src');
});

test('preserves a leading UTF-8 BOM and still rejects invalid UTF-8', async () => {
  const root = await makeBoundaryRoot('bom');
  const project = createProject(root);

  const text = await project.readText('bom.txt');
  assert.equal(text, '\uFEFFalpha');
  assert.equal(text.codePointAt(0), 0xfeff);
  assert.equal(await project.readText('bom-only.txt'), '\uFEFF');

  await expectReject('invalid utf-8', () => project.readText('bin.dat'), 'bin.dat');
});

async function caseInsensitiveFilesystem(root: string): Promise<boolean> {
  await mkdir(join(root, 'CaseProbe'), { recursive: true });
  try {
    return (await lstat(join(root, 'caseprobe'))).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

test('resolveTarget resolves a case-varied real root on a case-insensitive filesystem', async (t) => {
  const physical = await realpath(await makeProjectRoot('case-varied-root'));
  if (!(await caseInsensitiveFilesystem(physical))) {
    t.skip('filesystem is case-sensitive so a case-varied spelling of the root cannot exist');
    return;
  }
  const varied = join(dirname(physical), basename(physical).toUpperCase());

  const file = await resolveTarget(physical, join(varied, 'nested', 'b.txt'));
  assert.equal(file.kind, 'file');
  assert.equal(file.path, 'nested/b.txt');
  assert.equal(file.root, physical);
  assert.equal(file.contains('nested/b.txt'), true);

  const directory = await resolveTarget(physical, join(varied, 'nested'));
  assert.equal(directory.kind, 'directory');
  assert.equal(directory.path, 'nested');
  assert.equal(directory.contains('nested/deep/c.txt'), true);

  const rootItself = await resolveTarget(physical, varied);
  assert.equal(rootItself.kind, 'directory');
  assert.equal(rootItself.path, '.');
  assert.equal(rootItself.contains('a.txt'), true);

  await expectReject(
    'case-varied final symlink',
    () => resolveTarget(physical, join(varied, 'link.txt')),
    'symbolic link',
  );
  await expectReject(
    'case-varied intermediate symlink',
    () => resolveTarget(physical, join(varied, 'linkdir', 'b.txt')),
    'symbolic link',
  );
  await expectReject(
    'case-varied reserved directory',
    () => resolveTarget(physical, join(varied, 'old')),
    'reserved',
  );
  await expectReject(
    'case-varied reserved descendant',
    () => resolveTarget(physical, join(varied, 'old', 'legacy.txt')),
    'reserved',
  );
  await expectReject(
    'case-varied outsider',
    () => resolveTarget(physical, join(dirname(varied), 'missing', 'deep.txt')),
    'outside',
  );
});

test('resolveTarget canonicalizes case-varied suffixes before selection and reserved-directory checks', async (t) => {
  const physical = await realpath(await makeProjectRoot('case-varied-suffix'));
  if (!(await caseInsensitiveFilesystem(physical))) {
    t.skip('filesystem is case-sensitive so alternate-case suffixes do not name these entries');
    return;
  }
  const varied = join(dirname(physical), basename(physical).toUpperCase());
  await mkdir(join(physical, 'nested', 'node_modules'), { recursive: true });
  await mkdir(join(physical, 'nested', 'dist'), { recursive: true });
  await writeFile(join(physical, 'nested', 'dist', 'note.txt'), 'nested generated directory');
  await mkdir(join(physical, 'notes'), { recursive: true });
  await writeFile(join(physical, 'notes', 'old'), 'ordinary reserved namesake');
  for (const rootSpelling of [physical, varied]) {
    const file = await resolveTarget(physical, join(rootSpelling, 'NESTED', 'B.TXT'));
    assert.equal(file.path, 'nested/b.txt');
    assert.equal(file.kind, 'file');
    assert.equal(file.contains('nested/b.txt'), true);
    assert.equal(file.contains('NESTED/B.TXT'), false);
    const directory = await resolveTarget(physical, join(rootSpelling, 'NESTED'));
    assert.equal(directory.path, 'nested');
    assert.equal(directory.contains('nested/deep/c.txt'), true);
    for (const reserved of ['.GIT', 'NODE_MODULES', '.RULEKEEPER', 'OLD', 'DIST', 'COVERAGE']) {
      await assert.rejects(() => resolveTarget(physical, join(rootSpelling, reserved)));
    }
    await assert.rejects(() =>
      resolveTarget(physical, join(rootSpelling, 'NESTED', 'NODE_MODULES')));
    const generated = await resolveTarget(
      physical, join(rootSpelling, 'NESTED', 'DIST', 'NOTE.TXT'));
    assert.equal(generated.path, 'nested/dist/note.txt');
    const namesake = await resolveTarget(physical, join(rootSpelling, 'NOTES', 'OLD'));
    assert.equal(namesake.kind, 'file');
    assert.equal(namesake.path, 'notes/old');
    assert.equal(namesake.contains('notes/old'), true);
  }
});

test('resolveTarget preserves actual uppercase entry spelling', async () => {
  const root = await makeTempRoot('uppercase-entries');
  await mkdir(join(root, 'SRC'), { recursive: true });
  await writeFile(join(root, 'SRC', 'FILE.TXT'), 'uppercase entry');
  const file = await resolveTarget(root, join(root, 'SRC', 'FILE.TXT'));
  assert.equal(file.path, 'SRC/FILE.TXT');
  assert.equal(file.contains('SRC/FILE.TXT'), true);
  assert.equal(file.contains('src/file.txt'), false);
  await mkdir(join(root, 'OLD'), { recursive: true });
  await writeFile(join(root, 'OLD', 'note.txt'), 'ordinary uppercase directory');
  const uppercase = await resolveTarget(root, join(root, 'OLD', 'note.txt'));
  assert.equal(uppercase.path, 'OLD/note.txt');
  assert.equal(uppercase.contains('OLD/note.txt'), true);
});

test('resolveTarget rejects a distinct case-varied sibling root on a case-sensitive filesystem', async (t) => {
  const physical = await realpath(await makeProjectRoot('case-sensitive-sibling'));
  if (await caseInsensitiveFilesystem(physical)) {
    t.skip('filesystem folds case so a distinct case-varied sibling root cannot exist');
    return;
  }
  const sibling = join(dirname(physical), basename(physical).toUpperCase());
  tempRoots.push(sibling);
  await mkdir(join(sibling, 'nested'), { recursive: true });
  await writeFile(join(sibling, 'nested', 'b.txt'), 'beta');

  await expectReject(
    'distinct case-varied sibling root',
    () => resolveTarget(physical, join(sibling, 'nested', 'b.txt')),
    'outside',
  );
});

test('project helpers reject alternate-case aliases of actual reserved directories', async (t) => {
  const root = await makeProjectRoot('casefold-reserved-helpers');
  if (!(await caseInsensitiveFilesystem(root))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  await mkdir(join(root, 'nested/old'), { recursive: true });
  await writeFile(join(root, 'nested/old/legacy.txt'), 'nested legacy');
  const project = createProject(root);
  for (const path of [
    'OLD/legacy.txt', '.GIT/note.txt', 'NODE_MODULES/pkg/note.txt',
    '.RULEKEEPER/note.txt', 'DIST/note.txt', 'COVERAGE/note.txt', 'NESTED/OLD/legacy.txt',
  ]) {
    await assert.rejects(() => project.readText(path), /reserved directory/);
    await assert.rejects(() => project.stat(path), /reserved directory/);
    await assert.rejects(() => project.stat(dirname(path)), /reserved directory/);
    await assert.rejects(() => project.glob(path), /reserved directory/);
    await assert.rejects(() => project.hasFiles(path), /reserved directory/);
  }
});

test('project boundaries use actual uppercase directory identities instead of alias spelling', async (t) => {
  const root = await makeTempRoot('casefold-uppercase-helpers');
  if (!(await caseInsensitiveFilesystem(root))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  const names = ['OLD', '.GIT', 'NODE_MODULES', '.RULEKEEPER', 'DIST', 'COVERAGE'];
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'file.txt'), name);
  }
  const project = createProject(root);
  for (const name of names) {
    const actual = `${name}/file.txt`;
    const alias = `${name.toLowerCase()}/file.txt`;
    assert.equal(await project.readText(actual), name);
    assert.deepEqual(await project.glob(actual), [actual]);
    assert.equal(await project.readText(alias), name);
    assert.deepEqual(await project.stat(alias), { kind: 'file' });
    assert.deepEqual(await project.stat(name.toLowerCase()), { kind: 'directory' });
    assert.deepEqual(await project.glob(alias), []);
    assert.equal(await project.hasFiles(alias), false);
    const target = await resolveTarget(root, alias);
    assert.equal(target.path, actual);
    assert.equal(target.kind, 'file');
  }
});

test('casefold boundary checks preserve nested generated directories, namesake files, and missing stat', async (t) => {
  const root = await makeTempRoot('casefold-boundary-controls');
  if (!(await caseInsensitiveFilesystem(root))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  for (const name of ['dist', 'coverage']) {
    await mkdir(join(root, 'nested', name), { recursive: true });
    await writeFile(join(root, 'nested', name, 'file.txt'), name);
  }
  for (const name of ['old', '.git', 'node_modules', '.rulekeeper', 'dist', 'coverage']) {
    await writeFile(join(root, name), name);
  }
  const project = createProject(root);
  for (const name of ['dist', 'coverage']) {
    const path = `NESTED/${name.toUpperCase()}/FILE.TXT`;
    assert.equal(await project.readText(path), name);
    assert.deepEqual(await project.stat(path), { kind: 'file' });
    assert.deepEqual(await project.glob(`nested/${name}/*.txt`), [`nested/${name}/file.txt`]);
  }
  for (const name of ['old', '.git', 'node_modules', '.rulekeeper', 'dist', 'coverage']) {
    assert.equal(await project.readText(name.toUpperCase()), name);
    assert.deepEqual(await project.stat(name.toUpperCase()), { kind: 'file' });
  }
  assert.equal(await project.stat('MISSING/file.txt'), undefined);
});

test('casefold directory aliases do not launder symbolic links through project helpers', async (t) => {
  const root = await makeBoundaryRoot('casefold-symlink');
  if (!(await caseInsensitiveFilesystem(root))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  const project = createProject(root);
  for (const path of ['ALIAS/file.txt', 'ALIAS-OLD/legacy.txt', 'LINK.TXT']) {
    await assert.rejects(() => project.readText(path), /symbolic link/);
    await assert.rejects(() => project.stat(path), /symbolic link/);
    await assert.rejects(() => resolveTarget(root, path), /symbolic link/);
  }
});

test('CLI custom selection rejects a casefold alias into the archived tree', async (t) => {
  const target = cliSandbox.isolated('casefold-reserved-custom');
  if (!(await caseInsensitiveFilesystem(target.cwd))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  writeSandboxFile(join(target.cwd, 'old/legacy.txt'), 'legacy');
  for (const filepath of ['old/legacy.txt', 'OLD/legacy.txt']) {
    writeSandboxFile(join(target.cwd, '.rulekeeper/custom.rule.ts'), `import { Rule, pass } from 'rulekeeper';
export default class Custom extends Rule {
  select = () => [{ kind: 'scope' as const, filepath: '${filepath}', id: '$', source: 'legacy' }];
  check = pass;
}
`);
    const result = await runCli(['check', '--json'], target);
    expectFailure(result, `custom archive path ${filepath}`);
    assert.match(result.stderr, /reserved directory|ineligible/);
  }
});

test('CLI custom selection accepts a casefold alias into an actual uppercase eligible tree', async (t) => {
  const target = cliSandbox.isolated('casefold-uppercase-custom');
  if (!(await caseInsensitiveFilesystem(target.cwd))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  writeSandboxFile(join(target.cwd, 'OLD/file.txt'), 'eligible');
  writeSandboxFile(join(target.cwd, '.rulekeeper/custom.rule.ts'), `import { Rule, pass } from 'rulekeeper';
export default class Custom extends Rule {
  select = () => [{ kind: 'scope' as const, filepath: 'old/file.txt', id: '$', source: 'eligible' }];
  check = pass;
}
`);
  const result = await runCli(['check', '--json'], target);
  assert.equal(result.status, 0, result.stderr);
  const reports = parseCheckOutput(result, 'custom uppercase alias');
  assert.equal(reports[0]?.status, 'pass');
  assert.equal(reports[0]?.evaluations.length, 1);
});

test('literal dot prefixes cannot bypass root generated directory checks', async () => {
  const root = await makeProjectRoot('dot-prefix-generated');
  const project = createProject(root);
  for (const directory of ['dist', 'coverage']) {
    for (const pattern of [`${directory}/**`, `./${directory}/**`, `././${directory}/**`]) {
      await assert.rejects(() => project.glob(pattern), /reserved directory/);
      await assert.rejects(() => project.hasFiles(pattern), /reserved directory/);
    }
  }
});

test('casefold literal dot prefixes cannot bypass root generated directory checks', async (t) => {
  const root = await makeProjectRoot('dot-prefix-casefold-generated');
  if (!(await caseInsensitiveFilesystem(root))) {
    t.skip('filesystem is case-sensitive so alternate-case aliases do not exist');
    return;
  }
  const project = createProject(root);
  for (const directory of ['DIST', 'COVERAGE']) {
    await assert.rejects(() => project.glob(`./${directory}/**`), /reserved directory/);
    await assert.rejects(() => project.hasFiles(`./${directory}/**`), /reserved directory/);
  }
});

test('literal dot prefix validation preserves nested generated directories and glob matching', async () => {
  const root = await makeTempRoot('dot-prefix-nested-generated');
  for (const directory of ['dist', 'coverage']) {
    await mkdir(join(root, 'nested', directory), { recursive: true });
    await writeFile(join(root, 'nested', directory, 'visible.txt'), directory);
  }
  const project = createProject(root);
  for (const directory of ['dist', 'coverage']) {
    const actual = `nested/${directory}/visible.txt`;
    assert.deepEqual(await project.glob(`./nested/${directory}/*.txt`), []);
    assert.equal(await project.hasFiles(`./nested/${directory}/*.txt`), false);
    assert.deepEqual(
      await project.glob([`./nested/${directory}/*.txt`, `nested/${directory}/*.txt`]),
      [actual],
    );
  }
});

test('literal dot prefixes do not classify an independent project root by its reserved basename', async () => {
  const holder = await makeTempRoot('dot-prefix-root-basename');
  for (const name of ['old', '.git', 'node_modules', '.rulekeeper', 'dist', 'coverage']) {
    const root = join(holder, name);
    await mkdir(root);
    await writeFile(join(root, 'visible.txt'), name);
    const project = createProject(root);
    assert.deepEqual(await project.glob('./*.txt'), []);
    assert.equal(await project.hasFiles('./*.txt'), false);
    assert.deepEqual(await project.glob(['./*.txt', '*.txt']), ['visible.txt']);
    assert.equal(await project.hasFiles(['./*.txt', '*.txt']), true);
  }
});
