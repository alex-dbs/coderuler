import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import type { CheckProgress, DecisionProgress } from './app/check-result.ts';
import { createCheck, type CheckOptions } from './app/check.ts';
import type { ContextCollector } from './app/ports/sources.ts';
import type { BackendDecision, DecisionBackend, DecisionRequest } from './app/decision/port.ts';
import { DecisionService } from './app/decision/service.ts';
import { DEFAULT_THRESHOLD } from './app/decision/threshold.ts';
import type { DiagnosticFields, Diagnostics } from './app/ports/diagnostics.ts';
import type { LoadedRule } from './app/ports/rules.ts';
import type { Context } from './app/rule/types.ts';
import { parseRule } from './infra/rules.ts';

const CWD = join('/', 'tmp', 'rulekeeper-app-check');

interface Source {
  readonly filepath: string;
  readonly source: string;
}

interface RecordedEvent {
  readonly level: 'debug' | 'verbose';
  readonly event: string;
  readonly fields: DiagnosticFields | undefined;
}

interface Backend {
  readonly backend: DecisionBackend;
  readonly requested: string[];
  readonly resolved: string[];
  readonly maxInFlight: () => number;
}

function ruleYaml(name: string, included: string, decision: readonly string[], path = '$'): string {
  return [
    "version: 'v1'",
    `name: '${name}'`,
    'files:',
    '  included:',
    `    - '${included}'`,
    'scope:',
    '  format: yaml',
    `  path: '${path}'`,
    ...decision,
    'examples:',
    '  good:',
    "    - 'complies'",
    'rule: Follow the review.',
    '',
  ].join('\n');
}

function loadedRule(filepath: string, yaml: string): LoadedRule {
  return { filepath, rule: parseRule(yaml) };
}

function contextKey(request: DecisionRequest): string {
  const { context } = request;
  return 'group' in context ? `group:${context.group.path}` : `scope:${context.filepath}`;
}

interface Gate {
  readonly promise: Promise<BackendDecision>;
  readonly resolve: () => void;
  readonly fail: () => void;
}

function backendWith(decide: (request: DecisionRequest, gate: Gate) => void): Backend {
  const requested: string[] = [];
  const resolved: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const gate = (request: DecisionRequest): Promise<BackendDecision> => {
    const { promise, resolve, reject } = Promise.withResolvers<BackendDecision>();
    const key = contextKey(request);
    requested.push(key);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const settle = (outcome: () => void) => (): void => {
      inFlight--;
      resolved.push(key);
      outcome();
    };
    decide(request, {
      promise,
      resolve: settle(() => resolve({ probability: 0.9, model: 'memory' })),
      fail: settle(() => reject(new Error('backend exploded'))),
    });
    return promise;
  };
  return { backend: { decide: gate }, requested, resolved, maxInFlight: () => maxInFlight };
}

function memoryCollector(sources: readonly Source[], phases: string[]): ContextCollector {
  return {
    async identities(loaded) {
      phases.push('identities');
      return new Set(loaded.map(({ filepath }) => filepath));
    },
    async collect(target, options, loaded, _grouped, _rulePaths, _concurrency, progress) {
      phases.push(`collect:${target}:${String(options.diffOnly)}`);
      progress?.start(sources.length);
      const contextsByRule: Context[][] = loaded.map(() => []);
      for (const source of sources) {
        for (const [index, { rule }] of loaded.entries()) {
          if (!rule.matchesFile(source.filepath)) continue;
          contextsByRule[index]!.push(...rule.match({ filepath: source.filepath, source: source.source }));
        }
        progress?.complete();
      }
      return contextsByRule;
    },
  };
}

function progressRecorder(): { readonly progress: CheckProgress; readonly decisions: DecisionProgress[]; completed: () => number } {
  const decisions: DecisionProgress[] = [];
  let completed = 0;
  return {
    progress: {
      rulesLoaded: () => {},
      sources: () => {},
      sourceComplete: () => {},
      decisions: (info) => decisions.push(info),
      decisionComplete: () => {
        completed++;
      },
    },
    decisions,
    completed: () => completed,
  };
}

function diagnosticsRecorder(): { readonly diagnostics: Diagnostics; readonly events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    diagnostics: {
      important: (event, fields) => {
        events.push({ level: 'debug', event, fields });
      },
    },
    events,
  };
}

function names(events: readonly RecordedEvent[]): string[] {
  return events.map(({ event }) => event);
}

function fieldsOf(events: readonly RecordedEvent[], event: string): DiagnosticFields {
  const match = events.find((entry) => entry.event === event);
  assert.ok(match !== undefined, `the run must report ${event}`);
  return match.fields ?? {};
}

test('check folds grouped and scoped decisions back per rule with the injected project root', async () => {
  const alpha = join(CWD, 'src', 'alpha', 'a.yaml');
  const beta = join(CWD, 'src', 'beta', 'b.yaml');
  const rules = [
    loadedRule(
      'grouped.yaml',
      ruleYaml('grouped review', '**/*.yaml', ['decision:', '  group_by: folder', '  level: 0'], '$.services[*]'),
    ),
    loadedRule('scoped.yaml', ruleYaml('scoped review', '**/*.yaml', [], '$.services[*]')),
  ];
  const sources: Source[] = [
    { filepath: alpha, source: 'services:\n  - name: api\n  - name: web\n' },
    { filepath: beta, source: 'services:\n  - name: db\n' },
  ];

  const decisions: (() => void)[] = [];
  const { backend, requested, resolved, maxInFlight } = backendWith((_request, gate) => {
    decisions.push(gate.resolve);
    if (decisions.length < 5) return;
    for (const release of [...decisions].reverse()) release();
  });

  const phases: string[] = [];
  const record = progressRecorder();
  const { diagnostics, events } = diagnosticsRecorder();
  const check = createCheck({
    loadRules: async () => rules,
    contexts: memoryCollector(sources, phases),
    createDecisionService: (_diagnostics, threshold) => new DecisionService(backend, threshold ?? DEFAULT_THRESHOLD),
    cwd: CWD,
  });

  const options: CheckOptions = { rules: 'r.yaml', diffOnly: true, base: 'origin/main', concurrency: 8 };
  const results = await check('.', options, record.progress, diagnostics);

  assert.deepStrictEqual(phases, ['identities', 'collect:.:true']);
  assert.deepStrictEqual(results.map(({ name }) => name), ['grouped review', 'scoped review']);
  assert.deepStrictEqual(record.decisions, [{ matchingRules: 2, scopes: 6, total: 5 }]);
  assert.strictEqual(record.completed(), 5);
  assert.strictEqual(maxInFlight(), 5, 'the work of both rules is flattened under one global limit');
  assert.deepStrictEqual(requested, ['group:src/alpha', 'group:src/beta', `scope:${alpha}`, `scope:${alpha}`, `scope:${beta}`]);
  assert.deepStrictEqual(resolved, [...requested].reverse(), 'the decisions must finish in a different order than they started');

  const grouped = results[0]!;
  const groups = grouped.decisions.map((decision) => {
    assert.ok('group' in decision, 'a grouped rule must report group decisions');
    return decision;
  });
  assert.deepStrictEqual(groups.map(({ group }) => group), [
    { type: 'folder', path: 'src/alpha' },
    { type: 'folder', path: 'src/beta' },
  ]);
  assert.deepStrictEqual(
    groups[0]!.members,
    grouped.contexts.slice(0, 2).map((context) => ({ filepath: context.filepath, scopeId: context.scope.id })),
  );
  assert.deepStrictEqual(
    groups[1]!.members,
    grouped.contexts.slice(2).map((context) => ({ filepath: context.filepath, scopeId: context.scope.id })),
  );

  const scoped = results[1]!;
  assert.deepStrictEqual(
    scoped.decisions.map((decision) => 'scopeId' in decision ? `${decision.filepath}\u0000${decision.scopeId}` : decision.group.path),
    scoped.contexts.map((context) => `${context.filepath}\u0000${context.scope.id}`),
  );

  assert.deepStrictEqual(names(events), [
    'rules.loaded',
    'rules.paths',
    'sources.collected',
    'decisions.planned',
    'decision.start',
    'decision.start',
    'decision.start',
    'decision.start',
    'decision.start',
    'decision.result',
    'decision.result',
    'decision.result',
    'decision.result',
    'decision.result',
    'decisions.complete',
    'run.complete',
  ]);
  const collected = fieldsOf(events, 'sources.collected');
  assert.strictEqual(collected.rules, 2);
  assert.strictEqual(collected.matched, 2);
  assert.strictEqual(collected.contexts, 6);
  const completedDecisions = fieldsOf(events, 'decisions.complete');
  assert.strictEqual(completedDecisions.units, 5);
  assert.strictEqual(completedDecisions.passed, 5);
  assert.strictEqual(completedDecisions.violations, 0);
  assert.strictEqual(fieldsOf(events, 'run.complete').units, 5);
});

test('check builds no decision service and decides nothing when no scope matches', async () => {
  const rules = [loadedRule('nothing.yaml', ruleYaml('nothing review', 'nothing/**/*.yaml', []))];
  const sources: Source[] = [{ filepath: 'src/a.yaml', source: 'service:\n  name: api\n' }];
  const phases: string[] = [];
  const record = progressRecorder();
  const { diagnostics, events } = diagnosticsRecorder();
  let built = 0;

  const check = createCheck({
    loadRules: async () => rules,
    contexts: memoryCollector(sources, phases),
    createDecisionService: () => {
      built++;
      throw new Error('no decision service may be built');
    },
    cwd: CWD,
  });

  const results = await check('.', {}, record.progress, diagnostics);

  assert.strictEqual(built, 0);
  assert.deepStrictEqual(results[0]!.decisions, []);
  assert.deepStrictEqual(results[0]!.contexts, []);
  assert.deepStrictEqual(record.decisions, [{ matchingRules: 0, scopes: 0, total: 0 }]);
  assert.strictEqual(record.completed(), 0);
  assert.deepStrictEqual(names(events), [
    'rules.loaded',
    'rules.paths',
    'sources.collected',
    'decisions.planned',
    'decisions.complete',
    'run.complete',
  ]);
  const exhausted = fieldsOf(events, 'decisions.complete');
  assert.strictEqual(exhausted.units, 0);
  assert.strictEqual(exhausted.passed, 0);
  assert.strictEqual(exhausted.violations, 0);
  assert.strictEqual(fieldsOf(events, 'sources.collected').contexts, 0);
});

test('check drains in-flight decisions, keeps the global limit and surfaces the failing rule', async () => {
  const failing = 'src/second/a.yaml';
  const rules = [
    loadedRule('first.yaml', ruleYaml('first review', 'src/first/**/*.yaml', [])),
    loadedRule('second.yaml', ruleYaml('second review', 'src/second/**/*.yaml', [])),
  ];
  const sources: Source[] = [
    { filepath: 'src/first/a.yaml', source: 'a: 1\n' },
    { filepath: 'src/first/b.yaml', source: 'b: 1\n' },
    { filepath: failing, source: 'c: 1\n' },
    { filepath: 'src/second/b.yaml', source: 'd: 1\n' },
  ];

  const pending: (() => void)[] = [];
  const { backend, maxInFlight } = backendWith((request, gate) => {
    pending.push(contextKey(request) === `scope:${failing}` ? gate.fail : gate.resolve);
    if (pending.length < 2) return;
    for (const release of pending.splice(0)) release();
  });

  const phases: string[] = [];
  const record = progressRecorder();
  const { diagnostics, events } = diagnosticsRecorder();
  const check = createCheck({
    loadRules: async () => rules,
    contexts: memoryCollector(sources, phases),
    createDecisionService: (_diagnostics, threshold) => new DecisionService(backend, threshold ?? DEFAULT_THRESHOLD),
    cwd: CWD,
  });

  const failure = await check('.', { concurrency: 2 }, record.progress, diagnostics).then(
    (results) => results,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof Error, 'the failing decision must reject the run');
  assert.strictEqual(
    failure.message,
    `Decision for ${failing} scope 0: of rule second.yaml failed: backend exploded`,
  );
  assert.strictEqual(maxInFlight(), 2, 'the limit stays global across the flattened rules');
  assert.strictEqual(record.completed(), 3, 'the decisions in flight drain, and no further one starts');
  assert.strictEqual(fieldsOf(events, 'decision.failed').rule, 'second review');
  assert.strictEqual(fieldsOf(events, 'run.failed').phase, 'decisions');
  assert.strictEqual(fieldsOf(events, 'run.failed').reason, 'Error');
  assert.ok(!names(events).includes('run.complete'), 'a failed run reports no completion');
});
