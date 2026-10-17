import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runProgram, type CliServices } from '../dist/adapter/cli/program.js';
import { createProgress, terminalCapabilities } from '../dist/adapter/cli/progress.js';
import type { RuleReport } from '../dist/app/ports.js';
import { createServices } from '../dist/infra/runtime.js';

const TTY = { stdoutIsTTY: true, stderrIsTTY: true, columns: 80 };
const REPORT: RuleReport = { name: 'example', ruleFile: '/rules/example.rule.ts', status: 'pass', durationMs: 4.25, evaluations: [] };

function fixture(overrides: Partial<CliServices> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const services: CliServices = {
    ...createServices('/project', {}),
    terminal: { color: false, interactive: true, columns: 80 },
    resolveTarget: async () => ({ root: '/project', path: '.', kind: 'directory', contains: () => true }),
    loadRules: async () => [],
    runRules: async () => [REPORT],
    write: text => { stdout.push(text); },
    writeError: text => { stderr.push(text); },
    ...overrides,
  };
  return { services, stdout, stderr };
}

test('terminal colors honor capability and environment precedence', () => {
  for (const [env, color] of [
    [{}, true],
    [{ NO_COLOR: '' }, false],
    [{ TERM: 'dumb' }, false],
    [{ FORCE_COLOR: '0' }, false],
    [{ FORCE_COLOR: 'false' }, false],
    [{ FORCE_COLOR: '1', NO_COLOR: '1', TERM: 'dumb' }, true],
    [{ FORCE_COLOR: '' }, true],
    [{ FORCE_COLOR: '2' }, true],
    [{ FORCE_COLOR: '3' }, true],
  ] as const) {
    assert.equal(terminalCapabilities(TTY, env).color, color, JSON.stringify(env));
  }
  const redirected = { ...TTY, stdoutIsTTY: false, stderrIsTTY: false };
  assert.equal(terminalCapabilities(redirected, {}).color, false);
  assert.equal(terminalCapabilities(redirected, { FORCE_COLOR: '1' }).color, true);
  assert.equal(terminalCapabilities(redirected, { FORCE_COLOR: '1' }).interactive, false);
  assert.equal(terminalCapabilities({ ...TTY, stdoutIsTTY: false }, {}).interactive, false);
  assert.equal(terminalCapabilities({ ...TTY, stderrIsTTY: false }, {}).interactive, false);
  assert.equal(terminalCapabilities(TTY, { TERM: 'dumb' }).interactive, false);
});

test('progress animates ASCII frames and uses real phase counts without touching the cursor', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const chunks: string[] = [];
  const progress = createProgress(text => { chunks.push(text); }, () => 72);
  try {
    const first = chunks.at(-1);
    context.mock.timers.tick(80);
    assert.notEqual(chunks.at(-1), first);
    progress.emit({ type: 'rule', name: 'unsafe\u001b[31m', ruleFile: '/unsafe\u001b[31m' });
    assert.equal(chunks.join('').includes('unsafe'), false);
    assert.equal(chunks.join('').includes('%'), false);
    progress.emit({ type: 'progress', phase: 'selection', completed: 1, total: 3 });
    assert.match(chunks.at(-1)!, /1\/3.*rules/);
    progress.emit({ type: 'progress', phase: 'evaluation', completed: 2, total: 7 });
    assert.match(chunks.at(-1)!, /2\/7.*subjects/);
    assert.match(chunks.at(-1)!, /\[[#-]+\]/);
    assert.equal(/[^\x00-\x7f]/.test(chunks.join('')), false);
    assert.equal(chunks.join('').includes('\u001b[?25'), false);
  } finally {
    progress.stop();
  }
  assert.equal(chunks.at(-1), '\r\u001b[2K');
  const count = chunks.length;
  context.mock.timers.tick(1000);
  progress.stop();
  progress.emit({ type: 'progress', phase: 'evaluation', completed: 7, total: 7 });
  assert.equal(chunks.length, count);
});

test('progress fits narrow terminals and adapts to resizing', () => {
  const chunks: string[] = [];
  let columns = 12;
  const progress = createProgress(text => { chunks.push(text); }, () => columns);
  try {
    progress.emit({ type: 'progress', phase: 'evaluation', completed: 1, total: 20 });
    columns = 4;
    progress.emit({ type: 'progress', phase: 'evaluation', completed: 2, total: 20 });
    const frames = chunks.map(chunk => chunk.replace(/\r|\u001b\[2K/g, ''));
    assert.ok(frames[0]!.length < 12);
    assert.ok(frames[1]!.length < 12);
    assert.ok(frames[2]!.length < 4);
  } finally {
    progress.stop();
  }
});

test('interactive check starts feedback before target and rule loading and clears before its summary', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const target = fixture();
  const services: CliServices = {
    ...target.services,
    resolveTarget: async () => {
      assert.ok(target.stderr.length > 0);
      context.mock.timers.tick(160);
      return { root: '/project', path: '.', kind: 'directory', contains: () => true };
    },
    loadRules: async () => {
      assert.ok(target.stderr.length > 1);
      return [];
    },
    runRules: async (_rules, run) => {
      run.emit?.({ type: 'progress', phase: 'selection', completed: 0, total: 0 });
      run.emit?.({ type: 'progress', phase: 'evaluation', completed: 0, total: 0 });
      return [REPORT];
    },
    write: text => {
      assert.equal(target.stderr.at(-1), '\r\u001b[2K');
      target.stdout.push(text);
    },
  };
  assert.equal(await runProgram(['check'], services), 0);
  assert.ok(target.stdout.join('').includes('1'));
  const count = target.stderr.length;
  context.mock.timers.tick(1000);
  assert.equal(target.stderr.length, count);
});

test('interactive check clears progress and cancels animation after loading or evaluation errors', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  for (const stage of ['resolveTarget', 'loadRules', 'runRules'] as const) {
    const target = fixture({ [stage]: async () => { throw new Error('intentional failure'); } });
    assert.equal(await runProgram(['check'], target.services), 2);
    assert.equal(target.stdout.join(''), '');
    assert.equal(target.stderr.at(-2), '\r\u001b[2K');
    assert.match(target.stderr.at(-1)!, /intentional failure/);
    const count = target.stderr.length;
    context.mock.timers.tick(1000);
    assert.equal(target.stderr.length, count);
  }
});

test('machine modes, diagnostic modes and noninteractive services never animate', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  for (const options of [['--json'], ['--jsonl'], ['--debug'], ['--verbose']]) {
    const target = fixture();
    assert.equal(await runProgram(['check', ...options], target.services), 0);
    context.mock.timers.tick(1000);
    assert.equal(target.stderr.join('').includes('\u001b'), false);
    if (options[0] === '--json') {
      const output = JSON.parse(target.stdout.join(''));
      assert.deepEqual(output.reports, []);
      assert.equal(typeof output.durationMs, 'number');
    }
    if (options[0] === '--jsonl') assert.equal(target.stdout.join(''), '');
  }
  for (const terminal of [undefined, { color: false, interactive: false, columns: 80 }]) {
    const target = fixture();
    const { terminal: _terminal, ...withoutTerminal } = target.services;
    const services: CliServices = terminal === undefined ? withoutTerminal : { ...withoutTerminal, terminal };
    assert.equal(await runProgram(['check'], services), 0);
    context.mock.timers.tick(1000);
    assert.equal(target.stderr.join(''), '');
    assert.equal(target.stdout.join('').includes('\u001b'), false);
  }
});

test('empty machine runs retain total duration only in JSON and emit no JSONL records or progress', async () => {
  for (const option of ['--json', '--jsonl']) {
    const target = fixture({
      terminal: { color: true, interactive: true, columns: 80 },
      runRules: async () => [],
    });
    assert.equal(await runProgram(['check', option], target.services), 0);
    assert.equal(target.stderr.join(''), '');
    if (option === '--json') {
      const output = JSON.parse(target.stdout.join(''));
      assert.equal(typeof output.durationMs, 'number');
      assert.ok(Number.isFinite(output.durationMs) && output.durationMs >= 0);
      assert.deepEqual(output.reports, []);
    } else assert.equal(target.stdout.join(''), '');
  }
});

test('check enables summary colors only when injected terminal capabilities allow them', async context => {
  context.mock.method(performance, 'now', () => 100);
  const plain = fixture({ terminal: { color: false, interactive: false } });
  const colored = fixture({ terminal: { color: true, interactive: false } });
  assert.equal(await runProgram(['check'], plain.services), 0);
  assert.equal(await runProgram(['check'], colored.services), 0);
  assert.equal(plain.stdout.join('').includes('\u001b'), false);
  assert.equal(colored.stdout.join('').includes('\u001b'), true);
  assert.equal(colored.stdout.join('').replace(/\u001b\[[0-9;]*m/g, ''), plain.stdout.join(''));
});

test('CLI card rendering receives live widths, preserves concurrency, and closes partial output in finally', async () => {
  const subject = {
    kind: 'scope' as const,
    filepath: 'src/example.txt',
    id: '$',
    source: 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ',
  };
  for (const mode of ['inspect', 'verbose'] as const) {
    for (const fails of [false, true]) {
      let columns = 32;
      const target = fixture({
        terminal: { color: false, interactive: false, get columns() { return columns; } },
        resolveRuleSelector: async () => ({ name: 'example' }),
        runRules: async (_rules, run) => {
          assert.equal(run.concurrency, mode === 'inspect' ? 1 : 3);
          run.emit?.({ type: 'evaluation', evaluationId: 1, name: 'example', subject });
          run.emit?.({ type: 'result', evaluationId: 1, name: 'example', subject, result: { status: 'pass' } });
          columns = 44;
          run.emit?.({ type: 'evaluation', evaluationId: 2, name: 'example', subject });
          run.emit?.({ type: 'trace', evaluationId: 2, name: 'example', message: 'before failure' });
          if (fails) throw new Error('failure without terminal event');
          return [REPORT];
        },
      });
      const args = mode === 'inspect' ? ['inspect', 'example'] : ['check', '--verbose', '--concurrency', '3'];
      assert.equal(await runProgram(args, target.services), fails ? 2 : 0);
      const output = (mode === 'inspect' ? target.stdout : target.stderr).join('');
      const lines = output.split('\n');
      const tops = lines.filter(line => line.startsWith('╭'));
      const bottoms = lines.filter(line => line.startsWith('╰'));
      assert.deepEqual(tops.map(line => line.length), [32, 44], output);
      assert.deepEqual(bottoms.map(line => line.length), [32, 44], output);
      assert.match(output, /Incomplete/);
      assert.match(output, /before failure/);
      assert.equal(output.includes('\u001b'), false);
      let width = 0;
      for (const line of lines) {
        if (line.startsWith('╭')) width = line.length;
        if (line.startsWith('│') || line.startsWith('╰')) assert.equal(line.length, width, line);
      }
      if (fails) {
        assert.match(target.stderr.at(-1)!, /^rulekeeper: failure without terminal event\n$/);
        if (mode === 'verbose') assert.ok(output.lastIndexOf('╰') < output.indexOf('rulekeeper:'), output);
      }
    }
  }
});

test('inspect uses stdout width while verbose keeps stderr width and injected columns remain a fallback', async () => {
  const redirectedStderr = terminalCapabilities({
    stdoutIsTTY: true,
    stderrIsTTY: false,
    stdoutColumns: 52,
  }, { NO_COLOR: '1' });
  const separateStreams = terminalCapabilities({
    stdoutIsTTY: true,
    stderrIsTTY: true,
    stdoutColumns: 56,
    columns: 36,
  }, { NO_COLOR: '1' });
  const synthetic = { color: false, interactive: false, columns: 44 };
  for (const [terminal, inspectWidth, verboseWidth] of [
    [redirectedStderr, 52, 80],
    [separateStreams, 56, 36],
    [synthetic, 44, 44],
  ] as const) {
    for (const mode of ['inspect', 'verbose'] as const) {
      const target = fixture({
        terminal,
        resolveRuleSelector: async () => ({ name: 'example' }),
        runRules: async (_rules, run) => {
          const subject = { kind: 'scope' as const, filepath: 'src/example.txt', id: '$', source: 'example' };
          run.emit?.({ type: 'evaluation', evaluationId: 1, name: 'example', subject });
          run.emit?.({ type: 'result', evaluationId: 1, name: 'example', subject, result: { status: 'pass' } });
          return [REPORT];
        },
      });
      assert.equal(await runProgram(mode === 'inspect' ? ['inspect', 'example'] : ['check', '--verbose'], target.services), 0);
      const output = (mode === 'inspect' ? target.stdout : target.stderr).join('');
      const top = output.split('\n').find(line => line.startsWith('╭'));
      assert.ok(top !== undefined, output);
      assert.equal(top.length, mode === 'inspect' ? inspectWidth : verboseWidth, output);
    }
  }
});
