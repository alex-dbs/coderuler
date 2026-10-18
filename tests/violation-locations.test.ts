import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Rule, ai, pass, regex, scopes, violation } from '../dist/index.js';
import type {
  CheckResult,
  DecisionBackend,
  DecisionOutcome,
  Evaluator,
  Grouping,
  RunContext,
  RunEvent,
  ScopeSelector,
  Subject,
  ViolationLocation,
} from '../dist/index.js';
import { createProject } from '../dist/adapter/filesystem/project.js';
import { renderViolationComments } from '../dist/adapter/cli/reports.js';
import { executeRules } from '../dist/app/execute.js';
import { validateCheckResult } from '../dist/app/validate.js';
import { createSandbox, writeFile } from './support.ts';

const sandbox = createSandbox('rulekeeper-violation-locations-');
after(() => sandbox.cleanup());

class LocationRule extends Rule {
  files = ['pkg/*.txt'];

  check: Evaluator;

  constructor(check: Evaluator) {
    super();
    this.check = check;
  }
}

function fixture(files: Readonly<Record<string, string>> = {
  'pkg/a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine',
}) {
  const { cwd } = sandbox.isolated('project');
  for (const [filepath, source] of Object.entries(files)) writeFile(join(cwd, filepath), source);
  return createProject(cwd);
}

const splitScopes: ScopeSelector = ({ source }) => {
  const lines = source.split('\n');
  return [
    { id: 'head', source: lines.slice(0, 3).join('\n'), lines: { start: 1, end: 3 } },
    { id: 'tail', source: lines.slice(6, 9).join('\n'), lines: { start: 7, end: 9 } },
  ];
};

function scopedRule(check: Evaluator, group: Grouping = 'scope'): LocationRule {
  const rule = new LocationRule(check);
  rule.group = group;
  rule.scope = splitScopes;
  return rule;
}

async function run(
  rule: LocationRule,
  project = fixture(),
  options: { readonly backend?: DecisionBackend; readonly emit?: RunContext['emit'] } = {},
) {
  const events: RunEvent[] = [];
  const reports = await executeRules([{
    name: 'location-policy', ruleFile: '.rulekeeper/location-policy.rule.ts', rule: rule as Rule<unknown>,
  }], {
    project,
    isTarget: () => true,
    concurrency: 2,
    resolveDecision: () => {
      assert.ok(options.backend, 'local checks must not resolve AI');
      return {
        backend: options.backend,
        threshold: 0.4,
        pricing: { inputCostPerMillion: 0, outputCostPerMillion: 0 },
      };
    },
    emit: event => {
      events.push(event);
      options.emit?.(event);
    },
  });
  assert.equal(reports.length, 1);
  return { reports, report: reports[0]!, events };
}

const redact = (text: string): string => text;

function rawResult(locations: unknown, status: CheckResult['status'] = 'violation'): CheckResult {
  return { status, message: 'Invalid attribution', locations } as unknown as CheckResult;
}

test('scope violations infer their own range only when locations are omitted', async () => {
  const implicit = await run(scopedRule(() => violation('Scope policy failed')));
  assert.equal(implicit.report.status, 'violation');
  assert.ok(implicit.report.evaluations.every(({ result }) => result.locations === undefined));
  assert.deepEqual(renderViolationComments(implicit.reports, redact).map(comment => comment.locations), [
    [{ filepath: 'pkg/a.txt', lines: { start: 1, end: 3 } }],
    [{ filepath: 'pkg/a.txt', lines: { start: 7, end: 9 } }],
  ]);

  const suppressed = await run(scopedRule(() => violation('Do not infer blame', [])));
  assert.deepEqual(suppressed.report.evaluations.map(({ result }) => result.locations), [[], []]);
  assert.deepEqual(renderViolationComments(suppressed.reports, redact).map(comment => comment.locations), [[], []]);
});

test('scopeId-only and explicit subranges resolve into consumer-visible result locations', async () => {
  const scoped = await run(scopedRule(subject => {
    assert.equal(subject.kind, 'scope');
    if (subject.kind !== 'scope') throw new Error('Expected a scope evaluation');
    return violation('Attributed failure', [{ filepath: subject.filepath, scopeId: subject.id }]);
  }));
  assert.deepEqual(scoped.report.evaluations.map(({ result }) => result.locations), [
    [{ filepath: 'pkg/a.txt', scopeId: 'head', lines: { start: 1, end: 3 } }],
    [{ filepath: 'pkg/a.txt', scopeId: 'tail', lines: { start: 7, end: 9 } }],
  ]);

  const explicit = await run(scopedRule(subject => {
    assert.equal(subject.kind, 'scope');
    if (subject.kind !== 'scope') throw new Error('Expected a scope evaluation');
    const start = subject.lines!.start;
    return violation('Precise failure', [{
      filepath: subject.filepath, scopeId: subject.id, lines: { start, end: start + 1 },
    }]);
  }));
  assert.deepEqual(explicit.report.evaluations.map(({ result }) => result.locations), [
    [{ filepath: 'pkg/a.txt', scopeId: 'head', lines: { start: 1, end: 2 } }],
    [{ filepath: 'pkg/a.txt', scopeId: 'tail', lines: { start: 7, end: 8 } }],
  ]);
  assert.deepEqual(renderViolationComments(explicit.reports, redact).map(comment => comment.locations), [
    [{ filepath: 'pkg/a.txt', lines: { start: 1, end: 2 } }],
    [{ filepath: 'pkg/a.txt', lines: { start: 7, end: 8 } }],
  ]);
});

for (const group of ['scope', 'file', 'folder', 'project'] as const) {
  test(`regex ${group} preserves whitespace-only IDs from structured selector keys`, async () => {
    const rule = new LocationRule(regex({ pattern: /"value":"ok"/ }));
    rule.group = group;
    rule.scope = scopes.json({ path: '$.items[*]', key: '$.id' });
    const result = await run(rule, fixture({
      'pkg/a.txt': '{\n"items":[\n{"id":" ","value":"bad"},\n{"id":"passing","value":"ok"}\n]\n}',
    }));
    assert.equal(result.report.status, 'violation');
    const failures = result.report.evaluations.filter(({ result }) => result.status === 'violation');
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0]!.result.locations, [
      { filepath: 'pkg/a.txt', scopeId: ' ', lines: { start: 3, end: 3 } },
    ]);
    assert.deepEqual(renderViolationComments(result.reports, redact).map(comment => comment.locations), [
      [{ filepath: 'pkg/a.txt', lines: { start: 3, end: 3 } }],
    ]);
    assert.equal(result.events.some(event => event.type === 'error'), false);
  });

  test(`explicit ${group} attribution preserves whitespace-only filepath and member ID`, async () => {
    const rule = new LocationRule(subject => {
      const member = subject.kind === 'scope' ? subject : subject.members[0]!;
      assert.equal(member.filepath, ' ');
      assert.equal(member.id, ' ');
      return violation('Whitespace identity fails', [{ filepath: member.filepath, scopeId: member.id }]);
    });
    rule.files = ['[ ]'];
    rule.group = group;
    rule.scope = ({ source }) => [{ id: ' ', source, lines: { start: 1, end: 1 } }];
    const result = await run(rule, fixture({ ' ': 'bad' }));
    assert.equal(result.report.status, 'violation');
    assert.deepEqual(result.report.evaluations.map(({ result }) => result), [{
      status: 'violation',
      message: 'Whitespace identity fails',
      locations: [{ filepath: ' ', scopeId: ' ', lines: { start: 1, end: 1 } }],
    }]);
    assert.deepEqual(renderViolationComments(result.reports, redact).map(comment => comment.locations), [
      [{ filepath: ' ', lines: { start: 1, end: 1 } }],
    ]);
    assert.equal(result.events.some(event => event.type === 'error'), false);
  });
}

for (const group of ['file', 'folder', 'project'] as const) {
  test(`${group} locations resolve the named member, not every member of the group`, async () => {
    const rule = scopedRule(subject => {
      assert.equal(subject.kind, 'group');
      if (subject.kind !== 'group') throw new Error('Expected a group evaluation');
      const member = subject.members.at(-1)!;
      return violation('Only this member fails', [{ filepath: member.filepath, scopeId: 'tail' }]);
    }, group);
    const result = await run(rule, fixture({
      'pkg/a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine',
      'pkg/b.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine',
    }));
    const paths = group === 'file' ? ['pkg/a.txt', 'pkg/b.txt'] : ['pkg/b.txt'];
    assert.deepEqual(result.report.evaluations.map(({ result }) => result.locations), paths.map(filepath => [
      { filepath, scopeId: 'tail', lines: { start: 7, end: 9 } },
    ]));
    assert.deepEqual(renderViolationComments(result.reports, redact).map(comment => comment.locations), paths.map(filepath => [
      { filepath, lines: { start: 7, end: 9 } },
    ]));
  });

  test(`${group} message-only violations do not invent member blame`, async () => {
    const result = await run(scopedRule(() => violation('Group policy failed'), group));
    assert.equal(result.report.status, 'violation');
    assert.equal(result.report.evaluations[0]!.result.locations, undefined);
    assert.deepEqual(renderViolationComments(result.reports, redact)[0]!.locations, []);
  });
}

test('file-level lines may select any one known member but cannot bridge member ranges', async () => {
  const result = await run(scopedRule(() => violation('Tail line failed', [
    { filepath: 'pkg/a.txt', lines: { start: 8, end: 9 } },
  ]), 'project'));
  assert.deepEqual(result.report.evaluations[0]!.result.locations, [
    { filepath: 'pkg/a.txt', lines: { start: 8, end: 9 } },
  ]);

  for (const lines of [{ start: 3, end: 7 }, { start: 4, end: 6 }, { start: 9, end: 10 }]) {
    await assert.rejects(run(scopedRule(() => violation('Outside member', [
      { filepath: 'pkg/a.txt', lines },
    ]), 'project')), /location|line|range|member/i);
  }
});

test('file lines resolve unsorted, nested, and equal-start member ranges without changing them', async () => {
  const ranges = [
    { start: 8, end: 9 },
    { start: 2, end: 3 },
    { start: 1, end: 12 },
    { start: 5, end: 6 },
    { start: 2, end: 10 },
  ];
  const originalRanges = ranges.map(lines => ({ ...lines }));
  const expected = [
    { filepath: 'pkg/a.txt', lines: { start: 11, end: 12 } },
    { filepath: 'pkg/a.txt', lines: { start: 2, end: 10 } },
    { filepath: 'pkg/a.txt', lines: { start: 6, end: 11 } },
    { filepath: 'pkg/a.txt', lines: { start: 1, end: 12 } },
  ];
  const rule = scopedRule(() => violation('Contained in one member', expected), 'file');
  rule.scope = ({ source }) => ranges.map((lines, index) => ({
    id: `member-${index}`, source, lines,
  }));
  const result = await run(rule, fixture({
    'pkg/a.txt': Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n'),
  }));
  assert.deepEqual(result.report.evaluations[0]!.result.locations, expected);
  assert.deepEqual(ranges, originalRanges);
});

test('equal-start file ranges retain the longest containing member in either input order', async () => {
  for (const ends of [[3, 9], [9, 3]]) {
    const expected = [{ filepath: 'pkg/a.txt', lines: { start: 2, end: 8 } }];
    const rule = scopedRule(() => violation('Contained in the longer member', expected), 'file');
    rule.scope = ({ source }) => ends.map((end, index) => ({
      id: `member-${index}`, source, lines: { start: 2, end },
    }));
    const result = await run(rule);
    assert.deepEqual(result.report.evaluations[0]!.result.locations, expected);
  }
});

test('file lines cannot combine adjacent or gapped members into a containing range', async () => {
  const ranges = [
    { start: 7, end: 9 },
    { start: 1, end: 3 },
    { start: 4, end: 5 },
  ];
  const rule = scopedRule(() => violation('Member boundaries', ranges.map(lines => ({
    filepath: 'pkg/a.txt', lines,
  }))), 'file');
  rule.scope = ({ source }) => ranges.map((lines, index) => ({
    id: `member-${index}`, source, lines,
  }));
  const result = await run(rule);
  assert.deepEqual(result.report.evaluations[0]!.result.locations, ranges.map(lines => ({
    filepath: 'pkg/a.txt', lines,
  })));

  for (const lines of [
    { start: 3, end: 4 },
    { start: 1, end: 5 },
    { start: 5, end: 7 },
    { start: 6, end: 6 },
    { start: 4, end: 9 },
    { start: 9, end: 10 },
  ]) {
    rule.check = () => violation('No single containing member', [{ filepath: 'pkg/a.txt', lines }]);
    await assert.rejects(run(rule), /location|line|range|member/i);
  }
});

test('overlapping file ranges accept individual containment but not their union', async () => {
  const expected = [
    { filepath: 'pkg/a.txt', lines: { start: 3, end: 6 } },
    { filepath: 'pkg/a.txt', lines: { start: 5, end: 8 } },
    { filepath: 'pkg/a.txt', lines: { start: 5, end: 6 } },
  ];
  const rule = scopedRule(() => violation('Contained in one overlapping member', expected), 'file');
  rule.scope = ({ source }) => [
    { id: 'later', source, lines: { start: 5, end: 9 } },
    { id: 'earlier', source, lines: { start: 2, end: 6 } },
  ];
  const result = await run(rule);
  assert.deepEqual(result.report.evaluations[0]!.result.locations, expected);
  for (const lines of [{ start: 2, end: 9 }, { start: 4, end: 8 }]) {
    rule.check = () => violation('Cannot combine overlapping members', [{ filepath: 'pkg/a.txt', lines }]);
    await assert.rejects(run(rule), /location|line|range|member/i);
  }
});

test('locations without known member lines remain unanchored unless callers supply explicit lines', async () => {
  for (const group of ['scope', 'folder', 'project'] as const) {
    const unanchored = new LocationRule(() => violation('No source position', [
      { filepath: 'pkg/a.txt', scopeId: 'virtual' },
    ]));
    unanchored.group = group;
    unanchored.scope = ({ source }) => [{ id: 'virtual', source }];
    const result = await run(unanchored);
    assert.deepEqual(result.report.evaluations[0]!.result.locations, [
      { filepath: 'pkg/a.txt', scopeId: 'virtual' },
    ]);
    assert.deepEqual(renderViolationComments(result.reports, redact)[0]!.locations, []);

    unanchored.check = () => violation('Caller knows source position', [
      { filepath: 'pkg/a.txt', scopeId: 'virtual', lines: { start: 50, end: 51 } },
    ]);
    const explicit = await run(unanchored);
    assert.deepEqual(explicit.report.evaluations[0]!.result.locations, [
      { filepath: 'pkg/a.txt', scopeId: 'virtual', lines: { start: 50, end: 51 } },
    ]);
  }
});

test('a member without line metadata permits explicit file lines even alongside ranged members', async () => {
  const rule = scopedRule(() => violation('Known external position', [
    { filepath: 'pkg/a.txt', lines: { start: 50, end: 51 } },
  ]), 'project');
  rule.scope = ({ source }) => [
    { id: 'ranged', source, lines: { start: 1, end: 3 } },
    { id: 'unranged', source },
  ];
  const result = await run(rule);
  assert.deepEqual(result.report.evaluations[0]!.result.locations, [
    { filepath: 'pkg/a.txt', lines: { start: 50, end: 51 } },
  ]);
});

const invalidMetadata: readonly (readonly [string, unknown])[] = [
  ['non-array locations', {}],
  ['null locations', null],
  ['sparse locations', new Array(1)],
  ['missing location', [undefined]],
  ['null location', [null]],
  ['string location', ['pkg/a.txt']],
  ['missing filepath', [{ scopeId: 'head' }]],
  ['empty filepath', [{ filepath: '', scopeId: 'head' }]],
  ['numeric filepath', [{ filepath: 7, scopeId: 'head' }]],
  ['missing location position', [{ filepath: 'pkg/a.txt' }]],
  ['empty scopeId', [{ filepath: 'pkg/a.txt', scopeId: '' }]],
  ['numeric scopeId', [{ filepath: 'pkg/a.txt', scopeId: 0 }]],
  ['null lines', [{ filepath: 'pkg/a.txt', lines: null }]],
  ['string lines', [{ filepath: 'pkg/a.txt', lines: '1-3' }]],
  ['missing line end', [{ filepath: 'pkg/a.txt', lines: { start: 1 } }]],
  ['zero start', [{ filepath: 'pkg/a.txt', lines: { start: 0, end: 1 } }]],
  ['negative start', [{ filepath: 'pkg/a.txt', lines: { start: -1, end: 1 } }]],
  ['fractional start', [{ filepath: 'pkg/a.txt', lines: { start: 1.5, end: 2 } }]],
  ['fractional end', [{ filepath: 'pkg/a.txt', lines: { start: 1, end: 2.5 } }]],
  ['reversed range', [{ filepath: 'pkg/a.txt', lines: { start: 3, end: 2 } }]],
  ['unsafe line integer', [{ filepath: 'pkg/a.txt', lines: { start: 1, end: Number.MAX_SAFE_INTEGER + 1 } }]],
  ['infinite line', [{ filepath: 'pkg/a.txt', lines: { start: 1, end: Number.POSITIVE_INFINITY } }]],
  ['NaN line', [{ filepath: 'pkg/a.txt', lines: { start: Number.NaN, end: 1 } }]],
];

for (const [label, locations] of invalidMetadata) {
  test(`engine rejects ${label} rather than emitting invalid blame`, async () => {
    const events: RunEvent[] = [];
    await assert.rejects(run(scopedRule(() => rawResult(locations), 'project'), fixture(), {
      emit: event => events.push(event),
    }), /location|filepath|scopeId|line/i);
    assert.ok(events.some(event => event.type === 'error' && event.stage === 'check'));
    assert.equal(events.some(event => event.type === 'result'), false);
  });
}

for (const [label, location] of [
  ['unknown file', { filepath: 'pkg/missing.txt', scopeId: 'head' }],
  ['existing nonmember file', { filepath: 'other.txt', lines: { start: 1, end: 1 } }],
  ['unknown scope', { filepath: 'pkg/a.txt', scopeId: 'missing' }],
  ['unknown whitespace-only file', { filepath: ' ', scopeId: 'head' }],
  ['unknown whitespace-only scope', { filepath: 'pkg/a.txt', scopeId: ' ' }],
  ['padded nonmember file', { filepath: ' pkg/a.txt ', scopeId: 'head' }],
  ['padded nonmember scope', { filepath: 'pkg/a.txt', scopeId: ' head ' }],
  ['range outside named scope', { filepath: 'pkg/a.txt', scopeId: 'head', lines: { start: 7, end: 8 } }],
  ['range extending past named scope', { filepath: 'pkg/a.txt', scopeId: 'head', lines: { start: 3, end: 4 } }],
] as const) {
  test(`engine rejects ${label} in a project location`, async () => {
    const project = fixture({ 'pkg/a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine', 'other.txt': 'outside' });
    await assert.rejects(run(scopedRule(() => violation('Invalid blame', [location]), 'project'), project),
      /location|member|scope|range|line/i);
  });
}

test('scope locations cannot name a different evaluated scope from the same file', async () => {
  await assert.rejects(run(scopedRule(() => violation('Wrong scope', [
    { filepath: 'pkg/a.txt', scopeId: 'tail' },
  ]))), /location|scope|member/i);
});

test('group locations cannot blame scopes removed by the rule filter', async () => {
  const rule = scopedRule(() => violation('Filtered scope', [
    { filepath: 'pkg/a.txt', scopeId: 'tail' },
  ]), 'project');
  rule.filter = subject => subject.id !== 'tail';
  await assert.rejects(run(rule), /location|scope|member/i);
});

test('scope IDs are resolved together with their filepath', async () => {
  const rule = scopedRule(() => violation('ID belongs to another file', [
    { filepath: 'pkg/a.txt', scopeId: 'only-b' },
  ]), 'project');
  rule.scope = ({ filepath, source }) => [{
    id: filepath === 'pkg/a.txt' ? 'only-a' : 'only-b', source, lines: { start: 1, end: 1 },
  }];
  await assert.rejects(run(rule, fixture({ 'pkg/a.txt': 'a', 'pkg/b.txt': 'b' })), /location|scope|member/i);
});

for (const locations of [[], [{ filepath: 'pkg/a.txt', scopeId: 'head' }]]) {
  test(`pass results reject ${locations.length === 0 ? 'empty' : 'nonempty'} locations`, async () => {
    await assert.rejects(run(scopedRule(() => rawResult(locations, 'pass'), 'project')), /location|violation/i);
  });
}

test('location normalization never mutates rule-owned arrays or nested lines', async () => {
  const supplied: readonly ViolationLocation[] = Object.freeze([
    Object.freeze({ filepath: 'pkg/a.txt', scopeId: 'tail' }),
    Object.freeze({ filepath: 'pkg/a.txt', lines: Object.freeze({ start: 1, end: 2 }) }),
  ]);
  const returned = Object.freeze(violation('Frozen rule-owned metadata', supplied));
  const result = await run(scopedRule(() => returned, 'project'));
  const locations = result.report.evaluations[0]!.result.locations!;
  assert.deepEqual(locations, [
    { filepath: 'pkg/a.txt', scopeId: 'tail', lines: { start: 7, end: 9 } },
    { filepath: 'pkg/a.txt', lines: { start: 1, end: 2 } },
  ]);
  assert.notEqual(locations, supplied);
  assert.notEqual(locations[1]!.lines, supplied[1]!.lines);
  assert.deepEqual(supplied[0], { filepath: 'pkg/a.txt', scopeId: 'tail' });
});

test('locations snapshot nested metadata before pending AI handlers mutate rule-owned results', { timeout: 5000 }, async () => {
  const pending = Promise.withResolvers<DecisionOutcome>();
  const started = Promise.withResolvers<void>();
  const lines = { start: 2, end: 3 };
  const locations = [{ filepath: 'pkg/a.txt', scopeId: 'head', lines }];
  const returned = { status: 'violation' as const, message: 'Initial failure', locations };
  const rule = scopedRule((_subject, context) => {
    void context.ai({ rule: 'Account for pending work' }).then(() => {
      lines.start = 90;
      lines.end = 99;
      locations[0]!.filepath = 'other.txt';
      locations[0]!.scopeId = 'changed';
      locations.push({ filepath: 'invented.txt', scopeId: 'new', lines: { start: 1, end: 2 } });
      returned.locations = [];
    });
    return returned;
  }, 'project');
  const backend: DecisionBackend = {
    decide: async () => {
      started.resolve();
      return pending.promise;
    },
  };
  const completed = run(rule, fixture(), { backend });
  await started.promise;
  await new Promise<void>(resolve => { setImmediate(resolve); });
  pending.resolve({ probability: 0.9, model: 'location-test' });
  const result = await completed;
  const expected = [{ filepath: 'pkg/a.txt', scopeId: 'head', lines: { start: 2, end: 3 } }];
  assert.deepEqual(returned.locations, []);
  assert.equal(lines.start, 90);
  assert.deepEqual(result.report.evaluations[0]!.result.locations, expected);
  assert.deepEqual(result.events.filter(event => event.type === 'result').map(event => event.result.locations), [expected]);
});

test('result event callbacks cannot alter stored locations by mutating the original return value', async () => {
  const lines = { start: 1, end: 2 };
  const locations = [{ filepath: 'pkg/a.txt', scopeId: 'head', lines }];
  const returned = violation('Stable result', locations);
  const result = await run(scopedRule(() => returned, 'project'), fixture(), {
    emit: event => {
      if (event.type !== 'result') return;
      lines.end = 999;
      locations[0]!.filepath = 'other.txt';
      locations.splice(0);
    },
  });
  assert.deepEqual(locations, []);
  assert.deepEqual(result.report.evaluations[0]!.result.locations, [
    { filepath: 'pkg/a.txt', scopeId: 'head', lines: { start: 1, end: 2 } },
  ]);
});

test('empty locations do not read group members and detached locations need no member lookup', () => {
  const subject: Subject = {
    kind: 'group',
    group: { type: 'project', path: '.' },
    get members(): never {
      throw new Error('Empty locations must not read members');
    },
  };
  assert.deepEqual(validateCheckResult(violation('No blame', []), 'Empty result', subject).locations, []);
  assert.deepEqual(validateCheckResult(violation('Detached result', [{
    filepath: 'unknown.txt', scopeId: ' ', lines: { start: 2, end: 3 },
  }]), 'Detached result').locations, [{
    filepath: 'unknown.txt', scopeId: ' ', lines: { start: 2, end: 3 },
  }]);
});

test('large same-file group resolves every range-only failure with one read per member', async () => {
  const memberCount = 256;
  const source = Array.from({ length: memberCount }, (_, index) => `bad-${index + 1}`).join('\n');
  const expected = Array.from({ length: memberCount }, (_, index) => ({
    filepath: 'pkg/a.txt', lines: { start: index + 1, end: index + 1 },
  }));
  const evaluate = regex({ pattern: /^ok$/, violationMessage: 'All members fail' });
  let lineReads = 0;
  let readsAtResult: number | undefined;
  const rule = new LocationRule(async (subject, context) => {
    assert.equal(subject.kind, 'group');
    if (subject.kind !== 'group') throw new Error('Expected a group evaluation');
    const result = await evaluate(subject, context);
    const locations = subject.members.map(({ filepath, lines }) => {
      assert.ok(lines);
      return { filepath, lines };
    });
    for (const member of subject.members) {
      const { lines } = member;
      Object.defineProperty(member, 'lines', {
        configurable: true,
        enumerable: true,
        get: () => { lineReads += 1; return lines; },
      });
    }
    return violation(result.message!, locations);
  });
  rule.group = 'file';
  rule.scope = ({ source }) => source.split('\n').map((text, index) => ({
    id: `line-${index + 1}`, source: text, lines: { start: index + 1, end: index + 1 },
  }));
  const result = await run(rule, fixture({ 'pkg/a.txt': source }), {
    emit: event => {
      if (event.type === 'result') readsAtResult = lineReads;
    },
  });
  assert.equal(result.report.status, 'violation');
  assert.equal(result.report.evaluations.length, 1);
  assert.deepEqual(result.report.evaluations[0]!.result.locations, expected);
  assert.notEqual(readsAtResult, undefined);
  assert.ok(readsAtResult! <= memberCount, `${readsAtResult} member line reads for ${memberCount} findings`);
  assert.equal(result.events.some(event => event.type === 'error'), false);
});

for (const attribution of ['scopeId', 'lines'] as const) {
  test(`large all-fail project regex resolves ${attribution} locations with linear member metadata reads`, async () => {
    const fileCount = 32;
    const scopesPerFile = 32;
    const memberCount = fileCount * scopesPerFile;
    const paths = Array.from({ length: fileCount }, (_, index) => `pkg/file-${String(index).padStart(2, '0')}.txt`);
    const source = Array.from({ length: scopesPerFile }, (_, index) => `bad-${index + 1}`).join('\n');
    const expected = paths.flatMap(filepath => Array.from({ length: scopesPerFile }, (_, index) => ({
      filepath,
      ...(attribution === 'scopeId' ? { scopeId: `line-${index + 1}` } : {}),
      lines: { start: index + 1, end: index + 1 },
    })));
    const evaluate = regex({ pattern: /^ok$/, violationMessage: 'All members fail' });
    let identityReads = 0;
    let lineReads = 0;
    let readsAtResult: { identity: number; lines: number } | undefined;
    const rule = new LocationRule(async (subject, context) => {
      assert.equal(subject.kind, 'group');
      if (subject.kind !== 'group') throw new Error('Expected a group evaluation');
      const result = await evaluate(subject, context);
      for (const member of subject.members) {
        const { filepath, id, lines } = member;
        Object.defineProperties(member, {
          filepath: { configurable: true, enumerable: true, get: () => { identityReads += 1; return filepath; } },
          id: { configurable: true, enumerable: true, get: () => { identityReads += 1; return id; } },
          lines: { configurable: true, enumerable: true, get: () => { lineReads += 1; return lines; } },
        });
      }
      return attribution === 'scopeId' ? result : violation(result.message!, expected);
    });
    rule.group = 'project';
    rule.scope = ({ source }) => source.split('\n').map((text, index) => ({
      id: `line-${index + 1}`, source: text, lines: { start: index + 1, end: index + 1 },
    }));
    const result = await run(rule, fixture(Object.fromEntries(paths.map(filepath => [filepath, source]))), {
      emit: event => {
        if (event.type === 'result') readsAtResult = { identity: identityReads, lines: lineReads };
      },
    });
    assert.equal(result.report.status, 'violation');
    assert.equal(result.report.evaluations.length, 1);
    assert.deepEqual(result.report.evaluations[0]!.result.locations, expected);
    assert.ok(readsAtResult);
    assert.ok(readsAtResult.identity <= 4 * memberCount, `${readsAtResult.identity} member identity reads`);
    assert.ok(readsAtResult.lines <= memberCount, `${readsAtResult.lines} member line reads`);
    assert.equal(result.events.some(event => event.type === 'error'), false);
  });
}

for (const group of ['scope', 'file', 'folder', 'project'] as const) {
  test(`regex ${group} reports only the exact failing members`, async () => {
    const rule = new LocationRule(regex({ pattern: /^ok$/, violationMessage: 'Member must be ok' }));
    rule.group = group;
    rule.scope = ({ source }) => source.split('\n').map((text, index) => ({
      id: `line-${index + 1}`, source: text, lines: { start: index + 1, end: index + 1 },
    }));
    const result = await run(rule, fixture({ 'pkg/a.txt': 'ok\nbad-a\nok', 'pkg/b.txt': 'bad-b\nok' }));
    const failures = result.report.evaluations.filter(({ result }) => result.status === 'violation');
    assert.ok(failures.every(({ result }) => result.message === 'Member must be ok'));
    assert.deepEqual(failures.flatMap(({ result }) => result.locations ?? []), [
      { filepath: 'pkg/a.txt', scopeId: 'line-2', lines: { start: 2, end: 2 } },
      { filepath: 'pkg/b.txt', scopeId: 'line-1', lines: { start: 1, end: 1 } },
    ]);
    assert.ok(result.report.evaluations.filter(({ result }) => result.status === 'pass')
      .every(({ result }) => result.locations === undefined));
    assert.deepEqual(renderViolationComments(result.reports, redact).flatMap(comment => comment.locations), [
      { filepath: 'pkg/a.txt', lines: { start: 2, end: 2 } },
      { filepath: 'pkg/b.txt', lines: { start: 1, end: 1 } },
    ]);
  });
}

test('regex preserves unanchored failing members without blaming passing ranged members', async () => {
  const rule = new LocationRule(regex({ pattern: /^ok$/ }));
  rule.group = 'project';
  rule.scope = ({ filepath, source }) => [{
    id: 'member', source,
    ...(filepath === 'pkg/a.txt' ? { lines: { start: 1, end: 1 } } : {}),
  }];
  const result = await run(rule, fixture({ 'pkg/a.txt': 'ok', 'pkg/b.txt': 'bad' }));
  assert.deepEqual(result.report.evaluations[0]!.result.locations, [{ filepath: 'pkg/b.txt', scopeId: 'member' }]);
  assert.equal(result.report.evaluations[0]!.result.message, undefined);
  assert.deepEqual(renderViolationComments(result.reports, redact)[0]!.locations, []);
});

test('passing regex evaluations preserve pass behavior without location metadata', async () => {
  const rule = new LocationRule(regex({ pattern: /^ok$/ }));
  rule.group = 'project';
  const result = await run(rule, fixture({ 'pkg/a.txt': 'ok', 'pkg/b.txt': 'ok' }));
  assert.equal(result.report.status, 'pass');
  assert.deepEqual(result.report.evaluations[0]!.result, pass());
  assert.deepEqual(renderViolationComments(result.reports, redact), []);
});

test('AI scalar results use only scope fallback and never invent grouped attribution or extra calls', async () => {
  for (const group of ['scope', 'folder', 'project'] as const) {
    let calls = 0;
    const backend: DecisionBackend = {
      decide: async () => {
        calls += 1;
        return { probability: 0.1, model: 'location-test' };
      },
    };
    const rule = scopedRule(ai({ rule: 'Policy violation', violationMessage: 'AI found a violation' }), group);
    const result = await run(rule, fixture(), { backend });
    assert.equal(calls, result.report.evaluations.length);
    assert.ok(result.report.evaluations.every(({ result }) => result.locations === undefined));
    const comments = renderViolationComments(result.reports, redact);
    assert.equal(comments.length, result.report.evaluations.length);
    assert.deepEqual(comments.map(comment => comment.locations), group === 'scope' ? [
      [{ filepath: 'pkg/a.txt', lines: { start: 1, end: 3 } }],
      [{ filepath: 'pkg/a.txt', lines: { start: 7, end: 9 } }],
    ] : [[]]);
  }
});
