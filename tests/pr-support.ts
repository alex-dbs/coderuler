import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { writeFile, type Sandbox, type SandboxRoot } from './support.ts';

export const PR_REPOSITORY = 'owner/project';
export const PR_NUMBER = 42;
export const PR_URL = `https://github.com/${PR_REPOSITORY}/pull/${PR_NUMBER}`;
export const PR_TOKEN = 'github-pr-fixture-secret';
export const BASE_MESSAGE = 'Committed main policy rejects BAD';
export const GLOBAL_MESSAGE = 'Global policy rejects BAD';

export interface PrFixture extends Sandbox {
  readonly remote: string;
  readonly temporary: string;
  readonly base: string;
  readonly main: string;
  readonly release: string;
  readonly head: string;
}

export function git(target: Sandbox, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: target.cwd,
    env: target.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function commit(target: Sandbox, message: string): string {
  git(target, 'add', '--all');
  git(target, 'commit', '-m', message);
  return git(target, 'rev-parse', 'HEAD');
}

export function policy(check: string, imports = '', fields = ''): string {
  return `import { Rule, pass, violation } from '@alex-dbs/coderuler';
${imports}
export default class FixturePolicy extends Rule {
  files = ['src/*.txt'];
${fields === '' ? '' : `  ${fields}\n`}  check = ${check};
}
`;
}

// Every Git operation is real. Only transport is redirected, and only after the
// checkout adapter initializes its own temporary head repository.
export function createPrFixture(sandbox: SandboxRoot, label: string): PrFixture {
  const isolated = sandbox.isolated(label);
  const temporary = join(isolated.root, 'tmp');
  mkdirSync(temporary, { recursive: true });
  const inheritedGit = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('GIT_')).map(key => [key, undefined]));
  const inheritedGithub = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('GITHUB_')).map(key => [key, undefined]));
  const globalConfig = join(isolated.home, '.gitconfig');
  const target: Sandbox = {
    ...isolated,
    env: {
      ...isolated.env,
      ...inheritedGit,
      ...inheritedGithub,
      TMPDIR: temporary,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfig,
      GITHUB_TOKEN: PR_TOKEN,
    },
  };
  const remote = join(target.root, 'remote.git');
  const transportConfig = join(target.home, 'temporary-checkout.gitconfig');
  writeFile(globalConfig, `[includeIf "gitdir:**/coderuler-pr-*/head/.git"]\n\tpath = ${JSON.stringify(transportConfig)}\n`);
  writeFile(transportConfig, `[url ${JSON.stringify(remote)}]\n\tinsteadOf = https://github.com/${PR_REPOSITORY}.git\n\tinsteadOf = git@github.com:${PR_REPOSITORY}.git\n`);

  writeFile(join(target.cwd, '.gitignore'), 'node_modules/\n');
  writeFile(join(target.cwd, 'src/changed.txt'), 'GOOD before the PR\n');
  writeFile(join(target.cwd, 'src/unchanged.txt'), 'BAD unchanged on the PR\n');
  writeFile(join(target.cwd, 'policy/helper.ts'), `export const message = 'Common ancestor policy';\n`);
  writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(`() => pass('Weak common ancestor policy')`));
  git(target, 'init', '--initial-branch=main');
  git(target, 'config', 'user.name', 'CodeRuler tests');
  git(target, 'config', 'user.email', 'tests@example.invalid');
  git(target, 'config', 'commit.gpgsign', 'false');
  const base = commit(target, 'common ancestor');

  git(target, 'checkout', '-b', 'release');
  writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(`subject => subject.source.includes('BAD') ? violation('Committed release policy rejects BAD') : pass()`));
  const release = commit(target, 'release policy');

  git(target, 'checkout', 'main');
  writeFile(join(target.cwd, 'policy/helper.ts'), `export const message = ${JSON.stringify(BASE_MESSAGE)};\n`);
  writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(
    `subject => subject.source.includes('BAD') ? violation(message) : pass()`,
    `import { message } from '../policy/helper.ts';`,
  ));
  writeFile(join(target.cwd, 'src/base-only.txt'), 'BAD added only on main\n');
  // Comparing directly with the main tip would wrongly include this unchanged
  // PR file. The changed-file set must instead use main's merge-base with head.
  writeFile(join(target.cwd, 'src/unchanged.txt'), 'BAD independently changed on main\n');
  const main = commit(target, 'advance main with trusted policy and independent source edits');

  git(target, 'checkout', '-b', 'feature/pr-fixture', base);
  writeFile(join(target.cwd, 'src/changed.txt'), 'BAD changed by the PR\n');
  writeFile(join(target.cwd, 'policy/helper.ts'), `export const message = 'UNTRUSTED PR-head helper';\n`);
  writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(`() => pass('Weakened PR-head policy')`));
  writeFile(join(target.cwd, '.coderuler/head-only.rule.ts'), `throw new Error('PR-head policy must never execute');\n`);
  const head = commit(target, 'PR changes and untrusted policy');

  git(target, 'init', '--bare', remote);
  git(target, 'push', remote, 'main:refs/heads/main', 'release:refs/heads/release', `${head}:refs/pull/${PR_NUMBER}/head`);
  git(target, 'remote', 'add', 'origin', `git@github.com:${PR_REPOSITORY}.git`);
  writeFile(join(target.cwd, '.coderuler/base.rule.ts'), `throw new Error('Dirty caller policy must never execute');\n`);
  writeFile(join(target.cwd, '.coderuler/caller-only.rule.ts'), `throw new Error('Caller-only policy must never execute');\n`);
  writeFile(join(target.home, '.coderuler/global.rule.ts'), policy(`subject => subject.source.includes('BAD') ? violation(${JSON.stringify(GLOBAL_MESSAGE)}) : pass()`));
  return { ...target, remote, temporary, base, main, release, head };
}

export interface RequestRecord {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly authorization: string | undefined;
}

export interface GithubFixtureOptions {
  readonly metadata?: unknown;
  readonly metadataStatus?: number;
  readonly postStatus?: number;
}

// The standalone server also supports a built-CLI child with a fetch preload;
// tests running services in-process can use interceptGithub below instead.
export async function startGithubFixture(target: PrFixture, options: GithubFixtureOptions = {}) {
  const requests: RequestRecord[] = [];
  const changed = git(target, 'diff', '--name-only', '--diff-filter=AM', target.base, target.head, '--', 'src');
  const files = (changed === '' ? [] : changed.split('\n')).map(filename => ({
    filename,
    status: 'modified',
    sha: git(target, 'rev-parse', `${target.head}:${filename}`),
    patch: git(target, 'diff', '--no-ext-diff', '--no-color', '--unified=3', target.base, target.head, '--', filename),
  }));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = request.url ?? '';
    requests.push({ method: request.method ?? '', url, body: Buffer.concat(chunks).toString('utf8'), authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    const pull = `/repos/${PR_REPOSITORY}/pulls/${PR_NUMBER}`;
    if (request.method === 'GET' && url === pull) {
      response.statusCode = options.metadataStatus ?? 200;
      response.end(JSON.stringify(options.metadata ?? { base: { ref: 'main' }, head: { sha: target.head } }));
    } else if (request.method === 'GET' && url.startsWith(`${pull}/files?`)) {
      response.end(JSON.stringify(files));
    } else if (request.method === 'GET' && url.startsWith(`/repos/${PR_REPOSITORY}/pulls?`)) {
      response.end(JSON.stringify([{ number: PR_NUMBER }]));
    } else if (request.method === 'POST' && [
      `${pull}/reviews`, `/repos/${PR_REPOSITORY}/issues/${PR_NUMBER}/comments`,
    ].includes(url)) {
      response.statusCode = options.postStatus ?? 201;
      response.end(JSON.stringify(response.statusCode === 201 ? { id: 1 } : { message: 'Fixture rejected comment' }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: 'Unexpected fixture API request' }));
    }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return {
    requests,
    origin: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      const closed = Promise.withResolvers<void>();
      server.close(error => error === undefined ? closed.resolve() : closed.reject(error));
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

export async function interceptGithub(context: TestContext, target: PrFixture, options: GithubFixtureOptions = {}) {
  const api = await startGithubFixture(target, options);
  context.after(() => api.close());
  const fetch = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, 'https://api.github.com', 'all external HTTP must target the fixed GitHub API');
    return fetch(`${api.origin}${url.pathname}${url.search}`, init);
  });
  return api.requests;
}
