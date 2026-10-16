import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';

import { createSourceRepository } from './adapter/filesystem/sources.ts';
import type { Context } from './app/rule/types.ts';
import { PluginRegistry } from './app/scope/registry.ts';
import type { ScopeMatch, ScopePlugin } from './app/scope/types.ts';
import { compileRule } from './infra/rules.ts';
import { createSandbox, isolatedEnv, runGit, writeFile, type SandboxRoot } from '../tests/support.ts';

const selects = { count: 0 };

const kvPlugin: ScopePlugin = {
  format: 'kv',
  compile(options) {
    const { prefix } = options;
    if (typeof prefix !== 'string' || prefix === '') {
      throw new Error('kv scope requires a non-empty "prefix" string');
    }
    return {
      select({ source }): readonly ScopeMatch[] {
        selects.count += 1;
        const scopes: ScopeMatch[] = [];
        for (const line of source.split('\n')) {
          if (!line.startsWith(prefix)) continue;
          const body = line.slice(prefix.length);
          const separator = body.indexOf('=');
          const key = separator === -1 ? body : body.slice(0, separator);
          if (key === '') continue;
          scopes.push({
            id: key,
            source: line,
            data: { key, value: separator === -1 ? null : body.slice(separator + 1) },
          });
        }
        return scopes;
      },
    };
  },
};

const registry = new PluginRegistry([kvPlugin]);

const RULE_FILE = '/rules/matching.yaml';

const DEFINITION: Record<string, unknown> = {
  version: 'v1',
  files: { included: ['src/**'] },
  scope: { format: 'kv', prefix: '+' },
  check: { kind: 'AI', rule: 'p' },
};

function kvRule(fields: Record<string, unknown> = {}, files: unknown = { included: ['src/**'] }) {
  selects.count = 0;
  return compileRule({ ...DEFINITION, files, ...fields }, RULE_FILE, registry);
}

interface Observation {
  readonly id: string;
  readonly accepted: boolean;
  readonly context: Context;
}

type Observer = (context: Context, accepted: boolean) => void;

const NO_RULE_PATHS: ReadonlySet<string> = new Set();

test('the observer sees every selected scope once with its filter verdict, and accepted contexts are the returned ones', () => {
  const rule = kvRule({ filter: { non_empty: '$.data.value' } });
  const seen: Observation[] = [];
  const returned = rule.match(
    { filepath: 'src/a.txt', source: '+a=1\n+b=\n+c=3\n' },
    {
      onScope: (context, accepted) => {
        seen.push({ id: context.scope.id, accepted, context });
      },
    },
  );

  assert.deepEqual(seen.map(({ id, accepted }) => [id, accepted]), [['a', true], ['b', false], ['c', true]]);
  assert.deepEqual(returned.map(context => context.scope.id), ['a', 'c']);
  assert.strictEqual(seen[0]!.context, returned[0]);
  assert.strictEqual(seen[2]!.context, returned[1]);
  assert.ok(!returned.includes(seen[1]!.context));
  assert.ok(seen.every(({ context }) => context.filepath === 'src/a.txt'));
  assert.ok(seen.every(({ context }) => !('diff' in context)));
  assert.strictEqual(selects.count, 1);
});

test('an observed match parses once and returns what an unobserved match returns', () => {
  const source = '+a=1\n+b=\n+c=3\n';
  const filter = { non_empty: '$.data.value' };
  const seen: Observation[] = [];
  const observed = kvRule({ filter }).match(
    { filepath: 'src/a.txt', source },
    {
      onScope: (context, accepted) => {
        seen.push({ id: context.scope.id, accepted, context });
      },
    },
  );
  const parsedForObserved = selects.count;
  const plain = kvRule({ filter }).match({ filepath: 'src/a.txt', source });

  assert.strictEqual(parsedForObserved, 1);
  assert.strictEqual(selects.count, 1);
  assert.deepEqual(plain.map(context => context.scope.id), observed.map(context => context.scope.id));
  assert.deepEqual(seen.map(({ id, accepted }) => [id, accepted]), [['a', true], ['b', false], ['c', true]]);
});

test('a scope the base comparison skips is never observed, and each revision is parsed once', () => {
  const rule = kvRule({ scope: { format: 'kv', prefix: '+', changed: true } });
  const seen: Observation[] = [];
  const returned = rule.match(
    { filepath: 'src/a.txt', diff: '@@ -1 +1 @@', head: '+a=1\n+b=2\n', base: '+a=1\n+b=9\n' },
    {
      onScope: (context, accepted) => {
        seen.push({ id: context.scope.id, accepted, context });
      },
    },
  );

  assert.deepEqual(seen.map(({ id, accepted }) => [id, accepted]), [['b', true]]);
  assert.deepEqual(returned.map(context => context.scope.id), ['b']);
  assert.strictEqual(seen[0]!.context, returned[0]);
  assert.strictEqual(returned[0]!.diff, '@@ -1 +1 @@');
  assert.strictEqual(selects.count, 2);
});

test('unselected files, empty selections and a deleted head observe nothing', () => {
  const seen: Observation[] = [];
  const onScope: Observer = (context, accepted) => {
    seen.push({ id: context.scope.id, accepted, context });
  };

  const unselected = kvRule();
  assert.deepEqual(unselected.match({ filepath: 'other/a.txt', source: '+a=1\n' }, { onScope }), []);
  const empty = kvRule({}, { included: ['**/*.txt'] });
  assert.deepEqual(empty.match({ filepath: 'a.txt', source: 'plain\n' }, { onScope }), []);
  const deleted = kvRule({ decision: { group_by: 'file' } });
  assert.deepEqual(deleted.match({ filepath: 'src/a.txt', diff: '', head: '' }, { onScope }), []);

  assert.deepEqual(seen, []);
});

test('a filter that rejects every scope reports each rejection and returns no context', () => {
  const rule = kvRule({ filter: { non_empty: '$.data.value' } });
  const seen: Observation[] = [];
  const returned = rule.match(
    { filepath: 'src/a.txt', source: '+a=\n+b=\n' },
    {
      onScope: (context, accepted) => {
        seen.push({ id: context.scope.id, accepted, context });
      },
    },
  );

  assert.deepEqual(seen.map(({ id, accepted }) => [id, accepted]), [['a', false], ['b', false]]);
  assert.deepEqual(returned, []);
  assert.strictEqual(selects.count, 1);
});

test('an unusable onScope is rejected before any scope is parsed', () => {
  const rule = kvRule();
  assert.throws(
    () => rule.match({ filepath: 'src/a.txt', source: '+a=1\n' }, { onScope: 'nope' as unknown as Observer }),
    /Match options\.onScope must be a function/,
  );
  assert.strictEqual(selects.count, 0);
});

let sandbox!: SandboxRoot;
let folder = '';

before(() => {
  sandbox = createSandbox('rulekeeper-inspect-matching-');
  mkdirSync(join(sandbox.root, 'home'), { recursive: true });
  folder = join(sandbox.root, 'folder');
  writeFile(join(folder, 'a.txt'), 'a\n');
  writeFile(join(folder, 'sub/b.txt'), 'b\n');
  writeFile(join(folder, 'sub/deep/c.txt'), 'c\n');
  writeFile(join(folder, 'notes.md'), 'n\n');
  writeFile(join(folder, 'node_modules/skip.txt'), 's\n');
});

after(() => {
  sandbox.cleanup();
});

test('an explicit folder root anchors rule globs and logical paths, and reads stay lazy', async () => {
  const rule = kvRule({}, { included: ['**/*.txt'] });
  const sources = createSourceRepository({ cwd: folder });
  const jobs = await sources.treeJobs({
    target: '.',
    rulePaths: NO_RULE_PATHS,
    select: logical => (rule.matchesFile(logical) ? [0] : []),
  });

  assert.deepEqual(jobs.map(job => job.logical), ['a.txt', 'sub/b.txt', 'sub/deep/c.txt']);
  assert.ok(jobs.every(job => job.kind === 'tree' && job.rules.length === 1));
  assert.deepEqual(await jobs[0]!.read(), { filepath: 'a.txt', source: 'a\n' });
  assert.deepEqual(await jobs[2]!.read(), { filepath: 'sub/deep/c.txt', source: 'c\n' });
  writeFile(join(folder, 'sub/deep/c.txt'), 'c2\n');
  assert.deepEqual(await jobs[2]!.read(), { filepath: 'sub/deep/c.txt', source: 'c2\n' });
});

test('an explicit folder root resolves relative targets and rule descriptor paths', async () => {
  const rule = kvRule({}, { included: ['**/*.txt'] });
  const sources = createSourceRepository({ cwd: folder });
  const select = (logical: string): readonly number[] => (rule.matchesFile(logical) ? [0] : []);

  const nested = await sources.treeJobs({ target: 'sub', rulePaths: NO_RULE_PATHS, select });
  assert.deepEqual(nested.map(job => job.logical), ['sub/b.txt', 'sub/deep/c.txt']);

  const descriptors = await sources.treeJobs({
    target: '.',
    rulePaths: new Set([join(folder, 'a.txt')]),
    select,
  });
  assert.deepEqual(descriptors.map(job => job.logical), ['sub/b.txt', 'sub/deep/c.txt']);

  await assert.rejects(
    sources.treeJobs({ target: 'missing', rulePaths: NO_RULE_PATHS, select }),
    (error: unknown) => error instanceof Error && error.message.includes(join(folder, 'missing')),
  );
});

test('an omitted cwd keeps the ambient working directory as the root, without changing it', async () => {
  const ambient = process.cwd();
  const select = (logical: string): readonly number[] => (logical.endsWith('.txt') ? [0] : []);
  const expected = ['a.txt', 'sub/b.txt', 'sub/deep/c.txt'].map(path =>
    relative(ambient, join(folder, path)).split(sep).join('/'));

  const ambientJobs = await createSourceRepository().treeJobs({
    target: folder,
    rulePaths: NO_RULE_PATHS,
    select,
  });
  assert.deepEqual(ambientJobs.map(job => job.logical), expected);

  const anchoredJobs = await createSourceRepository({ cwd: folder }).treeJobs({
    target: folder,
    rulePaths: NO_RULE_PATHS,
    select,
  });
  assert.deepEqual(anchoredJobs.map(job => job.logical), ['a.txt', 'sub/b.txt', 'sub/deep/c.txt']);

  assert.strictEqual(process.cwd(), ambient);
});

test('an explicit cwd anchors branch diffs and their logical paths', async () => {
  const repo = join(sandbox.root, 'repo');
  mkdirSync(repo, { recursive: true });
  const env = isolatedEnv(join(sandbox.root, 'home'));
  runGit(repo, ['init', '-q', '-b', 'main'], env);
  writeFile(join(repo, 'app.txt'), '+a=1\n');
  runGit(repo, ['add', '-A'], env);
  runGit(repo, ['commit', '-q', '--no-gpg-sign', '-m', 'one'], env);
  writeFile(join(repo, 'app.txt'), '+a=2\n');
  runGit(repo, ['add', '-A'], env);
  runGit(repo, ['commit', '-q', '--no-gpg-sign', '-m', 'two'], env);

  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
  try {
    const rule = kvRule({}, { included: ['**/*.txt'] });
    const sources = createSourceRepository({ cwd: repo });
    const jobs = await sources.diffJobs({
      target: '.',
      base: 'HEAD~1',
      rulePaths: NO_RULE_PATHS,
      select: logical => (rule.matchesFile(logical) ? [0] : []),
    });

    assert.deepEqual(jobs.map(job => job.logical), ['app.txt']);
    const input = await jobs[0]!.read();
    assert.strictEqual(input.filepath, 'app.txt');
    assert.strictEqual(input.head, '+a=2\n');
    assert.strictEqual(input.base, '+a=1\n');
    assert.match(input.diff, /\+a=2/);

    await assert.rejects(
      sources.diffJobs({ target: join(sandbox.root, 'folder'), rulePaths: NO_RULE_PATHS, select: () => [0] }),
      /is outside the repository/,
    );
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
