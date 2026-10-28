import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { createPullRequestCheckout, type PullRequestCheckout } from '../dist/adapter/github/pull-request.js';
import { BASE_MESSAGE, commit, createPrFixture, git, interceptGithub, PR_NUMBER, PR_REPOSITORY, PR_TOKEN, PR_URL, type PrFixture } from './pr-support.ts';
import { createSandbox, writeFile, type Sandbox } from './support.ts';

const sandboxes = createSandbox('coderuler-pull-request-');
after(() => sandboxes.cleanup());

function fixture(context: TestContext, label: string): PrFixture {
  const target = createPrFixture(sandboxes, label);
  // os.tmpdir() reads the process environment, not the factory's captured env.
  // Keep every allocated parent observable inside this test's sandbox.
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = target.temporary;
  context.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  return target;
}

function prepare(target: PrFixture, cwd = target.cwd, env: NodeJS.ProcessEnv = target.env) {
  return createPullRequestCheckout(cwd, env);
}

function assertClean(target: PrFixture): void {
  assert.deepEqual(readdirSync(target.temporary).filter(name => name.startsWith('coderuler-pr-')), [], 'the entire allocated workspace must be removed');
}

async function checkout(context: TestContext, target: PrFixture, selector = '42', base?: string): Promise<PullRequestCheckout> {
  const result = await prepare(target)(selector, base);
  context.after(() => result.cleanup());
  return result;
}

function at(target: Sandbox, cwd: string): Sandbox {
  return { ...target, cwd };
}

function snapshot(target: PrFixture) {
  const paths = git(target, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  // Refresh stat information before capturing the index's bytes.
  const status = git(target, 'status', '--porcelain=v1', '--untracked-files=all');
  return {
    head: readFileSync(join(target.cwd, '.git/HEAD'), 'utf8'),
    commit: git(target, 'rev-parse', 'HEAD'),
    index: readFileSync(join(target.cwd, '.git/index')).toString('base64'),
    refs: git(target, 'for-each-ref', '--format=%(refname) %(objectname)'),
    status,
    files: [...new Set(paths)].sort().map(path => [path, existsSync(join(target.cwd, path)) ? readFileSync(join(target.cwd, path)).toString('base64') : null]),
  };
}

function cleanCaller(target: PrFixture): void {
  git(target, 'reset', '--hard', 'HEAD');
  rmSync(join(target.cwd, '.coderuler/caller-only.rule.ts'));
}

test('numeric SSH origin materializes complete committed trees and only merge-base changes', async context => {
  const target = fixture(context, 'numeric-ssh');
  const requests = await interceptGithub(context, target);
  const before = snapshot(target);
  const result = await checkout(context, target);
  assert.deepEqual(result.pullRequest, { repository: PR_REPOSITORY, number: PR_NUMBER, head: target.head });
  assert.equal(dirname(result.root), dirname(result.rulesRoot));
  assert.equal(dirname(result.root).startsWith(join(target.temporary, 'coderuler-pr-')), true);
  assert.equal(lstatSync(join(result.root, '.git')).isDirectory(), true, 'head must be the main repository, not a linked worktree');
  assert.equal(lstatSync(join(result.rulesRoot, '.git')).isFile(), true);
  assert.equal(git(at(target, result.root), 'remote', 'get-url', '--push', 'origin'), target.remote);
  assert.equal(readFileSync(join(result.root, '.git/config'), 'utf8').includes(`git@github.com:${PR_REPOSITORY}.git`), true, 'retain validated SSH transport rather than deriving HTTPS');
  assert.equal(git(at(target, result.root), 'rev-parse', 'HEAD'), target.head);
  assert.equal(git(at(target, result.rulesRoot), 'rev-parse', 'HEAD'), target.main);
  assert.equal(git(at(target, result.root), 'rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(readFileSync(join(result.root, 'src/changed.txt'), 'utf8'), 'BAD changed by the PR\n');
  assert.equal(existsSync(join(result.root, 'src/base-only.txt')), false);
  assert.match(readFileSync(join(result.root, 'policy/helper.ts'), 'utf8'), /UNTRUSTED PR-head helper/);
  assert.match(readFileSync(join(result.rulesRoot, 'policy/helper.ts'), 'utf8'), new RegExp(BASE_MESSAGE));
  assert.equal(readFileSync(join(result.rulesRoot, 'src/base-only.txt'), 'utf8'), 'BAD added only on main\n');
  assert.equal(existsSync(join(result.rulesRoot, '.coderuler/head-only.rule.ts')), false);
  assert.equal(existsSync(join(result.rulesRoot, '.coderuler/caller-only.rule.ts')), false);
  assert.deepEqual([...result.changedFiles].sort(), ['policy/helper.ts', 'src/changed.txt']);
  assert.deepEqual([...result.changedLines], [
    ['policy/helper.ts', [{ start: 1, end: 1 }]],
    ['src/changed.txt', [{ start: 1, end: 1 }]],
  ]);
  assert.deepEqual(requests.map(request => [request.method, request.url, request.authorization]), [
    ['GET', `/repos/${PR_REPOSITORY}/pulls/42`, `Bearer ${PR_TOKEN}`],
  ]);
  assert.deepEqual(snapshot(target), before);
  const parent = dirname(result.root);
  await result.cleanup();
  assert.equal(existsSync(parent), false);
  assertClean(target);
});

test('canonical URL works outside a repository, ignores query and fragment, and permits anonymous metadata', async context => {
  const target = fixture(context, 'url-outside');
  const requests = await interceptGithub(context, target);
  const outside = join(target.root, 'outside');
  mkdirSync(outside);
  const result = await prepare(target, outside, { ...target.env, GITHUB_TOKEN: '   ' })(`${PR_URL}/?tab=files#diff`);
  context.after(() => result.cleanup());
  assert.deepEqual(result.pullRequest, { repository: PR_REPOSITORY, number: 42, head: target.head });
  assert.equal(readFileSync(join(result.root, '.git/config'), 'utf8').includes(`https://github.com/${PR_REPOSITORY}.git`), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.authorization, undefined);
  await result.cleanup();
  assertClean(target);
});

test('checkout identity carries the fetched Git revision rather than earlier API metadata', async context => {
  const target = fixture(context, 'stale-head-metadata');
  await interceptGithub(context, target, { metadata: { base: { ref: 'main' }, head: { sha: target.base } } });
  const result = await checkout(context, target);
  assert.notEqual(target.base, target.head);
  assert.equal(result.pullRequest.head, target.head);
  assert.equal(result.pullRequest.head, git(at(target, result.root), 'rev-parse', 'HEAD'));
});

test('explicit base selects the branch tip policy and its distinct merge-base, not the default branch', async context => {
  const target = fixture(context, 'release-ancestry');
  cleanCaller(target);
  git(target, 'checkout', 'release');
  writeFile(join(target.cwd, 'src/release-shared.txt'), 'BAD shared with release\n');
  const release = commit(target, 'release source also in PR history');
  git(target, 'checkout', 'feature/pr-fixture');
  git(target, 'merge', '-s', 'ours', '--no-commit', 'release');
  writeFile(join(target.cwd, 'src/release-shared.txt'), 'BAD shared with release\n');
  const head = commit(target, 'merge release source into PR history');
  git(target, 'push', target.remote, 'release:refs/heads/release', `${head}:refs/pull/42/head`);
  await interceptGithub(context, target);
  const main = await checkout(context, target);
  const selected = await checkout(context, target, '42', 'release');
  assert.equal(git(at(target, selected.rulesRoot), 'rev-parse', 'HEAD'), release);
  assert.match(readFileSync(join(selected.rulesRoot, '.coderuler/base.rule.ts'), 'utf8'), /Committed release policy/);
  assert.deepEqual([...main.changedFiles].sort(), ['policy/helper.ts', 'src/changed.txt', 'src/release-shared.txt']);
  assert.deepEqual([...selected.changedFiles].sort(), ['policy/helper.ts', 'src/changed.txt']);
  assert.deepEqual([...main.changedLines], [
    ['policy/helper.ts', [{ start: 1, end: 1 }]],
    ['src/changed.txt', [{ start: 1, end: 1 }]],
    ['src/release-shared.txt', [{ start: 1, end: 1 }]],
  ]);
  assert.deepEqual([...selected.changedLines], [
    ['policy/helper.ts', [{ start: 1, end: 1 }]],
    ['src/changed.txt', [{ start: 1, end: 1 }]],
  ]);
});

test('missing or malformed default metadata fails, but explicit branch does not depend on base.ref', async context => {
  for (const metadata of [{}, { base: null }, { base: {} }, { base: { ref: 42 } }, { base: { ref: '' } }]) {
    await context.test(JSON.stringify(metadata), async child => {
      const target = fixture(child, 'metadata');
      const requests = await interceptGithub(child, target, { metadata });
      await assert.rejects(prepare(target)('42'), /pull request|response|base/i);
      assertClean(target);
      const result = await checkout(child, target, '42', 'release');
      assert.equal(git(at(target, result.rulesRoot), 'rev-parse', 'HEAD'), target.release);
      assert.equal(requests.length, 2, 'an override must still fetch PR metadata');
    });
  }
});

test('missing and inaccessible PR metadata fails even with an explicit base and leaves no workspace', async context => {
  for (const status of [404, 403, 500]) {
    await context.test(String(status), async child => {
      const target = fixture(child, `api-${status}`);
      const requests = await interceptGithub(child, target, { metadataStatus: status });
      await assert.rejects(prepare(target)('42', 'main'), /GitHub|HTTP|request/i);
      assert.equal(requests.length, 1);
      assertClean(target);
    });
  }
});

test('unsafe and malformed selectors fail before API access or workspace allocation', async context => {
  const target = fixture(context, 'selectors');
  const requests = await interceptGithub(context, target);
  const invalid = [
    '', '0', '-1', '+42', '1.5', '1e2', '9007199254740992', ' 42 ', 'main', '--help',
    'https://example.com/owner/project/pull/42', 'http://github.com/owner/project/pull/42',
    'https://user:secret@github.com/owner/project/pull/42', 'https://github.com:444/owner/project/pull/42',
    'https://github.com/owner/project/issues/42', 'https://github.com/owner/project/pull/0',
    'https://github.com/owner/project/pull/42/files', 'https://github.com/owner/project/pull/42//',
    'https://github.com/owner/project/pull/9007199254740992', 'https://github.com/owner/project/pull/4%32',
    'https://github.com/owner/project/pull/42/../../pull/42', 'https://github.com/owner/%2e%2e/pull/42',
  ];
  for (const selector of invalid) {
    await assert.rejects(prepare(target)(selector), { message: '--pr must be a positive pull request number or a GitHub pull request URL.' }, selector);
    assertClean(target);
  }
  assert.deepEqual(requests, []);
});

test('numeric selectors require a supported origin before metadata or allocation', async context => {
  const target = fixture(context, 'origin');
  const requests = await interceptGithub(context, target);
  git(target, 'remote', 'remove', 'origin');
  await assert.rejects(prepare(target)('42'), /origin|Git/i);
  git(target, 'remote', 'add', 'origin', 'https://example.com/owner/project.git');
  await assert.rejects(prepare(target)('42'), /origin|github/i);
  const outside = join(target.root, 'outside');
  mkdirSync(outside);
  await assert.rejects(prepare(target, outside)('42'), /Git|repository/i);
  assert.deepEqual(requests, []);
  assertClean(target);
});

test('invalid or unavailable selected branches fail instead of falling back to local HEAD', async context => {
  const target = fixture(context, 'branches');
  await interceptGithub(context, target);
  const before = snapshot(target);
  for (const branch of ['', '../main', '--help', 'main:refs/heads/other', 'HEAD', 'origin/main', 'missing-branch']) {
    await assert.rejects(prepare(target)('42', branch), /Git|branch|ref/i, branch);
    assertClean(target);
    assert.deepEqual(snapshot(target), before);
  }
});

test('missing PR head and unrelated histories fail and clean their temporary repositories', async context => {
  await context.test('missing PR head', async child => {
    const target = fixture(child, 'missing-head');
    await interceptGithub(child, target);
    git(target, '--git-dir', target.remote, 'update-ref', '-d', 'refs/pull/42/head');
    await assert.rejects(prepare(target)('42'), /Git|ref|fetch/i);
    assertClean(target);
  });
  await context.test('no merge-base', async child => {
    const target = fixture(child, 'unrelated');
    await interceptGithub(child, target);
    const orphan = sandboxes.isolated('orphan', target.env);
    git(orphan, 'init', '--initial-branch=orphan');
    git(orphan, 'config', 'user.name', 'CodeRuler tests');
    git(orphan, 'config', 'user.email', 'tests@example.invalid');
    git(orphan, 'config', 'commit.gpgsign', 'false');
    writeFile(join(orphan.cwd, 'src/unrelated.txt'), 'unrelated\n');
    const head = commit(orphan, 'unrelated history');
    git(orphan, 'push', target.remote, `${head}:refs/pull/42/head`, '--force');
    await assert.rejects(prepare(target)('42'), /Git|merge-base/i);
    assertClean(target);
  });
});

test('unavailable Git fails without modifying the caller or leaving a workspace', async context => {
  const target = fixture(context, 'missing-git');
  const requests = await interceptGithub(context, target);
  const before = snapshot(target);
  const emptyPath = join(target.root, 'empty-bin');
  mkdirSync(emptyPath);
  await assert.rejects(prepare(target, target.cwd, { ...target.env, PATH: emptyPath })('42'), /Git|git|ENOENT/);
  assert.deepEqual(requests, []);
  assertClean(target);
  assert.deepEqual(snapshot(target), before);
});

test('inherited Git repository locations cannot redirect head, diff, base, or caller mutations', async context => {
  const target = fixture(context, 'location-isolation');
  await interceptGithub(context, target);
  writeFile(join(target.cwd, 'src/staged.txt'), 'caller staged contents\n');
  git(target, 'add', 'src/staged.txt');
  writeFile(join(target.cwd, 'src/changed.txt'), 'dirty caller worktree\n');
  const before = snapshot(target);
  const inherited = {
    GIT_DIR: join(target.cwd, '.git'), GIT_WORK_TREE: target.cwd, GIT_COMMON_DIR: join(target.cwd, '.git'),
    GIT_INDEX_FILE: join(target.cwd, '.git/index'), GIT_OBJECT_DIRECTORY: join(target.cwd, '.git/objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(target.root, 'missing-objects'), GIT_SHALLOW_FILE: join(target.root, 'missing-shallow'),
    GIT_GRAFT_FILE: join(target.root, 'missing-graft'), GIT_IMPLICIT_WORK_TREE: '0', GIT_PREFIX: 'wrong/',
    GIT_REPLACE_REF_BASE: 'refs/wrong/', GIT_NO_REPLACE_OBJECTS: '1', GIT_NAMESPACE: 'wrong',
    GIT_CONFIG: join(target.root, 'missing-config'),
  };
  const result = await prepare(target, target.cwd, { ...target.env, ...inherited })('42');
  context.after(() => result.cleanup());
  assert.equal(git(at(target, result.root), 'rev-parse', 'HEAD'), target.head);
  assert.equal(git(at(target, result.rulesRoot), 'rev-parse', 'HEAD'), target.main);
  assert.deepEqual([...result.changedFiles].sort(), ['policy/helper.ts', 'src/changed.txt']);
  assert.equal(readFileSync(join(result.root, 'src/changed.txt'), 'utf8'), 'BAD changed by the PR\n');
  await result.cleanup();
  assertClean(target);
  assert.deepEqual(snapshot(target), before);
});

test('core.worktree command-scope overrides are refused before any workspace is allocated', async context => {
  for (const channel of ['count', 'parameters', 'empty'] as const) {
    await context.test(channel, async child => {
      const target = fixture(child, `worktree-${channel}`);
      const requests = await interceptGithub(child, target);
      const before = snapshot(target);
      const extra = channel === 'parameters'
        ? { GIT_CONFIG_PARAMETERS: `'core.worktree=${target.cwd}'` }
        : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: channel === 'empty' ? '' : target.cwd };
      await assert.rejects(prepare(target, target.cwd, { ...target.env, ...extra })('42'), {
        message: 'PR checkout requires Git core.worktree to be unset; remove the inherited repository-location override.',
      });
      assertClean(target);
      assert.equal(requests.some(request => request.method === 'POST'), false);
      assert.deepEqual(snapshot(target), before);
    });
  }
});

test('ordinary credential configuration survives both command-scope Git config channels', async context => {
  for (const channel of ['count', 'parameters'] as const) {
    await context.test(channel, async child => {
      const target = fixture(child, `credentials-${channel}`);
      await interceptGithub(child, target);
      const extra = channel === 'count'
        ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'fixture-helper' }
        : { GIT_CONFIG_PARAMETERS: "'credential.helper=fixture-helper'" };
      const env = { ...target.env, ...extra };
      const result = await prepare(target, target.cwd, env)('42');
      child.after(() => result.cleanup());
      assert.equal(git({ ...target, cwd: result.root, env }, 'config', '--get', 'credential.helper'), 'fixture-helper');
      assert.deepEqual([...result.changedFiles].sort(), ['policy/helper.ts', 'src/changed.txt']);
      await result.cleanup();
      assertClean(target);
    });
  }
});

test('base and invocation-local core.worktree config are checked before checkout', async context => {
  await context.test('invocation local config', async child => {
    const target = fixture(child, 'local-worktree');
    await interceptGithub(child, target);
    const before = snapshot(target);
    git(target, 'config', 'core.worktree', target.cwd);
    await assert.rejects(prepare(target)('42'), /core\.worktree.*unset/);
    assertClean(target);
    assert.deepEqual(snapshot(target), before);
  });
  await context.test('temporary repository conditional config', async child => {
    const target = fixture(child, 'temporary-worktree');
    await interceptGithub(child, target);
    const before = snapshot(target);
    const config = join(target.home, 'temporary-checkout.gitconfig');
    writeFile(config, `${readFileSync(config, 'utf8')}\n[core]\n\tworktree = ${JSON.stringify(target.cwd)}\n`);
    await assert.rejects(prepare(target)('42'), /core\.worktree.*unset/);
    assertClean(target);
    assert.deepEqual(snapshot(target), before);
  });
  await context.test('base linked-worktree conditional config', async child => {
    const target = fixture(child, 'base-worktree');
    await interceptGithub(child, target);
    const before = snapshot(target);
    const globalConfig = join(target.home, '.gitconfig');
    const baseConfig = join(target.home, 'base-location.gitconfig');
    writeFile(baseConfig, `[core]\n\tworktree = ${JSON.stringify(target.cwd)}\n`);
    writeFile(globalConfig, `${readFileSync(globalConfig, 'utf8')}\n[includeIf "gitdir:**/coderuler-pr-*/head/.git/worktrees/base"]\n\tpath = ${JSON.stringify(baseConfig)}\n`);
    await assert.rejects(prepare(target)('42'), /core\.worktree.*unset/);
    assertClean(target);
    assert.deepEqual(snapshot(target), before);
  });
});
