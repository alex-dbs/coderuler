import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { changedFiles } from '../git/changes.js';
import { isolatedGitEnvironment } from '../git/environment.js';
import { createGithubApi, mapping } from './api.js';

export interface PullRequest {
  readonly repository: string;
  readonly number: number;
  readonly head?: string;
}

export interface PullRequestCheckout {
  readonly root: string;
  readonly rulesRoot: string;
  readonly changedFiles: ReadonlySet<string>;
  readonly pullRequest: PullRequest;
  cleanup(): Promise<void>;
}

export function repositoryName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Cannot determine the GitHub repository: expected owner/repository.');
  }
  return value;
}

export function pullNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Cannot determine a valid GitHub pull request number.');
  }
  return value;
}

export function originRepository(origin: string): string {
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

function selectorIdentity(selector: string): { readonly repository?: string; readonly number: number } {
  const invalid = '--pr must be a positive pull request number or a GitHub pull request URL.';
  if (/^[0-9]+$/.test(selector)) {
    try {
      return { number: pullNumber(Number(selector)) };
    } catch {
      throw new Error(invalid);
    }
  }
  const match = /^https:\/\/github\.com(?::443)?\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/pull\/([0-9]+)\/?(?:[?#][\s\S]*)?$/i.exec(selector);
  if (!match) throw new Error(invalid);
  try {
    return { repository: repositoryName(match[1]), number: pullNumber(Number(match[2])) };
  } catch {
    throw new Error(invalid);
  }
}

export function createPullRequestCheckout(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): (selector: string, baseBranch?: string) => Promise<PullRequestCheckout> {
  const isolatedEnv = isolatedGitEnvironment(env);
  const api = createGithubApi(env.GITHUB_TOKEN?.trim() || undefined);

  const runGit = (
    root: string,
    args: readonly string[],
    allowedExitCodes: readonly number[] = [0],
  ): Promise<{ readonly stdout: string; readonly code: number | null }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{ readonly stdout: string; readonly code: number | null }>();
    const child = spawn('git', [...args], {
      cwd: root,
      env: isolatedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => reject(new Error(`Cannot run Git: ${error.message}`, {
      cause: error,
    })));
    child.on('close', (code, signal) => {
      if (code !== null && allowedExitCodes.includes(code)) resolve({ stdout, code });
      else reject(new Error(`Git ${args[0]} failed: ${stderr.trim() || signal || `exit ${code}`}`));
    });
    return promise;
  };

  const assertNoWorktreeOverride = async (root: string): Promise<void> => {
    const result = await runGit(root, ['config', '--null', '--get-all', 'core.worktree'], [0, 1]);
    if (result.code === 0) {
      throw new Error('PR checkout requires Git core.worktree to be unset; remove the inherited repository-location override.');
    }
  };

  return async (selector, baseBranch) => {
    const identity = selectorIdentity(selector);
    await assertNoWorktreeOverride(cwd);
    const transport = identity.repository === undefined
      ? (await runGit(cwd, ['remote', 'get-url', 'origin'])).stdout.trim()
      : `https://github.com/${identity.repository}.git`;
    const pullRequest: PullRequest = {
      repository: identity.repository ?? originRepository(transport),
      number: identity.number,
    };
    const response = await api.json(`/repos/${pullRequest.repository}/pulls/${pullRequest.number}`);
    const defaultBranch = mapping(mapping(response)?.base)?.ref;
    if (baseBranch === undefined && (typeof defaultBranch !== 'string' || defaultBranch.trim() === '')) {
      throw new Error('GitHub API returned an invalid pull request response: expected a base branch.');
    }
    const branch = baseBranch ?? defaultBranch as string;
    const workspace = await mkdtemp(join(await realpath(tmpdir()), 'rulekeeper-pr-'));
    const root = join(workspace, 'head');
    const rulesRoot = join(workspace, 'base');
    const cleanup = (): Promise<void> => rm(workspace, { recursive: true, force: true });
    try {
      await runGit(cwd, ['init', root]);
      await assertNoWorktreeOverride(root);
      await runGit(root, ['remote', 'add', 'origin', transport]);
      await runGit(root, ['check-ref-format', `refs/heads/${branch}`]);
      await runGit(root, [
        'fetch', '--no-tags', 'origin',
        `+refs/heads/${branch}:refs/rulekeeper/base`,
        `+refs/pull/${pullRequest.number}/head:refs/rulekeeper/head`,
      ]);
      await runGit(root, ['checkout', '--detach', 'refs/rulekeeper/head']);
      const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
      await runGit(root, ['worktree', 'add', '--detach', rulesRoot, 'refs/rulekeeper/base']);
      const mergeBase = (await runGit(root, ['merge-base', 'refs/rulekeeper/base', 'refs/rulekeeper/head'])).stdout.trim();
      const files = await changedFiles(root, mergeBase, isolatedEnv);
      await assertNoWorktreeOverride(rulesRoot);
      return { root, rulesRoot, changedFiles: files, pullRequest: { ...pullRequest, head }, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
}
