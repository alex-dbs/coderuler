import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { runProgram } from '../dist/adapter/cli/program.js';
import type { RuleReport, RunEvent } from '../dist/app/ports.js';
import { createServices } from '../dist/infra/runtime.js';
import type { InspectionUsage } from '../src/adapter/cli/inspect-usage.js';
import {
  CLI,
  asMapping,
  createSandbox,
  decisionPayload,
  runCli,
  startDecisionFixture,
  writeFile,
  type CliResult,
  type DecisionFixture,
  type DecisionFixtureOptions,
  type Sandbox,
} from './support.ts';

const sandbox = createSandbox('rulekeeper-inspect-modes-');
const fixtures: DecisionFixture[] = [];
after(async () => {
  await Promise.all(fixtures.map(fixture => fixture.close()));
  sandbox.cleanup();
});

async function fixture(options: DecisionFixtureOptions = {}): Promise<DecisionFixture> {
  const result = await startDecisionFixture(options);
  fixtures.push(result);
  return result;
}

function project(label: string, rule: string, source = 'Unicode α 日本語\nsecond line'): Sandbox {
  const target = sandbox.isolated(label);
  writeFile(join(target.cwd, '.rulekeeper/example.rule.ts'), rule);
  writeFile(join(target.cwd, 'src/example.txt'), source);
  return target;
}

const MIXED_RULE = `import { Rule, pass, violation } from '@alex-dbs/rulekeeper';
export default class Example extends Rule {
  files = ['src/*.txt'];
  check = subject => subject.source.includes('BAD') ? violation('Rejected source') : pass();
}
`;
const AI_RULE = `import { Rule, ai } from '@alex-dbs/rulekeeper';
export default class Example extends Rule {
  files = ['src/*.txt'];
  settings = { threshold: 0.8 };
  check = ai({ rule: 'All text must be tidy.' });
}
`;
const DISABLED_RULE = `import { Rule, pass } from '@alex-dbs/rulekeeper';
export default class Example extends Rule {
  enabled = false;
  files = ['src/*.txt'];
  check = pass;
}
`;

type MachineRecord =
  | { type: 'event'; event: RunEvent }
  | { type: 'report'; report: RuleReport }
  | { type: 'summary'; usage: InspectionUsage }
  | { type: 'error'; message: string };
interface Inspection {
  readonly events: readonly RunEvent[];
  readonly reports: readonly RuleReport[];
  readonly error?: string;
  readonly usage?: InspectionUsage;
}

function records(stdout: string): readonly MachineRecord[] {
  assert.ok(stdout.endsWith('\n'), stdout);
  return stdout.trimEnd().split('\n').map(line => {
    const record = JSON.parse(line) as MachineRecord;
    assert.equal(line, JSON.stringify(record));
    assert.ok(['event', 'report', 'summary', 'error'].includes(record.type), line);
    return record;
  });
}

function inspection(result: CliResult, mode: '--json' | '--jsonl'): Inspection {
  assert.equal(result.stdout.includes('\u001b'), false);
  if (mode === '--json') {
    const document = JSON.parse(result.stdout) as Inspection;
    assert.equal(result.stdout, `${JSON.stringify(document, null, 2)}\n`);
    assert.ok(Array.isArray(document.events));
    assert.ok(Array.isArray(document.reports));
    return document;
  }
  const lines = records(result.stdout);
  const errors = lines.filter(record => record.type === 'error');
  assert.ok(errors.length <= 1);
  if (errors.length > 0) assert.equal(lines.at(-1), errors[0]);
  const firstReport = lines.findIndex(record => record.type === 'report');
  if (firstReport >= 0) assert.ok(lines.slice(firstReport).every(record => record.type === 'report' || record.type === 'summary'));
  const summaries = lines.filter(record => record.type === 'summary');
  assert.ok(summaries.length <= 1);
  if (summaries.length > 0 && errors.length === 0) assert.equal(lines.at(-1), summaries[0]);
  return {
    events: lines.flatMap(record => record.type === 'event' ? [record.event] : []),
    reports: lines.flatMap(record => record.type === 'report' ? [record.report] : []),
    ...(errors[0]?.type === 'error' ? { error: errors[0].message } : {}),
    ...(summaries[0]?.type === 'summary' ? { usage: summaries[0].usage } : {}),
  };
}

test('inspect machine modes retain complete passes, violations and skipped reports without failure records', async () => {
  for (const mode of ['--json', '--jsonl'] as const) {
    for (const [label, rule, status, exit] of [
      ['pass', MIXED_RULE, 'pass', 0],
      ['mixed', MIXED_RULE, 'violation', 1],
      ['skipped', DISABLED_RULE, 'skipped', 0],
    ] as const) {
      const target = project(`${mode}-${label}`, rule);
      if (label === 'mixed') writeFile(join(target.cwd, 'src/rejected.txt'), 'BAD source');
      const result = await runCli(['inspect', 'example', mode], target);
      assert.equal(result.status, exit, result.stderr);
      assert.equal(result.stderr, '');
      const document = inspection(result, mode);
      assert.equal(document.error, undefined);
      assert.equal(document.usage, undefined);
      assert.equal(document.reports.length, 1);
      const report = document.reports[0]!;
      assert.equal(report.status, status);
      assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0);
      assert.ok(document.events.some(event => event.type === 'rule'));
      if (label === 'skipped') {
        assert.equal(report.reason, 'disabled');
        assert.deepEqual(report.evaluations, []);
      } else {
        assert.equal(report.evaluations.length, label === 'mixed' ? 2 : 1);
        assert.equal(report.evaluations[0]!.result.status, 'pass');
        const subject = report.evaluations[0]!.subject;
        assert.equal(subject.kind, 'scope');
        if (subject.kind !== 'scope') throw new Error('expected scope');
        assert.equal(subject.source, 'Unicode α 日本語\nsecond line');
        assert.equal(subject.filepath, 'src/example.txt');
        assert.equal(subject.id, '$');
        assert.deepEqual(subject.lines, { start: 1, end: 2 });
      }
    }
  }
});

test('inspect machine HTTP exchanges remain correlated strings with real thresholds and durations', async () => {
  const backend = await fixture();
  for (const mode of ['--json', '--jsonl'] as const) {
    const target = project(`http-${mode}`, AI_RULE);
    const result = await runCli(['inspect', 'example', mode], target, backend.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const document = inspection(result, mode);
    const request = document.events.find(event => event.type === 'request');
    const response = document.events.find(event => event.type === 'response');
    const evaluated = document.events.find(event => event.type === 'result');
    assert.ok(request?.type === 'request');
    assert.ok(response?.type === 'response');
    assert.ok(evaluated?.type === 'result');
    assert.equal(typeof request.body, 'string');
    assert.equal(typeof response.body, 'string');
    assert.deepEqual(JSON.parse(request.body), backend.requests.at(-1)!.body);
    assert.deepEqual(JSON.parse(response.body), decisionPayload(backend.probability, backend.model));
    assert.equal(request.evaluationId, response.evaluationId);
    assert.equal(request.evaluationId, evaluated.evaluationId);
    const report = document.reports[0]!;
    assert.ok(report.durationMs > 0);
    assert.equal(report.evaluations[0]!.result.threshold, 0.8);
    assert.equal(report.evaluations[0]!.result.probability, backend.probability);
    assert.deepEqual(document.usage, {
      verifications: 1, calls: 1, unreportedCalls: 0,
      inputTokens: 11, outputTokens: 1, inputCost: 11 * 0.042 / 1e6, outputCost: 0,
    });
    assert.deepEqual(report.evaluations[0]!.result.usage, {
      calls: 1, unreportedCalls: 0,
      inputTokens: 11, outputTokens: 1, inputCost: 11 * 0.042 / 1e6, outputCost: 0,
    });
  }
});

test('inspect JSONL streams request events before the backend responds', { timeout: 30_000 }, async context => {
  const backend = await fixture({ hold: true });
  const target = project('streaming', AI_RULE);
  const child = spawn(process.execPath, [CLI, 'inspect', 'example', '--jsonl'], {
    cwd: target.cwd,
    env: { ...target.env, ...backend.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.signal.addEventListener('abort', () => {
    backend.releaseAll();
    child.kill('SIGKILL');
  }, { once: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const observed = Promise.withResolvers<void>();
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    for (const line of stdout.split('\n').slice(0, -1)) {
      const record = JSON.parse(line) as MachineRecord;
      if (record.type === 'event' && record.event.type === 'request') observed.resolve();
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  try {
    await Promise.race([Promise.all([backend.waitForRequests(1), observed.promise]), done.then(() => {
      throw new Error(`CLI exited before its streamed request: ${stderr}`);
    })]);
    const pending = records(stdout.slice(0, stdout.lastIndexOf('\n') + 1));
    assert.ok(pending.some(record => record.type === 'event' && record.event.type === 'request'));
    assert.ok(pending.every(record => record.type === 'event' && record.event.type !== 'response'));
    backend.releaseAll();
    assert.equal(await done, 0, stderr);
    const report = records(stdout).find(record => record.type === 'report');
    assert.ok(report?.type === 'report');
  } finally {
    backend.releaseAll();
    child.kill('SIGKILL');
  }
});

test('inspect machine modes produce valid documents and terminal errors for preparation and runtime failures', async () => {
  const backend = await fixture();
  backend.answer = () => ({ status: 503, body: 'upstream refused\ntry later' });
  for (const mode of ['--json', '--jsonl'] as const) {
    for (const failure of ['selector', 'target', 'load', 'check', 'network'] as const) {
      const throwing = MIXED_RULE.replace("check = subject => subject.source.includes('BAD') ? violation('Rejected source') : pass();", "check = () => { throw new Error('check exploded'); };");
      const target = project(`${failure}-${mode}`, failure === 'network' ? AI_RULE : failure === 'check' ? throwing : MIXED_RULE);
      if (failure === 'load') writeFile(join(target.cwd, '.rulekeeper/example.rule.ts'), 'export default {};');
      const args = ['inspect', failure === 'selector' ? 'missing-rule' : 'example', ...(failure === 'target' ? ['src/example.txt'] : []), mode];
      const result = await runCli(args, target, backend.env);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /^rulekeeper:/);
      const document = inspection(result, mode);
      assert.equal(typeof document.error, 'string');
      assert.ok(document.error!.length > 0);
      assert.deepEqual(document.reports, []);
      if (failure === 'check' || failure === 'network') {
        assert.ok(document.events.some(event => event.type === 'error'));
      } else assert.deepEqual(document.events, []);
      if (failure === 'network') {
        const response = document.events.find(event => event.type === 'response');
        assert.ok(response?.type === 'response');
        assert.equal(response.status, 503);
        assert.equal(typeof response.body, 'string');
        assert.equal(JSON.parse(response.body), 'upstream refused\ntry later');
        assert.deepEqual(document.usage, {
          verifications: 1, calls: 1, unreportedCalls: 1,
          inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0,
        });
      }
    }
  }
});

test('inspect machine formats retain valid diagnostics on a refused local connection', async () => {
  const backend = await startDecisionFixture();
  await backend.close();
  for (const mode of ['--json', '--jsonl'] as const) {
    const target = project(`connection-${mode}`, AI_RULE);
    const result = await runCli(['inspect', 'example', mode], target, backend.env);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /^rulekeeper:/);
    const document = inspection(result, mode);
    assert.ok(document.error);
    assert.deepEqual(document.reports, []);
    assert.ok(document.events.some(event => event.type === 'request'));
    assert.ok(document.events.some(event => event.type === 'error'));
    assert.equal(document.events.some(event => event.type === 'response'), false);
  }
});

test('inspect rejects every pair of formats before selector resolution, loading, hooks or HTTP', async () => {
  const backend = await fixture();
  const target = project('conflicts', `import { writeFileSync } from 'node:fs';
import { Rule, ai } from '@alex-dbs/rulekeeper';
writeFileSync('loaded-marker', 'loaded');
export default class Example extends Rule {
  files = ['src/*.txt'];
  when() { writeFileSync('hook-marker', 'hook'); return true; }
  check = ai({ rule: 'Do not run.' });
}
`);
  for (const pair of [['--json', '--jsonl'], ['--json', '--raw'], ['--jsonl', '--raw']]) {
    for (const options of [pair, [...pair].reverse()]) {
      const result = await runCli(['inspect', 'example', ...options], target, backend.env);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      for (const option of pair) assert.ok(result.stderr.includes(option), result.stderr);
      assert.match(result.stderr, /exclusive|conflict|cannot/i);
      assert.equal(existsSync(join(target.cwd, 'loaded-marker')), false);
      assert.equal(existsSync(join(target.cwd, 'hook-marker')), false);
    }
  }
  const output: string[] = [];
  const errors: string[] = [];
  let resolved = false;
  const services = {
    ...createServices(target.cwd, {}),
    resolveRuleSelector: async () => { resolved = true; throw new Error('selector ran'); },
    write: (text: string) => { output.push(text); },
    writeError: (text: string) => { errors.push(text); },
  };
  assert.equal(await runProgram(['inspect', 'example', '--json', '--raw'], services), 2);
  assert.equal(resolved, false);
  assert.equal(output.join(''), '');
  assert.match(errors.join(''), /exclusive|conflict|cannot/i);
  assert.equal(backend.requests.length, 0);
});

test('inspect raw is unboxed uncolored and unwrapped while retaining original payloads and safe source', async () => {
  const backend = await fixture();
  const source = `Unicode α 日本語 ${'unbroken-source-'.repeat(18)}\n\tlast\u001b[31m\u0007`;
  const target = project('raw', AI_RULE, source);
  const result = await runCli(['inspect', 'example', '--raw'], target, { ...backend.env, FORCE_COLOR: '1', NO_COLOR: undefined });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /[╭╮╰╯│─\u001b\u0007]/);
  assert.ok(result.stdout.includes('unbroken-source-'.repeat(18)));
  assert.ok(result.stdout.includes(backend.requests.at(-1)!.raw));
  assert.ok(result.stdout.includes(JSON.stringify(decisionPayload(backend.probability, backend.model))));
  assert.equal(result.stdout.split('\n').filter(line => line.trim() === 'file: src/example.txt:1-2').length, 1);
  assert.equal(result.stdout.split('\n').filter(line => line.trim().startsWith('scope:')).length, 1);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const services = {
    ...createServices(target.cwd, backend.env),
    terminal: { color: true, interactive: true, stdoutColumns: 20, columns: 20 },
    write: (text: string) => { stdout.push(text); },
    writeError: (text: string) => { stderr.push(text); },
  };
  assert.equal(await runProgram(['inspect', 'example', '--raw'], services), 0, stderr.join(''));
  assert.doesNotMatch(stdout.join(''), /[╭╮╰╯│─\u001b\u0007]/);
  assert.ok(stdout.join('').includes('unbroken-source-'.repeat(18)));
});

test('inspect diagnostics redact credentials while check machine reports remain deliberately unredacted', async () => {
  const secret = 'quoted"credential';
  const backend = await fixture({ apiKey: secret });
  const target = project('redaction', AI_RULE, `Unicode α ${secret}`);
  for (const mode of ['--json', '--jsonl', '--raw'] as const) {
    const result = await runCli(['inspect', 'example', mode], target, backend.env);
    assert.equal(result.status, 0, result.stderr);
    for (const output of [result.stdout, result.stderr]) {
      assert.equal(output.includes(secret), false);
      assert.equal(output.includes(JSON.stringify(secret).slice(1, -1)), false);
    }
    assert.ok(result.stdout.includes('[REDACTED]'));
    if (mode !== '--raw') {
      const document = inspection(result, mode);
      assert.equal(document.reports[0]!.status, 'pass');
      assert.ok(document.events.some(event => event.type === 'result' && event.result.status === 'pass'));
    }
  }
  for (const mode of ['--json', '--jsonl'] as const) {
    const filtered = await runCli(['check', mode], target, backend.env);
    assert.equal(filtered.status, 0, filtered.stderr);
    if (mode === '--json') {
      const document = asMapping(JSON.parse(filtered.stdout), 'check document');
      assert.deepEqual(document['reports'], []);
    } else assert.equal(filtered.stdout, '');
    const all = await runCli(['check', mode, '--output-all'], target, backend.env);
    assert.equal(all.status, 0, all.stderr);
    assert.ok(all.stdout.includes(JSON.stringify(secret).slice(1, -1)), all.stdout);
  }
  writeFile(join(target.cwd, '.rulekeeper/example.rule.ts'), `import { Rule } from '@alex-dbs/rulekeeper';
export default class Example extends Rule {
  files = ['src/*.txt'];
  check = () => { throw new Error('check exploded ' + process.env.TYPESAFE_API_KEY); };
}
`);
  for (const mode of ['--json', '--jsonl', '--raw'] as const) {
    const result = await runCli(['inspect', 'example', mode], target, backend.env);
    assert.equal(result.status, 2);
    assert.equal((result.stdout + result.stderr).includes(secret), false);
    assert.equal((result.stdout + result.stderr).includes(JSON.stringify(secret).slice(1, -1)), false);
    assert.match(result.stderr, /^rulekeeper:.*\[REDACTED\]/);
    if (mode !== '--raw') {
      const document = inspection(result, mode);
      assert.equal(document.error, 'check exploded [REDACTED]');
      assert.deepEqual(document.reports, []);
    }
  }
});

test('inspect help and usage errors keep standard CLI stdout and stderr conventions', async () => {
  const target = sandbox.isolated('usage');
  const help = await runCli(['inspect', '--json', '--help'], target);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:.*inspect/);
  for (const option of ['--json', '--jsonl', '--raw']) assert.ok(help.stdout.includes(option));
  for (const args of [['inspect', '--json'], ['inspect', 'example', '--json', '--unknown']]) {
    const result = await runCli(args, target);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.length > 0);
  }
});

test('inspect pricing overrides independently replace rule and environment rates, including zero', async () => {
  const backend = await fixture();
  const rule = AI_RULE.replace('threshold: 0.8', 'threshold: 0.8, inputCostPerMillion: 5, outputCostPerMillion: 7');
  for (const mode of ['--json', '--jsonl'] as const) {
    for (const [flags, inputPrice, outputPrice] of [
      [[], 5, 7],
      [['--input-cost-per-million', '0'], 0, 7],
      [['--output-cost-per-million', '.25'], 5, 0.25],
      [['--input-cost-per-million', '2.5', '--output-cost-per-million', '3'], 2.5, 3],
    ] as const) {
      const target = project(`prices-${mode}-${inputPrice}-${outputPrice}`, rule);
      const result = await runCli(['inspect', 'example', mode, ...flags], target, {
        ...backend.env, RK_INPUT_COST_PER_MILLION: '99', RK_OUTPUT_COST_PER_MILLION: '101',
      });
      assert.equal(result.status, 0, result.stderr);
      const document = inspection(result, mode);
      assert.equal(document.usage?.inputCost, 11 * inputPrice / 1e6);
      assert.equal(document.usage?.outputCost, outputPrice / 1e6);
      assert.equal(document.reports[0]!.evaluations[0]!.result.usage?.inputCost, document.usage?.inputCost);
      assert.equal(document.reports[0]!.evaluations[0]!.result.usage?.outputCost, document.usage?.outputCost);
    }
  }
});

test('inspect rejects invalid prices before loading and does not expose price flags on other commands', async context => {
  const target = sandbox.isolated('invalid-prices');
  async function run(args: readonly string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let loadCalls = 0;
    const services = {
      ...createServices(target.cwd, target.env),
      loadRules: async () => {
        loadCalls++;
        throw new Error('loadRules must not be reached for invalid price options');
      },
      write: (text: string) => { stdout.push(text); },
      writeError: (text: string) => { stderr.push(text); },
    };
    const status = await runProgram(args, services);
    return { status, stdout: stdout.join(''), stderr: stderr.join(''), loadCalls };
  }

  for (const option of ['--input-cost-per-million', '--output-cost-per-million']) {
    for (const value of ['', '-1', 'NaN', 'Infinity', '1e3', '0x10', '1'.repeat(400)]) {
      await context.test(`invalid ${option}=${value}`, async () => {
        const result = await run(['inspect', 'missing', `${option}=${value}`]);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.ok(result.stderr.includes(option), result.stderr);
        assert.equal(result.loadCalls, 0);
      });
    }
    for (const command of ['check', 'validate', 'test']) {
      await context.test(`${command} rejects ${option}`, async () => {
        const result = await run([command, option, '1']);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /unknown option/);
      });
    }
  }
});

test('inspect recaps multiple actual calls and earlier verifications after a later backend failure', async () => {
  const backend = await fixture();
  let calls = 0;
  backend.answer = () => ++calls === 3 ? { status: 503, body: 'stopped' } : {};
  const target = project('multi-partial', `import { Rule, pass } from '@alex-dbs/rulekeeper';
export default class Example extends Rule {
  files = ['src/*.txt'];
  async check(subject, context) {
    await context.ai({ rule: 'First check' });
    await context.ai({ rule: 'Second check' });
    return pass();
  }
}`);
  writeFile(join(target.cwd, 'src/second.txt'), 'Second source');
  for (const mode of ['--json', '--jsonl'] as const) {
    calls = 0;
    const result = await runCli(['inspect', 'example', mode], target, backend.env);
    assert.equal(result.status, 2, result.stderr);
    const document = inspection(result, mode);
    assert.ok(document.error);
    assert.deepEqual(document.usage, {
      verifications: 2, calls: 3, unreportedCalls: 1,
      inputTokens: 22, outputTokens: 2, inputCost: 2 * (11 * 0.042 / 1e6), outputCost: 0,
    });
    const completed = document.events.find(event => event.type === 'result');
    assert.ok(completed?.type === 'result');
    assert.equal(completed.result.status, 'pass');
    assert.equal(completed.result.usage?.calls, 2);
  }
});
