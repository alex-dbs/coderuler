import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContextCollector } from './app/collect-contexts.ts';
import type { DiagnosticFields } from './app/ports/diagnostics.ts';
import type { Diagnostics } from './app/ports/diagnostics.ts';
import type { LoadedRule } from './app/ports/rules.ts';
import type {
  ContextCollector,
  DiffSourceJob,
  DiffSourceRequest,
  SourceProgress,
  SourceRepository,
  TreeSourceJob,
  TreeSourceRequest,
} from './app/ports/sources.ts';
import { parseRule } from './infra/rules.ts';

interface TreeFixture {
  readonly logical: string;
  readonly source: string;
}

interface DiffFixture {
  readonly logical: string;
  readonly previous: string;
  readonly base: string;
  readonly head: string;
  readonly diff: string;
}

interface MemoryRepository {
  readonly collector: ContextCollector;
  readonly treeRequests: TreeSourceRequest[];
  readonly diffRequests: DiffSourceRequest[];
  readonly reads: string[];
}

function memoryRepository(
  trees: readonly TreeFixture[],
  diffs: readonly DiffFixture[],
): MemoryRepository {
  const treeRequests: TreeSourceRequest[] = [];
  const diffRequests: DiffSourceRequest[] = [];
  const reads: string[] = [];
  const sources: SourceRepository = {
    identities: async (paths) => paths.map((path) => `${path}.real`),
    treeJobs: async (request): Promise<readonly TreeSourceJob[]> => {
      treeRequests.push(request);
      const jobs: TreeSourceJob[] = [];
      for (const fixture of trees) {
        const rules = request.select(fixture.logical);
        if (rules.length === 0) continue;
        jobs.push({
          kind: 'tree',
          logical: fixture.logical,
          rules,
          read: async () => {
            reads.push(fixture.logical);
            return { filepath: fixture.logical, source: fixture.source };
          },
        });
      }
      return jobs;
    },
    diffJobs: async (request): Promise<readonly DiffSourceJob[]> => {
      diffRequests.push(request);
      const jobs: DiffSourceJob[] = [];
      for (const fixture of diffs) {
        const rules = request.select(fixture.logical);
        if (rules.length === 0) continue;
        jobs.push({
          kind: 'diff',
          logical: fixture.logical,
          previous: fixture.previous,
          rules,
          read: async () => {
            reads.push(fixture.logical);
            return {
              filepath: fixture.logical,
              diff: fixture.diff,
              head: fixture.head,
              base: fixture.base,
            };
          },
        });
      }
      return jobs;
    },
  };
  return { collector: createContextCollector(sources), treeRequests, diffRequests, reads };
}

interface RecordedEvent {
  readonly event: string;
  readonly fields: DiagnosticFields | undefined;
}

function memoryDiagnostics(): { readonly diagnostics: Diagnostics; readonly events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    events,
    diagnostics: {
      important: (event, fields) => {
        events.push({ event, fields });
      },
    },
  };
}

function ruleSource(groupBy: 'scope' | 'file', included: string, changed = true): string {
  return [
    "version: 'v1'",
    'files:',
    '  included:',
    `    - '${included}'`,
    'scope:',
    '  format: yaml',
    "  path: '$'",
    `  changed: ${changed}`,
    'decision:',
    `  group_by: ${groupBy}`,
    'check:',
    '  rule: Review the change.',
  ].join('\n');
}

function loaded(rules: readonly string[]): LoadedRule[] {
  return rules.map((source, index) => {
    const filepath = `/rules/rule-${index}.yaml`;
    return { filepath, rule: parseRule(source, filepath) };
  });
}

const API_YAML = 'service:\n  name: api\n';

const OLD_YAML = 'service:\n  name: old\n';

test('diff-only collection routes grouped rules to the tree and scope rules to the changed sources', async () => {
  const rules = loaded([
    ruleSource('scope', '**/*.yaml'),
    ruleSource('file', '**/*.yaml'),
  ]);
  const memory = memoryRepository(
    [{ logical: 'src/grouped.yaml', source: API_YAML }],
    [
      {
        logical: 'src/scoped.yaml',
        previous: 'src/scoped.yaml',
        base: OLD_YAML,
        head: API_YAML,
        diff: 'diff --git a/src/scoped.yaml b/src/scoped.yaml\n',
      },
    ],
  );
  const { diagnostics, events } = memoryDiagnostics();
  const starts: number[] = [];
  let completions = 0;
  const progress: SourceProgress = {
    start: (total) => {
      starts.push(total);
    },
    complete: () => {
      completions += 1;
    },
  };

  const contexts = await memory.collector.collect(
    '.',
    { diffOnly: true },
    rules,
    [false, true],
    new Set<string>(),
    1,
    progress,
    diagnostics,
  );

  assert.strictEqual(memory.treeRequests.length, 1, 'the grouped rule must route one tree pass');
  assert.strictEqual(memory.diffRequests.length, 1, 'the scope rule must route one diff pass');
  assert.deepStrictEqual(
    memory.treeRequests[0]!.select('src/grouped.yaml'),
    [1],
    'only the grouped rule may select a tree source',
  );
  assert.deepStrictEqual(
    memory.diffRequests[0]!.select('src/scoped.yaml'),
    [0],
    'only the scope rule may select a changed source',
  );
  assert.strictEqual(memory.diffRequests[0]!.base, undefined, 'a base-less run must pass no base down');

  assert.strictEqual(contexts[0]!.length, 1, 'the scope rule must collect the changed scope it selected');
  assert.strictEqual(contexts[0]![0]!.filepath, 'src/scoped.yaml');
  assert.strictEqual(
    contexts[0]![0]!.diff,
    'diff --git a/src/scoped.yaml b/src/scoped.yaml\n',
    'a scope-rule context must carry the diff it was read from',
  );
  assert.strictEqual(contexts[1]!.length, 1, 'the grouped rule must collect the file it selected');
  assert.strictEqual(contexts[1]![0]!.filepath, 'src/grouped.yaml');
  assert.strictEqual(
    contexts[1]![0]!.diff,
    undefined,
    'a grouped context must carry no diff even when the run is diff-only',
  );
  assert.match(contexts[1]![0]!.scope.source, /name: api/, 'a grouped context must carry the scope it selected');

  assert.deepStrictEqual(starts, [2], 'progress must be started with every routed source');
  assert.strictEqual(completions, 2, 'progress must complete once per source');
  assert.deepStrictEqual(memory.reads.slice().sort(), ['src/grouped.yaml', 'src/scoped.yaml']);

  const routing = events.find((entry) => entry.event === 'diff.routing');
  assert.ok(routing !== undefined, 'a diff-only run must report its routing');
  assert.deepStrictEqual(routing.fields, {
    requested_base: 'default',
    tree_rules: 1,
    diff_rules: 1,
    tree_sources: 1,
    diff_sources: 1,
  });
});

test('compares the base revision only for a rule that also selects the previous path', async () => {
  const rules = loaded([ruleSource('scope', '**/*.ts')]);
  const memory = memoryRepository(
    [],
    [
      {
        logical: 'src/a.ts',
        previous: 'src/b.ts',
        base: API_YAML,
        head: API_YAML,
        diff: 'rename within the selection\n',
      },
      {
        logical: 'src/new.ts',
        previous: 'src/old.md',
        base: API_YAML,
        head: API_YAML,
        diff: 'rename into the selection\n',
      },
    ],
  );

  const contexts = await memory.collector.collect(
    '.',
    { diffOnly: true },
    rules,
    [false],
    new Set<string>(),
    1,
  );

  assert.strictEqual(
    contexts[0]!.length,
    1,
    'only the previous path the rule selects may be compared against the base',
  );
  assert.strictEqual(contexts[0]![0]!.filepath, 'src/new.ts');
  assert.strictEqual(contexts[0]![0]!.diff, 'rename into the selection\n');
});

test('forces a changed-only comparison on a diff source even when the rule opts out of comparing', async () => {
  const rules = loaded([ruleSource('scope', '**/*.yaml', false)]);
  const memory = memoryRepository(
    [],
    [
      {
        logical: 'src/a.yaml',
        previous: 'src/a.yaml',
        base: API_YAML,
        head: API_YAML,
        diff: 'no textual change\n',
      },
    ],
  );

  const contexts = await memory.collector.collect(
    '.',
    { diffOnly: true },
    rules,
    [false],
    new Set<string>(),
    1,
  );

  assert.deepStrictEqual(contexts[0], [], 'an unchanged scope must not be collected from a diff source');
});

test('resolves every rule identity alongside the path it was discovered under', async () => {
  const rules = loaded([ruleSource('scope', '**/*.yaml'), ruleSource('scope', '**/*.md')]);
  const memory = memoryRepository([], []);

  const identities = await memory.collector.identities(rules, 2);

  assert.deepStrictEqual(
    [...identities].sort(),
    ['/rules/rule-0.yaml', '/rules/rule-0.yaml.real', '/rules/rule-1.yaml', '/rules/rule-1.yaml.real'],
  );
});
