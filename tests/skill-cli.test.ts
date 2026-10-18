import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createProgram, runProgram } from '../dist/adapter/cli/program.js';
import { createSkillManager, SKILL_NAME, SKILL_SOURCE } from '../dist/adapter/skills/cli.js';
import { createServices } from '../dist/infra/runtime.js';
import { createSandbox, ROOT, writeFile } from './support.ts';

const sandbox = createSandbox('rulekeeper-skill-cli-');
after(() => sandbox.cleanup());

const SHIM = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SKILLS_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.SKILLS_MARKER }) + '\\n');
if (process.argv[2] === 'list') {
  process.stdout.write(process.env.SKILLS_LIST ?? '[]');
  process.exit(Number(process.env.SKILLS_LIST_STATUS ?? 0));
}
if (process.env.SKILLS_SIGNAL) process.kill(process.pid, process.env.SKILLS_SIGNAL);
if (process.env.SKILLS_STDOUT) process.stdout.write(process.env.SKILLS_STDOUT);
if (process.env.SKILLS_STDERR) process.stderr.write(process.env.SKILLS_STDERR);
process.exitCode = Number(process.env.SKILLS_STATUS ?? 0);
`;

interface Invocation {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly marker: string;
}

function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const target = sandbox.isolated('skills');
  const executable = writeFile(join(target.root, 'fake skills.mjs'), SHIM);
  const logfile = join(target.root, 'calls.jsonl');
  const env = {
    ...target.env,
    PATH: '',
    SKILLS_LOG: logfile,
    SKILLS_MARKER: 'inherited environment',
    SKILLS_LIST: JSON.stringify([{
      name: SKILL_NAME,
      scope: 'project',
      path: join(target.cwd, '.agents', 'skills', SKILL_NAME),
      agents: [],
    }]),
    ...overrides,
  };
  const stderr: string[] = [];
  const services = {
    ...createServices(target.cwd, env),
    manageSkill: createSkillManager(target.cwd, env, executable),
    writeError: (text: string) => { stderr.push(text); },
  };
  return {
    target, executable, env, services, stderr,
    calls: (): readonly Invocation[] => readFileSync(logfile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Invocation),
  };
}

const ADD = ['add', SKILL_SOURCE, '--skill', SKILL_NAME];

test('install defaults to the bundled skill in the universal directory, preserving prompts and arbitrary cwd', async () => {
  const target = fixture();
  assert.equal(await runProgram(['skill', 'install'], target.services), 0);
  assert.deepEqual(target.calls(), [{ args: [...ADD, '--agent', 'universal'], cwd: target.target.cwd, marker: 'inherited environment' }]);
  assert.equal(SKILL_SOURCE, join(ROOT, 'skills', SKILL_NAME));
  assert.match(readFileSync(join(SKILL_SOURCE, 'SKILL.md'), 'utf8'), /name: rulekeeper-new-rule/);
});

test('install forwards global scope, multiple agents, confirmation and copy flags without shell parsing', async () => {
  const target = fixture();
  assert.equal(await runProgram(['skill', 'install', '-g', '-a', 'claude-code', 'cursor', '-y', '--copy'], target.services), 0);
  assert.deepEqual(target.calls()[0]?.args, [...ADD, '--global', '--agent', 'claude-code', 'cursor', '--yes', '--copy']);
});

test('update checks and refreshes only the universal project installation by default', async () => {
  const target = fixture();
  assert.equal(await runProgram(['skill', 'update', '--project', '--copy'], target.services), 0);
  assert.deepEqual(target.calls().map(call => call.args), [
    ['list', '--json', '--agent', 'universal'],
    [...ADD, '--agent', 'universal', '--yes', '--copy'],
  ]);
});

test('global update verifies the universal installation under the home directory', async () => {
  const target = fixture();
  target.env.SKILLS_LIST = JSON.stringify([{
    name: SKILL_NAME,
    scope: 'global',
    path: join(target.target.home, '.agents', 'skills', SKILL_NAME),
    agents: [],
  }]);
  assert.equal(await runProgram(['skill', 'update', '--global'], target.services), 0);
  assert.deepEqual(target.calls().map(call => call.args), [
    ['list', '--json', '--global', '--agent', 'universal'],
    [...ADD, '--global', '--agent', 'universal', '--yes'],
  ]);
});

test('global universal update uses the home path even when XDG config is set', async () => {
  const config = join(sandbox.root, 'custom-config');
  const target = fixture({ XDG_CONFIG_HOME: config });
  target.env.SKILLS_LIST = JSON.stringify([{
    name: SKILL_NAME,
    scope: 'global',
    path: join(target.target.home, '.agents', 'skills', SKILL_NAME),
    agents: [],
  }]);
  assert.equal(await runProgram(['skill', 'update', '--global'], target.services), 0);
});

test('universal update verifies the exact canonical destination rather than an agent label', async () => {
  for (const path of [undefined, '/another-project/.agents/skills/rulekeeper-new-rule']) {
    const target = fixture({
      SKILLS_LIST: JSON.stringify([{ name: SKILL_NAME, scope: 'project', path, agents: ['Universal'] }]),
    });
    assert.equal(await runProgram(['skill', 'update', '--agent', 'universal'], target.services), 2);
    assert.deepEqual(target.calls().map(call => call.args), [['list', '--json', '--agent', 'universal']]);
    assert.match(target.stderr.join(''), /not installed for agent "universal"/);
  }
});

test('explicit universal update can refresh the canonical destination together with verified agent copies', async () => {
  const target = fixture();
  target.env.SKILLS_LIST = JSON.stringify([{
    name: SKILL_NAME,
    scope: 'project',
    path: join(target.target.cwd, '.agents', 'skills', SKILL_NAME),
    agents: ['Claude Code'],
  }]);
  assert.equal(await runProgram(['skill', 'update', '--agent', 'universal', 'claude-code'], target.services), 0);
  assert.deepEqual(target.calls().map(call => call.args), [
    ['list', '--json', '--agent', 'universal', 'claude-code'],
    [...ADD, '--agent', 'universal', 'claude-code', '--yes'],
  ]);
});

test('update forwards global and agent selection to discovery and refresh', async () => {
  const target = fixture({ SKILLS_LIST: JSON.stringify([{ name: SKILL_NAME, scope: 'global', agents: ['Claude Code'] }]) });
  assert.equal(await runProgram(['skill', 'update', '--global', '--agent', 'claude-code'], target.services), 0);
  assert.deepEqual(target.calls().map(call => call.args), [
    ['list', '--json', '--global', '--agent', 'claude-code'],
    [...ADD, '--global', '--agent', 'claude-code', '--yes'],
  ]);
});

test('update verifies every explicit agent using case-insensitive, punctuation-insensitive display labels', async () => {
  const target = fixture({
    SKILLS_LIST: JSON.stringify([
      { name: SKILL_NAME, scope: 'project', agents: ['Claude Code', 'GitHub Copilot'] },
    ]),
  });
  assert.equal(await runProgram(['skill', 'update', '--agent', 'claude-code', 'github-copilot'], target.services), 0);
  assert.deepEqual(target.calls().map(call => call.args), [
    ['list', '--json', '--agent', 'claude-code', 'github-copilot'],
    [...ADD, '--agent', 'claude-code', 'github-copilot', '--yes'],
  ]);
});

test('default update does not refresh another agent or install a new universal copy', async () => {
  const target = fixture({
    SKILLS_LIST: JSON.stringify([{ name: SKILL_NAME, scope: 'project', agents: ['Claude Code'] }]),
  });
  assert.equal(await runProgram(['skill', 'update'], target.services), 2);
  assert.deepEqual(target.calls().map(call => call.args), [['list', '--json', '--agent', 'universal']]);
  assert.match(target.stderr.join(''), /not installed for agent "universal"/);
});

test('update refuses all requested agents before refreshing when any target is not installed', async () => {
  for (const installed of [
    [{ name: SKILL_NAME, scope: 'project', agents: ['Claude Code'] }],
    [{ name: SKILL_NAME, scope: 'project', agents: ['Universal'] }],
    [
      { name: SKILL_NAME, scope: 'project', agents: ['Claude Code'] },
      { name: SKILL_NAME, scope: 'global', agents: ['Cursor'] },
    ],
    [
      { name: SKILL_NAME, scope: 'project', agents: ['Claude Code'] },
      { name: 'another-skill', scope: 'project', agents: ['Cursor'] },
    ],
  ]) {
    const target = fixture({ SKILLS_LIST: JSON.stringify(installed) });
    assert.equal(await runProgram(['skill', 'update', '--agent', 'claude-code', 'cursor'], target.services), 2);
    assert.deepEqual(target.calls().map(call => call.args), [
      ['list', '--json', '--agent', 'claude-code', 'cursor'],
    ]);
    assert.match(target.stderr.join(''), /not installed for agent/);
  }
});

test('update rejects unknown or missing display labels instead of guessing an installed target', async () => {
  for (const agents of [['Claude Code (Legacy)'], ['Claude'], [], undefined, 'Claude Code', [null]]) {
    const target = fixture({
      SKILLS_LIST: JSON.stringify([{ name: SKILL_NAME, scope: 'project', agents }]),
    });
    assert.equal(await runProgram(['skill', 'update', '--agent', 'claude-code'], target.services), 2);
    assert.deepEqual(target.calls().map(call => call.args), [['list', '--json', '--agent', 'claude-code']]);
    assert.match(target.stderr.join(''), /use a supported installed --agent target or universal/);
  }
});

test('explicit wildcard update opts into every upstream agent without passing an invalid list filter', async () => {
  const target = fixture();
  assert.equal(await runProgram(['skill', 'update', '--agent', '*'], target.services), 0);
  assert.deepEqual(target.calls().map(call => call.args), [
    ['list', '--json'],
    [...ADD, '--agent', '*', '--yes'],
  ]);
});

test('update refuses absent skills rather than refreshing another skill or installing a new one', async () => {
  for (const installed of [
    [],
    [{ name: 'another-skill', scope: 'project', agents: ['Universal'] }],
    [{ name: SKILL_NAME, scope: 'global', agents: ['Universal'] }],
  ]) {
    const target = fixture({ SKILLS_LIST: JSON.stringify(installed) });
    assert.equal(await runProgram(['skill', 'update'], target.services), 2);
    assert.deepEqual(target.calls().map(call => call.args), [['list', '--json', '--agent', 'universal']]);
    assert.match(target.stderr.join(''), /rulekeeper-new-rule is not installed/);
  }
});

test('subprocess failure status propagates for installation, discovery, and refresh', async () => {
  for (const [args, overrides, expectedStatus, expectedCalls] of [
    [['skill', 'install'], { SKILLS_STATUS: '17' }, 17, 1],
    [['skill', 'update'], { SKILLS_LIST_STATUS: '23' }, 23, 1],
    [['skill', 'update'], { SKILLS_STATUS: '29' }, 29, 2],
  ] as const) {
    const target = fixture(overrides);
    assert.equal(await runProgram(args, target.services), expectedStatus);
    assert.equal(target.calls().length, expectedCalls);
  }
});

test('malformed discovery output fails closed before any refresh', async () => {
  const target = fixture({ SKILLS_LIST: 'not json' });
  assert.equal(await runProgram(['skill', 'update'], target.services), 2);
  assert.equal(target.calls().length, 1);
});

test('a subprocess that cannot start is reported as an operational failure', async () => {
  const target = fixture();
  const services = { ...target.services, manageSkill: createSkillManager(join(target.target.root, 'missing'), target.env, target.executable) };
  assert.equal(await runProgram(['skill', 'install'], services), 2);
  assert.match(target.stderr.join(''), /ENOENT/);
});

test('subprocess termination signals are returned as conventional shell exit statuses', async () => {
  const target = fixture({ SKILLS_SIGNAL: 'SIGTERM' });
  assert.equal(await runProgram(['skill', 'install'], target.services), 143);
});

test('interactive subprocess streams are inherited and its exit reaches the caller', () => {
  const target = fixture({ SKILLS_STDOUT: 'upstream stdout\n', SKILLS_STDERR: 'upstream stderr\n', SKILLS_STATUS: '19' });
  const adapter = pathToFileURL(join(ROOT, 'dist', 'adapter', 'skills', 'cli.js')).href;
  const launcher = writeFile(join(target.target.root, 'launch.mjs'), `import { createSkillManager } from ${JSON.stringify(adapter)};\nprocess.exitCode = await createSkillManager(process.cwd(), process.env, ${JSON.stringify(target.executable)})('install', {});\n`);
  const result = spawnSync(process.execPath, [launcher], { cwd: target.target.cwd, env: target.env, encoding: 'utf8' });
  assert.equal(result.status, 19, result.stderr);
  assert.equal(result.stdout, 'upstream stdout\n');
  assert.equal(result.stderr, 'upstream stderr\n');
});

test('skill help lists both commands and their supported upstream options', () => {
  const target = fixture();
  const skill = createProgram(target.services).commands.find(command => command.name() === 'skill');
  assert.ok(skill !== undefined);
  assert.match(skill.helpInformation(), /install/);
  assert.match(skill.helpInformation(), /update/);
  const [install, update] = skill.commands;
  assert.ok(install !== undefined);
  assert.ok(update !== undefined);
  for (const command of [install, update]) {
    assert.match(command.helpInformation(), /--global/);
    assert.match(command.helpInformation(), /--agent/);
    assert.match(command.helpInformation(), /--copy/);
  }
  assert.match(install.helpInformation(), /--yes/);
  assert.doesNotMatch(update.helpInformation(), /--yes/);
});

test('skill commands reject extra sources and options that could select other skills', async () => {
  for (const args of [
    ['skill', 'install', 'another-source'],
    ['skill', 'install', '--skill', 'another-skill'],
    ['skill', 'update', '--all'],
    ['skill', 'update', '--global', '--project'],
  ]) {
    const target = fixture();
    assert.equal(await runProgram(args, target.services), 2, args.join(' '));
  }
});
