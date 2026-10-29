import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Rule, pass, scopes, violation } from '../dist/index.js';
import type {
  CheckResult,
  CsvRow,
  DecisionRequest,
  JsonValue,
  LoadedRule,
  Project,
  RuleReport,
  RunContext,
  RunEvent,
  ScopeMatch,
  ScopeSelector,
  ScopeSubject,
  Subject,
} from '../dist/index.js';
import { createProject } from '../dist/adapter/filesystem/project.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';
import { executeRules } from '../dist/app/execute.js';
import { wholeFileScope } from '../dist/app/selection.js';

import { GOLDEN_CASES } from './fixtures/golden-cases.ts';

const RULE_DIR = '/repo/.coderuler';

class GoldenProject implements Project {
  readonly root: string;
  readonly #files: Map<string, string>;

  constructor(root: string, files: Readonly<Record<string, string>>) {
    this.root = root;
    this.#files = new Map(Object.entries(files));
  }

  async glob(patterns: string | readonly string[]): Promise<readonly string[]> {
    const list = typeof patterns === 'string' ? [patterns] : patterns;
    return [...this.#files.keys()]
      .filter(filepath => list.some(glob => matchesGlob(filepath, glob)))
      .sort();
  }

  async hasFiles(patterns: string | readonly string[]): Promise<boolean> {
    return (await this.glob(patterns)).length > 0;
  }

  async stat(path: string): Promise<{ kind: 'file' | 'directory' } | undefined> {
    return this.#files.has(path) ? { kind: 'file' } : undefined;
  }

  async readText(path: string): Promise<string> {
    const text = this.#files.get(path);
    if (text === undefined) throw new Error(`Missing file ${path}`);
    return text;
  }

  async readJson(path: string): Promise<JsonValue> {
    return JSON.parse(await this.readText(path)) as JsonValue;
  }

  async readYaml(): Promise<readonly JsonValue[]> {
    throw new Error('GoldenProject does not read YAML');
  }

  async readCsv(): Promise<readonly CsvRow[]> {
    throw new Error('GoldenProject does not read CSV');
  }
}

function goldenContext(project: Project): RunContext {
  const events: RunEvent[] = [];
  return {
    project,
    isTarget: () => true,
    concurrency: 2,
    resolveDecision: () => {
      throw new Error('golden rules must not call the decision backend');
    },
    emit: event => {
      events.push(event);
    },
  };
}

function loaded(name: string, rule: Rule): LoadedRule {
  return { name, ruleFile: `${RULE_DIR}/${name}.rule.ts`, rule: rule as unknown as Rule<unknown> };
}

function stableReports(reports: readonly RuleReport[]) {
  return reports.map(({ durationMs, ...report }) => {
    assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
    return report;
  });
}

test('golden: wholeFileScope spans across empty, LF, CRLF, and lone-CR sources', () => {
  assert.deepEqual(wholeFileScope({ filepath: 'empty.txt', source: '' }), [
    { id: '$', source: '', lines: { start: 1, end: 1 } },
  ]);
  assert.deepEqual(wholeFileScope({ filepath: 'one.txt', source: 'one' }), [
    { id: '$', source: 'one', lines: { start: 1, end: 1 } },
  ]);
  assert.deepEqual(wholeFileScope({ filepath: 'no-trailing.txt', source: 'one\ntwo' }), [
    { id: '$', source: 'one\ntwo', lines: { start: 1, end: 2 } },
  ]);
  assert.deepEqual(wholeFileScope({ filepath: 'blank-middle.txt', source: 'a\n\nb' }), [
    { id: '$', source: 'a\n\nb', lines: { start: 1, end: 3 } },
  ]);
  assert.deepEqual(wholeFileScope({ filepath: 'two.txt', source: 'one\ntwo\n' }), [
    { id: '$', source: 'one\ntwo\n', lines: { start: 1, end: 2 } },
  ]);
  assert.deepEqual(wholeFileScope({ filepath: 'crlf.txt', source: 'one\r\ntwo\r\n' }), [
    { id: '$', source: 'one\r\ntwo\r\n', lines: { start: 1, end: 2 } },
  ]);
  assert.deepEqual(wholeFileScope({ filepath: 'cr.txt', source: 'one\rtwo' }), [
    { id: '$', source: 'one\rtwo', lines: { start: 1, end: 2 } },
  ]);
});

class FilePolarityRule extends Rule {
  files = ['**/*.txt'];

  check = (subject: Subject): CheckResult =>
    (subject as ScopeSubject).filepath === 'alpha.txt' ? pass() : violation('beta is out of policy');
}

test('golden: whole-file selection report for a mixed pass/violation run', async () => {
  const project = new GoldenProject('/repo', { 'alpha.txt': 'alpha\n', 'beta.txt': 'beta\n' });

  const reports = await executeRules([loaded('file-polarity', new FilePolarityRule())], goldenContext(project));

  assert.deepEqual(stableReports(reports), [
    {
      name: 'file-polarity',
      ruleFile: '/repo/.coderuler/file-polarity.rule.ts',
      status: 'violation',
      evaluations: [
        {
          subject: { kind: 'scope', filepath: 'alpha.txt', id: '$', source: 'alpha\n', lines: { start: 1, end: 1 } },
          result: { status: 'pass' },
        },
        {
          subject: { kind: 'scope', filepath: 'beta.txt', id: '$', source: 'beta\n', lines: { start: 1, end: 1 } },
          result: { status: 'violation', message: 'beta is out of policy' },
        },
      ],
    },
  ]);
});

class NegativeLevelFolderRule extends Rule {
  files = ['**/*.txt'];
  group = { by: 'folder', level: -1 } as const;

  check = (): CheckResult => pass();
}

test('golden: negative-level folder grouping lifts files to their ancestor folder', async () => {
  const project = new GoldenProject('/repo', {
    'a/b/one.txt': '1\n',
    'a/b/two.txt': '2\n',
    'a/three.txt': '3\n',
    'root.txt': '4\n',
  });

  const reports = await executeRules([loaded('negative-folder', new NegativeLevelFolderRule())], goldenContext(project));

  assert.deepEqual(stableReports(reports), [
    {
      name: 'negative-folder',
      ruleFile: '/repo/.coderuler/negative-folder.rule.ts',
      status: 'pass',
      evaluations: [
        {
          subject: {
            kind: 'group',
            group: { type: 'folder', path: 'a' },
            members: [
              { kind: 'scope', filepath: 'a/b/one.txt', id: '$', source: '1\n', lines: { start: 1, end: 1 } },
              { kind: 'scope', filepath: 'a/b/two.txt', id: '$', source: '2\n', lines: { start: 1, end: 1 } },
            ],
          },
          result: { status: 'pass' },
        },
        {
          subject: {
            kind: 'group',
            group: { type: 'folder', path: '.' },
            members: [
              { kind: 'scope', filepath: 'a/three.txt', id: '$', source: '3\n', lines: { start: 1, end: 1 } },
              { kind: 'scope', filepath: 'root.txt', id: '$', source: '4\n', lines: { start: 1, end: 1 } },
            ],
          },
          result: { status: 'pass' },
        },
      ],
    },
  ]);
});

class DataScopeRule extends Rule {
  files = ['data.json'];

  scope: ScopeSelector = (): readonly ScopeMatch<JsonValue>[] => [
    {
      id: '$.id',
      source: '7',
      data: 7,
      lines: { start: 1, end: 1 },
      captures: { key: 'id', path: ['id'] },
    },
    {
      id: '$.name',
      source: '"alpha"',
      data: 'alpha',
      lines: { start: 1, end: 1 },
    },
  ];

  check = (subject: Subject): CheckResult =>
    (subject as ScopeSubject).data === 7 ? pass() : violation('unexpected data');
}

test('golden: a custom data scope preserves id, data, captures, and lines', async () => {
  const project = new GoldenProject('/repo', { 'data.json': '{"id":7,"name":"alpha"}' });

  const reports = await executeRules([loaded('data-scope', new DataScopeRule())], goldenContext(project));

  assert.deepEqual(stableReports(reports), [
    {
      name: 'data-scope',
      ruleFile: '/repo/.coderuler/data-scope.rule.ts',
      status: 'violation',
      evaluations: [
        {
          subject: {
            kind: 'scope',
            filepath: 'data.json',
            id: '$.id',
            source: '7',
            data: 7,
            lines: { start: 1, end: 1 },
            captures: { key: 'id', path: ['id'] },
          },
          result: { status: 'pass' },
        },
        {
          subject: {
            kind: 'scope',
            filepath: 'data.json',
            id: '$.name',
            source: '"alpha"',
            data: 'alpha',
            lines: { start: 1, end: 1 },
          },
          result: { status: 'violation', message: 'unexpected data' },
        },
      ],
    },
  ]);
});

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const GOLDEN_FIXTURES = join(FIXTURES, 'golden');
const FEATURE_ROOT = join(FIXTURES, 'features');
const RELAXED_ROOT = join(FIXTURES, 'relaxed-policies');
const ABSENT_HOME = join(FIXTURES, 'absent-home');

function isMapping(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: JsonValue | undefined, ...segments: string[]): boolean {
  let current: JsonValue | undefined = value;
  for (const segment of segments) {
    if (!isMapping(current)) return false;
    current = current[segment];
  }
  if (current === null || current === undefined) return false;
  if (typeof current === 'string') return current !== '';
  if (Array.isArray(current)) return current.length > 0;
  if (typeof current === 'object') return Object.keys(current).length > 0;
  return true;
}

class BillingUrlLeavesGoldenRule extends Rule {
  files = ['proto/billing/**/*.proto'];
  exclude = ['proto/billing/generated/**'];
  scope = scopes.protobuf({ path: "$.rpcs[*].options['google.api.http']..['get','put','post','delete','patch','path']" });

  check = (): CheckResult => pass();
}

class BillingRpcsGoldenRule extends Rule {
  files = ['proto/billing/**/*.proto'];
  exclude = ['proto/billing/generated/**'];
  scope = scopes.protobuf({ path: '$.rpcs[*]' });

  filter(subject: ScopeSubject<JsonValue>): boolean {
    return nonEmpty(subject.data, 'options', 'google.api.http');
  }

  check = (): CheckResult => pass();
}

class CorpRouteGoldenRule extends Rule {
  files = ['proto/**/*.proto'];
  scope = scopes.protobuf({ path: "$.rpcs[*].options['corp.http.route'].*" });

  check = (): CheckResult => pass();
}

class MemoryContainersGoldenRule extends Rule {
  files = ['charts/**/*.yaml'];
  scope = scopes.yaml({ path: '$.containers[*]', key: '$.name' });

  filter(subject: ScopeSubject<JsonValue>): boolean {
    return (
      nonEmpty(subject.data, 'resources', 'requests', 'memory')
      || nonEmpty(subject.data, 'resources', 'limits', 'memory')
    );
  }

  check = (): CheckResult => pass();
}

class GoAppendSliceGoldenRule extends Rule {
  files = ['**/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        kind: 'for_statement',
        stopBy: 'end',
        has: { pattern: 'append($SLICE,$$$ARGS)', stopBy: 'end' },
      },
    },
  });

  check = (): CheckResult => pass();
}

const GOLDEN_RULE_FACTORIES: Readonly<Record<string, () => Rule>> = {
  'billing-http-url-leaves': () => new BillingUrlLeavesGoldenRule(),
  'billing-http-url': () => new BillingRpcsGoldenRule(),
  'corp-http-route': () => new CorpRouteGoldenRule(),
  'memory-ratio': () => new MemoryContainersGoldenRule(),
  'go-slice-append': () => new GoAppendSliceGoldenRule(),
};

async function runGoldenFixture(group: string, name: string, rule: Rule): Promise<readonly RuleReport[]> {
  const project = createProject(join(GOLDEN_FIXTURES, group, name));
  return executeRules([loaded(group, rule)], goldenContext(project));
}

for (const golden of GOLDEN_CASES) {
  test(`golden: ${golden.group}/${golden.name} keeps its archived source fidelity`, async () => {
    const factory = GOLDEN_RULE_FACTORIES[golden.group];
    assert.ok(factory !== undefined, `no golden rule for ${golden.group}`);
    const reports = await runGoldenFixture(golden.group, golden.name, factory());
    const outcome =
      golden.status === 'skipped'
        ? { status: 'skipped', reason: golden.reason, evaluations: [] }
        : { status: 'pass', evaluations: golden.evaluations };
    assert.deepEqual(stableReports(reports), [
      { name: golden.group, ruleFile: `${RULE_DIR}/${golden.group}.rule.ts`, ...outcome },
    ]);
  });
}

async function loadFeatureRules(): Promise<readonly LoadedRule[]> {
  return createRuleLoader({ home: ABSENT_HOME }).load({ root: FEATURE_ROOT, invocationCwd: FEATURE_ROOT });
}

function summarizeReports(reports: readonly RuleReport[]) {
  return stableReports(reports).map(report => ({
    name: report.name,
    status: report.status,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
    evaluations: report.evaluations.map(({ subject, result }) => ({
      id: subject.kind === 'scope' ? subject.id : subject.group.path,
      data: subject.kind === 'scope' ? (subject.data ?? null) : null,
      result,
    })),
  }));
}

test('fixture: the feature project discovers rule modules and ignores its helper', async () => {
  const featureRules = await loadFeatureRules();

  assert.deepEqual(
    featureRules.map(entry => entry.name),
    [
      'conditional-ai',
      'csv-rows',
      'custom-check',
      'custom-selector',
      'file-notes',
      'infra-placement',
      'json-config',
      'when-gated',
    ],
  );
  for (const entry of featureRules) {
    assert.ok(entry.ruleFile.endsWith(`.coderuler/${entry.name}.rule.ts`), entry.ruleFile);
  }
});

test('fixture: when, JSON, CSV, file, custom selection, and custom checks drive the engine', async () => {
  const featureRules = await loadFeatureRules();
  const deterministic = featureRules.filter(
    entry => entry.name !== 'conditional-ai' && entry.name !== 'infra-placement',
  );
  const project = createProject(FEATURE_ROOT, {
    excludeFiles: featureRules.map(entry => entry.ruleFile),
  });
  const events: RunEvent[] = [];

  const reports = await executeRules(deterministic, {
    project,
    isTarget: () => true,
    concurrency: 4,
    resolveDecision: () => {
      throw new Error('deterministic feature rules must not resolve a decision runtime');
    },
    emit: event => {
      events.push(event);
    },
  });

  assert.deepEqual(summarizeReports(reports), [
    {
      name: 'csv-rows',
      status: 'violation',
      evaluations: [
        {
          id: 'billing',
          data: { name: 'billing', team: 'payments', owner: 'alice' },
          result: { status: 'pass' },
        },
        {
          id: 'ledger',
          data: { name: 'ledger', team: 'payments', owner: 'unknown' },
          result: { status: 'violation', message: 'row "ledger" names an unknown owner' },
        },
        {
          id: 'audit',
          data: { name: 'audit', team: 'risk', owner: 'bob' },
          result: { status: 'pass' },
        },
      ],
    },
    {
      name: 'custom-check',
      status: 'violation',
      evaluations: [
        {
          id: '$',
          data: null,
          result: {
            status: 'violation',
            message: 'data/rows.csv names owners outside data/config.json: ledger -> unknown',
          },
        },
      ],
    },
    {
      name: 'custom-selector',
      status: 'violation',
      evaluations: [
        {
          id: 'owner@1',
          data: { owner: 'platform' },
          result: {
            status: 'violation',
            message: 'owner "platform" must be replaced by an owning team',
          },
        },
      ],
    },
    {
      name: 'file-notes',
      status: 'violation',
      evaluations: [
        { id: '$', data: null, result: { status: 'pass' } },
        {
          id: '$',
          data: null,
          result: { status: 'violation', message: 'unfinished work in "docs/notes/two.txt"' },
        },
      ],
    },
    {
      name: 'json-config',
      status: 'violation',
      evaluations: [
        {
          id: 'billing',
          data: { name: 'billing', replicas: 3, team: 'payments' },
          result: { status: 'pass' },
        },
        {
          id: 'ledger',
          data: { name: 'ledger', replicas: 7, team: 'payments' },
          result: { status: 'violation', message: 'service "ledger" runs 7 replicas, above the 3 allowed' },
        },
      ],
    },
    {
      name: 'when-gated',
      status: 'violation',
      evaluations: [
        { id: 'function_declaration:OpenStore', data: null, result: { status: 'pass' } },
        {
          id: 'function_declaration:MustOpen',
          data: null,
          result: {
            status: 'violation',
            message: 'infrastructure returns errors instead of panicking',
          },
        },
      ],
    },
  ]);
  assert.deepEqual(
    events.filter(event => event.type === 'progress'),
    [
      ...Array.from({ length: 7 }, (_, completed) => ({
        type: 'progress', phase: 'selection', completed, total: 6,
      })),
      ...Array.from({ length: 12 }, (_, completed) => ({
        type: 'progress', phase: 'evaluation', completed, total: 11,
      })),
    ],
  );
  const starts = events.filter(event => event.type === 'evaluation');
  const expectedEvaluations = reports.flatMap(report =>
    report.evaluations.map(evaluation => ({ name: report.name, ...evaluation })),
  );
  assert.deepEqual(starts.map(({ evaluationId, name, subject }) =>
    ({ evaluationId, name, subject }),
  ), expectedEvaluations.map(({ name, subject }, index) =>
    ({ evaluationId: index + 1, name, subject }),
  ));
  const terminals = events.filter(event => event.type === 'result' || event.type === 'error');
  assert.equal(terminals.length, expectedEvaluations.length);
  for (const event of terminals) {
    assert.equal(event.type, 'result');
    if (event.type !== 'result') continue;
    const start = starts[event.evaluationId - 1];
    const expected = expectedEvaluations[event.evaluationId - 1];
    assert.ok(start && expected);
    assert.ok(events.indexOf(start) < events.indexOf(event));
    assert.deepEqual(
      { name: event.name, subject: event.subject, result: event.result },
      expected,
    );
  }
  assert.deepEqual(terminals.map(event => event.evaluationId).sort((a, b) => a! - b!), [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  ]);

  assert.ok(
    events.some(
      event =>
        event.type === 'gate'
        && event.name === 'when-gated'
        && event.applies
        && event.reason === 'infrastructure rules need internal/adapter',
    ),
  );
  assert.ok(
    events.some(
      event =>
        event.type === 'scope'
        && event.name === 'when-gated'
        && event.subject.id === 'function_declaration:BusinessPolicy'
        && !event.accepted
        && event.reason === 'business functions belong outside infrastructure',
    ),
  );
  assert.ok(
    events.some(
      event =>
        event.type === 'scope'
        && event.name === 'json-config'
        && event.subject.id === 'audit'
        && !event.accepted
        && event.reason === 'service declares no replica count',
    ),
  );
  assert.ok(
    events.some(
      event =>
        event.type === 'scope'
        && event.name === 'custom-selector'
        && event.subject.id === 'owner@7'
        && !event.accepted
        && event.reason === 'payments owners are reviewed by another rule',
    ),
  );
  assert.ok(
    !events.some(
      event => event.type === 'scope' && event.name === 'custom-selector' && event.subject.id === 'owner@4',
    ),
  );
  assert.ok(
    events.some(
      event =>
        event.type === 'file'
        && event.name === 'file-notes'
        && event.filepath === 'docs/notes/two.txt'
        && event.selected,
    ),
  );
  assert.ok(
    events.some(
      event =>
        event.type === 'trace'
        && event.name === 'custom-check'
        && event.evaluationId === 4
        && event.message === 'cross-referenced project data',
    ),
  );

  const selectorEntry = featureRules.find(entry => entry.name === 'custom-selector');
  assert.ok(selectorEntry !== undefined);
  assert.deepEqual(
    stableReports(reports).filter(report => report.name === 'custom-selector'),
    [
      {
        name: 'custom-selector',
        ruleFile: selectorEntry.ruleFile,
        status: 'violation',
        evaluations: [
          {
            subject: {
              kind: 'scope',
              filepath: 'data/values.yaml',
              id: 'owner@1',
              source: '# owner: platform',
              data: { owner: 'platform' },
              lines: { start: 1, end: 1 },
              captures: { owner: 'platform' },
            },
            result: {
              status: 'violation',
              message: 'owner "platform" must be replaced by an owning team',
            },
          },
        ],
      },
    ],
  );
});

test('fixture: a strict policy reaches the backend while a relaxed one never resolves it', async () => {
  const featureRules = await loadFeatureRules();
  const conditional = featureRules.filter(entry => entry.name === 'conditional-ai');
  const strictProject = createProject(FEATURE_ROOT, {
    excludeFiles: featureRules.map(entry => entry.ruleFile),
  });
  const requests: DecisionRequest[] = [];

  const strictReports = await executeRules(conditional, {
    project: strictProject,
    isTarget: () => true,
    concurrency: 2,
    resolveDecision: settings => {
      assert.deepEqual(settings, {});
      return {
        threshold: 0.4,
        pricing: { inputCostPerMillion: 0.042, outputCostPerMillion: 0 },
        backend: {
          decide: async request => {
            requests.push(request);
            return { probability: 1, model: 'fixture-stub' };
          },
        },
      };
    },
    emit: () => {},
  });

  assert.deepEqual(summarizeReports(strictReports), [
    {
      name: 'conditional-ai',
      status: 'pass',
      evaluations: [
        { id: 'logging', data: { id: 'logging', strict: false }, result: { status: 'pass' } },
        {
          id: 'secrets',
          data: { id: 'secrets', strict: true },
          result: {
            status: 'pass', probability: 1, threshold: 0.4, model: 'fixture-stub',
            usage: { calls: 1, unreportedCalls: 1, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0 },
          },
        },
      ],
    },
  ]);
  assert.deepEqual(requests, [
    {
      state: { policy: 'secrets', settings: { id: 'secrets', strict: true } },
      instructions: {
        rule: 'A strict policy must name an owning team and an enforcement limit.',
        question: 'Is the rule respected?',
        examples: {
          good: ['id: secrets\nstrict: true\nowner: security\nlimit: 30'],
          bad: ['id: secrets\nstrict: true'],
        },
      },
    },
  ]);

  const relaxed = await createRuleLoader({ home: ABSENT_HOME }).load({
    root: RELAXED_ROOT,
    explicit: join(FEATURE_ROOT, '.coderuler', 'conditional-ai.rule.ts'),
    invocationCwd: FEATURE_ROOT,
  });
  assert.deepEqual(relaxed.map(entry => entry.name), ['conditional-ai']);

  const relaxedReports = await executeRules(relaxed, {
    project: createProject(RELAXED_ROOT, { excludeFiles: relaxed.map(entry => entry.ruleFile) }),
    isTarget: () => true,
    concurrency: 1,
    resolveDecision: () => {
      throw new Error('a non-strict policy must not resolve a decision runtime');
    },
    emit: () => {},
  });

  assert.deepEqual(summarizeReports(relaxedReports), [
    {
      name: 'conditional-ai',
      status: 'pass',
      evaluations: [
        { id: 'logging', data: { id: 'logging', strict: false }, result: { status: 'pass' } },
        { id: 'metrics', data: { id: 'metrics', strict: false }, result: { status: 'pass' } },
      ],
    },
  ]);
});

test('fixture: the approved ai example is skipped when its directory gate fails', async () => {
  const featureRules = await loadFeatureRules();
  const placement = featureRules.filter(entry => entry.name === 'infra-placement');
  const [entry] = placement;
  assert.ok(entry !== undefined);

  const reports = await executeRules(placement, {
    project: createProject(join(FEATURE_ROOT, 'data')),
    isTarget: () => true,
    concurrency: 1,
    resolveDecision: () => {
      throw new Error('a skipped rule must not resolve a decision runtime');
    },
    emit: () => {},
  });

  assert.deepEqual(stableReports(reports), [
    {
      name: 'infra-placement',
      ruleFile: entry.ruleFile,
      status: 'skipped',
      reason: 'when returned false',
      evaluations: [],
    },
  ]);
});

const DUPLICATED_ENV_RULE = fileURLToPath(new URL('../.coderuler/duplicated-env.rule.ts', import.meta.url));
const tempRoots: string[] = [];

after(async () => {
  await Promise.all(tempRoots.map(root => rm(root, { recursive: true, force: true })));
});

async function makeManualRoot(label: string, files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), `coderuler-${label}-`));
  tempRoots.push(root);
  for (const [filepath, source] of Object.entries(files)) {
    const target = join(root, filepath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source, 'utf8');
  }
  return root;
}

async function loadDuplicatedEnv(root: string): Promise<readonly LoadedRule[]> {
  const rules = await createRuleLoader({ home: ABSENT_HOME }).load({
    root,
    explicit: DUPLICATED_ENV_RULE,
    invocationCwd: root,
  });
  for (const { rule } of rules) rule.enabled = true;
  return rules;
}

function subjectShape(subject: Subject<JsonValue>) {
  if (subject.kind === 'group') {
    return {
      group: subject.group,
      members: subject.members.map(member => ({
        filepath: member.filepath,
        id: member.id,
        data: member.data ?? null,
      })),
    };
  }
  return { filepath: subject.filepath, id: subject.id, data: subject.data ?? null };
}

test('golden: duplicated-env skips scopes whose env values are all empty', async () => {
  const root = await makeManualRoot('duplicated-env-empty', {
    'tests/manual/all-empty.yml': `global:
  env:
    text:
      EMPTY_STRING: ''
      NULL_VALUE: null
      EMPTY_LIST: []
      EMPTY_MAP: {}
`,
    'tests/manual/blank-values.yml': `global:
  env:
    text:
      TOKEN: ''
      LABELS: {}
      NAMES: []
`,
    'tests/manual/empty-list.yml': `global:
  env:
    text: []
`,
    'tests/manual/empty-map.yml': `global:
  env:
    text: {}
`,
  });
  const rules = await loadDuplicatedEnv(root);
  assert.deepEqual(rules.map(ruleEntry => ruleEntry.name), ['duplicated-env']);
  const [entry] = rules;
  assert.ok(entry !== undefined);

  const events: RunEvent[] = [];

  const reports = await executeRules(rules, {
    project: createProject(root, { excludeFiles: rules.map(ruleEntry => ruleEntry.ruleFile) }),
    isTarget: () => true,
    concurrency: 2,
    resolveDecision: () => {
      throw new Error('duplicated-env must not call the decision backend');
    },
    emit: event => {
      events.push(event);
    },
  });

  assert.deepEqual(
    events.flatMap(event =>
      event.type === 'scope'
        ? [{ filepath: event.subject.filepath, id: event.subject.id, accepted: event.accepted }]
        : [],
    ),
    [
      { filepath: 'tests/manual/all-empty.yml', id: '0:/global/env/text', accepted: false },
      { filepath: 'tests/manual/blank-values.yml', id: '0:/global/env/text', accepted: false },
      { filepath: 'tests/manual/empty-list.yml', id: '0:/global/env/text', accepted: false },
      { filepath: 'tests/manual/empty-map.yml', id: '0:/global/env/text', accepted: false },
    ],
  );
  assert.equal(events.filter(event => event.type === 'group').length, 0);
  assert.deepEqual(stableReports(reports), [
    {
      name: 'duplicated-env',
      ruleFile: entry.ruleFile,
      status: 'skipped',
      reason: 'no matching subjects',
      evaluations: [],
    },
  ]);
});

test('golden: duplicated-env keeps zero, false, and nonempty env values in one folder group', async () => {
  const root = await makeManualRoot('duplicated-env-kept', {
    'tests/manual/default.yml': `global:
  env:
    text:
      LOG_LEVEL: info
`,
    'tests/manual/production.yml': `global:
  env:
    text:
      RETRIES: 0
`,
    'tests/manual/staging.yml': `global:
  env:
    text:
      FEATURE_ENABLED: false
      EMPTY_STRING: ''
`,
    'tests/manual/timeouts.yml': `global:
  env:
    text:
      TIMEOUT_SECONDS: 0
`,
  });
  const rules = await loadDuplicatedEnv(root);
  assert.deepEqual(rules.map(ruleEntry => ruleEntry.name), ['duplicated-env']);

  const reports = await executeRules(rules, {
    project: createProject(root, { excludeFiles: rules.map(ruleEntry => ruleEntry.ruleFile) }),
    isTarget: () => true,
    concurrency: 2,
    resolveDecision: () => {
      throw new Error('duplicated-env must not call the decision backend');
    },
    emit: () => {},
  });

  assert.deepEqual(
    stableReports(reports).map(report => ({
      name: report.name,
      status: report.status,
      evaluations: report.evaluations.map(({ subject, result }) => ({ subject: subjectShape(subject), result })),
    })),
    [
      {
        name: 'duplicated-env',
        status: 'pass',
        evaluations: [
          {
            subject: {
              group: { type: 'folder', path: 'tests/manual' },
              members: [
                { filepath: 'tests/manual/default.yml', id: '0:/global/env/text', data: { LOG_LEVEL: 'info' } },
                { filepath: 'tests/manual/production.yml', id: '0:/global/env/text', data: { RETRIES: 0 } },
                {
                  filepath: 'tests/manual/staging.yml',
                  id: '0:/global/env/text',
                  data: { FEATURE_ENABLED: false, EMPTY_STRING: '' },
                },
                { filepath: 'tests/manual/timeouts.yml', id: '0:/global/env/text', data: { TIMEOUT_SECONDS: 0 } },
              ],
            },
            result: { status: 'pass' },
          },
        ],
      },
    ],
  );
});

