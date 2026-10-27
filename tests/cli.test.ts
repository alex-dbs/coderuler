import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { runProgram } from '../dist/adapter/cli/program.js';
import { terminalCapabilities } from '../dist/adapter/cli/progress.js';
import { createRuleDependencyManager } from '../dist/adapter/filesystem/dependencies.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';
import { createServices } from '../dist/infra/runtime.js';
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
  withLoadOverrides,
  type DecisionFixture,
  type DecisionFixtureOptions,
  type Sandbox,
  type CliResult,
} from './support.ts';

const sandbox = createSandbox('coderuler-cli-');

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

async function runCommand(argv: readonly string[], target: Sandbox, overrides: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const env = { ...target.env, ...overrides };
  const loader = createRuleLoader({
    home: target.home,
    dependencies: createRuleDependencyManager({ cacheRoot: join(target.home, '.cache', 'coderuler', 'dependencies') }),
  });
  const services = withLoadOverrides({
    ...createServices(target.cwd, env),
    write: text => { stdout.push(text); },
    writeError: text => { stderr.push(text); },
    terminal: terminalCapabilities({ stdoutIsTTY: false, stderrIsTTY: false }, env),
  }, {
    check: { loadRules: selection => loader.load(selection) },
    inspect: { loadRules: selection => loader.load(selection) },
    test: { loadRules: selection => loader.load(selection) },
    validate: { loadRules: selection => loader.load(selection) },
  });
  const status = await runProgram(argv, services);
  return { status, stdout: stdout.join(''), stderr: stderr.join('') } satisfies CliResult;
}

function writeFiles(target: Sandbox, files: Readonly<Record<string, string>>): void {
  for (const [path, contents] of Object.entries(files)) writeFile(join(target.cwd, path), contents);
}

function writeRule(target: Sandbox, name: string, source: string): string {
  return writeFile(join(target.cwd, '.coderuler', `${name}.rule.ts`), source);
}

function writeHomeRule(target: Sandbox, name: string, source: string): string {
  return writeFile(join(target.home, '.coderuler', `${name}.rule.ts`), source);
}

function walkthroughBlocks(output: string): readonly string[] {
  return output.trim().split(/\n[ \t]*\n/);
}

function evaluationCards(output: string): readonly string[] {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const cards: string[] = [];
  let lines: string[] | undefined;
  for (const line of plain.split('\n')) {
    if (line.startsWith('╭')) {
      assert.equal(lines, undefined, `evaluation cards must not overlap: ${output}`);
      lines = [];
    } else if (line.startsWith('╰')) {
      assert.ok(lines !== undefined, `card footer needs a header: ${output}`);
      cards.push(lines.join('\n'));
      lines = undefined;
    } else if (lines !== undefined) {
      assert.match(line, /^│.*│$/, `only card content may appear inside an evaluation: ${output}`);
      lines.push(line.slice(2, -1).trimEnd());
    }
  }
  assert.equal(lines, undefined, `every evaluation card must close: ${output}`);
  return cards;
}

function cardSection(card: string, title: string): string {
  const lines = card.split('\n');
  const start = lines.findIndex(line => line === `  ${title}` || line.startsWith(`  ${title} ─`));
  assert.ok(start >= 0, `missing ${title} section: ${card}`);
  const next = lines.findIndex((line, index) => index > start && /^  [A-Z]/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trimEnd();
}

function assertCardMetadata(card: string, name: string, filepath: string, scope = '$'): void {
  assert.match(card, new RegExp(`^evaluation ${name}$`, 'm'));
  assert.equal(card.split('\n').filter(line => line.trim() === `file: ${filepath}`).length, 1, card);
  assert.equal(card.split('\n').filter(line => line.trim() === `scope: ${scope}`).length, 1, card);
  const sections = card.slice(card.indexOf('\n  Source'));
  assert.doesNotMatch(sections, /^\s*(?:file|scope|rule): /m);
}

function assertWirePayload(section: string, payload: unknown): void {
  assert.ok(section.replace(/\s/g, '').includes(JSON.stringify(payload).replace(/\s/g, '')), section);
}

function indentedJsonPayloads(output: string): readonly unknown[] {
  const lines = output.split('\n');
  const payloads: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = /^(\s+)\{$/.exec(lines[index]!);
    if (start === null) continue;
    const indent = start[1]!;
    const end = lines.findIndex((line, position) => position > index && line === `${indent}}`);
    assert.ok(end > index, `JSON payload must have an indented closing brace: ${output}`);
    payloads.push(JSON.parse(lines.slice(index, end + 1).map(line => line.slice(indent.length)).join('\n')));
    index = end;
  }
  return payloads;
}

const PASS_RULE = `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Pass extends Rule {
  files = ['src/**/*.txt'];
  check = pass;
}
`;

const SCAN_RULE = `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Scan extends Rule {
  files = ['**/*'];
  check = pass;
}
`;

const AI_WHOLE_FILE = `import { Rule, ai } from '@alex-dbs/coderuler';
export default class Basic extends Rule {
  files = ['src/**/*.txt'];
  check = ai({ rule: 'Files must be tidy.', violationMessage: 'Not tidy' });
}
`;

const JSON_VALUES = `import { Rule, ai, scopes } from '@alex-dbs/coderuler';
export default class Values extends Rule {
  files = ['data/*.json'];
  scope = scopes.json({ path: '$.value' });
  check = ai({ rule: 'Values must be present.' });
}
`;

const GROUPED_FOLDERS = `import { Rule, ai } from '@alex-dbs/coderuler';
export default class Grouped extends Rule {
  files = ['config/**/*.yml'];
  group = 'folder';
  check = ai({ rule: 'Keys must be unique.' });
}
`;

const INPUT_OVERRIDE = `import { Rule, ai } from '@alex-dbs/coderuler';
export default class Input extends Rule {
  files = ['src/**/*.txt'];
  check = ai({
    rule: 'Inputs must be explicit.',
    input: (subject, context) => ({ filepath: subject.filepath, kind: subject.kind, rooted: context.project.root.length > 0 }),
  });
}
`;

const EXAMPLES_RULE = `import { Rule, ai } from '@alex-dbs/coderuler';
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

const GATE_DIRECTORY = `import { Rule, ai, scopes } from '@alex-dbs/coderuler';
export default class Infra extends Rule {
  files = ['internal/infra/**/*.go'];
  scope = scopes.astGrep({ language: 'go', rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }] } });
  async when({ project }) {
    return (await project.stat('internal/adapter'))?.kind === 'directory';
  }
  check = ai({ rule: 'Infrastructure must not carry business policy.' });
}
`;

const GATE_REASON = `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Reasoned extends Rule {
  files = ['src/**/*.txt'];
  async when() {
    return { applies: false, reason: 'maintenance window' };
  }
  check = pass;
}
`;

const GATE_THROW = `import { Rule, pass } from '@alex-dbs/coderuler';
export default class GateThrow extends Rule {
  files = ['src/**/*.txt'];
  async when() {
    throw new Error('gate exploded');
  }
  check = pass;
}
`;

const CUSTOM_SELECT = `import { Rule, pass, violation } from '@alex-dbs/coderuler';
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

const CUSTOM_READS = `import { Rule, pass, violation } from '@alex-dbs/coderuler';
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

const CUSTOM_OUTSIDE = `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Outside extends Rule {
  files = ['src/**/*.txt'];
  async select() {
    return [{ kind: 'scope', filepath: 'outside.txt', id: '$', source: 'outside' }];
  }
  check = pass;
}
`;

const CUSTOM_DUPLICATE = `import { Rule, pass } from '@alex-dbs/coderuler';
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

const THROWING_CHECK = `import { Rule } from '@alex-dbs/coderuler';
export default class Boom extends Rule {
  files = ['src/**/*.txt'];
  check = async () => {
    throw new Error('check exploded');
  };
}
`;

const NO_MATCH = `import { Rule, pass } from '@alex-dbs/coderuler';
export default class NoMatch extends Rule {
  files = ['missing/**/*.txt'];
  check = pass;
}
`;

const DISABLED = `import { Rule, violation } from '@alex-dbs/coderuler';
export default class Off extends Rule {
  enabled = false;
  files = ['src/**/*.txt'];
  check = () => violation('never runs');
}
`;

const MJS_RULE = `import { Rule, regex } from '@alex-dbs/coderuler';
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
  return `import { Rule, regex } from '@alex-dbs/coderuler';
export default class Marker extends Rule {
  files = ['src/**/*.txt'];
  check = regex({ pattern: /MARKER-OK/g, violationMessage: ${JSON.stringify(message)} });
}
`;
}

const MARKER_ANY_TXT_RULE = `import { Rule, regex } from '@alex-dbs/coderuler';
export default class MarkerAnyTxt extends Rule {
  files = ['**/*.txt'];
  check = regex({ pattern: /MARKER-OK/g, violationMessage: 'Missing marker' });
}
`;

function longRule(): string {
  return `import { Rule, regex } from '@alex-dbs/coderuler';
export default class Long extends Rule {
  files = ['long/*.txt'];
  check = regex({ pattern: /MARKER-OK/g, violationMessage: 'no marker' });
}
`;
}

function manyRule(): string {
  return `import { Rule, regex } from '@alex-dbs/coderuler';
export default class Many extends Rule {
  files = ['many/*.txt'];
  check = regex({ pattern: /MARKER-OK/g, violationMessage: 'no marker' });
}
`;
}

const JSON_MISSING = `import { Rule, ai, scopes } from '@alex-dbs/coderuler';
export default class Missing extends Rule {
  files = ['data/*.json'];
  scope = scopes.json({ path: '$.missing' });
  check = ai({ rule: 'Missing values must be explained.' });
}
`;

const ESC_THROW = `import { Rule } from '@alex-dbs/coderuler';
export default class EscThrow extends Rule {
  files = ['src/**/*.txt'];
  check = async () => {
    throw new Error('boom \\u001b[31mred');
  };
}
`;

const ESC_TRACE = `import { Rule, pass } from '@alex-dbs/coderuler';
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
    `import { Rule } from '@alex-dbs/coderuler';
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

test('validate selects rule names from project and home discovery', async () => {
  const target = sandbox.isolated('validate-name');
  writeFile(join(target.cwd, '.coderuler', 'nested', 'project-choice.rule.ts'), PASS_RULE);
  writeHomeRule(target, 'home-choice', PASS_RULE);
  writeRule(target, 'unrelated', 'throw new Error("unrelated rule imported");');

  for (const [name, excluded] of [
    ['project-choice', 'home-choice'],
    ['home-choice', 'project-choice'],
  ] as const) {
    const result = await runCli(['validate', name], target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `Valid rule: ${name}`);
    assert.ok(!result.stdout.includes(excluded), result.stdout);
  }
});

test('rule names reject missing and ambiguous selections', async () => {
  const target = sandbox.isolated('rule-name-errors');
  const projectRule = writeRule(target, 'shared-choice', PASS_RULE);
  const homeRule = writeHomeRule(target, 'shared-choice', PASS_RULE);
  writeRule(target, 'available', PASS_RULE);
  writeHomeRule(target, 'home-available', PASS_RULE);

  for (const args of [
    ['check', '--rules', 'missing-choice'],
    ['validate', 'missing-choice'],
    ['test', 'missing-choice'],
  ]) {
    const result = await runCli(args, target);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes('missing-choice'), result.stderr);
  }

  for (const args of [
    ['check', '--rules', 'shared-choice'],
    ['validate', 'shared-choice'],
    ['test', 'shared-choice'],
  ]) {
    const result = await runCli(args, target);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes('shared-choice'), result.stderr);
    assert.ok(result.stderr.includes(projectRule), result.stderr);
    assert.ok(result.stderr.includes(homeRule), result.stderr);
  }
});

test('validate reports malformed modules and invalid disabled rules', async () => {
  const malformedTarget = sandbox.isolated('validate-malformed');
  writeRule(
    malformedTarget,
    'broken',
    `import { Rule, pass } from '@alex-dbs/coderuler';
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
    `import { Rule, pass } from '@alex-dbs/coderuler';
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

test('check reports a passing rule in the complete JSON envelope with --output-all', async () => {
  const target = sandbox.isolated('check-pass');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'ok', PASS_RULE);
  const result = await runCli(['check', '--json', '--output-all'], target);
  assert.equal(result.status, 0, result.stderr);
  const reports = parseCheckOutput(result, 'check pass');
  assert.deepEqual(reports.map(report => report.name), ['ok']);
  const report = reports[0]!;
  assert.equal(report.status, 'pass');
  assert.ok(report.ruleFile.endsWith(join('.coderuler', 'ok.rule.ts')), report.ruleFile);
  assert.deepEqual(scopeSubjects(report, 'check pass').map(subject => subject.filepath), ['src/a.txt']);
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result.status), ['pass']);
});

test('check selects rule names across supported suffixes', async () => {
  for (const suffix of ['ts', 'mts', 'js', 'mjs']) {
    const target = sandbox.isolated(`check-name-${suffix}`);
    writeFiles(target, {
      'src/a.txt': 'no marker here',
      [`.coderuler/nested/go-append-slice.rule.${suffix}`]: markerRule('Missing marker'),
      '.coderuler/go-append-slice-extra.rule.ts': 'throw new Error("unrelated rule imported");',
    });
    const result = await runCli(['check', '--rules', 'go-append-slice', '--json', '--output-all'], target);
    assert.equal(result.status, 1, result.stderr);
    const reports = parseCheckOutput(result, `named check ${suffix}`);
    assert.deepEqual(reports.map(report => {
      const subjects = scopeSubjects(report, `named check ${suffix}`);
      return {
        name: report.name,
        status: report.status,
        scopes: subjects.map(subject => subject.filepath),
        evaluations: report.evaluations.map(evaluation => ({
          status: evaluation.result.status,
          message: evaluation.result.message,
        })),
      };
    }), [{
      name: 'go-append-slice',
      status: 'violation',
      scopes: ['src/a.txt'],
      evaluations: [{ status: 'violation', message: 'Missing marker' }],
    }]);
  }
});

test('check filters rules by tags', async () => {
  const target = sandbox.isolated('check-tags');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  const definitions: readonly (readonly [string, readonly string[] | undefined, string])[] = [
    ['a-go', ['go'], 'pass()'],
    ['b-go-security', ['go', 'security'], "violation('tagged violation')"],
    ['c-security', ['security'], 'pass()'],
    ['d-untagged', undefined, 'pass()'],
    ['e-empty', [], 'pass()'],
  ];
  for (const [name, tags, result] of definitions) {
    writeRule(target, name, `import { Rule, pass, violation } from '@alex-dbs/coderuler';
export default class extends Rule {
  ${tags === undefined ? '' : `tags = ${JSON.stringify(tags)};`}
  files = ['src/*.txt'];
  check = () => ${result};
}
`);
  }

  const cases = [
    {
      name: 'default',
      args: [],
      names: ['a-go', 'b-go-security', 'c-security', 'd-untagged', 'e-empty'],
      status: 1,
    },
    { name: 'include either tag', args: ['--tags', 'go', 'security'], names: ['a-go', 'b-go-security', 'c-security'], status: 1 },
    { name: 'exclude security', args: ['--exclude-tags', 'security'], names: ['a-go', 'd-untagged', 'e-empty'], status: 0 },
    { name: 'exclude wins', args: ['--tags', 'go', '--exclude-tags', 'security'], names: ['a-go'], status: 0 },
    { name: 'exclude all included rules', args: ['--tags', 'security', '--exclude-tags', 'security'], names: [], status: 0 },
    { name: 'unknown tag', args: ['--tags', 'unknown'], names: [], status: 0 },
    { name: 'case-sensitive tag', args: ['--tags', 'GO'], names: [], status: 0 },
    {
      name: 'explicit rule filtered by tag',
      args: ['--rules', '.coderuler/a-go.rule.ts', '--tags', 'security'],
      names: [],
      status: 0,
    },
  ] as const;
  for (const { name, args, names, status } of cases) {
    const result = await runCommand(['check', '--json', '--output-all', ...args], target);
    assert.equal(result.status, status, `${name}: ${result.stderr}`);
    const reports = parseCheckOutput(result, name);
    assert.deepEqual(reports.map(report => report.name).sort(), names, name);
    for (const report of reports) {
      assert.equal(report.status, report.name === 'b-go-security' ? 'violation' : 'pass', name);
    }
  }
});

test('check excludes tagged rules before running hooks', async () => {
  const target = sandbox.isolated('check-tags-hooks');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'go', `import { Rule, pass } from '@alex-dbs/coderuler';
export default class extends Rule {
  tags = ['go'];
  files = ['src/*.txt'];
  check = () => pass();
}
`);
  writeRule(target, 'security', `import { Rule, pass } from '@alex-dbs/coderuler';
export default class extends Rule {
  tags = ['security'];
  files = ['src/*.txt'];
  when = () => { throw new Error('excluded hook ran'); };
  check = () => pass();
}
`);

  const result = await runCli(['check', '--json', '--output-all', '--exclude-tags', 'security'], target);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseCheckOutput(result, 'filtered hooks').map(report => report.name), ['go']);
});

test('check validates tags before filtering rules', async () => {
  const target = sandbox.isolated('check-tags-invalid');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'broken-tags', `import { Rule, pass } from '@alex-dbs/coderuler';
export default class extends Rule {
  tags = 'security';
  files = ['src/*.txt'];
  check = () => pass();
}
`);

  const result = await runCli(['check', '--tags', 'go'], target);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /broken-tags\.rule\.ts/);
  assert.match(result.stderr, /tags/);
});

test('check JSONL preserves complete ordered reports and machine exit statuses', async () => {
  const target = sandbox.isolated('check-jsonl');
  writeFiles(target, { 'src/a.txt': 'alpha\ncafé 中文' });
  writeRule(target, 'aaa-pass', PASS_RULE);
  writeRule(target, 'zzz-marker', markerRule('Missing marker\nwith details'));
  const json = await runCli(['check', '--json', '--output-all'], target);
  const expected = parseCheckOutput(json, 'JSONL reference');
  assert.deepEqual(reportNamed(expected, 'zzz-marker', 'JSONL reference').evaluations[0]!.result, {
    status: 'violation',
    message: 'Missing marker\nwith details',
    locations: [{ filepath: 'src/a.txt', scopeId: '$', lines: { start: 1, end: 2 } }],
  });
  const assertJsonl = (stdout: string, reports: typeof expected): void => {
    const lines = stdout === '' ? [] : stdout.trimEnd().split('\n');
    parseCheckOutput({ status: reports.some(report => report.status === 'violation') ? 1 : 0, stdout, stderr: '' }, 'JSONL records', '--jsonl');
    const records = lines.map((line, index) => asMapping(JSON.parse(line), `JSONL record ${index}`));
    assert.deepEqual(
      records.map(({ durationMs: _durationMs, ...report }) => report),
      reports.map(({ durationMs: _durationMs, ...report }) => ({ type: 'rule', ...report })),
    );
    assert.equal(lines.length, reports.length);
    assert.ok(lines.every(line => line === JSON.stringify(JSON.parse(line))));
    assert.equal(stdout.includes('\u001b'), false);
  };
  for (const diagnostic of [[], ['--debug'], ['--verbose']]) {
    const result = await runCli(['check', '--jsonl', '--output-all', ...diagnostic], target);
    assert.equal(result.status, 1, result.stderr);
    assertJsonl(result.stdout, expected);
    if (diagnostic.length === 0) assert.equal(result.stderr, '');
    else assert.ok(result.stderr.length > 0);
  }
  const passing = await runCli(['check', '--jsonl', '--output-all', '--rules', '.coderuler/aaa-pass.rule.ts'], target);
  assert.equal(passing.status, 0, passing.stderr);
  assertJsonl(passing.stdout, [expected[0]!]);
  const filtered = await runCli(['check', '--jsonl', '--rules', '.coderuler/aaa-pass.rule.ts'], target);
  assert.equal(filtered.status, 0, filtered.stderr);
  assertJsonl(filtered.stdout, []);
});

test('check JSON and JSONL preserve whitespace keyed scope locations', async () => {
  const target = sandbox.isolated('check-whitespace-scope-location');
  writeFiles(target, { 'data/record.json': '{\n  "id": " ",\n  "value": "bad"\n}\n' });
  writeRule(target, 'keyed', `import { Rule, regex, scopes } from '@alex-dbs/coderuler';
export default class Keyed extends Rule {
  files = ['data/*.json'];
  scope = scopes.json({ key: '$.id' });
  check = regex({ pattern: /MARKER-OK/, violationMessage: 'Missing marker' });
}
`);
  const locations = [{ filepath: 'data/record.json', scopeId: ' ', lines: { start: 1, end: 4 } }];
  for (const mode of ['--json', '--jsonl'] as const) {
    const result = await runCli(['check', mode], target);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    const reports = parseCheckOutput(result, 'whitespace keyed scope', mode);
    assert.equal(reports.length, 1);
    const report = reports[0]!;
    assert.equal(report.status, 'violation');
    assert.equal(report.evaluations.length, 1);
    const evaluation = report.evaluations[0]!;
    assert.equal(evaluation.result.status, 'violation');
    assert.deepEqual(evaluation.result.locations, locations);
    const subject = scopeSubjects(report, 'whitespace keyed scope')[0]!;
    assert.equal(subject.id, ' ');
    assert.deepEqual(subject.lines, { start: 1, end: 4 });
    const payload = asMapping(JSON.parse(result.stdout), `${mode} whitespace keyed scope output`);
    let rawReport = payload;
    if (mode === '--json') {
      assert.ok(Array.isArray(payload['reports']));
      rawReport = asMapping(payload['reports'][0], 'JSON whitespace keyed scope report');
    } else {
      assert.equal(payload['type'], 'rule');
    }
    assert.deepEqual(rawReport['evaluations'], report.evaluations);
  }
});

test('check rejects conflicting machine modes before loading rules', async () => {
  const target = sandbox.isolated('check-json-conflict');
  for (const options of [['--json', '--jsonl'], ['--jsonl', '--json']]) {
    const result = await runCli(['check', ...options], target);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--json/);
    assert.match(result.stderr, /--jsonl/);
    assert.match(result.stderr, /cannot|conflict|exclusive/i);
  }
});

test('check JSONL emits no partial reports on execution failure', async () => {
  const target = sandbox.isolated('check-jsonl-failure');
  writeFiles(target, { 'src/a.txt': 'alpha' });
  writeRule(target, 'aaa-pass', PASS_RULE);
  writeRule(target, 'zzz-throw', THROWING_CHECK);
  const result = await runCli(['check', '--jsonl'], target);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /check exploded/);
  assert.equal(result.stderr.includes('\u001b'), false);
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
  const result = await runCli(['check', '--json', '--output-all'], target, fixture.env);
  assert.equal(result.status, 1, result.stderr);
  const report = reportNamed(parseCheckOutput(result, 'check violation'), 'marker', 'check violation');
  assert.equal(report.status, 'violation');
  const subjects = scopeSubjects(report, 'check violation');
  assert.deepEqual(subjects.map(subject => subject.filepath), ['src/one.txt', 'src/three.txt', 'src/two.txt']);
  assert.deepEqual(subjects.map(subject => subject.id), ['$', '$', '$']);
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result.status), ['violation', 'pass', 'pass']);
  assert.equal(report.evaluations[0]!.result.message, 'Missing marker');
  assert.equal(report.evaluations[0]!.result.probability, undefined);
  assert.ok(report.evaluations.every(evaluation => !('threshold' in evaluation.result)));
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
  const result = await runCli(['check', '--json', '--output-all'], target);
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
  const result = await runCli(['check', '--json', '--output-all'], target);
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
  const result = await runCli(['check', '--json', '--output-all'], target);
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
    `import { Rule, violation } from '@alex-dbs/coderuler';
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
    `import { Rule, pass } from '@alex-dbs/coderuler';
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
  const noMatch = await runCli(['check', '--output-all'], noMatchTarget);
  assert.equal(noMatch.status, 0, noMatch.stderr);
  assert.match(noMatch.stdout, /no (?:matching )?(?:subjects?|verifications?|checks?|evaluations?)/i);
  assert.equal(noMatch.stdout.includes('src/'), false, noMatch.stdout);
  const noMatchReport = reportNamed(
    parseCheckOutput(await runCli(['check', '--json', '--output-all'], noMatchTarget), 'no match'),
    'nomatch',
    'no match',
  );
  assert.equal(noMatchReport.status, 'skipped');
  assert.equal(noMatchReport.reason, 'no matching subjects');

  const disabledTarget = sandbox.isolated('check-disabled');
  writeRule(disabledTarget, 'off', DISABLED);
  const disabled = await runCli(['check', '--output-all'], disabledTarget);
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
    parseCheckOutput(await runCli(['check', '--json', '--output-all'], passTarget), 'passing'),
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
  const result = await runCli(['check', 'internal/infra', '--json', '--output-all'], target, fixture.env);
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
  const result = await runCli(['check', '--json', '--output-all'], target);
  assert.equal(result.status, 0, result.stderr);
  const report = reportNamed(parseCheckOutput(result, 'check reserved'), 'scan', 'check reserved');
  const filepaths = scopeSubjects(report, 'check reserved').map(subject => subject.filepath);
  assert.ok(filepaths.includes('src/a.txt'), filepaths.join(','));
  assert.ok(filepaths.includes('package.json'), filepaths.join(','));
  assert.deepEqual(
    filepaths.filter(path => /^(?:\.coderuler|old|node_modules|dist|coverage)\//.test(path)),
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
  writeRule(target, 'rules', 'throw new Error("discovered rule named rules imported");');
  const single = await runCli(['check', '--json', '--rules', 'rules/explicit.rule.ts'], target);
  assert.equal(single.status, 1, single.stderr);
  assert.deepEqual(parseCheckOutput(single, 'explicit file').map(report => report.name), ['explicit']);
  const directory = await runCli(['check', '--json', '--output-all', '--rules', 'rules'], target);
  assert.equal(directory.status, 1, directory.stderr);
  assert.deepEqual(parseCheckOutput(directory, 'explicit directory').map(report => report.name), ['explicit', 'scan2']);
  const scan = await runCli(['check', '--json', '--output-all', '--rules', 'rules/scan2.rule.ts'], target);
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
  const missing = await runCli(['check', '--json', '--output-all'], missingTarget, fixture.env);
  assert.equal(missing.status, 0, missing.stderr);
  const missingReport = reportNamed(parseCheckOutput(missing, 'gate missing'), 'gate-dir', 'gate missing');
  assert.equal(missingReport.status, 'skipped');
  assert.equal(missingReport.reason, 'when returned false');
  assert.deepEqual(missingReport.evaluations, []);
  assert.equal(fixture.requests.length, 0);

  const fileTarget = sandbox.isolated('check-gate-file');
  writeFiles(fileTarget, { 'internal/infra/store.go': GO_SOURCE, 'internal/adapter': 'not a directory\n' });
  writeRule(fileTarget, 'gate-dir', GATE_DIRECTORY);
  const asFile = await runCli(['check', '--json', '--output-all'], fileTarget, fixture.env);
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
  const result = await runCli(['check', '--json', '--output-all'], target, fixture.env);
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
  const result = await runCli(['check', '--json', '--output-all'], target);
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
  const result = await runCli(['check', '--json', '--output-all'], target, { RK_BACKEND: 'not-a-backend', RK_THRESHOLD: 'nonsense' });
  assert.equal(result.status, 1, result.stderr);
  const report = reportNamed(parseCheckOutput(result, 'custom select'), 'custom-select', 'custom select');
  const subjects = scopeSubjects(report, 'custom select');
  assert.deepEqual(subjects.map(subject => subject.filepath), ['src/drop-b.txt', 'src/keep-a.txt']);
  assert.deepEqual(subjects.map(subject => subject.id), ['custom:$', 'custom:$']);
  assert.deepEqual(report.evaluations.map(evaluation => evaluation.result.status), ['violation', 'pass']);
  assert.equal(report.evaluations[0]!.result.message, 'rejected src/drop-b.txt');
  assert.ok(report.evaluations.every(evaluation => evaluation.result.probability === undefined));
  assert.ok(report.evaluations.every(evaluation => !('threshold' in evaluation.result)));
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
  const lax = await runCli(['check', '--json', '--output-all'], target);
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
  const result = await runCli(['check', '--json', '--output-all'], target, fixture.env);
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
    threshold: 0.4,
    model: fixture.model,
    usage: { calls: 1, unreportedCalls: 0, inputTokens: 11, outputTokens: 1, inputCost: 11 * 0.042 / 1_000_000, outputCost: 0 },
  });
});
test('check uses the rule question with the instruction option', async () => {
  const target = sandbox.isolated('check-ai-instruction');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'instruction', `
import { Rule, ai } from '@alex-dbs/coderuler';

export default class InstructionCheck extends Rule {
  files = ['src/**/*.txt'];
  check = ai({ instruction: 'Files must be tidy.' });
}
`);
  const fixture = await decisionFixture();
  const result = await runCli(['check', '--json', '--output-all'], target, fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(requestInstructions(fixture.requests[0]!), {
    rule: 'Files must be tidy.',
    question: 'Is the rule respected?',
  });
  assert.equal(requestQuestion(fixture.requests[0]!)['type'], 'noul');
});

test('invalid environment prices are ignored by deterministic checks and rejected before an AI request', async () => {
  const target = sandbox.isolated('check-lazy-pricing');
  writeFiles(target, { 'src/one.txt': 'SOURCE' });
  writeRule(target, 'lazy', PASS_RULE);
  const fixture = await decisionFixture();
  const env = { ...fixture.env, RK_INPUT_COST_PER_MILLION: 'invalid', RK_OUTPUT_COST_PER_MILLION: 'invalid' };
  const deterministic = await runCli(['check', '--json', '--output-all'], target, env);
  assert.equal(deterministic.status, 0, deterministic.stderr);
  const report = reportNamed(parseCheckOutput(deterministic, 'deterministic pricing'), 'lazy', 'deterministic pricing');
  assert.deepEqual(report.evaluations[0]?.result, { status: 'pass' });
  writeRule(target, 'lazy', AI_WHOLE_FILE);
  const aiResult = await runCli(['check', '--json'], target, env);
  expectFailure(aiResult, 'invalid AI pricing');
  assert.equal(fixture.requests.length, 0);
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
  const result = await runCli(['check', '--json', '--output-all'], target, fixture.env);
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
  const result = await runCli(['check', '--json', '--output-all'], target, fixture.env);
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
    threshold: 0.9,
    model: fixture.model,
    usage: { calls: 1, unreportedCalls: 0, inputTokens: 11, outputTokens: 1, inputCost: 11 * 0.042 / 1_000_000, outputCost: 0 },
  });
});

test('check and inspect report the effective flag, rule, environment and default AI thresholds', async () => {
  const target = sandbox.isolated('check-thresholds');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'examples', EXAMPLES_RULE);
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture();
  const cases = [
    { label: 'rule over environment', rule: 'examples', env: '0.1', flag: undefined, probability: 0.5, threshold: 0.9, status: 'violation' },
    { label: 'flag over rule and environment', rule: 'examples', env: '0.1', flag: '0.637', probability: 0.7, threshold: 0.637, status: 'pass' },
    { label: 'environment', rule: 'basic', env: '0.8', flag: undefined, probability: 0.5, threshold: 0.8, status: 'violation' },
    { label: 'flag equality', rule: 'basic', env: '0.1', flag: '0.637', probability: 0.637, threshold: 0.637, status: 'violation' },
    { label: 'default equality', rule: 'basic', env: undefined, flag: undefined, probability: 0.4, threshold: 0.4, status: 'violation' },
    { label: 'above default', rule: 'basic', env: undefined, flag: undefined, probability: 0.41, threshold: 0.4, status: 'pass' },
  ] as const;

  for (const entry of cases) {
    fixture.probability = entry.probability;
    const env = { ...fixture.env, RK_THRESHOLD: entry.env };
    const flags = entry.flag === undefined ? [] : ['--threshold', entry.flag];
    for (const mode of ['--json', '--jsonl'] as const) {
      const result = await runCommand(
        ['check', mode, '--output-all', '--rules', `.coderuler/${entry.rule}.rule.ts`, ...flags],
        target,
        env,
      );
      assert.equal(result.status, entry.status === 'pass' ? 0 : 1, `${entry.label}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      const report = reportNamed(parseCheckOutput(result, entry.label, mode), entry.rule, entry.label);
      assert.equal(report.status, entry.status, entry.label);
      const evaluation = report.evaluations[0]!.result;
      assert.equal(evaluation.status, entry.status, entry.label);
      assert.equal(evaluation.probability, entry.probability, entry.label);
      assert.equal(evaluation.threshold, entry.threshold, entry.label);
    }
    const inspected = await runCommand(
      entry.flag === undefined
        ? ['inspect', entry.rule]
        : ['check', '--verbose', '--output-all', '--rules', `.coderuler/${entry.rule}.rule.ts`, ...flags],
      target,
      env,
    );
    assert.equal(inspected.status, entry.status === 'pass' ? 0 : 1, `${entry.label}: ${inspected.stderr}`);
    if (entry.flag === undefined) assert.equal(inspected.stderr, '');
    const walkthrough = entry.flag === undefined ? inspected.stdout : inspected.stderr;
    const cards = evaluationCards(walkthrough);
    assert.equal(cards.length, 1, walkthrough);
    const result = cardSection(cards[0]!, 'Result');
    assert.ok(result.split('\n').some(line => line.trim() === `status: ${entry.status}`), result);
    assert.ok(result.split('\n').some(line => line.trim() === `probability: ${entry.probability}`), result);
    assert.ok(result.split('\n').some(line => line.trim() === `threshold: ${entry.threshold}`), result);
    assertWirePayload(cardSection(cards[0]!, 'Request'), fixture.requests.at(-1)!.body);
    assertWirePayload(cardSection(cards[0]!, 'Response'), decisionPayload(entry.probability, fixture.model));
  }
  assert.equal(fixture.requests.length, cases.length * 3);
  for (const request of fixture.requests) assert.equal(request.raw.includes('"threshold"'), false, request.raw);
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
  const otherModel = await runCli(['check', '--json', '--output-all'], target, fixture.env);
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

test('check verbose preserves earlier rule blocks on stderr when a later rule fails', async () => {
  const target = sandbox.isolated('check-verbose-late-error');
  writeFiles(target, { 'src/a.txt': 'nothing to see' });
  writeRule(target, 'aaa', markerRule('first violation'));
  writeRule(target, 'zzz', THROWING_CHECK);
  const result = await runCli(['check', '--json', '--verbose', '--concurrency', '1'], target);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  const cards = evaluationCards(result.stderr);
  assert.equal(cards.length, 2, result.stderr);
  assertCardMetadata(cards[0]!, 'aaa', 'src/a.txt:1-1');
  assert.match(cardSection(cards[0]!, 'Result'), /^\s+status: violation$/m);
  assertCardMetadata(cards[1]!, 'zzz', 'src/a.txt:1-1');
  assert.match(cardSection(cards[1]!, 'Error'), /^\s+stage: check$/m);
  assert.match(cards[0]!, /nothing to see/);
  assert.match(result.stderr, /^coderuler: .*check exploded/m);
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
  const run = runCli(['check', '--debug'], target, fixture.env);
  await fixture.waitForRequests(1);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.active, 1);
  assert.equal(fixture.peak, 1);
  const result = await releaseUntilDone(fixture, run);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 4);
});

test('check bounds evaluation concurrency and keeps result order', async () => {
  const target = sandbox.isolated('check-concurrency');
  const filepaths = ['src/a.txt', 'src/b.txt', 'src/c.txt', 'src/d.txt', 'src/e.txt'];
  const files: Record<string, string> = {};
  for (const filepath of filepaths) files[filepath] = 'alpha';
  writeFiles(target, files);
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture({ hold: true });
  const run = runCli(['check', '--json', '--output-all', '--verbose', '--concurrency', '2'], target, fixture.env);
  await fixture.waitForRequests(2);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.peak, 2);
  const result = await releaseUntilDone(fixture, run);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.requests.length, 5);
  const report = reportNamed(parseCheckOutput(result, 'bounded concurrency'), 'basic', 'bounded concurrency');
  assert.deepEqual(scopeSubjects(report, 'bounded concurrency').map(subject => subject.filepath), filepaths);
  const cards = evaluationCards(result.stderr);
  assert.equal(cards.length, filepaths.length, result.stderr);
  for (const filepath of filepaths) {
    const card = cards.find(block => block.includes(`file: ${filepath}`));
    assert.ok(card !== undefined, result.stderr);
    assertCardMetadata(card, 'basic', `${filepath}:1-1`);
    assert.match(cardSection(card, 'Source'), /\b1 \| alpha/);
    assert.match(cardSection(card, 'Request'), /"state"/);
    assert.match(cardSection(card, 'Response'), /status: HTTP 200/);
    assert.match(cardSection(card, 'Result'), /status: pass/);
    for (const other of filepaths.filter(path => path !== filepath)) assert.equal(card.includes(other), false, card);
  }
});

test('inspect resolves explicit paths, names and home rules', async () => {
  const target = sandbox.isolated('inspect-resolve');
  writeFiles(target, { 'src/a.txt': 'alpha MARKER-OK beta', 'other/b.txt': 'gamma MARKER-OK' });
  writeRule(target, 'marker', MARKER_ANY_TXT_RULE);
  writeHomeRule(target, 'home-marker', MARKER_ANY_TXT_RULE);
  const explicit = await runCli(['inspect', '.coderuler/marker.rule.ts', 'src'], target);
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
  const gate = walkthroughBlocks(gated.stdout).find(block => block.startsWith('gate gate-dir\n'));
  assert.ok(gate !== undefined, gated.stdout);
  assert.match(gate, /^ {2}status: skipped$/m);
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
  const cards = evaluationCards(result.stdout);
  assert.equal(cards.length, 1, result.stdout);
  const trace = indentedJsonPayloads(cardSection(cards[0]!, 'Trace')).find(payload =>
    typeof payload === 'object' && payload !== null && 'pattern' in payload,
  );
  assert.ok(trace !== undefined, result.stdout);
  const details = asMapping(trace, 'regex trace');
  assert.equal(details['pattern'], 'MARKER-OK');
  assert.deepEqual(details['evaluations'], [{
    filepath: 'src/a.txt',
    scopeId: '$',
    input: 'alpha MARKER-OK beta',
    matched: true,
  }]);
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
  const cards = evaluationCards(result.stdout);
  assert.equal(cards.length, 1, result.stdout);
  const trace = cardSection(cards[0]!, 'Trace');
  assert.match(trace, /custom-check/);
  assertWirePayload(trace, { filepath: 'src/keep-a.txt', id: 'custom:$' });
  const blocks = walkthroughBlocks(result.stdout);
  const filtered = blocks.find(block => block.startsWith('scope custom-select\n') && block.includes('src/skip.txt'));
  assert.ok(filtered !== undefined, result.stdout);
  assert.match(filtered, /^ {2}status: filtered$/m);
  assert.match(filtered, /^ {2}reason: generated file$/m);
});

test('inspect separates rule stages and nests source and complete JSON exchanges', async () => {
  const target = sandbox.isolated('inspect-ai');
  const source = 'FIRST-LINE\n\tSECOND-LINE\nLAST-LINE';
  writeFiles(target, { 'src/one.txt': source });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture();
  const result = await runCli(['inspect', 'basic'], target, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('\u001b'), false);
  const blocks = walkthroughBlocks(result.stdout);
  for (const kind of ['rule', 'file']) {
    assert.ok(blocks.some(block => block.split('\n')[0] === `${kind} basic`), `missing ${kind} block: ${result.stdout}`);
  }
  const cards = evaluationCards(result.stdout);
  assert.equal(cards.length, 1, result.stdout);
  const card = cards[0]!;
  assertCardMetadata(card, 'basic', 'src/one.txt:1-3');
  const sourceSection = cardSection(card, 'Source');
  assert.match(sourceSection, /^\s*1 \| FIRST-LINE$/m);
  assert.match(sourceSection, /^\s*2 \| +SECOND-LINE$/m);
  assert.match(sourceSection, /^\s*3 \| LAST-LINE$/m);
  assert.equal(sourceSection.includes('\t'), false);
  assert.ok(card.includes('Files must be tidy.'), card);
  assert.equal(fixture.requests.length, 1);
  const request = cardSection(card, 'Request');
  const response = cardSection(card, 'Response');
  assertWirePayload(request, fixture.requests[0]!.body);
  assertWirePayload(response, decisionPayload(fixture.probability, fixture.model));
  assert.match(response, /status: HTTP 200/);
  assert.match(cardSection(card, 'Result'), /^\s+status: pass$/m);
});

test('inspect groups each scoped HTTP evaluation with one metadata header and faithful payloads', async () => {
  const target = sandbox.isolated('inspect-scoped-cards');
  writeFiles(target, { 'src/slice.go': 'package main\n\nfunc Alpha() {}\n\nfunc Beta() {}\n' });
  writeRule(target, 'functions', `import { Rule, ai, scopes } from '@alex-dbs/coderuler';
export default class Functions extends Rule {
  files = ['src/*.go'];
  scope = scopes.astGrep({ language: 'go', rule: { kind: 'function_declaration' } });
  check = ai({ rule: 'Functions must be tidy.' });
}
`);
  const fixture = await decisionFixture({ hold: true });
  const run = runCli(['inspect', 'functions'], target, fixture.env);
  await fixture.waitForRequests(1);
  assert.equal(fixture.active, 1);
  assert.equal(fixture.peak, 1);
  const result = await releaseUntilDone(fixture, run);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const cards = evaluationCards(result.stdout);
  assert.equal(cards.length, 2, result.stdout);
  assert.equal(fixture.requests.length, 2);
  assert.doesNotMatch(result.stdout, /^scope functions$/m);
  for (const [index, name] of ['Alpha', 'Beta'].entries()) {
    const card = cards[index]!;
    const line = index === 0 ? 3 : 5;
    assertCardMetadata(card, 'functions', `src/slice.go:${line}-${line}`, `function_declaration:${name}`);
    assert.match(cardSection(card, 'Source'), new RegExp(`\\b${line} \\| func ${name}\\(\\) \\{\\}`));
    assertWirePayload(cardSection(card, 'Request'), fixture.requests[index]!.body);
    assertWirePayload(cardSection(card, 'Response'), decisionPayload(fixture.probability, fixture.model));
    assert.match(cardSection(card, 'Result'), /status: pass/);
    assert.ok(card.includes('"filepath"'), 'wire filepath must remain present inside Request');
    const other = name === 'Alpha' ? 'Beta' : 'Alpha';
    assert.equal(card.includes(`func ${other}`), false, card);
  }
});

test('inspect honors terminal colors while redirected and NO_COLOR output remains readable and plain', async () => {
  const target = sandbox.isolated('inspect-color');
  writeFiles(target, {
    'src/pass.txt': 'MARKER-OK',
    'src/fail.txt': 'missing marker',
  });
  writeRule(target, 'marker', markerRule('Missing marker'));
  writeRule(target, 'off', DISABLED);
  const forced = { FORCE_COLOR: '1', NO_COLOR: undefined };
  const colored = await runCli(['inspect', 'marker'], target, forced);
  assert.equal(colored.status, 1, colored.stderr);
  assert.equal(colored.stderr, '');
  for (const code of [1, 31, 32, 36]) {
    assert.ok(colored.stdout.includes(`\u001b[${code}m`), `missing ANSI style ${code}: ${colored.stdout}`);
  }
  const skipped = await runCli(['inspect', 'off'], target, forced);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.ok(skipped.stdout.includes('\u001b[33m'), skipped.stdout);
  for (const env of [
    { FORCE_COLOR: undefined, NO_COLOR: '1' },
    { FORCE_COLOR: undefined, NO_COLOR: undefined },
  ]) {
    const plain = await runCli(['inspect', 'marker'], target, env);
    assert.equal(plain.status, 1, plain.stderr);
    assert.equal(plain.stderr, '');
    assert.equal(plain.stdout.includes('\u001b'), false);
    const cards = evaluationCards(plain.stdout);
    assert.equal(cards.length, 2, plain.stdout);
    for (const status of ['pass', 'violation']) {
      assert.ok(cards.some(card => cardSection(card, 'Result').includes(`status: ${status}`)), plain.stdout);
    }
    for (const card of cards) assert.match(cardSection(card, 'Source'), /\b1 \|/);
  }
  for (const mode of ['--json', '--jsonl'] as const) {
    const machine = await runCli(['check', mode, '--output-all', '--verbose'], target, forced);
    assert.equal(machine.status, 1, machine.stderr);
    assert.equal(machine.stdout.includes('\u001b'), false);
    assert.equal(machine.stderr.includes('\u001b'), false, 'stdout color capability must not color verbose stderr');
    assert.equal(parseCheckOutput(machine, 'colored machine output', mode).length, 2);
    assert.equal(evaluationCards(machine.stderr).length, 2, machine.stderr);
  }
});

test('inspect keeps non-JSON backend failures readable and streams the exchange before exit 2', async () => {
  const target = sandbox.isolated('inspect-http-error');
  writeFiles(target, { 'src/one.txt': 'SOURCE-TEXT-ONE' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture();
  fixture.answer = () => ({ status: 503, body: 'upstream refused\ntry later' });
  const result = await runCli(['inspect', 'basic'], target, fixture.env);
  expectStreamingFailure(result, 'inspect HTTP failure');
  const cards = evaluationCards(result.stdout);
  assert.equal(cards.length, 1, result.stdout);
  const card = cards[0]!;
  assertCardMetadata(card, 'basic', 'src/one.txt:1-1');
  const sections = card.split('\n')
    .map(line => /^  (Request|Response|Error)(?: ─+)?$/.exec(line)?.[1])
    .filter(title => title !== undefined);
  assert.deepEqual(sections, ['Request', 'Response', 'Error'], card);
  assert.match(cardSection(card, 'Response'), /^\s+status: HTTP 503$/m);
  assertWirePayload(cardSection(card, 'Response'), 'upstream refused\ntry later');
  assert.match(cardSection(card, 'Error'), /^\s+stage: check$/m);
  assert.match(result.stderr, /503/);
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
  const failure = walkthroughBlocks(result.stdout).find(block => block.includes('gate exploded'));
  assert.ok(failure !== undefined, `inspect must stream the failure itself: ${result.stdout}`);
  assert.match(failure, /^\s+stage:\s+when$/m);
  assert.match(failure, /^\s+message:\s+gate exploded$/m);
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
    const result = await runCommand(args, target);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.notEqual(result.stdout, '', `${args.join(' ')} must print help on stdout`);
    assert.equal(result.stderr, '', `${args.join(' ')} must not write diagnostics: ${result.stderr}`);
  }
  for (const args of [['help', 'nope'], ['help', 'stats'], ['check', '--bogus']]) {
    expectFailure(await runCommand(args, target), `usage ${args.join(' ')}`);
  }
  expectFailure(await runCommand(['check', 'missing-dir'], target), 'runtime target failure');
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
      ['check', '--json', '--output-all', join(rootSpelling, 'SRC', 'A.TXT')], target);
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
  const accepted = await runCli(['check', '--json', '--output-all', '--concurrency', '1', '--threshold', '0'], target);
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
    'old/bad.rule.ts': `import { Rule, pass } from '@alex-dbs/coderuler';
export default class Bad extends Rule {
  enabled = 'nope';
  check = pass;
}
`,
  });
  writeRule(target, 'ok', PASS_RULE);
  const result = await runCli(['check', '--json', '--output-all'], target);
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
    `import { Rule, pass } from '@alex-dbs/coderuler';
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
  assert.ok(duplicated.stderr.includes(join(duplicateTarget.cwd, '.coderuler', 'dup.rule.ts')), duplicated.stderr);
  assert.ok(duplicated.stderr.includes(join(duplicateTarget.home, '.coderuler', 'dup.rule.ts')), duplicated.stderr);

  const emptyTarget = sandbox.isolated('module-none');
  const none = await runCli(['check', '--json'], emptyTarget);
  expectFailure(none, 'no rules');
  assert.match(none.stderr, /no rule files/i);
});

test('plain helper modules are ignored while .rule.mjs modules load', async () => {
  const target = sandbox.isolated('module-helpers');
  writeFiles(target, {
    'src/a.txt': 'alpha MARKER-OK',
    '.coderuler/helper.ts': "throw new Error('helper module must not be imported');\n",
    '.coderuler/mjs.rule.mjs': MJS_RULE,
  });
  const result = await runCli(['check', '--json', '--output-all'], target);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes('helper module must not be imported'));
  assert.deepEqual(parseCheckOutput(result, 'helpers').map(report => report.name), ['mjs']);
});

test('inspect resolves a named rule under the inspected folder root', async () => {
  const target = sandbox.isolated('inspect-named-root');
  writeFiles(target, { 'src/root.txt': 'nothing to see', 'sub/src/inner.txt': 'nothing to see' });
  writeRule(target, 'inner', markerRule('ROOT-SCOPE-MESSAGE'));
  writeFile(join(target.cwd, 'sub', '.coderuler', 'inner.rule.ts'), markerRule('INNER-SCOPE-MESSAGE'));
  const result = await runCli(['inspect', 'inner', 'sub'], target);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(
    result.stdout.includes(join(target.cwd, 'sub', '.coderuler', 'inner.rule.ts')),
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
  const ruleFile = join(target.cwd, '.coderuler', 'marker.rule.ts');
  for (const folder of [sibling, '../sibling']) {
    const result = await runCli(['inspect', '.coderuler/marker.rule.ts', folder], target);
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
  const archived = await runCli(['inspect', '.coderuler/marker.rule.ts', 'old'], target);
  expectFailure(archived, 'archived inspect folder');
  assert.match(archived.stderr, /reserved/, archived.stderr);
  for (const folder of ['.coderuler', 'node_modules', '.git']) {
    expectFailure(
      await runCli(['inspect', '.coderuler/marker.rule.ts', folder], target),
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
  const failureBlock = walkthroughBlocks(result.stdout).find(block => block.includes('could not be parsed'));
  assert.match(
    failureBlock ?? '',
    /^\s+stage:\s+(?:select|scope)$/m,
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

const AI_ALPHA = `import { Rule, ai } from '@alex-dbs/coderuler';
export default class Alpha extends Rule {
  files = ['src/**/*.txt'];
  check = ai({ rule: 'Alpha must hold.' });
}
`;

const AI_BETA = `import { Rule, ai } from '@alex-dbs/coderuler';
export default class Beta extends Rule {
  files = ['src/**/*.txt'];
  check = ai({ rule: 'Beta must hold.' });
}
`;

const TRACE_LEAK = `import { Rule, pass } from '@alex-dbs/coderuler';
export default class TraceLeak extends Rule {
  files = ['src/**/*.txt'];
  check = (subject, context) => {
    context.trace('observed', { filepath: subject.filepath, source: subject.source });
    return pass();
  };
}
`;

const GROUPED_PROJECT = `import { Rule, violation } from '@alex-dbs/coderuler';
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
  const fixture = await decisionFixture({ hold: true });
  const run = runCli(['check', '--verbose', '--concurrency', '2'], target, fixture.env);
  await fixture.waitForRequests(2);
  assert.equal(fixture.active, 2, 'both rules must be in flight before responses are released');
  const result = await releaseUntilDone(fixture, run);
  assert.equal(result.status, 0, result.stderr);
  const cards = evaluationCards(result.stderr);
  assert.equal(cards.length, 2, result.stderr);
  for (const name of ['alpha', 'beta']) {
    const associated = cards.filter(card => card.startsWith(`evaluation ${name}\n`));
    assert.equal(associated.length, 1, result.stderr);
    const card = associated[0]!;
    assertCardMetadata(card, name, 'src/one.txt:1-1');
    for (const title of ['Request', 'Response', 'Result']) cardSection(card, title);
    assert.match(cardSection(card, 'Result'), /^\s+status:\s+pass$/m);
    const other = name === 'alpha' ? 'Beta' : 'Alpha';
    assert.equal(card.includes(`${other} must hold.`), false, card);
  }
  assert.equal(fixture.requests.length, 2);
});

test('check honors --debug and --verbose together at concurrency 1', async () => {
  const target = sandbox.isolated('check-debug-verbose');
  writeFiles(target, { 'src/a.txt': 'alpha', 'src/b.txt': 'beta', 'src/c.txt': 'gamma' });
  writeRule(target, 'basic', AI_WHOLE_FILE);
  const fixture = await decisionFixture({ hold: true });
  const run = runCli(['check', '--debug', '--verbose'], target, fixture.env);
  await fixture.waitForRequests(1);
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

  const machine = await runCli(['check', '--json', '--output-all'], target, fixture.env);
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

const SHORT_KEY_LEAK = `import { Rule } from '@alex-dbs/coderuler';
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
  assert.ok(thrown.stderr.startsWith('coderuler: '), `the prefix is public contract: ${thrown.stderr}`);
  assert.ok(thrown.stderr.includes('[REDACTED]'), thrown.stderr);
  assert.equal(thrown.stderr.includes('boom k mark'), false, thrown.stderr);

  const usage = await runCli(['check', '--kaboom'], target, env);
  assert.equal(usage.status, 2, usage.stderr);
  assert.ok(usage.stderr.startsWith('coderuler: '), `the prefix is public contract: ${usage.stderr}`);
  assert.ok(usage.stderr.includes('[REDACTED]'), usage.stderr);
});
