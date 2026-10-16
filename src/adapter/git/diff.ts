import { spawn } from 'node:child_process';

export interface DiffFile {
  readonly filepath: string;
  readonly previousPath: string;
  readonly baseMode: string;
  readonly headMode: string;
  readonly baseObject: string;
  readonly headObject: string;
}

export interface BranchDiff {
  readonly repoRoot: string;
  readonly head: string;
  readonly mergeBase: string;
  readonly files: readonly DiffFile[];
}

const ABSENT_MODE = '000000';

const SYMLINK_MODE = '120000';

const SUBMODULE_MODE = '160000';

const TREE_MODE = '040000';

const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';

const DEFAULT_BASES: readonly string[] = [
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master',
];

interface ResolvedBase {
  readonly ref: string;
  readonly commit: string;
}

interface GitOutcome {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

const NO_LAZY_FETCH = '--no-lazy-fetch';

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

function failureDetail(outcome: GitOutcome): string {
  const detail = outcome.stderr.trim();
  if (detail !== '') return detail;
  return outcome.code === null ? 'git was terminated by a signal' : `git exited with status ${outcome.code}`;
}

async function findRepoRoot(cwd: string): Promise<string> {
  const outcome = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const root = outcome.stdout.toString('utf8').replace(/\r?\n$/, '');
  if (outcome.code !== 0 || root === '') {
    const detail = failureDetail(outcome);
    throw new Error(`Cannot diff branch: ${cwd} is not inside a Git working tree (${detail}); run the diff from a checkout`, { cause: new Error(detail) });
  }
  return root;
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string | undefined> {
  const outcome = await runGit(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (outcome.code !== 0) return undefined;
  const commit = outcome.stdout.toString('utf8').trim();
  return commit === '' ? undefined : commit;
}

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

async function mergeBaseOf(repoRoot: string, base: ResolvedBase, head: string): Promise<string> {
  const outcome = await runGit(repoRoot, ['merge-base', base.commit, head]);
  const commit = outcome.stdout.toString('utf8').trim();
  if (outcome.code !== 0 || commit === '') {
    const detail = failureDetail(outcome);
    throw new Error(`Cannot diff branch: ${base.ref} and HEAD have no common ancestor (${detail}); unrelated histories cannot be compared`, { cause: new Error(detail) });
  }
  return commit;
}

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

async function rawFiles(repoRoot: string, mergeBase: string, head: string): Promise<DiffFile[]> {
  const outcome = await runGit(repoRoot, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv', mergeBase, head]);
  if (outcome.code !== 0) {
    const detail = failureDetail(outcome);
    throw new Error(`Cannot diff branch: git diff --raw failed (${detail})`, { cause: new Error(detail) });
  }
  return parseRaw(outcome.stdout);
}

export async function branchDiff(base?: string, cwd?: string): Promise<BranchDiff> {
  const repoRoot = await findRepoRoot(cwd ?? process.cwd());

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
