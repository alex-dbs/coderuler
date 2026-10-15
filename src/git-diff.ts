/**
 * Branch diffs: the committed change between a base ref and `HEAD`, read with Git itself.
 *
 * The comparison is a pull request's: the base side is the merge base of the base ref and `HEAD`,
 * the head side is the frozen `HEAD` commit. Git runs without a shell, in the repository root once
 * it is known, and every read names a commit id rather than a moving branch name, so the working
 * tree is never consulted — a dirty checkout does not change the answer. A base ref that exists only
 * on a remote must already be present locally, and the failure says so.
 *
 * Nothing here fetches, not even in a partial clone whose blobs are missing: Git runs with
 * `--no-lazy-fetch`, so a missing object fails the read instead of reaching the promisor remote.
 * That option needs Git 2.45 or later — older Git rejects it, which fails the diff loudly rather
 * than silently allowing the fetch.
 */
import { spawn } from 'node:child_process';

/** One file of a branch diff, as Git's raw (`--raw`) metadata reports it. */
export interface DiffFile {
  /**
   * Repository-relative path after the change, with `/` separators: the new path of a rename, and
   * the old path of a deletion, which has no path on the head side.
   */
  readonly filepath: string;
  /** Repository-relative path before the change; the same as {@link filepath} unless rename detection paired two different paths. */
  readonly previousPath: string;
  /** Raw source mode; all zeros when Git reports no source side (an addition). */
  readonly baseMode: string;
  /** Raw destination mode; all zeros when Git reports no destination side (a deletion). */
  readonly headMode: string;
  /** Raw source object id; all zeros when Git reports no source side. */
  readonly baseObject: string;
  /** Raw destination object id; all zeros when Git reports no destination side. */
  readonly headObject: string;
}

/** One branch's committed change set: the frozen commits compared and the files that differ. */
export interface BranchDiff {
  /** Absolute repository root; every {@link DiffFile} path is relative to it. */
  readonly repoRoot: string;
  /** Frozen commit id of `HEAD`, the head side of every comparison. */
  readonly head: string;
  /** Frozen commit id of the merge base of the base ref and {@link head}. */
  readonly mergeBase: string;
  /** Changed files, lexically sorted by `filepath`. */
  readonly files: readonly DiffFile[];
}

/** Git's marker for a side that does not exist: an absent mode, and an absent object id (all zeros). */
const ABSENT_MODE = '000000';

/** Git's mode for a symbolic link: its blob is a link target, not file text. */
const SYMLINK_MODE = '120000';

/** Git's mode for a submodule: the recorded object is a commit in another repository. */
const SUBMODULE_MODE = '160000';

/** Git's mode for a subdirectory, which no branch diff reports as a file. */
const TREE_MODE = '040000';

/** The ref that carries the remote's default branch, when the remote's head was recorded. */
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';

/**
 * The local branches a default base falls back through when `origin/HEAD` is unset or does not
 * resolve. Fully qualified, so a tag or remote branch of the same name cannot be chosen by accident.
 */
const DEFAULT_BASES: readonly string[] = [
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master',
];

/** One resolved base: the ref that was asked for, and the commit it froze to. */
interface ResolvedBase {
  readonly ref: string;
  readonly commit: string;
}

/** One Git invocation: its exit status and both streams, undecoded. */
interface GitOutcome {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * The option every invocation carries, before the subcommand: it turns a missing object into an
 * error instead of an on-demand fetch from the promisor remote. Passing it is what makes an
 * unsupported Git fail loudly — Git older than 2.45 rejects the option — where an environment
 * variable alone would be ignored and the read would silently go to the network.
 */
const NO_LAZY_FETCH = '--no-lazy-fetch';

/**
 * Run one Git command in one directory, with no shell and no output-size cap: the streams are
 * collected as they arrive, so a large patch is read whole rather than truncated at a default
 * buffer. Arguments reach `spawn` as an array with no shell in between, so nothing here is
 * shell-interpolated; a caller-supplied ref or path is kept from being read as an option by
 * `--end-of-options` and `--` at the call site, not by the array itself.
 *
 * Every run carries {@link NO_LAZY_FETCH} and its equivalent `GIT_NO_LAZY_FETCH=1`, and disables
 * interactive prompting, so no read can fetch a missing object or block on a credential question.
 */
function runGit(repoRoot: string, args: readonly string[]): Promise<GitOutcome> {
  const { promise, resolve, reject } = Promise.withResolvers<GitOutcome>();
  const child = spawn('git', [NO_LAZY_FETCH, ...args], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });
  child.on('error', (error: Error) => {
    reject(new Error(`Git could not be run in ${repoRoot} (${error.message}); install Git and make sure it is on PATH`, { cause: error }));
  });
  child.on('close', (code: number | null) => {
    resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
  });
  return promise;
}

/** The most useful thing to report about a failed invocation: Git's own message, else its status. */
function failureDetail(outcome: GitOutcome): string {
  const detail = outcome.stderr.trim();
  if (detail !== '') return detail;
  return outcome.code === null ? 'git was terminated by a signal' : `git exited with status ${outcome.code}`;
}

/**
 * The repository root the diff is taken in, or a failure naming the directory that is not in one.
 * Git answers with one line terminated by a line feed (or by a carriage return and a line feed), so
 * only that terminator is removed: a repository under a path that itself ends in whitespace keeps
 * every one of its characters.
 */
async function findRepoRoot(cwd: string): Promise<string> {
  const outcome = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const root = outcome.stdout.toString('utf8').replace(/\r?\n$/, '');
  if (outcome.code !== 0 || root === '') {
    const detail = failureDetail(outcome);
    throw new Error(`Cannot diff branch: ${cwd} is not inside a Git working tree (${detail}); run the diff from a checkout`, { cause: new Error(detail) });
  }
  return root;
}

/**
 * The commit one ref freezes to, or `undefined` when it names no commit here. The ref is verified
 * with `--verify --end-of-options` and a `^{commit}` peel, so a caller-supplied base cannot be read
 * as an option and a tag, a remote branch or a tree is either resolved to its commit or rejected.
 */
async function resolveCommit(repoRoot: string, ref: string): Promise<string | undefined> {
  const outcome = await runGit(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (outcome.code !== 0) return undefined;
  const commit = outcome.stdout.toString('utf8').trim();
  return commit === '' ? undefined : commit;
}

/**
 * The base the caller did not name: the branch `origin/HEAD` points at, then the usual `main` and
 * `master` locals in remote-then-local order. Each candidate is resolved to a commit before it is
 * chosen, so an unset remote head or a stale name falls through instead of failing the whole diff.
 */
async function defaultBase(repoRoot: string): Promise<ResolvedBase> {
  const symbolic = await runGit(repoRoot, ['symbolic-ref', '--quiet', ORIGIN_HEAD]);
  const declared = symbolic.code === 0 ? symbolic.stdout.toString('utf8').trim() : '';
  const candidates = [...new Set([declared === '' ? ORIGIN_HEAD : declared, ...DEFAULT_BASES])];
  for (const candidate of candidates) {
    const commit = await resolveCommit(repoRoot, candidate);
    if (commit !== undefined) return { ref: candidate, commit };
  }
  throw new Error(
    `Cannot diff branch: none of ${candidates.join(', ')} resolves to a commit in ${repoRoot}; pass --base with the ref to compare against (no fetch is performed)`,
  );
}

/** The common ancestor both frozen commits share; unrelated histories have none. */
async function mergeBaseOf(repoRoot: string, base: ResolvedBase, head: string): Promise<string> {
  const outcome = await runGit(repoRoot, ['merge-base', base.commit, head]);
  const commit = outcome.stdout.toString('utf8').trim();
  if (outcome.code !== 0 || commit === '') {
    const detail = failureDetail(outcome);
    throw new Error(`Cannot diff branch: ${base.ref} and HEAD have no common ancestor (${detail}); unrelated histories cannot be compared`, { cause: new Error(detail) });
  }
  return commit;
}

/**
 * Split one raw (`--raw -z`) listing into records. With `-z` Git terminates every field with NUL
 * and quotes nothing, so a path holding a space, a tab or a newline arrives verbatim — and a
 * rename or copy is followed by two paths, the old one first.
 */
function parseRaw(raw: Buffer): DiffFile[] {
  const tokens = raw.toString('utf8').split('\0');
  const files: DiffFile[] = [];
  let index = 0;
  while (index < tokens.length) {
    const header = tokens[index]!;
    index += 1;
    // The listing terminates with a NUL, which leaves one empty token behind it.
    if (header === '') continue;

    const fields = header.startsWith(':') ? header.slice(1).split(' ') : [];
    if (fields.length !== 5) throw new Error(`Cannot diff branch: unexpected git diff --raw record ${JSON.stringify(header)}`);
    const baseMode = fields[0]!;
    const headMode = fields[1]!;
    const baseObject = fields[2]!;
    const headObject = fields[3]!;
    const status = fields[4]!;
    const twoPaths = status.startsWith('R') || status.startsWith('C');

    const previousPath = tokens[index];
    if (previousPath === undefined || previousPath === '') {
      throw new Error(`Cannot diff branch: git diff --raw record ${JSON.stringify(header)} is missing its path`);
    }
    const movedPath = twoPaths ? tokens[index + 1] : undefined;
    if (twoPaths && (movedPath === undefined || movedPath === '')) {
      throw new Error(`Cannot diff branch: git diff --raw rename record ${JSON.stringify(header)} is missing one of its two paths`);
    }
    index += twoPaths ? 2 : 1;

    files.push({
      filepath: movedPath ?? previousPath,
      previousPath,
      baseMode,
      headMode,
      baseObject,
      headObject,
    });
  }
  return files.sort((left, right) => (left.filepath < right.filepath ? -1 : left.filepath > right.filepath ? 1 : 0));
}

/** The changed files of one frozen commit range, from Git's own raw metadata. */
async function rawFiles(repoRoot: string, mergeBase: string, head: string): Promise<DiffFile[]> {
  const outcome = await runGit(repoRoot, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv', mergeBase, head]);
  if (outcome.code !== 0) {
    const detail = failureDetail(outcome);
    throw new Error(`Cannot diff branch: git diff --raw failed (${detail})`, { cause: new Error(detail) });
  }
  return parseRaw(outcome.stdout);
}

/**
 * The committed change of the repository the process runs in: the merge base of `base` and `HEAD`
 * on the base side, the frozen `HEAD` commit on the head side, and Git's raw metadata for every
 * file that differs between them, lexically sorted by filepath.
 *
 * `base` defaults to the branch `origin/HEAD` points at, then `origin/main`, `origin/master`,
 * `main` and `master` in turn. A base names a commit to freeze — never a range, and never refetched
 * — so a caller can pass the branch a pull request targets without the working tree mattering.
 */
export async function branchDiff(base?: string): Promise<BranchDiff> {
  const repoRoot = await findRepoRoot(process.cwd());

  const head = await resolveCommit(repoRoot, 'HEAD');
  if (head === undefined) {
    throw new Error(`Cannot diff branch: HEAD does not resolve to a commit in ${repoRoot}; a branch with no commits yet has nothing to compare`);
  }

  let resolved: ResolvedBase;
  if (base === undefined) {
    resolved = await defaultBase(repoRoot);
  } else {
    const commit = await resolveCommit(repoRoot, base);
    if (commit === undefined) {
      throw new Error(`Cannot diff branch: base ref ${base} does not resolve to a commit in ${repoRoot}; pass --base with a ref that exists locally (no fetch is performed)`);
    }
    resolved = { ref: base, commit };
  }

  const mergeBase = await mergeBaseOf(repoRoot, resolved, head);
  return { repoRoot, head, mergeBase, files: await rawFiles(repoRoot, mergeBase, head) };
}

/**
 * One side's text at the frozen commits: a regular file's blob, and `''` for a side Git reports
 * absent or as something other than a regular file — a symlink's target and a submodule's commit id
 * are not the file's text, so neither is reported as one.
 */
async function readSide(repoRoot: string, file: DiffFile, side: 'base' | 'head'): Promise<string> {
  const mode = side === 'base' ? file.baseMode : file.headMode;
  if (mode === ABSENT_MODE || mode === SYMLINK_MODE || mode === SUBMODULE_MODE || mode === TREE_MODE) return '';
  const object = side === 'base' ? file.baseObject : file.headObject;
  const outcome = await runGit(repoRoot, ['cat-file', 'blob', object]);
  if (outcome.code !== 0) {
    const detail = failureDetail(outcome);
    throw new Error(`Cannot diff branch: the ${side} blob of ${file.filepath} could not be read (${detail})`, { cause: new Error(detail) });
  }
  return outcome.stdout.toString('utf8');
}

/**
 * One file's patch between the frozen merge base and `HEAD`. Pathspecs are literal, so a filename
 * holding glob or pathspec characters selects itself and nothing else, and rename detection runs
 * against both the old and the new path, so a rename reads as a rename rather than as a pair of
 * unrelated changes.
 */
async function readPatch(branch: BranchDiff, file: DiffFile): Promise<string> {
  const paths = file.previousPath === file.filepath ? [file.filepath] : [file.previousPath, file.filepath];
  const outcome = await runGit(branch.repoRoot, [
    '--no-pager',
    '--literal-pathspecs',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    branch.mergeBase,
    branch.head,
    '--',
    ...paths,
  ]);
  if (outcome.code !== 0) {
    const detail = failureDetail(outcome);
    throw new Error(`Cannot diff branch: git diff failed for ${file.filepath} (${detail})`, { cause: new Error(detail) });
  }
  return outcome.stdout.toString('utf8');
}

/**
 * One changed file's two committed texts and its patch, all read from the branch's frozen commits
 * rather than from the working tree. The base text is the file's content at the merge base, so a
 * caller can compare the same rule's scope on both sides without another checkout.
 */
export async function readBranchFile(branch: BranchDiff, file: DiffFile): Promise<{ base: string; head: string; diff: string }> {
  const baseSide = readSide(branch.repoRoot, file, 'base');
  // An unchanged rename or copy carries one object id and one mode on both sides, so the head side
  // reuses the base read instead of asking Git for the same blob twice.
  const sameObject = file.baseObject === file.headObject && file.baseMode === file.headMode;
  const [base, head, diff] = await Promise.all([
    baseSide,
    sameObject ? baseSide : readSide(branch.repoRoot, file, 'head'),
    readPatch(branch, file),
  ]);
  return { base, head, diff };
}
