import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';

import {
  Rule,
  ai,
  pass,
  regex,
  violation,
  type AiOptions,
  type CheckContext,
  type CheckResult,
  type CsvRow,
  type GroupSubject,
  type JsonValue,
  type Project,
  type ProjectContext,
  type ScopeMatch,
  type ScopeSelector,
  type ScopeSubject,
  type SourceFile,
  type Subject,
} from '../dist/index.js';
import { evaluateAi } from '../dist/app/evaluators.js';
import type { DecisionBackend, DecisionObserver, DecisionRuntime } from '../dist/app/ports.js';
import {
  validateCheckResult,
  validateJsonValue,
  validateRule,
  validateScopeMatch,
} from '../dist/app/validate.js';

const BRAND = Symbol.for('rulekeeper.Rule');
const RULE_FILE = '/rules/contracts.rule.ts';

class MemoryProject implements Project {
  readonly root: string;
  readonly #files: Map<string, string>;

  constructor(root = '/memory', files: Readonly<Record<string, string>> = {}) {
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
    throw new Error('MemoryProject does not read YAML');
  }

  async readCsv(): Promise<readonly CsvRow[]> {
    throw new Error('MemoryProject does not read CSV');
  }
}

interface CapturedTrace {
  readonly message: string;
  readonly details: JsonValue | undefined;
}

interface TestContextOptions {
  readonly project?: Project;
  readonly ruleName?: string;
  readonly subject?: Subject<JsonValue>;
  readonly runtime?: DecisionRuntime;
}

class TestContext implements CheckContext<JsonValue> {
  readonly project: Project;
  readonly ruleName: string;
  readonly traces: CapturedTrace[] = [];
  readonly selections: unknown[] = [];
  subjects: readonly ScopeSubject<JsonValue>[] = [];
  aiCalls = 0;
  #subject: Subject<JsonValue> | undefined;
  #runtime: DecisionRuntime | undefined;

  constructor(options: TestContextOptions = {}) {
    this.project = options.project ?? new MemoryProject();
    this.ruleName = options.ruleName ?? 'contract-rule';
    this.#subject = options.subject;
    this.#runtime = options.runtime;
  }

  trace(message: string, details?: JsonValue): void {
    this.traces.push({ message, details });
  }

  async select<T>(selection: {
    files: readonly string[];
    exclude?: readonly string[];
    scope?: ScopeSelector<T>;
  }): Promise<readonly ScopeSubject<T>[]> {
    this.selections.push(selection);
    return this.subjects as unknown as readonly ScopeSubject<T>[];
  }

  async ai(options: AiOptions<JsonValue>): Promise<CheckResult> {
    this.aiCalls += 1;
    const subject = this.#subject;
    const runtime = this.#runtime;
    if (subject === undefined || runtime === undefined) {
      throw new Error('TestContext has no bound subject or runtime');
    }
    return evaluateAi(
      subject,
      options,
      {
        project: this.project,
        ruleName: this.ruleName,
        trace: (message, details) => this.trace(message, details),
      },
      runtime,
    );
  }
}

type DecisionRequest = Parameters<DecisionBackend['decide']>[0];

class RecordingBackend implements DecisionBackend {
  readonly requests: DecisionRequest[] = [];
  probability: number;
  model: string;

  constructor(probability = 0.9, model = 'test-model') {
    this.probability = probability;
    this.model = model;
  }

  async decide(request: DecisionRequest): Promise<{ probability: number; model: string }> {
    this.requests.push(request);
    return { probability: this.probability, model: this.model };
  }
}

function runtimeFor(backend: DecisionBackend, threshold = 0.4): DecisionRuntime {
  return { backend, threshold };
}

function requestAt(backend: RecordingBackend, index = 0): DecisionRequest {
  const request = backend.requests[index];
  assert.ok(request, `backend received no request at index ${index}`);
  return request;
}

function projectContext(ruleName = 'contract-rule'): ProjectContext & { readonly ruleName: string } {
  return { project: new MemoryProject(), ruleName, trace: () => {} };
}

function scopeSubject(subject: Omit<ScopeSubject<JsonValue>, 'kind'>): ScopeSubject<JsonValue> {
  return { kind: 'scope', ...subject };
}

function groupSubject(
  members: readonly ScopeSubject<JsonValue>[],
  path = 'a.json',
): GroupSubject<JsonValue> {
  return { kind: 'group', group: { type: 'folder', path }, members };
}

class DefaultsRule extends Rule {
  check = async () => pass();
}

class ScopedRule extends Rule {
  files = ['src/**/*.json'];
  scope = (file: SourceFile): readonly ScopeMatch[] => [{ id: '$', source: file.source }];
  check = async () => pass();
}

function brandedPrototype(): object {
  const prototype: Record<symbol, unknown> = {};
  Object.defineProperty(prototype, BRAND, { value: true, enumerable: false });
  return prototype;
}

class ForeignRule {
  enabled = true;
  files: readonly string[] = ['**/*'];
  exclude: readonly string[] = [];
  settings: Record<string, unknown> = {};
  group: unknown = 'scope';
  when = (): boolean => true;
  filter = (): boolean => true;
  select = (): readonly unknown[] => [];
  check = (): { readonly status: 'pass' } => ({ status: 'pass' });
}

Object.defineProperty(ForeignRule.prototype, BRAND, { value: true, enumerable: false });

function brandedRule(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const rule = Object.setPrototypeOf({ ...new ForeignRule() }, ForeignRule.prototype);
  return Object.assign(rule, fields);
}

function expectThrows(label: string, run: () => unknown): void {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  assert.ok(threw, `expected a thrown error for ${label}`);
}

test('Rule exposes its documented defaults', async () => {
  const rule = new DefaultsRule();
  assert.equal(rule.enabled, true);
  assert.deepStrictEqual(rule.files, ['**/*']);
  assert.deepStrictEqual(rule.exclude, []);
  assert.equal(rule.scope, undefined);
  assert.deepStrictEqual(rule.settings, {});
  assert.equal(rule.group, 'scope');

  const context: ProjectContext = { project: new MemoryProject(), trace: () => {} };
  assert.equal(await rule.when(context), true);
  const subject = scopeSubject({ filepath: 'a.txt', id: '$', source: 'text' });
  assert.equal(await rule.filter(subject, context), true);
});

test('Rule.select forwards files and a custom scope to the selection context', async () => {
  const rule = new ScopedRule();
  const context = new TestContext();
  const subject = scopeSubject({ filepath: 'src/a.json', id: '$', source: '{}' });
  context.subjects = [subject];

  const selected = await rule.select(context);

  assert.deepStrictEqual(selected, [subject]);
  assert.equal(context.selections.length, 1);
  assert.deepStrictEqual(context.selections[0], {
    files: ['src/**/*.json'],
    exclude: [],
    scope: rule.scope,
  });
});

test('Rule.select omits an absent scope instead of forwarding undefined', async () => {
  const rule = new DefaultsRule();
  const context = new TestContext();
  context.subjects = [scopeSubject({ filepath: 'a.txt', id: '$', source: 'x' })];

  const selected = await rule.select(context);

  assert.equal(selected.length, 1);
  assert.deepStrictEqual(context.selections[0], { files: ['**/*'], exclude: [] });
});

test('Rule brands its prototype with a shared non-enumerable symbol', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Rule.prototype, BRAND);
  assert.equal(descriptor?.value, true);
  assert.equal(descriptor?.enumerable, false);
  assert.equal(Reflect.get(Rule.prototype, BRAND), true);
  assert.equal(Reflect.get(new DefaultsRule(), BRAND), true);
});

test('a separately defined Rule copy carries the same brand without being an instance', () => {
  const instance = new ForeignRule();
  assert.equal(instance instanceof Rule, false);
  assert.equal(Reflect.get(ForeignRule.prototype, BRAND), true);
  assert.equal(Reflect.get(instance, BRAND), true);
  assert.doesNotThrow(() => validateRule(instance, RULE_FILE));
});

test('validateRule accepts structurally valid rules in every grouping and setting form', () => {
  const accepted: readonly Record<string, unknown>[] = [
    brandedRule(),
    brandedRule({ enabled: false }),
    brandedRule({ scope: () => [] }),
    brandedRule({ group: 'file' }),
    brandedRule({ group: 'folder' }),
    brandedRule({ group: 'project' }),
    brandedRule({ group: { by: 'folder', level: 0 } }),
    brandedRule({ group: { by: 'folder', level: -3 } }),
    brandedRule({ exclude: ['old/**'] }),
    brandedRule({ settings: { backend: 'jev', model: 'jev-latest', threshold: 0 } }),
    brandedRule({ settings: { backend: 'jev', model: 'jev-latest', threshold: 1 } }),
  ];

  for (const rule of accepted) {
    assert.doesNotThrow(() => validateRule(rule, RULE_FILE));
  }
});

test('validateRule describes the rule file when validation fails', () => {
  const rule = brandedRule();
  delete rule.check;
  try {
    validateRule(rule, RULE_FILE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(message.includes(RULE_FILE), `expected the rule file in "${message}"`);
    return;
  }
  assert.fail('expected validateRule to reject a rule without a check');
});

const malformed: readonly (readonly [string, (rule: Record<string, unknown>) => void])[] = [
  ['missing check', rule => void delete rule.check],
  ['non-callable check', rule => void (rule.check = 'pass')],
  ['non-callable when', rule => void (rule.when = 1)],
  ['non-callable filter', rule => void (rule.filter = null)],
  ['non-callable select', rule => void (rule.select = {})],
  ['non-callable scope', rule => void (rule.scope = 'all')],
  ['non-boolean enabled', rule => void (rule.enabled = 'yes')],
  ['missing enabled', rule => void delete rule.enabled],
  ['empty files', rule => void (rule.files = [])],
  ['non-array files', rule => void (rule.files = '**/*')],
  ['empty glob entry', rule => void (rule.files = [''])],
  ['non-string glob entry', rule => void (rule.files = ['a', 7])],
  ['non-array exclude', rule => void (rule.exclude = 'a')],
  ['empty exclude entry', rule => void (rule.exclude = [''])],
  ['non-string exclude entry', rule => void (rule.exclude = [1])],
  ['unknown group', rule => void (rule.group = 'files')],
  ['group object without by', rule => void (rule.group = { level: 0 })],
  ['folder level above zero', rule => void (rule.group = { by: 'folder', level: 1 })],
  ['fractional folder level', rule => void (rule.group = { by: 'folder', level: 0.5 })],
  ['string folder level', rule => void (rule.group = { by: 'folder', level: '0' })],
  ['non-object group', rule => void (rule.group = 42)],
  ['blank model setting', rule => void (rule.settings = { model: '' })],
  ['whitespace-only model setting', rule => void (rule.settings = { model: '   ' })],
  ['newline-only model setting', rule => void (rule.settings = { model: '\t\n ' })],
  ['unknown backend setting', rule => void (rule.settings = { backend: 'other' })],
  ['threshold above range', rule => void (rule.settings = { threshold: 1.5 })],
  ['negative threshold', rule => void (rule.settings = { threshold: -0.1 })],
  ['negative infinity threshold', rule => void (rule.settings = { threshold: Number.NEGATIVE_INFINITY })],
  ['non-finite threshold', rule => void (rule.settings = { threshold: Number.NaN })],
  ['string threshold', rule => void (rule.settings = { threshold: '0.4' })],
  ['non-object settings', rule => void (rule.settings = 'none')],
];

test('validateRule rejects malformed rules even when they are disabled', () => {
  for (const [label, mutate] of malformed) {
    const rule = brandedRule();
    mutate(rule);
    expectThrows(label, () => validateRule(rule, RULE_FILE));
  }

  for (const [label, mutate] of malformed) {
    const rule = brandedRule({ enabled: false });
    mutate(rule);
    expectThrows(`disabled ${label}`, () => validateRule(rule, RULE_FILE));
  }
});

test('validateRule rejects missing pattern entries before hooks for enabled and disabled rules', () => {
  for (const field of ['files', 'exclude'] as const) {
    for (const enabled of [true, false]) {
      const inherited = new Array<string>(1);
      Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: '*.txt' }));
      const missingFirst = new Array<string>(2);
      missingFirst[1] = '*.txt';
      const missingLast = ['*.txt'];
      missingLast.length = 2;
      for (const patterns of [new Array<string>(1), missingFirst, missingLast, inherited]) {
        const calls: string[] = [];
        const rule = brandedRule({
          enabled,
          [field]: patterns,
          when: () => { calls.push('when'); return true; },
          select: () => { calls.push('select'); return []; },
          filter: () => { calls.push('filter'); return true; },
          check: () => { calls.push('check'); return pass(); },
        });
        assert.throws(
          () => validateRule(rule, RULE_FILE),
          field === 'files'
            ? /files must be a non-empty array of non-empty glob strings/
            : /exclude must be an array of non-empty glob strings/,
        );
        assert.deepEqual(calls, []);
      }
    }
  }
});

test('validateRule rejects non-object rules', () => {
  for (const value of [null, undefined, 42, 'rule', [], () => ({ status: 'pass' })]) {
    expectThrows(String(value), () => validateRule(value, RULE_FILE));
  }
});

test('validateRule checks hooks without executing them', () => {
  const calls: string[] = [];
  const rule: Record<string, unknown> = {
    enabled: true,
    files: ['**/*'],
    exclude: [],
    settings: {},
    group: 'scope',
    when: () => {
      calls.push('when');
      return true;
    },
    filter: () => {
      calls.push('filter');
      return true;
    },
    select: () => {
      calls.push('select');
      return [];
    },
    check: () => {
      calls.push('check');
      return { status: 'pass' };
    },
  };
  const branded = Object.setPrototypeOf(rule, brandedPrototype());

  assert.doesNotThrow(() => validateRule(branded, RULE_FILE));
  assert.deepStrictEqual(calls, []);
});

test('JSON data validation accepts plain and null-prototype records with own __proto__ keys', () => {
  const nullPrototype: Record<string, JsonValue> = Object.create(null);
  nullPrototype['name'] = 'x';
  nullPrototype['nested'] = [null, false, 0, '', { deep: true }];

  const ownProtoKey: Record<string, JsonValue> = { b: 2 };
  Object.defineProperty(ownProtoKey, '__proto__', {
    value: { injected: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });

  const accepted: readonly (readonly [string, JsonValue])[] = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
    ['empty array', []],
    ['empty record', {}],
    ['null-prototype record', nullPrototype],
    ['own __proto__ key', ownProtoKey],
    ['nested records and arrays', { a: [1, { b: null }] }],
  ];
  for (const [label, value] of accepted) {
    assert.doesNotThrow(() => validateJsonValue(value, 'data'), label);
  }

  assert.equal(Object.getPrototypeOf(nullPrototype), null);
  assert.equal(Object.getPrototypeOf(ownProtoKey), Object.prototype);
  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(ownProtoKey, '__proto__')?.value, {
    injected: true,
  });
});

test('JSON data validation rejects rich object instances at any depth', () => {
  class Thing {
    readonly kind = 'thing';
  }
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;

  const rejected: readonly (readonly [string, unknown])[] = [
    ['Date', new Date(0)],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['RegExp', /x/],
    ['class instance', new Thing()],
    ['nested Date', { at: new Date(0) }],
    ['Date inside an array', [new Date(0)]],
    ['Map inside a nested array', { rows: [new Map()] }],
    ['class instance inside a record', { value: new Thing() }],
    ['function', () => {}],
    ['undefined', undefined],
    ['bigint', 1n],
    ['symbol', Symbol('s')],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['nested negative infinity', { value: Number.NEGATIVE_INFINITY }],
    ['cycle', cyclic],
  ];
  for (const [label, value] of rejected) {
    expectThrows(label, () => validateJsonValue(value, 'data'));
  }
});

test('JSON data validation rejects hidden serialization hooks', () => {
  const hook = (): JsonValue => ({ changed: true });
  const enumerableArray = Object.assign([1], { toJSON: hook });
  const hiddenArray: number[] = [1];
  Object.defineProperty(hiddenArray, 'toJSON', { value: hook });
  const hiddenRecord: Record<string, JsonValue> = { a: 1 };
  Object.defineProperty(hiddenRecord, 'toJSON', { value: hook });
  const nested: Record<string, JsonValue> = { rows: enumerableArray as unknown as JsonValue };

  const rejected: readonly (readonly [string, unknown])[] = [
    ['enumerable array toJSON', enumerableArray],
    ['non-enumerable array toJSON', hiddenArray],
    ['non-enumerable record toJSON', hiddenRecord],
    ['nested array toJSON', nested],
  ];
  for (const [label, value] of rejected) {
    expectThrows(label, () => validateJsonValue(value, 'data'));
  }

  assert.doesNotThrow(() => validateJsonValue([1, { a: 2 }], 'data'));
  assert.doesNotThrow(() => validateJsonValue({ toJSONValue: 1 }, 'data'));
  expectThrows('scope data toJSON', () =>
    validateScopeMatch({ id: '$', source: '{}', data: enumerableArray }, 'scope'),
  );
});

test('scope validation applies the JSON boundary to scope data', () => {
  const nullPrototype: Record<string, JsonValue> = Object.create(null);
  nullPrototype['name'] = 'x';

  assert.doesNotThrow(() => validateScopeMatch({ id: '$', source: '{}' }, 'scope'));
  assert.doesNotThrow(() => validateScopeMatch({ id: '$', source: '{}', data: nullPrototype }, 'scope'));
  assert.doesNotThrow(() =>
    validateScopeMatch({ id: '$', source: '{}', data: { a: [1, null, false, 0, ''] } }, 'scope'),
  );

  const rejected: readonly (readonly [string, unknown])[] = [
    ['Date data', { id: '$', source: '{}', data: new Date(0) }],
    ['Map data', { id: '$', source: '{}', data: new Map([['a', 1]]) }],
    ['nested class data', { id: '$', source: '{}', data: { nested: new (class {})() } }],
    ['Date inside array data', { id: '$', source: '{}', data: [new Date(0)] }],
  ];
  for (const [label, value] of rejected) {
    expectThrows(label, () => validateScopeMatch(value, 'scope'));
  }
});

test('scope validation rejects sparse arrays in data and captures', () => {
  expectThrows('sparse data array', () =>
    validateScopeMatch({ id: '$', source: '{}', data: [1, , 2] }, 'scope'),
  );
  expectThrows('sparse nested data array', () =>
    validateScopeMatch({ id: '$', source: '{}', data: { a: new Array<number>(1) } }, 'scope'),
  );
  expectThrows('sparse captures array', () =>
    validateScopeMatch({ id: '$', source: '{}', captures: { name: new Array<string>(1) } }, 'scope'),
  );
  expectThrows('dense undefined capture', () =>
    validateScopeMatch({ id: '$', source: '{}', captures: { name: [undefined as unknown as string] } }, 'scope'),
  );

  assert.deepEqual(
    validateScopeMatch(
      { id: '$', source: '{}', data: [1, null, false, 0, ''], captures: { a: 'x', b: ['y'] } },
      'scope',
    ),
    { id: '$', source: '{}', data: [1, null, false, 0, ''], captures: { a: 'x', b: ['y'] } },
  );
});

test('scope match validation materializes declared plain fields', () => {
  class Captures {
    get name(): string {
      return 'x';
    }
  }
  class LineRange {
    get start(): number {
      return 2;
    }
    get end(): number {
      return 3;
    }
  }

  expectThrows('class captures container', () =>
    validateScopeMatch({ id: '$', source: '{}', captures: new Captures() }, 'scope'),
  );

  const accessorBacked = Object.defineProperties(
    {},
    {
      id: { get: () => 'a' },
      source: { get: () => 'body' },
      data: { get: () => [1, 2] },
    },
  );
  assert.deepEqual(validateScopeMatch(accessorBacked, 'scope'), { id: 'a', source: 'body', data: [1, 2] });

  assert.deepEqual(validateScopeMatch({ id: '$', source: '{}', extra: 'dropped' }, 'scope'), {
    id: '$',
    source: '{}',
  });

  const nullProtoCaptures = Object.create(null) as Record<string, string>;
  nullProtoCaptures['name'] = 'n';

  const match = validateScopeMatch(
    { id: 'k', source: 'src', captures: nullProtoCaptures, lines: new LineRange() },
    'scope',
  );
  assert.deepEqual(match.lines, { start: 2, end: 3 });
  assert.equal(Object.getPrototypeOf(match.lines), Object.prototype);
  assert.deepEqual(Object.keys(match).sort(), ['captures', 'id', 'lines', 'source']);
  assert.equal(Object.getPrototypeOf(match.captures), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(match)), {
    id: 'k',
    source: 'src',
    captures: { name: 'n' },
    lines: { start: 2, end: 3 },
  });
});

test('validateCheckResult rejects a blank model and preserves an empty message', () => {
  assert.doesNotThrow(() => validateCheckResult({ status: 'pass' }, 'check'));
  assert.doesNotThrow(() => validateCheckResult({ status: 'pass', message: '' }, 'check'));
  assert.doesNotThrow(() =>
    validateCheckResult({ status: 'violation', model: 'model-a', probability: 0.5 }, 'check'),
  );

  expectThrows('blank model', () => validateCheckResult({ status: 'pass', model: '' }, 'check'));
  expectThrows('whitespace-only model', () =>
    validateCheckResult({ status: 'pass', model: '  \t' }, 'check'),
  );
  expectThrows('non-string message', () =>
    validateCheckResult({ status: 'pass', message: 5 as unknown as string }, 'check'),
  );
  expectThrows('unknown status', () => validateCheckResult({ status: 'maybe' }, 'check'));
  expectThrows('non-object result', () => validateCheckResult('pass', 'check'));
});

test('ai validates its options eagerly', () => {
  assert.throws(() => ai({ rule: '' }));
  assert.throws(() => ai({ rule: 42 as unknown as string }));
  assert.throws(() => ai({ rule: 'r', examples: { good: [1 as unknown as string] } }));
  assert.throws(() => ai({ rule: 'r', examples: { good: 'x' as unknown as readonly string[] } }));
  assert.throws(() => ai({ rule: 'r', examples: { bad: [null as unknown as string] } }));
  assert.throws(() => ai({ rule: 'r', violationMessage: 5 as unknown as string }));
  assert.throws(() => ai({ rule: 'r', input: 'y' as unknown as NonNullable<AiOptions['input']> }));
});

function incompleteExampleLists(): readonly (readonly [string, readonly string[]])[] {
  const holeBefore = new Array<string>(2);
  holeBefore[1] = 'valid';
  const holeAfter = new Array<string>(2);
  holeAfter[0] = 'valid';
  const inherited = new Array<string>(1);
  Object.setPrototypeOf(inherited, ['inherited']);
  return [
    ['only a hole', new Array<string>(1)],
    ['hole before a valid string', holeBefore],
    ['hole after a valid string', holeAfter],
    ['inherited-only slot', inherited],
  ];
}

for (const kind of ['good', 'bad'] as const) {
  test(`ai eagerly rejects sparse and inherited-only ${kind} example slots`, () => {
    for (const [label, entries] of incompleteExampleLists()) {
      assert.throws(() => ai({ rule: 'r', examples: { [kind]: entries } }), label);
    }
  });

  test(`evaluateAi rejects sparse and inherited-only ${kind} examples before requesting a decision`, async () => {
    const backend = new RecordingBackend();
    const subject = scopeSubject({ filepath: 'a.txt', id: '$', source: 'visible' });
    for (const [label, entries] of incompleteExampleLists()) {
      await assert.rejects(
        evaluateAi(subject, { rule: 'r', examples: { [kind]: entries } }, projectContext(), runtimeFor(backend)),
        label,
      );
      assert.equal(backend.requests.length, 0, label);
    }
  });
}

test('the public ai evaluator forwards examples, a lazy input override, and the violation message', async () => {
  const backend = new RecordingBackend(0.1);
  const project = new MemoryProject();
  let inputCalls = 0;
  let sawSubject: Subject<JsonValue> | undefined;
  const evaluator = ai<JsonValue>({
    rule: 'Do the thing',
    examples: { good: ['a'] },
    violationMessage: 'Must do the thing',
    input: (inputSubject: Subject<JsonValue>, context: ProjectContext) => {
      inputCalls += 1;
      sawSubject = inputSubject;
      return { root: context.project.root };
    },
  });

  assert.equal(inputCalls, 0, 'the input callback must stay lazy until evaluation');

  const subject = scopeSubject({ filepath: 'a.json', id: '$', source: '{}', data: { a: 1 } });
  const context = new TestContext({ subject, runtime: runtimeFor(backend), project });
  const result = await evaluator(subject, context);

  assert.equal(inputCalls, 1);
  assert.strictEqual(sawSubject, subject);
  assert.equal(context.aiCalls, 1);
  assert.equal(result.status, 'violation');
  assert.equal(result.message, 'Must do the thing');
  assert.equal(result.probability, 0.1);
  assert.equal(result.model, 'test-model');
  assert.deepStrictEqual(requestAt(backend).state, { root: project.root });
  assert.deepStrictEqual(requestAt(backend).instructions, {
    rule: 'Do the thing',
    question: 'Is the rule respected?',
    examples: { good: ['a'], bad: [] },
  });
  assert.equal(JSON.stringify(requestAt(backend)).includes('Must do the thing'), false);
});

test('the ai evaluator runs through the bound context', async () => {
  const backend = new RecordingBackend(0.9);
  const subject = scopeSubject({ filepath: 'a.json', id: '$', source: '{}', data: { a: 1 } });
  const context = new TestContext({ subject, runtime: runtimeFor(backend) });

  const result = await ai({ rule: 'Do the thing' })(subject, context);

  assert.equal(result.status, 'pass');
  assert.equal(context.aiCalls, 1);
  assert.deepStrictEqual(requestAt(backend).state, { filepath: 'a.json', scope: { id: '$', data: { a: 1 } } });
  assert.deepStrictEqual(requestAt(backend).instructions, {
    rule: 'Do the thing',
    question: 'Is the rule respected?',
  });
});

test('default AI state keeps falsy data as data', async () => {
  const cases: readonly (readonly [string, JsonValue])[] = [
    ['null', null],
    ['false', false],
    ['0', 0],
    ['empty string', ''],
  ];

  for (const [label, data] of cases) {
    const backend = new RecordingBackend();
    const subject = scopeSubject({ filepath: 'a.json', id: '$', source: 'ignored', data });
    await evaluateAi(subject, { rule: 'r' }, projectContext(), runtimeFor(backend));
    assert.deepStrictEqual(requestAt(backend).state, { filepath: 'a.json', scope: { id: '$', data } }, label);
  }
});

test('default AI state uses source text when data is absent and never leaks internals', async () => {
  const backend = new RecordingBackend();
  const subject = scopeSubject({
    filepath: 'a.txt',
    id: 'scope-1',
    source: 'body text',
    lines: { start: 1, end: 2 },
  });

  await evaluateAi(subject, { rule: 'r' }, projectContext(), runtimeFor(backend));

  assert.deepStrictEqual(requestAt(backend).state, {
    filepath: 'a.txt',
    scope: { id: 'scope-1', source: 'body text' },
  });
});

test('default AI state projects captures alongside data', async () => {
  const backend = new RecordingBackend();
  const subject = scopeSubject({
    filepath: 'a.go',
    id: 'fn-1',
    source: 'func Foo() {}',
    data: { kind: 'function_declaration' },
    captures: { name: 'Foo' },
  });

  await evaluateAi(subject, { rule: 'r' }, projectContext(), runtimeFor(backend));

  assert.deepStrictEqual(requestAt(backend).state, {
    filepath: 'a.go',
    scope: { id: 'fn-1', data: { kind: 'function_declaration' }, captures: { name: 'Foo' } },
  });
});

test('default AI state projects groups by first file occurrence', async () => {
  const backend = new RecordingBackend();
  const subject = groupSubject([
    scopeSubject({ filepath: 'a/f1.json', id: '$', source: '1', data: 1 }),
    scopeSubject({ filepath: 'a/f2.json', id: '$', source: '2', data: 2 }),
    scopeSubject({ filepath: 'a/f1.json', id: '$.y', source: '3', data: 3 }),
  ]);

  await evaluateAi(subject, { rule: 'r' }, projectContext(), runtimeFor(backend));

  assert.deepStrictEqual(requestAt(backend).state, {
    files: [
      { filepath: 'a/f1.json', scopes: [{ id: '$', data: 1 }, { id: '$.y', data: 3 }] },
      { filepath: 'a/f2.json', scopes: [{ id: '$', data: 2 }] },
    ],
  });
});

test('an input callback replaces the projected state', async () => {
  const backend = new RecordingBackend();
  const project = new MemoryProject();
  let received: Subject<JsonValue> | undefined;
  const subject = scopeSubject({ filepath: 'a.json', id: '$', source: '{"a":1}', data: { a: 1 } });

  const result = await evaluateAi(
    subject,
    {
      rule: 'r',
      input: (inputSubject: Subject<JsonValue>, context: ProjectContext) => {
        received = inputSubject;
        return { custom: context.project.root };
      },
    },
    { project, ruleName: 'r', trace: () => {} },
    runtimeFor(backend),
  );

  assert.strictEqual(received, subject);
  assert.equal(result.status, 'pass');
  assert.deepStrictEqual(requestAt(backend).state, { custom: project.root });
});

test('an input callback result is validated and its failures propagate', async () => {
  const backend = new RecordingBackend();
  const context = projectContext();
  const runtime = runtimeFor(backend);
  const subject = scopeSubject({ filepath: 'a.json', id: '$', source: '{}' });

  await assert.rejects(
    evaluateAi(
      subject,
      {
        rule: 'r',
        input: () => {
          throw new Error('input boom');
        },
      },
      context,
      runtime,
    ),
  );
  await assert.rejects(
    evaluateAi(subject, { rule: 'r', input: () => (() => {}) as unknown as JsonValue }, context, runtime),
  );

  const cyclic: Record<string, JsonValue> = {};
  cyclic.self = cyclic;
  const nonJsonInputs: readonly (readonly [string, () => JsonValue])[] = [
    ['NaN', () => Number.NaN],
    ['positive infinity', () => Number.POSITIVE_INFINITY],
    ['nested negative infinity', () => ({ value: Number.NEGATIVE_INFINITY })],
    ['cycle', () => cyclic],
    ['Date instance', () => new Date(0) as unknown as JsonValue],
    ['Map instance', () => new Map([['a', 1]]) as unknown as JsonValue],
    ['nested class instance', () => ({ nested: new (class {})() }) as unknown as JsonValue],
    ['Date inside an array', () => [new Date(0)] as unknown as JsonValue],
  ];
  for (const [label, input] of nonJsonInputs) {
    await assert.rejects(evaluateAi(subject, { rule: 'r', input }, context, runtime), label);
  }

  assert.equal(backend.requests.length, 0);
});

test('an input callback accepts plain and null-prototype JSON records', async () => {
  const backend = new RecordingBackend(0.1);
  const context = projectContext();
  const runtime = runtimeFor(backend);
  const subject = scopeSubject({ filepath: 'a.json', id: '$', source: '{}' });

  const nullPrototype: Record<string, JsonValue> = Object.create(null);
  nullPrototype['name'] = 'x';
  const ownProtoKey: Record<string, JsonValue> = { b: 2 };
  Object.defineProperty(ownProtoKey, '__proto__', {
    value: 'kept',
    enumerable: true,
    configurable: true,
    writable: true,
  });

  await evaluateAi(subject, { rule: 'r', input: () => nullPrototype }, context, runtime);
  await evaluateAi(subject, { rule: 'r', input: () => ownProtoKey }, context, runtime);

  assert.equal(backend.requests.length, 2);
});

test('AI decisions compare the probability strictly against the threshold', async () => {
  const cases: readonly (readonly [number, 'pass' | 'violation'])[] = [
    [0.4, 'violation'],
    [0.41, 'pass'],
    [0.39, 'violation'],
    [1, 'pass'],
    [0, 'violation'],
  ];

  for (const [probability, status] of cases) {
    const backend = new RecordingBackend(probability);
    const subject = scopeSubject({ filepath: 'a', id: '$', source: 's' });
    const result = await evaluateAi(subject, { rule: 'r' }, projectContext(), runtimeFor(backend, 0.4));

    assert.equal(result.status, status, String(probability));
    assert.equal(result.probability, probability);
    assert.equal(result.model, 'test-model');
  }
});

test('AI instructions carry the rule, question, and normalized examples', async () => {
  const subject = scopeSubject({ filepath: 'a', id: '$', source: 's' });

  const withoutExamples = new RecordingBackend();
  await evaluateAi(subject, { rule: 'Do the thing' }, projectContext(), runtimeFor(withoutExamples));
  assert.deepStrictEqual(requestAt(withoutExamples).instructions, {
    rule: 'Do the thing',
    question: 'Is the rule respected?',
  });

  const emptyExamples = new RecordingBackend();
  await evaluateAi(
    subject,
    { rule: 'r', examples: { good: [], bad: [] } },
    projectContext(),
    runtimeFor(emptyExamples),
  );
  assert.deepStrictEqual(requestAt(emptyExamples).instructions, {
    rule: 'r',
    question: 'Is the rule respected?',
  });

  const partialExamples = new RecordingBackend();
  await evaluateAi(subject, { rule: 'r', examples: { good: ['a'] } }, projectContext(), runtimeFor(partialExamples));
  assert.deepStrictEqual(requestAt(partialExamples).instructions, {
    rule: 'r',
    question: 'Is the rule respected?',
    examples: { good: ['a'], bad: [] },
  });
});

test('AI violations carry the fallback or supplied message without leaking it upstream', async () => {
  const subject = scopeSubject({ filepath: 'a', id: '$', source: 's' });

  const fallback = new RecordingBackend(0.1);
  const fallbackResult = await evaluateAi(
    subject,
    { rule: 'r' },
    projectContext('infra-placement'),
    runtimeFor(fallback),
  );
  assert.equal(fallbackResult.status, 'violation');
  assert.equal(fallbackResult.message, 'Rule "infra-placement" was violated');

  const custom = new RecordingBackend(0.1);
  const customResult = await evaluateAi(
    subject,
    { rule: 'r', violationMessage: 'This belongs outside infrastructure' },
    projectContext('infra-placement'),
    runtimeFor(custom),
  );
  assert.equal(customResult.message, 'This belongs outside infrastructure');
  assert.equal(JSON.stringify(requestAt(custom)).includes('This belongs outside infrastructure'), false);
});

test('evaluateAi delivers backend exchanges to the caller observer', async () => {
  const exchanges: unknown[] = [];
  const observer: DecisionObserver = exchange => {
    exchanges.push(exchange);
  };
  const backend: DecisionBackend = {
    async decide(_request, backendObserver): Promise<{ probability: number; model: string }> {
      backendObserver?.({ type: 'request', body: '{"model":"test-model"}' });
      backendObserver?.({ type: 'response', status: 200, body: '{"probability":1,"model":"test-model"}' });
      return { probability: 1, model: 'test-model' };
    },
  };
  const subject = scopeSubject({ filepath: 'a', id: '$', source: 's' });

  const result = await evaluateAi(subject, { rule: 'r' }, projectContext(), runtimeFor(backend), observer);

  assert.equal(result.status, 'pass');
  assert.deepStrictEqual(exchanges, [
    { type: 'request', body: '{"model":"test-model"}' },
    { type: 'response', status: 200, body: '{"probability":1,"model":"test-model"}' },
  ]);
});

test('regex validates its options eagerly', () => {
  type RegexInput = (subject: ScopeSubject<JsonValue>, context: ProjectContext) => string;

  assert.throws(() => regex({ pattern: 'x' as unknown as RegExp }));
  assert.throws(() => regex({ pattern: /x/, violationMessage: 5 as unknown as string }));
  assert.throws(() => regex({ pattern: /x/, input: 'y' as unknown as RegexInput }));
});

test('regex reads scalar and null data as strings', async () => {
  const cases: readonly (readonly [JsonValue, RegExp])[] = [
    [42, /^42$/],
    [true, /^true$/],
    [false, /^false$/],
    [null, /^null$/],
    ['text', /^text$/],
  ];

  for (const [data, pattern] of cases) {
    const context = new TestContext();
    const subject = scopeSubject({ filepath: 'a', id: '$', source: 'source-text', data });
    assert.deepStrictEqual(await regex({ pattern })(subject, context), { status: 'pass' }, String(data));
  }
});

test('regex reads source text when data is absent or structured', async () => {
  const cases: readonly (readonly [JsonValue | undefined, RegExp])[] = [
    [undefined, /^source-text$/],
    [{ a: 1 }, /^source-text$/],
    [[1, 2], /^source-text$/],
  ];

  for (const [data, pattern] of cases) {
    const context = new TestContext();
    const subject =
      data === undefined
        ? scopeSubject({ filepath: 'a', id: '$', source: 'source-text' })
        : scopeSubject({ filepath: 'a', id: '$', source: 'source-text', data });
    assert.deepStrictEqual(await regex({ pattern })(subject, context), { status: 'pass' });
  }
});

test('regex requires every group member to match and traces members after a mismatch', async () => {
  const evaluator = regex({ pattern: /^ok$/ });

  const passingContext = new TestContext();
  const passing = groupSubject([
    scopeSubject({ filepath: 'a.json', id: '$', source: 'ignored', data: 'ok' }),
    scopeSubject({ filepath: 'b.json', id: '$', source: 'ok' }),
  ]);
  assert.deepStrictEqual(await evaluator(passing, passingContext), { status: 'pass' });

  const failingContext = new TestContext();
  const failing = groupSubject([
    scopeSubject({ filepath: 'a.json', id: '$', source: 'nope' }),
    scopeSubject({ filepath: 'b.json', id: '$', source: 'ignored', data: 'ok' }),
  ]);
  assert.deepStrictEqual(await evaluator(failing, failingContext), {
    status: 'violation',
    message: 'Rule "contract-rule" was violated',
  });
  assert.deepStrictEqual(failingContext.traces, [
    {
      message: 'regex',
      details: {
        pattern: '^ok$',
        flags: '',
        evaluations: [
          { filepath: 'a.json', scopeId: '$', input: 'nope', matched: false },
          { filepath: 'b.json', scopeId: '$', input: 'ok', matched: true },
        ],
      },
    },
  ]);
});

test('regex repeats global and sticky patterns deterministically', async () => {
  for (const pattern of [/a/g, /a/y]) {
    const context = new TestContext();
    const evaluator = regex({ pattern });
    const subject = scopeSubject({ filepath: 'a', id: '$', source: 'a' });

    assert.deepStrictEqual(await evaluator(subject, context), { status: 'pass' }, String(pattern));
    assert.deepStrictEqual(await evaluator(subject, context), { status: 'pass' }, String(pattern));
  }
});

test('regex does not share state with the caller pattern', async () => {
  const pattern = /a/g;
  const evaluator = regex({ pattern });
  pattern.lastIndex = 7;

  const outcome = await evaluator(scopeSubject({ filepath: 'a', id: '$', source: 'a' }), new TestContext());

  assert.deepStrictEqual(outcome, { status: 'pass' });
  assert.equal(pattern.lastIndex, 7);
});

test('regex traces the evaluated inputs and results', async () => {
  const context = new TestContext();
  const subject = scopeSubject({ filepath: 'a.yaml', id: '0:$.x', source: 'x: a', data: 'a' });

  const result = await regex({ pattern: /b/ })(subject, context);

  assert.deepStrictEqual(result, { status: 'violation', message: 'Rule "contract-rule" was violated' });
  assert.deepStrictEqual(context.traces, [
    {
      message: 'regex',
      details: {
        pattern: 'b',
        flags: '',
        evaluations: [{ filepath: 'a.yaml', scopeId: '0:$.x', input: 'a', matched: false }],
      },
    },
  ]);
});

test('regex honours an asynchronous input override per group member and a custom violation message', async () => {
  const context = new TestContext();
  const first = scopeSubject({ filepath: 'a.json', id: '$.a', source: 'ignored-a', data: { kind: 'x' } });
  const second = scopeSubject({ filepath: 'b.json', id: '$.b', source: 'ignored-b', data: { kind: 'y' } });

  const evaluator = regex({
    pattern: /^x$/,
    input: async subject => (subject.filepath === 'a.json' ? 'x' : 'y'),
  });

  assert.deepStrictEqual(await evaluator(first, context), { status: 'pass' });
  assert.deepStrictEqual(await evaluator(groupSubject([first, second]), context), {
    status: 'violation',
    message: 'Rule "contract-rule" was violated',
  });
  assert.deepStrictEqual(context.traces, [
    {
      message: 'regex',
      details: {
        pattern: '^x$',
        flags: '',
        evaluations: [{ filepath: 'a.json', scopeId: '$.a', input: 'x', matched: true }],
      },
    },
    {
      message: 'regex',
      details: {
        pattern: '^x$',
        flags: '',
        evaluations: [
          { filepath: 'a.json', scopeId: '$.a', input: 'x', matched: true },
          { filepath: 'b.json', scopeId: '$.b', input: 'y', matched: false },
        ],
      },
    },
  ]);

  const violated = await regex({ pattern: /^z$/, violationMessage: 'Not x' })(first, context);
  assert.deepStrictEqual(violated, { status: 'violation', message: 'Not x' });
});

test('regex never contacts the decision backend', async () => {
  const context = new TestContext();
  const subject = scopeSubject({ filepath: 'a', id: '$', source: 'match' });

  await regex({ pattern: /match/ })(subject, context);

  assert.equal(context.aiCalls, 0);
});

test('pass and violation build check results', () => {
  assert.deepStrictEqual(pass(), { status: 'pass' });
  assert.deepStrictEqual(violation('nope'), { status: 'violation', message: 'nope' });
});
