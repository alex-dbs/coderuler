import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { runProgram } from '../dist/adapter/cli/program.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';
import { createServices } from '../dist/infra/runtime.js';
import {
  createDependencyFixture,
  dependencyFixtureEnvironment,
  POLICY_MESSAGE_V1,
  type RegistryRequest,
} from './dependency-support.ts';
import {
  BASE_MESSAGE,
  GLOBAL_MESSAGE,
  PR_NUMBER,
  PR_REPOSITORY,
  PR_TOKEN,
  PR_URL,
  commit,
  createPrFixture,
  git,
  interceptGithub,
  policy,
  startGithubFixture,
  type PrFixture,
  type RequestRecord,
} from './pr-support.ts';
import { createSandbox, parseCheckOutput, runCli, withLoadOverrides, writeFile, type CheckReportShape, type Sandbox } from './support.ts';

const sandbox = createSandbox('coderuler-cli-pr-');
after(() => sandbox.cleanup());
const dependencyRegistry = createDependencyFixture(join(sandbox.root, 'dependency-registry'));
let dependencyInvocation = 0;

function fixture(context: TestContext, label: string): PrFixture {
  const target = createPrFixture(sandbox, label);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = target.temporary;
  context.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  return target;
}

function assertClean(target: PrFixture): void {
  assert.deepEqual(readdirSync(target.temporary).filter(name => name.startsWith('coderuler-pr-')), [], 'the entire temporary workspace must be removed');
}

async function check(target: PrFixture, args: readonly string[] = [], invocation: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const loader = createRuleLoader({ home: target.home });
  const services = withLoadOverrides({
    ...createServices(invocation.cwd ?? target.cwd, { ...target.env, ...invocation.env }),
    terminal: { color: false, interactive: false },
    write: (text: string) => { stdout.push(text); },
    writeError: (text: string) => { stderr.push(text); },
  }, {
    check: { loadRules: loader.load },
  });
  const status = await runProgram(['check', ...args, '--json', '--output-all'], services);
  assertClean(target);
  return { status, stdout: stdout.join(''), stderr: stderr.join('') };
}

function cleanCaller(target: PrFixture): void {
  writeFile(join(target.cwd, '.coderuler/base.rule.ts'), `${git(target, 'show', 'HEAD:.coderuler/base.rule.ts')}\n`);
  rmSync(join(target.cwd, '.coderuler/caller-only.rule.ts'), { force: true });
}

function publish(target: PrFixture, branch: 'main' | 'feature/pr-fixture', change: () => void): PrFixture {
  cleanCaller(target);
  git(target, 'checkout', branch);
  change();
  const revision = commit(target, `CLI fixture changes on ${branch}`);
  const ref = branch === 'main' ? 'refs/heads/main' : `refs/pull/${PR_NUMBER}/head`;
  git(target, 'push', '--force', target.remote, `${revision}:${ref}`);
  return { ...target, [branch === 'main' ? 'main' : 'head']: revision };
}

function evaluations(reports: readonly CheckReportShape[]) {
  return reports.flatMap(report => report.evaluations.map(({ subject, result }) => {
    assert.equal(subject.kind, 'scope');
    if (subject.kind !== 'scope') throw new Error('Expected a file scope');
    return { rule: report.name, filepath: subject.filepath, message: result.message, status: result.status };
  }));
}

function posts(requests: readonly RequestRecord[]) {
  return requests.filter(request => request.method === 'POST');
}

test('--pr uses current committed base and global policy only on PR changes', async context => {
  const target = fixture(context, 'default-base');
  assert.equal(git(target, 'remote', 'get-url', 'origin'), `git@github.com:${PR_REPOSITORY}.git`, 'the local transport rewrite must not alter caller origin discovery');
  const requests = await interceptGithub(context, target);


  const stdout: string[] = [];
  const stderr: string[] = [];
  const loader = createRuleLoader({ home: target.home });
  const services = withLoadOverrides({
    ...createServices(target.cwd, target.env),
    terminal: { color: false, interactive: false },
    write: (text: string) => { stdout.push(text); },
    writeError: (text: string) => { stderr.push(text); },
  }, {
    check: { loadRules: loader.load },
  });
  const status = await runProgram(['check', '--pr', String(PR_NUMBER), '--json', '--output-all'], services);
  const result = { status, stdout: stdout.join(''), stderr: stderr.join('') };
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const reports = parseCheckOutput(result, 'default PR base');
  assert.deepEqual(reports.map(report => ({
    name: report.name,
    status: report.status,
    evaluations: report.evaluations.map(({ subject, result: finding }) => {
      assert.equal(subject.kind, 'scope');
      if (subject.kind !== 'scope') throw new Error('Expected a file scope');
      return {
        filepath: subject.filepath,
        source: subject.source,
        status: finding.status,
        message: finding.message,
      };
    }),
  })), [
    {
      name: 'base',
      status: 'violation',
      evaluations: [{ filepath: 'src/changed.txt', source: 'BAD changed by the PR\n', status: 'violation', message: BASE_MESSAGE }],
    },
    {
      name: 'global',
      status: 'violation',
      evaluations: [{ filepath: 'src/changed.txt', source: 'BAD changed by the PR\n', status: 'violation', message: GLOBAL_MESSAGE }],
    },
  ]);
  assert.match(reports[0]!.ruleFile, /[/\\]coderuler-pr-[^/\\]+[/\\]base[/\\]\.coderuler[/\\]base\.rule\.ts$/);
  assert.equal(reports[1]!.ruleFile, join(target.home, '.coderuler/global.rule.ts'));
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: `/repos/${PR_REPOSITORY}/pulls/${PR_NUMBER}` },
  ], 'without --auto-comment only PR metadata is requested; no discovery or POST occurs');
  assert.equal(requests[0]!.authorization, `Bearer ${PR_TOKEN}`);
  assertClean(target);
});

test('--pr applies base policy to current-head changed-line coordinates', async context => {
  let target = fixture(context, 'changed-lines');
  cleanCaller(target);
  writeFile(join(target.home, '.coderuler/global.rule.ts'), policy('() => pass()'));

  git(target, 'checkout', 'main');
  writeFile(join(target.cwd, 'src/changed.txt'), 'BAD unchanged\nclean\n');
  writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(
    `subject => subject.source.includes('BAD') ? violation('Changed bad line', [{ filepath: subject.filepath, lines: subject.lines }]) : pass()`,
    '',
    `scope = (file, context) => {
    if (context.changedFiles?.has('.coderuler/base.rule.ts')) {
      throw new Error('Loaded base rule files must not be in changedFiles');
    }
    if (context.changedLines?.has('.coderuler/base.rule.ts')) {
      throw new Error('Loaded base rule files must not be in changedLines');
    }
    const candidates = file.source.split('\\n').flatMap((line, index) => line.includes('BAD') ? [{
      id: String(index + 1), source: line, lines: { start: index + 1, end: index + 1 },
    }] : []);
    if (context.changedFiles === undefined) return candidates;
    if (!context.changedFiles.has(file.filepath)) return [];
    const ranges = context.changedLines?.get(file.filepath);
    if (ranges === undefined) return candidates;
    return candidates.filter(scope => ranges.some(range => range.start <= scope.lines.end && scope.lines.start <= range.end));
  };`,
  ));
  const basePolicy = commit(target, 'add diff-aware base policy');
  git(target, 'push', target.remote, 'main:refs/heads/main');

  git(target, 'checkout', '-B', 'feature/pr-fixture', basePolicy);
  writeFile(join(target.cwd, 'src/changed.txt'), 'BAD unchanged\nBAD changed by the PR\n');
  writeFile(join(target.cwd, '.coderuler/base.rule.ts'), `throw new Error('PR-head policy must not execute');\n`);
  const head = commit(target, 'change the second current-head line');
  git(target, 'push', '--force', target.remote, `${head}:refs/pull/${PR_NUMBER}/head`);
  target = { ...target, head };
  const requests = await interceptGithub(context, target);
  const result = await check(target, ['--pr', '42']);
  assert.equal(result.status, 1, result.stderr);
  const reports = parseCheckOutput(result, 'changed-line PR');
  const baseReport = reports.find(report => report.name === 'base');
  assert.ok(baseReport);
  assert.match(baseReport.ruleFile, /[/\\]coderuler-pr-[^/\\]+[/\\]base[/\\]\.coderuler[/\\]base\.rule\.ts$/);
  assert.equal(reports.flatMap(report => report.evaluations).filter(({ result: finding }) => finding.status === 'violation').length, 1);
  assert.deepEqual(baseReport.evaluations.map(({ subject, result: finding }) => ({
    filepath: subject.kind === 'scope' ? subject.filepath : '',
    source: subject.kind === 'scope' ? subject.source : '',
    status: finding.status,
    message: finding.message,
    locations: finding.locations,
  })), [{
    filepath: 'src/changed.txt',
    source: 'BAD changed by the PR',
    status: 'violation',
    message: 'Changed bad line',
    locations: [{ filepath: 'src/changed.txt', lines: { start: 2, end: 2 } }],
  }]);
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: `/repos/${PR_REPOSITORY}/pulls/${PR_NUMBER}` },
  ]);
});

test('--base release selects distinct committed policy and the release merge-base', async context => {
  let target = fixture(context, 'release');
  cleanCaller(target);
  git(target, 'checkout', 'release');
  writeFile(join(target.cwd, 'src/release-shared.txt'), 'BAD shared with release\n');
  const release = commit(target, 'release source ancestor absent from main');
  git(target, 'checkout', 'feature/pr-fixture');
  git(target, 'merge', '-s', 'ours', '--no-commit', 'release');
  writeFile(join(target.cwd, 'src/release-shared.txt'), 'BAD shared with release\n');
  const head = commit(target, 'PR shares release source ancestry');
  git(target, 'push', target.remote, 'release:refs/heads/release', `${head}:refs/pull/42/head`);
  target = { ...target, release, head };
  await interceptGithub(context, target);

  const defaultBase = await check(target, ['--pr', '42']);
  assert.equal(defaultBase.status, 1, defaultBase.stderr);
  assert.deepEqual(evaluations(parseCheckOutput(defaultBase, 'main')).filter(item => item.rule === 'base'), [
    { rule: 'base', filepath: 'src/changed.txt', status: 'violation', message: BASE_MESSAGE },
    { rule: 'base', filepath: 'src/release-shared.txt', status: 'violation', message: BASE_MESSAGE },
  ]);
  const selected = await check(target, ['--pr', '42', '--base', 'release']);
  assert.equal(selected.status, 1, selected.stderr);
  assert.deepEqual(evaluations(parseCheckOutput(selected, 'release')), [
    { rule: 'base', filepath: 'src/changed.txt', status: 'violation', message: 'Committed release policy rejects BAD' },
    { rule: 'global', filepath: 'src/changed.txt', status: 'violation', message: GLOBAL_MESSAGE },
  ]);
});

test('a base without repository policy runs global policy, while two empty policy roots fail', async context => {
  let target = fixture(context, 'global-only');
  target = publish(target, 'main', () => rmSync(join(target.cwd, '.coderuler'), { recursive: true }));
  const requests = await interceptGithub(context, target);
  const globalOnly = await check(target, ['--pr', '42']);
  assert.equal(globalOnly.status, 1, globalOnly.stderr);
  assert.deepEqual(evaluations(parseCheckOutput(globalOnly, 'global only')), [
    { rule: 'global', filepath: 'src/changed.txt', status: 'violation', message: GLOBAL_MESSAGE },
  ]);
  rmSync(join(target.home, '.coderuler'), { recursive: true });
  const noRules = await check(target, ['--pr', '42']);
  assert.equal(noRules.status, 2);
  assert.match(noRules.stderr, /no rule files/i);
  assert.deepEqual(posts(requests), []);
});

test('check --pr selects rule names from committed base policy', async context => {
  const target = fixture(context, 'named-base-policy');
  await interceptGithub(context, target);

  const result = await check(target, ['--pr', '42', '--rules', 'base']);
  assert.equal(result.status, 1, result.stderr);
  const reports = parseCheckOutput(result, 'named PR base policy');
  assert.deepEqual(evaluations(reports), [
    { rule: 'base', filepath: 'src/changed.txt', status: 'violation', message: BASE_MESSAGE },
  ]);
  assert.match(reports[0]!.ruleFile, /[/\\]coderuler-pr-[^/\\]+[/\\]base[/\\]\.coderuler[/\\]base\.rule\.ts$/);
});

test('caller-relative --rules intentionally overrides discovery but still requires a fetched base', async context => {
  const target = fixture(context, 'explicit-rules');
  writeFile(join(target.cwd, 'custom/explicit.rule.ts'), policy(`() => pass()`));
  const requests = await interceptGithub(context, target);
  const explicit = await check(target, ['--pr', '42', '--rules', 'custom/explicit.rule.ts']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(evaluations(parseCheckOutput(explicit, 'explicit policy')), [
    { rule: 'explicit', filepath: 'src/changed.txt', status: 'pass', message: undefined },
  ]);
  const missingBase = await check(target, ['--pr', '42', '--rules', 'custom/explicit.rule.ts', '--base', 'absent']);
  assert.equal(missingBase.status, 2);
  assert.equal(missingBase.stdout, '');
  assert.notEqual(missingBase.stderr, '');
  assert.deepEqual(posts(requests), []);
});

test('check --pr uses remote rules for PR-head changes and removes both checkouts', async context => {
  const target = fixture(context, 'remote-rules');
  const requests = await interceptGithub(context, target);

  const ruleRemote = join(target.root, 'rule-remote.git');
  const ruleSource = join(target.root, 'rule-source');
  const ruleTransport = 'https://rules.example.invalid/team/policies.git';
  git(target, 'init', '--bare', ruleRemote);
  git(target, 'init', ruleSource);
  git(target, '-C', ruleSource, 'config', 'user.name', 'CodeRuler tests');
  git(target, '-C', ruleSource, 'config', 'user.email', 'tests@example.invalid');
  writeFile(join(ruleSource, 'remote.rule.ts'), policy(
    `subject => subject.source.includes('BAD') ? violation('Remote policy rejects BAD') : pass()`,
  ));
  git(target, '-C', ruleSource, 'add', '--all');
  git(target, '-C', ruleSource, 'commit', '-m', 'remote PR policy');
  git(target, '-C', ruleSource, 'push', ruleRemote, 'HEAD:refs/heads/main');
  git(target, '-C', ruleRemote, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  const globalConfig = join(target.home, '.gitconfig');
  const transportConfig = join(target.home, 'temporary-checkout.gitconfig');
  writeFile(globalConfig, [
    `[includeIf "gitdir:**/coderuler-pr-*/head/.git"]`,
    `\tpath = ${JSON.stringify(transportConfig)}`,
    `[includeIf "gitdir:**/coderuler-rules-*/repository/.git"]`,
    `\tpath = ${JSON.stringify(transportConfig)}`,
    '',
  ].join('\n'));
  writeFile(transportConfig, [
    `[url ${JSON.stringify(target.remote)}]`,
    `\tinsteadOf = https://github.com/${PR_REPOSITORY}.git`,
    `\tinsteadOf = git@github.com:${PR_REPOSITORY}.git`,
    `[url ${JSON.stringify(ruleRemote)}]`,
    `\tinsteadOf = ${ruleTransport}`,
    '',
  ].join('\n'));

  const result = await check(target, ['--pr', '42', '--rules', ruleTransport]);
  assert.equal(result.status, 1, result.stderr);
  const reports = parseCheckOutput(result, 'remote PR policy');
  assert.deepEqual(evaluations(reports), [
    { rule: 'remote', filepath: 'src/changed.txt', status: 'violation', message: 'Remote policy rejects BAD' },
  ]);
  assert.match(reports[0]!.ruleFile, /[/\\]coderuler-rules-[^/\\]+[/\\]repository[/\\]remote\.rule\.ts$/);
  assert.deepEqual(posts(requests), []);
  assert.deepEqual(
    readdirSync(target.temporary).filter(name => name.startsWith('coderuler-pr-') || name.startsWith('coderuler-rules-')),
    [],
    'both PR and remote-rule workspaces must be removed',
  );
});

test('positional targets resolve in PR head and preserve missing, boundary, and symlink errors with cleanup', async context => {
  let target = fixture(context, 'targets');
  const outside = writeFile(join(target.root, 'outside.txt'), 'BAD outside\n');
  target = publish(target, 'feature/pr-fixture', () => {
    writeFile(join(target.cwd, 'src/other.txt'), 'BAD another PR change\n');
    symlinkSync(outside, join(target.cwd, 'src/escape.txt'));
  });
  const requests = await interceptGithub(context, target);
  for (const path of ['src', 'src/changed.txt']) {
    const result = await check(target, [path, '--pr', '42']);
    assert.equal(result.status, 1, result.stderr);
    const files = evaluations(parseCheckOutput(result, path)).filter(item => item.rule === 'base').map(item => item.filepath);
    assert.deepEqual(files, path === 'src' ? ['src/changed.txt', 'src/other.txt'] : ['src/changed.txt']);
  }
  for (const [path, error] of [
    ['src/missing.txt', /does not exist/],
    ['../outside.txt', /outside.*root/],
    ['src/escape.txt', /symbolic link/],
  ] as const) {
    const result = await check(target, [path, '--pr', '42']);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, error);
  }
  assert.deepEqual(posts(requests), []);
});

const CUSTOM_COMMENT = '**Committed base guidance** — use the trusted policy.';

function commentPolicy(target: PrFixture): PrFixture {
  const updated = publish(target, 'main', () => {
    writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(
      `() => violation('Located committed-base rejection')`,
      '',
      `scope = file => [{ id: '$', source: file.source, lines: { start: 1, end: 1 } }];\n  comment = ${JSON.stringify(CUSTOM_COMMENT)};`,
    ));
  });
  writeFile(join(target.home, '.coderuler/global.rule.ts'), policy(
    `() => violation('Unlocated global rejection')`, '', `group = 'project';`,
  ));
  return updated;
}

function assertCommentTarget(requests: readonly RequestRecord[], target: PrFixture): void {
  assert.equal(requests.some(request => request.url.startsWith(`/repos/${PR_REPOSITORY}/pulls?`)), false, 'explicit PR identity must not discover a branch');
  assert.ok(requests.every(request => request.url.startsWith(`/repos/${PR_REPOSITORY}/`)), 'unrelated Actions identity must never redirect requests');
  const review = posts(requests).filter(request => request.url.endsWith('/pulls/42/reviews'));
  assert.equal(review.length, 1);
  const payload = JSON.parse(review[0]!.body);
  assert.equal(payload.commit_id, target.head);
  assert.equal(payload.event, 'COMMENT');
  assert.deepEqual(payload.comments, [
    { path: 'src/changed.txt', body: CUSTOM_COMMENT, line: 1, side: 'RIGHT' },
  ], 'inline placement requires the PR-head blob to match the analyzed file');
  const fallback = posts(requests).filter(request => request.url.endsWith('/issues/42/comments'));
  assert.equal(fallback.length, 1);
  assert.match(JSON.parse(fallback[0]!.body).body, /Unlocated global rejection/);
  assert.equal(posts(requests).length, 2);
}

test('URL outside a clone comments on the explicit detached PR despite unrelated Actions identity', async context => {
  const target = commentPolicy(fixture(context, 'url-comments'));
  const requests = await interceptGithub(context, target);
  const outside = join(target.root, 'not-a-repository');
  mkdirSync(outside);
  const result = await check(target, ['--pr', `${PR_URL}/?tab=files#diff`, '--auto-comment'], {
    cwd: outside,
    env: { GITHUB_REPOSITORY: 'unrelated/actions', GITHUB_REF: 'refs/pull/999/merge', GITHUB_HEAD_REF: 'unrelated-branch' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(parseCheckOutput(result, 'commented URL').map(report => report.name), ['base', 'global']);
  assertCommentTarget(requests, target);
});

test('passing and empty-diff PR checks never post even with --auto-comment', async context => {
  let target = fixture(context, 'no-post');
  target = publish(target, 'feature/pr-fixture', () => {
    writeFile(join(target.cwd, 'src/changed.txt'), 'GOOD changed by the PR\n');
  });
  const requests = await interceptGithub(context, target);
  const passing = await check(target, ['--pr', '42', '--auto-comment']);
  assert.equal(passing.status, 0, passing.stderr);
  assert.deepEqual(evaluations(parseCheckOutput(passing, 'passing')).map(item => item.status), ['pass', 'pass']);
  git(target, 'push', '--force', target.remote, `${target.main}:refs/pull/42/head`);
  const empty = await check(target, ['--pr', '42', '--auto-comment']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(parseCheckOutput(empty, 'empty diff').map(report => ({ status: report.status, evaluations: report.evaluations })), [
    { status: 'skipped', evaluations: [] }, { status: 'skipped', evaluations: [] },
  ]);
  assert.deepEqual(posts(requests), []);
  assert.equal(requests.length, 2, 'no comment planning or head rechecks are needed without violations');
});

test('missing token retains rendered violations and fails without a POST', async context => {
  const target = fixture(context, 'missing-token');
  const requests = await interceptGithub(context, target);
  const result = await check(target, ['--pr', '42', '--auto-comment'], { env: { GITHUB_TOKEN: undefined } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GITHUB_TOKEN/);
  assert.deepEqual(evaluations(JSON.parse(result.stdout).reports).map(item => item.message), [BASE_MESSAGE, GLOBAL_MESSAGE]);
  assert.deepEqual(posts(requests), []);
  assert.equal(requests[0]!.authorization, undefined);
});

test('failed comment POST retains analysis and removes both checkout trees', async context => {
  const target = commentPolicy(fixture(context, 'failed-post'));
  const requests = await interceptGithub(context, target, { postStatus: 403 });
  const result = await check(target, ['--pr', '42', '--auto-comment']);
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout).reports.map((report: CheckReportShape) => report.status), ['violation', 'violation']);
  assert.equal(posts(requests).length, 1, 'do not continue posting after the rejected review');
  assert.ok(posts(requests)[0]!.url.endsWith('/pulls/42/reviews'));
});

test('PR advancement after actual analysis refuses stale inline and fallback findings and cleans checkout', async context => {
  for (const located of [false, true]) {
    await context.test(located ? 'unchanged contextual anchor' : 'fixed affected-file fallback', async child => {
      let target = fixture(child, located ? 'stale-context-anchor' : 'stale-summary');
      if (located) {
        target = publish(target, 'main', () => {
          writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(
            `subject => subject.source.includes('BAD') ? violation(${JSON.stringify(BASE_MESSAGE)}) : pass()`,
            '',
            `scope = file => [{ id: '$', source: file.source, lines: { start: 1, end: 1 } }];`,
          ));
        });
        target = publish(target, 'feature/pr-fixture', () => {
          writeFile(join(target.cwd, 'src/changed.txt'), 'unchanged anchor\nBAD changed by the PR\n');
        });
      }
      const analyzedHead = target.head;
      const metadata = { base: { ref: 'main' }, head: { sha: analyzedHead } };
      const requests = await interceptGithub(child, target, { metadata });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const runtime = createServices(target.cwd, target.env);
      const runtimeCheck = await runtime.load.check(runtime);
      const loader = createRuleLoader({ home: target.home });
      let evaluated = false;
      const services = withLoadOverrides({
        ...runtime,
        terminal: { color: false, interactive: false },
        write: (text: string) => { stdout.push(text); },
        writeError: (text: string) => { stderr.push(text); },
      }, {
        check: {
          loadRules: loader.load,
          runRules: async (...args: Parameters<typeof runtimeCheck.runRules>) => {
            const reports = await runtimeCheck.runRules(...args);
            assert.ok(reports.some(report => report.status === 'violation'), 'real evaluation must finish against the old fetched head');
            evaluated = true;
            target = publish(target, 'feature/pr-fixture', () => {
              writeFile(join(target.cwd, 'src/changed.txt'), `${located ? 'unchanged anchor\n' : ''}GOOD fixed by the PR\n`);
            });
            metadata.head.sha = target.head;
            return reports;
          },
        },
      });
      const status = await runProgram(['check', '--pr', '42', '--auto-comment', '--json', '--output-all'], services);
      assert.equal(evaluated, true);
      assert.notEqual(target.head, analyzedHead);
      assert.equal(git(target, '--git-dir', target.remote, 'rev-parse', 'refs/pull/42/head'), target.head);
      assert.equal(status, 2);
      assert.match(stderr.join(''), /head.*changed.*analysis/i);
      assert.equal(stderr.join('').includes(PR_TOKEN), false);
      const reports = JSON.parse(stdout.join('')).reports as CheckReportShape[];
      assert.deepEqual(evaluations(reports).map(item => item.message), [BASE_MESSAGE, GLOBAL_MESSAGE]);
      assert.ok(reports.every(report => report.status === 'violation'), 'rendered old-head analysis must remain available');
      assert.deepEqual(posts(requests), []);
      assert.equal(requests.length, 2, 'stale analysis must fail before file planning or any POST');
      assertClean(target);
    });
  }
});

function policyLock(version: '1.0.0' | '2.0.0', malicious = false): string {
  const names = ['fixture-policy', 'fixture-shared', ...(malicious ? ['fixture-install'] : [])];
  const direct = { 'fixture-policy': version, ...(malicious ? { 'fixture-install': '1.0.0' } : {}) };
  const packages: Record<string, unknown> = {
    '': { name: 'coderuler-rules', version: '1.0.0', dependencies: direct },
  };
  for (const name of names) {
    const artifact = dependencyRegistry.artifacts.find(candidate => candidate.manifest.name === name
      && candidate.manifest.version === (name === 'fixture-install' ? '1.0.0' : version));
    assert.ok(artifact);
    packages[`node_modules/${name}`] = {
      version: artifact.manifest.version,
      resolved: artifact.tarball,
      integrity: artifact.integrity,
      ...(artifact.manifest.dependencies === undefined ? {} : { dependencies: artifact.manifest.dependencies }),
      ...(name === 'fixture-install' ? { hasInstallScript: true } : {}),
    };
  }
  return `${JSON.stringify({ name: 'coderuler-rules', version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

function committedDependencies(target: PrFixture, manifest: 'malformed' | 'unrelated' = 'unrelated'): PrFixture {
  target = publish(target, 'main', () => {
    writeFile(join(target.cwd, 'package.json'), manifest === 'malformed' ? '{ invalid application JSON' : JSON.stringify({
      name: 'unrelated-base-application', private: true,
      dependencies: { 'never-install-base': 'file:missing-base-package' },
      scripts: { install: 'exit 1' },
    }));
    writeFile(join(target.cwd, 'package-lock.json'), '{ stale application lock');
    writeFile(join(target.cwd, 'npm-shrinkwrap.json'), '{ malformed application shrinkwrap');
    // Rules have their own ESM boundary; Node need not parse the unrelated application manifest.
    writeFile(join(target.cwd, '.coderuler/package.json'), '{"type":"module"}');
    writeFile(join(target.cwd, '.coderuler/coderuler.lock'), policyLock('1.0.0'));
    writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(
      `subject => subject.source.includes('BAD') ? violation(message) : pass()`,
      `import { message } from 'fixture-policy';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
const installed = new URL('./node_modules/', import.meta.url);
assert.equal(lstatSync(installed).isDirectory(), true);
assert.equal(lstatSync(installed).isSymbolicLink(), false);
for (const name of ['fixture-policy', 'fixture-shared']) {
  const location = new URL(name, installed);
  assert.equal(lstatSync(location).isDirectory(), true);
  assert.equal(lstatSync(location).isSymbolicLink(), false);
}
const marker = JSON.parse(readFileSync(new URL('.coderuler-install.json', installed), 'utf8'));
assert.equal(marker.version, 1);
assert.match(marker.key, /^[a-f0-9]{64}$/);
assert.ok(marker.installedLocations.includes('node_modules/fixture-policy'));
assert.ok(marker.installedLocations.includes('node_modules/fixture-shared'));
assert.equal(
  realpathSync(new URL(import.meta.resolve('fixture-policy'))),
  realpathSync(new URL('fixture-policy/index.js', installed)),
);
assert.equal(readFileSync(new URL('./package.json', import.meta.url), 'utf8'), '{"type":"module"}');
assert.equal(existsSync(new URL('./package-lock.json', import.meta.url)), false);`,
    ));
  });
  return publish(target, 'feature/pr-fixture', () => {
    writeFile(join(target.cwd, '.coderuler/coderuler.lock'), policyLock('2.0.0', true));
    writeFile(join(target.cwd, 'package.json'), JSON.stringify({
      name: 'untrusted-head',
      dependencies: { 'never-install-head': 'file:missing-head-package' },
      scripts: { install: 'exit 1' },
    }));
  });
}

async function checkWithDependencies(
  context: TestContext,
  target: PrFixture,
  mode: 'tarballs' | 'offline' = 'tarballs',
  args: readonly string[] = [],
) {
  const api = await startGithubFixture(target);
  context.after(() => api.close());
  const requestLog = join(target.root, `dependency-requests-${dependencyInvocation++}.jsonl`);
  const preload = writeFile(join(target.root, 'pr-transport.mjs'), `
import nock from ${JSON.stringify(import.meta.resolve('nock'))};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin !== 'https://api.github.com') throw new Error('Unexpected GitHub API origin: ' + url.origin);
  nock.enableNetConnect('127.0.0.1');
  return originalFetch(${JSON.stringify(api.origin)} + url.pathname + url.search, init);
};
`);
  const bin = join(target.root, 'git-only');
  if (!existsSync(bin)) {
    mkdirSync(bin);
    const gitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    symlinkSync(gitPath, join(bin, 'git'));
  }
  const before = callerSnapshot(target);
  const result = await runCli(['check', '--pr', '42', '--json', '--output-all', ...args], target, {
    ...dependencyFixtureEnvironment(dependencyRegistry, {
      mode, requestLog, nodeOptions: `--import=${JSON.stringify(pathToFileURL(preload).href)}`,
    }),
    RK_DEPENDENCY_CACHE: join(target.root, 'rule-dependency-cache'),
    RK_DEPENDENCY_SCRIPT_MARKER: join(target.root, 'lifecycle-ran'),
    PATH: bin,
    NODE_ENV: 'production',
  });
  assert.deepEqual(callerSnapshot(target), before, 'PR acquisition must preserve all caller files and Git state');
  assertClean(target);
  const dependencyRequests = existsSync(requestLog)
    ? readFileSync(requestLog, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as RegistryRequest)
      // Nock also records allowed loopback GitHub transport as unmatched traffic.
      .filter(request => request.kind !== 'unmatched' || !request.path.startsWith(`${api.origin}/`))
    : [];
  return { ...result, dependencyRequests, githubRequests: api.requests };
}

for (const manifest of ['malformed', 'unrelated'] as const) {
  test(`PR CLI installs real packages only beside committed base policy with ${manifest} application metadata and no npm`, async context => {
    const target = committedDependencies(fixture(context, `managed-${manifest}`), manifest);
    const result = await checkWithDependencies(context, target);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(evaluations(parseCheckOutput(result, 'committed managed base policy')), [
      { rule: 'base', filepath: 'src/changed.txt', status: 'violation', message: POLICY_MESSAGE_V1 },
      { rule: 'global', filepath: 'src/changed.txt', status: 'violation', message: GLOBAL_MESSAGE },
    ]);
    const [base] = parseCheckOutput(result, 'installed base checkout cleanup');
    assert.ok(base);
    assert.equal(existsSync(dirname(base.ruleFile)), false, 'temporary base policy and its installed node_modules must be removed together');
    assert.deepEqual(readdirSync(join(target.root, 'rule-dependency-cache')), ['tarballs'], 'only downloaded artifacts persist outside the removed checkout');
    assert.deepEqual([...result.dependencyRequests].sort((left, right) => left.path.localeCompare(right.path)), [
      { kind: 'tarball', path: '/fixture-policy/-/fixture-policy-1.0.0.tgz' },
      { kind: 'tarball', path: '/fixture-shared/-/fixture-shared-1.0.0.tgz' },
    ]);
    assert.deepEqual(posts(result.githubRequests), []);
    assert.equal(existsSync(join(target.root, 'lifecycle-ran')), false);
    const cached = await checkWithDependencies(context, target, 'offline');
    assert.equal(cached.status, 1, cached.stderr);
    const cachedReports = parseCheckOutput(cached, 'base policy reinstalled from downloaded artifacts');
    assert.deepEqual(evaluations(cachedReports).map(item => item.message), [POLICY_MESSAGE_V1, GLOBAL_MESSAGE]);
    assert.equal(existsSync(dirname(cachedReports[0]!.ruleFile)), false);
    assert.deepEqual(cached.dependencyRequests, []);
  });
}

test('invalid base locks, unavailable locked packages and imports fail without global-only fallback or comments', async context => {
  for (const failure of ['lock', 'offline', 'unsafe', 'import'] as const) {
    await context.test(failure, async child => {
      let target = committedDependencies(fixture(child, `managed-${failure}`));
      target = publish(target, 'main', () => {
        if (failure === 'lock') {
          writeFile(join(target.cwd, '.coderuler/coderuler.lock'), '{ invalid rule lock');
        } else if (failure === 'unsafe') {
          writeFile(join(target.cwd, '.coderuler/coderuler.lock'), policyLock('1.0.0', true));
        } else if (failure === 'import') {
          writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(
            `() => violation(message)`, `import message from '../policy/missing-helper.ts';`,
          ));
        } else {
          writeFile(join(target.cwd, 'unrelated-base.txt'), 'Keep the reviewed locked policy\n');
        }
      });
      const result = await checkWithDependencies(child, target, failure === 'offline' ? 'offline' : 'tarballs', ['--auto-comment']);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, failure === 'lock' ? /coderuler\.lock|JSON|lock/i
        : failure === 'offline' ? /fixture-policy|fixture-shared|network|cache|request/i
          : failure === 'unsafe' ? /fixture-install|install script|lifecycle|unsupported/i : /missing-helper|import|resolve/i);
      assert.deepEqual(posts(result.githubRequests), []);
      assert.equal(existsSync(join(target.root, 'lifecycle-ran')), false);
      if (failure === 'lock') assert.deepEqual(result.dependencyRequests, []);
      assert.ok(result.dependencyRequests.every(request => !request.path.includes('2.0.0')
        && (failure === 'unsafe' || !request.path.includes('fixture-install'))));
    });
  }
});

test('SDK-only committed base rules need neither rule lock nor application installation', async context => {
  let target = fixture(context, 'sdk-only-no-install');
  target = publish(target, 'main', () => {
    writeFile(join(target.cwd, 'package.json'), '{ invalid unrelated application manifest');
    writeFile(join(target.cwd, '.coderuler/package.json'), '{"type":"module"}');
    writeFile(join(target.cwd, '.coderuler/base.rule.ts'), policy(
      `subject => subject.source.includes('BAD') ? violation(${JSON.stringify(BASE_MESSAGE)}) : pass()`,
    ));
  });
  const result = await checkWithDependencies(context, target, 'offline');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(evaluations(parseCheckOutput(result, 'SDK-only base')).map(item => item.message), [BASE_MESSAGE, GLOBAL_MESSAGE]);
  assert.deepEqual(result.dependencyRequests, []);
  assert.deepEqual(posts(result.githubRequests), []);
});

function callerSnapshot(target: Sandbox) {
  const status = git(target, 'status', '--porcelain=v1', '--untracked-files=all');
  const paths = git(target, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  return {
    head: readFileSync(join(target.cwd, '.git/HEAD'), 'utf8'),
    commit: git(target, 'rev-parse', 'HEAD'),
    index: readFileSync(join(target.cwd, '.git/index')).toString('base64'),
    refs: git(target, 'for-each-ref', '--format=%(refname) %(objectname)'),
    status,
    files: [...new Set(paths)].sort().map(path => [path, readFileSync(join(target.cwd, path)).toString('base64')]),
  };
}

test('inherited repository selectors cannot redirect PR analysis, inline matching, or mutate the caller', async context => {
  const target = commentPolicy(fixture(context, 'inherited-repository'));
  writeFile(join(target.cwd, 'src/changed.txt'), 'BAD dirty caller blob must not match PR\n');
  writeFile(join(target.cwd, 'caller-untracked.txt'), 'Preserve caller worktree\n');
  git(target, 'add', 'src/changed.txt');
  const before = callerSnapshot(target);
  const requests = await interceptGithub(context, target);
  const result = await check(target, ['--pr', '42', '--auto-comment'], {
    env: {
      GIT_DIR: join(target.cwd, '.git'),
      GIT_WORK_TREE: target.cwd,
      GIT_INDEX_FILE: join(target.cwd, '.git/index'),
      GIT_COMMON_DIR: join(target.cwd, '.git'),
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const reports = parseCheckOutput(result, 'isolated repository');
  assert.deepEqual(reports[0]!.evaluations.map(({ subject }) => subject.kind === 'scope' ? subject.source : undefined), ['BAD changed by the PR\n']);
  assertCommentTarget(requests, target);
  assert.deepEqual(callerSnapshot(target), before, 'caller HEAD, refs, index bytes, staged/unstaged content and untracked files stay untouched');
});

for (const channel of ['count', 'parameters'] as const) {
  test(`core.worktree via ${channel} fails before preparation; ordinary credential configuration remains usable`, async context => {
    const target = fixture(context, `configuration-${channel}`);
    const requests = await interceptGithub(context, target);
    const before = callerSnapshot(target);
    const location = channel === 'count'
      ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: target.cwd }
      : { GIT_CONFIG_PARAMETERS: `'core.worktree=${target.cwd}'` };
    const refused = await check(target, ['--pr', '42', '--auto-comment'], { env: location });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /core\.worktree.*unset/);
    assert.equal(refused.stdout, '');
    assert.deepEqual(requests, [], 'location overrides must fail before PR lookup or workspace allocation');
    assert.deepEqual(callerSnapshot(target), before);

    const credentials = channel === 'count'
      ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'fixture-helper' }
      : { GIT_CONFIG_PARAMETERS: "'credential.helper=fixture-helper'" };
    const accepted = await check(target, ['--pr', '42'], { env: credentials });
    assert.equal(accepted.status, 1, accepted.stderr);
    assert.deepEqual(evaluations(parseCheckOutput(accepted, 'credential config')).map(item => item.message), [BASE_MESSAGE, GLOBAL_MESSAGE]);
    assert.deepEqual(posts(requests), []);
    assert.deepEqual(callerSnapshot(target), before);
  });
}

test('root-dotfile project groups include committed inputs but no generated Git metadata or sibling policy tree', async context => {
  let target = fixture(context, 'metadata-inputs');
  target = publish(target, 'main', () => {
    rmSync(join(target.cwd, '.coderuler/base.rule.ts'));
    writeFile(join(target.cwd, '.coderuler/dotfiles.rule.ts'), `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Dotfiles extends Rule {
  files = ['.*'];
  group = 'project';
  check = () => pass();
}
`);
    writeFile(join(target.cwd, '.base-only'), 'This sibling base-tree dotfile must not enter the group\n');
  });
  // The source branch has no .policy yet, so this is an actual PR source change.
  git(target, 'checkout', 'feature/pr-fixture');
  writeFile(join(target.cwd, '.policy'), 'Committed PR dotfile\n');
  const head = commit(target, 'PR root dotfile');
  git(target, 'push', target.remote, `${head}:refs/pull/42/head`);
  target = { ...target, head };
  const requests = await interceptGithub(context, target);
  const result = await check(target, ['--pr', '42']);
  assert.equal(result.status, 1, result.stderr);
  const report = parseCheckOutput(result, 'root dotfiles').find(report => report.name === 'dotfiles');
  assert.ok(report);
  assert.equal(report.evaluations.length, 1);
  const subject = report.evaluations[0]!.subject;
  assert.equal(subject.kind, 'group');
  if (subject.kind !== 'group') throw new Error('Expected a project group');
  assert.equal(subject.group.type, 'project');
  assert.deepEqual(subject.members.map(member => member.filepath).sort(), ['.gitignore', '.policy']);
  assert.equal(report.evaluations[0]!.result.status, 'pass');
  assert.deepEqual(posts(requests), []);
});

test('representative selector, metadata, ref, and history failures return exit 2 without comments', async context => {
  for (const failure of ['unsafe-selector', 'missing-origin', 'missing-pr', 'invalid-metadata', 'missing-base', 'missing-head', 'unrelated-history'] as const) {
    await context.test(failure, async child => {
      let target = fixture(child, failure);
      let selector = '42';
      let args: string[] = [];
      if (failure === 'unsafe-selector') selector = 'https://user:secret@github.com/owner/project/pull/42';
      if (failure === 'missing-origin') git(target, 'remote', 'remove', 'origin');
      if (failure === 'missing-base') args = ['--base', 'does-not-exist'];
      if (failure === 'missing-head') git({ ...target, cwd: target.remote }, 'update-ref', '-d', 'refs/pull/42/head');
      if (failure === 'unrelated-history') {
        const head = git(target, 'commit-tree', `${target.main}^{tree}`, '-m', 'unrelated history');
        git(target, 'push', '--force', target.remote, `${head}:refs/pull/42/head`);
        target = { ...target, head };
      }
      const requests = await interceptGithub(child, target, {
        ...(failure === 'missing-pr' ? { metadataStatus: 404 } : {}),
        ...(failure === 'invalid-metadata' ? { metadata: { head: { sha: target.head } } } : {}),
      });
      const result = await check(target, ['--pr', selector, '--auto-comment', ...args]);
      assert.equal(result.status, 2, failure);
      assert.equal(result.stdout, '');
      assert.notEqual(result.stderr, '', failure);
      assert.deepEqual(posts(requests), []);
      if (failure === 'unsafe-selector' || failure === 'missing-origin') assert.deepEqual(requests, []);
    });
  }
});

test('committed-base and global duplicate rule names fail rather than silently overriding policy', async context => {
  const target = fixture(context, 'duplicate-policy');
  rmSync(join(target.home, '.coderuler/global.rule.ts'));
  writeFile(join(target.home, '.coderuler/base.rule.ts'), policy(`() => pass('Must not override trusted base')`));
  const requests = await interceptGithub(context, target);
  const result = await check(target, ['--pr', '42', '--auto-comment']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /matches 2 rule files/i);
  assert.equal(result.stdout, '');
  assert.deepEqual(posts(requests), []);
});
