import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { ViolationComment } from '../../app/violation-comments.js';

interface PullRequest {
  readonly repository: string;
  readonly number: number;
}

function repositoryName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Cannot determine the GitHub repository: expected owner/repository.');
  }
  return value;
}

function pullNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Cannot determine a valid GitHub pull request number.');
  }
  return value;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('git', [...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Cannot run Git to resolve the GitHub pull request.')));
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Git ${args[0]} failed; check the origin remote and current branch (detached HEAD is unsupported).`));
    });
  });
}

function originRepository(origin: string): string {
  let path: string;
  const scp = /^git@github\.com:(.+)$/i.exec(origin);
  if (scp) {
    path = scp[1]!;
  } else {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('Git origin must be an HTTPS or SSH repository on github.com.');
    }
    if (url.hostname.toLowerCase() !== 'github.com' || !['https:', 'ssh:'].includes(url.protocol)
      || (url.port !== '' && !(url.protocol === 'ssh:' && url.port === '22')) || url.search || url.hash) {
      throw new Error('Git origin must be an HTTPS or SSH repository on github.com.');
    }
    path = url.pathname.slice(1);
  }
  return repositoryName(path.replace(/\/$/, '').replace(/\.git$/, ''));
}

function mapping(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function actionsPullRequest(env: Readonly<Record<string, string | undefined>>): Promise<PullRequest | undefined> {
  const ref = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(env.GITHUB_REF ?? '');
  if (ref) return { repository: repositoryName(env.GITHUB_REPOSITORY), number: pullNumber(Number(ref[1])) };
  if (!env.GITHUB_EVENT_PATH) return undefined;

  let event: unknown;
  try {
    event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) as unknown;
  } catch {
    throw new Error('Cannot read the GitHub pull request event at GITHUB_EVENT_PATH; check that it is readable JSON.');
  }
  const pull = mapping(mapping(event)?.pull_request);
  const base = mapping(mapping(pull?.base)?.repo);
  if (!pull || !base) throw new Error('GitHub event does not identify a pull request and its base repository.');
  return { repository: repositoryName(base.full_name), number: pullNumber(pull.number) };
}

interface DiffRun {
  readonly start: number;
  end: number;
  readonly added: boolean;
}

interface PullFile {
  readonly filename: string;
  readonly status: string;
  readonly sha: string;
  readonly patch?: string;
}

interface ReviewComment {
  readonly path: string;
  readonly body: string;
  readonly line: number;
  readonly side: 'RIGHT';
  readonly start_line?: number;
  readonly start_side?: 'RIGHT';
}

function rightRuns(patch: string): readonly DiffRun[] {
  const runs: DiffRun[] = [];
  let hunk: { old: number; right: number; oldCount: number; rightCount: number; oldRead: number; rightRead: number; runs: DiffRun[]; valid: boolean } | undefined;
  const finish = () => {
    if (hunk?.valid && hunk.oldRead === hunk.oldCount && hunk.rightRead === hunk.rightCount) runs.push(...hunk.runs);
  };
  const lines = patch.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]!;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(text);
    if (header) {
      finish();
      const old = Number(header[1]);
      const right = Number(header[3]);
      const oldCount = Number(header[2] ?? 1);
      const rightCount = Number(header[4] ?? 1);
      hunk = { old, right, oldCount, rightCount, oldRead: 0, rightRead: 0, runs: [],
        valid: [old, right, oldCount, rightCount, old + oldCount, right + rightCount].every(Number.isSafeInteger)
          && (oldCount === 0 || old > 0) && (rightCount === 0 || right > 0) };
      continue;
    }
    if (!hunk || text === '\\ No newline at end of file' || (index === lines.length - 1 && text === '')) continue;
    const prefix = text[0];
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') { hunk.valid = false; continue; }
    if (prefix !== '+') hunk.oldRead++;
    if (prefix !== '-') {
      const line = hunk.right + hunk.rightRead++;
      const added = prefix === '+';
      const previous = hunk.runs.at(-1);
      if (previous && previous.added === added && previous.end + 1 === line) previous.end = line;
      else hunk.runs.push({ start: line, end: line, added });
    }
    if (hunk.oldRead > hunk.oldCount || hunk.rightRead > hunk.rightCount) hunk.valid = false;
  }
  finish();
  return runs;
}

async function repositoryPaths(root: string): Promise<{ root: string; invocation: string } | undefined> {
  try {
    const invocation = await realpath(root);
    const repository = await realpath(await git(invocation, ['rev-parse', '--show-toplevel']));
    const prefix = relative(repository, invocation);
    if (prefix === '..' || prefix.startsWith(`..${sep}`) || isAbsolute(prefix)) return undefined;
    return { root: repository, invocation };
  } catch {
    return undefined;
  }
}

async function matchingFile(
  repository: { readonly root: string; readonly invocation: string },
  filepath: string,
  files: ReadonlyMap<string, PullFile>,
): Promise<PullFile | undefined> {
  if (!filepath || isAbsolute(filepath)) return undefined;
  const absolute = resolve(repository.invocation, filepath);
  const local = relative(repository.root, absolute);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined;
  const path = local.split(sep).join('/');
  const file = files.get(path);
  if (!file || file.status === 'removed' || !file.patch) return undefined;
  try {
    // Symlinks and paths escaping through a symlink cannot identify this Git blob.
    if (!(await lstat(absolute)).isFile() || await realpath(absolute) !== absolute) return undefined;
    await git(repository.root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path]);
    const bytes = await readFile(absolute);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return sha === file.sha ? file : undefined;
  } catch {
    return undefined;
  }
}

export function createGithubCommenter(
  env: Readonly<Record<string, string | undefined>>,
): (root: string, comments: readonly ViolationComment[]) => Promise<void> {
  return async (root, comments) => {
    if (comments.length === 0) return;
    const token = env.GITHUB_TOKEN?.trim();
    if (!token) throw new Error('GITHUB_TOKEN is required to comment on a GitHub pull request.');

    const request = async (path: string, method: 'GET' | 'POST', payload?: object): Promise<Response> => {
      let response: Response;
      try {
        response = await fetch(`https://api.github.com${path}`, {
          method,
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
      } catch {
        throw new Error('GitHub API request failed; check network connectivity to api.github.com.');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`GitHub API returned HTTP ${response.status}; check GITHUB_TOKEN permissions and pull request access.`);
      }
      return response;
    };
    const json = async (path: string): Promise<unknown> => {
      const response = await request(path, 'GET');
      try {
        return await response.json() as unknown;
      } catch {
        throw new Error('GitHub API returned an invalid response.');
      }
    };

    let pull = await actionsPullRequest(env);
    if (!pull) {
      const repository = originRepository(await git(root, ['remote', 'get-url', 'origin']));
      const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (!branch) throw new Error('Cannot resolve the current branch; detached HEAD is unsupported.');
      const owner = repository.split('/')[0]!;
      const pulls = await json(`/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=2`);
      if (!Array.isArray(pulls)) throw new Error('GitHub API returned an invalid pull request discovery response.');
      if (pulls.length === 0) throw new Error('No open pull request found for the current branch on GitHub.');
      if (pulls.length !== 1) throw new Error('Multiple open pull requests match the current branch; refusing an ambiguous comment target.');
      pull = { repository, number: pullNumber(mapping(pulls[0])?.number) };
    }
    const path = `/repos/${pull.repository}/pulls/${pull.number}`;
    const readHead = async (): Promise<string> => {
      const sha = mapping(mapping(await json(path))?.head)?.sha;
      if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('GitHub API returned an invalid pull request head response.');
      return sha;
    };
    const head = await readHead();
    const files = new Map<string, PullFile>();
    for (let page = 1; page <= 30; page++) {
      const entries = await json(`${path}/files?per_page=100&page=${page}`);
      if (!Array.isArray(entries) || entries.length > 100) throw new Error('GitHub API returned an invalid pull request files response.');
      for (const entry of entries) {
        const file = mapping(entry);
        if (!file || typeof file.filename !== 'string' || typeof file.status !== 'string' || typeof file.sha !== 'string'
          || !/^[a-f0-9]{40}$/.test(file.sha)) throw new Error('GitHub API returned an invalid pull request files response.');
        files.set(file.filename, { filename: file.filename, status: file.status, sha: file.sha,
          ...(typeof file.patch === 'string' ? { patch: file.patch } : {}) });
      }
      if (entries.length < 100) break;
    }

    const repository = comments.some(comment => comment.locations.length > 0) ? await repositoryPaths(root) : undefined;
    const matched = new Map<string, Promise<PullFile | undefined>>();
    const patches = new Map<string, readonly DiffRun[]>();
    const inline: ReviewComment[] = [];
    const fallback: string[] = [];
    for (const finding of comments) {
      const anchors = new Set<string>();
      for (const location of finding.locations) {
        if (!repository || !Number.isSafeInteger(location.lines.start) || !Number.isSafeInteger(location.lines.end)
          || location.lines.start <= 0 || location.lines.end < location.lines.start) continue;
        let match = matched.get(location.filepath);
        if (!match) {
          match = matchingFile(repository, location.filepath, files);
          matched.set(location.filepath, match);
        }
        const file = await match;
        if (!file?.patch) continue;
        let runs = patches.get(file.filename);
        if (!runs) { runs = rightRuns(file.patch); patches.set(file.filename, runs); }
        const run = runs.find(run => run.added && run.start <= location.lines.end && run.end >= location.lines.start)
          ?? runs.find(run => !run.added && run.start <= location.lines.end && run.end >= location.lines.start);
        if (!run) continue;
        const start = Math.max(run.start, location.lines.start);
        const end = Math.min(run.end, location.lines.end);
        const key = JSON.stringify([file.filename, start, end]);
        if (anchors.has(key)) continue;
        anchors.add(key);
        inline.push({ path: file.filename, body: finding.body, line: end, side: 'RIGHT',
          ...(start < end ? { start_line: start, start_side: 'RIGHT' as const } : {}) });
      }
      if (anchors.size === 0) fallback.push(finding.body);
    }

    if (inline.length > 0) {
      if (await readHead() !== head) throw new Error('GitHub pull request head changed during comment planning; refusing stale inline locations.');
      for (let index = 0; index < inline.length; index += 100) {
        const response = await request(`${path}/reviews`, 'POST', {
          commit_id: head, event: 'COMMENT', body: 'Rulekeeper violations', comments: inline.slice(index, index + 100),
        });
        await response.body?.cancel().catch(() => undefined);
      }
    }
    if (fallback.length > 0) {
      const response = await request(`/repos/${pull.repository}/issues/${pull.number}/comments`, 'POST', {
        body: `## Rulekeeper violations\n\n${fallback.join('\n\n')}\n`,
      });
      await response.body?.cancel().catch(() => undefined);
    }
  };
}
