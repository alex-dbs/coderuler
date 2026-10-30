import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isolatedGitEnvironment } from './environment.js';

export interface RuleRepositoryCheckout {
  readonly root: string;
  cleanup(): Promise<void>;
}

interface RuleRepositorySelector {
  readonly transport: string;
  readonly revision: string | undefined;
}

const invalidRepositoryUrl = 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.';

function parseRuleRepositorySelector(selector: string): RuleRepositorySelector | undefined {
  const schemeMatch = /^([a-z][a-z\d+.-]*):\/\//i.exec(selector);
  const schemePrefix = /^([a-z][a-z\d+.-]*):/i.exec(selector);
  const windowsDrivePath = /^[a-z]:[\\/]/i.test(selector);
  const malformedUrl = schemeMatch === null
    && schemePrefix !== null
    && !windowsDrivePath
    && (
      /^(?:https?|ssh|file|ftp|git(?:\+(?:https?|ssh))?):/i.test(selector)
      || /^[\\/]/.test(selector.slice(schemePrefix[0].length))
      || selector.slice(schemePrefix[0].length).includes('@')
    );
  const looksLikeUrl = schemeMatch !== null || malformedUrl;
  const looksLikeScp = /^[^/@:\s]*@[^/:\s]*:/.test(selector);
  if (!looksLikeUrl && !looksLikeScp) return undefined;

  const separator = selector.indexOf('#');
  const transport = separator === -1 ? selector : selector.slice(0, separator);
  const revision = separator === -1 ? undefined : selector.slice(separator + 1);
  if (revision === '') throw new Error('Rule repository revision must not be empty.');

  if (looksLikeUrl) {
    if (schemeMatch === null) throw new Error(invalidRepositoryUrl);
    let url: URL;
    try {
      url = new URL(transport);
    } catch {
      throw new Error(invalidRepositoryUrl);
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'ssh:')
      || url.hostname === ''
      || url.search !== ''
      || transport.includes('?')
      || (url.protocol === 'https:' && (url.username !== '' || url.password !== ''))
      || (url.protocol === 'ssh:' && hasSshPassword(transport, url))
    ) {
      throw new Error(invalidRepositoryUrl);
    }
  } else {
    const match = /^([^/@:\s]+)@([^/:\s]+):(.+)$/.exec(transport);
    if (match === null) throw new Error(invalidRepositoryUrl);
  }

  return { transport, revision };
}

function hasSshPassword(transport: string, url: URL): boolean {
  if (url.password !== '') return true;
  const authorityStart = transport.indexOf('://') + 3;
  const authorityEnd = transport.slice(authorityStart).search(/[/?#]/);
  const authority = authorityEnd === -1
    ? transport.slice(authorityStart)
    : transport.slice(authorityStart, authorityStart + authorityEnd);
  const userInfoEnd = authority.lastIndexOf('@');
  return userInfoEnd !== -1 && authority.slice(0, userInfoEnd).includes(':');
}

export function createRuleRepositoryCheckout(
  env: Readonly<Record<string, string | undefined>>,
): (selector: string) => Promise<RuleRepositoryCheckout | undefined> {
  const isolatedEnv = isolatedGitEnvironment(env);

  const runGit = (
    cwd: string,
    args: readonly string[],
    allowedExitCodes: readonly number[] = [0],
  ): Promise<{ readonly stdout: string; readonly code: number | null }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{
      readonly stdout: string;
      readonly code: number | null;
    }>();
    const child = spawn('git', [...args], {
      cwd,
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

  return async selector => {
    const parsed = parseRuleRepositorySelector(selector);
    if (parsed === undefined) return undefined;

    const workspace = await mkdtemp(join(await realpath(tmpdir()), 'coderuler-rules-'));
    const root = join(workspace, 'repository');
    const cleanup = (): Promise<void> => rm(workspace, { recursive: true, force: true });
    try {
      await runGit(workspace, ['init', root]);
      const worktree = await runGit(root, ['config', '--null', '--get-all', 'core.worktree'], [0, 1]);
      if (worktree.code === 0) {
        throw new Error('Rule repository checkout requires Git core.worktree to be unset; remove the inherited repository-location override.');
      }

      if (parsed.revision !== undefined) {
        if (
          parsed.revision.startsWith('+')
          && !parsed.revision.startsWith('refs/heads/+')
        ) {
          throw new Error('Invalid rule repository revision.');
        }
        const result = await runGit(root, [
          'check-ref-format',
          `refs/coderuler/${parsed.revision}`,
        ], [0, 1]);
        if (result.code !== 0) throw new Error('Invalid rule repository revision.');
      }

      await runGit(root, ['remote', 'add', 'origin', parsed.transport]);
      await runGit(root, [
        'fetch', '--depth=1', '--no-tags', '--', 'origin', `${parsed.revision ?? 'HEAD'}:`,
      ]);
      await runGit(root, ['checkout', '--detach', 'FETCH_HEAD']);
      return { root, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
}
