import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import type { BackendDecision, DecisionBackend, DecisionObserver, DecisionRequest } from './app/decision/port.ts';
import { DecisionService } from './app/decision/service.ts';
import type { InspectionEvent, InspectionObserver, InspectionSummary } from './app/inspect-result.ts';
import { createInspect, type InspectDependencies } from './app/inspect.ts';
import type { RuleSelector } from './app/ports/rules.ts';
import type { SourceRepository, TreeSourceJob } from './app/ports/sources.ts';
import type { RuleSettings } from './app/rule/types.ts';
import { parseRule } from './infra/rules.ts';

const CWD = join('/', 'tmp', 'rulekeeper-inspect');

interface Source {
  readonly filepath: string;
  readonly source: string;
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

interface MemorySources {
  readonly repository: SourceRepository;
  readonly targets: string[];
  readonly read: string[];
  readonly identity: string[][];
}

function memorySources(sources: readonly Source[]): MemorySources {
  const targets: string[] = [];
  const read: string[] = [];
  const identity: string[][] = [];
  return {
    targets,
    read,
    identity,
    repository: {
      async identities(paths): Promise<readonly string[]> {
        identity.push([...paths]);
        return paths;
      },
      async treeJobs(request): Promise<readonly TreeSourceJob[]> {
        targets.push(request.target);
        const jobs: TreeSourceJob[] = [];
        for (const source of sources) {
          const rules = request.select(source.filepath);
          if (rules.length === 0) continue;
          jobs.push({
            kind: 'tree',
            logical: source.filepath,
            rules,
            read: async () => {
              read.push(source.filepath);
              return { filepath: source.filepath, source: source.source };
            },
          });
        }
        return jobs;
      },
      async diffJobs() {
        return [];
      },
    },
  };
}

interface MemoryDecisions {
  readonly create: () => DecisionService;
  readonly requests: DecisionRequest[];
  readonly created: () => number;
}

function memoryDecisions(failAt?: number): MemoryDecisions {
  const requests: DecisionRequest[] = [];
  let created = 0;
  return {
    requests,
    created: () => created,
    create: () => {
      created++;
      const backend: DecisionBackend = {
        async decide(request: DecisionRequest, observer?: DecisionObserver): Promise<BackendDecision> {
          const index = requests.length;
          requests.push(request);
          observer?.({ type: 'request', body: JSON.stringify({ index }) });
          if (failAt === index) throw new Error('backend exploded');
          observer?.({ type: 'response', status: 200, body: JSON.stringify({ passed: index % 2 === 0 }) });
          return { probability: index % 2 === 0 ? 0.9 : 0.1, model: 'memory' };
        },
      };
      return new DecisionService(backend, 0.5);
    },
  };
}

const RULE_FILE = join(CWD, '.rulekeeper', 'review.yaml');

function selectorFor(yaml: string, filepath = RULE_FILE): RuleSelector {
  return { select: async () => ({ filepath, source: yaml }) };
}

interface Run {
  readonly events: InspectionEvent[];
  readonly observer: InspectionObserver;
}

function recorder(): Run {
  const events: InspectionEvent[] = [];
  return { events, observer: (event) => events.push(event) };
}

function ofType<T extends InspectionEvent['type']>(
  events: readonly InspectionEvent[],
  type: T,
): Extract<InspectionEvent, { readonly type: T }> {
  const match = events.find((event): event is Extract<InspectionEvent, { readonly type: T }> => event.type === type);
  assert.ok(match !== undefined, `the run must emit a ${type} event`);
  return match;
}

function shape(events: readonly InspectionEvent[]): string[] {
  return events.map((event) => {
    if (event.type === 'verification') return `verification:${event.index}/${event.total}`;
    if (event.type === 'decision') return `decision:${event.index}:${String(event.decision.follows)}`;
    if (event.type === 'exchange') return `exchange:${event.index}:${event.exchange.type}`;
    return event.type;
  });
}

function dependencies(
  yaml: string,
  sources: MemorySources,
  decisions: MemoryDecisions,
): InspectDependencies {
  return {
    rules: selectorFor(yaml),
    compile: parseRule,
    sources: sources.repository,
    createDecisionService: decisions.create,
    cwd: CWD,
  };
}

test('inspect streams rule, selection, serial verifications and a complete summary', async () => {
  const sources = memorySources([
    { filepath: 'src/a.yaml', source: 'services:\n  - name: api\n  - name: web\n' },
    { filepath: 'src/notes.txt', source: 'services:\n  - name: ignored\n' },
    { filepath: 'src/b.yaml', source: 'services:\n  - name: db\n' },
  ]);
  const decisions = memoryDecisions();
  const run = recorder();

  const summary = await createInspect(
    dependencies(ruleYaml('**/*.yaml'), sources, decisions),
  )('review.yaml', run.observer);

  assert.deepStrictEqual(shape(run.events), [
    'rule',
    'selection',
    'verification:1/3',
    'exchange:1:request',
    'exchange:1:response',
    'decision:1:true',
    'verification:2/3',
    'exchange:2:request',
    'exchange:2:response',
    'decision:2:false',
    'verification:3/3',
    'exchange:3:request',
    'exchange:3:response',
    'decision:3:true',
    'complete',
  ]);

  const ruleEvent = ofType(run.events, 'rule');
  assert.deepStrictEqual(
    {
      cwd: ruleEvent.cwd,
      ruleFile: ruleEvent.ruleFile,
      name: ruleEvent.name,
      rule: ruleEvent.rule,
      grouping: ruleEvent.grouping,
    },
    {
      cwd: CWD,
      ruleFile: RULE_FILE,
      name: 'review',
      rule: 'Follow the review.',
      grouping: { group_by: 'scope' },
    },
  );
  assert.ok(!('violationMessage' in ruleEvent), 'a rule without a violation message omits the field');
  assert.strictEqual(ruleEvent.enabled, true, 'an enabled rule is reported as enabled');

  const { files } = ofType(run.events, 'selection');
  assert.deepStrictEqual(
    files.map((file) => ({
      filepath: file.filepath,
      selected: file.selected.length,
      accepted: file.accepted.length,
      filtered: file.filtered.length,
    })),
    [
      { filepath: 'src/a.yaml', selected: 2, accepted: 2, filtered: 0 },
      { filepath: 'src/b.yaml', selected: 1, accepted: 1, filtered: 0 },
    ],
  );
  assert.strictEqual(files[0]!.accepted[0], files[0]!.selected[0], 'an accepted context is shared, not copied');
  assert.deepStrictEqual(files[0]!.accepted.map((context) => context.scope.source), ['name: api\n', 'name: web\n']);
  assert.deepStrictEqual(sources.read, ['src/a.yaml', 'src/b.yaml'], 'only eligible files are read');
  assert.deepStrictEqual(sources.targets, [CWD], 'the working root is the tree target');
  assert.strictEqual(decisions.created(), 1, 'the backend service is built once');
  assert.deepStrictEqual(summary, {
    eligibleFiles: 2,
    matchedFiles: 2,
    selectedScopes: 3,
    filteredScopes: 0,
    verifications: 3,
    passed: 2,
    violations: 1,
  });
  const states = decisions.requests.map((request) => ('files' in request.context ? 'files' : request.context.filepath));
  assert.deepStrictEqual(states, ['src/a.yaml', 'src/a.yaml', 'src/b.yaml'], 'verifications are serial and in source order');
});

test('inspect lists every selected scope of a file, filtered ones included', async () => {
  const sources = memorySources([
    {
      filepath: 'src/partial.yaml',
      source: 'services:\n  - name: api\n  - port: 8080\n  - name: web\n',
    },
    { filepath: 'src/none.yaml', source: 'other: 1\n' },
  ]);
  const decisions = memoryDecisions();
  const run = recorder();

  const summary = await createInspect(
    dependencies(
      ruleYaml('**/*.yaml', ['filter:', '  non_empty: $.data.name']),
      sources,
      decisions,
    ),
  )('review.yaml', run.observer);

  const { files } = ofType(run.events, 'selection');
  assert.deepStrictEqual(
    files.map((file) => ({
      filepath: file.filepath,
      selected: file.selected.length,
      accepted: file.accepted.length,
      filtered: file.filtered.length,
    })),
    [
      { filepath: 'src/partial.yaml', selected: 3, accepted: 2, filtered: 1 },
      { filepath: 'src/none.yaml', selected: 0, accepted: 0, filtered: 0 },
    ],
  );
  assert.deepStrictEqual(files[0]!.filtered.map((context) => context.scope.source), ['port: 8080\n']);
  assert.deepStrictEqual(
    summary,
    {
      eligibleFiles: 2,
      matchedFiles: 1,
      selectedScopes: 3,
      filteredScopes: 1,
      verifications: 2,
      passed: 1,
      violations: 1,
    },
    'eligible files stay separate from files with a surviving scope',
  );
});

test('inspect never constructs the backend when nothing survives the filter', async () => {
  const sources = memorySources([{ filepath: 'src/all.yaml', source: 'services:\n  - port: 1\n  - port: 2\n' }]);
  const decisions = memoryDecisions();
  const run = recorder();

  const summary = await createInspect(
    dependencies(
      ruleYaml('**/*.yaml', ['filter:', '  non_empty: $.data.name']),
      sources,
      decisions,
    ),
  )('review.yaml', run.observer);

  assert.deepStrictEqual(shape(run.events), ['rule', 'selection', 'complete']);
  assert.strictEqual(decisions.created(), 0);
  assert.deepStrictEqual(summary, {
    eligibleFiles: 1,
    matchedFiles: 1,
    selectedScopes: 2,
    filteredScopes: 2,
    verifications: 0,
    passed: 0,
    violations: 0,
  });
});

test('inspect sends one grouped verification carrying every member scope', async () => {
  const sources = memorySources([
    { filepath: 'src/a.yaml', source: 'services:\n  - name: api\n  - name: web\n' },
    { filepath: 'src/b.yaml', source: 'services:\n  - name: db\n' },
  ]);
  const decisions = memoryDecisions();
  const run = recorder();

  const summary = await createInspect(
    dependencies(
      ruleYaml('**/*.yaml', ['decision:', '  group_by: file']),
      sources,
      decisions,
    ),
  )('review.yaml', run.observer);

  assert.deepStrictEqual(shape(run.events), [
    'rule',
    'selection',
    'verification:1/2',
    'exchange:1:request',
    'exchange:1:response',
    'decision:1:true',
    'verification:2/2',
    'exchange:2:request',
    'exchange:2:response',
    'decision:2:false',
    'complete',
  ]);

  const verification = ofType(run.events, 'verification');
  assert.ok('group' in verification.context, 'a grouped rule verifies one group');
  assert.deepStrictEqual(verification.context.group, { type: 'file', path: 'src/a.yaml' });
  assert.deepStrictEqual(
    decisions.requests.map((request) => ('files' in request.context ? request.context.files.map((file) => file.scopes.length) : [])),
    [[2], [1]],
    'each group request carries its own member scopes',
  );
  assert.strictEqual(summary.verifications, 2);
  assert.strictEqual(summary.passed, 1);
});

test('inspect reports a failed verification with its context and rethrows', async () => {
  const sources = memorySources([
    { filepath: 'src/a.yaml', source: 'services:\n  - name: api\n' },
    { filepath: 'src/b.yaml', source: 'services:\n  - name: db\n' },
  ]);
  const decisions = memoryDecisions(1);
  const run = recorder();

  const inspect = createInspect(
    dependencies(ruleYaml('**/*.yaml'), sources, decisions),
  );
  await assert.rejects(
    inspect('review.yaml', run.observer),
    /Decision for src\/b\.yaml scope .+ of rule .+review\.yaml failed: backend exploded/,
  );

  assert.deepStrictEqual(shape(run.events), [
    'rule',
    'selection',
    'verification:1/2',
    'exchange:1:request',
    'exchange:1:response',
    'decision:1:true',
    'verification:2/2',
    'exchange:2:request',
    'failure',
  ]);
  const failure = ofType(run.events, 'failure');
  assert.strictEqual(failure.index, 2);
  assert.match(failure.message, /Decision for src\/b\.yaml scope .+ failed: backend exploded/);
  assert.strictEqual(decisions.created(), 1, 'a failure keeps the one service the run already built');
});

test('inspect wraps an invalid selected descriptor and a failed source read', async () => {
  const decisions = memoryDecisions();
  const run = recorder();

  await assert.rejects(
    createInspect(dependencies('name: [broken\n', memorySources([]), decisions))('review.yaml', run.observer),
    /is invalid: /,
    'an uncompilable descriptor is reported as invalid',
  );
  const streamed: InspectionEvent[] = [];
  assert.deepStrictEqual(run.events, streamed, 'nothing is streamed before the rule compiles');

  const sources = memorySources([{ filepath: 'src/a.yaml', source: 'services: []\n' }]);
  sources.repository.treeJobs = async () => [
    {
      kind: 'tree',
      logical: 'src/a.yaml',
      rules: [0],
      read: async () => {
        throw new Error('EACCES');
      },
    },
  ];
  await assert.rejects(
    createInspect(dependencies(ruleYaml('**/*.yaml'), sources, decisions))('review.yaml', run.observer),
    /Source file src\/a\.yaml could not be read: EACCES/,
  );
  assert.deepStrictEqual(
    run.events.map((event) => event.type),
    ['rule'],
    'a source failure leaves the rule event as the only streamed stage',
  );
});

test('inspect runs without an observer and still returns the summary', async () => {
  const sources = memorySources([{ filepath: 'src/a.yaml', source: 'services:\n  - name: api\n' }]);
  const decisions = memoryDecisions();
  const summary: InspectionSummary = await createInspect(
    dependencies(ruleYaml('**/*.yaml'), sources, decisions),
  )('review.yaml');

  assert.strictEqual(summary.verifications, 1);
  assert.strictEqual(summary.passed, 1);
});

test('inspect carries the descriptor violation message on its rule event', async () => {
  const sources = memorySources([{ filepath: 'src/a.yaml', source: 'services:\n  - name: api\n' }]);
  const decisions = memoryDecisions();
  const run = recorder();

  await createInspect(
    dependencies(
      `${ruleYaml('**/*.yaml')}  violation-message: 'Pin every service.'\n`,
      sources,
      decisions,
    ),
  )('review.yaml', run.observer);

  const ruleEvent = ofType(run.events, 'rule');
  assert.strictEqual(ruleEvent.violationMessage, 'Pin every service.');
  assert.strictEqual(ruleEvent.enabled, true);
});

test('inspect hands the selected rule settings to the one service it builds', async () => {
  const sources = memorySources([
    { filepath: 'src/a.yaml', source: 'services:\n  - name: api\n' },
    { filepath: 'src/b.yaml', source: 'services:\n  - name: db\n' },
  ]);
  const decisions = memoryDecisions();
  const run = recorder();
  const seen: RuleSettings[] = [];
  let built = 0;

  const summary = await createInspect({
    rules: selectorFor(ruleYaml('**/*.yaml', ['settings:', "  model: 'rule-model'", '  threshold: 0.2'])),
    compile: parseRule,
    sources: sources.repository,
    createDecisionService: (settings) => {
      seen.push(settings);
      built++;
      return decisions.create();
    },
    cwd: CWD,
  })('review.yaml', run.observer);

  assert.deepStrictEqual(seen, [{ model: 'rule-model', threshold: 0.2 }]);
  assert.strictEqual(built, 1, 'the inspected rule builds one service for all of its verifications');
  assert.strictEqual(summary.verifications, 2);
});

test('inspect reports a disabled rule and never touches sources or a provider', async () => {
  const sources = memorySources([{ filepath: 'src/a.yaml', source: 'services:\n  - name: api\n' }]);
  const decisions = memoryDecisions();
  const run = recorder();

  const summary = await createInspect({
    rules: selectorFor(ruleYaml('**/*.yaml', ['enabled: false'])),
    compile: parseRule,
    sources: sources.repository,
    createDecisionService: () => decisions.create(),
    cwd: CWD,
  })('review.yaml', run.observer);

  assert.deepStrictEqual(shape(run.events), ['rule', 'selection', 'complete']);
  const ruleEvent = ofType(run.events, 'rule');
  assert.strictEqual(ruleEvent.enabled, false);
  assert.strictEqual(ruleEvent.name, 'review');
  assert.deepStrictEqual(ofType(run.events, 'selection').files, []);
  assert.deepStrictEqual(summary, {
    eligibleFiles: 0,
    matchedFiles: 0,
    selectedScopes: 0,
    filteredScopes: 0,
    verifications: 0,
    passed: 0,
    violations: 0,
  });
  assert.deepStrictEqual(sources.identity, [], 'a disabled rule resolves no descriptor identity');
  assert.deepStrictEqual(sources.targets, [], 'a disabled rule asks for no tree jobs');
  assert.deepStrictEqual(sources.read, [], 'a disabled rule reads no source');
  assert.strictEqual(decisions.created(), 0, 'a disabled rule builds no provider');
});
