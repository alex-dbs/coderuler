import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';

import { createInspectRenderer, createWalkthroughRenderer } from '../dist/adapter/cli/reports.js';
import { createRedactor } from '../dist/adapter/cli/text.js';
import type { RuleReport, RunEvent } from '../src/app/ports.js';
import type { CheckResult, GroupSubject, ScopeSubject, Subject } from '../src/app/rule.js';

const identity = (text: string): string => text;

function scope(source = 'first();\nsecond();\nlast();', filepath = 'src/subject.ts', id = 'function:work', start = 7): ScopeSubject {
  return { kind: 'scope', filepath, id, source, lines: { start, end: start + source.split('\n').length - 1 } };
}

function evaluation(evaluationId: number, subject: Subject, name = 'placement'): RunEvent {
  return { type: 'evaluation', evaluationId, name, subject };
}

function result(evaluationId: number, subject: Subject, value: CheckResult = { status: 'pass' }, name = 'placement'): RunEvent {
  return { type: 'result', evaluationId, name, subject, result: value };
}

function capture(options: Partial<Parameters<typeof createWalkthroughRenderer>[0]> = {}) {
  const chunks: string[] = [];
  const renderer = createWalkthroughRenderer({ write: text => chunks.push(text), headings: () => [], redact: identity, ...options });
  return { renderer, chunks, output: () => chunks.join('') };
}

function cards(output: string): string[] {
  return stripVTControlCharacters(output).match(/^╭─+╮\n[\s\S]*?^╰─+╯\n/gm) ?? [];
}

function content(card: string): string {
  return stripVTControlCharacters(card).split('\n').filter(line => line.startsWith('│ ')).map(line => {
    assert.ok(line.endsWith(' │'), line);
    return line.slice(2, -2).trimEnd();
  }).join('\n');
}

function sectionTitle(line: string): string | undefined {
  return /^  (Source|Request|Response|Result|Trace|Error|File|Incomplete)(?: ─+)?$/.exec(line)?.[1];
}

function sections(card: string, title: string): string[] {
  const lines = content(card).split('\n');
  const found: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (sectionTitle(lines[index]!) !== title) continue;
    let end = index + 1;
    while (end < lines.length && sectionTitle(lines[end]!) === undefined) end += 1;
    found.push(lines.slice(index + 1, end).join('\n').trimEnd());
  }
  return found;
}

function payload(section: string, label = 'body'): string {
  const marker = `    ${label}:\n`;
  const start = section.indexOf(marker);
  assert.notEqual(start, -1, section);
  return section.slice(start + marker.length).trimEnd();
}

function assertWidth(card: string, columns: number): void {
  for (const line of card.trimEnd().split('\n')) {
    assert.equal(stringWidth(line), columns, JSON.stringify(line));
  }
  assert.match(card, new RegExp(`^╭─{${columns - 2}}╮\\n`));
  assert.match(card, new RegExp(`╰─{${columns - 2}}╯\\n$`));
}

function assertWrappedText(card: string, expected: string, occurrences?: number): void {
  const unframed = stripVTControlCharacters(card).split('\n')
    .filter(line => line.startsWith('│ ')).map(line => line.slice(2, -2)).join('\n');
  const pattern = [...new Intl.Segmenter().segment(expected)]
    .map(({ segment }) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?: *\\n)?');
  if (occurrences === undefined) assert.match(unframed, new RegExp(pattern, 'u'));
  else assert.equal(unframed.match(new RegExp(pattern, 'gu'))?.length ?? 0, occurrences, unframed);
}

test('one evaluation card owns metadata once while JSON metadata remains faithful', () => {
  const subject = scope();
  const request = {
    name: 'placement',
    file: subject.filepath,
    scope: subject.id,
    subject: { filepath: subject.filepath, id: subject.id, lines: subject.lines },
    instructions: 'evaluation placement; file: src/subject.ts:7-9; scope: function:work',
  };
  const response = { name: 'placement', file: subject.filepath, scope: subject.id, status: 'pass' };
  const { renderer, output } = capture({ columns: () => 400 });
  renderer.emit(evaluation(1, subject));
  renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: JSON.stringify(request) });
  renderer.emit({ type: 'response', evaluationId: 1, name: 'placement', subject, status: 200, body: JSON.stringify(response) });
  renderer.emit(result(1, subject, { status: 'pass', message: 'Correct layer', model: 'local', probability: 0.99 }));
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1, output());
  const lines = content(rendered[0]!).split('\n');
  assert.equal(lines.filter(line => line === 'evaluation placement').length, 1);
  assert.equal(lines.filter(line => line === '  file: src/subject.ts:7-9').length, 1);
  assert.equal(lines.filter(line => line === '  scope: function:work').length, 1);
  assert.deepEqual(lines.slice(0, 4), ['evaluation placement', '  file: src/subject.ts:7-9', '  scope: function:work', '']);
  assert.equal(sectionTitle(lines[4]!), 'Source');
  assert.deepEqual(JSON.parse(payload(sections(rendered[0]!, 'Request')[0]!)), request);
  assert.deepEqual(JSON.parse(payload(sections(rendered[0]!, 'Response')[0]!)), response);
  assert.match(sections(rendered[0]!, 'Response')[0]!, /^    status: HTTP 200\n    body:\n/);
  assert.match(sections(rendered[0]!, 'Result')[0]!, /^    status: pass\n    message: Correct layer\n/);
  assert.ok(sections(rendered[0]!, 'Result')[0]!.includes('    probability: 0.99'));
  assert.ok(sections(rendered[0]!, 'Result')[0]!.includes('    model: local'));
  assert.ok(!/^request placement$|^response placement$|^result placement$/m.test(output()), output());
});

test('deterministic evaluations stream full source and result without inventing AI sections', () => {
  for (const status of ['pass', 'violation'] as const) {
    const subject = scope('one();\ntwo();\nthree();\nfour();\nfive();\nsix();\nlast();');
    const { renderer, output } = capture();
    renderer.emit(evaluation(1, subject));
    assert.match(output(), /^╭─+╮\n/);
    assert.ok(content(output()).includes('    13 | last();'), output());
    assert.ok(!output().includes('╰'), output());
    renderer.emit(result(1, subject, { status }));
    renderer.finish();
    const rendered = cards(output());
    assert.equal(rendered.length, 1);
    assertWidth(rendered[0]!, 80);
    assert.match(sections(rendered[0]!, 'Result')[0]!, new RegExp(`^    status: ${status}$`));
    for (const absent of ['Request', 'Response', 'Incomplete', 'model:', 'probability:', 'threshold:', 'undefined', 'more line']) {
      assert.ok(!content(rendered[0]!).includes(absent), output());
    }
  }
});

test('one evaluation retains every AI request-response pair in order', () => {
  const subject = scope('consult();');
  const { renderer, output } = capture({ columns: () => 200 });
  renderer.emit(evaluation(4, subject));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    renderer.emit({ type: 'request', evaluationId: 4, name: 'placement', subject, body: JSON.stringify({ attempt, message: `request-${attempt}` }) });
    renderer.emit({ type: 'response', evaluationId: 4, name: 'placement', subject, status: attempt === 1 ? 503 : 200, body: JSON.stringify({ attempt, message: `response-${attempt}` }) });
  }
  renderer.emit(result(4, subject, { status: 'violation', message: 'Move to adapter', model: 'judge', probability: 0.12 }));
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1);
  assert.deepEqual(content(rendered[0]!).split('\n').map(sectionTitle).filter(title => /^(Request|Response|Result)$/.test(title ?? '')), [
    'Request', 'Response', 'Request', 'Response', 'Request', 'Response', 'Result',
  ]);
  for (const [index, section] of sections(rendered[0]!, 'Request').entries()) {
    assert.deepEqual(JSON.parse(payload(section)), { attempt: index + 1, message: `request-${index + 1}` });
  }
  for (const [index, section] of sections(rendered[0]!, 'Response').entries()) {
    assert.deepEqual(JSON.parse(payload(section)), { attempt: index + 1, message: `response-${index + 1}` });
    assert.ok(section.includes(`status: HTTP ${index === 0 ? 503 : 200}`), section);
  }
  assert.equal(sections(rendered[0]!, 'Source').length, 1);
  assert.equal(sections(rendered[0]!, 'Result').length, 1);
});

test('group cards contain all member metadata and complete sources inside Source', () => {
  const members = Array.from({ length: 7 }, (_, index) => scope(
    `member-${index}-one\nmember-${index}-two\nmember-${index}-three\nmember-${index}-four\nmember-${index}-five\nmember-${index}-last`,
    `src/member-${index}.ts`, `function:member-${index}`, 20 + index,
  ));
  const subject: GroupSubject = { kind: 'group', group: { type: 'folder', path: 'src' }, members };
  const { renderer, output } = capture();
  renderer.emit({ type: 'group', name: 'placement', subject });
  assert.equal(output(), '', 'selection-time groups must not duplicate card metadata');
  renderer.emit(evaluation(1, subject));
  renderer.emit(result(1, subject));
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1);
  const text = content(rendered[0]!);
  assert.match(text, /^evaluation placement\n  group: folder\n  path: src\n  members: 7\n\n  Source ─+\n/);
  const source = sections(rendered[0]!, 'Source')[0]!;
  for (const [index, member] of members.entries()) {
    assert.ok(source.includes(`file: ${member.filepath}:${member.lines!.start}-${member.lines!.end}`), source);
    assert.ok(source.includes(`scope: ${member.id}`), source);
    assert.ok(source.includes(`${member.lines!.end} | member-${index}-last`), source);
    assert.equal(text.split(member.filepath).length - 1, 1, text);
  }
  assert.ok(!text.includes('more members'), text);
  assert.ok(!text.includes('more line'), text);
});

test('accepted selections show source only in cards while filtered selections retain standalone source', () => {
  const accepted = scope('accepted-source-only-in-card();', 'src/accepted.ts');
  const filtered = scope('filtered-source-outside-card();', 'src/filtered.ts');
  const { renderer, output } = capture();
  renderer.emit({ type: 'scope', name: 'placement', subject: accepted, accepted: true });
  assert.equal(output(), '', 'accepted source is not a standalone block');
  renderer.emit({ type: 'file', name: 'placement', filepath: accepted.filepath, selected: true });
  assert.match(output(), /^file placement\n  file: src\/accepted\.ts\n  status: selected\n\n$/);
  renderer.emit({ type: 'scope', name: 'placement', subject: filtered, accepted: false, reason: 'outside layer' });
  const standalone = output();
  assert.match(standalone, /scope placement\n  file: src\/filtered\.ts:7-7\n  scope: function:work\n  status: filtered\n  reason: outside layer\n  source:\n/);
  assert.ok(standalone.includes('filtered-source-outside-card();'), standalone);
  assert.ok(!standalone.includes('accepted-source-only-in-card();'), standalone);
  renderer.emit(evaluation(1, accepted));
  renderer.emit(result(1, accepted));
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1);
  assert.ok(content(rendered[0]!).includes('accepted-source-only-in-card();'));
  assert.ok(!content(rendered[0]!).includes('filtered-source-outside-card();'));
  assert.equal(output().split('accepted-source-only-in-card();').length - 1, 1);
  assert.equal(output().split('filtered-source-outside-card();').length - 1, 1);
});

test('inspect skips remain plain explanations and finish is idempotent including later emits', () => {
  const chunks: string[] = [];
  const renderer = createInspectRenderer({ write: text => chunks.push(text), headings: () => [], redact: identity });
  renderer.emit({ type: 'gate', name: 'disabled', enabled: false, applies: false, reason: 'disabled by settings' });
  const reports: readonly RuleReport[] = [
    { name: 'disabled', ruleFile: 'disabled.rule.ts', status: 'skipped', durationMs: 0, reason: 'disabled by settings', evaluations: [] },
    { name: 'empty', ruleFile: 'empty.rule.ts', status: 'skipped', durationMs: 0, evaluations: [] },
    { name: 'filtered', ruleFile: 'filtered.rule.ts', status: 'skipped', durationMs: 0, reason: 'all scopes filtered', evaluations: [] },
  ];
  renderer.finish(reports);
  const output = chunks.join('');
  renderer.finish(reports);
  renderer.emit({ type: 'trace', name: 'late', message: 'must be ignored' });
  assert.equal(chunks.join(''), output);
  assert.equal(cards(output).length, 0);
  assert.equal(output.split('disabled by settings').length - 1, 1);
  assert.match(output, /result empty\n  status: skipped\n  reason: no matching subjects\n\n/);
  assert.match(output, /result filtered\n  status: skipped\n  reason: all scopes filtered\n\n/);
  assert.ok(!output.includes('status: pass'), output);
  assert.ok(!output.includes('status: violation'), output);
});

test('inspect streams an evaluation before finish and never duplicates report results', () => {
  const chunks: string[] = [];
  const subject = scope('inspect-source();');
  const renderer = createInspectRenderer({ write: text => chunks.push(text), headings: () => [], redact: identity });
  renderer.emit(evaluation(1, subject));
  assert.ok(content(chunks.join('')).includes('inspect-source();'));
  assert.ok(!chunks.join('').includes('╰'));
  renderer.emit(result(1, subject));
  const reports: readonly RuleReport[] = [{ name: 'placement', ruleFile: 'placement.rule.ts', status: 'pass', durationMs: 1, evaluations: [{ subject, result: { status: 'pass' } }] }];
  renderer.finish(reports);
  const output = chunks.join('');
  renderer.finish(reports);
  assert.equal(chunks.join(''), output);
  assert.equal(cards(output).length, 1);
  assert.equal(sections(cards(output)[0]!, 'Result').length, 1);
  assert.ok(!/^result placement$/m.test(output), output);
});

test('finish closes partial evaluations explicitly without manufacturing a verdict', () => {
  const subject = scope('unfinished();');
  const { renderer, output } = capture();
  renderer.emit(evaluation(1, subject));
  renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: '{"pending":true}' });
  assert.ok(!output().includes('╰'));
  renderer.finish();
  const complete = output();
  renderer.finish();
  renderer.emit(result(1, subject));
  renderer.emit(evaluation(2, subject));
  assert.equal(output(), complete);
  const rendered = cards(complete);
  assert.equal(rendered.length, 1);
  assert.match(content(rendered[0]!), /\n  Incomplete ─+\n    status: incomplete$/);
  assert.equal(sections(rendered[0]!, 'Result').length, 0);
  assert.equal(sections(rendered[0]!, 'Response').length, 0);
  assert.ok(!/status: (?:pass|violation)/.test(complete), complete);
});

test('correlated trace, file and error remain nested without repeated evaluation metadata', () => {
  const subject = scope('unsafe();');
  const details = { selected: ['src/extra.ts'], reason: 'adapter dependency' };
  const { renderer, output } = capture({ columns: () => 200 });
  renderer.emit(evaluation(1, subject));
  renderer.emit({ type: 'file', evaluationId: 1, name: 'placement', filepath: 'src/extra.ts', selected: false, reason: 'not an adapter' });
  renderer.emit({ type: 'trace', evaluationId: 1, name: 'placement', message: 'Resolved candidates', details });
  renderer.emit({ type: 'error', evaluationId: 1, name: 'placement', stage: 'request', message: 'Backend unavailable' });
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1);
  assert.match(sections(rendered[0]!, 'File')[0]!, /^    file: src\/extra\.ts\n    status: excluded\n    reason: not an adapter$/);
  assert.match(sections(rendered[0]!, 'Trace')[0]!, /^    message: Resolved candidates\n    details:\n/);
  assert.deepEqual(JSON.parse(payload(sections(rendered[0]!, 'Trace')[0]!, 'details')), details);
  assert.match(sections(rendered[0]!, 'Error')[0]!, /^    stage: request\n    message: Backend unavailable$/);
  const lines = content(rendered[0]!).split('\n');
  assert.equal(lines.filter(line => line === 'evaluation placement').length, 1);
  assert.equal(lines.filter(line => line === '  scope: function:work').length, 1);
  assert.equal(lines.filter(line =>
    line === `  file: ${subject.filepath}:${subject.lines!.start}-${subject.lines!.end}`,
  ).length, 1);
  assert.ok(!/status: (?:pass|violation)/.test(output()), output());
});

test('global errors close an open card as incomplete before the standalone error', () => {
  const subject = scope('interrupted();');
  const { renderer, output } = capture();
  renderer.emit(evaluation(1, subject));
  renderer.emit({ type: 'error', stage: 'run', message: 'Interrupted externally' });
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1);
  assert.match(content(rendered[0]!), /\n  Incomplete ─+\n    status: incomplete$/);
  const tail = output().slice(output().indexOf('╯') + 1);
  assert.match(tail, /error\n  stage: run\n  message: Interrupted externally/);
  assert.ok(!/status: (?:pass|violation)/.test(output()), output());
});

test('correlated events without an evaluation start throw instead of fabricating metadata', () => {
  const subject = scope();
  const events: readonly RunEvent[] = [
    { type: 'request', evaluationId: 999, name: 'placement', subject, body: '{}' },
    { type: 'response', evaluationId: 999, name: 'placement', subject, status: 200, body: '{}' },
    result(999, subject),
    { type: 'file', evaluationId: 999, name: 'placement', filepath: subject.filepath, selected: true },
    { type: 'trace', evaluationId: 999, name: 'placement', message: 'orphan trace' },
    { type: 'error', evaluationId: 999, name: 'placement', stage: 'request', message: 'orphan error' },
  ];
  for (const event of events) {
    const { renderer, output } = capture();
    assert.throws(() => renderer.emit(event), /evaluation.*999|999.*evaluation/i, event.type);
    renderer.finish();
    assert.equal(output(), '', event.type);
  }
});

test('interleaved concurrent IDs with duplicate subjects emit isolated atomic cards', () => {
  const distinct = scope('third-source();', 'src/third.ts', 'function:third');
  const subject = scope('shared-source();');
  const { renderer, chunks, output } = capture({ concurrency: 3, columns: () => 160 });
  renderer.emit(evaluation(11, subject));
  renderer.emit(evaluation(12, subject));
  renderer.emit(evaluation(13, distinct));
  renderer.emit({ type: 'request', evaluationId: 11, name: 'placement', subject, body: '{"marker":"first-request"}' });
  renderer.emit({ type: 'request', evaluationId: 12, name: 'placement', subject, body: '{"marker":"second-request"}' });
  renderer.emit({ type: 'request', evaluationId: 13, name: 'placement', subject: distinct, body: '{"marker":"third-request"}' });
  renderer.emit({ type: 'response', evaluationId: 12, name: 'placement', subject, status: 200, body: '{"marker":"second-response"}' });
  renderer.emit({ type: 'trace', evaluationId: 11, name: 'placement', message: 'first-trace' });
  assert.equal(chunks.length, 0, 'concurrent partial cards are buffered');
  renderer.emit(result(12, subject, { status: 'violation', message: 'second-result' }));
  assert.equal(chunks.length, 1, 'each completed concurrent card is one write');
  assert.equal(cards(chunks[0]!).length, 1);
  assert.match(chunks[0]!, /^╭─+╮\n[\s\S]*╰─+╯\n\n$/);
  renderer.emit({ type: 'response', evaluationId: 11, name: 'placement', subject, status: 200, body: '{"marker":"first-response"}' });
  renderer.emit(result(11, subject, { status: 'pass', message: 'first-result' }));
  assert.equal(chunks.length, 2);
  renderer.emit({ type: 'response', evaluationId: 13, name: 'placement', subject: distinct, status: 201, body: '{"marker":"third-response"}' });
  renderer.emit(result(13, distinct, { status: 'pass', message: 'third-result' }));
  assert.equal(chunks.length, 3);
  renderer.finish();
  assert.equal(chunks.length, 3);
  const rendered = cards(output());
  assert.equal(rendered.length, 3);
  for (const marker of ['second-request', 'second-response', 'second-result']) assert.ok(content(rendered[0]!).includes(marker), output());
  for (const marker of ['first-request', 'first-response', 'first-trace', 'first-result']) assert.ok(!content(rendered[0]!).includes(marker), output());
  for (const marker of ['first-request', 'first-response', 'first-trace', 'first-result']) assert.ok(content(rendered[1]!).includes(marker), output());
  for (const marker of ['second-request', 'second-response', 'second-result']) assert.ok(!content(rendered[1]!).includes(marker), output());
  for (const card of rendered.slice(0, 2)) {
    assert.ok(!content(card).includes('third-'), output());
  }
  for (const marker of ['third-source', 'third-request', 'third-response', 'third-result', 'src/third.ts', 'function:third']) {
    assert.ok(content(rendered[2]!).includes(marker), output());
  }
  for (const marker of ['first-', 'second-', 'shared-source', 'src/subject.ts', 'function:work']) {
    assert.ok(!content(rendered[2]!).includes(marker), output());
  }
  for (const [index, card] of rendered.entries()) {
    assertWidth(card, 160);
    assert.equal(sections(card, 'Source').length, 1);
    assert.equal(sections(card, 'Result').length, 1);
    assert.equal(content(card).split(index === 2 ? 'third-source();' : 'shared-source();').length - 1, 1);
  }
});

test('concurrent finish flushes each unfinished ID as its own atomic incomplete card', () => {
  const subject = scope('shared-partial();');
  const { renderer, chunks, output } = capture({ concurrency: 2 });
  renderer.emit(evaluation(1, subject));
  renderer.emit(evaluation(2, subject));
  renderer.emit({ type: 'trace', evaluationId: 1, name: 'placement', message: 'first-partial' });
  renderer.emit({ type: 'trace', evaluationId: 2, name: 'placement', message: 'second-partial' });
  assert.equal(output(), '');
  renderer.finish();
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    const rendered = cards(chunk);
    assert.equal(rendered.length, 1);
    assert.match(content(rendered[0]!), /\n  Incomplete ─+\n    status: incomplete$/);
    assert.equal(sections(rendered[0]!, 'Result').length, 0);
  }
  assert.ok(chunks[0]!.includes('first-partial'));
  assert.ok(!chunks[0]!.includes('second-partial'));
  assert.ok(chunks[1]!.includes('second-partial'));
  assert.ok(!chunks[1]!.includes('first-partial'));
  const complete = output();
  renderer.finish();
  assert.equal(output(), complete);
});

test('progress remains outside open streaming borders and keeps the latest update for each phase', () => {
  const subject = scope('streaming();');
  const { renderer, output } = capture();
  renderer.emit({ type: 'progress', phase: 'selection', completed: 0, total: 2 });
  renderer.emit(evaluation(1, subject));
  const opened = output();
  renderer.emit({ type: 'progress', phase: 'selection', completed: 1, total: 2 });
  renderer.emit({ type: 'progress', phase: 'evaluation', completed: 1, total: 3 });
  renderer.emit({ type: 'progress', phase: 'selection', completed: 2, total: 2 });
  renderer.emit({ type: 'progress', phase: 'evaluation', completed: 2, total: 3 });
  assert.equal(output(), opened);
  renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: '{"streamed":true}' });
  assert.ok(content(output()).includes('  Request'), output());
  assert.ok(!output().includes('╰'));
  renderer.emit(result(1, subject));
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1);
  assertWidth(rendered[0]!, 80);
  assert.ok(!rendered[0]!.includes('progress'), rendered[0]);
  const tail = output().slice(output().lastIndexOf('╯') + 1);
  assert.match(tail, /progress selection 2\/2/);
  assert.match(tail, /progress evaluation 2\/3/);
  assert.equal(tail.split('progress selection').length - 1, 1);
  assert.equal(tail.split('progress evaluation').length - 1, 1);
  assert.ok(!tail.includes('1/2'), tail);
  assert.ok(!tail.includes('1/3'), tail);
  assert.ok(!output().includes('\r'), output());
});

test('non-error standalone events defer until the streaming card closes without splitting it', () => {
  const subject = scope('one-card();');
  const { renderer, output } = capture();
  renderer.emit(evaluation(1, subject));
  const opened = output();
  renderer.emit({ type: 'trace', name: 'setup', message: 'global-trace' });
  renderer.emit({ type: 'rule', name: 'later', ruleFile: 'later.rule.ts' });
  assert.equal(output(), opened);
  renderer.emit(result(1, subject));
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1);
  assert.equal(sections(rendered[0]!, 'Incomplete').length, 0);
  assert.ok(!rendered[0]!.includes('global-trace'));
  assert.ok(!rendered[0]!.includes('later.rule.ts'));
  const tail = output().slice(output().lastIndexOf('╯') + 1);
  assert.match(tail, /trace setup\n  message: global-trace/);
  assert.match(tail, /rule later\n  file: later\.rule\.ts/);
});

test('narrow Unicode and ANSI cards wrap by terminal cells without changing grapheme bytes', () => {
  const graphemes = 'e\u0301👩‍💻你🇫🇷✈️'.repeat(12);
  const filepath = `src/${graphemes}/long-unbroken-path-${'x'.repeat(90)}.ts`;
  const subject = scope(`const value = "${graphemes}";`, filepath, 'function:你👩‍💻e\u0301');
  const request = { text: graphemes, path: filepath };
  for (const columns of [24, 41, 80]) {
    const render = (color: boolean): string => {
      const { renderer, output } = capture({ color, columns: () => columns });
      renderer.emit(evaluation(1, subject, 'règle-👩‍💻'));
      renderer.emit({ type: 'request', evaluationId: 1, name: 'règle-👩‍💻', subject, body: JSON.stringify(request) });
      renderer.emit(result(1, subject, { status: 'pass', message: `Accept ${graphemes}` }, 'règle-👩‍💻'));
      renderer.finish();
      return output();
    };
    const plain = render(false);
    const colored = render(true);
    assert.equal(stripVTControlCharacters(colored), plain);
    assert.ok(colored.includes('\u001b['));
    assert.ok(!plain.includes('\u001b'));
    const rendered = cards(colored);
    assert.equal(rendered.length, 1);
    assertWidth(rendered[0]!, columns);
    const joined = content(rendered[0]!).replaceAll('\n', '');
    assert.ok(joined.includes(filepath), joined);
    assertWrappedText(rendered[0]!, `const value = "${graphemes}";`);
    assertWrappedText(rendered[0]!, `Accept ${graphemes}`);
    assert.ok(joined.includes('function:你👩‍💻e\u0301'), joined);
    assert.ok(!joined.includes('é'), joined);
    const wrappedPayload = payload(sections(rendered[0]!, 'Request')[0]!).replaceAll('\n', '');
    assert.deepEqual(JSON.parse(wrappedPayload), request);
    for (const line of content(rendered[0]!).split('\n')) {
      assert.ok(!/^\p{Mark}|^\u200d|\u200d$/u.test(line), JSON.stringify(line));
      assert.ok(!line.endsWith('\ud83d'), JSON.stringify(line));
      assert.ok(!/[\u{1f1e6}-\u{1f1ff}]/u.test(line.replaceAll('🇫🇷', '')), JSON.stringify(line));
    }
  }
});

test('wrapping measures original Bengali clusters and preserves space-combining boundaries', () => {
  const cases = [
    { columns: 24, source: '\u0995\u09c7\u09be'.repeat(20) },
    { columns: 14, source: 'a\u0301 \u0301x' },
  ];
  for (const { columns, source } of cases) {
    const subject = scope(source);
    const render = (color: boolean): string => {
      const { renderer, output } = capture({ color, columns: () => columns });
      renderer.emit(evaluation(1, subject));
      renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: JSON.stringify({ text: source }) });
      renderer.emit(result(1, subject, { status: 'pass', message: source }));
      renderer.finish();
      return output();
    };
    const plain = render(false);
    const colored = render(true);
    assert.equal(stripVTControlCharacters(colored), plain);
    assert.ok(!plain.includes('undefined'), plain);
    assert.ok(!plain.includes(source.normalize()), plain);
    const rendered = cards(colored);
    assert.equal(rendered.length, 1);
    assertWidth(rendered[0]!, columns);
    assertWrappedText(rendered[0]!, source, 3);
    assertWrappedText(rendered[0]!, JSON.stringify(source));
    for (const row of stripVTControlCharacters(rendered[0]!).split('\n').filter(line => line.startsWith('│ '))) {
      assert.ok(!/^\p{Mark}/u.test(row.slice(2, -2)), row);
    }
  }
});

test('cards redact multiline raw and JSON credentials before wrapping, controls and color', () => {
  const secret = 'private\t"key"\r\ncontinued\u001b[31m';
  const redact = createRedactor([secret]);
  const subject = scope(`${secret}\r\n你\tsafe();`, 'src/unsafe\u001b[2J\u0000.ts', 'function:unsafe\u0007', 9);
  const body = JSON.stringify({ credential: secret, nested: { credential: secret }, safe: '日本語' });
  const render = (color: boolean): string => {
    const { renderer, output } = capture({ redact, color, columns: () => 48 });
    renderer.emit(evaluation(1, subject, 'rule\u009b31m'));
    renderer.emit({ type: 'request', evaluationId: 1, name: 'rule\u009b31m', subject, body });
    renderer.emit({ type: 'response', evaluationId: 1, name: 'rule\u009b31m', subject, status: 502, body: `${secret}\n日本語\t\u001b[2J\u0000\b\u009b31m\r\nlast` });
    renderer.emit({ type: 'trace', evaluationId: 1, name: 'rule\u009b31m', message: secret, details: { credential: secret } });
    renderer.emit({ type: 'error', evaluationId: 1, name: 'rule\u009b31m', stage: 'request', message: secret });
    renderer.finish();
    return output();
  };
  const plain = render(false);
  const colored = render(true);
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(plain), plain);
  for (const fragment of ['private', 'continued', '"key"', '\\"key\\"']) assert.ok(!plain.includes(fragment), plain);
  const rendered = cards(plain);
  assert.equal(rendered.length, 1);
  assertWidth(rendered[0]!, 48);
  const text = content(rendered[0]!);
  assert.ok(text.includes('     9 | [REDACTED]\n    10 | [REDACTED]\n    11 | 你  safe();'), text);
  const joined = text.replaceAll('\n', '');
  for (const fragment of ['private', 'continued', 'key']) assert.ok(!joined.includes(fragment), joined);
  for (const escaped of ['\\u001b[2J', '\\u0000', '\\u0008', '\\u009b31m', '\\u0009', '\\u000d']) assert.ok(joined.includes(escaped), joined);
  assert.ok(joined.includes('日本語'), joined);
  assert.ok(joined.includes('last'), joined);
  assert.ok(!/status: (?:pass|violation)/.test(text), text);
});

test('raw wire JSON retains duplicate keys, huge number lexemes and original escapes in both directions', () => {
  const subject = scope('raw();', 'src/raw.ts');
  const raw = '{"name":"placement","file":"src/raw.ts","scope":"function:work","decision":true,"decision":false,"id":900719925474099312345,"huge":1e999,"escaped":"\\u0061\\/\\uD83D\\uDC69\\n\\t\\\""}';
  const { renderer, output } = capture({ columns: () => 500 });
  renderer.emit(evaluation(1, subject));
  renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: raw });
  renderer.emit({ type: 'response', evaluationId: 1, name: 'placement', subject, status: 200, body: raw });
  renderer.emit(result(1, subject));
  renderer.finish();
  const rendered = cards(output());
  assert.equal(rendered.length, 1);
  for (const title of ['Request', 'Response']) {
    const wire = payload(sections(rendered[0]!, title)[0]!);
    assert.equal(wire.split('"decision"').length - 1, 2, wire);
    assert.ok(wire.indexOf('"decision": true') < wire.indexOf('"decision": false'), wire);
    for (const token of ['900719925474099312345', '1e999', '\\u0061', '\\/', '\\uD83D\\uDC69', '\\n', '\\t', '\\"']) assert.ok(wire.includes(token), wire);
    assert.ok(wire.includes('"name": "placement"'), wire);
    assert.ok(wire.includes('"file": "src/raw.ts"'), wire);
    assert.ok(wire.includes('"scope": "function:work"'), wire);
    assert.ok(!wire.includes('"huge": null'), wire);
    assert.ok(!wire.includes('900719925474099300000'), wire);
    assert.ok(!wire.includes('"escaped": "a/'), wire);
  }
});

test('malformed JSON and non-JSON failure bodies retain every line without pretending to parse', () => {
  const subject = scope('raw();');
  const bodies = [
    '{"decision":true,"decision":false,"id":900719925474099312345,"escaped":"\\u0061",BROKEN}',
    'upstream failed\n<html>日本語</html>\nlast line\n',
  ];
  for (const body of bodies) {
    const { renderer, output } = capture({ columns: () => 300 });
    renderer.emit(evaluation(1, subject));
    renderer.emit({ type: 'response', evaluationId: 1, name: 'placement', subject, status: 502, body });
    renderer.finish();
    const rendered = cards(output());
    assert.equal(rendered.length, 1);
    const response = sections(rendered[0]!, 'Response')[0]!;
    const wire = payload(response);
    assert.equal(wire.split('\n').map(line => line.startsWith('      ') ? line.slice(6) : line).join('\n'), body.trimEnd());
    assert.ok(response.includes('    status: HTTP 502'), response);
    assert.match(content(rendered[0]!), /\n  Incomplete ─+\n    status: incomplete$/);
  }
});

test('inspect finish closes an interrupted evaluation once without inferring a report verdict', () => {
  const chunks: string[] = [];
  const subject = scope('interrupted-inspection();');
  const renderer = createInspectRenderer({ write: text => chunks.push(text), headings: () => [], redact: identity });
  renderer.emit(evaluation(1, subject));
  renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: '{"pending":true}' });
  renderer.finish([]);
  const output = chunks.join('');
  renderer.finish([]);
  renderer.emit(result(1, subject));
  assert.equal(chunks.join(''), output);
  const rendered = cards(output);
  assert.equal(rendered.length, 1);
  assert.match(content(rendered[0]!), /\n  Incomplete ─+\n    status: incomplete$/);
  assert.equal(sections(rendered[0]!, 'Result').length, 0);
  assert.ok(!/status: (?:pass|violation)/.test(output), output);
});

test('section dividers fill the fixed card interior without overflowing narrow terminals', () => {
  const subject = scope('你👩‍💻e\u0301();');
  for (const columns of [8, 14, 16, 24, 80, 120]) {
    const { renderer, output } = capture({ columns: () => columns });
    renderer.emit(evaluation(1, subject));
    renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: '{}' });
    renderer.emit({ type: 'response', evaluationId: 1, name: 'placement', subject, status: 200, body: '{}' });
    renderer.emit({ type: 'trace', evaluationId: 1, name: 'placement', message: '你👩‍💻e\u0301' });
    renderer.emit({ type: 'file', evaluationId: 1, name: 'placement', filepath: 'src/你.ts', selected: true });
    renderer.emit(result(1, subject));
    renderer.emit(evaluation(2, subject));
    renderer.emit({ type: 'error', evaluationId: 2, name: 'placement', stage: 'request', message: 'Failed' });
    renderer.emit(evaluation(3, subject));
    renderer.finish();
    const rendered = cards(output());
    assert.equal(rendered.length, 3);
    for (const card of rendered) assertWidth(card, columns);
    for (const [index, titles] of [
      ['Source', 'Request', 'Response', 'Trace', 'File', 'Result'],
      ['Source', 'Error'],
      ['Source', 'Incomplete'],
    ].entries()) {
      const rows = rendered[index]!.split('\n').filter(line => line.startsWith('│ '));
      for (const title of titles) {
        const heading = `  ${title}`;
        const dashCount = Math.max(0, columns - 4 - stringWidth(heading) - 1);
        if (stringWidth(heading) > columns - 4) {
          assertWrappedText(rendered[index]!, heading);
        } else {
          const divider = dashCount === 0 ? heading : `${heading} ${'─'.repeat(dashCount)}`;
          assert.ok(rows.includes(`│ ${divider}${' '.repeat(columns - 4 - stringWidth(divider))} │`), output());
        }
      }
      for (const row of rows) {
        if (/:/.test(row)) assert.ok(!/ ─+ │$/.test(row), row);
      }
    }
    assertWrappedText(rendered[0]!, '你👩‍💻e\u0301();');
  }
});

test('section dividers retain the evaluation width when terminal columns change', () => {
  let columns = 40;
  const subject = scope();
  const { renderer, output } = capture({ color: true, columns: () => columns });
  renderer.emit(evaluation(1, subject));
  columns = 100;
  renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: '{}' });
  renderer.emit(result(1, subject));
  renderer.finish();
  const rendered = cards(output())[0]!;
  assertWidth(rendered, 40);
  for (const title of ['Source', 'Request', 'Result']) {
    assert.ok(output().includes(`\u001b[1m  ${title}\u001b[22m \u001b[2m${'─'.repeat(40 - 4 - title.length - 3)}\u001b[22m │`), output());
  }
});

test('only Request and Response body labels and payloads stay grey across wrapped Unicode rows', () => {
  const source = 'source-not-grey();';
  const subject = scope(source);
  const text = '你👩‍💻e\u0301🇫🇷✈️'.repeat(12);
  for (const columns of [24, 41, 80]) {
    const render = (color: boolean): string => {
      const { renderer, output } = capture({ color, columns: () => columns });
      renderer.emit(evaluation(1, subject));
      renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: JSON.stringify({ text }) });
      renderer.emit({ type: 'response', evaluationId: 1, name: 'placement', subject, status: 502, body: `upstream failure ${text}\nlast failure line` });
      renderer.emit({ type: 'trace', evaluationId: 1, name: 'placement', message: 'trace-not-grey', details: { text } });
      renderer.emit(result(1, subject, { status: 'pass', probability: 0.9, threshold: 0.8 }));
      renderer.finish();
      return output();
    };
    const plain = render(false);
    const colored = render(true);
    assert.equal(stripVTControlCharacters(colored), plain);
    assert.ok(!plain.includes('\u001b'));
    assertWidth(cards(colored)[0]!, columns);
    let title: string | undefined;
    let body = false;
    let greyRows = 0;
    for (const line of colored.split('\n')) {
      const visible = stripVTControlCharacters(line);
      if (!visible.startsWith('│ ')) {
        assert.ok(!line.includes('\u001b[90m'), line);
        continue;
      }
      const inner = visible.slice(2, -2).trimEnd();
      const heading = sectionTitle(inner);
      if (heading !== undefined) {
        title = heading;
        body = false;
      }
      if (inner === '    body:') body = true;
      if ((title === 'Request' || title === 'Response') && body && inner !== '') {
        greyRows += 1;
        assert.match(line, /^│ \u001b\[90m/);
        assert.match(line, /\u001b\[(?:0|39)m * │$/);
        assert.ok(!line.includes('\u001b[2m'), line);
      } else {
        assert.ok(!line.includes('\u001b[90m'), line);
      }
    }
    assert.ok(greyRows > 8, colored);
    assertWrappedText(cards(colored)[0]!, text, 3);
    assertWrappedText(cards(colored)[0]!, source);
  }
});

test('Result renders only provided thresholds next to probability including zero and one', () => {
  const subject = scope();
  for (const threshold of [undefined, 0, 0.12345678901234568, 1]) {
    const { renderer, output } = capture();
    renderer.emit(evaluation(1, subject));
    renderer.emit(result(1, subject, {
      status: 'pass', probability: 0.9, model: 'judge',
      ...(threshold === undefined ? {} : { threshold }),
    }));
    renderer.finish();
    const section = sections(cards(output())[0]!, 'Result')[0]!;
    if (threshold === undefined) assert.ok(!section.includes('threshold:'), section);
    else assert.ok(section.includes(`    probability: 0.9\n    threshold: ${threshold}\n    model: judge`), section);
  }
  const { renderer, output } = capture();
  renderer.emit(evaluation(1, subject));
  renderer.emit(result(1, subject, { status: 'pass', threshold: 0 }));
  renderer.finish();
  assert.match(sections(cards(output())[0]!, 'Result')[0]!, /^    status: pass\n    threshold: 0$/);
});

test('raw evaluations share card metadata and sections without frames, color, wrapping or JSON formatting', () => {
  const long = '你👩‍💻e\u0301'.repeat(60);
  const subject = scope(`\t${long}`, 'src/café.ts', 'function:挨拶', 31);
  const body = `{"exponent":1e+09,"precise":9007199254740993,"text":"${long}","escape":"\\u0061"}`;
  const render = (raw: boolean): string => {
    const { renderer, output } = capture({ raw, color: true, columns: () => 16 });
    renderer.emit(evaluation(1, subject));
    renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body });
    renderer.emit({ type: 'response', evaluationId: 1, name: 'placement', subject, status: 200, body });
    renderer.emit(result(1, subject, { status: 'pass', probability: 0.95, threshold: 0.8 }));
    renderer.finish();
    return output();
  };
  const raw = render(true);
  assert.ok(!/[╭╮╰╯│─\u001b]/u.test(raw), raw);
  assert.match(raw, /^evaluation placement\n  file: src\/café.ts:31-31\n  scope: function:挨拶\n\n  Source\n/);
  assert.ok(raw.includes(`    31 |     ${long}\n`), raw);
  assert.equal(raw.split(`      ${body}\n`).length - 1, 2, raw);
  assert.match(raw, /  Result\n    status: pass\n    probability: 0.95\n    threshold: 0.8\n\n$/);
  assert.equal(raw.split('  file: ').length - 1, 1);
  assert.equal(raw.split('  scope: ').length - 1, 1);
  const card = render(false);
  assert.equal(cards(card).length, 1);
  assertWidth(cards(card)[0]!, 16);
  assert.ok(card.includes('\u001b'), card);
});

test('raw grouped and correlated evaluations retain all members and request-response pairs in order', () => {
  const members = Array.from({ length: 7 }, (_, index) => scope(
    `first-${index}\nsecond-${index}\nthird-${index}\nfourth-${index}\nfifth-${index}\nlast-${index}`,
    `src/member-${index}.ts`, `member-${index}`, 20 + index,
  ));
  const group: GroupSubject = { kind: 'group', group: { type: 'folder', path: 'src' }, members };
  const second = scope('second-evaluation();', 'src/second.ts');
  const { renderer, output } = capture({ raw: true, concurrency: 2, columns: () => 8 });
  renderer.emit({ type: 'group', name: 'placement', subject: group });
  renderer.emit(evaluation(10, group));
  renderer.emit(evaluation(11, second));
  renderer.emit({ type: 'request', evaluationId: 11, name: 'placement', subject: second, body: 'second-request' });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    renderer.emit({ type: 'request', evaluationId: 10, name: 'placement', subject: group, body: `{"attempt":${attempt}}` });
    renderer.emit({ type: 'response', evaluationId: 10, name: 'placement', subject: group, status: attempt === 1 ? 503 : 200, body: `response-${attempt}` });
  }
  assert.equal(output(), '');
  renderer.emit(result(10, group, { status: 'violation', message: 'move group' }));
  const first = output();
  assert.ok(!first.includes('second-evaluation'), first);
  assert.match(first, /^evaluation placement\n  group: folder\n  path: src\n  members: 7\n/);
  assert.deepEqual(first.split('\n').filter(line => /^  (Request|Response|Result)$/.test(line)), [
    '  Request', '  Response', '  Request', '  Response', '  Request', '  Response', '  Result',
  ]);
  for (const [index, member] of members.entries()) {
    assert.equal(first.split(member.filepath).length - 1, 1, first);
    assert.ok(first.includes(`${member.lines!.end} | last-${index}`), first);
  }
  renderer.emit({ type: 'response', evaluationId: 11, name: 'placement', subject: second, status: 200, body: 'second-response' });
  renderer.emit(result(11, second));
  renderer.finish();
  assert.ok(output().startsWith(first));
  assert.ok(output().slice(first.length).includes('second-request'));
  assert.ok(!/[╭╮╰╯│─\u001b]/u.test(output()), output());
});

test('raw errors and repeated finish close partial evaluations without manufacturing results', () => {
  for (const mode of ['finish', 'evaluation-error', 'operation-error'] as const) {
    const subject = scope('unfinished();');
    const { renderer, output } = capture({ raw: true, color: true });
    renderer.emit(evaluation(1, subject));
    renderer.emit({ type: 'request', evaluationId: 1, name: 'placement', subject, body: 'pending\nlast line' });
    assert.ok(output().includes('      pending\n      last line\n'));
    if (mode === 'evaluation-error') {
      renderer.emit({ type: 'error', evaluationId: 1, name: 'placement', stage: 'check', message: 'failed' });
    } else if (mode === 'operation-error') {
      renderer.emit({ type: 'error', stage: 'run', message: 'aborted' });
    }
    renderer.finish();
    const complete = output();
    renderer.finish();
    renderer.emit(result(1, subject));
    renderer.emit(evaluation(2, subject));
    assert.equal(output(), complete);
    assert.equal(complete.includes('  Incomplete\n    status: incomplete'), mode !== 'evaluation-error');
    assert.equal(complete.includes('  Error\n    stage: check\n    message: failed'), mode === 'evaluation-error');
    assert.equal(complete.includes('error\n  stage: run\n  message: aborted'), mode === 'operation-error');
    assert.ok(!/status: (?:pass|violation)/.test(complete), complete);
    assert.ok(!/[╭╮╰╯│─\u001b]/u.test(complete), complete);
  }
});
