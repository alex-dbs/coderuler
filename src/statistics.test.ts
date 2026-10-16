import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { createCheck, type Check } from './app/check.ts';
import type { BackendDecision, DecisionBackend } from './app/decision/port.ts';
import { DecisionService } from './app/decision/service.ts';
import { DEFAULT_THRESHOLD } from './app/decision/threshold.ts';
import { createInspect, type Inspect } from './app/inspect.ts';
import type { InspectionEvent } from './app/inspect-result.ts';
import type { EvaluationStatistics, StatisticsStore } from './app/ports/statistics.ts';
import type { LoadedRule } from './app/ports/rules.ts';
import type { ContextCollector, SourceRepository, TreeSourceJob } from './app/ports/sources.ts';
import type { Context } from './app/rule/types.ts';
import { parseRule } from './infra/rules.ts';
import { trackCheck, trackInspect } from './app/statistics.ts';

const CWD = join('/', 'tmp', 'rulekeeper-statistics-check');
const INSPECT_CWD = join('/', 'tmp', 'rulekeeper-statistics-inspect');
const RULE_FILE = join(INSPECT_CWD, '.rulekeeper', 'review.yaml');

interface Source {
  readonly filepath: string;
  readonly source: string;
}

interface Recorded {
  readonly project: string;
  readonly evaluation: EvaluationStatistics;
}

function recordingStore(): { readonly store: StatisticsStore; readonly records: Recorded[] } {
  const records: Recorded[] = [];
  const store: StatisticsStore = {
    record(project, evaluation) {
      records.push({ project, evaluation });
    },
    read() {
      return { total: { runs: 0, rules: 0, verifications: 0, violations: 0, elapsedMs: 0 }, projects: [] };
    },
    reset() {},
  };
  return { store, records };
}

function failingStore(error: Error): StatisticsStore {
  return {
    record() {
      throw error;
    },
    read() {
      return { total: { runs: 0, rules: 0, verifications: 0, violations: 0, elapsedMs: 0 }, projects: [] };
    },
    reset() {},
  };
}

function steppingClock(start: number, step: number): () => number {
  let current = start;
  return () => {
    const value = current;
    current += step;
    return value;
  };
}

type Outcome = (index: number) => BackendDecision | Error;

function scriptedBackend(outcome: Outcome): DecisionBackend {
  let index = 0;
  return {
    async decide(_request, observer) {
      const position = index;
      index += 1;
      observer?.({ type: 'request', body: JSON.stringify({ position }) });
      const result = outcome(position);
      if (result instanceof Error) throw result;
      observer?.({ type: 'response', status: 200, body: JSON.stringify({ passed: result.probability > 0.5 }) });
      return result;
    },
  };
}

function ruleYaml(included: string, extra: readonly string[] = [], path = '$.services[*]'): string {
  return [
    "version: 'v1'",
    'files:',
    '  included:',
    `    - '${included}'`,
    'scope:',
    '  format: yaml',
    `  path: '${path}'`,
    ...extra,
    'check:',
    '  rule: Follow the review.',
    '  examples:',
    '    good:',
    "      - 'complies'",
    '',
  ].join('\n');
}

function loadedRule(filepath: string, yaml: string): LoadedRule {
  return { filepath, rule: parseRule(yaml, filepath) };
}

function memoryCollector(sources: readonly Source[]): ContextCollector {
  return {
    async identities(loaded) {
      return new Set(loaded.map(({ filepath }) => filepath));
    },
    async collect(_target, _options, loaded) {
      const contextsByRule: Context[][] = loaded.map(() => []);
      for (const source of sources) {
        for (const [index, { rule }] of loaded.entries()) {
          if (!rule.matchesFile(source.filepath)) continue;
          contextsByRule[index]!.push(...rule.match({ filepath: source.filepath, source: source.source }));
        }
      }
      return contextsByRule;
    },
  };
}

function memorySources(sources: readonly Source[]): SourceRepository {
  return {
    async identities(paths) {
      return paths;
    },
    async treeJobs(request) {
      const jobs: TreeSourceJob[] = [];
      for (const source of sources) {
        const rules = request.select(source.filepath);
        if (rules.length === 0) continue;
        jobs.push({
          kind: 'tree',
          logical: source.filepath,
          rules,
          read: async () => ({ filepath: source.filepath, source: source.source }),
        });
      }
      return jobs;
    },
    async diffJobs() {
      return [];
    },
  };
}

function checkWith(
  loaded: readonly LoadedRule[],
  sources: readonly Source[],
  outcome: Outcome = (index) => ({ probability: index % 2 === 0 ? 0.9 : 0.1, model: 'memory' }),
): Check {
  const backend = scriptedBackend(outcome);
  return createCheck({
    loadRules: async () => [...loaded],
    contexts: memoryCollector(sources),
    createDecisionService: (settings) => new DecisionService(backend, settings.threshold ?? DEFAULT_THRESHOLD),
    cwd: CWD,
  });
}

function inspectWith(
  yaml: string,
  sources: readonly Source[],
  outcome: Outcome = (index) => ({ probability: index % 2 === 0 ? 0.9 : 0.1, model: 'memory' }),
): Inspect {
  return createInspect({
    rules: { select: async () => ({ filepath: RULE_FILE, source: yaml }) },
    compile: parseRule,
    sources: memorySources(sources),
    createDecisionService: () => new DecisionService(scriptedBackend(outcome), DEFAULT_THRESHOLD),
    cwd: INSPECT_CWD,
  });
}

const SERVICES = [
  { filepath: join(CWD, 'src', 'a.yaml'), source: 'services:\n  - name: api\n  - name: web\n' },
  { filepath: join(CWD, 'src', 'b.yaml'), source: 'services:\n  - name: db\n' },
];

test('trackCheck records enabled rules, verifications and violations for a completed run', async () => {
  const loaded = [loadedRule(join(CWD, '.rulekeeper', 'review.yaml'), ruleYaml('**/*.yaml'))];
  const expected = await checkWith(loaded, SERVICES)('.', { concurrency: 1 });

  const { store, records } = recordingStore();
  const check = trackCheck(checkWith(loaded, SERVICES), CWD, store, steppingClock(1000, 250));

  const results = await check('.', { concurrency: 1 });

  assert.deepStrictEqual(results, expected, 'the tracked run returns exactly what the wrapped check resolved');
  assert.deepStrictEqual(
    results[0]!.decisions.map((decision) => decision.follows),
    [true, false, true],
    'the decisions are the real resolved state',
  );
  assert.deepStrictEqual(records, [
    { project: CWD, evaluation: { rules: 1, verifications: 3, violations: 1, elapsedMs: 250 } },
  ]);
});

test('trackCheck counts an enabled rule even when it selects no scope', async () => {
  const loaded = [loadedRule(join(CWD, '.rulekeeper', 'review.yaml'), ruleYaml('**/*.yaml'))];
  const sources = [{ filepath: join(CWD, 'src', 'notes.md'), source: 'services:\n  - name: api\n' }];

  const { store, records } = recordingStore();
  const results = await trackCheck(checkWith(loaded, sources), CWD, store, steppingClock(500, 5))('.', {
    concurrency: 1,
  });

  assert.deepStrictEqual(results.map((result) => result.decisions.length), [0], 'the enabled rule ran with no match');
  assert.deepStrictEqual(records, [
    { project: CWD, evaluation: { rules: 1, verifications: 0, violations: 0, elapsedMs: 5 } },
  ]);
});

test('trackCheck counts a disabled rule as zero rules and no verifications', async () => {
  const loaded = [
    loadedRule(join(CWD, '.rulekeeper', 'review.yaml'), ruleYaml('**/*.yaml', ['enabled: false'])),
  ];

  const { store, records } = recordingStore();
  const results = await trackCheck(checkWith(loaded, SERVICES), CWD, store, steppingClock(0, 3))('.', {
    concurrency: 1,
  });

  assert.deepStrictEqual(results, [], 'a disabled-only run evaluates nothing');
  assert.deepStrictEqual(records, [
    { project: CWD, evaluation: { rules: 0, verifications: 0, violations: 0, elapsedMs: 3 } },
  ]);
});

test('trackCheck counts one verification per group, not per member', async () => {
  const loaded = [
    loadedRule(
      join(CWD, '.rulekeeper', 'grouped.yaml'),
      ruleYaml('**/*.yaml', ['decision:', '  group_by: file']),
    ),
  ];

  const { store, records } = recordingStore();
  const results = await trackCheck(checkWith(loaded, SERVICES), CWD, store, steppingClock(7, 11))('.', {
    concurrency: 1,
  });

  const decisions = results[0]!.decisions;
  assert.strictEqual(decisions.length, 2, 'one group decision per file');
  const members = decisions.map((decision) => {
    assert.ok('group' in decision, 'a grouped rule reports group decisions');
    return decision.members.length;
  });
  assert.deepStrictEqual(members, [2, 1], 'three member scopes collapse into two verifications');
  assert.deepStrictEqual(records, [
    { project: CWD, evaluation: { rules: 1, verifications: 2, violations: 1, elapsedMs: 11 } },
  ]);
});

test('trackCheck does not record a run whose evaluation fails', async () => {
  const loaded = [loadedRule(join(CWD, '.rulekeeper', 'review.yaml'), ruleYaml('**/*.yaml'))];
  const outcome: Outcome = (index) =>
    index === 1 ? new Error('backend exploded') : { probability: 0.9, model: 'memory' };

  const { store, records } = recordingStore();
  const check = trackCheck(checkWith(loaded, SERVICES, outcome), CWD, store, steppingClock(0, 1));

  await assert.rejects(() => check('.', { concurrency: 1 }), /backend exploded/);
  assert.deepStrictEqual(records, [], 'a partial execution is never recorded');
});

test('trackCheck and trackInspect surface a store failure instead of losing the run', async () => {
  const checkLoaded = [loadedRule(join(CWD, '.rulekeeper', 'review.yaml'), ruleYaml('**/*.yaml'))];
  const check = trackCheck(
    checkWith(checkLoaded, SERVICES),
    CWD,
    failingStore(new Error('store unavailable')),
    steppingClock(0, 1),
  );
  await assert.rejects(() => check('.', { concurrency: 1 }), /store unavailable/);

  const inspect = trackInspect(
    inspectWith(ruleYaml('**/*.yaml'), SERVICES),
    INSPECT_CWD,
    failingStore(new Error('store unavailable')),
    steppingClock(0, 1),
  );
  await assert.rejects(() => inspect('review.yaml'), /store unavailable/);
});

test('trackInspect forwards the real events and records the resolved summary', async () => {
  const yaml = ruleYaml('**/*.yaml');

  const directEvents: InspectionEvent[] = [];
  const directSummary = await inspectWith(yaml, SERVICES)('review.yaml', (event) => directEvents.push(event));

  const { store, records } = recordingStore();
  const events: InspectionEvent[] = [];
  const summary = await trackInspect(inspectWith(yaml, SERVICES), INSPECT_CWD, store, steppingClock(200, 40))(
    'review.yaml',
    (event) => events.push(event),
  );

  assert.deepStrictEqual(summary, directSummary, 'the tracked inspect resolves the real summary');
  assert.deepStrictEqual(events, directEvents, 'every event reaches the caller unchanged, exchanges included');
  assert.deepStrictEqual(records, [
    {
      project: INSPECT_CWD,
      evaluation: {
        rules: 1,
        verifications: directSummary.verifications,
        violations: directSummary.violations,
        elapsedMs: 40,
      },
    },
  ]);
  const exchanges = events.filter((event) => event.type === 'exchange');
  assert.strictEqual(exchanges.length > 0, true, 'the stream carried real exchanges');
});

test('trackInspect counts a disabled rule as zero', async () => {
  const yaml = ruleYaml('**/*.yaml', ['enabled: false']);

  const { store, records } = recordingStore();
  const events: InspectionEvent[] = [];
  const summary = await trackInspect(inspectWith(yaml, SERVICES), INSPECT_CWD, store, steppingClock(0, 9))(
    'review.yaml',
    (event) => events.push(event),
  );

  const rule = events.find((event) => event.type === 'rule');
  assert.ok(rule !== undefined && !rule.enabled, 'the disabled state comes from the real rule event');
  assert.deepStrictEqual(summary, {
    eligibleFiles: 0,
    matchedFiles: 0,
    selectedScopes: 0,
    filteredScopes: 0,
    verifications: 0,
    passed: 0,
    violations: 0,
  });
  assert.deepStrictEqual(records, [
    { project: INSPECT_CWD, evaluation: { rules: 0, verifications: 0, violations: 0, elapsedMs: 9 } },
  ]);
});

test('trackInspect records nothing when the evaluation fails', async () => {
  const yaml = ruleYaml('**/*.yaml');
  const outcome: Outcome = (index) =>
    index === 1 ? new Error('backend exploded') : { probability: 0.9, model: 'memory' };

  const { store, records } = recordingStore();
  const events: InspectionEvent[] = [];
  const inspect = trackInspect(inspectWith(yaml, SERVICES, outcome), INSPECT_CWD, store, steppingClock(0, 1));

  await assert.rejects(() => inspect('review.yaml', (event) => events.push(event)), /backend exploded/);
  assert.strictEqual(events.some((event) => event.type === 'failure'), true, 'the failure event is forwarded before the throw');
  assert.deepStrictEqual(records, [], 'a partial execution is never recorded');
});

test('trackInspect records a run observed without a caller observer', async () => {
  const yaml = ruleYaml('**/*.yaml');

  const { store, records } = recordingStore();
  const summary = await trackInspect(inspectWith(yaml, SERVICES), INSPECT_CWD, store, steppingClock(0, 4))(
    'review.yaml',
  );

  assert.strictEqual(summary.verifications, 3, 'the run still resolves its real summary');
  assert.deepStrictEqual(records, [
    { project: INSPECT_CWD, evaluation: { rules: 1, verifications: 3, violations: 1, elapsedMs: 4 } },
  ]);
});
