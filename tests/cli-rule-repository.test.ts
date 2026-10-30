import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  createSandbox,
  expectFailure,
  parseCheckOutput,
  runCli,
  writeFile,
} from './support.ts';
import type { CliResult, Sandbox } from './support.ts';

const sandbox = createSandbox('coderuler-cli-rule-repository-');
after(() => sandbox.cleanup());

interface RuleRepositoryFixture {
  readonly target: Sandbox;
  readonly temporary: string;
  readonly remote: string;
  readonly source: string;
  readonly olderCommit: string;
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd: string, env: NodeJS.ProcessEnv, message: string): string {
  git(cwd, env, 'add', '--all');
  git(cwd, env, 'commit', '-m', message);
  return git(cwd, env, 'rev-parse', 'HEAD');
}

function rootRule(): string {
  return `import { Rule, pass, violation } from '@alex-dbs/coderuler';
export default class Root extends Rule {
  files = ['src/*.txt'];
  check = async subject => {
    const { message } = await import('./helper.ts');
    return message && subject.source.includes('BAD') ? violation(message) : pass();
  };
}
`;
}

function nestedRule(): string {
  return `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Nested extends Rule {
  files = ['src/*.txt'];
  check = () => pass();
}
`;
}

function createRuleRepository(label: string): RuleRepositoryFixture {
  const isolated = sandbox.isolated(label);
  const temporary = join(isolated.root, 'tmp');
  mkdirSync(temporary, { recursive: true });
  const inheritedGit = Object.fromEntries(
    Object.keys(process.env).filter(key => key.startsWith('GIT_')).map(key => [key, undefined]),
  );
  const globalConfig = join(isolated.home, '.gitconfig');
  const remote = join(isolated.root, 'rules.git');
  const target: Sandbox = {
    ...isolated,
    env: {
      ...isolated.env,
      ...inheritedGit,
      TMPDIR: temporary,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfig,
    },
  };
  writeFile(globalConfig, `[url ${JSON.stringify(remote)}]\n\tinsteadOf = https://rules.example.invalid/team/policies.git\n\tinsteadOf = https://rules.example.invalid/team/policies\n\tinsteadOf = ssh://git@rules.example.invalid/team/policies.git\n\tinsteadOf = ssh://git@rules.example.invalid:2222/team/policies\n\tinsteadOf = git@rules.example.invalid:team/policies.git\n\tinsteadOf = git@rules.example.invalid:team/policies\n`);

  const source = join(isolated.root, 'policy-source');
  mkdirSync(source, { recursive: true });
  git(source, target.env, 'init', '--initial-branch=main');
  git(source, target.env, 'config', 'user.name', 'CodeRuler tests');
  git(source, target.env, 'config', 'user.email', 'tests@example.invalid');
  git(source, target.env, 'config', 'commit.gpgsign', 'false');
  writeFile(join(source, 'root.rule.ts'), rootRule());
  writeFile(join(source, 'nested/nested.rule.ts'), nestedRule());
  writeFile(join(source, 'helper.ts'), 'export const message = undefined;\n');
  const olderCommit = commit(source, target.env, 'passing remote rules');
  git(source, target.env, 'branch', 'release/rules');
  git(source, target.env, 'branch', 'tag');
  git(source, target.env, 'tag', '-a', 'v1.0.0', '-m', 'passing rules');
  git(source, target.env, 'tag', '-a', 'shared', '-m', 'shared tag');
  git(source, target.env, 'branch', '+name');
  writeFile(join(source, 'helper.ts'), "export const message = 'Remote policy rejects BAD';\n");
  commit(source, target.env, 'rejecting remote rules');
  git(source, target.env, 'branch', 'shared');

  git(target.cwd, target.env, 'init', '--bare', remote);
  git(target.cwd, target.env, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(target.cwd, target.env, '--git-dir', remote, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  git(source, target.env, 'push', remote, '--all');
  git(source, target.env, 'push', remote, '--tags');

  writeFile(join(target.cwd, 'src/example.txt'), 'BAD\n');
  writeFile(join(target.cwd, '.coderuler/local.rule.ts'), "throw new Error('Consumer policy must not load');\n");
  writeFile(join(target.home, '.coderuler/home.rule.ts'), "throw new Error('Home policy must not load');\n");
  return { target, temporary, remote, source, olderCommit };
}

function appendTransportRewrite(fixture: RuleRepositoryFixture, selector: string, remote: string): void {
  appendFileSync(
    fixture.target.env.GIT_CONFIG_GLOBAL!,
    `\n[url ${JSON.stringify(remote)}]\n\tinsteadOf = ${selector}\n`,
  );
}

function createVariantRemote(
  fixture: RuleRepositoryFixture,
  label: string,
  change: (source: string) => void,
): string {
  const source = join(fixture.target.root, `${label}-source`);
  const remote = join(fixture.target.root, `${label}.git`);
  git(fixture.target.cwd, fixture.target.env, 'clone', fixture.source, source);
  git(source, fixture.target.env, 'config', 'user.name', 'CodeRuler tests');
  git(source, fixture.target.env, 'config', 'user.email', 'tests@example.invalid');
  git(source, fixture.target.env, 'config', 'commit.gpgsign', 'false');
  change(source);
  commit(source, fixture.target.env, `${label} rule repository`);
  git(fixture.target.cwd, fixture.target.env, 'init', '--bare', remote);
  git(fixture.target.cwd, fixture.target.env, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(source, fixture.target.env, 'push', '--force', remote, 'HEAD:refs/heads/main');
  const selector = `https://rules.example.invalid/team/${label}.git`;
  appendTransportRewrite(fixture, selector, remote);
  return selector;
}

function createEmptyRemote(fixture: RuleRepositoryFixture, label: string): string {
  const remote = join(fixture.target.root, `${label}.git`);
  git(fixture.target.cwd, fixture.target.env, 'init', '--bare', remote);
  git(fixture.target.cwd, fixture.target.env, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const selector = `https://rules.example.invalid/team/${label}.git`;
  appendTransportRewrite(fixture, selector, remote);
  return selector;
}

function assertRuleReports(
  result: CliResult,
  label: string,
  rootStatus: 'pass' | 'violation',
  rootMessage: string | undefined,
): void {
  assert.equal(result.status, rootStatus === 'violation' ? 1 : 0, result.stderr);
  const reports = parseCheckOutput(result, label);
  assert.deepEqual(reports.map(report => ({
    name: report.name,
    status: report.status,
    evaluations: report.evaluations.map(({ subject, result: evaluation }) => {
      assert.equal(subject.kind, 'scope');
      if (subject.kind !== 'scope') throw new Error('Expected a file scope');
      return {
        filepath: subject.filepath,
        status: evaluation.status,
        message: evaluation.message,
      };
    }),
  })), [
    {
      name: 'nested',
      status: 'pass',
      evaluations: [{ filepath: 'src/example.txt', status: 'pass', message: undefined }],
    },
    {
      name: 'root',
      status: rootStatus,
      evaluations: [{ filepath: 'src/example.txt', status: rootStatus, message: rootMessage }],
    },
  ]);
}

function assertNoRuleWorkspace(fixture: RuleRepositoryFixture, label: string): void {
  assert.deepEqual(
    readdirSync(fixture.temporary).filter(name => name.startsWith('coderuler-rules-')),
    [],
    `${label}: rule checkout workspace should be removed`,
  );
}

function assertFailure(result: CliResult, label: string, diagnostic?: string | RegExp): void {
  expectFailure(result, label);
  if (diagnostic === undefined) return;
  if (typeof diagnostic === 'string') {
    assert.ok(result.stderr.includes(diagnostic), `${label}: expected diagnostic '${diagnostic}' (${result.stderr})`);
  } else {
    assert.match(result.stderr, diagnostic);
  }
}

function snapshotTree(root: string): readonly (readonly [string, string])[] {
  const files: Array<readonly [string, string]> = [];
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path, relative);
      else if (entry.isFile()) files.push([relative, readFileSync(path).toString('base64')]);
    }
  };
  visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function callerGitSnapshot(fixture: RuleRepositoryFixture): unknown {
  const gitDirectory = join(fixture.target.cwd, '.git');
  return {
    head: git(fixture.target.cwd, fixture.target.env, 'rev-parse', 'HEAD'),
    index: readFileSync(join(gitDirectory, 'index')).toString('base64'),
    entries: git(fixture.target.cwd, fixture.target.env, 'ls-files', '--stage'),
    status: git(fixture.target.cwd, fixture.target.env, 'status', '--porcelain'),
    source: ['.coderuler/local.rule.ts', 'package.json', 'src/example.txt'].map(path => [
      path,
      readFileSync(join(fixture.target.cwd, path)).toString('base64'),
    ]),
    objects: snapshotTree(join(gitDirectory, 'objects')),
  };
}

test('loads repository default rules', async () => {
  const fixture = createRuleRepository('default-branch');
  const result = await runCli([
    'check', '.', '--rules', 'https://rules.example.invalid/team/policies.git', '--json', '--output-all',
  ], fixture.target);

  assert.equal(result.status, 1, result.stderr);
  const reports = parseCheckOutput(result, 'repository default branch');
  assert.deepEqual(reports.map(report => ({
    name: report.name,
    status: report.status,
    evaluations: report.evaluations.map(({ subject, result: evaluation }) => {
      assert.equal(subject.kind, 'scope');
      if (subject.kind !== 'scope') throw new Error('Expected a file scope');
      return {
        filepath: subject.filepath,
        status: evaluation.status,
        message: evaluation.message,
      };
    }),
  })), [
    {
      name: 'nested',
      status: 'pass',
      evaluations: [{ filepath: 'src/example.txt', status: 'pass', message: undefined }],
    },
    {
      name: 'root',
      status: 'violation',
      evaluations: [{ filepath: 'src/example.txt', status: 'violation', message: 'Remote policy rejects BAD' }],
    },
  ]);
  assert.deepEqual(readdirSync(fixture.temporary).filter(name => name.startsWith('coderuler-rules-')), []);
});

test('loads HTTPS and SSH repository URLs with optional .git and SCP-style selectors', async () => {
  const fixture = createRuleRepository('transport-forms');
  const selectors = [
    'https://rules.example.invalid/team/policies.git',
    'https://rules.example.invalid/team/policies',
    'ssh://git@rules.example.invalid/team/policies.git',
    'ssh://git@rules.example.invalid:2222/team/policies',
    'git@rules.example.invalid:team/policies',
  ];

  for (const [index, selector] of selectors.entries()) {
    const result = await runCli(['check', '.', '--rules', selector, '--json', '--output-all'], fixture.target);
    assertRuleReports(result, `repository transport ${index}`, 'violation', 'Remote policy rejects BAD');
    assertNoRuleWorkspace(fixture, `repository transport ${index}`);
  }
});

test('selects repository branches, tags and full commit revisions', async () => {
  const fixture = createRuleRepository('revision-selection');
  const olderSelectors = [
    `https://rules.example.invalid/team/policies.git#release/rules`,
    `https://rules.example.invalid/team/policies.git#v1.0.0`,
    `https://rules.example.invalid/team/policies.git#tag`,
    `https://rules.example.invalid/team/policies.git#${fixture.olderCommit}`,
    `https://rules.example.invalid/team/policies.git#shared`,
    `https://rules.example.invalid/team/policies.git#refs/tags/shared`,
    `https://rules.example.invalid/team/policies.git#refs/heads/+name`,
  ];

  for (const [index, selector] of olderSelectors.entries()) {
    const result = await runCli(['check', '.', '--rules', selector, '--json', '--output-all'], fixture.target);
    assertRuleReports(result, `older repository revision ${index}`, 'pass', undefined);
    assertNoRuleWorkspace(fixture, `older repository revision ${index}`);
  }

  const branch = await runCli([
    'check', '.', '--rules', 'https://rules.example.invalid/team/policies.git#refs/heads/shared', '--json', '--output-all',
  ], fixture.target);
  assertRuleReports(branch, 'shared branch revision', 'violation', 'Remote policy rejects BAD');
  assertNoRuleWorkspace(fixture, 'shared branch revision');

  const encoded = await runCli([
    'check', '.', '--rules', 'https://rules.example.invalid/team/policies.git#release%2Frules', '--json', '--output-all',
  ], fixture.target);
  assertFailure(encoded, 'repository revision is not URL-decoded', /fetch/i);
  assertNoRuleWorkspace(fixture, 'repository revision is not URL-decoded');
});

test('repository acquisition failures report no partial JSON and clean their workspaces', async () => {
  const fixture = createRuleRepository('acquisition-failures');
  const inaccessible = `https://rules.example.invalid/team/inaccessible.git`;
  appendTransportRewrite(fixture, inaccessible, join(fixture.target.root, 'missing-remote.git'));
  const empty = createEmptyRemote(fixture, 'empty-repository');
  const cases = [
    ['missing revision', 'https://rules.example.invalid/team/policies.git#missing-revision', /fetch/i],
    ['inaccessible transport', inaccessible, /fetch|repository|git/i],
    ['empty repository', empty, /fetch|repository|git/i],
  ] as const;

  for (const [label, selector, diagnostic] of cases) {
    const result = await runCli(['check', '.', '--rules', selector, '--json', '--output-all'], fixture.target);
    assertFailure(result, label, diagnostic);
    assertNoRuleWorkspace(fixture, label);
  }
});

test('repository loading and evaluation failures do not fall back or leave workspaces', async () => {
  const fixture = createRuleRepository('load-evaluation-failures');
  const noRules = createVariantRemote(fixture, 'no-rules', source => {
    rmSync(join(source, 'root.rule.ts'));
    rmSync(join(source, 'nested'), { recursive: true, force: true });
  });
  const duplicate = createVariantRemote(fixture, 'duplicate-rules', source => {
    writeFile(join(source, 'nested/root.rule.ts'), `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Root extends Rule {
  files = ['src/*.txt'];
  check = () => pass();
}
`);
  });
  const invalidImport = createVariantRemote(fixture, 'invalid-import', source => {
    writeFile(join(source, 'broken.rule.ts'), `import './missing-module.ts';
export default class Broken {}
`);
  });
  const evaluationFailure = createVariantRemote(fixture, 'evaluation-failure', source => {
    writeFile(join(source, 'helper.ts'), "throw new Error('Remote evaluation exploded');\n");
  });
  const cases = [
    ['repository without rule modules', noRules, /no rule files/i],
    ['duplicate repository rule names', duplicate, /matches 2 rule files/],
    ['invalid repository rule import', invalidImport, /missing-module/i],
    ['repository runtime evaluation error', evaluationFailure, /Remote evaluation exploded/],
  ] as const;

  for (const [label, selector, diagnostic] of cases) {
    const result = await runCli(['check', '.', '--rules', selector, '--json', '--output-all'], fixture.target);
    assertFailure(result, label, diagnostic);
    assertNoRuleWorkspace(fixture, label);
  }
});

test('rejects invalid repository URLs and revisions without leaking credentials', async () => {
  const fixture = createRuleRepository('invalid-selectors');
  const credentialUser = 'private-user';
  const credentialSecret = 'private-rule-password';
  const invalid = [
    ['empty revision', 'https://rules.example.invalid/team/policies.git#', 'Rule repository revision must not be empty.'],
    ['unsupported scheme', 'file:///tmp/policies.git', 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.'],
    ['URL query', 'https://rules.example.invalid/team/policies.git?token=private-rule-password', 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.'],
    ['HTTPS credentials', `https://${credentialUser}:${credentialSecret}@rules.example.invalid/team/policies.git`, 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.'],
    ['SSH password', `ssh://git:${credentialSecret}@rules.example.invalid/team/policies.git`, 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.'],
    ['malformed URL', 'https://[invalid-host/team/policies.git', 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.'],
    ['malformed URL credentials', `https:/${credentialUser}:${credentialSecret}@rules.example.invalid/team/policies.git`, 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.'],
    ['SCP selector missing host', 'git@:team/policies.git', 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.'],
    ['SCP selector missing path', 'git@rules.example.invalid:', 'Invalid rule repository URL; use HTTPS or SSH with Git credentials.'],
    ['leading refspec modifier', 'https://rules.example.invalid/team/policies.git#+refs/heads/main', 'Invalid rule repository revision.'],
    ['invalid ref syntax', 'https://rules.example.invalid/team/policies.git#bad..ref', 'Invalid rule repository revision.'],
  ] as const;

  for (const [label, selector, diagnostic] of invalid) {
    const result = await runCli(['check', '.', '--rules', selector, '--json', '--output-all'], fixture.target);
    assertFailure(result, label, diagnostic);
    assert.equal(result.stderr.includes(credentialUser), false, `${label}: credential username leaked`);
    assert.equal(result.stderr.includes(credentialSecret), false, `${label}: credential secret leaked`);
    assertNoRuleWorkspace(fixture, label);
  }
});

test('inherited Git location overrides cannot modify the caller repository', async () => {
  const fixture = createRuleRepository('inherited-git-locations');
  writeFile(join(fixture.target.cwd, '.gitignore'), 'node_modules/\n');
  git(fixture.target.cwd, fixture.target.env, 'init', '--initial-branch=main');
  git(fixture.target.cwd, fixture.target.env, 'config', 'user.name', 'CodeRuler tests');
  git(fixture.target.cwd, fixture.target.env, 'config', 'user.email', 'tests@example.invalid');
  git(fixture.target.cwd, fixture.target.env, 'config', 'commit.gpgsign', 'false');
  commit(fixture.target.cwd, fixture.target.env, 'caller state before remote rules');
  const before = callerGitSnapshot(fixture);
  const gitDirectory = join(fixture.target.cwd, '.git');
  const overrides: NodeJS.ProcessEnv = {
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: fixture.target.cwd,
    GIT_INDEX_FILE: join(gitDirectory, 'index'),
    GIT_OBJECT_DIRECTORY: join(gitDirectory, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDirectory, 'objects'),
    GIT_COMMON_DIR: gitDirectory,
  };

  const result = await runCli([
    'check', '.', '--rules', 'https://rules.example.invalid/team/policies.git', '--json', '--output-all',
  ], fixture.target, overrides);
  assertRuleReports(result, 'inherited Git location overrides', 'violation', 'Remote policy rejects BAD');
  assert.deepEqual(callerGitSnapshot(fixture), before);
  assertNoRuleWorkspace(fixture, 'inherited Git location overrides');
});

test('refuses inherited core.worktree configuration and cleans the checkout', async () => {
  const fixture = createRuleRepository('inherited-core-worktree');
  appendFileSync(
    fixture.target.env.GIT_CONFIG_GLOBAL!,
    `\n[core]\n\tworktree = ${fixture.target.cwd}\n`,
  );

  const result = await runCli([
    'check', '.', '--rules', 'https://rules.example.invalid/team/policies.git', '--json', '--output-all',
  ], fixture.target);
  assertFailure(
    result,
    'inherited core.worktree',
    'Rule repository checkout requires Git core.worktree to be unset; remove the inherited repository-location override.',
  );
  assertNoRuleWorkspace(fixture, 'inherited core.worktree');
});

test('reports unavailable Git when Node is launched with an empty PATH', async () => {
  const fixture = createRuleRepository('missing-git');
  assert.equal(process.execPath.startsWith('/'), true, 'runCli starts Node through its absolute executable path');
  const result = await runCli([
    'check', '.', '--rules', 'https://rules.example.invalid/team/policies.git', '--json', '--output-all',
  ], fixture.target, { PATH: '' });
  assertFailure(result, 'unavailable Git', /Cannot run Git/);
  assertNoRuleWorkspace(fixture, 'unavailable Git');
});

test('local rule paths keep literal # characters', async () => {
  const fixture = createRuleRepository('local-hash-path');
  writeFile(join(fixture.target.cwd, 'custom/hash#rule.rule.ts'), `import { Rule, pass } from '@alex-dbs/coderuler';
export default class HashPath extends Rule {
  files = ['src/*.txt'];
  check = () => pass();
}
`);

  const result = await runCli([
    'check', '.', '--rules', 'custom/hash#rule.rule.ts', '--json', '--output-all',
  ], fixture.target);
  assert.equal(result.status, 0, result.stderr);
  const reports = parseCheckOutput(result, 'local rule path with #');
  assert.deepEqual(reports.map(report => ({ name: report.name, status: report.status })), [
    { name: 'hash#rule', status: 'pass' },
  ]);
  const [evaluation] = reports[0]!.evaluations;
  assert.equal(evaluation?.subject.kind, 'scope');
  if (evaluation?.subject.kind !== 'scope') throw new Error('Expected a file scope');
  assert.equal(evaluation.subject.filepath, 'src/example.txt');
  assertNoRuleWorkspace(fixture, 'local rule path with #');
});
