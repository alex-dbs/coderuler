import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runProgram, type CliServices } from '../dist/adapter/cli/program.js';
import { createProgress, terminalCapabilities } from '../dist/adapter/cli/progress.js';
import type { RuleReport } from '../dist/app/ports.js';
import type { RuleTestResult } from '../dist/app/rule-tests.js';
import { createServices } from '../dist/infra/runtime.js';

const TTY = { stdoutIsTTY: true, stderrIsTTY: true, columns: 80 };
const REPORT: RuleReport = { name: 'example', ruleFile: '/rules/example.rule.ts', status: 'pass', durationMs: 4.25, evaluations: [] };
const TEST_RESULT: RuleTestResult = { ruleName: 'example', name: 'first case', expected: 'pass', actual: 'pass', durationMs: 12.5 };

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

test('interactive PR preparation failures stop animation before returning', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const target = fixture();
  assert.equal(await runProgram(['check', '--pr', 'invalid'], target.services), 2);
  assert.deepEqual(target.stdout, []);
  const count = target.stderr.length;
  context.mock.timers.tick(1000);
  assert.equal(target.stderr.length, count);
});

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

test('progress messages reset phase rendering and clearing preserves the animation timer', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const chunks: string[] = [];
  const progress = createProgress(text => { chunks.push(text); });
  try {
    progress.emit({ type: 'progress', phase: 'selection', completed: 1, total: 3 });
    progress.message('Running tests');
    assert.match(chunks.at(-1)!, /Running tests/);
    assert.doesNotMatch(chunks.at(-1)!, /1\/3|\[[#-]+\]/);
    progress.clear();
    assert.equal(chunks.at(-1), '\r\u001b[2K');
    const count = chunks.length;
    progress.clear();
    assert.equal(chunks.length, count);
    context.mock.timers.tick(80);
    assert.equal(chunks.length, count + 1);
    assert.match(chunks.at(-1)!, /Running tests/);
  } finally {
    progress.stop();
  }
  const count = chunks.length;
  progress.message('Too late');
  progress.clear();
  context.mock.timers.tick(1000);
  assert.equal(chunks.length, count);
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

test('interactive tests animate while pending and clear each result before resuming on the same timer', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const intervals = context.mock.method(globalThis, 'setInterval');
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const second = { ...TEST_RESULT, name: 'second case' };
  const third = { ...TEST_RESULT, ruleName: 'another-rule', name: 'third case' };
  const target = fixture();
  const services: CliServices = {
    ...target.services,
    loadRules: async () => {
      assert.ok(target.stderr.length > 0);
      assert.equal(target.stdout.length, 0);
      context.mock.timers.tick(160);
      assert.ok(target.stderr.length > 1);
      return [];
    },
    testRules: async (_rules, onResult) => {
      assert.notEqual(target.stderr.at(-1), '\r\u001b[2K');
      onResult(TEST_RESULT, false);
      const firstOutput = target.stdout.join('');
      assert.equal(firstOutput.split('\n')[0], TEST_RESULT.ruleName);
      assert.match(firstOutput, /^├─ PASS /m);
      assert.ok(firstOutput.includes(TEST_RESULT.name));
      assert.equal(firstOutput.includes(second.name), false);
      assert.equal(firstOutput.includes(third.ruleName), false);
      assert.notEqual(target.stderr.at(-1), '\r\u001b[2K');
      entered.resolve();
      await pending.promise;
      onResult(second, true);
      const secondOutput = target.stdout.join('');
      assert.match(secondOutput, /^└─ PASS /m);
      assert.ok(secondOutput.includes(second.name));
      assert.equal(secondOutput.split('\n').filter(line => line === TEST_RESULT.ruleName).length, 1);
      assert.notEqual(target.stderr.at(-1), '\r\u001b[2K');
      onResult(third, true);
      const thirdOutput = target.stdout.join('');
      assert.ok(thirdOutput.includes(`\n\n${third.ruleName}\n`));
      assert.ok(thirdOutput.includes(`└─ PASS ${third.name}`));
      assert.notEqual(target.stderr.at(-1), '\r\u001b[2K');
      return [TEST_RESULT, second, third];
    },
    write: text => {
      assert.equal(target.stderr.at(-1), '\r\u001b[2K');
      target.stdout.push(text);
    },
  };
  const running = runProgram(['test'], services);
  await entered.promise;
  const firstFrame = target.stderr.at(-1);
  const frames = target.stderr.length;
  context.mock.timers.tick(80);
  assert.equal(target.stderr.length, frames + 1);
  assert.notEqual(target.stderr.at(-1), firstFrame);
  assert.equal(target.stdout.join('').includes(second.name), false);
  pending.resolve();
  assert.equal(await running, 0);
  const sections = target.stdout.join('').trimEnd().split('\n\n');
  assert.equal(sections.length, 3);
  assert.equal(sections[2]!.includes('─'), false);
  assert.equal(target.stderr.at(-1), '\r\u001b[2K');
  assert.equal(intervals.mock.callCount(), 1);
  const count = target.stderr.length;
  context.mock.timers.tick(1000);
  assert.equal(target.stderr.length, count);
});

test('interactive tests clear and cancel animation on load errors or errors after a completed case', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  for (const stage of ['loading', 'testing'] as const) {
    const target = fixture();
    const services: CliServices = {
      ...target.services,
      loadRules: async () => {
        context.mock.timers.tick(80);
        if (stage === 'loading') throw new Error('intentional load failure');
        return [];
      },
      testRules: async (_rules, onResult) => {
        onResult(TEST_RESULT, false);
        assert.match(target.stdout.join(''), /^├─ PASS /m);
        assert.ok(target.stdout.join('').includes(TEST_RESULT.name));
        context.mock.timers.tick(160);
        throw new Error('intentional later failure');
      },
      write: text => {
        assert.equal(target.stderr.at(-1), '\r\u001b[2K');
        target.stdout.push(text);
      },
    };
    assert.equal(await runProgram(['test'], services), 2);
    const output = target.stdout.join('');
    if (stage === 'loading') assert.equal(output, '');
    else {
      assert.equal(output.trimEnd().split('\n').length, 2);
      assert.equal(output.includes('└─'), false);
      assert.equal(output.includes('\n\n'), false);
    }
    assert.equal(target.stderr.at(-2), '\r\u001b[2K');
    assert.match(target.stderr.at(-1)!, /intentional.*failure/);
    const count = target.stderr.length;
    context.mock.timers.tick(1000);
    assert.equal(target.stderr.length, count);
  }
});

test('noninteractive tests stream results without starting an animation', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const intervals = context.mock.method(globalThis, 'setInterval');
  for (const terminal of [undefined, { color: false, interactive: false, columns: 80 }]) {
    const target = fixture();
    const { terminal: _terminal, ...withoutTerminal } = target.services;
    const services: CliServices = {
      ...withoutTerminal,
      ...(terminal === undefined ? {} : { terminal }),
      testRules: async (_rules, onResult) => {
        onResult(TEST_RESULT, true);
        assert.match(target.stdout.join(''), /^└─ PASS /m);
        assert.ok(target.stdout.join('').includes(TEST_RESULT.name));
        context.mock.timers.tick(160);
        assert.equal(target.stderr.join(''), '');
        return [TEST_RESULT];
      },
    };
    assert.equal(await runProgram(['test'], services), 0);
    context.mock.timers.tick(1000);
    assert.equal(target.stderr.join(''), '');
    assert.equal(target.stdout.join('').includes('\u001b'), false);
    assert.equal(target.stdout.join('').trimEnd().split('\n\n').length, 2);
  }
  assert.equal(intervals.mock.callCount(), 0);
});

test('invalid test timeouts fail before loading or running any case', async () => {
  for (const duration of [
    '0ms', '-1s', '1', '1h', 'NaNs', 'Infinitys', '1e309s',
    '2147483648ms', '2147484s', '35792m', `${'9'.repeat(400)}ms`,
  ]) {
    let loaded = false;
    let tested = false;
    const target = fixture({
      terminal: { color: false, interactive: false },
      loadRules: async () => { loaded = true; return []; },
      testRules: async () => { tested = true; return []; },
    });
    assert.equal(await runProgram(['test', '--timeout', duration], target.services), 2, duration);
    assert.equal(loaded, false, duration);
    assert.equal(tested, false, duration);
    assert.equal(target.stdout.join(''), '', duration);
    assert.match(target.stderr.join(''), /must be a positive duration/);
  }
});

test('test summary sums case durations rather than discovery, rendering, or elapsed CLI time', async context => {
  let clock = 0;
  context.mock.method(performance, 'now', () => clock);
  const timeout: RuleTestResult = { ...TEST_RESULT, actual: 'timeout', durationMs: 125 };
  const second: RuleTestResult = { ...TEST_RESULT, name: 'second case', durationMs: 875 };
  const target = fixture({ terminal: { color: false, interactive: false } });
  const services: CliServices = {
    ...target.services,
    loadRules: async () => { clock += 30_000; return []; },
    testRules: async (_rules, onResult) => {
      clock += 20_000;
      onResult(timeout, false);
      clock += 40_000;
      onResult(second, true);
      clock += 50_000;
      return [timeout, second];
    },
    write: text => { clock += 10_000; target.stdout.push(text); },
  };
  assert.equal(await runProgram(['test'], services), 1);
  const output = target.stdout.join('');
  assert.match(output, /├─ FAIL .*actual timeout.*\(125\.00ms\)/);
  assert.match(output, /└─ PASS second case \(875\.00ms\)/);
  assert.match(output, /1 passed, 1 failed  Time: 1\.00s/);
  assert.ok(clock > 1_000);
  assert.equal(target.stderr.join(''), '');
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
