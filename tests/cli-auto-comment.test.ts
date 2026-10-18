import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { runProgram } from '../dist/adapter/cli/program.js';
import { createServices } from '../dist/infra/runtime.js';
import { createSandbox, writeFile, type Sandbox } from './support.ts';

const TOKEN = 'github-test-secret-pat';
const API_KEY = 'typesafe-test-secret-key';
const MESSAGE = `Reject **bold** <script> @someone ${TOKEN} ${API_KEY}\u001b[31m`;
const inheritedGithub = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('GITHUB_')).map(key => [key, undefined]));
const sandbox = createSandbox('rulekeeper-cli-auto-comment-', inheritedGithub);
after(() => sandbox.cleanup());

function git(target: Sandbox, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: target.cwd,
    env: { ...target.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface Fixture extends Sandbox {
  readonly base: string;
  readonly head: string;
}

const scoped = (check: string, options = '') => `import { Rule, pass, violation, regex } from '@alex-dbs/rulekeeper';
export default class FixtureRule extends Rule {
  files = ['src/*.txt'];
  scope = file => [{ id: '$', source: file.source, data: { private: 'DATA-SECRET' }, captures: { private: 'CAPTURE-SECRET' }, lines: { start: 2, end: 3 } }];
  ${options}
  check = ${check};
}
`;
const implicit = scoped(`subject => subject.source.includes('BAD') ? violation(${JSON.stringify(MESSAGE)}) : pass('PASS-MESSAGE')`);
const unlocatedGroup = scoped(`() => violation('unlocated group rejection')`, `group = 'folder';`);

function repository(label: string, rules: Readonly<Record<string, string>> = { scoped: implicit }, changed = true): Fixture {
  const target = sandbox.isolated(label);
  writeFile(join(target.cwd, '.gitignore'), 'node_modules/\n');
  for (const [name, source] of Object.entries(rules)) writeFile(join(target.cwd, `.rulekeeper/${name}.rule.ts`), source);
  for (const name of ['one', 'two', 'good']) writeFile(join(target.cwd, `src/${name}.txt`), 'HEADER\nGOOD SOURCE-SECRET\nGOOD SOURCE-SECRET\nFOOTER\n');
  git(target, 'init', '--initial-branch=feature/comments');
  git(target, 'config', 'user.name', 'Rulekeeper tests');
  git(target, 'config', 'user.email', 'tests@example.invalid');
  git(target, 'config', 'commit.gpgsign', 'false');
  git(target, 'remote', 'add', 'origin', 'git@github.com:owner/project.git');
  git(target, 'add', '--all');
  git(target, 'commit', '-m', 'base fixture');
  const base = git(target, 'rev-parse', 'HEAD');
  if (changed) {
    for (const name of ['one', 'two']) writeFile(join(target.cwd, `src/${name}.txt`), 'HEADER\nBAD SOURCE-SECRET\nBAD SOURCE-SECRET\nFOOTER\n');
    writeFile(join(target.cwd, 'src/good.txt'), 'HEADER\nGOOD changed SOURCE-SECRET\nGOOD SOURCE-SECRET\nFOOTER\n');
    git(target, 'add', '--all');
    git(target, 'commit', '-m', 'PR changes');
  }
  return { ...target, base, head: git(target, 'rev-parse', 'HEAD') };
}

async function check(target: Sandbox, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const services = {
    ...createServices(target.cwd, { ...target.env, GITHUB_TOKEN: TOKEN, TYPESAFE_API_KEY: API_KEY, ...env }),
    terminal: { color: true, interactive: false },
    write: (text: string) => { stdout.push(text); },
    writeError: (text: string) => { stderr.push(text); },
  };
  const status = await runProgram(['check', ...args], services);
  return { status, stdout: stdout.join(''), stderr: stderr.join('') };
}

interface RequestRecord {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly authorization: string | undefined;
}
interface Review {
  readonly commit_id: string;
  readonly event: string;
  readonly body: string;
  readonly comments: readonly {
    readonly path: string;
    readonly body: string;
    readonly line: number;
    readonly side: string;
    readonly start_line?: number;
    readonly start_side?: string;
  }[];
}

async function github(context: TestContext, target: Fixture, postStatus = 201) {
  const requests: RequestRecord[] = [];
  const files = ['one', 'two', 'good'].map(name => {
    const filename = `src/${name}.txt`;
    return {
      filename, status: 'modified', sha: git(target, 'hash-object', filename),
      patch: git(target, 'diff', '--no-ext-diff', '--no-color', '--unified=3', target.base, target.head, '--', filename),
    };
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = request.url ?? '';
    requests.push({ method: request.method ?? '', url, body: Buffer.concat(chunks).toString('utf8'), authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && url.startsWith('/repos/owner/project/pulls?')) {
      response.end(JSON.stringify([{ number: 42 }]));
    } else if (request.method === 'GET' && url.startsWith('/repos/owner/project/pulls/42/files?')) {
      response.end(JSON.stringify(files));
    } else if (request.method === 'GET' && url === '/repos/owner/project/pulls/42') {
      response.end(JSON.stringify({ head: { sha: target.head } }));
    } else if (request.method === 'POST' && ['/repos/owner/project/pulls/42/reviews', '/repos/owner/project/issues/42/comments'].includes(url)) {
      response.statusCode = postStatus;
      response.end(JSON.stringify(postStatus === 201 ? { id: 1 } : { message: `Rejected ${TOKEN} ${API_KEY}` }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: 'Unexpected fixture API request' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const fetch = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, 'https://api.github.com', 'all external HTTP must target the fixed GitHub API');
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  });
  return requests;
}

function posts(requests: readonly RequestRecord[]) {
  return requests.filter(request => request.method === 'POST');
}
function review(requests: readonly RequestRecord[]): Review {
  const matching = posts(requests).filter(request => request.url.endsWith('/reviews'));
  assert.equal(matching.length, 1);
  return JSON.parse(matching[0]!.body) as Review;
}
function fallback(requests: readonly RequestRecord[]): string {
  const matching = posts(requests).filter(request => request.url.endsWith('/issues/42/comments'));
  assert.equal(matching.length, 1);
  const payload = JSON.parse(matching[0]!.body) as { body: string };
  assert.deepEqual(Object.keys(payload), ['body']);
  assert.ok(payload.body.startsWith('## Rulekeeper violations\n'));
  return payload.body;
}

for (const diff of ['--diff', '--diff-only']) {
  test(`${diff} posts implicit scope ranges inline, redacts comments, and preserves raw JSON`, async context => {
    const target = repository('scoped');
    const requests = await github(context, target);
    const result = await check(target, [diff, '--base', target.base, '--auto-comment', '--json', '--output-all']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    const lookup = new URL(requests[0]!.url, 'https://api.github.com');
    assert.equal(lookup.pathname, '/repos/owner/project/pulls');
    assert.equal(lookup.searchParams.get('head'), 'owner:feature/comments');
    assert.equal(posts(requests).length, 1);
    assert.ok(requests.every(request => request.authorization === `Bearer ${TOKEN}`));
    assert.equal(requests.filter(request => request.url === '/repos/owner/project/pulls/42').length, 2, 'the PR head must be rechecked before posting');
    const payload = review(requests);
    assert.equal(payload.commit_id, target.head);
    assert.equal(payload.event, 'COMMENT');
    assert.ok(payload.body.length > 0);
    assert.deepEqual(payload.comments.map(({ path, line, side, start_line, start_side }) => ({ path, line, side, start_line, start_side })).sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'src/one.txt', line: 3, side: 'RIGHT', start_line: 2, start_side: 'RIGHT' },
      { path: 'src/two.txt', line: 3, side: 'RIGHT', start_line: 2, start_side: 'RIGHT' },
    ]);
    for (const comment of payload.comments) {
      assert.ok(comment.body.includes('scoped'));
      assert.ok(comment.body.includes('Reject \\*\\*bold\\*\\* &lt;script&gt;'));
      assert.ok(comment.body.includes('REDACTED'));
      assert.doesNotMatch(comment.body, /SOURCE-SECRET|DATA-SECRET|CAPTURE-SECRET|PASS-MESSAGE|\u001b|<script>|@someone/);
      assert.equal(comment.body.includes(TOKEN), false);
      assert.equal(comment.body.includes(API_KEY), false);
    }
    const report = JSON.parse(result.stdout).reports[0];
    assert.equal(report.evaluations.find((evaluation: { result: { status: string } }) => evaluation.result.status === 'violation').result.message, MESSAGE);
    assert.ok(result.stdout.includes(TOKEN));
    assert.ok(result.stdout.includes(API_KEY));
    assert.ok(result.stdout.includes('SOURCE-SECRET'));
  });
}

for (const kind of ['review', 'fallback']) {
  test(`${kind} comments redact credentials reconstructed by ANSI stripping while preserving raw JSON`, async context => {
    const token = 'supersecretgithubtoken';
    const apiKey = 'supersecrettypesafekey';
    const message = `Reject **bold** <script> @someone super\u001b[31msecretgithubtoken super\u001b[0msecrettypesafekey \u0007`;
    const source = scoped(`subject => subject.source.includes('BAD') ? violation(${JSON.stringify(message)}) : pass()`);
    const target = repository(`ansi-secrets-${kind}`, {
      scoped: kind === 'review' ? source : source.replace(', lines: { start: 2, end: 3 }', ''),
    });
    const requests = await github(context, target);
    const result = await check(target, ['--diff', '--base', target.base, '--auto-comment', '--json'], {
      GITHUB_TOKEN: token,
      TYPESAFE_API_KEY: apiKey,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(posts(requests).length, 1);
    for (const request of posts(requests)) {
      assert.equal(request.body.includes(token), false);
      assert.equal(request.body.includes(apiKey), false);
    }
    const bodies = kind === 'review'
      ? review(requests).comments.map(comment => comment.body)
      : [fallback(requests)];
    assert.ok(bodies.length > 0);
    for (const body of bodies) {
      assert.ok(body.includes('Reject \\*\\*bold\\*\\* &lt;script&gt; &#64;someone \\[REDACTED\\] \\[REDACTED\\]'));
      assert.ok(body.includes('\\\\u0007'));
      assert.doesNotMatch(body, /\u001b|\u0007|<script>|@someone/);
    }
    const report = JSON.parse(result.stdout).reports[0];
    assert.equal(report.evaluations.find((evaluation: { result: { status: string } }) => evaluation.result.status === 'violation').result.message, message);
  });
}

for (const grouping of ['folder', 'project']) {
  test(`${grouping} custom attribution posts only the explicitly blamed member`, async context => {
    const target = repository(grouping, {
      attributed: scoped(`subject => violation('${grouping} subset rejection', subject.members.filter(member => member.filepath === 'src/two.txt').map(member => ({ filepath: member.filepath, scopeId: member.id })))`, `group = '${grouping}';`),
    });
    const requests = await github(context, target);
    const result = await check(target, ['--diff', '--base', target.base, '--auto-comment', '--json']);
    assert.equal(result.status, 1, result.stderr);
    const payload = review(requests);
    assert.equal(posts(requests).length, 1);
    assert.deepEqual(payload.comments.map(comment => [comment.path, comment.start_line, comment.line]), [['src/two.txt', 2, 3]]);
    assert.ok(payload.comments[0]!.body.includes(`${grouping} subset rejection`));
    assert.ok(payload.comments[0]!.body.includes(grouping));
    assert.deepEqual(JSON.parse(result.stdout).reports[0].evaluations[0].result.locations, [{ filepath: 'src/two.txt', scopeId: '$', lines: { start: 2, end: 3 } }]);
  });
}

test('explicit line ranges narrow comments instead of using the whole subject', async context => {
  const target = repository('explicit-lines', {
    lines: scoped(`subject => subject.source.includes('BAD') ? violation('specific line', [{ filepath: subject.filepath, scopeId: subject.id, lines: { start: 3, end: 3 } }]) : pass()`),
  });
  const requests = await github(context, target);
  const result = await check(target, ['--diff', '--base', target.base, '--auto-comment']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(posts(requests).length, 1);
  for (const comment of review(requests).comments) {
    assert.equal(comment.line, 3);
    assert.equal(comment.side, 'RIGHT');
    assert.equal('start_line' in comment, false);
    assert.equal('start_side' in comment, false);
  }
});

test('grouped regex attributes only failing members without blaming passing files', async context => {
  const target = repository('regex-subset', {
    regex: scoped(`regex({ pattern: /GOOD/, input: member => member.source, violationMessage: 'regex rejection' })`, `group = 'project';`),
  });
  const requests = await github(context, target);
  const result = await check(target, ['--diff', '--base', target.base, '--auto-comment']);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(review(requests).comments.map(comment => comment.path).sort(), ['src/one.txt', 'src/two.txt']);
  assert.equal(posts(requests).length, 1);
});

test('mixed runs post anchored findings in a review and only unlocated findings in fallback', async context => {
  const target = repository('mixed', { scoped: implicit, grouped: unlocatedGroup });
  const requests = await github(context, target);
  const result = await check(target, ['--diff', '--base', target.base, '--auto-comment', '--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(posts(requests).length, 2);
  assert.equal(review(requests).comments.length, 2);
  const body = fallback(requests);
  assert.ok(body.includes('unlocated group rejection'));
  assert.ok(body.includes('folder'));
  assert.equal(body.includes('Reject'), false, 'anchored findings must not be duplicated in fallback');
  assert.equal(body.includes('SOURCE-SECRET'), false);
});

test('a group without attribution posts one fallback finding, not arbitrary member comments', async context => {
  const target = repository('unlocated-group', { grouped: unlocatedGroup });
  const requests = await github(context, target);
  const result = await check(target, ['--diff', '--base', target.base, '--auto-comment']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(posts(requests).length, 1);
  assert.equal(fallback(requests).split('unlocated group rejection').length - 1, 1);
});

for (const mode of ['no-lines', 'opt-out']) {
  test(`${mode} scopes fall back instead of inventing inline locations`, async context => {
    const source = mode === 'no-lines'
      ? implicit.replace(', lines: { start: 2, end: 3 }', '')
      : implicit.replace(`violation(${JSON.stringify(MESSAGE)})`, `violation(${JSON.stringify(MESSAGE)}, [])`);
    const target = repository(mode, { scoped: source });
    const requests = await github(context, target);
    const result = await check(target, ['--diff', '--base', target.base, '--auto-comment']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(posts(requests).length, 1);
    const body = fallback(requests);
    assert.equal(body.split('Reject').length - 1, 2);
    assert.equal(body.includes(TOKEN), false);
    assert.equal(body.includes(API_KEY), false);
  });
}

test('passing, empty-diff, default HEAD, and non-opted-in runs never contact GitHub or require a token', async context => {
  const target = repository('no-post');
  const requests = await github(context, target);
  assert.equal((await check(target, ['--diff', '--auto-comment'], { GITHUB_TOKEN: undefined })).status, 0, 'default base stays HEAD, not a guessed PR base');
  assert.equal((await check(target, ['--diff-only', '--base', target.head, '--auto-comment'], { GITHUB_TOKEN: undefined })).status, 0);
  const clean = repository('passing', { passing: scoped(`() => pass()`) });
  assert.equal((await check(clean, ['--diff', '--base', clean.base, '--auto-comment'], { GITHUB_TOKEN: undefined })).status, 0);
  assert.equal((await check(target, ['--diff', '--base', target.base], { GITHUB_TOKEN: undefined })).status, 1);
  assert.equal((await check(target, [], { GITHUB_TOKEN: undefined })).status, 1);
  assert.deepEqual(requests, []);
});

test('--auto-comment without a diff flag fails usage before running or contacting GitHub', async context => {
  const target = repository('invalid');
  const requests = await github(context, target);
  const result = await check(target, ['--auto-comment', '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--auto-comment requires --diff/);
  assert.deepEqual(requests, []);
});

for (const kind of ['review', 'fallback']) {
  test(`${kind} API failure exits 2, preserves raw JSON, and redacts diagnostics without retrying`, async context => {
    const target = repository(`api-failure-${kind}`, kind === 'review' ? { scoped: implicit } : { grouped: unlocatedGroup });
    const requests = await github(context, target, 403);
    const args = ['--diff', '--base', target.base, '--json'];
    const baseline = await check(target, args);
    const result = await check(target, [...args, '--auto-comment']);
    assert.equal(baseline.status, 1, baseline.stderr);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /403/);
    const stable = (text: string) => JSON.parse(text).reports.map(({ durationMs: _duration, ...report }: Record<string, unknown>) => report);
    assert.deepEqual(stable(result.stdout), stable(baseline.stdout));
    assert.equal(posts(requests).length, 1, 'posting failures must not retry or fall back');
    assert.equal(posts(requests)[0]!.url, kind === 'review' ? '/repos/owner/project/pulls/42/reviews' : '/repos/owner/project/issues/42/comments');
    assert.equal(`${result.stderr}${posts(requests)[0]!.body}`.includes(TOKEN), false);
    assert.equal(`${result.stderr}${posts(requests)[0]!.body}`.includes(API_KEY), false);
    if (kind === 'review') assert.ok(result.stdout.includes(TOKEN));
  });
}

test('missing GITHUB_TOKEN fails only after a violating opted-in run', async context => {
  const target = repository('missing-token');
  const requests = await github(context, target);
  const result = await check(target, ['--diff-only', '--base', target.base, '--auto-comment', '--json'], { GITHUB_TOKEN: undefined });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GITHUB_TOKEN/);
  assert.equal(JSON.parse(result.stdout).reports[0].status, 'violation');
  assert.deepEqual(requests, []);
});
