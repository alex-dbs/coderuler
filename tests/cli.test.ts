import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  asMapping,
  createSandbox,
  decisionPayload,
  expectFailure,
  expectStreamingFailure,
  listTree,
  makeDirectory,
  makeSymlink,
  parseCheckOutput,
  releaseUntilDone,
  reportNamed,
  requestInstructions,
  requestQuestion,
  requestState,
  runCli,
  scopeSubjects,
  startDecisionFixture,
  writeFile,
  type DecisionFixture,
  type DecisionFixtureOptions,
  type Sandbox,
} from './support.ts';

const sandbox = createSandbox('rulekeeper-cli-');

const fixtures: DecisionFixture[] = [];

after(async () => {
  await Promise.all(fixtures.map(fixture => fixture.close()));
  sandbox.cleanup();
});

async function decisionFixture(options: DecisionFixtureOptions = {}): Promise<DecisionFixture> {
  const fixture = await startDecisionFixture(options);
  fixtures.push(fixture);
  return fixture;
}

function writeFiles(target: Sandbox, files: Readonly<Record<string, string>>): void {
  for (const [path, contents] of Object.entries(files)) writeFile(join(target.cwd, path), contents);
}

function writeRule(target: Sandbox, name: string, source: string): string {
  return writeFile(join(target.cwd, '.rulekeeper', `${name}.rule.ts`), source);
}

function writeHomeRule(target: Sandbox, name: string, source: string): string {
  return writeFile(join(target.home, '.rulekeeper', `${name}.rule.ts`), source);
}

const PASS_RULE = `import { Rule, pass } from 'rulekeeper';
export default class Pass extends Rule {
  files = ['src/**/*.txt'];
  check = pass;
}
`;

const SCAN_RULE = `import { Rule, pass } from 'rulekeeper';
export default class Scan extends Rule {
  files = ['**/*'];
  check = pass;
}
`;

const AI_WHOLE_FILE = `import { Rule, ai } from 'rulekeeper';
export default class Basic extends Rule {
  files = ['src/**/*.txt'];
  check = ai({ rule: 'Files must be tidy.', violationMessage: 'Not tidy' });
}
`;

const JSON_VALUES = `import { Rule, ai, scopes } from 'rulekeeper';
export default class Values extends Rule {
  files = ['data/*.json'];
  scope = scopes.json({ path: '$.value' });
  check = ai({ rule: 'Values must be present.' });
}
`;

const GROUPED_FOLDERS = `import { Rule, ai } from 'rulekeeper';
export default class Grouped extends Rule {
  files = ['config/**/*.yml'];
  group = 'folder';
  check = ai({ rule: 'Keys must be unique.' });
}
`;

const INPUT_OVERRIDE = `import { Rule, ai } from 'rulekeeper';
export default class Input extends Rule {
  files = ['src/**/*.txt'];
  check = ai({
    rule: 'Inputs must be explicit.',
    input: (subject, context) => ({ filepath: subject.filepath, kind: subject.kind, rooted: context.project.root.length > 0 }),
  });
}
`;

const EXAMPLES_RULE = `import { Rule, ai } from 'rulekeeper';
export default class Examples extends Rule {
  files = ['src/**/*.txt'];
  settings = { threshold: 0.9, model: 'rule-model' };
  check = ai({
    rule: 'Explained rule.',
    examples: { good: ['GOOD EXAMPLE'], bad: ['BAD EXAMPLE'] },
    violationMessage: 'LEAK-ME-NOT',
  });
}
`;

const GATE_DIRECTORY = `import { Rule, ai, scopes } from 'rulekeeper';
export default class Infra extends Rule {
  files = ['internal/infra/**/*.go'];
  scope = scopes.astGrep({ language: 'go', rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }] } });
  async when({ project }) {
    return (await project.stat('internal/adapter'))?.kind === 'directory';
  }
  check = ai({ rule: 'Infrastructure must not carry business policy.' });
}
`;

const GATE_REASON = `import { Rule, pass } from 'rulekeeper';
export default class Reasoned extends Rule {
  files = ['src/**/*.txt'];
  async when() {
    return { applies: false, reason: 'maintenance window' };
  }
  check = pass;
}
`;

const GATE_THROW = `import { Rule, pass } from 'rulekeeper';
export default class GateThrow extends Rule {
  files = ['src/**/*.txt'];
  async when() {
    throw new Error('gate exploded');
  }
  check = pass;
}
`;

const CUSTOM_SELECT = `import { Rule, pass, violation } from 'rulekeeper';
export default class CustomSelect extends Rule {
  files = ['src/**/*.txt'];
  async select(context) {
    const base = await context.select({ files: ['src/**/*.txt'] });
    return base.map(scope => ({ ...scope, id: 'custom:' + scope.id }));
  }
  filter(subject) {
    return subject.filepath.endsWith('skip.txt') ? { applies: false, reason: 'generated file' } : true;
  }
  check = async (subject, context) => {
    context.trace('custom-check', { filepath: subject.filepath, id: subject.id });
    return subject.filepath.startsWith('src/keep') ? pass() : violation('rejected ' + subject.filepath);
  };
}
`;

const CUSTOM_READS = `import { Rule, pass, violation } from 'rulekeeper';
export default class Reads extends Rule {
  files = ['src/**/*.txt'];
  check = async (subject, context) => {
    const settings = await context.project.readJson('settings.json');
    const limits = await context.project.readYaml('limits.yaml');
    const rows = await context.project.readCsv('rows.csv');
    if (settings.mode === 'strict' && limits[0][0] === 'MAX-LIMIT' && rows[0].name === 'CSV-ROW') {
      return violation('strict ' + subject.filepath);
    }
    return pass();
  };
}
`;

const CUSTOM_OUTSIDE = `import { Rule, pass } from 'rulekeeper';
export default class Outside extends Rule {
  files = ['src/**/*.txt'];
  async select() {
    return [{ kind: 'scope', filepath: 'outside.txt', id: '$', source: 'outside' }];
  }
  check = pass;
}
`;

const CUSTOM_DUPLICATE = `import { Rule, pass } from 'rulekeeper';
export default class Duplicates extends Rule {
  files = ['src/**/*.txt'];
  async select() {
    return [
      { kind: 'scope', filepath: 'src/a.txt', id: '$', source: 'alpha' },
      { kind: 'scope', filepath: 'src/a.txt', id: '$', source: 'alpha' },
    ];
  }
  check = pass;
}
`;

const THROWING_CHECK = `import { Rule } from 'rulekeeper';
export default class Boom extends Rule {
  files = ['src/**/*.txt'];
  check = async () => {
    throw new Error('check exploded');
  };
}
`;

const NO_MATCH = `import { Rule, pass } from 'rulekeeper';
export default class NoMatch extends Rule {
  files = ['missing/**/*.txt'];
  check = pass;
}
`;

const DISABLED = `import { Rule, violation } from 'rulekeeper';
export default class Off extends Rule {
  enabled = false;
  files = ['src/**/*.txt'];
  check = () => violation('never runs');
}
`;

const MJS_RULE = `import { Rule, regex } from 'rulekeeper';
export default class Mjs extends Rule {
  files = ['src/**/*.txt'];
  check = regex({ pattern: /MARKER-OK/, violationMessage: 'mjs missing marker' });
}
`;

const GO_SOURCE = `package infra

func Load() {}

type Store struct{}

func (s Store) Save() {}
`;

const LONG_SOURCE = `${Array.from({ length: 20 }, (_value, index) => `line-${String(index + 1).padStart(4, '0')}`).join('\n')}\n`;

function markerRule(message: string): string {
  return `import { Rule, regex } from 'rulekeeper';
export default class Marker extends Rule {
  files = ['src/**/*.txt'];
  check = regex({ pattern: /MARKER-OK/g, violationMessage: ${JSON.stringify(message)} });
}
`;
}

const MARKER_ANY_TXT_RULE = `import { Rule, regex } from 'rulekeeper';
export default class MarkerAnyTxt extends Rule {
  files = ['**/*.txt'];
  check = regex({ pattern: /MARKER-OK/g, violationMessage: 'Missing marker' });
}
`;

function longRule(): string {
  return `import { Rule, regex } from 'rulekeeper';
export default class Long extends Rule {
  files = ['long/*.txt'];
  check = regex({ pattern: /MARKER-OK/g, violationMessage: 'no marker' });
}
`;
}

function manyRule(): string {
  return `import { Rule, regex } from 'rulekeeper';
export default class Many extends Rule {
  files = ['many/*.txt'];
  check = regex({ pattern: /MARKER-OK/g, violationMessage: 'no marker' });
}
`;
}

const JSON_MISSING = `import { Rule, ai, scopes } from 'rulekeeper';
export default class Missing extends Rule {
  files = ['data/*.json'];
  scope = scopes.json({ path: '$.missing' });
  check = ai({ rule: 'Missing values must be explained.' });
}
`;

const ESC_THROW = `import { Rule } from 'rulekeeper';
export default class EscThrow extends Rule {
  files = ['src/**/*.txt'];
  check = async () => {
    throw new Error('boom \\u001b[31mred');
  };
}
`;

const ESC_TRACE = `import { Rule, pass } from 'rulekeeper';
export default class EscTrace extends Rule {
  files = ['src/**/*.txt'];
  check = (subject, context) => {
    context.trace('escaped-detail', { 'bad\\u001b[31mkey': subject.source });
    return pass();
  };
}
`;

test('validate loads rules without running gates or checks', async () => {
  const target = sandbox.isolated('validate-hooks');
  writeRule(
    target,
    'boom-check',
    `import { Rule } from 'rulekeeper';
export default class BoomCheck extends Rule {
  files = ['src/**/*.txt'];
  check = async () => {
    throw new Error('check must not run');
  };
}
`,
  );
  writeRule(target, 'boom-gate', GATE_THROW);
  const fixture = await decisionFixture();
  const result = await runCli(['validate'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('Valid rule: boom-check'), result.stdout);
  assert.ok(result.stdout.includes('Valid rule: boom-gate'), result.stdout);
  assert.ok(!result.stdout.includes('(v1)'), result.stdout);
  assert.ok(!result.stdout.includes('gate exploded'), result.stdout);
  assert.equal(fixture.requests.length, 0);
});

test('validate accepts explicit rule files and directories', async () => {
  const target = sandbox.isolated('validate-explicit');
  writeFiles(target, {
    'rules/one.rule.ts': PASS_RULE,
    'rules/two.rule.ts': SCAN_RULE,
    'outside/three.rule.ts': PASS_RULE,
  });
  const direct = await runCli(['validate', 'rules/one.rule.ts'], target);
  assert.equal(direct.status, 0, direct.stderr);
  assert.ok(direct.stdout.includes('Valid rule: one'), direct.stdout);
  assert.ok(!direct.stdout.includes('Valid rule: two'), direct.stdout);
  const directory = await runCli(['validate', 'rules'], target);
  assert.equal(directory.status, 0, directory.stderr);
  assert.ok(directory.stdout.includes('Valid rule: one'), directory.stdout);
  assert.ok(directory.stdout.includes('Valid rule: two'), directory.stdout);
  assert.ok(!directory.stdout.includes('Valid rule: three'), directory.stdout);
});

test('validate reports malformed modules and invalid disabled rules', async () => {
  const malformedTarget = sandbox.isolated('validate-malformed');
  writeRule(
    malformedTarget,
    'broken',
    `import { Rule, pass } from 'rulekeeper';
export default class Broken extends Rule {
  enabled = 'yes';
  check = pass;
}
`,
  );
  const malformed = await runCli(['validate'], malformedTarget);
  expectFailure(malformed, 'validate malformed');
  assert.ok(malformed.stderr.includes('broken.rule.ts'), malformed.stderr);

  const disabledTarget = sandbox.isolated('validate-disabled');
  writeRule(
    disabledTarget,
    'disabled-broken',
    `import { Rule, pass } from 'rulekeeper';
export default class DisabledBroken extends Rule {
  enabled = false;
  settings = { threshold: 7 };
  check = pass;
}
`,
  );
  const disabled = await runCli(['validate'], disabledTarget);
  expectFailure(disabled, 'validate disabled');
  assert.ok(disabled.stderr.includes('disabled-broken.rule.ts'), disabled.stderr);
});

test('validate fails when no rules are discoverable', async () => {
  const target = sandbox.isolated('validate-none');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  const result = await runCli(['validate'], target);
  expectFailure(result, 'validate none');
  assert.match(result.stderr, /no rule files/i);
});

test('check reports a passing rule as a complete JSON array', async () => {
  const target = sandbox.isolated('check-pass');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'ok', PASS_RULE);
  const result = await runCli(['check', '--json'], target);
  assert.equal(result.status, 0, result.stderr);
  const reports = parseCheckOutput(result, 'check pass');
  assert.deepEqual(reports.map(report => report.name), ['ok']);
  const report = reports[0]!;
  assert.equal(report.status, 'pass');
  assert.ok(report.ruleFile.endsWith(join('.rulekeeper', 'ok.rule.ts')), report.ruleFile);
  assert.deepEqual(scopeSubjects(report, 'check pass').map(subject => subject.filepath), ['src/a.txt']);
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result.status), ['pass']);
});

test('check exits 1 with violation messages and root-relative subjects', async () => {
  const target = sandbox.isolated('check-violation');
  writeFiles(target, {
    'src/one.txt': 'nothing to see',
    'src/three.txt': 'another MARKER-OK line',
    'src/two.txt': 'MARKER-OK present',
  });
  writeRule(target, 'marker', markerRule('Missing marker'));
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(result.status, 1, result.stderr);
  const report = reportNamed(parseCheckOutput(result, 'check violation'), 'marker', 'check violation');
  assert.equal(report.status, 'violation');
  const subjects = scopeSubjects(report, 'check violation');
  assert.deepEqual(subjects.map(subject => subject.filepath), ['src/one.txt', 'src/three.txt', 'src/two.txt']);
  assert.deepEqual(subjects.map(subject => subject.id), ['$', '$', '$']);
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result.status), ['violation', 'pass', 'pass']);
  assert.equal(report.evaluations[0]!.result.message, 'Missing marker');
  assert.equal(report.evaluations[0]!.result.probability, undefined);
  assert.equal(report.evaluations[0]!.result.model, undefined);
  assert.equal(fixture.requests.length, 0);
});

test('check human output counts rules, skips, verifications and violations', async () => {
  const target = sandbox.isolated('check-counts');
  writeFiles(target, { 'src/a.txt': 'nothing to see' });
  writeRule(target, 'ok', PASS_RULE);
  writeRule(target, 'gone', NO_MATCH);
  writeRule(target, 'off', DISABLED);
  writeRule(target, 'bad', markerRule('Missing marker'));
  const human = await runCli(['check'], target);
  assert.equal(human.status, 1, human.stderr);
  for (const token of [/rules?\b/i, /skip(?:ped|s)?\b/i, /verificat\w*/i, /violat\w*/i]) {
    assert.match(human.stdout, token);
  }
  assert.ok(human.stdout.includes('Missing marker'), human.stdout);
  assert.ok(human.stdout.includes('src/a.txt'), human.stdout);
  const result = await runCli(['check', '--json'], target);
  const reports = parseCheckOutput(result, 'check counts');
  assert.deepEqual(
    reports.map(report => [report.name, report.status]),
    [
      ['bad', 'violation'],
      ['gone', 'skipped'],
      ['off', 'skipped'],
      ['ok', 'pass'],
    ],
  );
  assert.equal(reportNamed(reports, 'gone', 'check counts').reason, 'no matching subjects');
  assert.equal(reportNamed(reports, 'off', 'check counts').reason, 'disabled');
  assert.deepEqual(reportNamed(reports, 'gone', 'check counts').evaluations, []);
});

test('check bounds the human violation list and points at --json', async () => {
  const target = sandbox.isolated('check-bounded-list');
  const files: Record<string, string> = {};
  for (let index = 1; index <= 12; index += 1) {
    files[`many/case-${String(index).padStart(2, '0')}.txt`] = 'nothing to see';
  }
  writeFiles(target, files);
  writeRule(target, 'many', manyRule());
  const human = await runCli(['check'], target);
  assert.equal(human.status, 1, human.stderr);
  assert.ok(human.stdout.includes('case-01.txt'), human.stdout);
  assert.ok(human.stdout.includes('case-10.txt'), human.stdout);
  assert.ok(!human.stdout.includes('case-11.txt'), human.stdout);
  assert.ok(!human.stdout.includes('case-12.txt'), human.stdout);
  assert.match(human.stdout, /--json/);
  const result = await runCli(['check', '--json'], target);
  const report = reportNamed(parseCheckOutput(result, 'check bounded'), 'many', 'check bounded');
  assert.equal(report.evaluations.length, 12);
  assert.ok(result.stdout.includes('case-12.txt'), 'json keeps the complete report');
});

test('check bounds each human excerpt to five source lines', async () => {
  const target = sandbox.isolated('check-bounded-lines');
  writeFiles(target, { 'long/only.txt': LONG_SOURCE });
  writeRule(target, 'long', longRule());
  const human = await runCli(['check'], target);
  assert.equal(human.status, 1, human.stderr);
  assert.ok(human.stdout.includes('line-0001'), human.stdout);
  assert.ok(!human.stdout.includes('line-0012'), human.stdout);
  const result = await runCli(['check', '--json'], target);
  const report = reportNamed(parseCheckOutput(result, 'check lines'), 'long', 'check lines');
  const subject = scopeSubjects(report, 'check lines')[0]!;
  assert.equal(subject.source.trimEnd().split('\n').length, 20);
  assert.ok(result.stdout.includes('line-0020'), 'json keeps the complete source');
});

test('check escapes control characters in violation messages', async () => {
  const target = sandbox.isolated('check-controls');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(
    target,
    'controls',
    `import { Rule, violation } from 'rulekeeper';
export default class Controls extends Rule {
  files = ['src/**/*.txt'];
  check = () => violation('plain\\u001b[31mred\\u0007 bell');
}
`,
  );
  const human = await runCli(['check'], target);
  assert.equal(human.status, 1, human.stderr);
  assert.equal(human.stdout.includes('\u001b'), false, 'raw escape sequences must not reach the terminal');
  assert.equal(human.stdout.includes('\u0007'), false, 'raw control characters must not reach the terminal');
  assert.ok(human.stdout.includes('red'), human.stdout);
});

test('check validates every rule module before running any gate', async () => {
  const target = sandbox.isolated('check-validate-first');
  writeFiles(target, { 'src/a.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'aaa-valid', AI_WHOLE_FILE);
  writeRule(
    target,
    'zzz-invalid',
    `import { Rule, pass } from 'rulekeeper';
export default class Invalid extends Rule {
  settings = { threshold: 4 };
  check = pass;
}
`,
  );
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--json'], target, fixture.env);
  expectFailure(result, 'validate first');
  assert.ok(result.stderr.includes('zzz-invalid.rule.ts'), result.stderr);
  assert.equal(fixture.requests.length, 0);
});

test('check distinguishes no-match, disabled and passing rules', async () => {
  const noMatchTarget = sandbox.isolated('check-nomatch');
  writeRule(noMatchTarget, 'nomatch', NO_MATCH);
  const noMatch = await runCli(['check'], noMatchTarget);
  assert.equal(noMatch.status, 0, noMatch.stderr);
  assert.match(noMatch.stdout, /no (?:matching )?(?:subjects?|verifications?|checks?|evaluations?)/i);
  assert.equal(noMatch.stdout.includes('src/'), false, noMatch.stdout);
  const noMatchReport = reportNamed(
    parseCheckOutput(await runCli(['check', '--json'], noMatchTarget), 'no match'),
    'nomatch',
    'no match',
  );
  assert.equal(noMatchReport.status, 'skipped');
  assert.equal(noMatchReport.reason, 'no matching subjects');

  const disabledTarget = sandbox.isolated('check-disabled');
  writeRule(disabledTarget, 'off', DISABLED);
  const disabled = await runCli(['check'], disabledTarget);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /disabled/i);
  assert.notEqual(disabled.stdout, noMatch.stdout);

  const passTarget = sandbox.isolated('check-passing');
  writeFiles(passTarget, { 'src/a.txt': 'alpha' });
  writeRule(passTarget, 'ok', PASS_RULE);
  const passing = await runCli(['check'], passTarget);
  assert.equal(passing.status, 0, passing.stderr);
  assert.notEqual(passing.stdout, noMatch.stdout);
  assert.notEqual(passing.stdout, disabled.stdout);
  const passingReport = reportNamed(
    parseCheckOutput(await runCli(['check', '--json'], passTarget), 'passing'),
    'ok',
    'passing',
  );
  assert.equal(passingReport.status, 'pass');
  assert.equal(passingReport.evaluations.length, 1);
});

test('check keeps deterministic report order across concurrency', async () => {
  const target = sandbox.isolated('check-order');
  writeFiles(target, { 'src/a.txt': 'nothing to see' });
  writeRule(target, 'aaa', markerRule('first'));
  writeRule(target, 'mmm', markerRule('second'));
  writeRule(target, 'zzz', markerRule('third'));
  const result = await runCli(['check', '--json', '--concurrency', '4'], target);
  assert.equal(result.status, 1, result.stderr);
  const reports = parseCheckOutput(result, 'check order');
  assert.deepEqual(reports.map(report => report.name), ['aaa', 'mmm', 'zzz']);
  assert.deepEqual(reports.map(report => report.evaluations[0]!.result.message), ['first', 'second', 'third']);
});

test('check narrows selection to the target while gates see the full root', async () => {
  const target = sandbox.isolated('check-target-gate');
  writeFiles(target, {
    'internal/infra/store.go': GO_SOURCE,
    'internal/adapter/README.md': 'adapter\n',
    'other/note.txt': 'note',
  });
  writeRule(target, 'gate-dir', GATE_DIRECTORY);
  const fixture = await decisionFixture();
  const result = await runCli(['check', 'internal/infra', '--json'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 2);
  const report = reportNamed(parseCheckOutput(result, 'target gate'), 'gate-dir', 'target gate');
  assert.deepEqual(scopeSubjects(report, 'target gate').map(subject => subject.filepath), [
    'internal/infra/store.go',
    'internal/infra/store.go',
  ]);
  for (const request of fixture.requests) {
    assert.equal(requestState(request)['filepath'], 'internal/infra/store.go');
  }
});

test('check rejects missing, escaping, reserved and symlinked targets', async () => {
  const target = sandbox.isolated('check-target-errors');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'ok', PASS_RULE);
  makeSymlink(join(target.cwd, 'src', 'link.txt'), 'a.txt');
  expectFailure(await runCli(['check', 'missing-dir'], target), 'missing target');
  expectFailure(await runCli(['check', '../outside'], target), 'escaping target');
  expectFailure(await runCli(['check', 'node_modules'], target), 'reserved target');
  const linked = await runCli(['check', 'src/link.txt'], target);
  expectFailure(linked, 'symlinked target');
  assert.match(linked.stderr, /symbolic link/i);
});

test('check excludes reserved directories and loaded rule files from selection', async () => {
  const target = sandbox.isolated('check-reserved');
  writeFiles(target, {
    'src/a.txt': 'alpha',
    'old/legacy.txt': 'legacy',
    'node_modules/pkg/index.js': 'export default 1;\n',
    'dist/note.txt': 'dist note',
    'coverage/note.txt': 'coverage note',
  });
  writeRule(target, 'scan', SCAN_RULE);
  const result = await runCli(['check', '--json'], target);
  assert.equal(result.status, 0, result.stderr);
  const report = reportNamed(parseCheckOutput(result, 'check reserved'), 'scan', 'check reserved');
  const filepaths = scopeSubjects(report, 'check reserved').map(subject => subject.filepath);
  assert.ok(filepaths.includes('src/a.txt'), filepaths.join(','));
  assert.ok(filepaths.includes('package.json'), filepaths.join(','));
  assert.deepEqual(
    filepaths.filter(path => /^(?:\.rulekeeper|old|node_modules|dist|coverage)\//.test(path)),
    [],
  );
});

test('check honors --rules with a file and a directory', async () => {
  const target = sandbox.isolated('check-rules');
  writeFiles(target, {
    'src/a.txt': 'nothing to see',
    'rules/explicit.rule.ts': markerRule('explicit missing marker'),
    'rules/scan2.rule.ts': SCAN_RULE,
    'notes.txt': 'notes',
  });
  const single = await runCli(['check', '--json', '--rules', 'rules/explicit.rule.ts'], target);
  assert.equal(single.status, 1, single.stderr);
  assert.deepEqual(parseCheckOutput(single, 'explicit file').map(report => report.name), ['explicit']);
  const directory = await runCli(['check', '--json', '--rules', 'rules'], target);
  assert.equal(directory.status, 1, directory.stderr);
  assert.deepEqual(parseCheckOutput(directory, 'explicit directory').map(report => report.name), ['explicit', 'scan2']);
  const scan = await runCli(['check', '--json', '--rules', 'rules/scan2.rule.ts'], target);
  assert.equal(scan.status, 0, scan.stderr);
  const scanReport = reportNamed(parseCheckOutput(scan, 'explicit scan'), 'scan2', 'explicit scan');
  const filepaths = scopeSubjects(scanReport, 'explicit scan').map(subject => subject.filepath);
  assert.ok(!filepaths.includes('rules/scan2.rule.ts'), filepaths.join(','));
  assert.ok(filepaths.includes('notes.txt'), filepaths.join(','));
  expectFailure(await runCli(['check', '--rules', 'notes.txt'], target), 'unsupported rule module');
});

test('check skips rules whose gate is false without contacting the backend', async () => {
  const fixture = await decisionFixture();

  const missingTarget = sandbox.isolated('check-gate-missing');
  writeFiles(missingTarget, { 'internal/infra/store.go': GO_SOURCE });
  writeRule(missingTarget, 'gate-dir', GATE_DIRECTORY);
  const missing = await runCli(['check', '--json'], missingTarget, fixture.env);
  assert.equal(missing.status, 0, missing.stderr);
  const missingReport = reportNamed(parseCheckOutput(missing, 'gate missing'), 'gate-dir', 'gate missing');
  assert.equal(missingReport.status, 'skipped');
  assert.equal(missingReport.reason, 'when returned false');
  assert.deepEqual(missingReport.evaluations, []);
  assert.equal(fixture.requests.length, 0);

  const fileTarget = sandbox.isolated('check-gate-file');
  writeFiles(fileTarget, { 'internal/infra/store.go': GO_SOURCE, 'internal/adapter': 'not a directory\n' });
  writeRule(fileTarget, 'gate-dir', GATE_DIRECTORY);
  const asFile = await runCli(['check', '--json'], fileTarget, fixture.env);
  assert.equal(asFile.status, 0, asFile.stderr);
  assert.equal(reportNamed(parseCheckOutput(asFile, 'gate file'), 'gate-dir', 'gate file').status, 'skipped');
  assert.equal(fixture.requests.length, 0);
});

test('check evaluates once the gate directory exists and projects function sources', async () => {
  const target = sandbox.isolated('check-gate-present');
  writeFiles(target, { 'internal/infra/store.go': GO_SOURCE });
  makeDirectory(join(target.cwd, 'internal', 'adapter'));
  writeRule(target, 'gate-dir', GATE_DIRECTORY);
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  const report = reportNamed(parseCheckOutput(result, 'gate present'), 'gate-dir', 'gate present');
  assert.equal(report.status, 'pass');
  assert.equal(report.evaluations.length, 2);
  assert.equal(fixture.requests.length, 2);
  for (const request of fixture.requests) {
    const state = requestState(request);
    assert.equal(state['filepath'], 'internal/infra/store.go');
    const scope = asMapping(state['scope'], 'state scope');
    assert.equal(typeof scope['source'], 'string');
    assert.ok(String(scope['source']).includes('func'), String(scope['source']));
    assert.equal(Object.hasOwn(scope, 'data'), false);
  }
});

test('check surfaces a structured gate reason', async () => {
  const target = sandbox.isolated('check-gate-reason');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'reasoned', GATE_REASON);
  const result = await runCli(['check', '--json'], target);
  assert.equal(result.status, 0, result.stderr);
  const report = reportNamed(parseCheckOutput(result, 'gate reason'), 'reasoned', 'gate reason');
  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'maintenance window');
});

test('check fails when a gate throws', async () => {
  const target = sandbox.isolated('check-gate-throw');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'gate-throw', GATE_THROW);
  const result = await runCli(['check', '--json'], target);
  expectFailure(result, 'gate throw');
  assert.ok(result.stderr.includes('gate exploded'), result.stderr);
});

test('check runs custom selectors, filters and checks without credentials', async () => {
  const target = sandbox.isolated('check-custom');
  writeFiles(target, {
    'src/keep-a.txt': 'alpha',
    'src/drop-b.txt': 'beta',
    'src/skip.txt': 'gamma',
  });
  writeRule(target, 'custom-select', CUSTOM_SELECT);
  const result = await runCli(['check', '--json'], target, { RK_BACKEND: 'not-a-backend', RK_THRESHOLD: 'nonsense' });
  assert.equal(result.status, 1, result.stderr);
  const report = reportNamed(parseCheckOutput(result, 'custom select'), 'custom-select', 'custom select');
  const subjects = scopeSubjects(report, 'custom select');
  assert.deepEqual(subjects.map(subject => subject.filepath), ['src/drop-b.txt', 'src/keep-a.txt']);
  assert.deepEqual(subjects.map(subject => subject.id), ['custom:$', 'custom:$']);
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result.status), ['violation', 'pass']);
  assert.equal(report.evaluations[0]!.result.message, 'rejected src/drop-b.txt');
  assert.ok(report.evaluations.every(evaluation => evaluation.result.probability === undefined));
});

test('check reads neighbour JSON, YAML and CSV through the project', async () => {
  const target = sandbox.isolated('check-reads');
  writeFiles(target, {
    'src/only.txt': 'alpha',
    'settings.json': '{"mode":"strict"}\n',
    'limits.yaml': '- MAX-LIMIT\n',
    'rows.csv': 'name\nCSV-ROW\n',
  });
  writeRule(target, 'custom-reads', CUSTOM_READS);
  const strict = await runCli(['check', '--json'], target);
  assert.equal(strict.status, 1, strict.stderr);
  const strictReport = reportNamed(parseCheckOutput(strict, 'reads strict'), 'custom-reads', 'reads strict');
  assert.equal(strictReport.evaluations[0]!.result.message, 'strict src/only.txt');
  writeFiles(target, { 'settings.json': '{"mode":"lax"}\n' });
  const lax = await runCli(['check', '--json'], target);
  assert.equal(lax.status, 0, lax.stderr);
  const laxReport = reportNamed(parseCheckOutput(lax, 'reads lax'), 'custom-reads', 'reads lax');
  assert.deepEqual(laxReport.evaluations.map(evaluation => evaluation.result.status), ['pass']);
});

test('check rejects selections outside the target and duplicated custom ids', async () => {
  const outsideTarget = sandbox.isolated('check-outside');
  writeFiles(outsideTarget, { 'src/a.txt': 'alpha', 'outside.txt': 'outside' });
  writeRule(outsideTarget, 'outside', CUSTOM_OUTSIDE);
  const outside = await runCli(['check', 'src', '--json'], outsideTarget);
  expectFailure(outside, 'outside target');
  assert.match(outside.stderr, /outside the CLI target/i);

  const duplicateTarget = sandbox.isolated('check-duplicate-ids');
  writeFiles(duplicateTarget, { 'src/a.txt': 'alpha' });
  writeRule(duplicateTarget, 'duplicates', CUSTOM_DUPLICATE);
  const duplicated = await runCli(['check', '--json'], duplicateTarget);
  expectFailure(duplicated, 'duplicate ids');
  assert.match(duplicated.stderr, /duplicate scope id/i);
});

test('check sends the default whole-file projection automatically', async () => {
  const target = sandbox.isolated('check-ai-source');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0]!;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/systemone');
  assert.equal(request.authorization, `Bearer ${fixture.apiKey}`);
  const body = asMapping(request.body, 'request body');
  assert.equal(body['model'], fixture.model);
  assert.deepEqual(body['state'], { filepath: 'src/one.txt', scope: { id: '$', source: 'SOURCE-TEXT-ONE' } });
  assert.deepEqual(requestInstructions(request), { rule: 'Files must be tidy.', question: 'Is the rule respected?' });
  assert.equal(requestQuestion(request)['type'], 'noul');
  const report = reportNamed(parseCheckOutput(result, 'ai source'), 'basic', 'ai source');
  assert.deepEqual(report.evaluations[0]!.result, {
    status: 'pass',
    probability: fixture.probability,
    model: fixture.model,
  });
});

test('check projects falsy structured data for AI', async () => {
  const target = sandbox.isolated('check-ai-data');
  writeFiles(target, {
    'data/one.json': '{"value":null}\n',
    'data/two.json': '{"value":false}\n',
    'data/three.json': '{"value":0}\n',
  });
  writeRule(target, 'values', JSON_VALUES);
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 3);
  const byFilepath = new Map<string, Record<string, unknown>>();
  for (const request of fixture.requests) {
    const state = requestState(request);
    const scope = asMapping(state['scope'], 'state scope');
    assert.equal(scope['id'], '/value');
    assert.equal(Object.hasOwn(scope, 'source'), false);
    byFilepath.set(String(state['filepath']), scope);
  }
  assert.equal(byFilepath.get('data/one.json')!['data'], null);
  assert.equal(byFilepath.get('data/two.json')!['data'], false);
  assert.equal(byFilepath.get('data/three.json')!['data'], 0);
  for (const [filepath, scope] of byFilepath) {
    assert.equal(Object.hasOwn(scope, 'data'), true, filepath);
  }
});

test('check projects grouped members per folder', async () => {
  const target = sandbox.isolated('check-ai-group');
  writeFiles(target, {
    'config/dev/a.yml': 'a: 1\n',
    'config/dev/b.yml': 'b: 2\n',
    'config/prod/c.yml': 'c: 3\n',
  });
  writeRule(target, 'grouped', GROUPED_FOLDERS);
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 2);
  const groups = new Map<string, readonly string[]>();
  for (const request of fixture.requests) {
    const state = requestState(request);
    const files = state['files'];
    assert.ok(Array.isArray(files), 'grouped state carries a files array');
    const filepaths: string[] = [];
    for (const file of files) {
      const entry = asMapping(file, 'grouped file');
      filepaths.push(String(entry['filepath']));
      const scopes = entry['scopes'];
      assert.ok(Array.isArray(scopes), 'each file carries scopes');
      for (const scope of scopes) {
        const match = asMapping(scope, 'grouped scope');
        assert.equal(typeof match['source'], 'string');
        assert.equal(match['id'], '$');
      }
    }
    groups.set(filepaths.join('|'), filepaths);
  }
  assert.deepEqual([...groups.keys()].sort(), ['config/dev/a.yml|config/dev/b.yml', 'config/prod/c.yml']);
  const report = reportNamed(parseCheckOutput(result, 'ai group'), 'grouped', 'ai group');
  const subjects = report.evaluations.map(evaluation => evaluation.subject);
  assert.deepEqual(subjects.map(subject => subject.kind), ['group', 'group']);
  const folders = subjects.map(subject => {
    assert.equal(subject.kind, 'group');
    return subject.kind === 'group' ? `${subject.group.type}:${subject.group.path}` : '';
  });
  assert.deepEqual(folders.sort(), ['folder:config/dev', 'folder:config/prod']);
  assert.equal(report.evaluations.length, 2);
  assert.ok(report.evaluations.every(evaluation => evaluation.subject.kind === 'group'));
});

test('check replaces the default input with the author callback', async () => {
  const target = sandbox.isolated('check-ai-input');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'input', INPUT_OVERRIDE);
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(requestState(fixture.requests[0]!), {
    filepath: 'src/one.txt',
    kind: 'scope',
    rooted: true,
  });
});

test('check carries examples, model settings and hides the violation message', async () => {
  const target = sandbox.isolated('check-ai-examples');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'examples', EXAMPLES_RULE);
  const fixture = await decisionFixture({ probability: 0.95 });
  const result = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  const request = fixture.requests[0]!;
  const body = asMapping(request.body, 'request body');
  assert.equal(body['model'], 'rule-model');
  assert.deepEqual(requestInstructions(request), {
    rule: 'Explained rule.',
    question: 'Is the rule respected?',
    examples: { good: ['GOOD EXAMPLE'], bad: ['BAD EXAMPLE'] },
  });
  assert.ok(!request.raw.includes('LEAK-ME-NOT'), request.raw);
  const report = reportNamed(parseCheckOutput(result, 'ai examples'), 'examples', 'ai examples');
  assert.deepEqual(report.evaluations[0]!.result, {
    status: 'pass',
    probability: 0.95,
    model: fixture.model,
  });
});

test('check resolves threshold precedence from flag, rule, env and default', async () => {
  const target = sandbox.isolated('check-thresholds');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'examples', EXAMPLES_RULE);
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture({ probability: 0.5 });

  const ruleOverEnv = await runCli(['check', '--json', '--rules', '.rulekeeper/examples.rule.ts'], target, {
    ...fixture.env,
    RK_THRESHOLD: '0.1',
  });
  assert.equal(ruleOverEnv.status, 1, ruleOverEnv.stderr);
  assert.equal(reportNamed(parseCheckOutput(ruleOverEnv, 'rule threshold'), 'examples', 'rule threshold').status, 'violation');

  const flagOverRule = await runCli(
    ['check', '--json', '--rules', '.rulekeeper/examples.rule.ts', '--threshold', '0.3'],
    target,
    { ...fixture.env, RK_THRESHOLD: '0.1' },
  );
  assert.equal(flagOverRule.status, 0, flagOverRule.stderr);
  assert.equal(reportNamed(parseCheckOutput(flagOverRule, 'flag threshold'), 'examples', 'flag threshold').status, 'pass');

  fixture.probability = 0.4;
  const equal = await runCli(['check', '--json', '--rules', '.rulekeeper/basic.rule.ts'], target, fixture.env);
  assert.equal(equal.status, 1, equal.stderr);
  assert.equal(reportNamed(parseCheckOutput(equal, 'default threshold'), 'basic', 'default threshold').status, 'violation');

  fixture.probability = 0.41;
  const above = await runCli(['check', '--json', '--rules', '.rulekeeper/basic.rule.ts'], target, fixture.env);
  assert.equal(above.status, 0, above.stderr);
  assert.equal(reportNamed(parseCheckOutput(above, 'above threshold'), 'basic', 'above threshold').status, 'pass');
});

test('check loads .env without overriding exported variables', async () => {
  const target = sandbox.isolated('check-dotenv');
  const fixture = await decisionFixture();
  writeFiles(target, {
    'src/one.txt': 'SOURCE-TEXT-ONE',
    '.env': `TYPESAFE_BASE_URL=${fixture.baseUrl}\nTYPESAFE_API_KEY=dotenv-key\n`,
  });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const dotenv = await runCli(['check', '--json'], target);
  assert.equal(dotenv.status, 0, dotenv.stderr);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0]!.authorization, 'Bearer dotenv-key');
  fixture.reset();
  const exported = await runCli(['check', '--json'], target, { TYPESAFE_API_KEY: 'exported-key' });
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0]!.authorization, 'Bearer exported-key');
});

test('check fails without an API key, with an unknown backend and on transport errors', async () => {
  const target = sandbox.isolated('check-ai-errors');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture();

  const missingKey = await runCli(['check', '--json'], target, { TYPESAFE_BASE_URL: fixture.baseUrl });
  expectFailure(missingKey, 'missing key');
  assert.match(missingKey.stderr, /TYPESAFE_API_KEY/);
  assert.equal(fixture.requests.length, 0);

  const backend = await runCli(['check', '--json'], target, { ...fixture.env, RK_BACKEND: 'not-a-backend' });
  expectFailure(backend, 'unknown backend');
  assert.match(backend.stderr, /not-a-backend/);
  assert.equal(fixture.requests.length, 0);

  fixture.answer = () => ({ status: 500 });
  const httpError = await runCli(['check', '--json'], target, fixture.env);
  expectFailure(httpError, 'http error');
  assert.match(httpError.stderr, /500/);
  assert.ok(!httpError.stderr.includes(fixture.apiKey), httpError.stderr);

  fixture.answer = () => ({ status: 200, body: '{not json' });
  expectFailure(await runCli(['check', '--json'], target, fixture.env), 'malformed response');

  fixture.answer = () => ({
    status: 200,
    body: JSON.stringify({ model: fixture.model, answers: { follows_instructions: { type: 'noul', noul: 1.5 } } }),
  });
  const invalid = await runCli(['check', '--json'], target, fixture.env);
  expectFailure(invalid, 'invalid probability');
  assert.match(invalid.stderr, /probability/i);

  fixture.answer = () => ({ status: 200, body: JSON.stringify(decisionPayload(0.9, 'other-model')) });
  const otherModel = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(otherModel.status, 0, otherModel.stderr);
  assert.equal(
    reportNamed(parseCheckOutput(otherModel, 'reported model'), 'basic', 'reported model').evaluations[0]!.result.model,
    'other-model',
  );
});

test('check reports unsafe URLs without leaking credentials', async () => {
  const target = sandbox.isolated('check-unsafe-url');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const result = await runCli(['check', '--json'], target, {
    TYPESAFE_BASE_URL: 'http://user:secretpass@127.0.0.1:9',
    TYPESAFE_API_KEY: 'secret-key',
  });
  expectFailure(result, 'unsafe url');
  assert.match(result.stderr, /credential/i);
  assert.ok(!result.stderr.includes('secretpass'), result.stderr);
  assert.ok(!result.stderr.includes('secret-key'), result.stderr);
});

test('check keeps stdout empty when a later rule stage fails', async () => {
  const target = sandbox.isolated('check-late-error');
  writeFiles(target, { 'src/a.txt': 'nothing to see' });
  writeRule(target, 'aaa', markerRule('first violation'));
  writeRule(target, 'zzz', THROWING_CHECK);
  const result = await runCli(['check', '--json'], target);
  expectFailure(result, 'late error');
  assert.ok(result.stderr.includes('check exploded'), result.stderr);
});

test('check debug output carries metadata without bodies or credentials', async () => {
  const target = sandbox.isolated('check-debug');
  writeFiles(target, { 'src/one.txt': 'SECRET-SOURCE-TEXT' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture({ apiKey: 'super-secret-key' });
  const result = await runCli(['check', '--debug'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  const combined = result.stdout + result.stderr;
  assert.equal(fixture.requests.length, 1);
  assert.ok(!combined.includes('SECRET-SOURCE-TEXT'), combined);
  assert.ok(!combined.includes('Files must be tidy.'), combined);
  assert.ok(!combined.includes('super-secret-key'), combined);
  assert.match(combined, /systemone|request/i);
});

test('check verbose output carries redacted request and response bodies', async () => {
  const target = sandbox.isolated('check-verbose');
  writeFiles(target, { 'src/one.txt': 'SECRET-SOURCE-TEXT' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture({ apiKey: 'super-secret-key' });
  const result = await runCli(['check', '--verbose'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  const combined = result.stdout + result.stderr;
  assert.ok(combined.includes('SECRET-SOURCE-TEXT'), combined);
  assert.ok(combined.includes('"state"'), combined);
  assert.ok(combined.includes('Files must be tidy.'), combined);
  assert.ok(combined.includes('follows_instructions'), combined);
  assert.ok(!combined.includes('super-secret-key'), combined);
});

test('check forces a single in-flight evaluation in debug', async () => {
  const target = sandbox.isolated('check-debug-concurrency');
  writeFiles(target, {
    'src/a.txt': 'alpha',
    'src/b.txt': 'beta',
    'src/c.txt': 'gamma',
    'src/d.txt': 'delta',
  });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture({ hold: true });
  fixture.limit = 1;
  const run = runCli(['check', '--debug'], target, fixture.env);
  await fixture.waitForRequests(1);
  await fixture.waitForSilence();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.active, 1);
  assert.equal(fixture.peak, 1);
  const result = await releaseUntilDone(fixture, run);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 4);
  assert.equal(fixture.violations, 0);
});

test('check bounds evaluation concurrency and keeps result order', async () => {
  const target = sandbox.isolated('check-concurrency');
  const filepaths = ['src/a.txt', 'src/b.txt', 'src/c.txt', 'src/d.txt', 'src/e.txt'];
  const files: Record<string, string> = {};
  for (const filepath of filepaths) files[filepath] = 'alpha';
  writeFiles(target, files);
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture({ hold: true });
  fixture.limit = 2;
  const run = runCli(['check', '--json', '--verbose', '--concurrency', '2'], target, fixture.env);
  await fixture.waitForRequests(2);
  await fixture.waitForSilence();
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.peak, 2);
  const result = await releaseUntilDone(fixture, run);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 5);
  assert.equal(fixture.violations, 0);
  assert.ok(fixture.peak <= 2, String(fixture.peak));
  const report = reportNamed(parseCheckOutput(result, 'bounded concurrency'), 'basic', 'bounded concurrency');
  assert.deepEqual(scopeSubjects(report, 'bounded concurrency').map(subject => subject.filepath), filepaths);
});

test('inspect resolves explicit paths, names and home rules', async () => {
  const target = sandbox.isolated('inspect-resolve');
  writeFiles(target, { 'src/a.txt': 'alpha MARKER-OK beta', 'other/b.txt': 'gamma MARKER-OK' });
  writeRule(target, 'marker', MARKER_ANY_TXT_RULE);
  writeHomeRule(target, 'home-marker', MARKER_ANY_TXT_RULE);
  const explicit = await runCli(['inspect', '.rulekeeper/marker.rule.ts', 'src'], target);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(
    explicit.stdout,
    /(^|\s)a\.txt\b/,
    `the inspected folder is the project root, so a.txt is root-relative: ${explicit.stdout}`,
  );
  assert.doesNotMatch(
    explicit.stdout,
    /src\/a\.txt/,
    `subject filepaths must stay relative to the inspected folder: ${explicit.stdout}`,
  );
  assert.ok(!explicit.stdout.includes('b.txt'), explicit.stdout);
  const byName = await runCli(['inspect', 'marker'], target);
  assert.equal(byName.status, 0, byName.stderr);
  assert.ok(byName.stdout.includes('src/a.txt'), byName.stdout);
  assert.ok(byName.stdout.includes('other/b.txt'), byName.stdout);
  const fromHome = await runCli(['inspect', 'home-marker'], target);
  assert.equal(fromHome.status, 0, fromHome.stderr);
  assert.ok(fromHome.stdout.includes('home-marker'), fromHome.stdout);
  assert.ok(fromHome.stdout.includes('src/a.txt'), fromHome.stdout);
  expectFailure(await runCli(['inspect', 'nope'], target), 'unknown rule name');
});

test('inspect explains skipped rules without contacting the backend', async () => {
  const target = sandbox.isolated('inspect-skip');
  writeFiles(target, { 'internal/infra/store.go': GO_SOURCE });
  writeRule(target, 'gate-dir', GATE_DIRECTORY);
  writeRule(target, 'off', DISABLED);
  const fixture = await decisionFixture();
  const gated = await runCli(['inspect', 'gate-dir'], target, fixture.env);
  assert.equal(gated.status, 0, gated.stderr);
  assert.match(gated.stdout, /\bskip(ped)?\b/i, gated.stdout);
  const disabled = await runCli(['inspect', 'off'], target, fixture.env);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /disabled/i);
  assert.equal(fixture.requests.length, 0);
});

test('inspect shows the regex pattern, inputs and results', async () => {
  const target = sandbox.isolated('inspect-regex');
  writeFiles(target, { 'src/a.txt': 'alpha MARKER-OK beta' });
  writeRule(target, 'marker', markerRule('Missing marker'));
  const result = await runCli(['inspect', 'marker'], target);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('alpha MARKER-OK beta'), result.stdout);
  assert.match(result.stdout, /"pattern":"MARKER-OK"/, result.stdout);
  assert.match(result.stdout, /"input":"alpha MARKER-OK beta"/, result.stdout);
  assert.match(result.stdout, /"matched":true/, result.stdout);
});

test('inspect exits 1 after a completed violation', async () => {
  const target = sandbox.isolated('inspect-violation');
  writeFiles(target, { 'src/a.txt': 'alpha without the marker' });
  writeRule(target, 'marker', markerRule('Missing marker'));
  const result = await runCli(['inspect', 'marker'], target);
  assert.equal(
    result.status,
    1,
    `expected exit 1 for a completed violation (stdout: ${result.stdout} stderr: ${result.stderr})`,
  );
  assert.ok(result.stdout.includes('src/a.txt'), result.stdout);
  assert.ok(result.stdout.includes('alpha without the marker'), result.stdout);
  assert.match(result.stdout, /\bviolation\b/, result.stdout);
  assert.ok(result.stdout.includes('Missing marker'), result.stdout);
});

test('inspect shows custom trace messages', async () => {
  const target = sandbox.isolated('inspect-custom');
  writeFiles(target, { 'src/keep-a.txt': 'alpha', 'src/skip.txt': 'gamma' });
  writeRule(target, 'custom-select', CUSTOM_SELECT);
  const result = await runCli(['inspect', 'custom-select'], target);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('custom-check'), result.stdout);
  assert.ok(result.stdout.includes('generated file'), result.stdout);
});

test('inspect shows the AI exchange', async () => {
  const target = sandbox.isolated('inspect-ai');
  writeFiles(target, { 'src/one.txt': 'SECRET-SOURCE-TEXT' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture();
  const result = await runCli(['inspect', 'basic'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('Files must be tidy.'), result.stdout);
  assert.ok(result.stdout.includes('SECRET-SOURCE-TEXT'), result.stdout);
  assert.ok(result.stdout.includes('follows_instructions'), result.stdout);
  assert.equal(fixture.requests.length, 1);
});

test('inspect keeps streamed output and reports the failing stage', async () => {
  const target = sandbox.isolated('inspect-failure');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'gate-throw', GATE_THROW);
  const result = await runCli(['inspect', 'gate-throw'], target);
  expectStreamingFailure(result, 'inspect failure');
  assert.ok(result.stderr.includes('gate exploded'), result.stderr);
  assert.ok(
    result.stdout.includes('gate-throw'),
    `already-streamed rule output must survive the failure: ${result.stdout}`,
  );
  const failureLine = result.stdout.split('\n').find(line => line.includes('gate exploded'));
  assert.ok(failureLine !== undefined, `inspect must stream the failure itself: ${result.stdout}`);
  assert.match(
    failureLine.replace('gate exploded', ''),
    /\bwhen\b/,
    `the streamed failure must name the failing stage separately from the error message: ${failureLine}`,
  );
});

test('usage errors exit 2 while removed commands and options stay unknown', async () => {
  const target = sandbox.isolated('usage');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'ok', PASS_RULE);
  const help = await runCli(['--help'], target);
  assert.equal(help.status, 0, help.stderr);
  for (const command of ['validate', 'check', 'inspect']) {
    assert.ok(help.stdout.includes(command), help.stdout);
  }
  for (const args of [
    ['nope'],
    ['stats'],
    ['stats', 'reset'],
    ['check', '--diff-only'],
    ['check', '--base', 'main'],
    ['check', '--bogus'],
    ['inspect'],
  ]) {
    expectFailure(await runCli(args, target), `usage ${args.join(' ')}`);
  }
});

test('implicit help commands exit 0 while invalid help targets and usage errors stay failures', async () => {
  const target = sandbox.isolated('help-exit');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'ok', PASS_RULE);
  for (const args of [
    ['help'],
    ['help', 'check'],
    ['help', 'validate'],
    ['help', 'inspect'],
    ['--help'],
    ['check', '--help'],
    ['validate', '--help'],
    ['inspect', '--help'],
  ]) {
    const result = await runCli(args, target);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.notEqual(result.stdout, '', `${args.join(' ')} must print help on stdout`);
    assert.equal(result.stderr, '', `${args.join(' ')} must not write diagnostics: ${result.stderr}`);
  }
  for (const args of [['help', 'nope'], ['help', 'stats'], ['check', '--bogus']]) {
    expectFailure(await runCli(args, target), `usage ${args.join(' ')}`);
  }
  expectFailure(await runCli(['check', 'missing-dir'], target), 'runtime target failure');
});

async function caseInsensitiveFilesystem(root: string): Promise<boolean> {
  makeDirectory(join(root, 'CaseProbe'));
  try {
    return (await lstat(join(root, 'caseprobe'))).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

test('check accepts an absolute target whose root spelling differs only in case', async (context) => {
  const target = sandbox.isolated('check-case-varied');
  writeFiles(target, { 'src/a.txt': 'alpha', 'old/hidden.txt': 'archived' });
  writeRule(target, 'ok', PASS_RULE);
  if (!(await caseInsensitiveFilesystem(target.cwd))) {
    context.skip('filesystem is case-sensitive so a case-varied root path cannot exist');
    return;
  }
  const varied = join(dirname(target.cwd), basename(target.cwd).toUpperCase());
  for (const rootSpelling of [target.cwd, varied]) {
    const result = await runCli(
      ['check', '--json', join(rootSpelling, 'SRC', 'A.TXT')], target);
    assert.equal(result.status, 0, result.stderr);
    const report = reportNamed(parseCheckOutput(result, 'case-varied target'), 'ok', 'case-varied target');
    assert.equal(report.status, 'pass');
    assert.deepEqual(
      scopeSubjects(report, 'case-varied target').map(subject => subject.filepath),
      ['src/a.txt'],
    );
    expectFailure(
      await runCli(['check', join(rootSpelling, 'OLD')], target),
      'case-varied reserved directory',
    );
  }
});

test('numeric options reject invalid values', async () => {
  const target = sandbox.isolated('check-numbers');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'ok', PASS_RULE);
  for (const args of [
    ['check', '--concurrency', '0'],
    ['check', '--concurrency', '1.5'],
    ['check', '--concurrency', 'two'],
    ['check', '--threshold', '1.5'],
    ['check', '--threshold', '-0.1'],
    ['check', '--threshold', 'abc'],
  ]) {
    expectFailure(await runCli(args, target), `numeric ${args.join(' ')}`);
  }
  const accepted = await runCli(['check', '--json', '--concurrency', '1', '--threshold', '0'], target);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(reportNamed(parseCheckOutput(accepted, 'numbers'), 'ok', 'numbers').status, 'pass');
});

test('the runtime creates no statistics or database artifacts', async () => {
  const target = sandbox.isolated('check-artifacts');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'ok', PASS_RULE);
  const result = await runCli(['check', '--json'], target);
  assert.equal(result.status, 0, result.stderr);
  const artifacts = listTree(target.root).filter(
    path => /\.(?:db|sqlite3?)$/i.test(path) || /(^|\/)stats(?:\/|$)/i.test(path),
  );
  assert.deepEqual(artifacts, []);
  assert.deepEqual(listTree(target.home), []);
});

test('archived directories are never discovered, selected or scanned', async () => {
  const target = sandbox.isolated('check-archived');
  writeFiles(target, {
    'src/a.txt': 'alpha',
    'old/src/legacy.txt': 'legacy',
    'old/bad.rule.ts': `import { Rule, pass } from 'rulekeeper';
export default class Bad extends Rule {
  enabled = 'nope';
  check = pass;
}
`,
  });
  writeRule(target, 'ok', PASS_RULE);
  const result = await runCli(['check', '--json'], target);
  assert.equal(result.status, 0, result.stderr);
  const reports = parseCheckOutput(result, 'archived');
  assert.deepEqual(reports.map(report => report.name), ['ok']);
  assert.deepEqual(scopeSubjects(reports[0]!, 'archived').map(subject => subject.filepath), ['src/a.txt']);
  assert.ok(!result.stderr.includes('bad.rule.ts'), result.stderr);
  assert.ok(!result.stdout.includes('legacy'), result.stdout);
  const archived = await runCli(['validate', 'old/bad.rule.ts'], target);
  expectFailure(archived, 'validate archived');
  assert.match(archived.stderr, /archiv/i);
});

test('rule modules must default-export a branded class and keep unique names', async () => {
  const instanceTarget = sandbox.isolated('module-instance');
  writeFiles(instanceTarget, { 'src/a.txt': 'alpha' });
  writeRule(
    instanceTarget,
    'instance',
    `import { Rule, pass } from 'rulekeeper';
class Instance extends Rule {
  files = ['src/**/*.txt'];
  check = pass;
}
export default new Instance();
`,
  );
  const instance = await runCli(['check', '--json'], instanceTarget);
  expectFailure(instance, 'default instance');
  assert.ok(instance.stderr.includes('instance.rule.ts'), instance.stderr);

  const duplicateTarget = sandbox.isolated('module-duplicates');
  writeFiles(duplicateTarget, { 'src/a.txt': 'alpha' });
  writeRule(duplicateTarget, 'dup', PASS_RULE);
  writeHomeRule(duplicateTarget, 'dup', PASS_RULE);
  const duplicated = await runCli(['check', '--json'], duplicateTarget);
  expectFailure(duplicated, 'duplicate names');
  assert.ok(duplicated.stderr.includes(join(duplicateTarget.cwd, '.rulekeeper', 'dup.rule.ts')), duplicated.stderr);
  assert.ok(duplicated.stderr.includes(join(duplicateTarget.home, '.rulekeeper', 'dup.rule.ts')), duplicated.stderr);

  const emptyTarget = sandbox.isolated('module-none');
  const none = await runCli(['check', '--json'], emptyTarget);
  expectFailure(none, 'no rules');
  assert.match(none.stderr, /no rule files/i);
});

test('plain helper modules are ignored while .rule.mjs modules load', async () => {
  const target = sandbox.isolated('module-helpers');
  writeFiles(target, {
    'src/a.txt': 'alpha MARKER-OK',
    '.rulekeeper/helper.ts': "throw new Error('helper module must not be imported');\n",
    '.rulekeeper/mjs.rule.mjs': MJS_RULE,
  });
  const result = await runCli(['check', '--json'], target);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes('helper module must not be imported'));
  assert.deepEqual(parseCheckOutput(result, 'helpers').map(report => report.name), ['mjs']);
});

test('inspect resolves a named rule under the inspected folder root', async () => {
  const target = sandbox.isolated('inspect-named-root');
  writeFiles(target, { 'src/root.txt': 'nothing to see', 'sub/src/inner.txt': 'nothing to see' });
  writeRule(target, 'inner', markerRule('ROOT-SCOPE-MESSAGE'));
  writeFile(join(target.cwd, 'sub', '.rulekeeper', 'inner.rule.ts'), markerRule('INNER-SCOPE-MESSAGE'));
  const result = await runCli(['inspect', 'inner', 'sub'], target);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(
    result.stdout.includes(join(target.cwd, 'sub', '.rulekeeper', 'inner.rule.ts')),
    `the rule must come from the inspected folder root: ${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes('INNER-SCOPE-MESSAGE'),
    `the named rule under the inspected folder must run: ${result.stdout}`,
  );
  assert.equal(
    result.stdout.includes('ROOT-SCOPE-MESSAGE'),
    false,
    `the same-named rule at the invocation root must not be inspected: ${result.stdout}`,
  );
  assert.ok(result.stdout.includes('src/inner.txt'), result.stdout);
  assert.equal(
    result.stdout.includes('sub/src/inner.txt'),
    false,
    `subject filepaths must stay relative to the inspected folder: ${result.stdout}`,
  );
  assert.equal(result.stdout.includes('root.txt'), false, result.stdout);
});

test('inspect accepts an explicit rule with an absolute or sibling folder', async () => {
  const target = sandbox.isolated('inspect-folder-outside');
  writeRule(target, 'marker', MARKER_ANY_TXT_RULE);
  const sibling = join(target.root, 'sibling');
  writeFile(join(sibling, 'note.txt'), 'alpha without the marker');
  const ruleFile = join(target.cwd, '.rulekeeper', 'marker.rule.ts');
  for (const folder of [sibling, '../sibling']) {
    const result = await runCli(['inspect', '.rulekeeper/marker.rule.ts', folder], target);
    assert.equal(result.status, 1, `${folder}: ${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes(ruleFile), `${folder}: ${result.stdout}`);
    assert.ok(result.stdout.includes('note.txt'), `${folder}: ${result.stdout}`);
    assert.equal(
      result.stdout.includes('sibling/note.txt'),
      false,
      `${folder}: subjects must stay relative to the inspected folder: ${result.stdout}`,
    );
  }
});

test('inspect rejects a rule directory even when it contains one rule', async () => {
  const target = sandbox.isolated('inspect-rule-directory');
  writeFiles(target, { 'src/a.txt': 'alpha MARKER-OK beta' });
  writeFile(join(target.cwd, 'rules', 'marker.rule.ts'), MARKER_ANY_TXT_RULE);
  expectFailure(await runCli(['inspect', 'rules', 'src'], target), 'inspect rule directory');
});

test('inspect keeps reserved source directories out of the inspected root', async () => {
  const target = sandbox.isolated('inspect-reserved-root');
  writeFiles(target, { 'src/a.txt': 'alpha', 'old/src/legacy.txt': 'legacy MARKER-OK' });
  writeRule(target, 'marker', MARKER_ANY_TXT_RULE);
  const archived = await runCli(['inspect', '.rulekeeper/marker.rule.ts', 'old'], target);
  expectFailure(archived, 'archived inspect folder');
  assert.match(archived.stderr, /reserved/, archived.stderr);
  for (const folder of ['.rulekeeper', 'node_modules', '.git']) {
    expectFailure(
      await runCli(['inspect', '.rulekeeper/marker.rule.ts', folder], target),
      `reserved inspect folder ${folder}`,
    );
  }
});

test('inspect streams selected files before a malformed JSON parser failure', async () => {
  const target = sandbox.isolated('inspect-parse-failure');
  writeFiles(target, { 'data/broken.json': '{ "value": ' });
  writeRule(target, 'json-values', JSON_VALUES);
  const result = await runCli(['inspect', 'json-values'], target);
  expectStreamingFailure(result, 'inspect parse failure');
  assert.match(result.stderr, /could not be parsed/i, result.stderr);
  const selected = result.stdout.indexOf('data/broken.json');
  const failure = result.stdout.indexOf('could not be parsed');
  assert.ok(selected !== -1, `the selected file event must be streamed: ${result.stdout}`);
  assert.ok(failure !== -1, `the parser failure must be streamed: ${result.stdout}`);
  assert.ok(selected < failure, `the file event must precede the parser failure: ${result.stdout}`);
  const failureLine = result.stdout.split('\n').find(line => line.includes('could not be parsed'));
  assert.match(
    failureLine ?? '',
    /\bselect\b|\bscope\b/,
    `the streamed failure must name its stage: ${result.stdout}`,
  );
});

test('inspect explains a selector with no matches without contacting the backend', async () => {
  const target = sandbox.isolated('inspect-no-subjects');
  writeFiles(target, { 'data/present.json': '{ "value": 1 }' });
  writeRule(target, 'json-missing', JSON_MISSING);
  const fixture = await decisionFixture();
  const result = await runCli(['inspect', 'json-missing'], target, fixture.env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /no matching subjects/i, result.stdout);
  assert.equal(fixture.requests.length, 0);
});

test('framework errors escape control bytes before reaching the terminal', async () => {
  const target = sandbox.isolated('cli-error-escapes');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'esc-throw', ESC_THROW);

  const missing = await runCli(['check', '--json', 'missing\u001b[31m.txt'], target);
  expectFailure(missing, 'escaped target path');
  assert.equal(missing.stderr.includes('\u001b'), false, `target errors must be escaped: ${missing.stderr}`);
  assert.ok(missing.stderr.includes('missing'), missing.stderr);

  const thrown = await runCli(['check', '--json'], target);
  expectFailure(thrown, 'escaped check error');
  assert.equal(thrown.stderr.includes('\u001b'), false, `check errors must be escaped: ${thrown.stderr}`);
  assert.ok(thrown.stderr.includes('boom'), thrown.stderr);

  const unknown = await runCli(['check', '--bogus\u001b[31m'], target);
  expectFailure(unknown, 'escaped unknown option');
  assert.equal(unknown.stderr.includes('\u001b'), false, `usage errors must be escaped: ${unknown.stderr}`);
  assert.ok(unknown.stderr.includes('bogus'), unknown.stderr);
});

test('check debug output escapes trace metadata keys without dumping bodies', async () => {
  const target = sandbox.isolated('check-debug-escapes');
  writeFiles(target, { 'src/a.txt': 'TRACE-BODY-VALUE' });
  writeRule(target, 'esc-trace', ESC_TRACE);
  const result = await runCli(['check', '--debug'], target);
  assert.equal(result.status, 0, result.stderr);
  const combined = result.stdout + result.stderr;
  assert.ok(combined.includes('escaped-detail'), combined);
  assert.equal(combined.includes('\u001b'), false, `debug trace keys must be escaped: ${combined}`);
  assert.equal(
    combined.includes('TRACE-BODY-VALUE'),
    false,
    `debug metadata must not dump traced bodies: ${combined}`,
  );
});

const AI_ALPHA = `import { Rule, ai } from 'rulekeeper';
export default class Alpha extends Rule {
  files = ['src/**/*.txt'];
  check = ai({ rule: 'Alpha must hold.' });
}
`;

const AI_BETA = `import { Rule, ai } from 'rulekeeper';
export default class Beta extends Rule {
  files = ['src/**/*.txt'];
  check = ai({ rule: 'Beta must hold.' });
}
`;

const TRACE_LEAK = `import { Rule, pass } from 'rulekeeper';
export default class TraceLeak extends Rule {
  files = ['src/**/*.txt'];
  check = (subject, context) => {
    context.trace('observed', { filepath: subject.filepath, source: subject.source });
    return pass();
  };
}
`;

const GROUPED_PROJECT = `import { Rule, violation } from 'rulekeeper';
export default class GroupedProject extends Rule {
  files = ['src/**/*.txt'];
  group = 'project';
  check = () => violation('project-wide problem');
}
`;

test('check verbose associates each streamed event with its rule name', async () => {
  const target = sandbox.isolated('check-verbose-names');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'alpha', AI_ALPHA);
  writeRule(target, 'beta', AI_BETA);
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--verbose'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  const diagnostics = result.stdout + result.stderr;
  for (const name of ['alpha', 'beta']) {
    for (const kind of ['request', 'response', 'result']) {
      assert.match(
        diagnostics,
        new RegExp(`^${kind} ${name} `, 'm'),
        `a ${kind} event must name its rule: ${diagnostics}`,
      );
    }
  }
  assert.equal(fixture.requests.length, 2);
});

test('check honors --debug and --verbose together at concurrency 1', async () => {
  const target = sandbox.isolated('check-debug-verbose');
  writeFiles(target, { 'src/a.txt': 'alpha', 'src/b.txt': 'beta', 'src/c.txt': 'gamma' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture({ hold: true });
  fixture.limit = 1;
  const run = runCli(['check', '--debug', '--verbose'], target, fixture.env);
  await fixture.waitForRequests(1);
  await fixture.waitForSilence();
  assert.equal(fixture.active, 1);
  assert.equal(fixture.peak, 1);
  const result = await releaseUntilDone(fixture, run);
  assert.equal(result.status, 0, result.stderr);
  const diagnostics = result.stdout + result.stderr;
  assert.ok(diagnostics.includes('"state"'), `verbose rendering must survive --debug: ${diagnostics}`);
  assert.ok(diagnostics.includes('Files must be tidy.'), diagnostics);
  assert.ok(diagnostics.includes('alpha'), diagnostics);
  assert.equal(fixture.requests.length, 3);
});

test('check redacts configured credentials from diagnostics but not the machine report', async () => {
  const target = sandbox.isolated('check-redaction');
  const credential = 'super"secret\\key';
  const escaped = JSON.stringify(credential).slice(1, -1);
  writeFiles(target, { 'src/one.txt': `token ${credential} end` });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  writeRule(target, 'trace-leak', TRACE_LEAK);
  const fixture = await decisionFixture({ apiKey: credential });

  const verbose = await runCli(['check', '--verbose'], target, fixture.env);
  assert.equal(verbose.status, 0, verbose.stderr);
  const diagnostics = verbose.stdout + verbose.stderr;
  assert.ok(diagnostics.includes('token'), diagnostics);
  assert.ok(diagnostics.includes('[REDACTED]'), diagnostics);
  assert.equal(diagnostics.includes(credential), false, diagnostics);
  assert.equal(diagnostics.includes(escaped), false, diagnostics);

  const inspected = await runCli(['inspect', 'trace-leak'], target, fixture.env);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.ok(inspected.stdout.includes('[REDACTED]'), inspected.stdout);
  assert.equal(inspected.stdout.includes(credential), false, inspected.stdout);
  assert.equal(inspected.stdout.includes(escaped), false, inspected.stdout);

  const machine = await runCli(['check', '--json'], target, fixture.env);
  assert.equal(machine.status, 0, machine.stderr);
  assert.ok(machine.stdout.includes(escaped), 'the machine report keeps complete subject data');

  const paddedEnv = { ...fixture.env, TYPESAFE_API_KEY: `  ${credential}\t` };
  const before = fixture.requests.length;
  const padded = await runCli(['check', '--verbose'], target, paddedEnv);
  assert.equal(padded.status, 0, padded.stderr);
  assert.equal(fixture.requests.length, before + 1);
  assert.equal(
    fixture.requests[before]!.authorization,
    `Bearer ${credential}`,
    'the transport uses the trimmed key, so diagnostics must redact it too',
  );
  const paddedDiagnostics = padded.stdout + padded.stderr;
  assert.ok(paddedDiagnostics.includes('[REDACTED]'), paddedDiagnostics);
  assert.equal(paddedDiagnostics.includes(credential), false, paddedDiagnostics);
  assert.equal(paddedDiagnostics.includes(escaped), false, paddedDiagnostics);
});

test('check names grouped violation members with locations and excerpts', async () => {
  const target = sandbox.isolated('check-grouped-members');
  writeFiles(target, { 'src/alpha.txt': 'alpha body', 'src/beta.txt': 'beta body' });
  writeRule(target, 'grouped-project', GROUPED_PROJECT);
  const human = await runCli(['check'], target);
  assert.equal(human.status, 1, human.stderr);
  assert.ok(human.stdout.includes('project-wide problem'), human.stdout);
  assert.match(human.stdout, /group project \./, human.stdout);
  for (const filepath of ['src/alpha.txt', 'src/beta.txt']) {
    assert.ok(human.stdout.includes(filepath), human.stdout);
  }
  assert.ok(human.stdout.includes('alpha body'), human.stdout);
  assert.ok(human.stdout.includes('beta body'), human.stdout);

  const json = await runCli(['check', '--json'], target);
  assert.equal(json.status, 1, json.stderr);
  const report = reportNamed(parseCheckOutput(json, 'grouped members'), 'grouped-project', 'grouped members');
  const subject = report.evaluations[0]?.subject;
  if (subject === undefined || subject.kind !== 'group') {
    throw new Error(`expected a grouped subject: ${JSON.stringify(subject)}`);
  }
  assert.deepEqual(subject.group, { type: 'project', path: '.' });
  assert.deepEqual(subject.members.map(member => member.filepath), ['src/alpha.txt', 'src/beta.txt']);
});

test('check bounds grouped members and excerpts with a truncation notice', async () => {
  const target = sandbox.isolated('check-grouped-bounded');
  const files: Record<string, string> = {};
  for (let index = 1; index <= 8; index += 1) {
    const name = `src/case-${String(index).padStart(2, '0')}.txt`;
    files[name] = index === 1 ? LONG_SOURCE : `payload-${String(index).padStart(2, '0')}`;
  }
  writeFiles(target, files);
  writeRule(target, 'grouped-project', GROUPED_PROJECT);
  const human = await runCli(['check'], target);
  assert.equal(human.status, 1, human.stderr);
  assert.ok(human.stdout.includes('src/case-01.txt'), human.stdout);
  assert.ok(human.stdout.includes('src/case-05.txt'), human.stdout);
  assert.ok(!human.stdout.includes('src/case-06.txt'), human.stdout);
  assert.ok(!human.stdout.includes('src/case-08.txt'), human.stdout);
  assert.match(human.stdout, /more members/, human.stdout);
  assert.ok(human.stdout.includes('line-0001'), human.stdout);
  assert.ok(!human.stdout.includes('line-0006'), human.stdout);
  assert.match(human.stdout, /more lines/, human.stdout);
  assert.match(human.stdout, /--json/, human.stdout);
});

const SHORT_KEY_LEAK = `import { Rule } from 'rulekeeper';
export default class LeakyError extends Rule {
  files = ['src/**/*.txt'];
  check = () => {
    throw new Error('boom ' + process.env.TYPESAFE_API_KEY + ' mark');
  };
}
`;

test('a short credential stays redacted inside diagnostics without corrupting the prefix', async () => {
  const target = sandbox.isolated('check-short-key');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'leaky-error', SHORT_KEY_LEAK);
  const env = { TYPESAFE_API_KEY: 'k' };

  const thrown = await runCli(['check', '--json'], target, env);
  assert.equal(thrown.status, 2, `${thrown.stdout}\n${thrown.stderr}`);
  assert.equal(thrown.stdout, '');
  assert.ok(thrown.stderr.startsWith('rulekeeper: '), `the prefix is public contract: ${thrown.stderr}`);
  assert.ok(thrown.stderr.includes('[REDACTED]'), thrown.stderr);
  assert.equal(thrown.stderr.includes('boom k mark'), false, thrown.stderr);

  const usage = await runCli(['check', '--kaboom'], target, env);
  assert.equal(usage.status, 2, usage.stderr);
  assert.ok(usage.stderr.startsWith('rulekeeper: '), `the prefix is public contract: ${usage.stderr}`);
  assert.ok(usage.stderr.includes('[REDACTED]'), usage.stderr);
});
