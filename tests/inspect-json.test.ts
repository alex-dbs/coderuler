import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInspectJsonRenderer } from '../dist/adapter/cli/inspect-json.js';
import { createRedactor } from '../dist/adapter/cli/text.js';
import type { RuleReport, RunEvent } from '../src/app/ports.js';
import type { GroupSubject, JsonValue, ScopeSubject } from '../src/app/rule.js';

interface InspectDocument {
  events: RunEvent[];
  reports: RuleReport[];
  error?: string;
}

type InspectRecord =
  | { type: 'event'; event: RunEvent }
  | { type: 'report'; report: RuleReport }
  | { type: 'error'; message: string };

function fixture(text = 'café 日本語 👋'): { events: RunEvent[]; reports: RuleReport[] } {
  const scope: ScopeSubject = {
    kind: 'scope', filepath: `src/${text}.ts`, id: `function:${text}`, source: `\t${text}\nnext();`,
    lines: { start: 9, end: 10 }, data: { text, count: 17, enabled: true, empty: null },
    captures: { text, repeated: [text, 'other'] },
  };
  const group: GroupSubject = { kind: 'group', group: { type: 'folder', path: `src/${text}` }, members: [scope] };
  const result = { status: 'violation' as const, message: text, model: text, probability: 0.125, threshold: 0.75 };
  const events: RunEvent[] = [
    { type: 'progress', phase: 'selection', completed: 0, total: 17 },
    { type: 'rule', name: text, ruleFile: `${text}.rule.ts` },
    { type: 'gate', name: text, enabled: true, applies: true, reason: text },
    { type: 'file', evaluationId: 17, name: text, filepath: scope.filepath, selected: true, reason: text },
    { type: 'file', name: text, filepath: scope.filepath, selected: false, reason: text },
    { type: 'scope', name: text, subject: scope, accepted: false, reason: text },
    { type: 'group', name: text, subject: group },
    { type: 'evaluation', evaluationId: 17, name: text, subject: group },
    { type: 'request', evaluationId: 17, name: text, subject: group, body: `{ "input": ${JSON.stringify(text)} }\n` },
    { type: 'response', evaluationId: 17, name: text, subject: group, status: 200, body: ` {"probability":0.125,"message":${JSON.stringify(text)}} ` },
    { type: 'trace', evaluationId: 17, name: text, message: text, details: { text, array: [text, 17, false, null] } },
    { type: 'result', evaluationId: 17, name: text, subject: group, result },
    { type: 'progress', phase: 'evaluation', completed: 17, total: 17 },
    { type: 'gate', name: text, enabled: false, applies: false, reason: text },
  ];
  const reports: RuleReport[] = [
    { name: text, ruleFile: `${text}.rule.ts`, status: 'violation', durationMs: 3.125, evaluations: [{ subject: group, result }] },
    { name: text, ruleFile: `${text}.rule.ts`, status: 'pass', durationMs: 0.25, evaluations: [{ subject: scope, result: { status: 'pass', probability: 1, threshold: 0.75 } }] },
    { name: text, ruleFile: `${text}.rule.ts`, status: 'skipped', durationMs: 0, reason: text, evaluations: [] },
  ];
  return { events, reports };
}

for (const format of ['json', 'jsonl'] as const) {
  test(`inspect ${format} preserves the complete walk, reports, original bodies and Unicode`, () => {
    const chunks: string[] = [];
    const renderer = createInspectJsonRenderer({ write: text => chunks.push(text), redact: text => text, format });
    const { events, reports } = fixture();
    for (const event of events) renderer.emit(event);
    if (format === 'json') assert.deepEqual(chunks, []);
    else {
      assert.equal(chunks.length, events.length);
      assert.deepEqual(chunks.map(chunk => JSON.parse(chunk)), events.map(event => ({ type: 'event', event })));
      for (const chunk of chunks) assert.equal(chunk.split('\n').length, 2);
    }
    renderer.finish(reports);
    if (format === 'json') {
      assert.equal(chunks.length, 1);
      assert.deepEqual(JSON.parse(chunks[0]!), { events, reports });
      assert.ok(chunks[0]!.startsWith('{\n  "events": [\n'));
    } else {
      assert.deepEqual(chunks.map(chunk => JSON.parse(chunk)), [
        ...events.map(event => ({ type: 'event', event })),
        ...reports.map(report => ({ type: 'report', report })),
      ]);
    }
    const output = chunks.join('');
    renderer.finish(reports, 'late error');
    renderer.emit({ type: 'error', stage: 'late', message: 'ignored' });
    assert.equal(chunks.join(''), output);
  });

  for (const secret of ['s', '1', '"', 'private"quoted\\value', 'private\r\nmultiline\tcredential', 'type']) {
    test(`inspect ${format} safely redacts ${JSON.stringify(secret)} without altering schema or numeric metadata`, () => {
      const chunks: string[] = [];
      const redact = createRedactor([secret]);
      assert.equal(redact(secret), secret.includes('\r\n') ? '[REDACTED]\r\n[REDACTED]' : '[REDACTED]');
      const renderer = createInspectJsonRenderer({ write: text => chunks.push(text), redact, format });
      const { events, reports } = fixture(secret);
      for (const event of events) renderer.emit(event);
      renderer.finish(reports);
      const document: InspectDocument = format === 'json'
        ? JSON.parse(chunks.join(''))
        : {
          events: (chunks.map(chunk => JSON.parse(chunk)) as InspectRecord[]).flatMap(record => record.type === 'event' ? [record.event] : []),
          reports: (chunks.map(chunk => JSON.parse(chunk)) as InspectRecord[]).flatMap(record => record.type === 'report' ? [record.report] : []),
        };
      assert.deepEqual(document.events.map(event => event.type), events.map(event => event.type));
      assert.deepEqual(document.events[0], { type: 'progress', phase: 'selection', completed: 0, total: 17 });
      assert.deepEqual(document.events[12], { type: 'progress', phase: 'evaluation', completed: 17, total: 17 });
      for (const event of document.events) {
        if ('name' in event) assert.equal(event.name, redact(secret));
        if ('reason' in event) assert.equal(event.reason, redact(secret));
        if ('evaluationId' in event) assert.equal(event.evaluationId, 17);
        if ('subject' in event) {
          assert.equal(event.subject.kind, event.type === 'scope' ? 'scope' : 'group');
          const subject = event.subject.kind === 'scope' ? event.subject : event.subject.members[0]!;
          assert.deepEqual(subject.lines, { start: 9, end: 10 });
          assert.equal(subject.filepath, redact(`src/${secret}.ts`));
          assert.equal(subject.id, redact(`function:${secret}`));
          assert.equal(subject.source, redact(`\t${secret}\nnext();`));
          assert.deepEqual(subject.data, { text: redact(secret), count: 17, enabled: true, empty: null });
          assert.deepEqual(subject.captures, { text: redact(secret), repeated: [redact(secret), redact('other')] });
          if (event.subject.kind === 'group') {
            assert.equal(event.subject.group.type, 'folder');
            assert.equal(event.subject.group.path, redact(`src/${secret}`));
          }
        }
        if (event.type === 'request' || event.type === 'response') {
          const original = events.find(candidate => candidate.type === event.type);
          assert.ok(original?.type === 'request' || original?.type === 'response');
          assert.equal(typeof event.body, 'string');
          assert.equal(event.body, redact(original.body));
          if (event.type === 'response') assert.equal(event.status, 200);
        }
        if (event.type === 'result') assert.deepEqual(event.result, {
          status: 'violation', message: redact(secret), model: redact(secret), probability: 0.125, threshold: 0.75,
        });
        if (event.type === 'trace') assert.deepEqual(event.details, { text: redact(secret), array: [redact(secret), 17, false, null] });
      }
      assert.deepEqual(document.events[2], { type: 'gate', name: redact(secret), enabled: true, applies: true, reason: redact(secret) });
      assert.deepEqual(document.events[13], { type: 'gate', name: redact(secret), enabled: false, applies: false, reason: redact(secret) });
      assert.deepEqual(document.reports.map(report => report.status), ['violation', 'pass', 'skipped']);
      assert.deepEqual(document.reports.map(report => report.durationMs), [3.125, 0.25, 0]);
      for (const report of document.reports) {
        assert.equal(report.name, redact(secret));
        assert.equal(report.ruleFile, redact(`${secret}.rule.ts`));
      }
      assert.equal(document.reports[2]!.reason, redact(secret));
      assert.deepEqual(document.reports[0]!.evaluations[0]!.result, {
        status: 'violation', message: redact(secret), model: redact(secret), probability: 0.125, threshold: 0.75,
      });
      if (secret.startsWith('private')) {
        for (const fragment of ['private', 'quoted', 'value', 'multiline', 'credential']) {
          assert.ok(!chunks.join('').includes(fragment));
        }
      }
      assert.deepEqual(document.reports[1]!.evaluations[0]!.result, { status: 'pass', probability: 1, threshold: 0.75 });
    });
  }

  test(`inspect ${format} redacts arbitrary keys, retains collisions and safely preserves own __proto__`, () => {
    const chunks: string[] = [];
    const renderer = createInspectJsonRenderer({ write: text => chunks.push(text), redact: createRedactor(['private']), format });
    const arbitrary = JSON.parse('{"private":"private","[REDACTED]":"second","[REDACTED]#2":"third","__proto__":{"private":"private"},"nested":[{"private":"private"}]}') as JsonValue;
    const captures = JSON.parse('{"private":"private","[REDACTED]":["private","safe"],"__proto__":"private"}') as Record<string, string | string[]>;
    const subject: ScopeSubject = { kind: 'scope', filepath: 'safe.ts', id: 'scope', source: 'safe', data: arbitrary, captures };
    renderer.emit({ type: 'trace', name: 'safe', message: 'safe', details: arbitrary });
    renderer.emit({ type: 'evaluation', evaluationId: 1, name: 'safe', subject });
    renderer.finish([{ name: 'safe', ruleFile: 'safe.rule.ts', status: 'pass', durationMs: 1, evaluations: [{ subject, result: { status: 'pass' } }] }]);
    const records = format === 'jsonl' ? chunks.map(chunk => JSON.parse(chunk)) as InspectRecord[] : [];
    const document: InspectDocument = format === 'json'
      ? JSON.parse(chunks.join(''))
      : {
        events: records.flatMap(record => record.type === 'event' ? [record.event] : []),
        reports: records.flatMap(record => record.type === 'report' ? [record.report] : []),
      };
    const expected = JSON.parse('{"[REDACTED]":"[REDACTED]","[REDACTED]#2":"second","[REDACTED]#2#2":"third","__proto__":{"[REDACTED]":"[REDACTED]"},"nested":[{"[REDACTED]":"[REDACTED]"}]}');
    const trace = document.events[0];
    assert.ok(trace?.type === 'trace');
    assert.deepEqual(trace.details, expected);
    const evaluation = document.events[1];
    assert.ok(evaluation?.type === 'evaluation' && evaluation.subject.kind === 'scope');
    assert.deepEqual(evaluation.subject.data, expected);
    assert.deepEqual(evaluation.subject.captures, JSON.parse('{"[REDACTED]":"[REDACTED]","[REDACTED]#2":["[REDACTED]","safe"],"__proto__":"[REDACTED]"}'));
    assert.ok(Object.hasOwn(evaluation.subject.data as object, '__proto__'));
    assert.equal(Object.getPrototypeOf(evaluation.subject.data), Object.prototype);
    assert.deepEqual(document.reports[0]!.evaluations[0]!.subject, evaluation.subject);
    assert.ok(!chunks.join('').includes('private'));
  });

  test(`inspect ${format} snapshots nested event state at emit rather than finish`, () => {
    const chunks: string[] = [];
    const renderer = createInspectJsonRenderer({ write: text => chunks.push(text), redact: text => text, format });
    const lines = { start: 1, end: 2 };
    const data = { nested: { values: ['before'] } };
    const captures = { values: ['before'] };
    const scope: ScopeSubject = { kind: 'scope', filepath: 'before.ts', id: 'before', source: 'before', lines, data, captures };
    const members = [scope];
    const group = { type: 'project' as const, path: 'before' };
    const subject: GroupSubject = { kind: 'group', group, members };
    const result = { status: 'pass' as const, message: 'before', model: 'before', probability: 0.9, threshold: 0.8 };
    const details = { values: [{ value: 'before' }] };
    const progress = { type: 'progress' as const, phase: 'evaluation' as const, completed: 1, total: 2 };
    const events: RunEvent[] = [
      { type: 'evaluation', evaluationId: 1, name: 'safe', subject },
      { type: 'result', evaluationId: 1, name: 'safe', subject, result },
      { type: 'trace', evaluationId: 1, name: 'safe', message: 'safe', details },
      progress,
    ];
    const expected = JSON.parse(JSON.stringify(events));
    for (const event of events) renderer.emit(event);
    lines.start = 99;
    data.nested.values[0] = 'after';
    captures.values.push('after');
    members.splice(0, 1);
    group.path = 'after';
    result.message = 'after';
    result.model = 'after';
    result.threshold = 0.1;
    details.values[0]!.value = 'after';
    details.values.push({ value: 'after' });
    progress.completed = 2;
    renderer.finish([]);
    const actual = format === 'json'
      ? (JSON.parse(chunks.join('')) as InspectDocument).events
      : (chunks.map(chunk => JSON.parse(chunk)) as InspectRecord[]).flatMap(record => record.type === 'event' ? [record.event] : []);
    assert.deepEqual(actual, expected);
  });

  test(`inspect ${format} retains engine errors and terminates failed operations without completion reports`, () => {
    const chunks: string[] = [];
    const redact = createRedactor(['private\ncredential']);
    const renderer = createInspectJsonRenderer({ write: text => chunks.push(text), redact, format });
    const error: RunEvent = { type: 'error', evaluationId: 17, name: 'private\ncredential', stage: 'private\ncredential', message: 'private\ncredential failed' };
    renderer.emit(error);
    const reports = fixture().reports;
    renderer.finish(reports, 'operation private\ncredential failed');
    if (format === 'json') {
      assert.deepEqual(JSON.parse(chunks.join('')), {
        events: [{ ...error, name: redact(error.name!), stage: redact(error.stage), message: redact(error.message) }],
        reports: [], error: redact('operation private\ncredential failed'),
      });
    } else {
      assert.deepEqual(chunks.map(chunk => JSON.parse(chunk)), [
        { type: 'event', event: { ...error, name: redact(error.name!), stage: redact(error.stage), message: redact(error.message) } },
        { type: 'error', message: redact('operation private\ncredential failed') },
      ]);
    }
    const output = chunks.join('');
    assert.ok(!output.includes('private'));
    assert.ok(!output.includes('credential'));
    renderer.finish(reports);
    renderer.emit({ type: 'rule', name: 'late', ruleFile: 'late' });
    assert.equal(chunks.join(''), output);
  });

  test(`inspect ${format} handles preparation failure before any event and empty successful runs`, () => {
    for (const error of [undefined, '', 'selector unavailable']) {
      const chunks: string[] = [];
      const renderer = createInspectJsonRenderer({ write: text => chunks.push(text), redact: text => text, format });
      renderer.finish([], error);
      if (format === 'json') assert.deepEqual(JSON.parse(chunks.join('')), {
        events: [], reports: [], ...(error === undefined ? {} : { error }),
      });
      else assert.deepEqual(chunks.map(chunk => JSON.parse(chunk)), error === undefined ? [] : [{ type: 'error', message: error }]);
    }
  });
}
