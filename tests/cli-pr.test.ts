import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { runProgram } from '../dist/adapter/cli/program.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';
import { createServices } from '../dist/infra/runtime.js';
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
  type PrFixture,
  type RequestRecord,
} from './pr-support.ts';
import { createSandbox, parseCheckOutput, writeFile, type CheckReportShape, type Sandbox } from './support.ts';

const sandbox = createSandbox('rulekeeper-cli-pr-');
after(() => sandbox.cleanup());

function fixture(context: TestContext, label: string): PrFixture {
  const target = createPrFixture(sandbox, label);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = target.temporary;
  context.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  target.env.npm_config_offline = 'true';
  target.env.npm_config_registry = 'http://127.0.0.1:1';
  target.env.npm_config_cache = join(target.root, 'npm-cache');
  target.env.npm_config_update_notifier = 'false';
  return target;
}

function assertClean(target: PrFixture): void {
  assert.deepEqual(readdirSync(target.temporary).filter(name => name.startsWith('rulekeeper-pr-')), [], 'the entire temporary workspace must be removed');
}

async function check(target: PrFixture, args: readonly string[] = [], invocation: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const loader = createRuleLoader({ home: target.home });
  const services = {
    ...createServices(invocation.cwd ?? target.cwd, { ...target.env, ...invocation.env }),
    loadRules: loader.load,
    terminal: { color: false, interactive: false },
    write: (text: string) => { stdout.push(text); },
    writeError: (text: string) => { stderr.push(text); },
  };
  const status = await runProgram(['check', ...args, '--json', '--output-all'], services);
  assertClean(target);
  return { status, stdout: stdout.join(''), stderr: stderr.join('') };
}

function cleanCaller(target: PrFixture): void {
  writeFile(join(target.cwd, '.rulekeeper/base.rule.ts'), `${git(target, 'show', 'HEAD:.rulekeeper/base.rule.ts')}\n`);
  rmSync(join(target.cwd, '.rulekeeper/caller-only.rule.ts'), { force: true });
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
  const services = {
    ...createServices(target.cwd, target.env),
    loadRules: loader.load,
    terminal: { color: false, interactive: false },
    write: (text: string) => { stdout.push(text); },
    writeError: (text: string) => { stderr.push(text); },
  };
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
  assert.match(reports[0]!.ruleFile, /[/\\]rulekeeper-pr-[^/\\]+[/\\]base[/\\]\.rulekeeper[/\\]base\.rule\.ts$/);
  assert.equal(reports[1]!.ruleFile, join(target.home, '.rulekeeper/global.rule.ts'));
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: `/repos/${PR_REPOSITORY}/pulls/${PR_NUMBER}` },
  ], 'without --auto-comment only PR metadata is requested; no discovery or POST occurs');
  assert.equal(requests[0]!.authorization, `Bearer ${PR_TOKEN}`);
  assertClean(target);
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
  target = publish(target, 'main', () => rmSync(join(target.cwd, '.rulekeeper'), { recursive: true }));
  const requests = await interceptGithub(context, target);
  const globalOnly = await check(target, ['--pr', '42']);
  assert.equal(globalOnly.status, 1, globalOnly.stderr);
  assert.deepEqual(evaluations(parseCheckOutput(globalOnly, 'global only')), [
    { rule: 'global', filepath: 'src/changed.txt', status: 'violation', message: GLOBAL_MESSAGE },
  ]);
  rmSync(join(target.home, '.rulekeeper'), { recursive: true });
  const noRules = await check(target, ['--pr', '42']);
  assert.equal(noRules.status, 2);
  assert.match(noRules.stderr, /no rule files/i);
  assert.deepEqual(posts(requests), []);
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
    assert.equal(result.status, 2, path);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, error);
  }
  assert.deepEqual(posts(requests), []);
});

const CUSTOM_COMMENT = '**Committed base guidance** — use the trusted policy.';

function commentPolicy(target: PrFixture): PrFixture {
  const updated = publish(target, 'main', () => {
    writeFile(join(target.cwd, '.rulekeeper/base.rule.ts'), policy(
      `() => violation('Located committed-base rejection')`,
      '',
      `scope = file => [{ id: '$', source: file.source, lines: { start: 1, end: 1 } }];\n  comment = ${JSON.stringify(CUSTOM_COMMENT)};`,
    ));
  });
  writeFile(join(target.home, '.rulekeeper/global.rule.ts'), policy(
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
  assert.notEqual(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).reports.map((report: CheckReportShape) => report.status), ['violation', 'violation']);
  assert.equal(posts(requests).length, 1, 'do not continue posting after the rejected review');
  assert.ok(posts(requests)[0]!.url.endsWith('/pulls/42/reviews'));
});

for (const locked of [true, false]) {
  test(`${locked ? 'locked' : 'unlocked'} committed base dependencies execute offline as dev policy without lifecycle scripts`, async context => {
    let target = fixture(context, `dependency-${locked}`);
    const marker = join(target.root, 'lifecycle-ran');
    const lifecycle = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`)}`;
    target = publish(target, 'main', () => {
      writeFile(join(target.cwd, 'deps/policy-helper/package.json'), JSON.stringify({
        name: 'policy-helper', version: '1.0.0', type: 'module', exports: './index.js',
        scripts: { preinstall: lifecycle, install: lifecycle, postinstall: lifecycle, prepare: lifecycle },
      }));
      writeFile(join(target.cwd, 'deps/policy-helper/index.js'), `export default 'Offline committed-base dependency policy';\n`);
      writeFile(join(target.cwd, 'package.json'), JSON.stringify({
        name: 'trusted-base', private: true, type: 'module',
        devDependencies: { 'policy-helper': 'file:deps/policy-helper' },
        scripts: { preinstall: lifecycle, install: lifecycle, postinstall: lifecycle, prepare: lifecycle },
      }));
      writeFile(join(target.cwd, '.rulekeeper/base.rule.ts'), policy(
        `() => violation(message)`, `import message from 'policy-helper';`,
      ));
      if (locked) {
        execFileSync('npm', ['install', '--package-lock-only', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
          cwd: target.cwd, env: target.env, stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    });
    target = publish(target, 'feature/pr-fixture', () => {
      writeFile(join(target.cwd, 'package.json'), JSON.stringify({
        name: 'untrusted-head', private: true,
        dependencies: { 'never-install-head': 'file:absent-head-package' },
        scripts: { preinstall: lifecycle, install: lifecycle },
      }));
    });
    const requests = await interceptGithub(context, target);
    const result = await check(target, ['--pr', '42'], { env: { NODE_ENV: 'production' } });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(evaluations(parseCheckOutput(result, 'installed policy')), [
      { rule: 'base', filepath: 'src/changed.txt', status: 'violation', message: 'Offline committed-base dependency policy' },
      { rule: 'global', filepath: 'src/changed.txt', status: 'violation', message: GLOBAL_MESSAGE },
    ]);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(posts(requests), []);
  });
}

test('npm installation and committed-policy import failures are CLI errors, never global-only fallbacks', async context => {
  for (const failure of ['install', 'import'] as const) {
    await context.test(failure, async child => {
      let target = fixture(child, `${failure}-failure`);
      target = publish(target, 'main', () => {
        if (failure === 'install') {
          writeFile(join(target.cwd, 'package.json'), '{"name":');
        } else {
          writeFile(join(target.cwd, '.rulekeeper/base.rule.ts'), policy(
            `() => violation(message)`, `import message from '../policy/missing-helper.ts';`,
          ));
        }
      });
      const requests = await interceptGithub(child, target);
      const result = await check(target, ['--pr', '42', '--auto-comment']);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, failure === 'install' ? /npm|install|ENOENT/i : /missing-helper|import|resolve/i);
      assert.deepEqual(posts(requests), []);
    });
  }
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
    rmSync(join(target.cwd, '.rulekeeper/base.rule.ts'));
    writeFile(join(target.cwd, '.rulekeeper/dotfiles.rule.ts'), `import { Rule, pass } from '@alex-dbs/rulekeeper';
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
  rmSync(join(target.home, '.rulekeeper/global.rule.ts'));
  writeFile(join(target.home, '.rulekeeper/base.rule.ts'), policy(`() => pass('Must not override trusted base')`));
  const requests = await interceptGithub(context, target);
  const result = await check(target, ['--pr', '42', '--auto-comment']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /matches 2 rule files/i);
  assert.equal(result.stdout, '');
  assert.deepEqual(posts(requests), []);
});
