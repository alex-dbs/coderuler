import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createSandbox, isolatedEnv, ROOT, runGit, writeFile, type SandboxRoot } from '../tests/support.ts';

const MODULE = pathToFileURL(join(ROOT, 'src', 'adapter', 'git', 'diff.ts')).href;

const SUPPORT = pathToFileURL(join(ROOT, 'tests', 'support.ts')).href;

const RUNNER = `import { branchDiff, readBranchFile } from ${JSON.stringify(MODULE)};

try {
  const base = process.argv[2] ?? '';
  const branch = await branchDiff(base === '' ? undefined : base);
  const files = [];
  for (const file of branch.files) files.push({ ...file, ...(await readBranchFile(branch, file)) });
  process.stdout.write(JSON.stringify({ repoRoot: branch.repoRoot, head: branch.head, mergeBase: branch.mergeBase, files }));
} catch (error) {
  process.stderr.write(\`\${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exitCode = 1;
}
`;

const STAGING_PROBE = `import { isolatedEnv, runGit, writeFile } from ${JSON.stringify(SUPPORT)};
import { join } from 'node:path';

try {
  const { repo, home, index, dir, worktree, config } = JSON.parse(process.argv[2]);
  // What the calling process had exported: an index, a repository, a working tree and a config
  // file, every one of them outside the fixture repository.
  process.env.GIT_INDEX_FILE = index;
  process.env.GIT_DIR = dir;
  process.env.GIT_WORK_TREE = worktree;
  process.env.GIT_CONFIG_GLOBAL = config;
  const env = isolatedEnv(home);
  writeFile(join(repo, 'staged.txt'), 'staged\\n');
  runGit(repo, ['add', '-A'], env);
  runGit(repo, ['commit', '-q', '--no-gpg-sign', '-m', 'fixture'], env);
  process.stdout.write(JSON.stringify({
    status: runGit(repo, ['status', '--porcelain'], env),
    index: runGit(repo, ['ls-files'], env),
    head: runGit(repo, ['rev-parse', 'HEAD'], env).trim(),
  }));
} catch (error) {
  process.stderr.write(\`\${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exitCode = 1;
}
`;

interface DiffEntry {
  readonly filepath: string;
  readonly previousPath: string;
  readonly baseMode: string;
  readonly headMode: string;
  readonly baseObject: string;
  readonly headObject: string;
  readonly base: string;
  readonly head: string;
  readonly diff: string;
}

interface DiffPayload {
  readonly repoRoot: string;
  readonly head: string;
  readonly mergeBase: string;
  readonly files: readonly DiffEntry[];
}

interface RunnerResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface StagingReport {
  readonly status: string;
  readonly index: string;
  readonly head: string;
}

let sandbox!: SandboxRoot;
let runner = '';
let env: NodeJS.ProcessEnv = {};
let sequence = 0;

before(() => {
  sandbox = createSandbox('rulekeeper-git-diff-');
  const home = join(sandbox.root, 'home');
  mkdirSync(home, { recursive: true });
  runner = writeFile(join(sandbox.root, 'runner.mjs'), RUNNER);
  env = isolatedEnv(home);
});

after(() => {
  sandbox.cleanup();
});

function createRepo(label: string, branch = 'main'): string {
  const root = join(sandbox.root, `${sequence++}-${label}`);
  mkdirSync(root, { recursive: true });
  runGit(root, ['init', '-q', '-b', branch], env);
  return root;
}

function commit(root: string, message: string): string {
  runGit(root, ['add', '-A'], env);
  runGit(root, ['commit', '-q', '--no-gpg-sign', '-m', message], env);
  return runGit(root, ['rev-parse', 'HEAD'], env).trim();
}

function runRaw(cwd: string, base = ''): RunnerResult {
  const result = spawnSync(process.execPath, [runner, base], { cwd, encoding: 'utf8', env });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function text(payload: Record<string, unknown>, key: string, where: string): string {
  const field = payload[key];
  if (typeof field !== 'string') throw new Error(`${where}.${key} must be a string`);
  return field;
}

function toEntry(value: unknown, where: string): DiffEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be a mapping`);
  const payload = value as Record<string, unknown>;
  return {
    filepath: text(payload, 'filepath', where),
    previousPath: text(payload, 'previousPath', where),
    baseMode: text(payload, 'baseMode', where),
    headMode: text(payload, 'headMode', where),
    baseObject: text(payload, 'baseObject', where),
    headObject: text(payload, 'headObject', where),
    base: text(payload, 'base', where),
    head: text(payload, 'head', where),
    diff: text(payload, 'diff', where),
  };
}

function runDiff(cwd: string, base = ''): DiffPayload {
  const result = runRaw(cwd, base);
  assert.strictEqual(result.status, 0, `expected the branch diff to succeed (stderr: ${result.stderr})`);
  const parsed: unknown = JSON.parse(result.stdout);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('the runner must report a mapping');
  const payload = parsed as Record<string, unknown>;
  const files = payload.files;
  if (!Array.isArray(files)) throw new Error('the runner must report a files array');
  return {
    repoRoot: text(payload, 'repoRoot', 'payload'),
    head: text(payload, 'head', 'payload'),
    mergeBase: text(payload, 'mergeBase', 'payload'),
    files: files.map((entry, index) => toEntry(entry, `payload.files[${index}]`)),
  };
}

function assertFails(cwd: string, base: string, needles: readonly string[]): void {
  const result = runRaw(cwd, base);
  assert.notStrictEqual(result.status, 0, `expected the branch diff to fail (stdout: ${result.stdout})`);
  for (const needle of needles) {
    assert.ok(result.stderr.includes(needle), `expected ${JSON.stringify(result.stderr)} to mention ${JSON.stringify(needle)}`);
  }
}

function hasBlob(cwd: string, oid: string): boolean {
  const probe = spawnSync('git', ['--no-lazy-fetch', 'cat-file', '-e', oid], {
    cwd,
    encoding: 'utf8',
    env: { ...env, GIT_NO_LAZY_FETCH: '1' },
  });
  return probe.status === 0;
}

function toStaging(value: unknown): StagingReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('the staging probe must report a mapping');
  const payload = value as Record<string, unknown>;
  return {
    status: text(payload, 'status', 'staging'),
    index: text(payload, 'index', 'staging'),
    head: text(payload, 'head', 'staging'),
  };
}

test('stages in its own repository when the caller exports hostile Git locations', () => {
  const repo = createRepo('hostile-env');
  const home = join(sandbox.root, 'hostile-env-home');
  mkdirSync(home, { recursive: true });
  // An index, a repository, a working tree and a config file, every one outside the fixture.
  const index = join(sandbox.root, 'hostile-index');
  const dir = join(sandbox.root, 'hostile-git-dir');
  const worktree = join(sandbox.root, 'hostile-work-tree');
  const config = 'not a Git config file\n';
  const configPath = writeFile(join(sandbox.root, 'hostile-gitconfig'), config);
  const probe = writeFile(join(sandbox.root, 'staging-probe.mjs'), STAGING_PROBE);
  const exported = JSON.stringify({ repo, home, index, dir, worktree, config: configPath });

  // The child inherits this process' environment and exports the hostile locations itself, so no
  // case rewrites `process.env` under its siblings.
  const result = spawnSync(process.execPath, [probe, exported], { cwd: sandbox.root, encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  assert.strictEqual(result.status, 0, `expected the fixture Git to stage ${repo} (stderr: ${result.stderr})`);

  const staging = toStaging(JSON.parse(result.stdout));
  // The file was staged and committed in the repository the child was given: its tree is clean
  // afterwards, its own index lists the file, and this process reads back the same commit.
  assert.strictEqual(staging.status, '');
  assert.strictEqual(staging.index, 'staged.txt\n');
  assert.match(staging.head, /^[0-9a-f]{40}$/, 'expected the commit the probe created');
  assert.strictEqual(runGit(repo, ['rev-parse', 'HEAD'], env).trim(), staging.head);
  // Every caller path is untouched: no external index was written, no external repository or
  // working tree was created and the unreadable config file was left as it was.
  assert.strictEqual(existsSync(index), false, `the exported index ${index} must not be written`);
  assert.strictEqual(existsSync(dir), false, `the exported repository ${dir} must not be created`);
  assert.strictEqual(existsSync(worktree), false, `the exported working tree ${worktree} must not be created`);
  assert.strictEqual(readFileSync(configPath, 'utf8'), config, `the exported config ${configPath} must not be rewritten`);
});

test('defaults to the ref origin/HEAD points at, ahead of the origin/main fallback', () => {
  const repo = createRepo('default-remote-head');
  writeFile(join(repo, 'a.txt'), 'one\n');
  const first = commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  writeFile(join(repo, 'a.txt'), 'two\n');
  const head = commit(repo, 'second');
  // The remote's default branch is `origin/release`, which already contains the feature commit,
  // while `origin/main` is the older commit the fallback list would reach for.
  runGit(repo, ['update-ref', 'refs/remotes/origin/main', first], env);
  runGit(repo, ['update-ref', 'refs/remotes/origin/release', head], env);
  runGit(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release'], env);

  const byDefault = runDiff(repo);
  assert.strictEqual(byDefault.repoRoot, repo);
  assert.strictEqual(byDefault.head, head);
  assert.strictEqual(byDefault.mergeBase, head);
  assert.deepStrictEqual(byDefault.files, []);

  const byMain = runDiff(repo, 'origin/main');
  assert.strictEqual(byMain.mergeBase, first);
  assert.deepStrictEqual(
    byMain.files.map((file) => file.filepath),
    ['a.txt'],
  );
});

test('falls back to a local main branch when the repository has no remote refs', () => {
  const repo = createRepo('default-local-main');
  writeFile(join(repo, 'a.txt'), 'one\n');
  const first = commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  writeFile(join(repo, 'b.txt'), 'new\n');
  const head = commit(repo, 'second');

  const result = runDiff(repo);
  assert.strictEqual(result.head, head);
  assert.strictEqual(result.mergeBase, first);
  assert.deepStrictEqual(
    result.files.map((file) => file.filepath),
    ['b.txt'],
  );
  assert.strictEqual(result.files[0]!.base, '');
  assert.strictEqual(result.files[0]!.head, 'new\n');
});

test('falls back to a local master branch when main does not exist', () => {
  const repo = createRepo('default-local-master', 'master');
  writeFile(join(repo, 'a.txt'), 'one\n');
  const first = commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  writeFile(join(repo, 'a.txt'), 'two\n');
  const head = commit(repo, 'second');

  const result = runDiff(repo);
  assert.strictEqual(result.head, head);
  assert.strictEqual(result.mergeBase, first);
  assert.strictEqual(result.files[0]!.base, 'one\n');
});

test('accepts an unqualified remote base ref without fetching', () => {
  const repo = createRepo('remote-base');
  writeFile(join(repo, 'a.txt'), 'one\n');
  const first = commit(repo, 'first');
  runGit(repo, ['update-ref', 'refs/remotes/origin/release', first], env);
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  writeFile(join(repo, 'a.txt'), 'two\n');
  const head = commit(repo, 'second');

  const result = runDiff(repo, 'origin/release');
  assert.strictEqual(result.head, head);
  assert.strictEqual(result.mergeBase, first);
  assert.deepStrictEqual(
    result.files.map((file) => file.filepath),
    ['a.txt'],
  );
});

test('compares against the merge base when the base branch advanced after the fork', () => {
  const repo = createRepo('advanced-base');
  writeFile(join(repo, 'a.txt'), 'one\n');
  const fork = commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  writeFile(join(repo, 'a.txt'), 'feature text\n');
  const head = commit(repo, 'feature change');
  runGit(repo, ['checkout', '-q', 'main'], env);
  writeFile(join(repo, 'a.txt'), 'main text\n');
  const tip = commit(repo, 'main advanced');
  assert.notStrictEqual(tip, fork);
  runGit(repo, ['checkout', '-q', 'feature'], env);

  const result = runDiff(repo, 'refs/heads/main');
  assert.strictEqual(result.head, head);
  assert.strictEqual(result.mergeBase, fork);
  assert.deepStrictEqual(
    result.files.map((file) => file.filepath),
    ['a.txt'],
  );
  // The base side is the fork point, not the advanced base branch the caller named.
  assert.strictEqual(result.files[0]!.base, 'one\n');
  assert.strictEqual(result.files[0]!.head, 'feature text\n');
  assert.notStrictEqual(result.files[0]!.diff, '');
});

test('reads the frozen commits, never the dirty working tree', () => {
  const repo = createRepo('dirty-checkout');
  writeFile(join(repo, 'tracked.txt'), 'committed base\n');
  const first = commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  writeFile(join(repo, 'tracked.txt'), 'committed head\n');
  const head = commit(repo, 'second');
  writeFile(join(repo, 'tracked.txt'), 'uncommitted edit\n');
  writeFile(join(repo, 'untracked.txt'), 'never committed\n');

  const result = runDiff(repo);
  assert.strictEqual(result.repoRoot, repo);
  assert.strictEqual(result.head, head);
  assert.strictEqual(result.mergeBase, first);
  assert.deepStrictEqual(
    result.files.map((file) => file.filepath),
    ['tracked.txt'],
  );
  assert.strictEqual(result.files[0]!.base, 'committed base\n');
  assert.strictEqual(result.files[0]!.head, 'committed head\n');
});

test('keeps a repository root whose path ends in whitespace intact', () => {
  for (const suffix of [' ', '\n']) {
    const repo = createRepo(`trailing${suffix}`);
    writeFile(join(repo, 'a.txt'), 'one\n');
    const first = commit(repo, 'first');
    runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
    writeFile(join(repo, 'a.txt'), 'two\n');
    const head = commit(repo, 'second');

    const result = runDiff(repo);
    assert.strictEqual(result.repoRoot, repo);
    assert.strictEqual(result.mergeBase, first);
    assert.strictEqual(result.head, head);
    assert.deepStrictEqual(
      result.files.map((file) => file.filepath),
      ['a.txt'],
    );
    assert.strictEqual(result.files[0]!.base, 'one\n');
    assert.strictEqual(result.files[0]!.head, 'two\n');
  }
});

test('keeps filenames with spaces, tabs, newlines and glob characters verbatim', () => {
  const repo = createRepo('filenames');
  writeFile(join(repo, 'seed.txt'), 'seed\n');
  commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  // `bracket[1].txt` and `bracket1.txt` both exist: a reader that let Git expand a path as a
  // pathspec glob would read the other one's snapshot or patch for one of them.
  const names = ['space name.txt', 'line\nbreak.txt', 'star*.txt', 'bracket[1].txt', 'bracket1.txt', 'tab\tname.txt'];
  for (const name of names) writeFile(join(repo, name), `${name}\n`);
  const head = commit(repo, 'names');

  const result = runDiff(repo);
  assert.strictEqual(result.head, head);
  // The reported order is the filepath order, whatever order Git listed the records in.
  assert.deepStrictEqual(
    result.files.map((file) => file.filepath),
    [...names].sort(),
  );
  for (const file of result.files) {
    assert.strictEqual(file.base, '');
    assert.strictEqual(file.head, `${file.filepath}\n`);
    // An added file's patch carries exactly its own content, so a reader that let Git expand a path
    // as a pathspec glob would show another file's patch here.
    for (const line of file.head.split('\n').slice(0, -1)) {
      assert.ok(file.diff.includes(`+${line}`), `expected the patch of ${JSON.stringify(file.filepath)}`);
    }
  }
});

test('pairs a rename with the path it came from', () => {
  const repo = createRepo('rename');
  writeFile(join(repo, 'old name.txt'), 'content\n');
  commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  runGit(repo, ['mv', 'old name.txt', 'new name.txt'], env);
  const head = commit(repo, 'rename');

  const result = runDiff(repo);
  assert.strictEqual(result.head, head);
  assert.deepStrictEqual(
    result.files.map((file) => file.filepath),
    ['new name.txt'],
  );
  const file = result.files[0]!;
  assert.strictEqual(file.previousPath, 'old name.txt');
  assert.strictEqual(file.baseMode, '100644');
  assert.strictEqual(file.headMode, '100644');
  // The content did not change, so both sides are the same blob and only the path moved.
  assert.strictEqual(file.baseObject, file.headObject);
  assert.strictEqual(file.base, 'content\n');
  assert.strictEqual(file.head, 'content\n');
  assert.notStrictEqual(file.diff, '');
});

test('ignores repository Git configuration that could shorten ids or drop renames', () => {
  const repo = createRepo('local-config');
  writeFile(join(repo, 'old name.txt'), 'content\n');
  commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  runGit(repo, ['mv', 'old name.txt', 'new name.txt'], env);
  const head = commit(repo, 'rename');
  // Local settings a plain reader would inherit: abbreviated object ids, and rename detection off.
  // The diff must still name full object ids and still pair the rename with the path it came from.
  runGit(repo, ['config', 'core.abbrev', '7'], env);
  runGit(repo, ['config', 'diff.renames', 'false'], env);

  const result = runDiff(repo);
  assert.strictEqual(result.head, head);
  assert.deepStrictEqual(
    result.files.map((file) => file.filepath),
    ['new name.txt'],
  );
  const file = result.files[0]!;
  assert.strictEqual(file.previousPath, 'old name.txt');
  assert.match(file.baseObject, /^[0-9a-f]{40}$/, 'expected the base object id unabbreviated');
  assert.match(file.headObject, /^[0-9a-f]{40}$/, 'expected the head object id unabbreviated');
  assert.strictEqual(file.base, 'content\n');
  assert.strictEqual(file.head, 'content\n');
});

test('reports additions and deletions with the missing side zeroed', () => {
  const repo = createRepo('add-delete');
  writeFile(join(repo, 'gone.txt'), 'goodbye\n');
  writeFile(join(repo, 'keep.txt'), 'kept\n');
  commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '-b', 'feature'], env);
  runGit(repo, ['rm', '-q', 'gone.txt'], env);
  // Deliberately unlike the deleted file, so rename detection cannot pair the two changes.
  const addition = `${Array.from({ length: 40 }, (_value, index) => `new line ${index} with no shared history`).join('\n')}\n`;
  writeFile(join(repo, 'added.txt'), addition);
  const head = commit(repo, 'add and delete');

  const result = runDiff(repo);
  assert.strictEqual(result.head, head);
  assert.deepStrictEqual(
    result.files.map((file) => file.filepath),
    ['added.txt', 'gone.txt'],
  );

  const added = result.files[0]!;
  assert.strictEqual(added.previousPath, 'added.txt');
  assert.strictEqual(added.baseMode, '000000');
  assert.strictEqual(added.baseObject, '0'.repeat(added.baseObject.length));
  assert.strictEqual(added.headMode, '100644');
  assert.strictEqual(added.base, '');
  assert.strictEqual(added.head, addition);
  assert.notStrictEqual(added.diff, '');

  const deleted = result.files[1]!;
  assert.strictEqual(deleted.filepath, 'gone.txt');
  assert.strictEqual(deleted.previousPath, 'gone.txt');
  assert.strictEqual(deleted.headMode, '000000');
  assert.strictEqual(deleted.headObject, '0'.repeat(deleted.headObject.length));
  assert.strictEqual(deleted.baseMode, '100644');
  assert.strictEqual(deleted.base, 'goodbye\n');
  assert.strictEqual(deleted.head, '');
  assert.notStrictEqual(deleted.diff, '');
});

test('fails on a partial clone instead of fetching the missing blob', () => {
  const origin = createRepo('partial-origin');
  // The origin agrees to serve a filtered clone. It is a local `file://` URL, so nothing reaches
  // the network even if a fetch were attempted.
  runGit(origin, ['config', 'uploadpack.allowFilter', 'true'], env);
  writeFile(join(origin, 'values.yaml'), 'memory: 100Mi\n');
  commit(origin, 'base');
  runGit(origin, ['checkout', '-q', '-b', 'feature'], env);
  writeFile(join(origin, 'values.yaml'), 'memory: 200Mi\n');
  commit(origin, 'change');
  const blob = runGit(origin, ['rev-parse', 'HEAD:values.yaml'], env).trim();

  const clone = join(sandbox.root, 'partial-clone');
  runGit(sandbox.root, ['clone', '--filter=blob:none', '--no-checkout', pathToFileURL(origin).href, clone], env);
  assert.strictEqual(hasBlob(clone, blob), false, 'expected the partial clone to lack the changed blob');

  // Reading the branch must fail on the missing object instead of fetching it on demand.
  const result = runRaw(clone, 'origin/main');
  assert.notStrictEqual(result.status, 0, 'expected the branch diff to fail on the missing blob');
  assert.notStrictEqual(result.stderr.trim(), '', 'expected the failure to be reported');
  assert.strictEqual(hasBlob(clone, blob), false, 'the branch diff must not fetch the missing blob');
});

test('fails outside a Git working tree, naming the directory it started from', () => {
  const outside = join(sandbox.root, 'outside');
  mkdirSync(outside, { recursive: true });
  assertFails(outside, '', [outside]);
});

test('fails instructing --base when no default base resolves', () => {
  const repo = createRepo('no-default', 'trunk');
  writeFile(join(repo, 'a.txt'), 'one\n');
  commit(repo, 'first');
  assertFails(repo, '', ['--base']);
});

test('fails when a named base ref does not resolve', () => {
  const repo = createRepo('missing-base');
  writeFile(join(repo, 'a.txt'), 'one\n');
  commit(repo, 'first');
  assertFails(repo, 'origin/missing', ['origin/missing', '--base']);
});

test('fails on an unborn HEAD', () => {
  const repo = createRepo('unborn');
  assertFails(repo, '', ['HEAD']);
});

test('fails when the base ref shares no history with HEAD', () => {
  const repo = createRepo('unrelated');
  writeFile(join(repo, 'a.txt'), 'one\n');
  commit(repo, 'first');
  runGit(repo, ['checkout', '-q', '--orphan', 'other'], env);
  writeFile(join(repo, 'b.txt'), 'unrelated\n');
  commit(repo, 'orphan');

  assertFails(repo, 'refs/heads/main', ['refs/heads/main', 'common']);
});
