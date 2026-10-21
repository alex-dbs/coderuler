import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { createGithubCommenter } from '../dist/adapter/github/comments.js';
import { createSandbox, writeFile } from './support.ts';

const sandboxes = createSandbox('rulekeeper-github-comments-', {
  GITHUB_TOKEN: undefined,
  GITHUB_REPOSITORY: undefined,
  GITHUB_REF: undefined,
  GITHUB_EVENT_PATH: undefined,
});
after(() => sandboxes.cleanup());
const token = 'github_pat_test-secret';
const body = '**memory**: app.yml:4-7 — limit is too high';
const head = 'a'.repeat(40);
const fallback = [{ body, locations: [] }];
const detail = { body: { head: { sha: head } } };
const posted = { status: 201, body: {} };
const summary = (bodies: readonly string[]) => ({ body: `## Rulekeeper violations\n\n${bodies.join('\n\n')}\n` });

function repository(origin = 'https://github.com/example/project.git') {
  const sandbox = sandboxes.isolated('repository');
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: sandbox.cwd,
    env: sandbox.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet', '--initial-branch=feature/comment');
  git('config', 'user.name', 'Rulekeeper Tests');
  git('config', 'user.email', 'rulekeeper@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', 'package.json');
  git('commit', '--quiet', '-m', 'base');
  git('remote', 'add', 'origin', origin);
  return { ...sandbox, git };
}

interface SourceRepository {
  readonly cwd: string;
  git(...args: string[]): string;
}

function source(repo: SourceRepository, filepath = 'app.yml', text = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n') {
  writeFile(join(repo.cwd, filepath), text);
  repo.git('add', '--', filepath);
  repo.git('commit', '--quiet', '-m', filepath);
  const bytes = Buffer.from(text);
  return { filename: filepath, status: 'modified', sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), patch: '@@ -1,8 +1,8 @@\n one\n two\n three\n-four old\n+four\n+five\n-five old\n six\n seven\n eight' };
}

function actions(env: Readonly<Record<string, string | undefined>>) {
  return createGithubCommenter({ ...env, GITHUB_TOKEN: token, GITHUB_REPOSITORY: 'example/project', GITHUB_REF: 'refs/pull/23/head' });
}

interface Request {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
interface Reply {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

async function github(t: TestContext, replies: readonly Reply[], transport?: { origin: string }) {
  const requests: Request[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method!, path: request.url!, headers: request.headers, body });
    const reply = replies[requests.length - 1] ?? { status: 500, body: { message: 'Unexpected request' } };
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  if (transport) transport.origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(input instanceof globalThis.Request ? input.url : input);
    assert.equal(url.origin, 'https://api.github.com', 'all requests must use the fixed GitHub API origin');
    assert.equal(init?.redirect, 'manual');
    return originalFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  });
  return requests;
}

function assertSafeError(error: unknown, expected: RegExp): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, expected);
  assert.ok(!error.stack?.includes(token), 'error must never expose the GitHub token');
  assert.equal(error.cause, undefined, 'raw network errors must not be attached');
  return true;
}

function payload(request: Request) { return JSON.parse(request.body) as unknown; }

function inline(path: string, line: number, start?: number, text = body) {
  return { path, body: text, line, side: 'RIGHT', ...(start === undefined ? {} : { start_line: start, start_side: 'RIGHT' }) };
}

test('empty findings do not require credentials, Git, or HTTP', async t => {
  const requests = await github(t, []);
  await createGithubCommenter({})('/does/not/exist', []);
  assert.deepEqual(requests, []);
});

test('local HTTPS and SSH origins discover one open PR and post only unlocatable findings', async t => {
  for (const origin of ['https://github.com/example/project.git', 'git@github.com:example/project.git', 'ssh://git@github.com/example/project.git', 'ssh://git@github.com:22/example/project.git']) {
    await t.test(origin, async t => {
      const repo = repository(origin);
      const requests = await github(t, [{ body: [{ number: 23 }] }, detail, { body: [] }, detail, posted]);
      await createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, fallback);
      assert.deepEqual(requests.map(request => [request.method, request.path]), [
        ['GET', '/repos/example/project/pulls?state=open&head=example%3Afeature%2Fcomment&per_page=2'],
        ['GET', '/repos/example/project/pulls/23'],
        ['GET', '/repos/example/project/pulls/23/files?per_page=100&page=1'],
        ['GET', '/repos/example/project/pulls/23'],
        ['POST', '/repos/example/project/issues/23/comments'],
      ]);
      assert.deepEqual(payload(requests[4]!), summary([body]));
      for (const request of requests) {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        assert.equal(request.headers.accept, 'application/vnd.github+json');
        assert.equal(request.headers['x-github-api-version'], '2022-11-28');
      }
      assert.equal(requests[4]!.headers['content-type'], 'application/json');
    });
  }
});

test('Actions refs and pull_request_target resolve the base PR without local Git', async t => {
  for (const suffix of ['merge', 'head', 'event']) {
    await t.test(suffix, async t => {
      const sandbox = sandboxes.isolated(`actions-${suffix}`);
      const event = writeFile(join(sandbox.root, 'event.json'), JSON.stringify({
        repository: { full_name: 'wrong/project' },
        pull_request: { number: 41, base: { repo: { full_name: 'base/project' } }, head: { repo: { full_name: 'fork/project' } } },
      }));
      const requests = await github(t, [detail, { body: [] }, detail, posted]);
      await createGithubCommenter({ ...sandbox.env, GITHUB_TOKEN: token, GITHUB_REPOSITORY: suffix === 'event' ? 'wrong/project' : 'base/project', GITHUB_REF: suffix === 'event' ? 'refs/heads/main' : `refs/pull/41/${suffix}`, ...(suffix === 'event' ? { GITHUB_EVENT_PATH: event } : {}) })(sandbox.cwd, fallback);
      assert.deepEqual(requests.map(request => request.path), ['/repos/base/project/pulls/41', '/repos/base/project/pulls/41/files?per_page=100&page=1', '/repos/base/project/pulls/41', '/repos/base/project/issues/41/comments']);
      assert.deepEqual(payload(requests[3]!), summary([body]));
    });
  }
});

test('explicit PR target supports detached HEAD and overrides unrelated Actions identity', async t => {
  const repo = repository();
  const file = source(repo);
  repo.git('checkout', '--quiet', '--detach');
  const requests = await github(t, [detail, { body: [file] }, detail, posted]);
  await createGithubCommenter({
    ...repo.env,
    GITHUB_TOKEN: token,
    GITHUB_REPOSITORY: 'unrelated/project',
    GITHUB_REF: 'refs/pull/99/merge',
    GITHUB_EVENT_PATH: join(repo.root, 'missing-event.json'),
  })(repo.cwd, [{ body, locations: [{ filepath: 'app.yml', lines: { start: 4, end: 5 } }] }], {
    repository: 'requested/project', number: 42, head,
  });
  assert.deepEqual(requests.map(request => [request.method, request.path]), [
    ['GET', '/repos/requested/project/pulls/42'],
    ['GET', '/repos/requested/project/pulls/42/files?per_page=100&page=1'],
    ['GET', '/repos/requested/project/pulls/42'],
    ['POST', '/repos/requested/project/pulls/42/reviews'],
  ]);
  assert.deepEqual(payload(requests[3]!), {
    commit_id: head, event: 'COMMENT', body: 'Rulekeeper violations', comments: [inline('app.yml', 5, 4)],
  });
});

test('explicit target matches inline files despite inherited Git repository locations', async t => {
  const caller = repository();
  const repo = repository();
  const file = source(repo);
  repo.git('checkout', '--quiet', '--detach');
  const callerHead = caller.git('rev-parse', 'HEAD');
  const callerIndex = caller.git('write-tree');
  const callerStatus = caller.git('status', '--porcelain');
  const transport = { origin: '' };
  const requests = await github(t, [detail, { body: [file] }, detail, posted], transport);
  const script = `
    import { createGithubCommenter } from ${JSON.stringify(new URL('../dist/adapter/github/comments.js', import.meta.url).href)};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input);
      if (url.origin !== 'https://api.github.com' || init.redirect !== 'manual') throw new Error('Unsafe API request');
      return originalFetch(${JSON.stringify(transport.origin)} + url.pathname + url.search, init);
    };
    await createGithubCommenter(process.env)(process.cwd(), ${JSON.stringify([
      { body, locations: [{ filepath: 'app.yml', lines: { start: 4, end: 5 } }] },
    ])}, { repository: 'requested/project', number: 42 });
  `;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repo.cwd,
    env: {
      ...repo.env,
      GITHUB_TOKEN: token,
      GIT_DIR: join(caller.cwd, '.git'),
      GIT_COMMON_DIR: join(caller.cwd, '.git'),
      GIT_WORK_TREE: caller.cwd,
      GIT_INDEX_FILE: join(caller.cwd, '.git/index'),
    },
  }, (error, _stdout, stderr) => {
    if (error) reject(new Error(stderr || error.message, { cause: error }));
    else resolve();
  });
  await promise;
  assert.deepEqual(requests.map(request => [request.method, request.path]), [
    ['GET', '/repos/requested/project/pulls/42'],
    ['GET', '/repos/requested/project/pulls/42/files?per_page=100&page=1'],
    ['GET', '/repos/requested/project/pulls/42'],
    ['POST', '/repos/requested/project/pulls/42/reviews'],
  ]);
  assert.deepEqual(payload(requests[3]!), {
    commit_id: head, event: 'COMMENT', body: 'Rulekeeper violations', comments: [inline('app.yml', 5, 4)],
  });
  assert.equal(caller.git('rev-parse', 'HEAD'), callerHead);
  assert.equal(caller.git('write-tree'), callerIndex);
  assert.equal(caller.git('status', '--porcelain'), callerStatus);
});

test('nested invocation roots map rename targets and prefer RIGHT additions despite deletions', async t => {
  const repo = repository();
  const file = source(repo, 'packages/app/new.yml');
  const requests = await github(t, [detail, { body: [{ ...file, status: 'renamed', previous_filename: 'old.yml' }] }, detail, posted]);
  await actions(repo.env)(join(repo.cwd, 'packages/app'), [{ body, locations: [
    { filepath: 'new.yml', lines: { start: 2, end: 7 } },
    { filepath: './new.yml', lines: { start: 4, end: 5 } },
  ] }]);
  assert.deepEqual(requests.map(request => [request.method, request.path]), [
    ['GET', '/repos/example/project/pulls/23'], ['GET', '/repos/example/project/pulls/23/files?per_page=100&page=1'],
    ['GET', '/repos/example/project/pulls/23'], ['POST', '/repos/example/project/pulls/23/reviews'],
  ]);
  assert.deepEqual(payload(requests[3]!), { commit_id: head, event: 'COMMENT', body: 'Rulekeeper violations', comments: [inline('packages/app/new.yml', 5, 4)] });
});

test('multiple hunks, optional header counts, no-newline markers and context anchors stay in one hunk', async t => {
  const repo = repository();
  const file = source(repo);
  const patch = '@@ -1,2 +1,2 @@ heading\n one\n-two old\n+two\n\\ No newline at end of file\n@@ -5,2 +5,2 @@\n five\n six\n@@ -8 +8 @@\n-eight old\n+eight';
  const requests = await github(t, [detail, { body: [{ ...file, patch }] }, detail, posted]);
  await actions(repo.env)(repo.cwd, [{ body, locations: [
    { filepath: 'app.yml', lines: { start: 1, end: 8 } },
    { filepath: 'app.yml', lines: { start: 5, end: 7 } },
    { filepath: 'app.yml', lines: { start: 8, end: 8 } },
  ] }]);
  assert.deepEqual(payload(requests[3]!), { commit_id: head, event: 'COMMENT', body: 'Rulekeeper violations', comments: [inline('app.yml', 2), inline('app.yml', 6, 5), inline('app.yml', 8)] });
});

test('mixed groups use only explicit usable candidates and fallback never duplicates anchored findings', async t => {
  const repo = repository();
  const file = source(repo);
  const requests = await github(t, [detail, { body: [file] }, detail, posted, posted]);
  await actions(repo.env)(repo.cwd, [
    { body: 'folder: selected member', locations: [{ filepath: 'app.yml', lines: { start: 4, end: 4 } }, { filepath: 'missing.yml', lines: { start: 1, end: 1 } }] },
    { body: 'project: no attribution', locations: [] },
    { body: 'scope: no usable hunk', locations: [{ filepath: 'app.yml', lines: { start: 99, end: 100 } }] },
  ]);
  assert.deepEqual(payload(requests[3]!), { commit_id: head, event: 'COMMENT', body: 'Rulekeeper violations', comments: [inline('app.yml', 4, undefined, 'folder: selected member')] });
  assert.deepEqual(payload(requests[4]!), summary(['project: no attribution', 'scope: no usable hunk']));
});

test('unmatched source never gets inline coordinates: dirty, unpushed, untracked, absent, outside root', async t => {
  for (const kind of ['dirty', 'unpushed', 'untracked', 'missing', 'outside']) {
    await t.test(kind, async t => {
      const repo = repository();
      const file = source(repo);
      let filepath = 'app.yml';
      if (kind === 'dirty' || kind === 'unpushed') {
        writeFile(join(repo.cwd, filepath), 'changed\n');
        if (kind === 'unpushed') { repo.git('add', filepath); repo.git('commit', '--quiet', '-m', 'unpushed'); }
      } else if (kind === 'untracked') {
        repo.git('rm', '--cached', '--', filepath);
      } else if (kind === 'missing') {
        filepath = 'absent.yml';
      } else {
        filepath = '../outside.yml';
        writeFile(join(repo.cwd, filepath), 'one\n');
      }
      const requests = await github(t, [detail, { body: [{ ...file, filename: kind === 'missing' ? filepath : file.filename }] }, detail, posted]);
      await actions(repo.env)(repo.cwd, [{ body, locations: [{ filepath, lines: { start: 1, end: 1 } }] }]);
      assert.equal(requests.length, 4);
      assert.equal(requests[3]!.path, '/repos/example/project/issues/23/comments');
      assert.deepEqual(payload(requests[3]!), summary([body]));
    });
  }
});

test('removed, missing patch, deletion-only, malformed and nonoverlapping hunks fall back', async t => {
  for (const change of [
    { status: 'removed' }, { patch: undefined }, { patch: '@@ -1,2 +0,0 @@\n-one\n-two' },
    { patch: '@@ -1,2 +1,2 @@\n+one' }, { patch: '@@ -10 +10 @@\n ten' },
  ]) {
    await t.test(JSON.stringify(change), async t => {
      const repo = repository();
      const file = source(repo);
      const requests = await github(t, [detail, { body: [{ ...file, ...change }] }, detail, posted]);
      await actions(repo.env)(repo.cwd, [{ body, locations: [{ filepath: 'app.yml', lines: { start: 1, end: 2 } }] }]);
      assert.equal(requests[3]!.path, '/repos/example/project/issues/23/comments');
    });
  }
});

test('blob identity hashes UTF-8 bytes and literal Git paths, not JavaScript string length', async t => {
  const repo = repository();
  const filename = '[special] λ.yml';
  const text = 'λ\n第二行\n';
  writeFile(join(repo.cwd, filename), text);
  repo.git('add', '--', filename);
  repo.git('commit', '--quiet', '-m', 'unicode');
  const file = { filename, status: 'added', sha: repo.git('hash-object', '--', filename), patch: '@@ -0,0 +1,2 @@\n+λ\n+第二行\n' };
  const requests = await github(t, [detail, { body: [file] }, detail, posted]);
  await actions(repo.env)(repo.cwd, [{ body, locations: [{ filepath: filename, lines: { start: 1, end: 2 } }] }]);
  assert.deepEqual(payload(requests[3]!), { commit_id: head, event: 'COMMENT', body: 'Rulekeeper violations', comments: [inline(filename, 2, 1)] });
});

test('Actions checkout without usable Git metadata falls back even when a file exists', async t => {
  const sandbox = sandboxes.isolated('not-a-git-repo');
  writeFile(join(sandbox.cwd, 'app.yml'), 'one\n');
  const bytes = Buffer.from('one\n');
  const file = { filename: 'app.yml', status: 'added', sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), patch: '@@ -0,0 +1 @@\n+one' };
  const requests = await github(t, [detail, { body: [file] }, detail, posted]);
  await actions(sandbox.env)(sandbox.cwd, [{ body, locations: [{ filepath: 'app.yml', lines: { start: 1, end: 1 } }] }]);
  assert.equal(requests[3]!.path, '/repos/example/project/issues/23/comments');
  assert.deepEqual(payload(requests[3]!), summary([body]));
});

test('file pagination finds later files without following arbitrary Link URLs', async t => {
  const repo = repository();
  const file = source(repo);
  const page = Array.from({ length: 100 }, (_, index) => ({ filename: `other-${index}`, status: 'modified', sha: file.sha }));
  const requests = await github(t, [detail, { body: page, headers: { link: '<https://evil.test/steal>; rel="next"' } }, { body: [file] }, detail, posted]);
  await actions(repo.env)(repo.cwd, [{ body, locations: [{ filepath: 'app.yml', lines: { start: 4, end: 4 } }] }]);
  assert.equal(requests[2]!.path, '/repos/example/project/pulls/23/files?per_page=100&page=2');
  assert.equal(requests[4]!.path, '/repos/example/project/pulls/23/reviews');
});

test('pagination stops at GitHub 3000-file cap and unmatched findings fall back', async t => {
  const repo = repository();
  const page = Array.from({ length: 100 }, (_, index) => ({ filename: `other-${index}`, status: 'modified', sha: head }));
  const requests = await github(t, [detail, ...Array.from({ length: 30 }, () => ({ body: page })), detail, posted]);
  await actions(repo.env)(repo.cwd, fallback);
  assert.equal(requests.length, 33);
  assert.equal(requests[30]!.path, '/repos/example/project/pulls/23/files?per_page=100&page=30');
  assert.equal(requests[32]!.method, 'POST');
});

test('inline reviews batch at 100, and distinct findings are not collapsed', async t => {
  const repo = repository();
  const file = source(repo);
  const requests = await github(t, [detail, { body: [file] }, detail, posted, posted]);
  await actions(repo.env)(repo.cwd, Array.from({ length: 101 }, (_, index) => ({ body: `finding ${index}`, locations: [{ filepath: 'app.yml', lines: { start: 4, end: 4 } }] })));
  const first = payload(requests[3]!) as { comments: unknown[] };
  const second = payload(requests[4]!) as { comments: unknown[] };
  assert.equal(first.comments.length, 100);
  assert.equal(second.comments.length, 1);
  assert.deepEqual(second.comments, [inline('app.yml', 4, undefined, 'finding 100')]);
});

test('head movement aborts all posting, including fallback', async t => {
  const repo = repository();
  const file = source(repo);
  const requests = await github(t, [detail, { body: [file] }, { body: { head: { sha: 'b'.repeat(40) } } }]);
  await assert.rejects(actions(repo.env)(repo.cwd, [{ body, locations: [{ filepath: 'app.yml', lines: { start: 4, end: 4 } }] }, ...fallback]), /head.*changed|head.*moved/i);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'GET', 'GET']);
});

test('analyzed PR revision rejects stale context anchors and summary findings before planning', async t => {
  for (const located of [true, false]) {
    await t.test(located ? 'unchanged context anchor' : 'summary-only group', async t => {
      const repo = repository();
      source(repo);
      const requests = await github(t, [{ body: { head: { sha: 'b'.repeat(40) } } }]);
      await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, [{
        body,
        locations: located ? [{ filepath: 'app.yml', lines: { start: 1, end: 1 } }] : [],
      }], { repository: 'example/project', number: 23, head }), error => assertSafeError(error, /head.*changed.*analysis/i));
      assert.deepEqual(requests.map(request => [request.method, request.path]), [['GET', '/repos/example/project/pulls/23']]);
    });
  }
});

test('summary-only planning rechecks the head with and without an analyzed revision', async t => {
  for (const expected of [true, false]) {
    await t.test(expected ? 'checkout revision' : 'local diff identity', async t => {
      const repo = repository();
      const file = source(repo);
      const requests = await github(t, [detail, { body: [{ ...file, sha: 'c'.repeat(40) }] }, { body: { head: { sha: 'b'.repeat(40) } } }]);
      await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, [{
        body,
        locations: [{ filepath: 'app.yml', lines: { start: 4, end: 4 } }],
      }], { repository: 'example/project', number: 23, ...(expected ? { head } : {}) }), error => assertSafeError(error, /head.*changed.*planning/i));
      assert.deepEqual(requests.map(request => request.method), ['GET', 'GET', 'GET']);
    });
  }
});

test('local discovery refuses missing and ambiguous PRs without posting', async t => {
  for (const [pulls, expected] of [[[], /no open pull request/i], [[{ number: 1 }, { number: 2 }], /multiple|ambiguous/i]] as const) {
    await t.test(String(pulls.length), async t => {
      const repo = repository();
      const requests = await github(t, [{ body: pulls }]);
      await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, fallback), error => assertSafeError(error, expected));
      assert.deepEqual(requests.map(request => request.method), ['GET']);
    });
  }
});

test('unsupported origins and detached HEAD fail before HTTP', async t => {
  const requests = await github(t, []);
  for (const origin of ['https://gitlab.com/example/project.git', 'git@github.example:example/project.git', 'https://github.com.evil.test/example/project.git']) {
    const repo = repository(origin);
    await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, fallback), error => assertSafeError(error, /github\.com/i));
  }
  const repo = repository();
  repo.git('checkout', '--quiet', '--detach');
  await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, fallback), error => assertSafeError(error, /detached HEAD|current branch/i));
  assert.deepEqual(requests, []);
});

test('credentials and valid Actions event identity are required for nonempty findings', async t => {
  const requests = await github(t, []);
  const sandbox = sandboxes.isolated('invalid-event');
  await assert.rejects(createGithubCommenter(sandbox.env)(sandbox.cwd, fallback), /GITHUB_TOKEN.*required|required.*GITHUB_TOKEN/i);
  for (const contents of ['not json', '{}', JSON.stringify({ pull_request: { number: -1, base: { repo: { full_name: 'base/project' } } } })]) {
    const event = writeFile(join(sandbox.root, 'event.json'), contents);
    await assert.rejects(createGithubCommenter({ ...sandbox.env, GITHUB_TOKEN: token, GITHUB_EVENT_PATH: event })(sandbox.cwd, fallback), /event|pull request/i);
  }
  await assert.rejects(createGithubCommenter({ ...sandbox.env, GITHUB_TOKEN: token, GITHUB_REF: 'refs/pull/1/merge', GITHUB_REPOSITORY: 'example/../../evil' })(sandbox.cwd, fallback), /repository/i);
  assert.deepEqual(requests, []);
});

test('all HTTP failure stages are safe, do not retry and never replace a failed review with fallback', async t => {
  for (const stage of ['discovery', 'head', 'files', 'recheck', 'review', 'fallback']) {
    await t.test(stage, async t => {
      const repo = repository();
      const file = source(repo);
      const replies: Reply[] = stage === 'discovery' ? [] : [{ body: [{ number: 23 }] }];
      if (!['discovery', 'head'].includes(stage)) replies.push(detail);
      if (!['discovery', 'head', 'files'].includes(stage)) replies.push({ body: stage === 'fallback' ? [] : [file] });
      if (['review', 'fallback'].includes(stage)) replies.push(detail);
      replies.push({ status: 403, body: { message: `credential ${token} denied` } });
      const requests = await github(t, replies);
      const findings = stage === 'fallback' ? fallback : [{ body, locations: [{ filepath: 'app.yml', lines: { start: 4, end: 4 } }] }, ...fallback];
      await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, findings), error => assertSafeError(error, /GitHub.*403.*permission/i));
      assert.equal(requests.length, replies.length);
      assert.equal(requests.filter(request => request.method === 'POST').length, ['review', 'fallback'].includes(stage) ? 1 : 0);
    });
  }
});

test('redirect responses are not followed with credentials', async t => {
  const repo = repository();
  const requests = await github(t, [{ status: 302, headers: { location: 'https://evil.test/steal' }, body: {} }]);
  await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, fallback), /GitHub.*302/i);
  assert.equal(requests.length, 1);
});

test('network and malformed API responses fail without disclosing raw data', async t => {
  const repo = repository();
  await t.test('network', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error(`network failure with ${token}`); });
    await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, fallback), error => assertSafeError(error, /GitHub.*network|GitHub.*request/i));
  });
  for (const [stage, replies] of [
    ['discovery', [{ body: { message: token } }]],
    ['head', [{ body: [{ number: 23 }] }, { body: { head: { sha: token } } }]],
    ['files', [{ body: [{ number: 23 }] }, detail, { body: { message: token } }]],
  ] as const) {
    await t.test(stage, async t => {
      const requests = await github(t, replies);
      await assert.rejects(createGithubCommenter({ ...repo.env, GITHUB_TOKEN: token })(repo.cwd, fallback), error => assertSafeError(error, /GitHub.*response/i));
      assert.equal(requests.length, replies.length);
    });
  }
});
