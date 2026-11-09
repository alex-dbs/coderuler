import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Rule, ai, scopes, violation as ruleViolation } from '../dist/index.js';
import { applySuppressions, parseSuppressionConfig } from '../dist/app/suppressions.js';
import type {
  CheckResult,
  DecisionBackend,
  DecisionOutcome,
  DecisionRuntime,
  Evaluator,
  GroupSubject,
  Project,
  RuleReport,
  RunContext,
  RunEvent,
  ScopeSelector,
  ScopeSubject,
  Subject,
} from '../dist/index.js';
import { executeRules } from '../dist/app/execute.js';
import { createProject } from '../dist/adapter/filesystem/project.js';
import { createSandbox, makeDirectory, makeSymlink, runCli, writeFile } from './support.ts';

const sandbox = createSandbox('coderuler-suppressions-');
after(() => sandbox.cleanup());

function scope(id: string, filepath = 'src/legacy.js', lines?: { readonly start: number; readonly end: number }): ScopeSubject {
  return {
    kind: 'scope',
    id,
    filepath,
    source: 'legacy source',
    ...(lines === undefined ? {} : { lines }),
  };
}

function group(members: readonly ScopeSubject[]): GroupSubject {
  return { kind: 'group', group: { type: 'project', path: '.' }, members };
}

function violation(locations?: CheckResult['locations']): CheckResult {
  return { status: 'violation', message: 'Policy failed', ...(locations === undefined ? {} : { locations }) };
}
class LocalRule extends Rule {
  check: Evaluator;

  constructor(check: Evaluator) {
    super();
    this.check = check;
  }
}

function runContext(project: Project, events: RunEvent[], runtime?: DecisionRuntime): RunContext {
  return {
    project,
    isTarget: () => true,
    concurrency: 2,
    resolveDecision: () => {
      if (runtime === undefined) throw new Error('Unexpected AI decision');
      return runtime;
    },
    emit: event => events.push(event),
  };
}

async function runRule(
  project: Project,
  name: string,
  rule: LocalRule,
  runtime?: DecisionRuntime,
): Promise<{ readonly report: RuleReport; readonly events: readonly RunEvent[] }> {
  const events: RunEvent[] = [];
  const reports = await executeRules([{
    name,
    ruleFile: `.coderuler/${name}.rule.ts`,
    rule: rule as Rule<unknown>,
  }], runContext(project, events, runtime));
  assert.equal(reports.length, 1);
  return { report: reports[0]!, events };
}

test('suppression configuration requires exact rule names and narrow entries', () => {
  const config = parseSuppressionConfig({
    suppressions: {
      'field-naming': [
        { files: ['api/**'], scope: ' legacy_id ', reason: 'Existing contract' },
        { files: ['generated/**'], reason: 'Generated source' },
      ],
      },
    });
  assert.equal(config.get('field-naming')?.[0]?.scope, ' legacy_id ');
  assert.deepEqual(parseSuppressionConfig({ suppressions: {} }).size, 0);
  assert.deepEqual(parseSuppressionConfig({ suppressions: { rule: [] } }).get('rule'), []);

  for (const [value, message] of [
    [{}, 'field "suppressions"'],
    [{ suppressions: [], extra: true }, 'field "extra"'],
    [{ suppressions: { ' ': [] } }, 'rule name'],
    [{ suppressions: { rule: {} } }, 'rule "rule"'],
    [{ suppressions: { rule: [{ files: [], reason: 'accepted' }] } }, 'entry 1 field "files"'],
    [{ suppressions: { rule: [{ files: ['src/**'], scope: 'x', lines: { start: 1, end: 1 }, reason: 'accepted' }] } }, 'both "scope" and "lines"'],
    [{ suppressions: { rule: [{ files: ['src/**'], reason: ' ' }] } }, 'field "reason"'],
    [{ suppressions: { rule: [{ files: ['src/**'], lines: { start: 3, end: 2 }, reason: 'accepted' }] } }, 'start <= end'],
    [{ suppressions: { rule: [{ files: ['src/**'], lines: { start: 1, end: 2, extra: 3 }, reason: 'accepted' }] } }, 'field "lines" field "extra"'],
  ] as const) {
    assert.throws(() => parseSuppressionConfig(value), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const sparseEntries: unknown[] = [];
  sparseEntries.length = 1;
  assert.throws(
    () => parseSuppressionConfig({ suppressions: { policy: sparseEntries } }),
    /rule "policy" entry 1 must be a mapping/,
  );
});

test('line suppression requires full inclusive containment and keeps the first reason', () => {
  const config = parseSuppressionConfig({
    suppressions: {
      policy: [
        { files: ['src/**'], lines: { start: 42, end: 45 }, reason: 'First exception' },
        { files: ['src/legacy.js'], lines: { start: 40, end: 50 }, reason: 'Later exception' },
      ],
    },
  });
  const subject = scope('legacy', 'src/legacy.js', { start: 40, end: 50 });
  const covered = applySuppressions(config, 'policy', subject, violation([
    { filepath: 'src/legacy.js', lines: { start: 42, end: 45 } },
  ]));
  assert.equal(covered.status, 'suppressed');
  assert.deepEqual(covered.suppressedLocations, [{
    location: { filepath: 'src/legacy.js', lines: { start: 42, end: 45 } },
    reason: 'First exception',
  }]);

  const overlapping = violation([{ filepath: 'src/legacy.js', lines: { start: 39, end: 43 } }]);
  assert.equal(applySuppressions(config, 'policy', subject, overlapping), overlapping);
  const uncoveredEnd = violation([{ filepath: 'src/legacy.js', lines: { start: 42, end: 51 } }]);
  assert.equal(applySuppressions(config, 'policy', subject, uncoveredEnd), uncoveredEnd);
  const missingLines = violation([{ filepath: 'src/legacy.js', scopeId: 'legacy' }]);
  assert.equal(applySuppressions(config, 'policy', subject, missingLines), missingLines);
});

test('scope suppression resolves line-only locations without guessing group members', () => {
  const config = parseSuppressionConfig({
    suppressions: { policy: [{ files: ['src/**'], scope: 'legacy', reason: 'Named exception' }] },
  });
  const location = { filepath: 'src/legacy.js', lines: { start: 2, end: 2 } };
  const singleSubject = scope('legacy', 'src/legacy.js', { start: 1, end: 3 });
  assert.equal(applySuppressions(config, 'policy', singleSubject, violation([location])).status, 'suppressed');

  const selectedGroup = group([
    scope('legacy', 'src/legacy.js', { start: 1, end: 3 }),
    scope('other', 'src/legacy.js', { start: 4, end: 6 }),
  ]);
  assert.equal(applySuppressions(config, 'policy', selectedGroup, violation([location])).status, 'suppressed');
  const unrelatedGroup = group([scope('other', 'src/legacy.js', { start: 4, end: 6 })]);
  assert.equal(applySuppressions(config, 'policy', unrelatedGroup, violation([location])).status, 'violation');

  const unboundedGroup = group([scope('legacy')]);
  const unboundedResult = violation([location]);
  assert.equal(applySuppressions(config, 'policy', unboundedGroup, unboundedResult), unboundedResult);
});

test('unattributed group failures suppress only when every evaluated member is covered', () => {
  const members = [
    scope('first', 'src/first.js', { start: 1, end: 2 }),
    scope('second', 'src/second.js', { start: 3, end: 4 }),
  ];
  const subject: Subject = group(members);
  const original = violation([]);
  const partial = parseSuppressionConfig({
    suppressions: { policy: [{ files: ['src/first.js'], reason: 'Accepted first member' }] },
  });
  assert.equal(applySuppressions(partial, 'policy', subject, original), original);
  const omitted = violation();
  assert.equal(applySuppressions(partial, 'policy', subject, omitted), omitted);

  const complete = parseSuppressionConfig({
    suppressions: {
      policy: [
        { files: ['src/first.js'], reason: 'Accepted first member' },
        { files: ['src/second.js'], reason: 'Accepted second member' },
      ],
    },
  });
  const suppressed = applySuppressions(complete, 'policy', subject, original);
  const fullyCoveredOmitted = applySuppressions(complete, 'policy', subject, omitted);
  assert.equal(fullyCoveredOmitted.status, 'suppressed');
  assert.equal('locations' in fullyCoveredOmitted, false);
  assert.equal(suppressed.status, 'suppressed');
  assert.equal('locations' in suppressed, false);
  assert.deepEqual(suppressed.suppressedLocations?.map(({ location, reason }) => [location.scopeId, reason]), [
    ['first', 'Accepted first member'],
    ['second', 'Accepted second member'],
  ]);
});

test('explicit group locations are suppressed independently and preserve active order', () => {
  const subject = group([
    scope('first', 'src/first.js', { start: 1, end: 2 }),
    scope('second', 'src/second.js', { start: 3, end: 4 }),
  ]);
  const first = { filepath: 'src/first.js', scopeId: 'first', lines: { start: 1, end: 2 } };
  const second = { filepath: 'src/second.js', scopeId: 'second', lines: { start: 3, end: 4 } };
  const result = violation([first, second]);
  const partial = parseSuppressionConfig({
    suppressions: { policy: [{ files: ['src/first.js'], scope: 'first', reason: 'Accepted first' }] },
  });
  const partiallySuppressed = applySuppressions(partial, 'policy', subject, result);
  assert.equal(partiallySuppressed.status, 'violation');
  assert.deepEqual(partiallySuppressed.locations, [second]);
  assert.deepEqual(partiallySuppressed.suppressedLocations, [{ location: first, reason: 'Accepted first' }]);

  const complete = parseSuppressionConfig({
    suppressions: {
      policy: [
        { files: ['src/first.js'], scope: 'first', reason: 'Accepted first' },
        { files: ['src/second.js'], scope: 'second', reason: 'Accepted second' },
      ],
    },
  });
  const fullySuppressed = applySuppressions(complete, 'policy', subject, result);
  assert.equal(fullySuppressed.status, 'suppressed');
  assert.equal('locations' in fullySuppressed, false);
  assert.deepEqual(fullySuppressed.suppressedLocations?.map(({ location }) => location), [first, second]);
});

test('filesystem configuration is optional, empty, and reloaded for each execution', async () => {
  const { cwd } = sandbox.isolated('reload');
  const project = createProject(cwd);
  const absent = await project.readSuppressions();
  assert.equal(absent.size, 0);
  assert.notEqual(await project.readSuppressions(), absent);
  makeDirectory(join(cwd, '.coderuler'));
  assert.equal((await project.readSuppressions()).size, 0);

  const path = join(cwd, '.coderuler', 'suppressions.yml');
  writeFile(path, '# no active rules\n');
  assert.equal((await project.readSuppressions()).size, 0);

  writeFile(path, 'suppressions:\n  policy:\n    - files: [\"src/**\"]\n      reason: First\n');
  assert.equal((await project.readSuppressions()).get('policy')?.[0]?.reason, 'First');
  writeFile(path, 'suppressions:\n  policy:\n    - files: [\"src/**\"]\n      reason: Changed\n');
  assert.equal((await project.readSuppressions()).get('policy')?.[0]?.reason, 'Changed');
});

test('filesystem configuration reports malformed YAML, documents, and entries', async () => {
  const { cwd } = sandbox.isolated('invalid-config');
  const project = createProject(cwd);
  const path = join(cwd, '.coderuler', 'suppressions.yml');

  for (const [source, message] of [
    ['null\n', /suppression configuration must be a mapping/],
    ['suppressions: {}\n---\nsuppressions: {}\n', /exactly one nonempty YAML document/],
    ['suppressions:\n  policy: []\n  policy: []\n', /YAML source could not be parsed/],
    ['suppressions:\n  policy:\n    - files: [\"src/**\"]\n      scope: x\n      lines: { start: 1, end: 2 }\n      reason: invalid\n', /rule \"policy\" entry 1 must not define both/],
    ['suppressions:\n  policy:\n    - files: ["src/**"]\n      lines: { start: 0, end: 2 }\n      reason: invalid range\n', /rule "policy" entry 1 field "lines.start"/],
    ['suppressions:\n  policy:\n    - files: [\"src/**\"]\n      reason: \" \"\n', /rule \"policy\" entry 1 field \"reason\"/],
  ] as const) {
    writeFile(path, source);
    await assert.rejects(project.readSuppressions(), error => {
      assert.ok((error as Error).message.startsWith('.coderuler/suppressions.yml:'));
      assert.match((error as Error).message, message);
      return true;
    });
  }
});

test('filesystem loader rejects symlinks and nonregular configuration paths', async () => {
  const symlinkedFile = sandbox.isolated('symlink-file');
  const filePath = join(symlinkedFile.cwd, '.coderuler', 'suppressions.yml');
  writeFile(join(symlinkedFile.cwd, 'outside.yml'), 'suppressions: {}\n');
  makeSymlink(filePath, join(symlinkedFile.cwd, 'outside.yml'));
  await assert.rejects(createProject(symlinkedFile.cwd).readSuppressions(), error =>
    (error as Error).message.startsWith('.coderuler/suppressions.yml:'));

  const nonregularFile = sandbox.isolated('nonregular-file');
  makeDirectory(join(nonregularFile.cwd, '.coderuler', 'suppressions.yml'));
  await assert.rejects(createProject(nonregularFile.cwd).readSuppressions(), error =>
    (error as Error).message.startsWith('.coderuler/suppressions.yml:'));

  const symlinkedDirectory = sandbox.isolated('symlink-directory');
  writeFile(join(symlinkedDirectory.cwd, 'outside', 'suppressions.yml'), 'suppressions: {}\n');
  makeSymlink(join(symlinkedDirectory.cwd, '.coderuler'), join(symlinkedDirectory.cwd, 'outside'));
  await assert.rejects(createProject(symlinkedDirectory.cwd).readSuppressions(), error =>
    (error as Error).message.startsWith('.coderuler/suppressions.yml:'));
});

test('CLI applies line suppressions without hiding unrelated violations', async () => {
  const target = sandbox.isolated('cli');
  writeFile(join(target.cwd, '.coderuler', 'no-console.rule.ts'), `import { Rule, violation } from '@alex-dbs/coderuler';
export default class NoConsole extends Rule {
  files = ['src/legacy.js'];
  check = subject => violation('Legacy console use', [
    { filepath: subject.filepath, lines: { start: 1, end: 1 } },
  ]);
}
`);
  writeFile(join(target.cwd, 'src', 'legacy.js'), "console.log('legacy');\n");

  const initial = await runCli(['check', '--json'], target);
  assert.equal(initial.status, 1, initial.stderr || initial.stdout);
  assert.equal(JSON.parse(initial.stdout).reports.length, 1);

  const path = join(target.cwd, '.coderuler', 'suppressions.yml');
  writeFile(path, 'suppressions:\n  no-console:\n    - files: ["src/legacy.js"]\n      lines: { start: 1, end: 1 }\n      reason: Accepted legacy diagnostic\n');
  const suppressed = await runCli(['check', '--json'], target);
  assert.equal(suppressed.status, 0, suppressed.stderr || suppressed.stdout);
  assert.deepEqual(JSON.parse(suppressed.stdout).reports, []);

  const outputAll = await runCli(['check', '--json', '--output-all'], target);
  assert.equal(outputAll.status, 0, outputAll.stderr || outputAll.stdout);
  const allReports = JSON.parse(outputAll.stdout).reports;
  const result = allReports[0].evaluations[0].result;
  assert.equal(result.status, 'suppressed');
  assert.equal(result.message, 'Legacy console use');
  assert.equal(result.suppressedLocations[0].reason, 'Accepted legacy diagnostic');

  const textOutput = await runCli(['check', '--output-all'], target);
  assert.equal(textOutput.status, 0, textOutput.stderr || textOutput.stdout);
  assert.ok(textOutput.stdout.includes('[suppressed] no-console'), textOutput.stdout);
  assert.ok(textOutput.stdout.includes('Accepted legacy diagnostic'), textOutput.stdout);

  writeFile(path, 'suppressions:\n  no-console:\n    - files: ["src/legacy.js"]\n      lines: { start: 2, end: 2 }\n      reason: Wrong line\n');
  const uncovered = await runCli(['check', '--json'], target);
  assert.equal(uncovered.status, 1, uncovered.stderr || uncovered.stdout);

  writeFile(join(target.cwd, '.coderuler', 'other-policy.rule.ts'), `import { Rule, violation } from '@alex-dbs/coderuler';
export default class OtherPolicy extends Rule {
  files = ['src/legacy.js'];
  check = subject => violation('Other policy failure', [
    { filepath: subject.filepath, lines: { start: 1, end: 1 } },
  ]);
}
`);
  writeFile(path, 'suppressions:\n  no-console:\n    - files: ["src/legacy.js"]\n      lines: { start: 1, end: 1 }\n      reason: Accepted legacy diagnostic\n');
  const unrelated = await runCli(['check', '--json'], target);
  assert.equal(unrelated.status, 1, unrelated.stderr || unrelated.stdout);
  assert.deepEqual(JSON.parse(unrelated.stdout).reports.map((report: { name: string }) => report.name), ['other-policy']);

  const mixedText = await runCli(['check', '--output-all'], target);
  assert.equal(mixedText.status, 1, mixedText.stderr || mixedText.stdout);
  assert.ok(mixedText.stdout.includes('[suppressed] no-console'), mixedText.stdout);
  assert.ok(mixedText.stdout.includes('other-policy:'), mixedText.stdout);
  assert.ok(mixedText.stdout.includes('Other policy failure'), mixedText.stdout);
});

test('file and line selectors match text files without format-specific parsing', () => {
  const config = parseSuppressionConfig({
    suppressions: { policy: [{ files: ['src/**'], lines: { start: 1, end: 1 }, reason: 'Accepted text' }] },
  });
  for (const filepath of ['src/legacy.js', 'src/Legacy.cs', 'src/data.json', 'src/api.proto', 'src/order.avsc']) {
    const subject = scope('$', filepath, { start: 1, end: 2 });
    const result = violation([{ filepath, lines: { start: 1, end: 1 } }]);
    assert.equal(applySuppressions(config, 'policy', subject, result).status, 'suppressed', filepath);
  }
});

test('empty scope locations still require full evaluated-scope coverage', () => {
  const subject = scope('named-scope', 'src/legacy.js', { start: 1, end: 3 });
  const result = violation([]);
  const unrelated = parseSuppressionConfig({
    suppressions: { policy: [{ files: ['src/other.js'], reason: 'Not this file' }] },
  });
  assert.equal(applySuppressions(unrelated, 'policy', subject, result), result);

  const covered = parseSuppressionConfig({
    suppressions: { policy: [{ files: ['src/legacy.js'], reason: 'Whole scope accepted' }] },
  });
  const suppressed = applySuppressions(covered, 'policy', subject, result);
  assert.equal(suppressed.status, 'suppressed');
  assert.deepEqual(suppressed.suppressedLocations, [{
    location: { filepath: 'src/legacy.js', scopeId: 'named-scope', lines: { start: 1, end: 3 } },
    reason: 'Whole scope accepted',
  }]);
});

test('execution uses fresh project suppressions before events and report aggregation', async () => {
  const { cwd } = sandbox.isolated('direct-engine');
  writeFile(join(cwd, 'src', 'legacy.js'), 'console.log(1);\n');
  const configPath = join(cwd, '.coderuler', 'suppressions.yml');
  writeFile(configPath, 'suppressions:\n  custom-policy:\n    - files: ["src/legacy.js"]\n      scope: named\n      reason: Accepted by engine\n');

  const rule = new LocalRule(subject => {
    if (subject.kind !== 'scope') throw new Error('expected a scope');
    return ruleViolation('Custom selector finding', [{ filepath: subject.filepath, scopeId: subject.id }]);
  });
  rule.files = ['src/legacy.js'];
  const customScope: ScopeSelector = () => [{
    id: 'named',
    source: 'console.log(1);',
    lines: { start: 1, end: 1 },
  }];
  let selectionCalls = 0;
  rule.select = context => {
    selectionCalls += 1;
    return context.select({ files: ['src/legacy.js'], scope: customScope });
  };

  const project = createProject(cwd);
  const first = await runRule(project, 'custom-policy', rule);
  assert.equal(first.report.status, 'pass');
  assert.equal(first.report.evaluations[0]?.result.status, 'suppressed');
  const resultEvent = first.events.find(event => event.type === 'result');
  assert.ok(resultEvent?.type === 'result');
  assert.equal(resultEvent.result.status, 'suppressed');

  writeFile(configPath, 'suppressions:\n  custom-policy:\n    - files: ["src/legacy.js"]\n      scope: other\n      reason: Different selector\n');
  const second = await runRule(project, 'custom-policy', rule);
  assert.equal(second.report.status, 'violation');
  assert.equal(second.report.evaluations[0]?.result.status, 'violation');
  assert.equal(selectionCalls, 2);
});

test('execution loads suppressions once even for no rules and before any rule hooks', async () => {
  const { cwd } = sandbox.isolated('empty-engine');
  const base = createProject(cwd);
  const readSuppressions = base.readSuppressions.bind(base);
  let loads = 0;
  const project: Project = {
    ...base,
    readSuppressions: async () => {
      loads += 1;
      return readSuppressions();
    },
  };
  const events: RunEvent[] = [];
  assert.deepEqual(await executeRules([], runContext(project, events)), []);
  assert.equal(loads, 1);

  writeFile(join(cwd, '.coderuler', 'suppressions.yml'), 'not-suppressions: true\n');
  const failingProject = createProject(cwd);
  const rule = new LocalRule(() => ruleViolation('Must not run'));
  let hookCalls = 0;
  rule.when = () => {
    hookCalls += 1;
    return true;
  };
  const failureEvents: RunEvent[] = [];
  await assert.rejects(executeRules([{
    name: 'policy',
    ruleFile: '.coderuler/policy.rule.ts',
    rule: rule as Rule<unknown>,
  }], runContext(failingProject, failureEvents)), /\.coderuler\/suppressions\.yml/);
  assert.equal(hookCalls, 0);
  assert.equal(failureEvents.some(event => event.type === 'rule'), false);
  assert.equal(failureEvents.find(event => event.type === 'error')?.stage, 'suppression');
});

test('suppression cannot hide a throwing check or a rule-authored suppressed status', async () => {
  const { cwd } = sandbox.isolated('invalid-check');
  writeFile(join(cwd, 'src', 'legacy.js'), 'legacy\n');
  writeFile(join(cwd, '.coderuler', 'suppressions.yml'), 'suppressions:\n  policy:\n    - files: ["src/legacy.js"]\n      reason: Accepted existing issue\n');
  const project = createProject(cwd);

  const thrownEvents: RunEvent[] = [];
  const throwing = new LocalRule(() => {
    throw new Error('check exploded');
  });
  throwing.files = ['src/legacy.js'];
  await assert.rejects(executeRules([{
    name: 'policy',
    ruleFile: '.coderuler/policy.rule.ts',
    rule: throwing as Rule<unknown>,
  }], runContext(project, thrownEvents)), /check exploded/);
  assert.equal(thrownEvents.find(event => event.type === 'error')?.stage, 'check');

  const invalidEvents: RunEvent[] = [];
  const authored = new LocalRule(() => ({
    status: 'suppressed',
    suppressedLocations: [{ location: { filepath: 'src/legacy.js', lines: { start: 1, end: 1 } }, reason: 'Not trusted' }],
  } as unknown as CheckResult));
  authored.files = ['src/legacy.js'];
  await assert.rejects(executeRules([{
    name: 'policy',
    ruleFile: '.coderuler/policy.rule.ts',
    rule: authored as Rule<unknown>,
  }], runContext(project, invalidEvents)), /status must be "pass" or "violation"/);
  assert.equal(invalidEvents.find(event => event.type === 'error')?.stage, 'check');
});

test('tracked AI usage survives full suppression', async () => {
  const { cwd } = sandbox.isolated('ai-usage');
  writeFile(join(cwd, 'src', 'legacy.js'), 'legacy\n');
  writeFile(join(cwd, '.coderuler', 'suppressions.yml'), 'suppressions:\n  ai-policy:\n    - files: ["src/legacy.js"]\n      reason: Accepted AI finding\n');
  let backendCalls = 0;
  const backend: DecisionBackend = {
    async decide(): Promise<DecisionOutcome> {
      backendCalls += 1;
      return {
        probability: 0.2,
        model: 'test-model',
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    },
  };
  const runtime: DecisionRuntime = {
    backend,
    threshold: 0.5,
    pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2 },
  };
  const rule = new LocalRule(ai({ rule: 'Legacy code must be clean', violationMessage: 'AI finding' }));
  rule.files = ['src/legacy.js'];

  const { report, events } = await runRule(createProject(cwd), 'ai-policy', rule, runtime);
  const result = report.evaluations[0]?.result;
  assert.equal(result?.status, 'suppressed');
  assert.deepEqual(result?.usage, {
    calls: 1,
    unreportedCalls: 0,
    inputTokens: 10,
    outputTokens: 2,
    inputCost: 10 / 1_000_000,
    outputCost: 4 / 1_000_000,
  });
  assert.equal(events.find(event => event.type === 'result')?.type, 'result');
  assert.equal(backendCalls, 1);
});

test('Avro scope IDs remain tied to field names after earlier fields are inserted', async () => {
  const { cwd } = sandbox.isolated('avro-scope');
  const sourcePath = join(cwd, 'schemas', 'order.avsc');
  const configPath = join(cwd, '.coderuler', 'suppressions.yml');
  writeFile(sourcePath, JSON.stringify({
    type: 'record',
    name: 'Order',
    fields: [{ name: 'legacy_id', type: 'string' }],
  }));
  writeFile(configPath, 'suppressions:\n  field-naming:\n    - files: ["schemas/order.avsc"]\n      scope: legacy_id\n      reason: Published field name\n');

  const rule = new LocalRule(subject => {
    if (subject.kind !== 'scope') throw new Error('expected a field scope');
    return ruleViolation('Field naming violation', [{ filepath: subject.filepath, scopeId: subject.id }]);
  });
  rule.files = ['schemas/order.avsc'];
  rule.scope = scopes.json({ path: '$.fields[*]', key: '$.name' }) as ScopeSelector;

  const first = await runRule(createProject(cwd), 'field-naming', rule);
  assert.equal(first.report.evaluations[0]?.subject.kind, 'scope');
  assert.equal(first.report.evaluations[0]?.result.status, 'suppressed');

  writeFile(sourcePath, JSON.stringify({
    type: 'record',
    name: 'Order',
    fields: [
      { name: 'created_at', type: 'string' },
      { name: 'legacy_id', type: 'string' },
    ],
  }));
  const afterInsert = await runRule(createProject(cwd), 'field-naming', rule);
  const legacy = afterInsert.report.evaluations.find(({ subject }) =>
    subject.kind === 'scope' && subject.id === 'legacy_id');
  const inserted = afterInsert.report.evaluations.find(({ subject }) =>
    subject.kind === 'scope' && subject.id === 'created_at');
  assert.equal(legacy?.result.status, 'suppressed');
  assert.equal(inserted?.result.status, 'violation');
});

test('Protobuf scope suppression uses qualified declaration IDs', async () => {
  const { cwd } = sandbox.isolated('protobuf-scope');
  writeFile(join(cwd, 'schemas', 'order.proto'), 'syntax = "proto3";\npackage acme;\nmessage Order {\n  string legacy_id = 1;\n}\n');
  writeFile(join(cwd, '.coderuler', 'suppressions.yml'), 'suppressions:\n  field-naming:\n    - files: ["schemas/order.proto"]\n      scope: acme.Order.legacy_id\n      reason: Published field name\n');

  const rule = new LocalRule(subject => {
    if (subject.kind !== 'scope') throw new Error('expected a field scope');
    return ruleViolation('Field naming violation', [{ filepath: subject.filepath, scopeId: subject.id }]);
  });
  rule.files = ['schemas/order.proto'];
  rule.scope = scopes.protobuf({ path: '$.fields[*]' }) as ScopeSelector;
  const { report } = await runRule(createProject(cwd), 'field-naming', rule);
  assert.equal(report.evaluations[0]?.subject.kind, 'scope');
  assert.equal(report.evaluations[0]?.subject.id, 'acme.Order.legacy_id');
  assert.equal(report.evaluations[0]?.result.status, 'suppressed');
});

test('home rules use the execution root and inspect folder suppressions', async () => {
  const target = sandbox.isolated('execution-root');
  const ruleSource = `import { Rule, violation } from '@alex-dbs/coderuler';
export default class NoConsole extends Rule {
  files = ['src/legacy.js'];
  check = subject => violation('Legacy console use', [
    { filepath: subject.filepath, lines: { start: 1, end: 1 } },
  ]);
}
`;
  writeFile(join(target.home, '.coderuler', 'no-console.rule.ts'), ruleSource);
  writeFile(join(target.cwd, 'src', 'legacy.js'), 'console.log(1);\n');
  writeFile(join(target.cwd, '.coderuler', 'suppressions.yml'), 'suppressions:\n  no-console:\n    - files: ["src/legacy.js"]\n      lines: { start: 1, end: 1 }\n      reason: Execution project exception\n');

  const check = await runCli(['check', '--json', '--output-all'], target);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const checkResult = JSON.parse(check.stdout).reports[0].evaluations[0].result;
  assert.equal(checkResult.status, 'suppressed');
  assert.equal(checkResult.suppressedLocations[0].reason, 'Execution project exception');

  const directRule = new LocalRule(subject => {
    if (subject.kind !== 'scope') throw new Error('expected a scope');
    return ruleViolation('Legacy console use', [
      { filepath: subject.filepath, lines: { start: 1, end: 1 } },
    ]);
  });
  directRule.files = ['src/legacy.js'];
  const direct = await runRule(createProject(target.cwd), 'no-console', directRule);
  assert.equal(direct.report.evaluations[0]?.result.status, 'suppressed');
  assert.equal(direct.report.evaluations[0]?.result.suppressedLocations?.[0]?.reason, 'Execution project exception');

  const inspected = join(target.cwd, 'inspection');
  writeFile(join(inspected, 'src', 'legacy.js'), 'console.log(1);\n');
  writeFile(join(inspected, '.coderuler', 'suppressions.yml'), 'suppressions:\n  no-console:\n    - files: ["src/legacy.js"]\n      lines: { start: 1, end: 1 }\n      reason: Inspection folder exception\n');
  const inspect = await runCli(['inspect', 'no-console', 'inspection', '--json'], target);
  assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
  const inspection = JSON.parse(inspect.stdout);
  const inspectedResult = inspection.reports[0].evaluations[0].result;
  assert.equal(inspectedResult.status, 'suppressed');
  assert.equal(inspectedResult.suppressedLocations[0].reason, 'Inspection folder exception');
});

test('rule test cases load only suppression YAML from their fixture project', async () => {
  const target = sandbox.isolated('test-fixture-root');
  writeFile(join(target.cwd, '.coderuler', 'suppressions.yml'), 'suppressions: { no-console: [{ files: ["src/legacy.js"], reason: "Invocation exception" }] }\n');
  writeFile(join(target.cwd, '.coderuler', 'no-console.rule.ts'), `import { Rule, test, violation } from '@alex-dbs/coderuler';
export default class NoConsole extends Rule {
  files = ['src/legacy.js'];
  check = subject => violation('Legacy console use', [
    { filepath: subject.filepath, lines: { start: 1, end: 1 } },
  ]);
}
export const tests = [
  test('fixture suppression applies').withFiles({
    'src/legacy.js': 'console.log(1)',
    '.coderuler/suppressions.yml': 'suppressions: { no-console: [{ files: ["src/legacy.js"], lines: { start: 1, end: 1 }, reason: "Fixture exception" }] }',
  }).passes(),
  test('invocation suppression does not leak').withFiles({
    'src/legacy.js': 'console.log(1)',
  }).violates(),
];
`);
  const result = await runCli(['test', 'no-console'], target);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.includes('2 passed'), result.stdout);
});
