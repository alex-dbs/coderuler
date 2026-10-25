import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { createInspectJsonRenderer } from '../dist/adapter/cli/inspect-json.js';
import { createInspectRenderer, createWalkthroughRenderer } from '../dist/adapter/cli/reports.js';
import { createRedactor } from '../dist/adapter/cli/text.js';
import type { InspectionUsage } from '../src/adapter/cli/inspect-usage.js';
import type { RuleReport, RunEvent } from '../src/app/ports.js';
import type { AiUsage, ScopeSubject } from '../src/app/rule.js';

const subject: ScopeSubject = { kind: 'scope', filepath: 'src/example.txt', id: '$', source: 'hello' };
const reported: AiUsage = { calls: 1, unreportedCalls: 0, inputTokens: 11, outputTokens: 2, inputCost: 11 * 0.042 / 1e6, outputCost: 2 * 0.25 / 1e6 };
const unknown: AiUsage = { calls: 1, unreportedCalls: 1, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0 };
const zero: AiUsage = { ...unknown, unreportedCalls: 0 };
const identity = (text: string): string => text;

function start(evaluationId: number): RunEvent {
  return { type: 'evaluation', evaluationId, name: 'example', subject };
}

function usage(evaluationId: number, value: AiUsage): RunEvent {
  return { type: 'usage', evaluationId, name: 'example', subject, usage: value };
}

function result(evaluationId: number, value?: AiUsage): Extract<RunEvent, { type: 'result' }> {
  return { type: 'result', evaluationId, name: 'example', subject, result: { status: 'pass', ...(value === undefined ? {} : { usage: value }) } };
}

function report(event: Extract<RunEvent, { type: 'result' }>): RuleReport {
  return { name: event.name, ruleFile: 'example.rule.ts', status: 'pass', durationMs: 1, evaluations: [{ subject, result: event.result }] };
}

function fields(output: string, label: string): readonly string[] {
  return stripVTControlCharacters(output).split('\n').map(line => line.replace(/^│ /, '').replace(/ │$/, '').trim())
    .filter(line => line.startsWith(`${label}: `)).map(line => line.slice(label.length + 2));
}

for (const raw of [false, true]) {
  for (const ending of ['result', 'error', 'finish'] as const) {
    test(`inspect ${raw ? 'raw' : 'cards'} aggregates each verification once on ${ending} and recaps actual events`, () => {
      const chunks: string[] = [];
      const renderer = createInspectRenderer({ write: text => chunks.push(text), headings: () => [], redact: identity, columns: () => 180, raw });
      renderer.emit(start(1));
      renderer.emit(usage(1, reported));
      renderer.emit(usage(1, unknown));
      renderer.emit(usage(1, reported));
      assert.deepEqual(fields(chunks.join(''), 'input tokens'), []);
      if (ending === 'result') renderer.emit(result(1, { ...zero, inputTokens: 999 }));
      if (ending === 'error') renderer.emit({ type: 'error', evaluationId: 1, name: 'example', stage: 'check', message: 'failed' });
      renderer.finish([], ending === 'result' ? undefined : 'failed');
      const output = chunks.join('');
      assert.deepEqual(fields(output, 'verifications'), ['1']);
      assert.deepEqual(fields(output, 'calls'), ['3', '3']);
      assert.deepEqual(fields(output, 'input tokens'), ['22', '22']);
      assert.deepEqual(fields(output, 'output tokens'), ['4', '4']);
      assert.deepEqual(fields(output, 'unreported calls'), ['1', '1']);
      assert.equal(fields(output, 'totals').length, 2);
      const total = fields(output, 'total cost (USD)').map(value => Number(value.slice(1)));
      assert.equal(total.length, 2);
      for (const cost of total) assert.ok(Math.abs(cost - 2 * (reported.inputCost + reported.outputCost)) < 1e-8);
      assert.ok(Number(fields(output, 'input cost (USD)')[0]!.slice(1)) > 0);
      renderer.finish([], 'late failure');
      renderer.emit(usage(1, reported));
      assert.equal(chunks.join(''), output);
    });
  }

  test(`inspect ${raw ? 'raw' : 'cards'} excludes deterministic verifications and keeps tiny costs visible`, () => {
    const chunks: string[] = [];
    const renderer = createInspectRenderer({ write: text => chunks.push(text), headings: () => [], redact: identity, raw, columns: () => 180 });
    renderer.emit(start(1));
    renderer.emit(result(1));
    renderer.emit(start(2));
    renderer.emit(usage(2, { ...zero, inputTokens: 1, inputCost: 0.042 / 1e6 }));
    renderer.emit(result(2));
    renderer.emit(start(3));
    renderer.emit(usage(3, { ...zero, inputTokens: 1, inputCost: 1e-12 }));
    renderer.emit(result(3));
    renderer.finish([]);
    const output = chunks.join('');
    assert.deepEqual(fields(output, 'verifications'), ['2']);
    assert.deepEqual(fields(output, 'input tokens'), ['1', '1', '2']);
    assert.deepEqual(fields(output, 'unreported calls'), []);
    for (const cost of fields(output, 'input cost (USD)')) assert.ok(Number(cost.slice(1)) > 0, cost);
  });

  test(`inspect ${raw ? 'raw' : 'cards'} redacts numeric usage secrets before styling`, () => {
    const chunks: string[] = [];
    const renderer = createInspectRenderer({ write: text => chunks.push(text), headings: () => [], redact: createRedactor(['12345']), raw, color: true, columns: () => 180 });
    renderer.emit(start(1));
    renderer.emit(usage(1, { ...zero, inputTokens: 12345, inputCost: 0.012345 }));
    renderer.emit(result(1));
    renderer.finish([]);
    const output = chunks.join('');
    assert.equal(output.includes('12345'), false);
    assert.ok(output.includes('[REDACTED]'));
  });
}

for (const format of ['json', 'jsonl'] as const) {
  for (const failure of [false, true]) {
    test(`inspect ${format} ${failure ? 'failure' : 'success'} preserves numeric metadata and summarizes events only`, () => {
      const chunks: string[] = [];
      const renderer = createInspectJsonRenderer({ write: text => chunks.push(text), redact: createRedactor(['11']), format });
      const events = [start(1), usage(1, reported), usage(1, unknown), result(1, { ...reported, calls: 2, unreportedCalls: 1 }), start(2), usage(2, zero)];
      for (const event of events) renderer.emit(event);
      const completed = result(2, zero);
      if (failure) renderer.emit({ type: 'error', evaluationId: 2, name: 'example', stage: 'check', message: '11 failed' });
      else renderer.emit(completed);
      const reports = [report(result(1, { ...reported, calls: 2, unreportedCalls: 1 })), report(completed)];
      renderer.finish(reports, failure ? '11 failed' : undefined);
      const expected: InspectionUsage = { ...reported, calls: 3, unreportedCalls: 1, verifications: 2 };
      const lines = chunks.map(chunk => JSON.parse(chunk));
      if (format === 'json') {
        const document = JSON.parse(chunks.join(''));
        assert.deepEqual(document.usage, expected);
        assert.equal(document.events.find((event: RunEvent) => event.type === 'usage').usage.inputTokens, 11);
        assert.equal(document.error, failure ? '[REDACTED] failed' : undefined);
        assert.equal(document.reports.length, failure ? 0 : 2);
        if (!failure) assert.deepEqual(document.reports[0].evaluations[0].result.usage, { ...reported, calls: 2, unreportedCalls: 1 });
      } else {
        assert.deepEqual(lines.find(line => line.type === 'summary'), { type: 'summary', usage: expected });
        assert.equal(lines.filter(line => line.type === 'summary').length, 1);
        assert.equal(lines.at(-1).type, failure ? 'error' : 'summary');
        if (failure) assert.equal(lines.at(-1).message, '[REDACTED] failed');
        else assert.equal(lines.at(-2).type, 'report');
      }
      const output = chunks.join('');
      renderer.finish(reports, 'late failure');
      renderer.emit(usage(2, reported));
      assert.equal(chunks.join(''), output);
    });
  }

  test(`inspect ${format} snapshots usage metadata on emit`, () => {
    const chunks: string[] = [];
    const renderer = createInspectJsonRenderer({ write: text => chunks.push(text), redact: identity, format });
    const mutable = { ...reported };
    const event = usage(1, mutable);
    renderer.emit(event);
    renderer.emit(result(1, mutable));
    mutable.inputTokens = 999;
    mutable.inputCost = 999;
    renderer.finish([]);
    const events = format === 'json' ? JSON.parse(chunks.join('')).events : chunks.map(chunk => JSON.parse(chunk)).filter(record => record.type === 'event').map(record => record.event);
    assert.deepEqual(events[0].usage, reported);
    assert.deepEqual(events[1].result.usage, reported);
    const summary = format === 'json' ? JSON.parse(chunks.join('')).usage : JSON.parse(chunks.at(-1)!).usage;
    assert.deepEqual(summary, { ...reported, verifications: 1 });
  });
}

test('deterministic-only inspection and ordinary walkthroughs do not add AI usage output', () => {
  for (const format of ['cards', 'raw', 'json', 'jsonl', 'walkthrough'] as const) {
    const chunks: string[] = [];
    const options = { write: (text: string) => chunks.push(text), redact: identity, headings: () => [] };
    const renderer = format === 'json' || format === 'jsonl' ? createInspectJsonRenderer({ ...options, format })
      : format === 'walkthrough' ? createWalkthroughRenderer(options) : createInspectRenderer({ ...options, raw: format === 'raw' });
    renderer.emit(start(1));
    if (format === 'walkthrough') renderer.emit(usage(1, reported));
    renderer.emit(result(1));
    renderer.finish([]);
    assert.equal(/AI Usage|"usage"|"summary"|input tokens/.test(chunks.join('')), false);
  }
});
