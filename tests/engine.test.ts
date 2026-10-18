import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import { after, test } from 'node:test';

import { Rule, ai, pass, regex, violation } from '../dist/index.js';
import type {
  Awaitable,
  CheckContext,
  CheckResult,
  CsvRow,
  DecisionBackend,
  DecisionObserver,
  DecisionOutcome,
  DecisionRequest,
  DecisionRuntime,
  Evaluator,
  Grouping,
  GroupSubject,
  JsonValue,
  LoadedRule,
  PredicateResult,
  Project,
  ProjectContext,
  RuleLoader,
  RuleReport,
  RuleSelection,
  RuleSettings,
  RunContext,
  RunEvent,
  ScopeMatch,
  ScopeSelector,
  ScopeSubject,
  SelectionContext,
  Subject,
  TokenUsage,
} from '../dist/index.js';
import { executeRules, validateRules } from '../dist/app/execute.js';
import { wholeFileScope } from '../dist/app/selection.js';
import { createUsageTracker } from '../dist/adapter/cli/inspect-usage.js';
import { UNREPORTED_AI_USAGE, createSandbox, expectFailure, parseCheckOutput, runCli, writeFile } from './support.ts';

const cliSandbox = createSandbox('rulekeeper-engine-');
after(() => cliSandbox.cleanup());

const SELECTION: RuleSelection = { root: '/repo', invocationCwd: '/repo' };
const RULE_DIR = '/repo/.rulekeeper';

class MemoryProject implements Project {
  readonly root: string;
  readonly reads: string[] = [];
  readonly #files: Map<string, string>;
  readonly #dirs: Set<string>;

  constructor(
    root = '/repo',
    files: Readonly<Record<string, string>> = {},
    dirs: readonly string[] = [],
  ) {
    this.root = root;
    this.#files = new Map(Object.entries(files));
    this.#dirs = new Set(dirs);
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
    if (this.#files.has(path)) return { kind: 'file' };
    if (this.#dirs.has(path)) return { kind: 'directory' };
    return undefined;
  }

  async readText(path: string): Promise<string> {
    this.reads.push(path);
    const text = this.#files.get(path);
    if (text === undefined) throw new Error(`Missing file ${path}`);
    return text;
  }

  async readJson(path: string): Promise<JsonValue> {
    return JSON.parse(await this.readText(path)) as JsonValue;
  }

  async readYaml(): Promise<readonly JsonValue[]> {
    throw new Error('MemoryProject does not read YAML');
  }

  async readCsv(): Promise<readonly CsvRow[]> {
    throw new Error('MemoryProject does not read CSV');
  }
}

class RecordingBackend implements DecisionBackend {
  readonly requests: DecisionRequest[] = [];
  probabilities: number[] = [];
  usages: (TokenUsage | undefined)[] = [];
  failures: (Error | undefined)[] = [];
  model = 'recording-model';

  async decide(request: DecisionRequest, observer?: DecisionObserver): Promise<DecisionOutcome> {
    this.requests.push(request);
    observer?.({ type: 'request', body: JSON.stringify(request) });
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    const probability = this.probabilities.shift() ?? 0.9;
    const usage = this.usages.shift();
    const outcome: DecisionOutcome = { probability, model: this.model, ...(usage === undefined ? {} : { usage }) };
    observer?.({ type: 'response', status: 200, body: JSON.stringify(outcome) });
    return outcome;
  }
}

interface HarnessOptions {
  readonly concurrency?: number;
  readonly isTarget?: (filepath: string) => boolean;
  readonly threshold?: number;
}

class Harness {
  readonly events: RunEvent[] = [];
  readonly backend = new RecordingBackend();
  resolveCalls = 0;
  readonly context: RunContext;

  constructor(project: Project, options: HarnessOptions = {}) {
    const backend = this.backend;
    const fallbackThreshold = options.threshold ?? 0.4;
    this.context = {
      project,
      isTarget: options.isTarget ?? (() => true),
      concurrency: options.concurrency ?? 8,
      resolveDecision: (settings: RuleSettings): DecisionRuntime => {
        this.resolveCalls += 1;
        return {
          backend,
          threshold: settings.threshold ?? fallbackThreshold,
          pricing: {
            inputCostPerMillion: settings.inputCostPerMillion ?? 0.042,
            outputCostPerMillion: settings.outputCostPerMillion ?? 0,
          },
        };
      },
      emit: (event: RunEvent): void => {
        this.events.push(event);
      },
    };
  }
}

interface RuleBehavior {
  readonly files?: readonly string[];
  readonly exclude?: readonly string[];
  readonly group?: Grouping;
  readonly scope?: ScopeSelector<JsonValue>;
  readonly when?: (context: ProjectContext) => Awaitable<PredicateResult>;
  readonly filter?: (subject: ScopeSubject<JsonValue>, context: ProjectContext) => Awaitable<PredicateResult>;
  readonly select?: (context: SelectionContext) => Awaitable<readonly ScopeSubject<JsonValue>[]>;
  readonly check?: (subject: Subject<JsonValue>, context: CheckContext<JsonValue>) => Awaitable<CheckResult>;
}

class TestRule extends Rule {
  whenCalls = 0;
  filterCalls = 0;
  selectCalls = 0;
  checkCalls = 0;
  readonly boundThis: boolean[] = [];
  readonly #behavior: RuleBehavior;
  readonly check: Evaluator<JsonValue>;

  constructor(behavior: RuleBehavior = {}) {
    super();
    this.#behavior = behavior;
    if (behavior.files !== undefined) this.files = behavior.files;
    if (behavior.exclude !== undefined) this.exclude = behavior.exclude;
    if (behavior.group !== undefined) this.group = behavior.group;
    if (behavior.scope !== undefined) this.scope = behavior.scope;
    this.check = function (this: TestRule, subject: Subject, context: CheckContext): Awaitable<CheckResult> {
      this.checkCalls += 1;
      this.boundThis.push(this instanceof TestRule);
      return behavior.check === undefined ? pass() : behavior.check(subject, context);
    };
  }

  async when(context: ProjectContext): Promise<PredicateResult> {
    this.whenCalls += 1;
    this.boundThis.push(this instanceof TestRule);
    return this.#behavior.when === undefined ? true : this.#behavior.when(context);
  }

  async filter(subject: ScopeSubject, context: ProjectContext): Promise<PredicateResult> {
    this.filterCalls += 1;
    this.boundThis.push(this instanceof TestRule);
    return this.#behavior.filter === undefined ? true : this.#behavior.filter(subject, context);
  }

  async select(context: SelectionContext): Promise<readonly ScopeSubject[]> {
    this.selectCalls += 1;
    this.boundThis.push(this instanceof TestRule);
    return this.#behavior.select === undefined ? super.select(context) : this.#behavior.select(context);
  }
}

function loaded(name: string, rule: TestRule, ruleFile = `${RULE_DIR}/${name}.rule.ts`): LoadedRule {
  return { name, ruleFile, rule: rule as unknown as Rule<unknown> };
}

async function runRule(
  rule: TestRule,
  project: MemoryProject,
  options: HarnessOptions = {},
  name = 'probe',
): Promise<{ report: RuleReport; harness: Harness }> {
  const harness = new Harness(project, options);
  const reports = await executeRules([loaded(name, rule)], harness.context);
  const report = reports[0];
  assert.ok(report, 'expected exactly one rule report');
  assert.equal(reports.length, 1);
  assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0);
  return { report, harness };
}

function eventsOfType<K extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: K,
): Extract<RunEvent, { type: K }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: K }> => event.type === type);
}

function assertEvaluationLifecycle(events: readonly RunEvent[]): void {
  const started = new Map<number, Extract<RunEvent, { type: 'evaluation' }>>();
  const terminal = new Set<number>();
  for (const event of events) {
    if (event.type === 'evaluation') {
      assert.ok(Number.isSafeInteger(event.evaluationId) && event.evaluationId > 0);
      assert.ok(!started.has(event.evaluationId), 'evaluation IDs must be unique within a run');
      started.set(event.evaluationId, event);
      continue;
    }
    if (event.type === 'request' || event.type === 'response' || event.type === 'usage' || event.type === 'result') {
      assert.equal(typeof event.evaluationId, 'number');
    }
    if (!('evaluationId' in event) || event.evaluationId === undefined) continue;
    const start = started.get(event.evaluationId);
    assert.ok(start, `${event.type} must follow its evaluation start`);
    assert.equal(event.name, start.name);
    assert.ok(!terminal.has(event.evaluationId), `${event.type} must precede its evaluation terminal`);
    if ('subject' in event) assert.deepEqual(event.subject, start.subject);
    if (event.type === 'result' || event.type === 'error') terminal.add(event.evaluationId);
  }
  assert.deepEqual([...terminal].sort((a, b) => a - b), [...started.keys()].sort((a, b) => a - b));
}

function asScope(subject: Subject): ScopeSubject {
  if (subject.kind !== 'scope') throw new Error('expected a scope subject');
  return subject;
}

function asGroup(subject: Subject): GroupSubject {
  if (subject.kind !== 'group') throw new Error('expected a group subject');
  return subject;
}

function scopeSubject(
  filepath: string,
  id: string,
  source: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind: 'scope', filepath, id, source, ...extra };
}

function stableReports(reports: readonly RuleReport[]) {
  return reports.map(({ durationMs, ...report }) => {
    assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
    return report;
  });
}

test('validateRules validates every loaded module before any hook runs', async () => {
  const first = new TestRule({ files: ['**/*.txt'] });
  const second = new TestRule({ files: ['**/*.json'] });
  const entries: LoadedRule[] = [loaded('first', first), loaded('second', second)];
  const loader: RuleLoader = {
    async load(): Promise<readonly LoadedRule[]> {
      return entries;
    },
  };

  const result = await validateRules(loader, SELECTION);

  assert.deepEqual(result.map(entry => entry.name), ['first', 'second']);
  for (const rule of [first, second]) {
    assert.equal(rule.whenCalls, 0);
    assert.equal(rule.selectCalls, 0);
    assert.equal(rule.checkCalls, 0);
  }
});

test('validateRules surfaces loader failures', async () => {
  const loader: RuleLoader = {
    async load(): Promise<readonly LoadedRule[]> {
      throw new Error('module /repo/.rulekeeper/broken.rule.ts failed to load');
    },
  };
  await assert.rejects(() => validateRules(loader, SELECTION), /broken\.rule\.ts failed to load/);
});

test('disabled rules are skipped without running any hook or reading sources', async () => {
  const rule = new TestRule({ files: ['**/*.txt'] });
  rule.enabled = false;
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });

  const { report, harness } = await runRule(rule, project, {}, 'off');

  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'disabled');
  assert.deepEqual(report.evaluations, []);
  assert.equal(report.ruleFile, `${RULE_DIR}/off.rule.ts`);
  assert.equal(rule.whenCalls, 0);
  assert.equal(rule.selectCalls, 0);
  assert.equal(rule.checkCalls, 0);
  assert.deepEqual(project.reads, []);

  const gate = eventsOfType(harness.events, 'gate');
  assert.equal(gate.length, 1);
  assert.equal(gate[0]?.name, 'off');
  assert.equal(gate[0]?.enabled, false);
  assert.equal(gate[0]?.applies, false);
  assert.equal(eventsOfType(harness.events, 'file').length, 0);
});

test('when false skips before reading sources; reason is reported', async () => {
  const rule = new TestRule({ files: ['**/*.txt'], when: () => false });
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });

  const { report, harness } = await runRule(rule, project, {}, 'gate');

  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'when returned false');
  assert.deepEqual(report.evaluations, []);
  assert.equal(rule.whenCalls, 1);
  assert.equal(rule.selectCalls, 0);
  assert.equal(rule.checkCalls, 0);
  assert.deepEqual(project.reads, []);

  const gate = eventsOfType(harness.events, 'gate');
  assert.equal(gate.length, 1);
  assert.equal(gate[0]?.enabled, true);
  assert.equal(gate[0]?.applies, false);
  assert.equal(eventsOfType(harness.events, 'file').length, 0);
});

test('a structured gate reason is reported verbatim and applies:true proceeds', async () => {
  const skipped = new TestRule({
    files: ['**/*.txt'],
    when: () => ({ applies: false, reason: 'internal/adapter is absent' }),
  });
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });
  const first = await runRule(skipped, project, {}, 'structured');
  assert.equal(first.report.status, 'skipped');
  assert.equal(first.report.reason, 'internal/adapter is absent');

  const passing = new TestRule({
    files: ['**/*.txt'],
    when: () => ({ applies: true, reason: 'adapter present' }),
  });
  const second = await runRule(passing, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'structured');
  assert.equal(second.report.status, 'pass');
  assert.equal(second.report.evaluations.length, 1);
});

test('a throwing gate rejects the run and emits a named error event', async () => {
  const failure = new Error('gate exploded');
  const rule = new TestRule({
    files: ['**/*.txt'],
    when: () => {
      throw failure;
    },
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));

  await assert.rejects(() => executeRules([loaded('boom', rule)], harness.context), error => error === failure);

  const errors = eventsOfType(harness.events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.name, 'boom');
  assert.match(errors[0]?.message ?? '', /gate exploded/);
  assert.ok((errors[0]?.stage.length ?? 0) > 0);
  assert.equal(rule.checkCalls, 0);
  assert.deepEqual(eventsOfType(harness.events, 'progress'), [
    { type: 'progress', phase: 'selection', completed: 0, total: 1 },
  ]);
});

test('a malformed gate return is an error, not a skip', async () => {
  const rule = new TestRule({ when: () => 'yes' as unknown as PredicateResult });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  await assert.rejects(() => executeRules([loaded('malformed', rule)], harness.context));
});

test('a rule matching no files is skipped as no matching subjects', async () => {
  const rule = new TestRule({ files: ['**/*.md'] });
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });

  const { report, harness } = await runRule(rule, project, {}, 'empty');

  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'no matching subjects');
  assert.deepEqual(report.evaluations, []);
  assert.equal(rule.selectCalls, 1);
  assert.equal(rule.checkCalls, 0);
  const gate = eventsOfType(harness.events, 'gate');
  assert.equal(gate[0]?.applies, true);
});

test('default selection is lexical, exclusion wins, and gates run once', async () => {
  const rule = new TestRule({ files: ['**/*.txt'], exclude: ['**/skip*'] });
  const project = new MemoryProject('/repo', { 'b.txt': 'B', 'a.txt': 'A', 'skip-c.txt': 'C' });

  const { report, harness } = await runRule(rule, project, {}, 'lexical');

  assert.deepEqual(report.evaluations.map(evaluation => asScope(evaluation.subject).filepath), [
    'a.txt',
    'b.txt',
  ]);
  assert.equal(rule.whenCalls, 1);
  assert.equal(rule.selectCalls, 1);
  assert.deepEqual(project.reads, ['a.txt', 'b.txt']);

  const files = eventsOfType(harness.events, 'file');
  const selected = files.filter(event => event.selected).map(event => event.filepath);
  assert.deepEqual(selected, ['a.txt', 'b.txt']);
  const excluded = files.find(event => event.filepath === 'skip-c.txt');
  assert.ok(excluded, 'expected a file event for the excluded file');
  assert.equal(excluded.selected, false);
  assert.ok((excluded.reason?.length ?? 0) > 0);
});

test('the CLI target narrows default selection', async () => {
  const rule = new TestRule({ files: ['**/*.txt'] });
  const project = new MemoryProject('/repo', { 'a/one.txt': '1', 'b/two.txt': '2' });

  const { report } = await runRule(rule, project, { isTarget: filepath => filepath.startsWith('a/') }, 'target');

  assert.deepEqual(report.evaluations.map(evaluation => asScope(evaluation.subject).filepath), ['a/one.txt']);
});

test('whole-file default selection attaches kind/filepath and the shared whole-file scope', async () => {
  const project = new MemoryProject('/repo', { 'a.txt': 'one\ntwo\n' });
  const rule = new TestRule({ files: ['a.txt'] });

  const { report } = await runRule(rule, project, {}, 'whole');

  const subject = asScope(report.evaluations[0]?.subject ?? ({} as Subject));
  assert.deepEqual(subject, { ...wholeFileScope({ filepath: 'a.txt', source: 'one\ntwo\n' })[0], kind: 'scope', filepath: 'a.txt' });
  assert.equal(subject.id, '$');
  assert.equal(subject.source, 'one\ntwo\n');
  assert.deepEqual(subject.lines, { start: 1, end: 2 });
});

test('scope selectors reject missing array entries instead of silently skipping them', async () => {
  const inherited = new Array<ScopeMatch>(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), {
    0: { id: 'inherited', source: 'A' },
  }));
  const missingFirst = new Array<ScopeMatch>(2);
  missingFirst[1] = { id: 'present', source: 'A' };
  const missingLast = [{ id: 'present', source: 'A' }];
  missingLast.length = 2;
  for (const matches of [new Array<ScopeMatch>(1), missingFirst, missingLast, inherited]) {
    const rule = new TestRule({ files: ['a.txt'], scope: () => matches });
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
    await assert.rejects(
      () => executeRules([loaded('sparse', rule)], harness.context),
      /scope.*a\.txt\[\d+\]/,
    );
    assert.equal(rule.filterCalls, 0);
    assert.equal(rule.checkCalls, 0);
    assert.equal(eventsOfType(harness.events, 'result').length, 0);
  }
});

test('scope selectors preserve genuine empty results and ordered dense results', async () => {
  const project = new MemoryProject('/repo', { 'a.txt': 'A', 'b.txt': 'B' });
  const empty = new TestRule({ files: ['*.txt'], scope: () => [] });
  const skipped = await runRule(empty, project);
  assert.equal(skipped.report.status, 'skipped');
  assert.equal(skipped.report.reason, 'no matching subjects');
  assert.equal(empty.checkCalls, 0);

  const laterFile = Promise.withResolvers<void>();
  const dense = new TestRule({
    files: ['*.txt'],
    scope: async file => {
      if (file.filepath === 'a.txt') await laterFile.promise;
      else laterFile.resolve();
      return [{ id: 'second', source: file.source }, { id: 'first', source: file.source }];
    },
  });
  const checked = await runRule(dense, project, { concurrency: 2 });
  assert.deepEqual(
    checked.report.evaluations.map(({ subject }) => [asScope(subject).filepath, asScope(subject).id]),
    [['a.txt', 'second'], ['a.txt', 'first'], ['b.txt', 'second'], ['b.txt', 'first']],
  );
});

test('CLI rejects sparse scope results but keeps a genuine empty scope result skipped', async () => {
  const target = cliSandbox.isolated('scope-array');
  writeFile(`${target.cwd}/visible.txt`, 'visible');
  const ruleFile = `${target.cwd}/.rulekeeper/scopes.rule.ts`;
  writeFile(ruleFile, `import { Rule, pass, type ScopeMatch } from 'rulekeeper';
export default class Scopes extends Rule {
  files = ['visible.txt'];
  scope = () => new Array<ScopeMatch>(1);
  check = pass;
}
`);
  const rejected = await runCli(['check', '--json'], target);
  expectFailure(rejected, 'sparse scope result');
  assert.match(rejected.stderr, /scope.*visible\.txt\[0\]/);

  writeFile(ruleFile, `import { Rule, pass } from 'rulekeeper';
export default class Scopes extends Rule {
  files = ['visible.txt'];
  scope = () => [];
  check = pass;
}
`);
  const accepted = await runCli(['check', '--json', '--output-all'], target);
  assert.equal(accepted.status, 0);
  const reports = parseCheckOutput(accepted, 'empty scope result');
  assert.equal(reports[0]?.status, 'skipped');
  assert.equal(reports[0]?.reason, 'no matching subjects');
});

test('CLI validates sparse pattern lists even on disabled rules before executing hooks', async () => {
  const target = cliSandbox.isolated('pattern-array');
  writeFile(`${target.cwd}/visible.txt`, 'visible');
  for (const field of ['files', 'exclude']) {
    for (const enabled of [true, false]) {
      writeFile(`${target.cwd}/.rulekeeper/patterns.rule.ts`, `import { Rule, pass } from 'rulekeeper';
export default class Patterns extends Rule {
  enabled = ${enabled};
  ${field} = new Array<string>(1);
  when() { throw new Error('HOOK_RAN'); }
  check = pass;
}
`);
      const result = await runCli(['validate'], target);
      expectFailure(result, `sparse ${field}, enabled=${enabled}`);
      assert.match(result.stderr, new RegExp(`${field} must be`));
      assert.doesNotMatch(result.stderr, /HOOK_RAN/);
    }
  }
});

test('per-scope filters run once before grouping and can drop scopes with a reason', async () => {
  const scope: ScopeSelector = file => [
    { id: 'keep', source: file.source },
    { id: 'drop', source: file.source },
  ];
  const rule = new TestRule({
    files: ['**/*.txt'],
    scope,
    group: 'file',
    filter: subject => (subject.id === 'drop' ? { applies: false, reason: 'irrelevant scope' } : true),
  });
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });

  const { report, harness } = await runRule(rule, project, {}, 'filtered');

  assert.equal(rule.filterCalls, 2);
  assert.equal(report.evaluations.length, 1);
  const group = asGroup(report.evaluations[0]?.subject ?? ({} as Subject));
  assert.deepEqual(group.members.map(member => member.id), ['keep']);

  const scopes = eventsOfType(harness.events, 'scope');
  assert.deepEqual(
    scopes.map(event => [event.subject.id, event.accepted]),
    [
      ['keep', true],
      ['drop', false],
    ],
  );
  assert.equal(scopes.find(event => event.subject.id === 'drop')?.reason, 'irrelevant scope');
});

test('a malformed filter result is an error', async () => {
  const scope: ScopeSelector = file => [{ id: '$', source: file.source }];
  const rule = new TestRule({
    files: ['**/*.txt'],
    scope,
    filter: () => ({ applies: 'yes' }) as unknown as PredicateResult,
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  await assert.rejects(() => executeRules([loaded('bad-filter', rule)], harness.context));
});

test('a throwing filter rejects the run', async () => {
  const scope: ScopeSelector = file => [{ id: '$', source: file.source }];
  const rule = new TestRule({
    files: ['**/*.txt'],
    scope,
    filter: () => {
      throw new Error('filter exploded');
    },
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  await assert.rejects(() => executeRules([loaded('throw-filter', rule)], harness.context), /filter exploded/);
});

test('every hook runs with this bound to its rule instance', async () => {
  const scope: ScopeSelector = file => [{ id: '$', source: file.source }];
  const rule = new TestRule({ files: ['**/*.txt'], scope });
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });

  await runRule(rule, project);

  assert.equal(rule.whenCalls, 1);
  assert.equal(rule.selectCalls, 1);
  assert.equal(rule.filterCalls, 1);
  assert.equal(rule.checkCalls, 1);
  assert.equal(rule.boundThis.length, 4);
  assert.ok(rule.boundThis.every(Boolean), 'every hook must observe this === the rule instance');
});

test('a custom select replaces default globs but must cite real eligible files', async () => {
  const project = new MemoryProject('/repo', { 'data.json': '{"ok":true}', 'other.txt': 'hi' });
  const rule = new TestRule({
    files: ['**/*.txt'],
    select: async () => [scopeSubject('data.json', '$', '{"ok":true}') as unknown as ScopeSubject<JsonValue>],
    check: () => violation('custom decision'),
  });

  const { report } = await runRule(rule, project, {}, 'custom');

  assert.deepEqual(report.evaluations.map(evaluation => asScope(evaluation.subject).filepath), ['data.json']);
  assert.equal(report.status, 'violation');
  assert.equal(rule.selectCalls, 1);

  const restricted = new Harness(project, { isTarget: filepath => filepath !== 'data.json' });
  await assert.rejects(() => executeRules([loaded('custom', rule)], restricted.context));

  const reserved = new TestRule({
    select: async () => [scopeSubject('node_modules/x.js', '$', 'x') as unknown as ScopeSubject<JsonValue>],
  });
  await assert.rejects(() => executeRules([loaded('reserved', reserved)], new Harness(project).context));
});

test('a custom selection with invalid, duplicate, or ineligible scopes is an error', async () => {
  const cyclic: Record<string, unknown> = { self: null };
  cyclic['self'] = cyclic;

  const project = new MemoryProject('/repo', { 'a.txt': 'A' });
  const cases: readonly (readonly [label: string, selection: unknown])[] = [
    ['unknown file', [scopeSubject('nope.txt', '$', 'A')]],
    ['absolute path', [scopeSubject('/etc/passwd', '$', 'x')]],
    ['empty scope id', [scopeSubject('a.txt', '', 'A')]],
    ['non-string source', [scopeSubject('a.txt', '$', 42)]],
    ['duplicate identities', [scopeSubject('a.txt', 'dup', 'A'), scopeSubject('a.txt', 'dup', 'A')]],
    ['nonfinite data', [scopeSubject('a.txt', '$', 'A', { data: Number.NaN })]],
    ['cyclic data', [scopeSubject('a.txt', '$', 'A', { data: cyclic })]],
    ['undefined nested in data', [scopeSubject('a.txt', '$', 'A', { data: { nested: undefined } })]],
    ['zero-based line start', [scopeSubject('a.txt', '$', 'A', { lines: { start: 0, end: 1 } })]],
    ['inverted line range', [scopeSubject('a.txt', '$', 'A', { lines: { start: 3, end: 1 } })]],
    ['non-string capture', [scopeSubject('a.txt', '$', 'A', { captures: { bad: 5 } })]],
  ];

  for (const [label, selection] of cases) {
    const rule = new TestRule({
      select: async () => selection as unknown as readonly ScopeSubject<JsonValue>[],
    });
    const harness = new Harness(project);
    await assert.rejects(
      () => executeRules([loaded('invalid', rule)], harness.context),
      `expected an invalid custom selection to be rejected: ${label}`,
    );
  }
});

test('a custom selection that is not an array is an error', async () => {
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });
  const rule = new TestRule({
    select: async () =>
      scopeSubject('a.txt', '$', 'A') as unknown as readonly ScopeSubject<JsonValue>[],
  });

  await assert.rejects(
    () => executeRules([loaded('not-array', rule)], new Harness(project).context),
    'expected a non-array custom selection to be rejected',
  );
});

test('a scope match cannot reroute file identity or drop accessor fields', async () => {
  const spoofed = { kind: 'group', filepath: 'elsewhere.txt', id: 'spoof', source: 'spoofed body' };
  const accessors = Object.defineProperties(
    {},
    {
      id: { get: () => 'accessor' },
      source: { get: () => 'accessor body' },
      data: { get: () => ({ ok: true }) },
    },
  );
  const scope: ScopeSelector = () => [spoofed, accessors] as unknown as readonly ScopeMatch<JsonValue>[];
  const rule = new TestRule({ files: ['a.txt'], scope, check: () => violation('inspected') });

  const { report } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'identity');

  const subjects = report.evaluations.map(evaluation => asScope(evaluation.subject));
  assert.deepEqual(subjects.map(subject => subject.kind), ['scope', 'scope']);
  assert.deepEqual(subjects.map(subject => subject.filepath), ['a.txt', 'a.txt']);
  assert.deepEqual(subjects.map(subject => subject.id), ['spoof', 'accessor']);
  assert.deepEqual(subjects.map(subject => subject.source), ['spoofed body', 'accessor body']);
  assert.deepEqual(subjects.map(subject => subject.data), [undefined, { ok: true }]);
  assert.equal(report.status, 'violation');
});

test('a regular file sharing a reserved directory name passes default and custom selection', async () => {
  const project = new MemoryProject('/repo', { 'a.txt': 'A', 'notes/old': 'archived notes' }, ['notes']);

  const byGlob = new TestRule({ files: ['**/*'] });
  const globbed = await runRule(byGlob, project, {}, 'namesake-glob');

  assert.deepEqual(
    globbed.report.evaluations.map(evaluation => asScope(evaluation.subject).filepath),
    ['a.txt', 'notes/old'],
  );
  assert.deepEqual(project.reads, ['a.txt', 'notes/old']);

  const custom = new TestRule({
    select: async () => [scopeSubject('notes/old', '$', 'archived notes') as unknown as ScopeSubject<JsonValue>],
    check: () => violation('notes/old is eligible'),
  });
  const selected = await runRule(custom, project, {}, 'namesake-custom');

  assert.equal(selected.report.status, 'violation');
  assert.deepEqual(
    selected.report.evaluations.map(evaluation => asScope(evaluation.subject).filepath),
    ['notes/old'],
  );
});

test('a directory at a reserved-name path is not a regular file', async () => {
  const project = new MemoryProject('/repo', { 'a.txt': 'A' }, ['notes', 'notes/old']);
  assert.deepEqual(await project.stat('notes/old'), { kind: 'directory' });

  const rule = new TestRule({
    select: async () => [scopeSubject('notes/old', '$', 'archived notes') as unknown as ScopeSubject<JsonValue>],
  });
  await assert.rejects(
    () => executeRules([loaded('reserved-dir', rule)], new Harness(project).context),
    /not a regular file|ineligible/,
    'expected a directory at a reserved-name path to be rejected',
  );
});

test('scope grouping evaluates each scope individually', async () => {
  const scope: ScopeSelector = file => [
    { id: 'one', source: file.source },
    { id: 'two', source: file.source },
  ];
  const rule = new TestRule({ files: ['a.txt'], scope, group: 'scope' });

  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'scope');

  assert.deepEqual(report.evaluations.map(evaluation => asScope(evaluation.subject).id), ['one', 'two']);
  assert.equal(eventsOfType(harness.events, 'group').length, 0);
});

test('file grouping keys one group per filepath and preserves member order', async () => {
  const scope: ScopeSelector = file => [
    { id: 'a', source: file.source },
    { id: 'b', source: file.source },
  ];
  const rule = new TestRule({ files: ['**/*.txt'], scope, group: 'file' });
  const project = new MemoryProject('/repo', { 'b.txt': 'B', 'a.txt': 'A' });

  const { report, harness } = await runRule(rule, project, {}, 'by-file');

  const groups = report.evaluations.map(evaluation => asGroup(evaluation.subject));
  assert.deepEqual(
    groups.map(group => [group.group.type, group.group.path, group.members.map(member => member.id)]),
    [
      ['file', 'a.txt', ['a', 'b']],
      ['file', 'b.txt', ['a', 'b']],
    ],
  );
  assert.deepEqual(
    eventsOfType(harness.events, 'group').map(event => event.subject.group.path),
    ['a.txt', 'b.txt'],
  );
});

test('folder grouping climbs negative levels and clamps at the root', async () => {
  const files = { 'a/b/one.txt': '1', 'a/b/two.txt': '2', 'a/three.txt': '3', 'root.txt': '4' };

  const level = async (value: number): Promise<readonly [string, number][]> => {
    const rule = new TestRule({ files: ['**/*.txt'], group: { by: 'folder', level: value } });
    const { report } = await runRule(rule, new MemoryProject('/repo', files), {}, 'folders');
    return report.evaluations.map(evaluation => {
      const group = asGroup(evaluation.subject);
      return [group.group.path, group.members.length] as [string, number];
    });
  };

  assert.deepEqual(await level(-1), [
    ['a', 2],
    ['.', 2],
  ]);
  assert.deepEqual(await level(0), [
    ['a/b', 2],
    ['a', 1],
    ['.', 1],
  ]);
  assert.deepEqual(await level(-9), [['.', 4]]);
});

test('project grouping emits one root group with every member', async () => {
  const rule = new TestRule({ files: ['**/*.txt'], group: 'project' });
  const project = new MemoryProject('/repo', { 'a/x.txt': 'X', 'b/y.txt': 'Y' });

  const { report, harness } = await runRule(rule, project, {}, 'project');

  assert.equal(report.evaluations.length, 1);
  const group = asGroup(report.evaluations[0]?.subject ?? ({} as Subject));
  assert.deepEqual(group.group, { type: 'project', path: '.' });
  assert.deepEqual(group.members.map(member => member.filepath), ['a/x.txt', 'b/y.txt']);
  assert.equal(eventsOfType(harness.events, 'group').length, 1);
});

test('an empty selection produces no groups and no evaluations', async () => {
  const rule = new TestRule({ files: ['**/*.md'], group: 'project' });
  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'empty-group');
  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'no matching subjects');
  assert.deepEqual(report.evaluations, []);
  assert.equal(eventsOfType(harness.events, 'group').length, 0);
});

test('ai projects the current subject and resolves one runtime per rule', async () => {
  const rule = new TestRule({ files: ['**/*.txt'], check: ai({ rule: 'Must be compliant' }) });
  const project = new MemoryProject('/repo', { 'a.txt': 'alpha', 'b.txt': 'beta' });

  const { report, harness } = await runRule(rule, project, { threshold: 0.4 }, 'ai-rule');

  assert.equal(harness.resolveCalls, 1);
  assert.equal(harness.backend.requests.length, 2);
  assert.deepEqual(harness.backend.requests[0]?.state, {
    filepath: 'a.txt',
    scope: { id: '$', source: 'alpha' },
  });
  assert.deepEqual(harness.backend.requests[1]?.state, {
    filepath: 'b.txt',
    scope: { id: '$', source: 'beta' },
  });
  assert.deepEqual(harness.backend.requests[0]?.instructions, {
    rule: 'Must be compliant',
    question: 'Is the rule respected?',
  });
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result.status), ['pass', 'pass']);

  const requests = eventsOfType(harness.events, 'request');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.name, 'ai-rule');
  assert.equal(asScope(requests[0]?.subject ?? ({} as Subject)).filepath, 'a.txt');
  assert.deepEqual(eventsOfType(harness.events, 'response').map(event => event.status), [200, 200]);
});

test('multiple context.ai calls are accumulated even when a custom check transforms the result', async () => {
  const rule = new TestRule({
    files: ['a.txt'],
    check: async (_subject, context) => {
      await context.ai({ rule: 'First policy' });
      await context.ai({ rule: 'Second policy' });
      await context.ai({ rule: 'Third policy' });
      return { status: 'violation', message: 'Combined policy failed', usage: UNREPORTED_AI_USAGE };
    },
  });
  rule.settings = { inputCostPerMillion: 2, outputCostPerMillion: 5 };
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  harness.backend.usages = [{ inputTokens: 20, outputTokens: 4 }, undefined, { inputTokens: 30, outputTokens: 6 }];
  const [report] = await executeRules([loaded('combined', rule)], harness.context);
  const usage = {
    calls: 3, unreportedCalls: 1, inputTokens: 50, outputTokens: 10,
    inputCost: 20 * 2 / 1_000_000 + 30 * 2 / 1_000_000,
    outputCost: 4 * 5 / 1_000_000 + 6 * 5 / 1_000_000,
  };
  const expected = { status: 'violation', message: 'Combined policy failed', usage };
  assert.deepEqual(report?.evaluations[0]?.result, expected);
  assert.deepEqual(eventsOfType(harness.events, 'result').map(event => event.result), [expected]);
  const calls = eventsOfType(harness.events, 'usage');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(event => event.usage), [
    { calls: 1, unreportedCalls: 0, inputTokens: 20, outputTokens: 4, inputCost: 20 * 2 / 1_000_000, outputCost: 4 * 5 / 1_000_000 },
    UNREPORTED_AI_USAGE,
    { calls: 1, unreportedCalls: 0, inputTokens: 30, outputTokens: 6, inputCost: 30 * 2 / 1_000_000, outputCost: 6 * 5 / 1_000_000 },
  ]);
  assert.equal(new Set(calls.map(event => event.evaluationId)).size, 1);
  assertEvaluationLifecycle(harness.events);
});

test('usage events retain partial accounting when a later AI invocation fails', async () => {
  const rule = new TestRule({
    files: ['a.txt'],
    check: async (_subject, context) => {
      await context.ai({ rule: 'First policy' });
      return context.ai({ rule: 'Second policy' });
    },
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  harness.backend.usages = [{ inputTokens: 11, outputTokens: 1 }];
  harness.backend.failures = [undefined, new Error('backend failed')];
  await assert.rejects(executeRules([loaded('partial', rule)], harness.context));
  const calls = eventsOfType(harness.events, 'usage');
  assert.deepEqual(calls.map(event => event.usage), [
    { calls: 1, unreportedCalls: 0, inputTokens: 11, outputTokens: 1, inputCost: 11 * 0.042 / 1_000_000, outputCost: 0 },
    UNREPORTED_AI_USAGE,
  ]);
  assert.equal(harness.backend.requests.length, 2);
  assert.equal(eventsOfType(harness.events, 'result').length, 0);
  assertEvaluationLifecycle(harness.events);
});

test('a concurrent AI failure drains pending calls before closing the evaluation', { timeout: 5000 }, async () => {
  const first = Promise.withResolvers<DecisionOutcome>();
  const second = Promise.withResolvers<DecisionOutcome>();
  const bothStarted = Promise.withResolvers<void>();
  const failure = new Error('first concurrent call failed');
  const rule = new TestRule({
    files: ['a.txt'],
    check: async (_subject, context) => {
      await Promise.all([
        context.ai({ rule: 'First policy' }),
        context.ai({ rule: 'Second policy' }),
      ]);
      return pass();
    },
  });
  rule.settings = { inputCostPerMillion: 2, outputCostPerMillion: 5 };
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  harness.backend.decide = async (request, observer) => {
    harness.backend.requests.push(request);
    observer?.({ type: 'request', body: JSON.stringify(request) });
    const pending = harness.backend.requests.length === 1 ? first : second;
    if (harness.backend.requests.length === 2) bothStarted.resolve();
    const outcome = await pending.promise;
    observer?.({ type: 'response', status: 200, body: JSON.stringify(outcome) });
    return outcome;
  };
  let settled = false;
  const completed = executeRules([loaded('concurrent-failure', rule)], harness.context).then(
    () => { settled = true; return undefined; },
    error => { settled = true; return error; },
  );
  await bothStarted.promise;
  first.reject(failure);
  await new Promise<void>(resolve => { setImmediate(resolve); });
  try {
    assert.equal(settled, false, 'the evaluation must wait for its pending AI call');
    assert.deepEqual(eventsOfType(harness.events, 'error'), []);
    assert.deepEqual(eventsOfType(harness.events, 'result'), []);
    assert.deepEqual(eventsOfType(harness.events, 'usage').map(event => event.usage), [UNREPORTED_AI_USAGE]);
  } finally {
    second.resolve({
      probability: 0.9,
      model: 'recording-model',
      usage: { inputTokens: 20, outputTokens: 4 },
    });
  }
  assert.equal(await completed, failure, 'draining must preserve the original failure');
  assert.deepEqual(eventsOfType(harness.events, 'usage').map(event => event.usage), [
    UNREPORTED_AI_USAGE,
    {
      calls: 1, unreportedCalls: 0, inputTokens: 20, outputTokens: 4,
      inputCost: 20 * 2 / 1_000_000, outputCost: 4 * 5 / 1_000_000,
    },
  ]);
  assert.equal(harness.backend.requests.length, 2);
  assert.equal(eventsOfType(harness.events, 'result').length, 0);
  assert.deepEqual(eventsOfType(harness.events, 'error').map(event => [
    event.evaluationId, event.stage, event.message,
  ]), [[1, 'check', failure.message]]);
  assertEvaluationLifecycle(harness.events);
});

test('an AI failure stops new subjects before its pending calls finish draining', { timeout: 5000 }, async () => {
  for (const siblingFails of [false, true]) {
    const failed = Promise.withResolvers<DecisionOutcome>();
    const slow = Promise.withResolvers<DecisionOutcome>();
    const sibling = Promise.withResolvers<DecisionOutcome>();
    const allStarted = Promise.withResolvers<void>();
    const checkFailed = Promise.withResolvers<void>();
    const siblingFinished = Promise.withResolvers<void>();
    const failure = new Error('first subject failed');
    const started: string[] = [];
    const rule = new TestRule({
      files: ['a.txt'],
      scope: file => Array.from({ length: 6 }, (_unused, index) => ({ id: String(index), source: file.source })),
      check: async (subject, context) => {
        const id = asScope(subject).id;
        started.push(id);
        if (id !== '0') return context.ai({ rule: 'Sibling policy' });
        try {
          await Promise.all([
            context.ai({ rule: 'Failed policy' }),
            context.ai({ rule: 'Slow policy' }),
          ]);
        } catch (error) {
          checkFailed.resolve();
          throw error;
        }
        return pass();
      },
    });
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }), { concurrency: 2 });
    harness.backend.decide = async (request, observer) => {
      harness.backend.requests.push(request);
      observer?.({ type: 'request', body: JSON.stringify(request) });
      if (harness.backend.requests.length === 3) allStarted.resolve();
      const outcome = await (request.instructions.rule === 'Failed policy'
        ? failed.promise
        : request.instructions.rule === 'Slow policy' ? slow.promise : sibling.promise);
      observer?.({ type: 'response', status: 200, body: JSON.stringify(outcome) });
      return outcome;
    };
    const context: RunContext = {
      ...harness.context,
      emit: event => {
        harness.events.push(event);
        if ((event.type === 'result' || event.type === 'error') && event.evaluationId === 2) {
          siblingFinished.resolve();
        }
      },
    };
    let settled = false;
    const completed = executeRules([loaded('stop-before-drain', rule)], context).then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; },
    );
    await allStarted.promise;
    failed.reject(failure);
    await checkFailed.promise;
    if (siblingFails) sibling.reject(new Error('later sibling failure'));
    else sibling.resolve({ probability: 0.9, model: 'recording-model' });
    await siblingFinished.promise;
    assert.equal(settled, false);
    assert.equal(eventsOfType(harness.events, 'error').some(event => event.evaluationId === 1), false);
    slow.resolve({
      probability: 0.9, model: 'recording-model', usage: { inputTokens: 20, outputTokens: 4 },
    });
    assert.equal(await completed, failure, 'the first failure must survive a later worker rejection');
    assert.deepEqual(started, ['0', '1']);
    assert.equal(harness.backend.requests.length, 3);
    assert.deepEqual(eventsOfType(harness.events, 'usage').map(event => [
      event.evaluationId, event.usage.inputTokens, event.usage.unreportedCalls,
    ]), [[1, 0, 1], [2, 0, 1], [1, 20, 0]]);
    assertEvaluationLifecycle(harness.events);
  }
});

test('invalid check results stop scheduling before pending AI calls drain', { timeout: 5000 }, async () => {
  for (const getterThrows of [false, true]) {
    for (const siblingFails of [false, true]) {
      const slow = Promise.withResolvers<DecisionOutcome>();
      const sibling = Promise.withResolvers<CheckResult>();
      const validationStarted = Promise.withResolvers<void>();
      const siblingFinished = Promise.withResolvers<void>();
      const validationFailure = new Error('check result getter failed');
      const siblingFailure = new Error('later sibling failure');
      const started: string[] = [];
      const rule = new TestRule({
        files: ['a.txt'],
        scope: file => Array.from({ length: 6 }, (_unused, index) => ({ id: String(index), source: file.source })),
        check: (subject, context) => {
          const id = asScope(subject).id;
          started.push(id);
          if (id !== '0') return sibling.promise;
          void context.ai({ rule: 'Slow policy' });
          return {
            status: 'pass',
            get probability() {
              validationStarted.resolve();
              if (getterThrows) throw validationFailure;
              return 2;
            },
          };
        },
      });
      const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }), { concurrency: 2 });
      harness.backend.decide = async (request, observer) => {
        harness.backend.requests.push(request);
        observer?.({ type: 'request', body: JSON.stringify(request) });
        return slow.promise;
      };
      const context: RunContext = {
        ...harness.context,
        emit: event => {
          harness.events.push(event);
          if ((event.type === 'result' || event.type === 'error') && event.evaluationId === 2) {
            siblingFinished.resolve();
          }
        },
      };
      let settled = false;
      const completed = executeRules([loaded('invalid-before-drain', rule)], context).then(
        () => { settled = true; return undefined; },
        error => { settled = true; return error; },
      );
      await validationStarted.promise;
      if (siblingFails) sibling.reject(siblingFailure);
      else sibling.resolve(pass());
      await siblingFinished.promise;
      assert.equal(settled, false, 'validation failure must still drain its pending AI call');
      assert.equal(eventsOfType(harness.events, 'error').some(event => event.evaluationId === 1), false);
      slow.resolve({ probability: 0.9, model: 'recording-model', usage: { inputTokens: 20, outputTokens: 4 } });
      const failure: unknown = await completed;
      assert.ok(failure instanceof Error);
      if (getterThrows) assert.equal(failure, validationFailure);
      else assert.match(failure.message, /check probability must be a finite number between 0 and 1/);
      assert.notEqual(failure, siblingFailure);
      assert.deepEqual(started, ['0', '1']);
      assert.equal(harness.backend.requests.length, 1);
      assert.deepEqual(eventsOfType(harness.events, 'usage').map(event => event.evaluationId), [1]);
      assert.deepEqual(eventsOfType(harness.events, 'error').filter(event => event.evaluationId === 1).map(event => [
        event.stage, event.message,
      ]), [['check', failure.message]]);
      assert.equal(eventsOfType(harness.events, 'result').some(event => event.evaluationId === 1), false);
      assertEvaluationLifecycle(harness.events);
    }
  }
});

test('check results are snapshotted before pending AI handlers mutate their fields', { timeout: 5000 }, async () => {
  const first = Promise.withResolvers<DecisionOutcome>();
  const second = Promise.withResolvers<DecisionOutcome>();
  const bothStarted = Promise.withResolvers<void>();
  const mutated = Promise.withResolvers<void>();
  const suppliedUsage = {
    calls: 7, unreportedCalls: 1, inputTokens: 11, outputTokens: 1, inputCost: 0.25, outputCost: 0,
  };
  const shared = {
    status: 'pass' as 'pass' | 'violation',
    message: 'initial message',
    probability: 0.9,
    threshold: 0.4,
    model: 'initial-model',
    usage: suppliedUsage,
    extra: 'must not escape',
  };
  const rule = new TestRule({
    files: ['a.txt'],
    check: (_subject, context) => {
      void context.ai({ rule: 'First policy' }).then(() => {
        shared.status = 'violation';
        shared.message = 'changed message';
        shared.probability = 2;
        shared.threshold = 2;
        shared.model = 'changed-model';
        suppliedUsage.calls = -1;
        suppliedUsage.inputTokens = Number.NaN;
        shared.usage = { ...suppliedUsage, outputTokens: Number.POSITIVE_INFINITY };
        mutated.resolve();
      });
      void context.ai({ rule: 'Second policy' });
      return shared;
    },
  });
  rule.settings = { inputCostPerMillion: 2, outputCostPerMillion: 5 };
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  harness.backend.decide = async (request, observer) => {
    harness.backend.requests.push(request);
    observer?.({ type: 'request', body: JSON.stringify(request) });
    if (harness.backend.requests.length === 2) bothStarted.resolve();
    return request.instructions.rule === 'First policy' ? first.promise : second.promise;
  };
  const completed = executeRules([loaded('snapshot-before-drain', rule)], harness.context);
  await bothStarted.promise;
  await new Promise<void>(resolve => { setImmediate(resolve); });
  assert.deepEqual(eventsOfType(harness.events, 'result'), []);
  first.resolve({
    probability: 0.9, model: 'recording-model', usage: { inputTokens: 20, outputTokens: 4 },
  });
  await mutated.promise;
  assert.equal(shared.probability, 2, 'the custom handler must mutate the original result during drain');
  assert.deepEqual(eventsOfType(harness.events, 'result'), []);
  second.resolve({
    probability: 0.9, model: 'recording-model', usage: { inputTokens: 30, outputTokens: 6 },
  });
  const [report] = await completed;
  const expected = {
    status: 'pass',
    message: 'initial message',
    probability: 0.9,
    threshold: 0.4,
    model: 'initial-model',
    usage: {
      calls: 2, unreportedCalls: 0, inputTokens: 50, outputTokens: 10,
      inputCost: 20 * 2 / 1_000_000 + 30 * 2 / 1_000_000,
      outputCost: 4 * 5 / 1_000_000 + 6 * 5 / 1_000_000,
    },
  };
  assert.deepEqual(report?.evaluations[0]?.result, expected);
  assert.deepEqual(eventsOfType(harness.events, 'result').map(event => event.result), [expected]);
  assert.equal(eventsOfType(harness.events, 'usage').length, 2);
  assertEvaluationLifecycle(harness.events);
});

test('a caught backend failure still contributes usage to the returned custom result', async () => {
  const rule = new TestRule({
    files: ['a.txt'],
    check: async (_subject, context) => {
      try {
        await context.ai({ rule: 'Policy' });
      } catch {
        return pass();
      }
      return violation('The backend unexpectedly succeeded');
    },
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  harness.backend.failures = [new Error('backend failed')];
  const [report] = await executeRules([loaded('caught', rule)], harness.context);
  assert.deepEqual(report?.evaluations[0]?.result, { status: 'pass', usage: UNREPORTED_AI_USAGE });
  assert.deepEqual(eventsOfType(harness.events, 'usage').map(event => event.usage), [UNREPORTED_AI_USAGE]);
  assertEvaluationLifecycle(harness.events);
});

test('invalid AI input before a backend invocation produces no usage', async () => {
  const rule = new TestRule({ files: ['a.txt'], check: ai({ rule: 'Policy', input: () => NaN }) });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  await assert.rejects(executeRules([loaded('invalid-input', rule)], harness.context));
  assert.equal(harness.backend.requests.length, 0);
  assert.deepEqual(eventsOfType(harness.events, 'usage'), []);
  assertEvaluationLifecycle(harness.events);
});

test('legitimate external usage is preserved and normalized without inventing backend calls', async () => {
  const usage = { calls: 2, unreportedCalls: 1, inputTokens: 11, outputTokens: 1, inputCost: 0.25, outputCost: 0 };
  const inheritedUsage = Object.assign(Object.create(usage), { extra: 'dropped' }) as typeof usage;
  const rule = new TestRule({ files: ['a.txt'], check: () => ({ status: 'pass', usage: inheritedUsage }) });
  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }));
  const result = report.evaluations[0]?.result;
  assert.deepEqual(result, { status: 'pass', usage });
  assert.equal(Object.getPrototypeOf(result?.usage), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 'pass', usage });
  assert.deepEqual(eventsOfType(harness.events, 'result')[0]?.result, result);
  assert.equal(harness.resolveCalls, 0);
  assert.deepEqual(eventsOfType(harness.events, 'usage'), []);
});

test('malformed external usage rejects the custom check without producing a result or usage event', async () => {
  const rule = new TestRule({
    files: ['a.txt'],
    check: () => ({ status: 'pass', usage: { ...UNREPORTED_AI_USAGE, inputTokens: Number.MAX_SAFE_INTEGER + 1 } }),
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  await assert.rejects(executeRules([loaded('invalid-usage', rule)], harness.context));
  assert.deepEqual(eventsOfType(harness.events, 'result'), []);
  assert.deepEqual(eventsOfType(harness.events, 'usage'), []);
  assert.equal(harness.resolveCalls, 0);
});

test('accumulating individually valid AI calls rejects unsafe token totals and nonfinite total costs', async () => {
  for (const tokenField of ['inputTokens', 'outputTokens', 'cost'] as const) {
    const rule = new TestRule({
      files: ['a.txt'],
      check: async (_subject, context) => {
        await context.ai({ rule: 'First policy' });
        return context.ai({ rule: 'Second policy' });
      },
    });
    rule.settings = {
      inputCostPerMillion: tokenField === 'cost' ? Number.MAX_VALUE : 0,
      outputCostPerMillion: 0,
    };
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
    harness.backend.usages = tokenField === 'cost'
      ? [{ inputTokens: 1_000_000, outputTokens: 0 }, { inputTokens: 1_000_000, outputTokens: 0 }]
      : [
          { inputTokens: 0, outputTokens: 0, [tokenField]: Number.MAX_SAFE_INTEGER },
          { inputTokens: 0, outputTokens: 0, [tokenField]: 1 },
        ];
    await assert.rejects(executeRules([loaded('overflow', rule)], harness.context), tokenField);
    assert.equal(harness.backend.requests.length, 2);
    assert.deepEqual(eventsOfType(harness.events, 'result'), []);
  }
});

test('custom checks cannot swallow aggregate accounting failures and still drain pending calls', { timeout: 5000 }, async () => {
  for (const field of ['inputTokens', 'outputTokens', 'inputCost', 'outputCost'] as const) {
    const pending = Promise.withResolvers<DecisionOutcome>();
    const caught = Promise.withResolvers<unknown>();
    const tokens = field === 'inputTokens' || field === 'outputTokens';
    const usageField = field === 'inputTokens' || field === 'inputCost' ? 'inputTokens' : 'outputTokens';
    const firstUsage = { inputTokens: 0, outputTokens: 0, [usageField]: tokens ? Number.MAX_SAFE_INTEGER : 1_000_000 };
    const secondUsage = { inputTokens: 0, outputTokens: 0, [usageField]: tokens ? 1 : 1_000_000 };
    const rule = new TestRule({
      files: ['a.txt'],
      check: async (_subject, context) => {
        await context.ai({ rule: 'First policy' });
        void context.ai({ rule: 'Pending policy' });
        try {
          await context.ai({ rule: 'Overflow policy' });
        } catch (error) {
          caught.resolve(error);
        }
        return pass();
      },
    });
    rule.settings = {
      inputCostPerMillion: field === 'inputCost' ? Number.MAX_VALUE : 0,
      outputCostPerMillion: field === 'outputCost' ? Number.MAX_VALUE : 0,
    };
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
    harness.backend.decide = async (request, observer) => {
      harness.backend.requests.push(request);
      observer?.({ type: 'request', body: JSON.stringify(request) });
      const outcome = request.instructions.rule === 'Pending policy'
        ? await pending.promise
        : {
            probability: 0.9, model: 'recording-model',
            usage: request.instructions.rule === 'First policy' ? firstUsage : secondUsage,
          };
      observer?.({ type: 'response', status: 200, body: JSON.stringify(outcome) });
      return outcome;
    };
    let settled = false;
    const completed = executeRules([loaded('caught-overflow', rule)], harness.context).then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; },
    );
    const accountingError = await caught.promise;
    assert.ok(accountingError instanceof Error);
    assert.equal(settled, false);
    assert.deepEqual(eventsOfType(harness.events, 'error'), []);
    assert.deepEqual(eventsOfType(harness.events, 'result'), []);
    assert.equal(eventsOfType(harness.events, 'usage').length, 2);
    pending.resolve({
      probability: 0.9, model: 'recording-model', usage: { inputTokens: 0, outputTokens: 0 },
    });
    assert.equal(await completed, accountingError);
    assert.equal(harness.backend.requests.length, 3);
    assert.deepEqual(eventsOfType(harness.events, 'result'), []);
    assert.equal(eventsOfType(harness.events, 'usage').length, 3);
    assert.deepEqual(eventsOfType(harness.events, 'error').map(event => [
      event.evaluationId, event.stage, event.message,
    ]), [[1, 'check', accountingError.message]]);
    assertEvaluationLifecycle(harness.events);
  }
});

test('caught inspection accounting failures stop scheduling and drain without a successful result', { timeout: 5000 }, async () => {
  for (const field of ['inputTokens', 'outputTokens', 'inputCost', 'outputCost'] as const) {
    const pending = Promise.withResolvers<DecisionOutcome>();
    const firstUsageReported = Promise.withResolvers<void>();
    const caught = Promise.withResolvers<unknown>();
    const firstFinished = Promise.withResolvers<void>();
    const tokens = field === 'inputTokens' || field === 'outputTokens';
    const usageField = field === 'inputTokens' || field === 'inputCost' ? 'inputTokens' : 'outputTokens';
    const firstUsage = { inputTokens: 0, outputTokens: 0, [usageField]: tokens ? Number.MAX_SAFE_INTEGER : 1_000_000 };
    const secondUsage = { inputTokens: 0, outputTokens: 0, [usageField]: tokens ? 1 : 1_000_000 };
    const started: string[] = [];
    const rule = new TestRule({
      files: ['a.txt'],
      scope: file => Array.from({ length: 6 }, (_unused, index) => ({ id: String(index), source: file.source })),
      check: async (subject, context) => {
        const id = asScope(subject).id;
        started.push(id);
        if (id === '0') {
          await context.ai({ rule: 'First policy' });
          firstUsageReported.resolve();
          await caught.promise;
        } else {
          await firstUsageReported.promise;
          void context.ai({ rule: 'Pending policy' });
          try {
            await context.ai({ rule: 'Overflow policy' });
          } catch (error) {
            caught.resolve(error);
          }
        }
        return pass();
      },
    });
    rule.settings = {
      inputCostPerMillion: field === 'inputCost' ? Number.MAX_VALUE : 0,
      outputCostPerMillion: field === 'outputCost' ? Number.MAX_VALUE : 0,
    };
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }), { concurrency: 2 });
    harness.backend.decide = async (request, observer) => {
      harness.backend.requests.push(request);
      observer?.({ type: 'request', body: JSON.stringify(request) });
      return request.instructions.rule === 'Pending policy'
        ? pending.promise
        : {
            probability: 0.9, model: 'recording-model',
            usage: request.instructions.rule === 'First policy' ? firstUsage : secondUsage,
          };
    };
    const usage = createUsageTracker();
    const context: RunContext = {
      ...harness.context,
      emit: event => {
        harness.events.push(event);
        usage.emit(event);
        if (event.type === 'result' && event.evaluationId === 1) firstFinished.resolve();
      },
    };
    let settled = false;
    const completed = executeRules([loaded('caught-inspection-overflow', rule)], context).then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; },
    );
    const accountingError = await caught.promise;
    assert.ok(accountingError instanceof Error);
    await firstFinished.promise;
    assert.equal(settled, false);
    assert.deepEqual(eventsOfType(harness.events, 'error'), []);
    assert.deepEqual(eventsOfType(harness.events, 'usage').map(event => event.evaluationId), [1, 2]);
    pending.resolve({ probability: 0.9, model: 'recording-model', usage: { inputTokens: 0, outputTokens: 0 } });
    assert.equal(await completed, accountingError);
    assert.deepEqual(started, ['0', '1']);
    assert.equal(harness.backend.requests.length, 3);
    assert.deepEqual(eventsOfType(harness.events, 'result').map(event => event.evaluationId), [1]);
    assert.deepEqual(eventsOfType(harness.events, 'usage').map(event => event.evaluationId), [1, 2, 2]);
    assert.deepEqual(eventsOfType(harness.events, 'error').map(event => [
      event.evaluationId, event.stage, event.message,
    ]), [[2, 'check', accountingError.message]]);
    assertEvaluationLifecycle(harness.events);
  }
});

test('a usage consumer cannot replace the original local accounting failure', async () => {
  const consumerFailure = new Error('usage consumer failed too');
  let caught: unknown;
  const rule = new TestRule({
    files: ['a.txt'],
    check: async (_subject, context) => {
      await context.ai({ rule: 'First policy' });
      try {
        await context.ai({ rule: 'Overflow policy' });
      } catch (error) {
        caught = error;
      }
      return pass();
    },
  });
  rule.settings = { inputCostPerMillion: 0, outputCostPerMillion: 0 };
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  harness.backend.usages = [
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
    { inputTokens: 1, outputTokens: 0 },
  ];
  const context: RunContext = {
    ...harness.context,
    emit: event => {
      harness.events.push(event);
      if (event.type === 'usage' && event.usage.inputTokens === 1) throw consumerFailure;
    },
  };
  const failure: unknown = await executeRules([loaded('two-accounting-failures', rule)], context).then(
    () => undefined,
    error => error,
  );
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /inputTokens/);
  assert.equal(failure, caught);
  assert.notEqual(failure, consumerFailure);
  assert.equal(eventsOfType(harness.events, 'usage').length, 2);
  assert.deepEqual(eventsOfType(harness.events, 'result'), []);
  assert.deepEqual(eventsOfType(harness.events, 'error').map(event => event.message), [failure.message]);
  assertEvaluationLifecycle(harness.events);
});

test('aggregate AI usage accepts safe token and finite cost boundaries', async () => {
  for (const field of ['inputTokens', 'outputTokens', 'inputCost', 'outputCost'] as const) {
    const tokens = field === 'inputTokens' || field === 'outputTokens';
    const usageField = field === 'inputTokens' || field === 'inputCost' ? 'inputTokens' : 'outputTokens';
    const rule = new TestRule({
      files: ['a.txt'],
      check: async (_subject, context) => {
        await context.ai({ rule: 'First policy' });
        await context.ai({ rule: 'Second policy' });
        return pass();
      },
    });
    rule.settings = {
      inputCostPerMillion: field === 'inputCost' ? Number.MAX_VALUE / 2 : 0,
      outputCostPerMillion: field === 'outputCost' ? Number.MAX_VALUE / 2 : 0,
    };
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
    harness.backend.usages = [
      { inputTokens: 0, outputTokens: 0, [usageField]: tokens ? Number.MAX_SAFE_INTEGER - 1 : 1_000_000 },
      { inputTokens: 0, outputTokens: 0, [usageField]: tokens ? 1 : 1_000_000 },
    ];
    const [report] = await executeRules([loaded('usage-boundary', rule)], harness.context);
    assert.equal(report?.evaluations[0]?.result.usage?.[field], tokens ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE);
    assert.equal(report?.evaluations[0]?.result.usage?.calls, 2);
    assert.equal(eventsOfType(harness.events, 'usage').length, 2);
    assertEvaluationLifecycle(harness.events);
  }
});

test('a check rejection keeps its identity when draining later overflows usage', { timeout: 5000 }, async () => {
  const pending = Promise.withResolvers<DecisionOutcome>();
  const checkFailed = Promise.withResolvers<void>();
  const failure = new Error('original check failure');
  const rule = new TestRule({
    files: ['a.txt'],
    check: async (_subject, context) => {
      await context.ai({ rule: 'First policy' });
      void context.ai({ rule: 'Pending policy' });
      checkFailed.resolve();
      throw failure;
    },
  });
  rule.settings = { inputCostPerMillion: 0, outputCostPerMillion: 0 };
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  harness.backend.decide = async (request, observer) => {
    harness.backend.requests.push(request);
    observer?.({ type: 'request', body: JSON.stringify(request) });
    return request.instructions.rule === 'First policy'
      ? { probability: 0.9, model: 'recording-model', usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } }
      : pending.promise;
  };
  const completed = executeRules([loaded('check-before-overflow', rule)], harness.context).then(
    () => undefined,
    error => error,
  );
  await checkFailed.promise;
  pending.resolve({ probability: 0.9, model: 'recording-model', usage: { inputTokens: 1, outputTokens: 0 } });
  assert.equal(await completed, failure);
  assert.equal(eventsOfType(harness.events, 'usage').length, 2);
  assert.deepEqual(eventsOfType(harness.events, 'error').map(event => event.message), [failure.message]);
  assertEvaluationLifecycle(harness.events);
});

test('early scheduling failure reporting preserves normalization of non-Error check rejections', async () => {
  for (const reason of [undefined, null, 'check failed', 0]) {
    const rule = new TestRule({
      files: ['a.txt'],
      check: () => { throw reason; },
    });
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
    const failure: unknown = await executeRules([loaded('non-error-check', rule)], harness.context).then(
      () => undefined,
      error => error,
    );
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, String(reason));
    assert.deepEqual(eventsOfType(harness.events, 'error').map(event => event.message), [failure.message]);
    assertEvaluationLifecycle(harness.events);
  }
});

test('probability equal to the threshold violates; above it passes', async () => {
  const rule = new TestRule({ files: ['**/*.txt'], check: ai({ rule: 'Boundary policy' }) });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A', 'b.txt': 'B' }), { threshold: 0.4 });
  harness.backend.probabilities = [0.4, 0.4001];

  const reports = await executeRules([loaded('boundary', rule)], harness.context);

  const report = reports[0];
  assert.ok(report);
  const expected: readonly CheckResult[] = [
    { status: 'violation', probability: 0.4, threshold: 0.4, model: 'recording-model', usage: UNREPORTED_AI_USAGE },
    { status: 'pass', probability: 0.4001, threshold: 0.4, model: 'recording-model', usage: UNREPORTED_AI_USAGE },
  ];
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result), expected);
  assert.deepEqual(eventsOfType(harness.events, 'result').map(event => event.result), expected);
  assert.equal(harness.resolveCalls, 1);
  assert.equal(report.status, 'violation');
});

test('rule settings threshold overrides the harness default', async () => {
  const rule = new TestRule({ files: ['**/*.txt'], check: ai({ rule: 'Strict policy' }) });
  rule.settings = { threshold: 0.9 };
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }), { threshold: 0.1 });
  harness.backend.probabilities = [0.5];

  const reports = await executeRules([loaded('settings', rule)], harness.context);

  const report = reports[0];
  assert.ok(report);
  assert.equal(report.status, 'violation');
  assert.deepEqual(report.evaluations[0]?.result, {
    status: 'violation', probability: 0.5, threshold: 0.9, model: 'recording-model',
    usage: UNREPORTED_AI_USAGE,
  });
  assert.deepEqual(eventsOfType(harness.events, 'result')[0]?.result, report.evaluations[0]?.result);
  assert.equal(asScope(report.evaluations[0]?.subject ?? ({} as Subject)).filepath, 'a.txt');
  assert.equal(harness.backend.requests.length, 1);
});

test('ai state keeps falsy data values instead of falling back to source', async () => {
  const scope: ScopeSelector = file => [
    { id: '$', source: file.source, data: file.filepath === 'n.txt' ? null : 0 },
  ];
  const rule = new TestRule({ files: ['**/*.txt'], scope, check: ai({ rule: 'Data policy' }) });
  const project = new MemoryProject('/repo', { 'n.txt': 'null', 'z.txt': '0' });

  const { harness } = await runRule(rule, project, {}, 'falsy');

  assert.deepEqual(harness.backend.requests.map(request => request.state), [
    { filepath: 'n.txt', scope: { id: '$', data: null } },
    { filepath: 'z.txt', scope: { id: '$', data: 0 } },
  ]);
});

test('ai projects a group as ordered files with nested scopes', async () => {
  const scope: ScopeSelector = file => [{ id: 's', source: file.source }];
  const rule = new TestRule({ files: ['**/*.txt'], scope, group: 'folder', check: ai({ rule: 'Group policy' }) });
  const project = new MemoryProject('/repo', { 'a/one.txt': '1', 'a/two.txt': '2' });

  const { harness } = await runRule(rule, project, {}, 'grouped-ai');

  assert.equal(harness.backend.requests.length, 1);
  assert.deepEqual(harness.backend.requests[0]?.state, {
    files: [
      { filepath: 'a/one.txt', scopes: [{ id: 's', source: '1' }] },
      { filepath: 'a/two.txt', scopes: [{ id: 's', source: '2' }] },
    ],
  });
});

test('a custom ai input replaces the projected state and invalid input errors', async () => {
  const rule = new TestRule({
    files: ['a.txt'],
    check: ai({
      rule: 'Input policy',
      input: subject => ({ custom: true, scope: subject.kind === 'scope' ? subject.id : null }),
    }),
  });
  const { harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'input');
  assert.deepEqual(harness.backend.requests[0]?.state, { custom: true, scope: '$' });

  const bad = new TestRule({ files: ['a.txt'], check: ai({ rule: 'Input policy', input: () => Number.NaN }) });
  await assert.rejects(
    () => executeRules([loaded('bad-input', bad)], new Harness(new MemoryProject('/repo', { 'a.txt': 'A' })).context),
    /ai input/,
  );
});

test('violationMessage is reporting only and examples are normalized', async () => {
  const messaging = new TestRule({
    files: ['a.txt'],
    check: ai({ rule: 'Messaging policy', violationMessage: 'Move this out of infra' }),
  });
  const messagingRun = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  messagingRun.backend.probabilities = [0.1];
  const [messaged] = await executeRules([loaded('msg', messaging)], messagingRun.context);
  assert.equal(messaged?.evaluations[0]?.result.status, 'violation');
  assert.equal(messaged?.evaluations[0]?.result.message, 'Move this out of infra');
  assert.deepEqual(messagingRun.backend.requests[0]?.instructions, {
    rule: 'Messaging policy',
    question: 'Is the rule respected?',
  });

  const fallback = new TestRule({ files: ['a.txt'], check: ai({ rule: 'Fallback policy' }) });
  const fallbackRun = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  fallbackRun.backend.probabilities = [0.1];
  const [fell] = await executeRules([loaded('ai-fallback', fallback)], fallbackRun.context);
  assert.deepEqual(fell?.evaluations[0]?.result, {
    status: 'violation', probability: 0.1, threshold: 0.4, model: 'recording-model',
    usage: UNREPORTED_AI_USAGE,
  });

  const emptyExamples = new TestRule({
    files: ['a.txt'],
    check: ai({ rule: 'Examples policy', examples: { good: [], bad: [] } }),
  });
  const withExamples = new TestRule({
    files: ['a.txt'],
    check: ai({ rule: 'Examples policy', examples: { good: ['g'], bad: [] } }),
  });
  const examplesRun = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  await executeRules([loaded('empty-examples', emptyExamples), loaded('with-examples', withExamples)], examplesRun.context);
  assert.ok(!('examples' in (examplesRun.backend.requests[0]?.instructions ?? {})));
  assert.deepEqual(examplesRun.backend.requests[1]?.instructions.examples, { good: ['g'], bad: [] });
});

class PrototypeViolation {
  get status(): 'violation' {
    return 'violation';
  }
  get model(): string {
    return 'class-model';
  }
  get probability(): number {
    return 0.25;
  }
}

class PrototypePass {
  get status(): 'pass' {
    return 'pass';
  }
}

test('a check result keeps prototype status and optional fields without inventing a message', async () => {
  const offending = new TestRule({ files: ['a.txt'], check: () => new PrototypeViolation() });
  const { report, harness } = await runRule(
    offending,
    new MemoryProject('/repo', { 'a.txt': 'A' }),
    {},
    'prototype-violation',
  );

  assert.equal(report.status, 'violation');
  const result = report.evaluations[0]?.result;
  assert.equal(result?.status, 'violation');
  assert.equal(Object.hasOwn(result!, 'message'), false);
  assert.equal(result?.model, 'class-model');
  assert.equal(result?.probability, 0.25);

  const emitted = eventsOfType(harness.events, 'result')[0];
  assert.equal(emitted?.result.status, 'violation');

  const clean = new TestRule({ files: ['a.txt'], check: () => new PrototypePass() });
  const { report: passing } = await runRule(
    clean,
    new MemoryProject('/repo', { 'a.txt': 'A' }),
    {},
    'prototype-pass',
  );
  assert.equal(passing.status, 'pass');
  assert.equal(passing.evaluations[0]?.result.status, 'pass');
});

class MessagedViolation {
  get status(): 'violation' {
    return 'violation';
  }
  get message(): string {
    return 'getter message';
  }
  get probability(): number {
    return 0.4;
  }
  get threshold(): number {
    return 0.6;
  }
  get model(): string {
    return 'getter-model';
  }
}

class SilentPass {
  get status(): 'pass' {
    return 'pass';
  }
}

class AccessorScopeSubject {
  get kind(): 'scope' {
    return 'scope';
  }
  get filepath(): string {
    return 'a.txt';
  }
  get id(): string {
    return 'accessor-subject';
  }
  get source(): string {
    return 'A';
  }
  get data(): JsonValue {
    return { ok: true };
  }
  get captures(): Readonly<Record<string, string | readonly string[]>> {
    return { name: 'x', list: ['a', 'b'] };
  }
  get lines(): { readonly start: number; readonly end: number } {
    return { start: 1, end: 1 };
  }
}

test('a check result is canonicalized to declared plain fields', async () => {
  const withMessage = new TestRule({ files: ['a.txt'], check: () => new MessagedViolation() });
  const { report: messaged, harness: messagedRun } = await runRule(
    withMessage,
    new MemoryProject('/repo', { 'a.txt': 'A' }),
    {},
    'messaged',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(messaged.evaluations[0]?.result)), {
    status: 'violation',
    message: 'getter message',
    probability: 0.4,
    threshold: 0.6,
    model: 'getter-model',
  });
  assert.deepEqual(eventsOfType(messagedRun.events, 'result')[0]?.result, messaged.evaluations[0]?.result);

  const passing = new TestRule({ files: ['a.txt'], check: () => new SilentPass() });
  const { report: passed } = await runRule(
    passing,
    new MemoryProject('/repo', { 'a.txt': 'A' }),
    {},
    'silent',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(passed.evaluations[0]?.result)), { status: 'pass' });

  const leaky = new TestRule({
    files: ['a.txt'],
    check: () => ({ status: 'pass', threshold: 0.125, leak: 'should-not-appear' }) as unknown as CheckResult,
  });
  const { report: leaked, harness: leakyRun } = await runRule(
    leaky,
    new MemoryProject('/repo', { 'a.txt': 'A' }),
    {},
    'leaky',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(leaked.evaluations[0]?.result)), { status: 'pass', threshold: 0.125 });
  assert.deepEqual(eventsOfType(leakyRun.events, 'result')[0]?.result, { status: 'pass', threshold: 0.125 });

  const blank = new TestRule({ files: ['a.txt'], check: () => ({ status: 'violation', message: '', threshold: 0 }) });
  const { report: blankMessage } = await runRule(
    blank,
    new MemoryProject('/repo', { 'a.txt': 'A' }),
    {},
    'blank',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(blankMessage.evaluations[0]?.result)), {
    status: 'violation',
    message: '',
    threshold: 0,
  });
});

test('a custom selection subject is canonicalized to declared plain fields', async () => {
  const rule = new TestRule({
    select: async () =>
      [Object.assign(new AccessorScopeSubject(), { extra: 'should-not-appear' }) as unknown as ScopeSubject<JsonValue>],
  });
  const { report } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'custom-subject');

  assert.deepEqual(JSON.parse(JSON.stringify(report.evaluations[0]?.subject)), {
    kind: 'scope',
    filepath: 'a.txt',
    id: 'accessor-subject',
    source: 'A',
    data: { ok: true },
    captures: { name: 'x', list: ['a', 'b'] },
    lines: { start: 1, end: 1 },
  });

  const grouped = new TestRule({
    group: 'file',
    select: async () =>
      [Object.assign(new AccessorScopeSubject(), { extra: 'should-not-appear' }) as unknown as ScopeSubject<JsonValue>],
  });
  const { report: groupedReport } = await runRule(
    grouped,
    new MemoryProject('/repo', { 'a.txt': 'A' }),
    {},
    'grouped-subject',
  );
  const group = groupedReport.evaluations[0]?.subject;
  assert.equal(group?.kind, 'group');
  assert.deepEqual(JSON.parse(JSON.stringify(group?.kind === 'group' ? group.members : [])), [
    {
      kind: 'scope',
      filepath: 'a.txt',
      id: 'accessor-subject',
      source: 'A',
      data: { ok: true },
      captures: { name: 'x', list: ['a', 'b'] },
      lines: { start: 1, end: 1 },
    },
  ]);
});

test('scope selectors reject opaque captures containers and materialize line getters', async () => {
  class Captures {
    get name(): string {
      return 'x';
    }
  }
  const capturesRule = new TestRule({
    files: ['a.txt'],
    scope: () => [{ id: 's', source: 'A', captures: new Captures() } as unknown as ScopeMatch<JsonValue>],
  });
  await assert.rejects(
    () => runRule(capturesRule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'caps'),
    /captures/i,
  );

  class LineRange {
    get start(): number {
      return 1;
    }
    get end(): number {
      return 2;
    }
  }
  const linesRule = new TestRule({
    files: ['a.txt'],
    scope: () => [{ id: 's', source: 'A', lines: new LineRange() } as unknown as ScopeMatch<JsonValue>],
  });
  const { report } = await runRule(linesRule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'lines');
  assert.deepEqual(JSON.parse(JSON.stringify(report.evaluations[0]?.subject)), {
    kind: 'scope',
    filepath: 'a.txt',
    id: 's',
    source: 'A',
    lines: { start: 1, end: 2 },
  });
});

test('a custom selection rejects sparse capture arrays instead of emitting holes', async () => {
  const rule = new TestRule({
    select: async (): Promise<readonly ScopeSubject<JsonValue>[]> =>
      [
        {
          kind: 'scope',
          filepath: 'a.txt',
          id: 'sparse',
          source: 'A',
          captures: { name: new Array<string>(2) },
        },
      ],
  });
  await assert.rejects(
    () => runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'sparse-captures'),
    /captures/i,
  );
});

test('a deterministic rule never resolves a decision runtime', async () => {
  const rule = new TestRule({ files: ['**/*.txt'], check: regex({ pattern: /^[a-z]+$/ }) });
  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'abc', 'b.txt': 'def' }), {}, 'regex');

  assert.equal(report.status, 'pass');
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result), [{ status: 'pass' }, { status: 'pass' }]);
  assert.equal(harness.resolveCalls, 0);
  assert.equal(harness.backend.requests.length, 0);
  assert.equal(eventsOfType(harness.events, 'request').length, 0);
  assert.equal(eventsOfType(harness.events, 'response').length, 0);
});

test('a custom check replacing its AI result does not inherit threshold metadata', async () => {
  const rule = new TestRule({
    files: ['a.txt'],
    check: async (_subject, context) => {
      await context.ai({ rule: 'Advisory policy' });
      return pass();
    },
  });
  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), { threshold: 0.67 });
  assert.equal(harness.backend.requests.length, 1);
  for (const result of [
    report.evaluations[0]?.result,
    eventsOfType(harness.events, 'result')[0]?.result,
  ]) {
    assert.equal(result?.status, 'pass');
    assert.equal(result?.threshold, undefined);
  }
});

test('a skipped rule never resolves a runtime or sends a request', async () => {
  const rule = new TestRule({ files: ['**/*.txt'], when: () => false, check: ai({ rule: 'Never asked' }) });
  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'skipped-ai');
  assert.equal(report.status, 'skipped');
  assert.equal(harness.resolveCalls, 0);
  assert.equal(harness.backend.requests.length, 0);
});

test('a full run emits associated rule/gate/file/scope/result events', async () => {
  const scope: ScopeSelector = file => [
    { id: 'one', source: file.source },
    { id: 'two', source: file.source },
  ];
  const rule = new TestRule({ files: ['a.txt'], scope });

  const { harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'events');

  const ruleEvents = eventsOfType(harness.events, 'rule');
  assert.equal(ruleEvents.length, 1);
  assert.equal(ruleEvents[0]?.name, 'events');
  assert.equal(ruleEvents[0]?.ruleFile, `${RULE_DIR}/events.rule.ts`);

  assert.equal(eventsOfType(harness.events, 'gate').length, 1);
  assert.deepEqual(eventsOfType(harness.events, 'file').map(event => event.filepath), ['a.txt']);
  assert.deepEqual(eventsOfType(harness.events, 'scope').map(event => event.subject.id), ['one', 'two']);

  const results = eventsOfType(harness.events, 'result');
  assert.deepEqual(results.map(event => [asScope(event.subject).id, event.result.status]), [
    ['one', 'pass'],
    ['two', 'pass'],
  ]);
  assert.equal(results[0]?.name, 'events');
  assert.deepEqual(eventsOfType(harness.events, 'evaluation').map(event =>
    [event.evaluationId, event.name, asScope(event.subject).id],
  ), [[1, 'events', 'one'], [2, 'events', 'two']]);
  assert.deepEqual(results.map(event => event.evaluationId), [1, 2]);
  assertEvaluationLifecycle(harness.events);
});

test('custom traces are surfaced as trace events tied to the rule', async () => {
  const rule = new TestRule({
    files: ['a.txt'],
    check: (subject, context) => {
      context.trace('inspect-scope', { id: subject.kind === 'scope' ? subject.id : null });
      return pass();
    },
  });
  const { harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'traced');

  const traces = eventsOfType(harness.events, 'trace');
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.name, 'traced');
  assert.equal(traces[0]?.message, 'inspect-scope');
  assert.deepEqual(traces[0]?.details, { id: '$' });
  assert.equal(traces[0]?.evaluationId, 1);
  assertEvaluationLifecycle(harness.events);
});

test('malformed check results are errors, never coerced to passes', async () => {
  const cases: unknown[] = [
    true,
    undefined,
    { status: 'weird' },
    { status: 'pass', probability: 2 },
    { status: 'pass', threshold: NaN },
    { status: 'violation', threshold: 1.1 },
    { status: 'violation', model: '' },
  ];
  for (const result of cases) {
    const rule = new TestRule({
      files: ['a.txt'],
      check: () => result as CheckResult,
    });
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
    await assert.rejects(
      () => executeRules([loaded('bad-result', rule)], harness.context),
      `expected ${JSON.stringify(result)} to be rejected`,
    );
    assert.deepEqual(eventsOfType(harness.events, 'error').map(event => [event.evaluationId, event.stage]), [[1, 'check']]);
    assert.equal(eventsOfType(harness.events, 'result').length, 0);
    assertEvaluationLifecycle(harness.events);
  }
});

test('concurrent duplicate subjects retain task IDs across traces, selections, AI calls and check errors', { timeout: 5000 }, async () => {
  const project = new MemoryProject('/repo', {
    'a.txt': 'A',
    'context-keep.txt': 'keep',
    'context-skip.txt': 'skip',
  });
  const harness = new Harness(project, { concurrency: 2 });
  const checks: string[] = [];
  const makeRule = (label: string) => new TestRule({
    files: ['a.txt'],
    check: async (_subject, context) => {
      checks.push(label);
      context.trace('started', { label });
      await context.select({ files: ['context-*.txt'], exclude: ['context-skip.txt'] });
      context.trace('selected', { label });
      await context.ai({ rule: label });
      if (label === 'second') throw new Error('second check failed');
      await new Promise<void>(resolve => { setImmediate(resolve); });
      context.trace('resumed', { label });
      return context.ai({ rule: `${label} again` });
    },
  });

  await assert.rejects(() => executeRules([
    loaded('duplicate', makeRule('first')),
    loaded('duplicate', makeRule('second')),
  ], harness.context), /second check failed/);

  assert.deepEqual(checks, ['first', 'second']);
  const starts = eventsOfType(harness.events, 'evaluation');
  assert.deepEqual(starts.map(event => event.evaluationId), [1, 2]);
  assert.deepEqual(starts[0]?.subject, starts[1]?.subject);
  assert.equal(starts[0]?.name, starts[1]?.name);
  assert.deepEqual(eventsOfType(harness.events, 'trace').map(event =>
    [event.evaluationId, event.message, event.details],
  ), [
    [1, 'started', { label: 'first' }],
    [2, 'started', { label: 'second' }],
    [1, 'selected', { label: 'first' }],
    [2, 'selected', { label: 'second' }],
    [1, 'resumed', { label: 'first' }],
  ]);
  assert.deepEqual(eventsOfType(harness.events, 'file').map(event =>
    [event.evaluationId, event.filepath, event.selected, event.reason],
  ), [
    [undefined, 'a.txt', true, undefined],
    [undefined, 'a.txt', true, undefined],
    [1, 'context-keep.txt', true, undefined],
    [1, 'context-skip.txt', false, 'excluded'],
    [2, 'context-keep.txt', true, undefined],
    [2, 'context-skip.txt', false, 'excluded'],
  ]);
  assert.deepEqual(eventsOfType(harness.events, 'request').map(event =>
    [event.evaluationId, (JSON.parse(event.body) as DecisionRequest).instructions.rule],
  ), [[1, 'first'], [2, 'second'], [1, 'first again']]);
  assert.deepEqual(eventsOfType(harness.events, 'response').map(event => event.evaluationId), [1, 2, 1]);
  assert.deepEqual(eventsOfType(harness.events, 'error').map(event =>
    [event.evaluationId, event.name, event.stage],
  ), [[2, 'duplicate', 'check']]);
  assert.deepEqual(eventsOfType(harness.events, 'result').map(event => event.evaluationId), [1]);
  assertEvaluationLifecycle(harness.events);
});

test('stage traces and failures remain outside evaluations even after another rule was selected', async () => {
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });
  const trace = (context: ProjectContext) => { context.trace('setup'); };
  for (const stage of ['when', 'select', 'filter', 'group'] as const) {
    const failure = new Error(`${stage} failed`);
    const rule = new TestRule({
      files: ['a.txt'],
      when: context => {
        trace(context);
        if (stage === 'when') throw failure;
        return true;
      },
      select: async context => {
        trace(context);
        if (stage === 'select') throw failure;
        return context.select({ files: ['a.txt'] });
      },
      filter: (_subject, context) => {
        trace(context);
        if (stage === 'filter') throw failure;
        return true;
      },
    });
    if (stage === 'group') rule.group = null as unknown as Grouping;
    const harness = new Harness(project);

    await assert.rejects(() => executeRules([
      loaded('selected-first', new TestRule({ files: ['a.txt'] })),
      loaded('failing-stage', rule),
    ], harness.context), stage === 'group' ? /./ : error => error === failure);

    assert.equal(eventsOfType(harness.events, 'evaluation').length, 0);
    const errors = eventsOfType(harness.events, 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.name, 'failing-stage');
    assert.equal(errors[0]?.stage, stage);
    assert.equal(Object.hasOwn(errors[0]!, 'evaluationId'), false);
    assert.ok(eventsOfType(harness.events, 'trace').length > 0);
    assert.ok(eventsOfType(harness.events, 'trace').every(event => !Object.hasOwn(event, 'evaluationId')));
    assert.ok(eventsOfType(harness.events, 'file').every(event => !Object.hasOwn(event, 'evaluationId')));
    assertEvaluationLifecycle(harness.events);
  }
});

test('evaluation task IDs restart at one for each run and skip unevaluated rules', async () => {
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  const rules = [
    loaded('skipped', new TestRule({ when: () => false })),
    loaded('checked', new TestRule({ files: ['a.txt'] })),
  ];
  for (let run = 0; run < 2; run += 1) {
    harness.events.length = 0;
    const reports = await executeRules(rules, harness.context);
    assert.deepEqual(reports.map(report => report.status), ['skipped', 'pass']);
    assert.deepEqual(eventsOfType(harness.events, 'evaluation').map(event =>
      [event.evaluationId, event.name],
    ), [[1, 'checked']]);
    assertEvaluationLifecycle(harness.events);
  }
});

test('a violation without a message preserves its result in the report and event', async () => {
  const rule = new TestRule({ files: ['a.txt'], check: () => ({ status: 'violation' }) });
  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'fallback');

  assert.equal(report.status, 'violation');
  assert.deepEqual(report.evaluations[0]?.result, { status: 'violation' });
  assert.deepEqual(eventsOfType(harness.events, 'result')[0]?.result, { status: 'violation' });
});

test('message-free violations preserve supplied probability and model metadata', async () => {
  const rule = new TestRule({
    files: ['a.txt'],
    check: () => ({ status: 'violation', probability: 0.2, model: 'custom' }),
  });
  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'preserve');

  const expected: CheckResult = {
    status: 'violation',
    probability: 0.2,
    model: 'custom',
  };
  assert.equal(report.status, 'violation');
  assert.deepEqual(report.evaluations[0]?.result, expected);
  assert.deepEqual(eventsOfType(harness.events, 'result')[0]?.result, expected);
});

test('an explicit empty message is preserved in reports and events', async () => {
  const rule = new TestRule({ files: ['a.txt'], check: () => ({ status: 'violation', message: '' }) });
  const { report, harness } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), {}, 'empty-message');

  assert.equal(report.status, 'violation');
  assert.equal(report.evaluations[0]?.result.message, '');
  assert.equal(eventsOfType(harness.events, 'result')[0]?.result.message, '');
});

test('reports aggregate violations per rule and preserve loaded order', async () => {
  const passing = new TestRule({ files: ['a.txt'] });
  const mixed = new TestRule({
    files: ['**/*.txt'],
    scope: file => [{ id: 'ok', source: file.source }, { id: 'bad', source: file.source }],
    check: subject => (asScope(subject).id === 'bad' ? violation('bad scope') : pass()),
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));

  const reports = await executeRules([loaded('first', passing), loaded('second', mixed)], harness.context);

  assert.deepEqual(reports.map(report => [report.name, report.status]), [
    ['first', 'pass'],
    ['second', 'violation'],
  ]);
  assert.equal(reports[1]?.evaluations.length, 2);
});

test('rules share the run project while each check receives a bound context', async () => {
  const project = new MemoryProject('/repo', { 'a.txt': 'A', 'b.txt': 'B' });
  const contexts: CheckContext[] = [];
  const ruleA = new TestRule({ files: ['a.txt'], check: (_subject, context) => { contexts.push(context); return pass(); } });
  const ruleB = new TestRule({ files: ['b.txt'], check: (_subject, context) => { contexts.push(context); return pass(); } });
  const harness = new Harness(project);

  await executeRules([loaded('A', ruleA), loaded('B', ruleB)], harness.context);

  assert.equal(contexts.length, 2);
  assert.notEqual(contexts[0], contexts[1]);
  assert.equal(contexts[0]?.ruleName, 'A');
  assert.equal(contexts[1]?.ruleName, 'B');
  assert.ok(contexts.every(context => context.project === project));
});

test('progress covers rule selection before counting grouped evaluation subjects', async () => {
  const project = new MemoryProject('/repo', { 'a.txt': 'A', 'b.txt': 'B' });
  const harness = new Harness(project, { concurrency: 3 });
  const disabled = new TestRule();
  disabled.enabled = false;
  const scope: ScopeSelector = file => [
    { id: 'first', source: file.source },
    { id: 'second', source: file.source },
  ];
  const check = (): CheckResult => {
    const progress = eventsOfType(harness.events, 'progress');
    assert.deepEqual(progress.filter(event => event.phase === 'selection').at(-1), {
      type: 'progress', phase: 'selection', completed: 5, total: 5,
    });
    assert.deepEqual(progress.find(event => event.phase === 'evaluation'), {
      type: 'progress', phase: 'evaluation', completed: 0, total: 6,
    });
    return pass();
  };
  const reports = await executeRules([
    loaded('disabled', disabled),
    loaded('gated', new TestRule({ when: () => false })),
    loaded('filtered', new TestRule({ files: ['*.txt'], filter: () => false })),
    loaded('files', new TestRule({ files: ['*.txt'], scope, group: 'file', check })),
    loaded('scopes', new TestRule({ files: ['*.txt'], scope, check })),
  ], harness.context);

  assert.deepEqual(reports.map(report => [report.status, report.evaluations.length]), [
    ['skipped', 0], ['skipped', 0], ['skipped', 0], ['pass', 2], ['pass', 4],
  ]);
  assert.deepEqual(eventsOfType(harness.events, 'progress'), [
    ...Array.from({ length: 6 }, (_, completed) => ({
      type: 'progress', phase: 'selection', completed, total: 5,
    })),
    ...Array.from({ length: 7 }, (_, completed) => ({
      type: 'progress', phase: 'evaluation', completed, total: 6,
    })),
  ]);
  const selectionEnd = harness.events.findIndex(event =>
    event.type === 'progress' && event.phase === 'selection' && event.completed === event.total,
  );
  const evaluationStart = harness.events.findIndex(event =>
    event.type === 'progress' && event.phase === 'evaluation',
  );
  const lastSelection = harness.events.findLastIndex(event => event.type === 'scope');
  const lastGroup = harness.events.findLastIndex(event => event.type === 'group');
  const firstResult = harness.events.findIndex(event => event.type === 'result');
  assert.ok(lastSelection < selectionEnd && selectionEnd < evaluationStart);
  assert.ok(lastGroup < evaluationStart && evaluationStart < firstResult);
});

test('empty and entirely skipped runs complete both progress phases without evaluations', async () => {
  const disabled = new TestRule();
  disabled.enabled = false;
  const skipped = [
    loaded('disabled', disabled),
    loaded('gated', new TestRule({ when: () => false })),
    loaded('unmatched', new TestRule({ files: ['missing.txt'] })),
    loaded('filtered', new TestRule({ files: ['a.txt'], filter: () => false })),
  ];
  for (const rules of [[], skipped]) {
    const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
    const reports = await executeRules(rules, harness.context);
    assert.ok(reports.every(report => report.status === 'skipped'));
    assert.equal(reports.length, rules.length);
    assert.equal(eventsOfType(harness.events, 'result').length, 0);
    assert.equal(harness.resolveCalls, 0);
    assert.deepEqual(eventsOfType(harness.events, 'progress'), [
      ...Array.from({ length: rules.length + 1 }, (_, completed) => ({
        type: 'progress', phase: 'selection', completed, total: rules.length,
      })),
      { type: 'progress', phase: 'evaluation', completed: 0, total: 0 },
    ]);
  }
});

test('evaluation progress counts concurrent completions rather than scheduling order', { timeout: 5000 }, async () => {
  let firstWaveStarted!: () => void;
  let lastStarted!: () => void;
  const firstWave = new Promise<void>(resolve => { firstWaveStarted = resolve; });
  const last = new Promise<void>(resolve => { lastStarted = resolve; });
  const releases = new Map<string, () => void>();
  const finished: string[] = [];
  const rule = new TestRule({
    files: ['a.txt'],
    scope: file => ['0', '1', '2'].map(id => ({ id, source: file.source })),
    check: async subject => {
      const id = asScope(subject).id;
      await new Promise<void>(resolve => {
        releases.set(id, resolve);
        if (releases.size === 2) firstWaveStarted();
        if (releases.size === 3) lastStarted();
      });
      finished.push(id);
      return pass();
    },
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }), { concurrency: 2 });
  const running = executeRules([loaded('concurrent', rule)], harness.context);
  await firstWave;
  assert.deepEqual(eventsOfType(harness.events, 'progress').filter(event => event.phase === 'evaluation'), [
    { type: 'progress', phase: 'evaluation', completed: 0, total: 3 },
  ]);
  releases.get('1')!();
  await last;
  assert.deepEqual(eventsOfType(harness.events, 'progress').filter(event => event.phase === 'evaluation'), [
    { type: 'progress', phase: 'evaluation', completed: 0, total: 3 },
    { type: 'progress', phase: 'evaluation', completed: 1, total: 3 },
  ]);
  releases.get('2')!();
  releases.get('0')!();
  const reports = await running;
  assert.deepEqual(finished, ['1', '2', '0']);
  assert.deepEqual(eventsOfType(harness.events, 'progress').filter(event => event.phase === 'evaluation'), [
    { type: 'progress', phase: 'evaluation', completed: 0, total: 3 },
    { type: 'progress', phase: 'evaluation', completed: 1, total: 3 },
    { type: 'progress', phase: 'evaluation', completed: 2, total: 3 },
    { type: 'progress', phase: 'evaluation', completed: 3, total: 3 },
  ]);
  assert.deepEqual(reports[0]?.evaluations.map(evaluation => asScope(evaluation.subject).id), ['0', '1', '2']);
});

test('rule timing excludes unrelated selection and initial queue waiting while overlapping checks use wall time', { timeout: 5000 }, async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const waits = new Map<string, {
    started: Promise<void>;
    start: () => void;
    completed: Promise<void>;
    complete: () => void;
    observed: Promise<void>;
    observe: () => void;
  }>();
  for (const id of ['early-0', 'early-1', 'early-2', 'queued-0', 'queued-1']) {
    let start!: () => void;
    let complete!: () => void;
    let observe!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const observed = new Promise<void>(resolve => { observe = resolve; });
    waits.set(id, { started, start, completed, complete, observed, observe });
  }
  const starts: [string, number][] = [];
  const makeRule = (prefix: string, count: number, selectionMs: number) => new TestRule({
    select: () => {
      now += selectionMs;
      return Array.from({ length: count }, (_, index) => ({
        kind: 'scope' as const, filepath: 'a.txt', id: `${prefix}-${index}`, source: 'A',
      }));
    },
    check: async subject => {
      const id = asScope(subject).id;
      starts.push([id, now]);
      const wait = waits.get(id)!;
      wait.start();
      await wait.completed;
      return pass();
    },
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }), { concurrency: 2 });
  const running = executeRules([
    loaded('early', makeRule('early', 3, 5)),
    loaded('slow-selection', makeRule('slow', 0, 100)),
    loaded('queued', makeRule('queued', 2, 7)),
  ], {
    ...harness.context,
    emit: event => {
      harness.context.emit?.(event);
      if (event.type === 'result') waits.get(asScope(event.subject).id)!.observe();
    },
  });
  await waits.get('early-0')!.started;
  await waits.get('early-1')!.started;
  for (const [id, finishAt, next] of [
    ['early-1', 122, 'early-2'],
    ['early-2', 132, 'queued-0'],
    ['queued-0', 137, 'queued-1'],
    ['queued-1', 142, undefined],
    ['early-0', 152, undefined],
  ] as const) {
    now = finishAt;
    waits.get(id)!.complete();
    await waits.get(id)!.observed;
    if (next !== undefined) await waits.get(next)!.started;
  }
  const reports = await running;
  assert.deepEqual(starts, [
    ['early-0', 112], ['early-1', 112], ['early-2', 122], ['queued-0', 132], ['queued-1', 137],
  ]);
  assert.deepEqual(reports.map(report => [report.name, report.durationMs]), [
    ['early', 45], ['slow-selection', 100], ['queued', 17],
  ]);
  assert.deepEqual(reports[0]?.evaluations.map(({ subject }) => asScope(subject).id), [
    'early-0', 'early-1', 'early-2',
  ]);
  assert.deepEqual(reports.map(report => report.status), ['pass', 'skipped', 'pass']);
});

test('disabled, gated, empty and filtered rules retain their measured selection time', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const when = () => { now += 3; return true; };
  const select = () => {
    now += 5;
    return [{ kind: 'scope' as const, filepath: 'a.txt', id: '$', source: 'A' }];
  };
  const disabled = new TestRule();
  disabled.enabled = false;
  const rules = [
    loaded('disabled', disabled),
    loaded('gated', new TestRule({ when: () => { now += 3; return false; } })),
    loaded('empty', new TestRule({ when, select: () => { now += 5; return []; } })),
    loaded('filtered', new TestRule({
      when, select, filter: () => { now += 11; return false; },
    })),
  ];
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }));
  const reports = await executeRules(rules, {
    ...harness.context,
    emit: event => {
      harness.context.emit?.(event);
      if (event.type === 'gate') now += 2;
    },
  });
  assert.deepEqual(reports.map(report => [report.name, report.durationMs, report.reason]), [
    ['disabled', 2, 'disabled'],
    ['gated', 5, 'when returned false'],
    ['empty', 10, 'no matching subjects'],
    ['filtered', 21, 'no matching subjects'],
  ]);
  assert.ok(reports.every(report => report.status === 'skipped' && report.evaluations.length === 0));
});

test('grouped rule timing includes its grouping interval without changing subject counts', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const rule = new TestRule({
    group: 'file',
    when: () => { now += 3; return true; },
    select: () => {
      now += 5;
      return [
        { kind: 'scope', filepath: 'a.txt', id: 'one', source: 'A' },
        { kind: 'scope', filepath: 'a.txt', id: 'two', source: 'A' },
        { kind: 'scope', filepath: 'b.txt', id: 'one', source: 'B' },
      ];
    },
    filter: () => { now += 11; return true; },
    check: () => { now += 13; return pass(); },
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A', 'b.txt': 'B' }), { concurrency: 1 });
  const [report] = await executeRules([loaded('grouped', rule)], {
    ...harness.context,
    emit: event => {
      harness.context.emit?.(event);
      if (event.type === 'gate') now += 2;
      if (event.type === 'group') now += 7;
    },
  });
  assert.ok(report);
  assert.equal(report.durationMs, 83);
  assert.deepEqual(report.evaluations.map(({ subject }) => asGroup(subject).members.length), [2, 1]);
  assert.equal(rule.checkCalls, 2);
  assert.deepEqual(eventsOfType(harness.events, 'progress').filter(event => event.phase === 'evaluation'), [
    { type: 'progress', phase: 'evaluation', completed: 0, total: 2 },
    { type: 'progress', phase: 'evaluation', completed: 1, total: 2 },
    { type: 'progress', phase: 'evaluation', completed: 2, total: 2 },
  ]);
});

test('progress observers do not change execution reports', async () => {
  const rule = new TestRule({ files: ['a.txt'], check: () => violation('policy detail') });
  const project = new MemoryProject('/repo', { 'a.txt': 'A' });
  const observed = new Harness(project);
  const unobserved = new Harness(project);
  const { emit: _emit, ...context } = unobserved.context;
  assert.deepEqual(
    stableReports(await executeRules([loaded('policy', rule)], context)),
    stableReports(await executeRules([loaded('policy', rule)], observed.context)),
  );
});

test('evaluation concurrency is bounded, ordered, and uses the configured limit', async () => {
  const scope: ScopeSelector = file => Array.from({ length: 6 }, (_unused, index) => ({ id: String(index), source: file.source }));
  let inFlight = 0;
  let maxInFlight = 0;
  const completed: string[] = [];
  const rule = new TestRule({
    files: ['**/*.txt'],
    scope,
    check: async subject => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => { setImmediate(resolve); });
      completed.push(asScope(subject).id);
      inFlight -= 1;
      return pass();
    },
  });

  const { report } = await runRule(rule, new MemoryProject('/repo', { 'a.txt': 'A' }), { concurrency: 2 }, 'bounded');

  assert.equal(maxInFlight, 2);
  assert.deepEqual(completed, ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual(report.evaluations.map(evaluation => asScope(evaluation.subject).id), ['0', '1', '2', '3', '4', '5']);
});

test('the flattened evaluation map bounds concurrency across rules', async () => {
  const scope: ScopeSelector = file => Array.from({ length: 3 }, (_unused, index) => ({ id: String(index), source: file.source }));
  let inFlight = 0;
  let maxInFlight = 0;
  const makeRule = (): TestRule =>
    new TestRule({
      files: ['a.txt'],
      scope,
      check: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>(resolve => { setImmediate(resolve); });
        inFlight -= 1;
        return pass();
      },
    });

  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }), { concurrency: 2 });
  const reports = await executeRules([loaded('one', makeRule()), loaded('two', makeRule())], harness.context);

  assert.equal(reports.length, 2);
  assert.ok(maxInFlight <= 2, `expected at most 2 in flight, saw ${maxInFlight}`);
  assert.ok(maxInFlight >= 1);
  assert.deepEqual(reports.map(report => report.evaluations.length), [3, 3]);
});

test('a failing evaluation stops scheduling and awaits in-flight work', async () => {
  const scope: ScopeSelector = file => Array.from({ length: 6 }, (_unused, index) => ({ id: String(index), source: file.source }));
  const started: string[] = [];
  let slowFinished = false;
  const rule = new TestRule({
    files: ['**/*.txt'],
    scope,
    check: async subject => {
      const id = asScope(subject).id;
      started.push(id);
      if (id === '0') {
        await new Promise<void>(resolve => { setImmediate(resolve); });
        throw new Error('evaluation exploded');
      }
      if (id === '1') {
        await new Promise<void>(resolve => { setImmediate(resolve); });
        slowFinished = true;
      }
      return pass();
    },
  });
  const harness = new Harness(new MemoryProject('/repo', { 'a.txt': 'A' }), { concurrency: 2 });

  await assert.rejects(() => executeRules([loaded('stopper', rule)], harness.context), /evaluation exploded/);

  assert.ok(slowFinished, 'in-flight work must complete before the rejection surfaces');
  assert.ok(started.includes('0') && started.includes('1'));
  assert.ok(started.length < 6, `expected scheduling to stop early, saw ${started.join(',')}`);

  const errors = eventsOfType(harness.events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.name, 'stopper');
  assert.match(errors[0]?.message ?? '', /evaluation exploded/);
  assert.equal(errors[0]?.evaluationId, 1);
  assertEvaluationLifecycle(harness.events);
  const progress = eventsOfType(harness.events, 'progress').filter(event => event.phase === 'evaluation');
  assert.deepEqual(progress.map(event => event.completed), Array.from({ length: started.length }, (_, index) => index));
  assert.ok(progress.every(event => event.total === 6 && event.completed < event.total));
});
