import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  entries,
  runCli,
  startDecisionFixture,
  startSchedulingFixture,
  writeFile,
  yamlRule,
  type CliPresentationOptions,
  type CliResult,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
  type SchedulingFixture,
} from '../tests/support.ts';

const MODEL = 'testmodel';
const THRESHOLD = 0.5;

const HUMAN: CliPresentationOptions = { json: false };

const SENTINEL_KEY = 'sentinel-key-2f4c0a-must-not-be-logged';
const SENTINEL_SOURCE = 'sentinel-source-7b1d3e-must-not-be-logged';
const SENTINEL_POLICY = 'sentinel-policy-5a8f20-must-not-be-logged';
const SENTINEL_EXAMPLE = 'sentinel-example-9c6b41-must-not-be-logged';
const SENTINEL_RESPONSE = 'sentinel-response-3e5d77-must-not-be-logged';

const FAILURE_STATUS = 500;

interface RejectingBackend {
  readonly baseUrl: string;
  readonly authorizations: readonly string[];
  close(): Promise<void>;
}

async function startRejectingBackend(): Promise<RejectingBackend> {
  const authorizations: string[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<RejectingBackend>();
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? '');
    request.on('end', () => {
      response.writeHead(FAILURE_STATUS, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: SENTINEL_RESPONSE }));
    });
    request.resume();
  });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('the rejecting fixture did not bind a loopback port'));
      return;
    }
    resolve({
      baseUrl: `http://127.0.0.1:${address.port}`,
      authorizations,
      close(): Promise<void> {
        const stopped = Promise.withResolvers<void>();
        server.close(error => {
          if (error === undefined) stopped.resolve();
          else stopped.reject(error);
        });
        server.closeAllConnections();
        return stopped.promise;
      },
    });
  });
  return promise;
}

let backend!: DecisionFixture;
let scheduler!: SchedulingFixture;
let rejecting!: RejectingBackend;
let plain!: SandboxRoot;
let held!: SandboxRoot;
let bare!: SandboxRoot;

before(async () => {
  backend = await startDecisionFixture();
  scheduler = await startSchedulingFixture();
  rejecting = await startRejectingBackend();
  plain = createSandbox('rulekeeper-diagnostics-plain-', backend.env);
  held = createSandbox('rulekeeper-diagnostics-held-', scheduler.env);
  bare = createSandbox('rulekeeper-diagnostics-bare-');
});

after(async () => {
  plain.cleanup();
  held.cleanup();
  bare.cleanup();
  await backend.close();
  await scheduler.close();
  await rejecting.close();
});

function writeSources(project: Sandbox, keys: readonly string[]): void {
  for (const key of keys) writeFile(join(project.cwd, key), `service:\n  name: ${key.replaceAll('/', '-')}\n`);
}

interface RuleSet {
  readonly names: readonly string[];
  readonly keysByRule: readonly (readonly string[])[];
}

function writeRuleSet(project: Sandbox, directories: readonly string[], sourcesPerRule: number): RuleSet {
  const keysByRule = directories.map(directory =>
    Array.from({ length: sourcesPerRule }, (_, index) => `${directory}/f${index}.yaml`),
  );
  for (const [index, directory] of directories.entries()) {
    writeFile(
      join(project.rules, `${directory}.yaml`),
      yamlRule(`${directory} review`, `Review the ${directory} sources.`, { included: [`${directory}/**/*.yaml`] }),
    );
    writeSources(project, keysByRule[index]!);
  }
  return { names: directories.map(directory => `${directory} review`), keysByRule };
}

function answerPerKey(keys: readonly string[]): Map<string, number> {
  return new Map(keys.map((key, index) => [key, (index + 1) / (keys.length + 1)]));
}

function setAnswers(fixture: SchedulingFixture, probabilities: ReadonlyMap<string, number>): void {
  fixture.answer = (request) => {
    const probability = probabilities.get(request.key);
    if (probability === undefined) throw new Error(`${request.key} was not expected to be decided`);
    return { probability };
  };
}

function expectedScopeDecisions(keys: readonly string[], probabilities: ReadonlyMap<string, number>): unknown[] {
  return keys.map((key) => {
    const probability = probabilities.get(key)!;
    return { filepath: key, scopeId: '0:', follows: probability > THRESHOLD, probability, model: MODEL };
  });
}

async function drainDecisions(fixture: SchedulingFixture, total: number, wave: number): Promise<void> {
  while (fixture.requests.length < total) {
    fixture.releaseAll();
    await fixture.waitForRequests(Math.min(fixture.requests.length + wave, total));
  }
  fixture.releaseAll();
}

function diagnosticLines(result: CliResult, level: 'debug' | 'verbose'): string[] {
  const marker = `[${level}] `;
  return result.stderr.split('\n').filter(line => line.startsWith(marker));
}

function emits(result: CliResult, level: 'debug' | 'verbose', event: string): boolean {
  const prefix = `[${level}] ${event}`;
  return result.stderr.split('\n').some(line => line === prefix || line.startsWith(`${prefix} `));
}

function strayStderrLines(result: CliResult): string[] {
  return result.stderr
    .split('\n')
    .filter(line => line !== '' && !line.startsWith('[debug] ') && !line.startsWith('[verbose] '));
}

function assertNoAnsi(result: CliResult, label: string): void {
  assert.doesNotMatch(result.stdout, /\u001b/, `${label}: stdout must stay free of terminal control`);
  assert.doesNotMatch(result.stderr, /\u001b/, `${label}: stderr must stay free of terminal control`);
}

test('check serializes every decision under --debug even when --concurrency asks for more', async () => {
  const project = held.isolated('debug-serial');
  const { names, keysByRule } = writeRuleSet(project, ['alpha', 'beta'], 4);
  const keys = keysByRule.flat();
  const probabilities = answerPerKey(keys);
  const args = ['check', '.', '--rules', project.rules, '--concurrency', '8', '--threshold', String(THRESHOLD)];

  scheduler.reset();
  scheduler.limit = 8;
  setAnswers(scheduler, probabilities);
  const parallel = runCli(args, project);
  try {
    await drainDecisions(scheduler, keys.length, 8);
    const result = await parallel;
    assert.strictEqual(scheduler.peak, 8, '--concurrency 8 without diagnostics must decide eight scopes at once');
    assert.strictEqual(scheduler.violations, 0, '--concurrency 8 must never exceed the limit it was given');
    const list = entries(result, 'undecorated run');
    assert.deepStrictEqual(list.map(entry => entry.name), names);
    for (const [index, entry] of list.entries()) {
      assert.deepStrictEqual(entry.decisions, expectedScopeDecisions(keysByRule[index]!, probabilities));
    }
    assert.deepStrictEqual(diagnosticLines(result, 'debug'), [], 'a run without diagnostics must keep stderr quiet');
    assert.deepStrictEqual(diagnosticLines(result, 'verbose'), [], 'a run without diagnostics must keep stderr quiet');
  } finally {
    scheduler.releaseAll();
  }

  scheduler.reset();
  scheduler.limit = 1;
  setAnswers(scheduler, probabilities);
  const serial = runCli([...args, '--debug'], project);
  try {
    await drainDecisions(scheduler, keys.length, 1);
    const result = await serial;
    assert.strictEqual(scheduler.peak, 1, '--debug must decide one scope at a time whatever --concurrency asked');
    assert.strictEqual(scheduler.violations, 0, '--debug must never keep two decisions in flight');
    assert.strictEqual(scheduler.requests.length, keys.length, 'every source of every rule must still be decided once');
    assert.ok(diagnosticLines(result, 'debug').length > 0, '--debug must report phases on stderr');
    assert.deepStrictEqual(
      diagnosticLines(result, 'verbose'),
      [],
      '--debug alone must not print the finer detail',
    );
    const list = entries(result, 'debug run');
    assert.deepStrictEqual(list.map(entry => entry.name), names);
    for (const [index, entry] of list.entries()) {
      assert.deepStrictEqual(entry.decisions, expectedScopeDecisions(keysByRule[index]!, probabilities));
    }
  } finally {
    scheduler.releaseAll();
  }
});

test('check keeps its configured parallelism under --verbose', async () => {
  scheduler.reset();
  scheduler.limit = 4;
  const project = held.isolated('verbose-parallel');
  const { names, keysByRule } = writeRuleSet(project, ['alpha', 'beta'], 4);
  const keys = keysByRule.flat();
  const probabilities = answerPerKey(keys);
  setAnswers(scheduler, probabilities);

  const run = runCli(['check', '.', '--rules', project.rules, '--concurrency', '4', '--verbose', '--threshold', String(THRESHOLD)], project);
  try {
    await drainDecisions(scheduler, keys.length, 4);
    const result = await run;
    assert.strictEqual(scheduler.peak, 4, '--verbose must not serialize a run that asked for four at once');
    assert.strictEqual(scheduler.violations, 0, '--verbose must keep the configured limit for every wave');
    assert.ok(diagnosticLines(result, 'debug').length > 0, '--verbose must keep the phase detail on stderr');
    assert.ok(diagnosticLines(result, 'verbose').length > 0, '--verbose must print the finer detail on stderr');
    assert.deepStrictEqual(strayStderrLines(result), [], 'stderr must carry diagnostics only');
    const list = entries(result, 'verbose run');
    assert.deepStrictEqual(list.map(entry => entry.name), names);
    for (const [index, entry] of list.entries()) {
      assert.deepStrictEqual(entry.decisions, expectedScopeDecisions(keysByRule[index]!, probabilities));
    }
  } finally {
    scheduler.releaseAll();
  }
});

test('check serializes and prints both levels when --debug and --verbose are combined', async () => {
  scheduler.reset();
  scheduler.limit = 1;
  const project = held.isolated('debug-and-verbose');
  const { keysByRule } = writeRuleSet(project, ['alpha', 'beta'], 2);
  const keys = keysByRule.flat();
  const probabilities = answerPerKey(keys);
  setAnswers(scheduler, probabilities);

  const run = runCli(['check', '.', '--rules', project.rules, '--concurrency', '8', '--debug', '--verbose', '--threshold', String(THRESHOLD)], project);
  try {
    await drainDecisions(scheduler, keys.length, 1);
    const result = await run;
    assert.strictEqual(scheduler.peak, 1, '--debug must serialize the run even beside --verbose');
    assert.strictEqual(scheduler.violations, 0, 'the combined run must never exceed one decision at a time');
    assert.ok(diagnosticLines(result, 'debug').length > 0, 'the combined run must report the phases');
    assert.ok(diagnosticLines(result, 'verbose').length > 0, 'the combined run must report the finer detail');
    assert.deepStrictEqual(strayStderrLines(result), [], 'stderr must carry diagnostics only, and no spinner');
    assertNoAnsi(result, 'combined run');
    assert.strictEqual(scheduler.requests.length, keys.length, 'every source of every rule must still be decided once');
    const list = entries(result, 'combined run');
    assert.deepStrictEqual(list.map(entry => entry.name), ['alpha review', 'beta review']);
    for (const [index, entry] of list.entries()) {
      assert.deepStrictEqual(entry.decisions, expectedScopeDecisions(keysByRule[index]!, probabilities));
    }
  } finally {
    scheduler.releaseAll();
  }
});

test('the per-source detail belongs to --verbose alone', async () => {
  backend.reset();
  const project = plain.isolated('detail-separation');
  const rulePath = writeFile(
    join(project.rules, 'detail.yaml'),
    yamlRule('Detail review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');

  const quiet = await runCli(['check', '.', '--rules', rulePath, '--debug'], project);
  entries(quiet, 'debug-only run');
  assert.ok(diagnosticLines(quiet, 'debug').length > 0, '--debug must report the phase detail');
  assert.deepStrictEqual(diagnosticLines(quiet, 'verbose'), [], '--debug alone must not print the finer detail');
  for (const event of ['source.match', 'source.selected', 'source.read', 'source.read.start', 'rules.rule']) {
    assert.ok(!emits(quiet, 'debug', event), `--debug alone must not report ${event}`);
  }

  const detailed = await runCli(['check', '.', '--rules', rulePath, '--verbose'], project);
  entries(detailed, 'verbose run');
  const finer = diagnosticLines(detailed, 'verbose');
  assert.ok(finer.length > 0, '--verbose must print the finer detail on stderr');
  assert.ok(
    finer.some(line => line.includes('src/a.yaml')),
    `the finer detail must name the source it read (stderr: ${JSON.stringify(detailed.stderr)})`,
  );
  assert.ok(diagnosticLines(detailed, 'debug').length > 0, '--verbose must keep the phase detail beside the finer one');
  assert.strictEqual(backend.requests.length, 2, 'both runs must decide their one source');
  assertNoAnsi(quiet, 'debug-only run');
  assertNoAnsi(detailed, 'verbose run');
});

test('--debug keeps the JSON report on stdout parseable and free of diagnostics', async () => {
  backend.reset();
  const project = plain.isolated('json-purity');
  const rulePath = writeFile(
    join(project.rules, 'purity.yaml'),
    yamlRule('Purity review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug', '--verbose'], project);
  const list = entries(result, 'debug json run');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0]!.decisions.length, 1);
  assert.ok(result.stdout.trimEnd().endsWith(']'), 'stdout must stay a single JSON report');
  assert.doesNotMatch(result.stdout, /\[(debug|verbose)\]/, 'diagnostics must never reach stdout');
  assertNoAnsi(result, 'debug json run');
  assert.ok(emits(result, 'debug', 'rules.loaded'), 'the phase detail must still be reported on stderr');
  assert.ok(diagnosticLines(result, 'verbose').length > 0, 'the finer detail must still be reported on stderr');
  assert.strictEqual(backend.requests.length, 1, 'the decorated run must still decide its one source');
});

test('a run that matches nothing logs its phases without a key or a backend', async () => {
  const project = bare.isolated('no-decision');
  assert.ok(
    !('TYPESAFE_API_KEY' in project.env),
    'the no-decision run must have no decision credential available',
  );
  const rulePath = writeFile(
    join(project.rules, 'nothing.yaml'),
    yamlRule('Nothing review', 'Review nothing.', { included: ['nothing/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug'], project);
  const list = entries(result, 'no decision debug run');
  assert.deepStrictEqual(list[0]!.decisions, [], 'a run that matches nothing must decide nothing');
  assert.ok(emits(result, 'debug', 'rules.loaded'), 'the run must report the phase it reached');
  assert.ok(emits(result, 'debug', 'sources.discovered'), 'the run must report the sources it looked for');
  assert.match(
    result.stderr,
    /\[debug\] sources\.(match|collected) \S*[^\n]*contexts=0/,
    `the empty result must be reported as a phase (stderr: ${JSON.stringify(result.stderr)})`,
  );
  assert.ok(!emits(result, 'debug', 'decision.start'), 'nothing may be decided');
  assert.ok(!emits(result, 'debug', 'decision.backend'), 'no backend may be built when nothing is decided');
  assert.deepStrictEqual(diagnosticLines(result, 'verbose'), [], '--debug alone must not print the finer detail');
  assert.deepStrictEqual(strayStderrLines(result), [], 'stderr must carry diagnostics only');
});

test('a run that matches nothing makes no HTTP attempt', async () => {
  scheduler.reset();
  const project = held.isolated('no-decision-http');
  const rulePath = writeFile(
    join(project.rules, 'nothing.yaml'),
    yamlRule('Nothing review', 'Review nothing.', { included: ['nothing/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug', '--verbose'], project);
  entries(result, 'no decision http run');
  assert.strictEqual(scheduler.requests.length, 0, 'no decision may reach the configured backend');
  assert.ok(emits(result, 'debug', 'rules.loaded'), 'the run must still report its phases');
  assert.ok(!emits(result, 'verbose', 'http.request'), 'no request may be reported either');
  assert.ok(!emits(result, 'debug', 'decision.backend'), 'no backend may be built when nothing is decided');
});

test('diagnostics never print the credential, the policy, the examples or the source', async () => {
  backend.reset();
  const project = plain.isolated('redaction');
  const rulePath = writeFile(
    join(project.rules, 'sentinel.yaml'),
    [
      "version: 'v1'",
      "name: 'Sentinel review'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$'",
      'examples:',
      '  good:',
      `    - '${SENTINEL_EXAMPLE}'`,
      `rule: 'Follow ${SENTINEL_POLICY}.'`,
      '',
    ].join('\n'),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), `service:\n  name: api\n  token: ${SENTINEL_SOURCE}\n`);

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug', '--verbose'], project, {
    TYPESAFE_API_KEY: SENTINEL_KEY,
  });
  entries(result, 'redaction run');
  assert.strictEqual(backend.requests.length, 1, 'the run must decide its one source');
  const request = backend.requests[0]!;
  assert.strictEqual(request.authorization, `Bearer ${SENTINEL_KEY}`, 'the sentinel key must be the credential presented');
  const sent = JSON.stringify(request.body);
  for (const sentinel of [SENTINEL_SOURCE, SENTINEL_POLICY, SENTINEL_EXAMPLE]) {
    assert.ok(sent.includes(sentinel), `${sentinel} must reach the backend, so hiding it means something`);
  }
  for (const sentinel of [SENTINEL_KEY, SENTINEL_SOURCE, SENTINEL_POLICY, SENTINEL_EXAMPLE]) {
    assert.ok(
      !result.stderr.includes(sentinel),
      `the diagnostics must not print ${sentinel} (stderr: ${JSON.stringify(result.stderr)})`,
    );
  }
  assert.doesNotMatch(result.stderr, /authorization|bearer/i, 'the diagnostics must not name the credential header');
  assertNoAnsi(result, 'redaction run');
  assert.ok(result.stderr.includes(new URL(backend.baseUrl).host), 'the diagnostics must name the backend host');
  assert.ok(result.stderr.includes('/v1/systemone'), 'the diagnostics must name the request path as well as its host');
  assert.match(result.stderr, /\[debug\] http\.response [^\n]*status=200/, 'the diagnostics must report the safe status');
});

test('a failing response reports its status and host without echoing the body or the credential', async () => {
  const project = plain.isolated('failing-response');
  const rulePath = writeFile(
    join(project.rules, 'failing.yaml'),
    yamlRule('Failing review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug', '--verbose'], project, {
    TYPESAFE_BASE_URL: rejecting.baseUrl,
    TYPESAFE_API_KEY: SENTINEL_KEY,
  });
  assertFailed(result, 'failing response');
  assert.strictEqual(rejecting.authorizations.length, 1, 'the run must attempt the decision exactly once');
  assert.strictEqual(rejecting.authorizations[0], `Bearer ${SENTINEL_KEY}`, 'the attempt must carry the sentinel key');
  assert.ok(result.stderr.includes(new URL(rejecting.baseUrl).host), 'the diagnostics must name the backend host');
  assert.ok(result.stderr.includes(String(FAILURE_STATUS)), 'the diagnostics must report the failing status');
  assert.ok(emits(result, 'debug', 'http.failure'), 'the diagnostics must name the failed request');
  assert.ok(
    !result.stderr.includes(SENTINEL_RESPONSE),
    `the diagnostics must not echo the failing body (stderr: ${JSON.stringify(result.stderr)})`,
  );
  assert.ok(
    !result.stderr.includes(SENTINEL_KEY),
    `the diagnostics must not echo the credential (stderr: ${JSON.stringify(result.stderr)})`,
  );
  assert.doesNotMatch(result.stderr, /authorization|bearer/i, 'the diagnostics must not name the credential header');
  assert.doesNotMatch(result.stderr, /\n\s+at [^\n]*:\d+:\d+/, 'the diagnostics must not carry a stack');
  assertNoAnsi(result, 'failing response');
});

test('--debug still rejects an unusable --concurrency before deciding anything', async () => {
  backend.reset();
  const project = plain.isolated('debug-invalid-limit');
  const rulePath = writeFile(
    join(project.rules, 'valid.yaml'),
    yamlRule('Valid review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug', '--concurrency', '0'], project);
  assertFailed(result, '--debug with an unusable limit');
  assert.match(result.stderr, /--concurrency/, 'the message must name the option');
  assert.strictEqual(backend.requests.length, 0, 'an unusable limit must fail before any request');
});

test('an interactive human run prints diagnostics instead of a spinner', async () => {
  backend.reset();
  const project = plain.isolated('tty-diagnostics');
  const rulePath = writeFile(
    join(project.rules, 'tty.yaml'),
    yamlRule('Tty review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');
  const preload = `--import=data:text/javascript,${encodeURIComponent('process.stderr.isTTY=true;process.stderr.columns=40;')}`;
  const inherited = project.env.NODE_OPTIONS;
  const overrides: NodeJS.ProcessEnv = {
    NODE_OPTIONS: inherited === undefined || inherited === '' ? preload : `${inherited} ${preload}`,
    TERM: 'xterm-256color',
    CI: undefined,
    FORCE_COLOR: '0',
  };

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug', '--verbose'], project, overrides, HUMAN);
  assert.strictEqual(result.status, 0, `tty diagnostics: expected success (stderr: ${result.stderr})`);
  assert.strictEqual(backend.requests.length, 1, 'the interactive run must still decide its source');
  assert.ok(diagnosticLines(result, 'debug').length > 0, 'the interactive run must report its phases');
  assert.ok(diagnosticLines(result, 'verbose').length > 0, 'the interactive run must report the finer detail');
  assert.deepStrictEqual(
    strayStderrLines(result),
    [],
    'diagnostic mode must replace the spinner, never join it',
  );
  assertNoAnsi(result, 'tty diagnostics');
  assert.notStrictEqual(result.stdout.trim(), '', 'the human summary must still print on stdout');
});

test('a rules directory holding no rule reports the empty discovery before failing', async () => {
  const project = bare.isolated('no-rules-explicit');
  const directory = join(project.cwd, 'no-rules');
  writeFile(join(directory, 'notes.txt'), 'not a rule\n');

  const result = await runCli(['check', '.', '--rules', directory, '--debug'], project);
  assertFailed(result, 'an explicit rules directory holding no rule');

  const lines = diagnosticLines(result, 'debug');
  const discovered = lines.filter(line => line.startsWith('[debug] rules.discovered '));
  assert.strictEqual(discovered.length, 1, `one discovery report expected (stderr: ${result.stderr})`);
  assert.match(discovered[0]!, /^\[debug\] rules\.discovered source="explicit" files=0 ms=\d+$/);
  assert.deepStrictEqual(
    lines.filter(line => line.startsWith('[debug] run.failed ')),
    ['[debug] run.failed phase="rules" reason="Error"'],
    'the empty discovery must fail in the rules phase',
  );
  assert.ok(
    lines.indexOf(discovered[0]!) < lines.indexOf('[debug] run.failed phase="rules" reason="Error"'),
    `the discovery report must precede the failure (stderr: ${result.stderr})`,
  );
  assert.ok(!emits(result, 'debug', 'rules.loaded'), 'a run without a rule must not report a load');
  assert.ok(result.stderr.includes(directory), `the failure must name ${directory}: ${result.stderr}`);
});

test('a project and home root holding no rule report the empty discovery before failing', async () => {
  const project = bare.isolated('no-rules-roots');

  const result = await runCli(['check', '.', '--debug'], project, {}, HUMAN);
  assertFailed(result, 'a project and home root holding no rule');

  const lines = diagnosticLines(result, 'debug');
  const discovered = lines.filter(line => line.startsWith('[debug] rules.discovered '));
  assert.strictEqual(discovered.length, 1, `one discovery report expected (stderr: ${result.stderr})`);
  assert.match(discovered[0]!, /^\[debug\] rules\.discovered source="discovery" files=0 ms=\d+$/);
  const failures = lines.filter(line => line.startsWith('[debug] run.failed '));
  assert.deepStrictEqual(failures, ['[debug] run.failed phase="rules" reason="Error"']);
  assert.ok(
    lines.indexOf(discovered[0]!) < lines.indexOf(failures[0]!),
    `the discovery report must precede the failure (stderr: ${result.stderr})`,
  );
  assert.ok(!emits(result, 'debug', 'rules.loaded'), 'a run without a rule must not report a load');
  const stray = strayStderrLines(result);
  assert.strictEqual(stray.length, 1, `the failure must stand alone (stderr: ${result.stderr})`);
  const roots = [join(project.cwd, '.rulekeeper'), join(project.home, '.rulekeeper')];
  assert.ok(
    roots.every(root => stray[0]!.includes(root)),
    `the failure must name both searched roots ${roots.join(' and ')}: ${stray[0]}`,
  );
});
