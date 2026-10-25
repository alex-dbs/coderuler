import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { runProgram, type CliServices } from '../dist/adapter/cli/program.js';
import { terminalCapabilities } from '../dist/adapter/cli/progress.js';
import { createRuleDependencyManager } from '../dist/adapter/filesystem/dependencies.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';
import type { RuleReport } from '../dist/app/ports.js';
import { createServices } from '../dist/infra/runtime.js';
import {
  asMapping,
  createSandbox,
  parseCheckOutput,
  runCli,
  writeFile,
  type CheckReportShape,
  type CliResult,
  type Sandbox,
} from './support.ts';

const sandbox = createSandbox('rulekeeper-cli-output-');
after(() => sandbox.cleanup());

const MIXED_RULE = `import { Rule, pass, violation } from '@alex-dbs/rulekeeper';
export default class Mixed extends Rule {
  files = ['items/*.txt'];
  check = subject => subject.source.includes('BAD') ? violation('custom rejection') : pass();
}
`;
const CLEAN_RULE = `import { Rule, pass } from '@alex-dbs/rulekeeper';
export default class Clean extends Rule {
  files = ['src/clean.txt'];
  check = pass;
}
`;
const SKIPPED_RULE = `import { Rule, pass } from '@alex-dbs/rulekeeper';
export default class Skipped extends Rule {
  enabled = false;
  files = ['src/clean.txt'];
  check = pass;
}
`;

function mixedProject(): Sandbox {
  const target = sandbox.isolated('mixed');
  writeFile(join(target.cwd, '.rulekeeper/mixed.rule.ts'), MIXED_RULE);
  writeFile(join(target.cwd, '.rulekeeper/clean.rule.ts'), CLEAN_RULE);
  writeFile(join(target.cwd, '.rulekeeper/skipped.rule.ts'), SKIPPED_RULE);
  writeFile(join(target.cwd, 'src/clean.txt'), 'CLEAN SOURCE\n');
  writeFile(join(target.cwd, 'items/bad.txt'), 'BAD SOURCE\n');
  for (let index = 1; index <= 12; index++) {
    writeFile(join(target.cwd, `items/good-${String(index).padStart(2, '0')}.txt`), `GOOD SOURCE ${index}\n`);
  }
  return target;
}

function readMachine(result: CliResult, mode: '--json' | '--jsonl'): {
  readonly durationMs?: number;
  readonly reports: readonly CheckReportShape[];
} {
  assert.equal(result.stderr, '');
  assert.equal(/[\u001b\r]/.test(result.stdout), false, 'machine output cannot contain ANSI or progress frames');
  const reports = parseCheckOutput(result, mode, mode);
  if (mode === '--jsonl') return { reports };
  const payload = asMapping(JSON.parse(result.stdout), 'JSON output');
  assert.deepEqual(Object.keys(payload).sort(), ['durationMs', 'reports']);
  const durationMs = payload['durationMs'];
  assert.equal(typeof durationMs, 'number');
  assert.ok(Number.isFinite(durationMs) && (durationMs as number) >= 0);
  return { durationMs: durationMs as number, reports };
}

async function runCommand(argv: readonly string[], target: Sandbox, overrides: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const env = { ...target.env, ...overrides };
  const loader = createRuleLoader({
    home: target.home,
    dependencies: createRuleDependencyManager({ cacheRoot: join(target.home, '.cache', 'rulekeeper', 'dependencies') }),
  });
  const services: CliServices = {
    ...createServices(target.cwd, env),
    loadRules: selection => loader.load(selection),
    write: text => { stdout.push(text); },
    writeError: text => { stderr.push(text); },
    terminal: terminalCapabilities({ stdoutIsTTY: false, stderrIsTTY: false }, env),
  };
  const status = await runProgram(argv, services);
  return { status, stdout: stdout.join(''), stderr: stderr.join('') };
}

test('real CLI scheduling honors debug concurrency and preserves lexical report order', async context => {
  const checkArgs = ['check', '--json', '--output-all', '--concurrency', '2'];
  const rows = [
    { name: 'check default concurrency', argv: checkArgs, peak: 2 },
    { name: 'check verbose concurrency', argv: [...checkArgs, '--verbose'], peak: 2 },
    { name: 'check debug concurrency', argv: [...checkArgs, '--debug'], peak: 1 },
    { name: 'check debug and verbose concurrency', argv: [...checkArgs, '--debug', '--verbose'], peak: 1 },
    { name: 'inspect concurrency', argv: ['inspect', 'scheduling', '--json'], peak: 1 },
  ] as const;
  const expectedFilepaths = ['inputs/a.txt', 'inputs/b.txt', 'inputs/c.txt'];

  for (const row of rows) {
    await context.test(row.name, async () => {
      const target = sandbox.isolated(row.name);
      for (const filepath of expectedFilepaths) writeFile(join(target.cwd, filepath), 'GOOD');
      const journal = join(target.cwd, 'scheduling.journal');
      writeFile(join(target.cwd, '.rulekeeper/scheduling.rule.ts'), `import { appendFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { Rule, pass } from '@alex-dbs/rulekeeper';
const journal = ${JSON.stringify(journal)};
export default class Scheduling extends Rule {
  files = ['inputs/*.txt'];
  check = async subject => {
    appendFileSync(journal, 'start ' + subject.filepath + '\\n');
    await setImmediate();
    appendFileSync(journal, 'end ' + subject.filepath + '\\n');
    return pass();
  };
}
`);

      const result = await runCommand(row.argv, target);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.includes('\u001b'), false);
      const document = asMapping(JSON.parse(result.stdout), row.name);
      const reports = document['reports'];
      assert.ok(Array.isArray(reports));
      assert.equal(reports.length, 1);
      const report = asMapping(reports[0], 'scheduling report');
      assert.equal(report['name'], 'scheduling');
      const evaluations = report['evaluations'];
      assert.ok(Array.isArray(evaluations));
      const reportedFilepaths = evaluations.map((value, index) => {
        const evaluation = asMapping(value, `scheduling evaluation ${index}`);
        const subject = asMapping(evaluation['subject'], `scheduling subject ${index}`);
        assert.equal(subject['kind'], 'scope');
        assert.equal(typeof subject['filepath'], 'string');
        return subject['filepath'] as string;
      });
      assert.deepEqual(reportedFilepaths, expectedFilepaths);

      const active = new Set<string>();
      const completed: string[] = [];
      let peak = 0;
      for (const record of readFileSync(journal, 'utf8').trimEnd().split('\n')) {
        const [action, filepath] = record.split(' ', 2);
        assert.ok(filepath, record);
        if (action === 'start') {
          assert.equal(active.has(filepath), false, record);
          active.add(filepath);
          peak = Math.max(peak, active.size);
        } else {
          assert.equal(action, 'end', record);
          assert.equal(active.delete(filepath), true, record);
          completed.push(filepath);
        }
      }
      assert.equal(active.size, 0);
      assert.equal(peak, row.peak);
      assert.equal(completed.length, expectedFilepaths.length);
      assert.deepEqual([...completed].sort(), expectedFilepaths);
    });
  }
});

function verificationGolden(reports: readonly CheckReportShape[]): unknown {
  return reports.map(report => ({
    name: report.name,
    status: report.status,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
    evaluations: report.evaluations.map(({ subject, result }) => {
      assert.equal(subject.kind, 'scope');
      if (subject.kind !== 'scope') throw new Error('expected scope');
      return { filepath: subject.filepath, status: result.status, ...(result.message === undefined ? {} : { message: result.message }) };
    }),
  }));
}

const BAD_EVALUATION = { filepath: 'items/bad.txt', status: 'violation', message: 'custom rejection' };
const VIOLATION_GOLDEN = [{ name: 'mixed', status: 'violation', evaluations: [BAD_EVALUATION] }];
const ALL_GOLDEN = [
  { name: 'clean', status: 'pass', evaluations: [{ filepath: 'src/clean.txt', status: 'pass' }] },
  {
    name: 'mixed',
    status: 'violation',
    evaluations: [BAD_EVALUATION, ...Array.from({ length: 12 }, (_, index) => ({
      filepath: `items/good-${String(index + 1).padStart(2, '0')}.txt`, status: 'pass',
    }))],
  },
  { name: 'skipped', status: 'skipped', reason: 'disabled', evaluations: [] },
];

test('machine report parsing preserves optional thresholds and rejects invalid threshold metadata', () => {
  const report = (result: string): string => JSON.stringify({
    name: 'threshold',
    ruleFile: join(sandbox.root, '.rulekeeper/threshold.rule.ts'),
    status: 'pass',
    durationMs: 0,
    evaluations: [{
      subject: { kind: 'scope', filepath: 'src/clean.txt', id: '$', source: 'CLEAN SOURCE' },
      result: null,
    }],
  }).replace('"result":null', `"result":${result}`);
  for (const mode of ['--json', '--jsonl'] as const) {
    const parse = (result: string): CheckReportShape => {
      const raw = report(result);
      const stdout = mode === '--json'
        ? `{"durationMs":0,"reports":[${raw}]}`
        : `{"type":"rule",${raw.slice(1)}\n`;
      return parseCheckOutput({ status: 0, stdout, stderr: '' }, 'threshold parser', mode)[0]!;
    };
    const plain = parse('{"status":"pass"}').evaluations[0]!.result;
    assert.equal('threshold' in plain, false);
    for (const threshold of [0, 0.637, 1]) {
      assert.deepEqual(parse(`{"status":"pass","threshold":${threshold}}`).evaluations[0]!.result, { status: 'pass', threshold });
    }
    for (const threshold of ['null', '"0.4"', 'true', '{}', '[]', '-0.1', '1.1', '1e999']) {
      assert.throws(() => parse(`{"status":"pass","threshold":${threshold}}`), /result\.threshold must be a finite number between 0 and 1/);
    }
  }
});

test('real machine outputs filter passing evaluations inside a mixed rule by default and preserve every verification with --output-all', async context => {
  const target = mixedProject();
  for (const mode of ['--json', '--jsonl'] as const) {
    for (const outputAll of [false, true]) {
      await context.test(`${mode} ${outputAll ? 'with' : 'without'} --output-all`, async () => {
        const result = await runCommand(['check', mode, ...(outputAll ? ['--output-all'] : [])], target, {
          FORCE_COLOR: '1',
          NO_COLOR: undefined,
        });
        assert.equal(result.status, 1, result.stderr);
        const { reports } = readMachine(result, mode);
        assert.deepEqual(verificationGolden(reports), outputAll ? ALL_GOLDEN : VIOLATION_GOLDEN);
        assert.equal(result.stdout.includes('GOOD SOURCE'), outputAll);
        assert.equal(result.stdout.includes('CLEAN SOURCE'), outputAll);
        assert.ok(result.stdout.includes('BAD SOURCE'));
      });
    }
  }
});

test('real CLI machine records retain independent active rule times rather than total or divided run time', async () => {
  const target = sandbox.isolated('independent-rule-times');
  writeFile(join(target.cwd, 'src/clean.txt'), 'CLEAN SOURCE\n');
  writeFile(join(target.cwd, '.rulekeeper/timing-clock.mjs'), `let elapsed = 0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
export function advance(durationMs) { elapsed += durationMs; }
`);
  for (const [name, selectionMs, evaluationMs] of [['first', 7, 11], ['second', 19, 23]] as const) {
    writeFile(join(target.cwd, '.rulekeeper', `${name}.rule.ts`), `import { Rule, pass } from '@alex-dbs/rulekeeper';
import { advance } from './timing-clock.mjs';
export default class Timed extends Rule {
  files = ['src/clean.txt'];
  when = () => { advance(${selectionMs}); return true; };
  check = () => { advance(${evaluationMs}); return pass(); };
}
`);
  }
  for (const mode of ['--json', '--jsonl'] as const) {
    const result = await runCli(['check', mode, '--output-all', '--concurrency', '1'], target);
    assert.equal(result.status, 0, result.stderr);
    const output = readMachine(result, mode);
    assert.deepEqual(output.reports.map(({ name, durationMs }) => ({ name, durationMs })), [
      { name: 'first', durationMs: 18 },
      { name: 'second', durationMs: 42 },
    ]);
    if (mode === '--json') assert.equal(output.durationMs, 60);
    else {
      assert.equal(output.durationMs, undefined);
      assert.equal(result.stdout.trimEnd().split('\n').length, 2);
    }
  }
});

test('real human output retains full counts and prints every passing verification only with --output-all', async () => {
  const target = mixedProject();
  const filtered = await runCli(['check'], target);
  const all = await runCli(['check', '--output-all'], target);
  for (const result of [filtered, all]) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Rules: 3.*Skipped: 1.*Verifications: 14.*Violations: 1/);
    assert.match(result.stdout, /Time: \d+\.\d{2}(?:ms|s|min|h|d)\b/);
    assert.match(result.stdout, /^\s+mixed\b/m);
    assert.equal(result.stdout.includes('🚓 mixed'), false);
    assert.match(result.stdout, /custom rejection/);
    assert.equal(result.stdout.includes('\u001b'), false);
  }
  assert.match(filtered.stdout, /^🚓 Violations:$/m);
  assert.equal((filtered.stdout.match(/🚓/g) ?? []).length, 1);
  assert.match(all.stdout, /^Verifications:$/m);
  assert.equal(all.stdout.includes('🚓'), false);
  assert.match(all.stdout, /^\s+✓ mixed\b/m);
  assert.equal(/^\s+pass /m.test(all.stdout), false);
  assert.equal(filtered.stdout.includes('GOOD SOURCE'), false);
  assert.equal(filtered.stdout.includes('CLEAN SOURCE'), false);
  assert.equal(filtered.stdout.includes('disabled'), false);
  for (let index = 1; index <= 12; index++) assert.ok(all.stdout.includes(`items/good-${String(index).padStart(2, '0')}.txt`));
  assert.ok(all.stdout.includes('src/clean.txt'));
  assert.ok(all.stdout.includes('disabled'));
  assert.equal(all.stdout.includes('more violation'), false);
});

test('real console uses bold red violation names and green checkmarks and passing names, with NO_COLOR and redirected fallbacks', async () => {
  const target = mixedProject();
  const colored = await runCli(['check', '--output-all'], target, { FORCE_COLOR: '1', NO_COLOR: undefined });
  assert.equal(colored.status, 1, colored.stderr);
  const redMixed = colored.stdout.split('\n').find(line => line.includes('\u001b[31m\u001b[1mmixed'))!;
  assert.equal(redMixed.includes('🚓'), false);
  assert.match(redMixed, /\u001b\[31m\u001b\[1mmixed/);
  const passingMixed = colored.stdout.split('\n').find(line => line.includes('✓') && line.includes('mixed'))!;
  assert.match(passingMixed, /\u001b\[32m✓\u001b\[(?:0|39)m/);
  assert.match(passingMixed, /\u001b\[32m\u001b\[1mmixed/);
  assert.match(colored.stdout, /\u001b\[32m\u001b\[1mclean/);
  for (const env of [{ FORCE_COLOR: undefined, NO_COLOR: '1' }, { FORCE_COLOR: undefined, NO_COLOR: undefined }]) {
    const plain = await runCli(['check', '--output-all'], target, env);
    assert.equal(plain.status, 1, plain.stderr);
    assert.equal(plain.stdout.includes('\u001b'), false);
    assert.match(plain.stdout, /^\s+mixed\b/m);
    assert.match(plain.stdout, /^\s+✓ mixed\b/m);
    assert.equal(plain.stdout.includes('🚓'), false);
  }
  assert.equal(terminalCapabilities({ stdoutIsTTY: true, stderrIsTTY: true }, { NO_COLOR: '' }).color, false);
});

function injected(reports: readonly RuleReport[], overrides: Partial<CliServices> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const services: CliServices = {
    ...createServices('/project', {}),
    terminal: { color: true, interactive: true, columns: 80 },
    resolveTarget: async () => ({ root: '/project', path: '.', kind: 'directory', contains: () => true }),
    loadRules: async () => [],
    runRules: async () => reports,
    write: text => { stdout.push(text); },
    writeError: text => { stderr.push(text); },
    ...overrides,
  };
  return { services, stdout, stderr };
}

test('duration measures only the monotonic awaited runRules boundary in every output mode', async context => {
  let clock = 0;
  context.mock.method(performance, 'now', () => clock);
  for (const mode of [[], ['--json'], ['--jsonl']]) {
    for (const outputAll of [false, true]) {
      let runCompleted = false;
      const base = createServices('/project', {});
      const target = injected([], {
        terminal: { color: false, interactive: false },
        resolveTarget: async () => {
          clock = 100;
          return { root: '/project', path: '.', kind: 'directory', contains: () => true };
        },
        loadRules: async () => { clock = 200; return []; },
        createProject: (...args) => { clock = 500; return base.createProject(...args); },
        decisionResolver: threshold => { clock = 1000; return base.decisionResolver(threshold); },
        runRules: async () => {
          clock = 1005;
          await Promise.resolve();
          clock = 1037.5;
          runCompleted = true;
          return [];
        },
        redact: text => { clock = 9000; return text; },
      });
      assert.equal(await runProgram(['check', ...mode, ...(outputAll ? ['--output-all'] : [])], target.services), 0);
      assert.equal(runCompleted, true);
      const result = { status: 0, stdout: target.stdout.join(''), stderr: target.stderr.join('') };
      if (mode[0] === '--json') {
        const output = readMachine(result, '--json');
        assert.equal(output.durationMs, 37.5);
        assert.deepEqual(output.reports, []);
      } else if (mode[0] === '--jsonl') {
        assert.equal(result.stdout, '');
        assert.deepEqual(readMachine(result, '--jsonl').reports, []);
      } else assert.match(result.stdout, /Time: 37\.50ms/);
    }
  }
});

test('clean, all-skipped and no-subject real runs retain rule durations with output-all and emit no default JSONL records', async context => {
  for (const kind of ['clean', 'skipped', 'empty'] as const) {
    const target = sandbox.isolated(kind);
    if (kind !== 'empty') {
      writeFile(join(target.cwd, '.rulekeeper', `${kind}.rule.ts`), kind === 'clean' ? CLEAN_RULE : SKIPPED_RULE);
      writeFile(join(target.cwd, 'src/clean.txt'), 'CLEAN SOURCE\n');
    } else {
      writeFile(join(target.cwd, '.rulekeeper/empty.rule.ts'), CLEAN_RULE);
    }
    for (const mode of ['human', '--json', '--jsonl'] as const) {
      for (const outputAll of [false, true]) {
        await context.test(`${kind} ${mode} ${outputAll ? 'with' : 'without'} --output-all`, async () => {
          const result = await runCommand([
            'check',
            ...(mode === 'human' ? [] : [mode]),
            ...(outputAll ? ['--output-all'] : []),
          ], target);
          assert.equal(result.status, 0, result.stderr);
          if (mode === 'human') {
            assert.equal(result.stderr, '');
            assert.match(result.stdout, /Time: \d+\.\d{2}(?:ms|s|min|h|d)\b/);
            return;
          }
          const { reports } = readMachine(result, mode);
          assert.equal(reports.length, outputAll ? 1 : 0);
          if (mode === '--jsonl') {
            assert.equal(result.stdout === '', !outputAll);
            assert.equal(result.stdout.trimEnd().split('\n').filter(Boolean).length, reports.length);
          }
          if (outputAll) assert.equal(reports[0]!.status, kind === 'clean' ? 'pass' : 'skipped');
        });
      }
    }
  }
});

test('machine failures leave stdout empty with output-all and mutually exclusive formats still fail', async () => {
  for (const mode of ['--json', '--jsonl']) {
    for (const stage of ['resolveTarget', 'loadRules', 'runRules'] as const) {
      const target = injected([], { [stage]: async () => { throw new Error('evaluation failed'); } });
      assert.equal(await runProgram(['check', mode, '--output-all'], target.services), 2);
      assert.equal(target.stdout.join(''), '');
      assert.match(target.stderr.join(''), /evaluation failed/);
      assert.equal(target.stderr.join('').includes('\u001b'), false);
    }
  }
  const conflict = injected([]);
  assert.equal(await runProgram(['check', '--json', '--jsonl', '--output-all'], conflict.services), 2);
  assert.equal(conflict.stdout.join(''), '');
  assert.match(conflict.stderr.join(''), /mutually exclusive/);
});
