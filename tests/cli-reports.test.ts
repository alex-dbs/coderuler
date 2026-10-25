import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import {
  createInspectRenderer,
  createMetadataRenderer,
  createWalkthroughRenderer,
  renderCheckJson,
  renderCheckJsonl,
  renderCheckSummary,
  renderRuleTestHeading,
  renderRuleTestResult,
  renderRuleTestSummary,
} from '../dist/adapter/cli/reports.js';
import type { RuleReport, RunEvent } from '../src/app/ports.js';
import { createRedactor } from '../dist/adapter/cli/text.js';
import type { RuleTestResult } from '../src/app/rule-tests.js';
import type { ScopeSubject } from '../src/app/rule.js';

const identity = (text: string): string => text;
const options = { durationMs: 12.5 };

function walkthroughContent(output: string): string {
  return stripVTControlCharacters(output).split('\n').map(line => {
    const text = line.startsWith('│ ') && line.endsWith(' │') ? line.slice(2, -2).trimEnd() : line;
    return text.replace(/^(  (?:Source|Request|Response|Result|Trace|Error|File|Incomplete)) ─+$/, '$1');
  }).join('\n');
}

function scope(source: string, filepath = 'src/café.ts'): ScopeSubject {
  return { kind: 'scope', filepath, id: 'function:挨拶', source, lines: { start: 9, end: 11 } };
}

function violation(subject: RuleReport['evaluations'][number]['subject'], message?: string): RuleReport {
  return {
    name: 'unicode',
    ruleFile: '.rulekeeper/unicode.rule.ts',
    durationMs: 3.125,
    status: 'violation',
    evaluations: [{ subject, result: message === undefined ? { status: 'violation' } : { status: 'violation', message } }],
  };
}

test('test rows and summaries reuse evaluation duration scaling at unit boundaries', () => {
  for (const [durationMs, formatted] of [
    [0, '0.00ms'],
    [12.5, '12.50ms'],
    [999, '999.00ms'],
    [1_000, '1.00s'],
    [59_999, '60.00s'],
    [60_000, '1.00min'],
    [3_600_000, '1.00h'],
    [86_400_000, '1.00d'],
  ] as const) {
    const result: RuleTestResult = {
      ruleName: 'example', name: 'case', expected: 'pass', actual: 'pass', durationMs,
    };
    const row = renderRuleTestResult(result, identity, false, true);
    const summary = renderRuleTestSummary(1, 0, durationMs, identity, false);
    assert.ok(row.endsWith(` (${formatted})\n`), row);
    assert.ok(summary.includes(`Time: ${formatted}`), summary);
  }
});

test('test timing stays dim while failures, tree branches, and escaped names retain their styles', () => {
  const result: RuleTestResult = {
    ruleName: 'unsafe\u001b[31m', name: 'case\u0007', expected: 'pass', actual: 'timeout', durationMs: 10_000,
  };
  const plain = renderRuleTestResult(result, identity, false, false);
  const colored = renderRuleTestResult(result, identity, true, false);
  assert.match(plain, /^├─ FAIL case\\u0007 \(expected pass, actual timeout\)/);
  assert.ok(plain.endsWith(' (10.00s)\n'));
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.ok(colored.includes('\u001b[31mFAIL\u001b[39m'));
  assert.ok(colored.includes('\u001b[2m (10.00s)\u001b[22m'));
  assert.equal(stripVTControlCharacters(renderRuleTestHeading(result.ruleName, identity, true)), 'unsafe\\u001b[31m\n');
  const summary = renderRuleTestSummary(0, 1, result.durationMs, identity, false);
  assert.equal(stripVTControlCharacters(renderRuleTestSummary(0, 1, result.durationMs, identity, true)), summary);
});

test('numeric test secrets redact fields, counts, and timings before ANSI styling', () => {
  const redact = createRedactor(['1']);
  const result: RuleTestResult = {
    ruleName: 'rule1', name: 'case1', expected: 'pass', actual: 'violation', durationMs: 1,
  };
  const heading = renderRuleTestHeading(result.ruleName, redact, false);
  const coloredHeading = renderRuleTestHeading(result.ruleName, redact, true);
  assert.equal(stripVTControlCharacters(coloredHeading), heading);
  assert.ok(coloredHeading.includes('\u001b[1mrule[REDACTED]\u001b[22m'), coloredHeading);
  for (const lastInRule of [false, true]) {
    const plain = renderRuleTestResult(result, redact, false, lastInRule);
    const colored = renderRuleTestResult(result, redact, true, lastInRule);
    assert.equal(stripVTControlCharacters(colored), plain);
    assert.ok(!plain.includes('1'), plain);
    assert.ok(plain.includes('case[REDACTED]'), plain);
    assert.ok(colored.includes('\u001b[31mFAIL\u001b[39m'), colored);
    assert.ok(colored.includes(`\u001b[2m${lastInRule ? '└─ ' : '├─ '}\u001b[22m`), colored);
    assert.ok(colored.includes('\u001b[2m ([REDACTED].00ms)\u001b[22m'), colored);
  }
  const summary = renderRuleTestSummary(1, 11, 1, redact, false);
  const coloredSummary = renderRuleTestSummary(1, 11, 1, redact, true);
  assert.equal(stripVTControlCharacters(coloredSummary), summary);
  assert.ok(!summary.includes('1'), summary);
  assert.ok(coloredSummary.includes('\u001b[32m[REDACTED] passed\u001b[39m'), coloredSummary);
  assert.ok(coloredSummary.includes('\u001b[31m[REDACTED][REDACTED] failed\u001b[39m'), coloredSummary);
  assert.ok(summary.includes('Time: [REDACTED].00ms'), summary);
});

test('test credentials are redacted before escaping names and mismatch details', () => {
  const credential = 'token\u001b[31mvalue';
  const redact = createRedactor([credential, 'pass', 'timeout']);
  const result: RuleTestResult = {
    ruleName: credential, name: `case ${credential}\u0007`, expected: 'pass', actual: 'timeout', durationMs: 0,
  };
  for (const color of [false, true]) {
    const heading = stripVTControlCharacters(renderRuleTestHeading(result.ruleName, redact, color));
    const row = stripVTControlCharacters(renderRuleTestResult(result, redact, color, true));
    assert.ok(heading.includes('[REDACTED]'), heading);
    assert.ok(row.includes('case [REDACTED]\\u0007'), row);
    assert.ok(row.includes('expected [REDACTED], actual [REDACTED]'), row);
    for (const secret of ['token', 'value', 'pass', 'timeout']) {
      assert.ok(!`${heading}${row}`.includes(secret), row);
    }
  }
});

test('plain diagnostic preserves Unicode and expands source tabs at four-column stops', () => {
  const report = violation(scope('\tconst café = "你好 👋";\r\n\tif (café) {\n\t\t挨拶(café);'));
  assert.equal(
    renderCheckSummary([report], identity, options),
    'Rules: 1  Skipped: 0  Verifications: 1  Violations: 1  Time: 12.50ms\n\n' +
      '🚓 Violations:\n' +
      '  unicode: src/café.ts:9-11\n' +
      '     9 |     const café = "你好 👋";\n' +
      '    10 |     if (café) {\n' +
      '    11 |         挨拶(café);\n\n',
  );
  const midline = renderCheckSummary([violation(scope('a\tb\tend'))], identity, options);
  assert.ok(midline.includes('9 | a   b   end'), midline);
  assert.ok(!midline.includes('\\u0009'), midline);
});

test('source tabs advance by Unicode terminal cells rather than code points', () => {
  const cases = [
    ['你\tx', '你  x'],
    ['e\u0301\tx', 'e\u0301   x'],
    ['👩‍💻\tx', '👩‍💻  x'],
    ['🇫🇷\tx', '🇫🇷  x'],
    ['✈️\tx', '✈️  x'],
    ['a你\tx', 'a你 x'],
    ['你\tx\ty', '你  x   y'],
    ['\u001b[31m\tx', '\\u001b[31m  x'],
  ] as const;
  for (const [source, expected] of cases) {
    const output = renderCheckSummary([violation(scope(source))], identity, options);
    assert.ok(output.includes(`9 | ${expected}\n`), output);
  }
});

test('diagnostics show each rule name once and preserve custom violation messages', () => {
  const absent = renderCheckSummary([violation(scope('bad();'))], identity, options);
  assert.equal(absent.match(/unicode/g)?.length, 1);
  assert.ok(!absent.includes('was violated'), absent);
  assert.ok(!absent.includes('undefined'), absent);
  const custom = renderCheckSummary([violation(scope('bad();'), 'Move this function to the adapter.')], identity, options);
  assert.ok(custom.includes('    Move this function to the adapter.\n'), custom);
  assert.equal(custom.match(/unicode/g)?.length, 1);
});

test('color is opt-in and adds semantic styling without changing readable content', () => {
  const reports: readonly RuleReport[] = [
    violation(scope('bad();'), 'Use the adapter.'),
    { name: 'disabled', ruleFile: 'disabled.rule.ts', durationMs: 0.75, status: 'skipped', reason: 'disabled by settings', evaluations: [] },
  ];
  const plain = renderCheckSummary(reports, identity, { ...options, outputAll: true });
  const colored = renderCheckSummary(reports, identity, { ...options, outputAll: true, color: true });
  assert.ok(!plain.includes('\u001b'), plain);
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.ok(colored.includes('\u001b[1municode\u001b[22m'), colored);
  assert.ok(colored.includes('\u001b[31m'), colored);
  assert.ok(!colored.includes('🚓'), colored);
  assert.ok(colored.includes('\u001b[2msrc/café.ts:9-11\u001b[22m'), colored);
  assert.ok(colored.includes('\u001b[2m    9 |\u001b[22m'), colored);
  assert.match(colored, /\u001b\[33m/);
  const passing = renderCheckSummary([{ name: 'pass', ruleFile: 'pass.rule.ts', durationMs: 2.25, status: 'pass', evaluations: [] }], identity, { ...options, color: true });
  assert.match(passing, /\u001b\[32m/);
});

test('short secrets are redacted before styling without damaging ANSI sequences', () => {
  const report = violation(scope('m = 1;', 'src/main.ts'), 'Remove m.');
  const redact = createRedactor(['m']);
  const plain = renderCheckSummary([report], redact, options);
  const colored = renderCheckSummary([report], redact, { ...options, color: true });
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.ok(colored.includes('\u001b[1municode\u001b[22m'), colored);
  assert.ok(plain.includes('[REDACTED] = 1;'), plain);
  assert.ok(plain.includes('src/[REDACTED]ain.ts'), plain);
});

test('hostile controls are escaped while Unicode source and custom messages stay readable', () => {
  const report = violation(scope('日本語\u001b[31m\u0000\b\u009b31m', 'src/\u001b[2J.ts'), 'unsafe\rmessage\u0007');
  const plain = renderCheckSummary([report], identity, options);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(plain), plain);
  assert.ok(plain.includes('日本語\\u001b[31m\\u0000\\u0008\\u009b31m'), plain);
  assert.ok(plain.includes('src/\\u001b[2J.ts'), plain);
  assert.ok(plain.includes('unsafe\\u000dmessage\\u0007'), plain);
  assert.equal(stripVTControlCharacters(renderCheckSummary([report], identity, { ...options, color: true })), plain);
});

test('source credentials are redacted before line splitting, tab expansion, truncation, or ANSI styling', () => {
  const secrets = ['begin\tmiddle\r\nend', 'token\u001b[31mvalue', '5 | label', 'joined\nsecret'];
  const redact = createRedactor(secrets);
  const report: RuleReport = {
    ...violation(scope(secrets.join('\n'))),
    name: secrets[1]!,
    evaluations: [{ subject: scope(secrets.join('\n'), secrets[2]!), result: { status: 'violation', message: secrets[0]! } }],
  };
  for (const color of [false, true]) {
    const output = stripVTControlCharacters(renderCheckSummary([report], redact, { ...options, color }));
    for (const fragment of ['begin', 'middle', 'end', 'token', 'value', 'label', 'joined', 'secret']) {
      assert.ok(!output.includes(fragment), output);
    }
    assert.equal(output.match(/\[REDACTED\]/g)?.length, 9);
  }
  const crossingLimit = scope('1\n2\n3\n4\njoined\nsecret\n7');
  const output = renderCheckSummary([violation(crossingLimit)], redact, options);
  assert.ok(output.includes('[REDACTED]'), output);
  assert.ok(!output.includes('joined'), output);
});

test('multiline credentials retain original source coordinates and excerpt limits for LF and CRLF', () => {
  for (const separator of ['\n', '\r\n', '\r']) {
    const secret = `private${separator}key`;
    const redact = createRedactor([secret]);
    assert.equal(redact(secret), `[REDACTED]${separator}[REDACTED]`);
    const subject = scope(`private${separator}key${separator}bad()${separator}four${separator}five${separator}hidden()`);
    for (const color of [false, true]) {
      const output = stripVTControlCharacters(renderCheckSummary([violation(subject)], redact, { ...options, color }));
      assert.ok(output.includes('     9 | [REDACTED]\n    10 | [REDACTED]\n    11 | bad()\n'), output);
      assert.ok(output.includes('    13 | five\n'), output);
      assert.ok(output.includes('1 more line;'), output);
      assert.ok(!output.includes('private'), output);
      assert.ok(!output.includes('key'), output);
      assert.ok(!output.includes('hidden()'), output);
    }
    const chunks: string[] = [];
    const renderer = createWalkthroughRenderer({ write: text => chunks.push(text), headings: () => [], redact });
    renderer.emit({ type: 'scope', name: 'safe', subject, accepted: true });
    renderer.emit({ type: 'evaluation', evaluationId: 1, name: 'safe', subject });
    renderer.emit({ type: 'result', evaluationId: 1, name: 'safe', subject, result: { status: 'pass' } });
    renderer.finish();
    assert.ok(walkthroughContent(chunks.join('')).includes('    14 | hidden()\n'), chunks.join(''));
    const acrossLimit = renderCheckSummary([
      violation(scope(`one${separator}two${separator}three${separator}four${separator}${secret}${separator}bad()`)),
    ], redact, options);
    assert.ok(acrossLimit.includes('    13 | [REDACTED]\n'), acrossLimit);
    assert.ok(acrossLimit.includes('2 more lines;'), acrossLimit);
    assert.ok(!acrossLimit.includes('private'), acrossLimit);
  }
});

test('grouped diagnostics redact member sources and retain structured locations', () => {
  const report = violation({
    kind: 'group',
    group: { type: 'folder', path: 'src' },
    members: [scope('\tpassword=secret\tvalue', 'src/one.ts'), scope('\t你好', 'src/two.ts')],
  });
  const output = renderCheckSummary([report], createRedactor(['secret\tvalue']), { ...options, color: true });
  const plain = stripVTControlCharacters(output);
  assert.ok(plain.includes('unicode: group folder src (2 members)'), plain);
  assert.ok(plain.includes('src/one.ts:9-11 function:挨拶'), plain);
  assert.ok(plain.includes('9 |     password=[REDACTED]'), plain);
  assert.ok(plain.includes('9 |     你好'), plain);
  assert.ok(!plain.includes('secret'), plain);
});

test('machine reports default to violating rules and evaluations without mutating input', () => {
  const reports: readonly RuleReport[] = [
    {
      ...violation(scope('bad();'), 'custom\tmessage'),
      evaluations: [
        { subject: scope('good();'), result: { status: 'pass' } },
        { subject: scope('\t你好\r\n\u001b[31msecret\u0000'), result: { status: 'violation', message: 'custom\tmessage' } },
      ],
    },
    { name: 'pass', ruleFile: 'pass.rule.ts', durationMs: 2.25, status: 'pass', evaluations: [{ subject: scope('good();'), result: { status: 'pass' } }] },
    { name: 'skipped', ruleFile: 'skipped.rule.ts', durationMs: 0.75, status: 'skipped', reason: 'not applicable', evaluations: [] },
  ];
  const original = structuredClone(reports);
  for (const report of reports) {
    Object.freeze(report.evaluations);
    Object.freeze(report);
  }
  Object.freeze(reports);
  const expected = [{ ...reports[0], evaluations: [reports[0]!.evaluations[1]] }];
  assert.deepEqual(JSON.parse(renderCheckJson(reports, options)), { durationMs: 12.5, reports: expected });
  const jsonl = renderCheckJsonl(reports, options);
  assert.ok(jsonl.endsWith('\n'));
  assert.deepEqual(jsonl.trimEnd().split('\n').map(line => JSON.parse(line)), [
    { type: 'rule', ...expected[0] },
  ]);
  assert.equal(JSON.parse(jsonl.trimEnd()).durationMs, 3.125);
  assert.ok(!jsonl.includes('"type":"summary"'), jsonl);
  assert.deepEqual(reports, original);
});

test('output-all machine reports preserve every report, evaluation and optional field', () => {
  const reports: readonly RuleReport[] = [
    {
      ...violation(scope('bad();')),
      evaluations: [
        { subject: scope('good();'), result: { status: 'pass' } },
        { subject: scope('bad();'), result: { status: 'violation' } },
      ],
    },
    { name: 'pass', ruleFile: 'pass.rule.ts', durationMs: 2.25, status: 'pass', evaluations: [{ subject: scope('good();'), result: { status: 'pass' } }] },
    { name: 'skipped', ruleFile: 'skipped.rule.ts', durationMs: 0.75, status: 'skipped', reason: 'not applicable', evaluations: [] },
  ];
  const allOptions = { ...options, outputAll: true };
  assert.deepEqual(JSON.parse(renderCheckJson(reports, allOptions)), { durationMs: 12.5, reports });
  assert.deepEqual(renderCheckJsonl(reports, allOptions).trimEnd().split('\n').map(line => JSON.parse(line)), [
    ...reports.map(report => ({ type: 'rule', ...report })),
  ]);
  assert.ok(!renderCheckJson(reports, allOptions).includes('"message"'));
});

test('machine reports preserve exact numeric thresholds without inventing deterministic metadata', () => {
  const results = [
    { status: 'pass' as const, probability: 1, threshold: 0 },
    { status: 'violation' as const, probability: 1, threshold: 1 },
    { status: 'pass' as const, probability: 0.9876543210987654, threshold: 0.12345678901234568 },
    { status: 'violation' as const },
  ];
  const reports: readonly RuleReport[] = [{
    ...violation(scope('decision();')),
    evaluations: results.map(result => ({ subject: scope('decision();'), result })),
  }];
  for (const outputAll of [false, true]) {
    const expected = results.filter(result => outputAll || result.status === 'violation');
    const json = JSON.parse(renderCheckJson(reports, { ...options, outputAll }));
    const jsonl = JSON.parse(renderCheckJsonl(reports, { ...options, outputAll }).trimEnd());
    for (const report of [json.reports[0], jsonl]) {
      assert.deepEqual(report.evaluations.map((evaluation: RuleReport['evaluations'][number]) => evaluation.result), expected);
      assert.ok(!Object.hasOwn(report.evaluations.at(-1).result, 'threshold'));
    }
  }
});

test('empty, passing and skipped machine reports keep JSON totals but emit no filtered JSONL records', () => {
  const skipped: RuleReport = { name: 'skip', ruleFile: 'skip.rule.ts', durationMs: 0.75, status: 'skipped', evaluations: [] };
  const pass: RuleReport = { name: 'pass', ruleFile: 'pass.rule.ts', durationMs: 2.25, status: 'pass', evaluations: [] };
  for (const reports of [[], [skipped], [pass]]) {
    assert.deepEqual(JSON.parse(renderCheckJson(reports, { durationMs: 0 })), { durationMs: 0, reports: [] });
    assert.equal(renderCheckJsonl(reports, { durationMs: 0 }), '');
  }
  assert.deepEqual(JSON.parse(renderCheckJson([skipped], { ...options, outputAll: true })), { durationMs: 12.5, reports: [skipped] });
  assert.equal(renderCheckJsonl([], { durationMs: 0, outputAll: true }), '');
});

test('summary counts the full run but includes skipped and passing details only with output-all', () => {
  const reports: readonly RuleReport[] = [
    {
      ...violation(scope('bad();')),
      name: 'mixed',
      evaluations: [
        { subject: scope('good();', 'src/pass.ts'), result: { status: 'pass' } },
        { subject: scope('bad();', 'src/fail.ts'), result: { status: 'violation' } },
      ],
    },
    { name: 'skip', ruleFile: 'skip.rule.ts', durationMs: 0.75, status: 'skipped', reason: 'not applicable', evaluations: [] },
  ];
  const original = structuredClone(reports);
  const plain = renderCheckSummary(reports, identity, options);
  assert.ok(plain.startsWith('Rules: 2  Skipped: 1  Verifications: 2  Violations: 1  Time: 12.50ms\n'), plain);
  assert.ok(plain.includes('\n🚓 Violations:\n  mixed: src/fail.ts'), plain);
  assert.equal(plain.match(/🚓/g)?.length, 1);
  assert.ok(!plain.includes('src/pass.ts'), plain);
  assert.ok(!plain.includes('not applicable'), plain);
  const all = renderCheckSummary(reports, identity, { ...options, outputAll: true });
  assert.ok(all.includes('✓ mixed: src/pass.ts'), all);
  assert.ok(all.includes('\n  mixed: src/fail.ts'), all);
  assert.ok(all.includes('\nVerifications:\n'), all);
  assert.ok(!all.includes('🚓'), all);
  assert.ok(all.includes('skip: not applicable'), all);
  assert.ok(!all.includes('undefined'), all);
  const colored = renderCheckSummary(reports, identity, { ...options, outputAll: true, color: true });
  assert.equal(stripVTControlCharacters(colored), all);
  assert.ok(colored.includes('\u001b[32m✓\u001b[39m'), colored);
  assert.ok(!all.includes('pass mixed:'), all);
  assert.ok(colored.includes('\u001b[32m\u001b[1mmixed\u001b[22m\u001b[39m'), colored);
  assert.ok(colored.includes('\u001b[31m\u001b[1mmixed\u001b[22m\u001b[39m'), colored);
  assert.deepEqual(reports, original);
});

test('output-all lists every verification while source excerpts and group members stay bounded', () => {
  const members = Array.from({ length: 7 }, (_, index) => scope('one\ntwo\nthree\nfour\nfive\nsix', `src/member${index}.ts`));
  const report: RuleReport = {
    ...violation(scope('bad();')),
    evaluations: [
      ...Array.from({ length: 12 }, (_, index) => ({
        subject: scope('one\ntwo\nthree\nfour\nfive\nsix', `src/pass${index}.ts`),
        result: { status: 'pass' as const },
      })),
      { subject: { kind: 'group', group: { type: 'folder', path: 'src' }, members }, result: { status: 'violation' } },
    ],
  };
  const output = renderCheckSummary([report], identity, { ...options, outputAll: true });
  assert.equal(output.match(/  ✓ unicode:/g)?.length, 12);
  assert.ok(output.includes('src/pass11.ts'), output);
  assert.ok(output.includes('1 more line; rerun with --json --output-all or --jsonl --output-all'), output);
  assert.ok(output.includes('2 more members; rerun with --json --output-all or --jsonl --output-all'), output);
  assert.ok(!output.includes('src/member5.ts'), output);
  assert.ok(!output.includes('six'), output);
  const violations: RuleReport = {
    ...report,
    evaluations: Array.from({ length: 12 }, (_, index) => ({
      subject: scope('bad();', `src/fail${index}.ts`), result: { status: 'violation' as const },
    })),
  };
  const bounded = renderCheckSummary([violations], identity, options);
  assert.ok(bounded.includes('2 more violations; rerun with --json or --jsonl'), bounded);
  assert.ok(!bounded.includes('src/fail11.ts'), bounded);
  const allViolations = renderCheckSummary([violations], identity, { ...options, outputAll: true });
  assert.equal(allViolations.match(/  unicode:/g)?.length, 12);
  assert.ok(!allViolations.includes('🚓'), allViolations);
});

test('passing output-all diagnostics preserve custom messages and redact before styling and source layout', () => {
  const secret = 'private\tvalue\r\ncontinued';
  const redact = createRedactor([secret]);
  const report: RuleReport = {
    name: 'safe\u001b[2J',
    ruleFile: 'safe.rule.ts',
    durationMs: 2.25,
    status: 'pass',
    evaluations: [{
      subject: scope(`${secret}\r\n你\tgood();`, 'src/safe\u0000.ts'),
      result: { status: 'pass', message: `Accepted ${secret}` },
    }],
  };
  const plain = renderCheckSummary([report], redact, { ...options, outputAll: true });
  const colored = renderCheckSummary([report], redact, { ...options, outputAll: true, color: true });
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.ok(plain.includes('✓ safe\\u001b[2J: src/safe\\u0000.ts:9-11'), plain);
  assert.ok(plain.includes('Accepted [REDACTED]\\u000d\\u000a[REDACTED]'), plain);
  assert.ok(plain.includes('     9 | [REDACTED]\n    10 | [REDACTED]\n    11 | 你  good();'), plain);
  assert.ok(!plain.includes('private'), plain);
  assert.ok(!plain.includes('continued'), plain);
  assert.ok(!plain.includes('🚓'), plain);
});

test('empty summaries include duration without inventing details', () => {
  const output = renderCheckSummary([], identity, { durationMs: 0, outputAll: true });
  assert.equal(output, 'Rules: 0  Skipped: 0  Verifications: 0  Violations: 0  Time: 0.00ms\n\nNo verifications were run.\n');
});

test('console duration scales at standard boundaries with two decimals and no suffix space', () => {
  const cases = [
    [0, '0.00ms'],
    [0.125, '0.13ms'],
    [23.49, '23.49ms'],
    [999, '999.00ms'],
    [1000, '1.00s'],
    [23490, '23.49s'],
    [59999, '60.00s'],
    [60000, '1.00min'],
    [90000, '1.50min'],
    [3599999, '60.00min'],
    [3600000, '1.00h'],
    [5400000, '1.50h'],
    [86399999, '24.00h'],
    [86400000, '1.00d'],
    [216000000, '2.50d'],
    [8640000000, '100.00d'],
  ] as const;
  for (const [durationMs, expected] of cases) {
    const output = renderCheckSummary([], identity, { durationMs });
    assert.ok(output.includes(`Time: ${expected}\n`), output);
  }
});

test('metadata and walkthrough render real phase-specific progress', () => {
  const events: readonly RunEvent[] = [
    { type: 'progress', phase: 'selection', completed: 1, total: 2 },
    { type: 'progress', phase: 'evaluation', completed: 3, total: 5 },
  ];
  for (const create of [
    (write: (text: string) => void) => createMetadataRenderer(write, identity),
    (write: (text: string) => void) => createWalkthroughRenderer({ write, headings: () => [], redact: identity }).emit,
  ]) {
    const chunks: string[] = [];
    events.forEach(create(text => chunks.push(text)));
    const output = chunks.join('');
    assert.match(output, /selection.*1\/2/);
    assert.match(output, /evaluation.*3\/5/);
  }
});

test('metadata includes evaluation IDs without adopting card presentation', () => {
  const chunks: string[] = [];
  const subject = scope('safe();');
  const emit = createMetadataRenderer(text => chunks.push(text), identity);
  emit({ type: 'evaluation', evaluationId: 41, name: 'placement', subject });
  assert.equal(chunks.join(''), 'evaluation 41 placement src/café.ts function:挨拶\n');
  assert.ok(!chunks.join('').includes('╭'));
});

test('walkthrough card source expands indentation without exposing multiline credentials', () => {
  const chunks: string[] = [];
  const subject = scope('\t你好\nprivate\tkey\ncontinued');
  const renderer = createWalkthroughRenderer({
    write: text => chunks.push(text), headings: () => [], redact: createRedactor(['private\tkey\ncontinued']),
  });
  renderer.emit({ type: 'scope', name: 'safe', subject, accepted: true });
  renderer.emit({ type: 'evaluation', evaluationId: 1, name: 'safe', subject });
  renderer.emit({ type: 'result', evaluationId: 1, name: 'safe', subject, result: { status: 'pass' } });
  renderer.finish();
  const output = walkthroughContent(chunks.join(''));
  assert.ok(output.includes('9 |     你好'), output);
  assert.ok(output.includes('[REDACTED]'), output);
  assert.ok(!output.includes('private'), output);
  assert.ok(!output.includes('continued'), output);
  assert.equal(output.match(/9 \|/g)?.length, 1, output);
});

test('walkthrough retains plain setup blocks and nests an evaluation in one rounded card', () => {
  const subject = scope('你\tfirst();\n\tsecond();');
  const events: readonly RunEvent[] = [
    { type: 'rule', name: 'placement', ruleFile: '.rulekeeper/placement.rule.ts' },
    { type: 'gate', name: 'placement', enabled: true, applies: true },
    { type: 'file', name: 'other-rule', filepath: 'src/other.ts', selected: false, reason: 'outside selection' },
    { type: 'scope', name: 'placement', subject, accepted: true },
    { type: 'evaluation', evaluationId: 1, name: 'placement', subject },
    { type: 'result', evaluationId: 1, name: 'placement', subject, result: { status: 'pass', message: 'Correct layer', probability: 0.99, model: 'local' } },
    { type: 'error', name: 'other-rule', stage: 'evaluation', message: 'Backend unavailable' },
  ];
  const chunks: string[] = [];
  const renderer = createWalkthroughRenderer({
    write: text => chunks.push(text),
    headings: () => [
      '  file: .rulekeeper/placement.rule.ts',
      '  files: ["src/**/*.ts"]',
      '  settings: {"backend":"local","threshold":0.9}',
    ],
    redact: identity,
  });
  events.forEach(renderer.emit);
  renderer.finish();
  const raw = chunks.join('');
  const output = walkthroughContent(raw);
  assert.match(output, /rule placement\n  file: \.rulekeeper\/placement\.rule\.ts\n/);
  assert.match(output, /  settings:\n    \{\n      "backend": "local",\n      "threshold": 0\.9\n    \}/);
  assert.match(output, /  files:\n    \[\n      "src\/\*\*\/\*\.ts"\n    \]/);
  assert.match(output, /file other-rule\n  file: src\/other\.ts\n  status: excluded\n  reason: outside selection/);
  assert.equal(raw.match(/^╭─+╮$/gm)?.length, 1, raw);
  assert.equal(raw.match(/^╰─+╯$/gm)?.length, 1, raw);
  const card = output.slice(output.indexOf('evaluation placement'));
  assert.match(card, /evaluation placement\n  file: src\/café\.ts:9-11\n  scope: function:挨拶\n\n  Source\n/);
  assert.ok(card.includes('     9 | 你  first();\n    10 |     second();'), card);
  assert.match(card, /  Result\n    status: pass\n    message: Correct layer\n    probability: 0\.99\n    model: local/);
  assert.equal(card.match(/file: src\/café\.ts/g)?.length, 1, card);
  assert.match(output, /error other-rule\n  stage: evaluation\n  message: Backend unavailable/);
});

test('walkthrough status colors are opt-in and preserve plain card and setup content', () => {
  const subject = scope('safe();');
  const events: readonly RunEvent[] = [
    { type: 'gate', name: 'rule', enabled: true, applies: true },
    { type: 'gate', name: 'rule', enabled: false, applies: false },
    { type: 'gate', name: 'rule', enabled: true, applies: false, reason: 'not applicable' },
    { type: 'file', name: 'rule', filepath: 'src/a.ts', selected: true },
    { type: 'file', name: 'rule', filepath: 'src/b.ts', selected: false },
    { type: 'scope', name: 'rule', subject, accepted: true },
    { type: 'scope', name: 'rule', subject, accepted: false },
    { type: 'evaluation', evaluationId: 1, name: 'rule', subject },
    { type: 'result', evaluationId: 1, name: 'rule', subject, result: { status: 'pass' } },
    { type: 'evaluation', evaluationId: 2, name: 'rule', subject },
    { type: 'response', evaluationId: 2, name: 'rule', subject, status: 503, body: 'Unavailable' },
    { type: 'result', evaluationId: 2, name: 'rule', subject, result: { status: 'violation' } },
    { type: 'error', name: 'rule', stage: 'request', message: 'Request failed' },
    { type: 'progress', phase: 'evaluation', completed: 2, total: 3 },
  ];
  const render = (color = false): string => {
    const chunks: string[] = [];
    const renderer = createWalkthroughRenderer({ write: text => chunks.push(text), headings: () => [], redact: identity, color });
    events.forEach(renderer.emit);
    renderer.finish();
    return chunks.join('');
  };
  const plain = render();
  const colored = render(true);
  assert.ok(!plain.includes('\u001b'));
  assert.equal(stripVTControlCharacters(colored), plain);
  for (const status of ['applies', 'selected', 'pass']) {
    assert.ok(colored.includes(`\u001b[32m${status}\u001b[39m`), colored);
  }
  for (const status of ['disabled', 'skipped', 'excluded', 'filtered']) {
    assert.ok(colored.includes(`\u001b[33m${status}\u001b[39m`), colored);
  }
  assert.ok(colored.includes('\u001b[31mviolation\u001b[39m'), colored);
  assert.ok(colored.includes('\u001b[31mHTTP 503\u001b[39m'), colored);
  assert.ok(colored.includes('\u001b[31merror\u001b[39m'), colored);
  assert.ok(colored.includes('\u001b[1mrule\u001b[22m'), colored);
  assert.ok(colored.includes('\u001b[2m'), colored);
  assert.ok(!colored.includes('\r'), colored);
});

test('wire requests, structured responses and correlated traces retain complete JSON payloads', () => {
  const subject = scope('safe();');
  const request = { model: 'local', messages: [{ role: 'user', content: 'first\nsecond' }], tail: 'x'.repeat(12000) };
  const response = { choices: [{ message: { content: '{"status":"pass"}' } }], usage: { total_tokens: 42 } };
  const details = { files: { 'src/a.ts': { scopes: { 'function:α': { selected: true } } } } };
  const events: readonly RunEvent[] = [
    { type: 'evaluation', evaluationId: 1, name: 'rule', subject },
    { type: 'request', evaluationId: 1, name: 'rule', subject, body: JSON.stringify(request) },
    { type: 'response', evaluationId: 1, name: 'rule', subject, status: 200, body: JSON.stringify(response) },
    { type: 'trace', evaluationId: 1, name: 'rule', message: 'Resolved subjects', details },
    { type: 'result', evaluationId: 1, name: 'rule', subject, result: { status: 'pass' } },
  ];
  const chunks: string[] = [];
  const renderer = createWalkthroughRenderer({
    write: text => chunks.push(text), headings: () => [], redact: identity, columns: () => 20000,
  });
  events.forEach(renderer.emit);
  renderer.finish();
  const output = walkthroughContent(chunks.join(''));
  for (const [title, label, value, next] of [
    ['Request', 'body', request, 'Response'],
    ['Response', 'body', response, 'Trace'],
    ['Trace', 'details', details, 'Result'],
  ] as const) {
    const section = output.split(`  ${title}\n`)[1]!.split(`\n\n  ${next}\n`)[0]!;
    const payload = section.split(`    ${label}:\n`)[1]!;
    assert.ok(payload.startsWith('      {\n        "'), payload);
    assert.deepEqual(JSON.parse(payload), value);
    assert.ok(!payload.includes('\\u000a'), payload);
  }
  assert.ok(output.includes('"content": "first\\nsecond"'), output);
  assert.match(output, /  Trace\n    message: Resolved subjects\n    details:\n/);
});

test('wire JSON presentation preserves duplicate keys, huge numbers and original string escapes', () => {
  const bodies = [
    '{"decision":true,"decision":false,"id":900719925474099312345,"escaped":"\\u0061"}',
    '{"decision":true,"decision":false,"id":900719925474099312345,"huge":1e999,"escaped":"\\u0061"}',
    '{"decision":true,"decision":false,"id":900719925474099312345,"escaped":"\\u0061",BROKEN}',
  ];
  for (const [index, body] of bodies.entries()) {
    const chunks: string[] = [];
    const subject = scope('safe();');
    const renderer = createWalkthroughRenderer({
      write: text => chunks.push(text), headings: () => [], redact: identity, columns: () => 300,
    });
    renderer.emit({ type: 'evaluation', evaluationId: 1, name: 'rule', subject });
    renderer.emit({ type: 'response', evaluationId: 1, name: 'rule', subject, status: 200, body });
    renderer.finish();
    const output = walkthroughContent(chunks.join(''));
    assert.equal(output.match(/"decision"/g)?.length, 2, output);
    for (const token of ['900719925474099312345', '\\u0061']) {
      assert.ok(output.includes(token), output);
    }
    if (index === 0) assert.ok(output.includes('    body:\n      {\n        "decision": true,'), output);
    if (index === 1) assert.ok(output.includes('1e999'), output);
    if (index === 2) assert.ok(output.includes(`    body:\n      ${body}\n`), output);
    assert.ok(!output.includes('"huge": null'), output);
  }
});

test('plain failure bodies retain all lines and expose hostile controls without executing them', () => {
  const body = 'upstream failed\n<html>\t日本語\u001b[2J\u0000\b\u009b31m</html>\r\nlast line\n';
  const chunks: string[] = [];
  const subject = scope('safe();', 'src/\u0000.ts');
  const renderer = createWalkthroughRenderer({
    write: text => chunks.push(text), headings: () => [], redact: identity, columns: () => 300,
  });
  renderer.emit({ type: 'evaluation', evaluationId: 1, name: 'rule\u001b[31m', subject });
  renderer.emit({ type: 'response', evaluationId: 1, name: 'rule\u001b[31m', subject, status: 502, body });
  renderer.finish();
  const output = walkthroughContent(chunks.join(''));
  assert.match(output, /evaluation rule\\u001b\[31m\n/);
  assert.ok(output.includes('    body:\n      upstream failed\n      <html>\\u0009日本語\\u001b[2J\\u0000\\u0008\\u009b31m</html>\\u000d\n      last line\n'), output);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(output), output);
});

test('walkthrough redacts raw and JSON-escaped credentials before formatting and styles', () => {
  const secret = 'private\t"key"\r\ncontinued\u001b[31m';
  const redact = createRedactor([secret, 'm']);
  const subject = scope(`${secret}\r\n你\tsafe();`, 'src/main.ts');
  const payload = JSON.stringify({ credential: secret, nested: { credential: secret } });
  const events: readonly RunEvent[] = [
    { type: 'rule', name: 'main', ruleFile: 'main.rule.ts' },
    { type: 'scope', name: 'main', subject, accepted: true },
    { type: 'evaluation', evaluationId: 1, name: 'main', subject },
    { type: 'request', evaluationId: 1, name: 'main', subject, body: payload },
    { type: 'response', evaluationId: 1, name: 'main', subject, status: 200, body: payload },
    { type: 'trace', evaluationId: 1, name: 'main', message: secret, details: { credential: secret } },
    { type: 'error', evaluationId: 1, name: 'main', stage: 'request', message: secret },
  ];
  const render = (color: boolean): string => {
    const chunks: string[] = [];
    const renderer = createWalkthroughRenderer({
      write: text => chunks.push(text), headings: () => [`  settings: {"credential":${JSON.stringify(secret)}}`], redact, color,
    });
    events.forEach(renderer.emit);
    renderer.finish();
    return chunks.join('');
  };
  const plain = render(false);
  const colored = render(true);
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.ok(colored.includes('\u001b[1m[REDACTED]ain\u001b[22m'), colored);
  assert.ok(walkthroughContent(plain).includes('     9 | [REDACTED]\n    10 | [REDACTED]\n    11 | 你  safe();'), plain);
  for (const fragment of ['private', 'continued', '\\"key\\"', 'key', '31m']) {
    assert.ok(!plain.includes(fragment), plain);
  }
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(plain), plain);
});

test('inspect fallback skip explanations use the shared block hierarchy and semantic color once', () => {
  const chunks: string[] = [];
  const renderer = createInspectRenderer({ write: text => chunks.push(text), headings: () => [], redact: identity, color: true });
  renderer.emit({ type: 'gate', name: 'disabled', enabled: false, applies: false, reason: 'disabled by settings' });
  const reports: readonly RuleReport[] = [
    { name: 'disabled', ruleFile: 'disabled.rule.ts', status: 'skipped', durationMs: 0, reason: 'disabled by settings', evaluations: [] },
    { name: 'empty', ruleFile: 'empty.rule.ts', status: 'skipped', durationMs: 0, evaluations: [] },
    { name: 'filtered', ruleFile: 'filtered.rule.ts', status: 'skipped', durationMs: 0, reason: 'all scopes filtered', evaluations: [] },
  ];
  renderer.finish(reports);
  renderer.finish(reports);
  assert.equal(chunks.length, 3);
  const plain = chunks.map(stripVTControlCharacters);
  assert.ok(plain[1]!.startsWith('result empty\n  status: skipped\n  reason: no matching subjects\n\n'), plain[1]);
  assert.ok(plain[2]!.includes('  reason: all scopes filtered\n\n'), plain[2]);
  assert.ok(chunks[1]!.includes('\u001b[33mskipped\u001b[39m'), chunks[1]);
});

test('raw standalone metadata and traces preserve original serialized text without styling', () => {
  const chunks: string[] = [];
  const settings = '{"exponent":1e+09,"precise":9007199254740993,"escape":"\\u0061"}';
  const renderer = createWalkthroughRenderer({
    write: text => chunks.push(text),
    headings: () => [`  files: ["src/**","lib/**"]`, `  settings: ${settings}`],
    redact: identity, raw: true, color: true, columns: () => 8,
  });
  renderer.emit({ type: 'rule', name: 'unicode', ruleFile: 'unicode.rule.ts' });
  renderer.emit({ type: 'trace', name: 'unicode', message: '你好 👋', details: { nested: [1, 'value'] } });
  renderer.finish();
  const output = chunks.join('');
  assert.equal(output,
    'rule unicode\n  file: unicode.rule.ts\n  files:\n    ["src/**","lib/**"]\n' +
    `  settings:\n    ${settings}\n\n` +
    'trace unicode\n  message: 你好 👋\n  details:\n    {"nested":[1,"value"]}\n\n');
  assert.ok(!output.includes('\u001b'));
});

test('raw source and plain payloads redact multiline credentials before escaping hostile controls', () => {
  const secret = 'private\t"key"\r\ncontinued\u001b[31m';
  const subject = scope(`${secret}\r\n你\t日本語\u001b[2J\u0000\b\u009b31m`, 'src/café.ts');
  const redact = createRedactor([secret]);
  const chunks: string[] = [];
  const renderer = createInspectRenderer({
    write: text => chunks.push(text), headings: () => [], redact, raw: true, color: true, columns: () => 8,
  });
  renderer.emit({ type: 'scope', name: 'unicode', subject, accepted: true });
  renderer.emit({ type: 'evaluation', evaluationId: 1, name: 'unicode', subject });
  renderer.emit({ type: 'request', evaluationId: 1, name: 'unicode', subject, body: `before\n${secret}\nafter\u001b[2J\u0007` });
  renderer.emit({ type: 'response', evaluationId: 1, name: 'unicode', subject, status: 503, body: JSON.stringify({ credential: secret, text: '你好 👋' }) });
  renderer.emit({ type: 'error', evaluationId: 1, name: 'unicode', stage: 'request', message: secret });
  renderer.finish([], secret);
  const output = chunks.join('');
  renderer.finish([], 'late failure');
  renderer.emit({ type: 'trace', name: 'late', message: 'must be ignored' });
  assert.equal(chunks.join(''), output);
  assert.ok(output.includes('     9 | [REDACTED]\n    10 | [REDACTED]\n    11 | 你  日本語\\u001b[2J\\u0000\\u0008\\u009b31m\n'), output);
  assert.ok(output.includes('      before\n      [REDACTED]\\u000d\n      [REDACTED]\n      after\\u001b[2J\\u0007\n'), output);
  assert.ok(output.includes('"text":"你好 👋"'), output);
  for (const fragment of ['private', 'continued', '"key"', '\\"key\\"', '\\\\u001b[31m']) {
    assert.ok(!output.includes(fragment), output);
  }
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(output), output);
  assert.ok(!/[╭╮╰╯│─]/u.test(output), output);
});

test('raw inspect skips suppress forced color and preserve distinct skip explanations once', () => {
  const chunks: string[] = [];
  const renderer = createInspectRenderer({
    write: text => chunks.push(text), headings: () => [], redact: createRedactor(['credential']),
    raw: true, color: true, columns: () => 8,
  });
  const filtered = scope('你\tfiltered\u001b[2J\ncredential', 'src/filtered.ts');
  renderer.emit({ type: 'gate', name: 'disabled', enabled: false, applies: false, reason: 'disabled by settings' });
  renderer.emit({ type: 'scope', name: 'filtered', subject: filtered, accepted: false, reason: 'outside layer' });
  renderer.finish([
    { name: 'disabled', ruleFile: 'disabled.rule.ts', durationMs: 0, status: 'skipped', reason: 'disabled by settings', evaluations: [] },
    { name: 'filtered', ruleFile: 'filtered.rule.ts', durationMs: 0, status: 'skipped', reason: 'all scopes filtered', evaluations: [] },
    { name: 'empty', ruleFile: 'empty.rule.ts', durationMs: 0, status: 'skipped', evaluations: [] },
  ]);
  const output = chunks.join('');
  assert.equal(output.split('disabled by settings').length - 1, 1);
  assert.match(output, /scope filtered\n  file: src\/filtered.ts:9-11\n  scope: function:挨拶\n  status: filtered\n  reason: outside layer\n  source:\n/);
  assert.ok(output.includes('9 | 你  filtered\\u001b[2J\n    10 | [REDACTED]\n'), output);
  assert.match(output, /result filtered\n  status: skipped\n  reason: all scopes filtered\n\n/);
  assert.match(output, /result empty\n  status: skipped\n  reason: no matching subjects\n\n$/);
  assert.ok(!/[╭╮╰╯│─\u001b]/u.test(output), output);
  assert.ok(!output.includes('credential'), output);
});
