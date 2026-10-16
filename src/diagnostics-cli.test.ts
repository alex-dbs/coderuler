import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  assertFailed,
  createSandbox,
  entries,
  isMapping,
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

const FIXTURE_PROBABILITY = 0.9;

const HANDLER_STEPS = 18;

const HANDLER = [
  'async function handle(request) {',
  '  let value = request.url;',
  ...Array.from({ length: HANDLER_STEPS }, (_, index) => `  value = await step${index + 1}(value);`),
  '  return value;',
  '}',
].join('\n');

const HANDLER_RULE = [
  "version: 'v1'",
  'files:',
  '  included:',
  "    - '**/*.js'",
  'scope:',
  '  format: ast-grep',
  '  language: javascript',
  '  rule:',
  '    kind: function_declaration',
  'check:',
  "  rule: 'Every handler must await the work it starts.'",
  '',
].join('\n');

const FIXTURE_DECISION = {
  model: MODEL,
  answers: { follows_instructions: { type: 'noul', noul: FIXTURE_PROBABILITY } },
  usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
};

interface FlexibleBackend {
  readonly baseUrl: string;
  readonly requests: readonly { readonly authorization: string | undefined; readonly body: unknown }[];
  answer: { status: number; body: string };
  reset(): void;
  close(): Promise<void>;
}

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

async function startFlexibleBackend(): Promise<FlexibleBackend> {
  const requests: { authorization: string | undefined; body: unknown }[] = [];
  let answer = { status: 200, body: '{}' };
  const { promise, resolve, reject } = Promise.withResolvers<FlexibleBackend>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ authorization: request.headers.authorization, body });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('the flexible fixture did not bind a loopback port'));
      return;
    }
    resolve({
      baseUrl: `http://127.0.0.1:${address.port}`,
      requests,
      get answer(): { status: number; body: string } {
        return answer;
      },
      set answer(value: { status: number; body: string }) {
        answer = value;
      },
      reset(): void {
        requests.length = 0;
        answer = { status: 200, body: '{}' };
      },
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
let flexible!: FlexibleBackend;
let plain!: SandboxRoot;
let held!: SandboxRoot;
let bare!: SandboxRoot;

before(async () => {
  backend = await startDecisionFixture();
  scheduler = await startSchedulingFixture();
  rejecting = await startRejectingBackend();
  flexible = await startFlexibleBackend();
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
  await flexible.close();
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
      yamlRule(`Review the ${directory} sources.`, { included: [`${directory}/**/*.yaml`] }),
    );
    writeSources(project, keysByRule[index]!);
  }
  return { names: directories, keysByRule };
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

function linesFor(result: CliResult, level: 'debug' | 'verbose', event: string): string[] {
  const prefix = `[${level}] ${event}`;
  return result.stderr.split('\n').filter(line => line === prefix || line.startsWith(`${prefix} `));
}

function emits(result: CliResult, level: 'debug' | 'verbose', event: string): boolean {
  return linesFor(result, level, event).length > 0;
}

function fieldRaw(line: string, key: string): string | undefined {
  const marker = ` ${key}=`;
  const at = line.indexOf(marker);
  if (at === -1) return undefined;
  const rest = line.slice(at + marker.length);
  if (rest.startsWith('"')) {
    let escaped = false;
    for (let index = 1; index < rest.length; index += 1) {
      const character = rest[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') return rest.slice(0, index + 1);
    }
    return undefined;
  }
  const end = rest.search(/[ \t]/);
  return end === -1 ? rest : rest.slice(0, end);
}

function fieldValue(line: string, key: string): unknown {
  const raw = fieldRaw(line, key);
  return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
}

function fieldBody(line: string, event: string, stderr: string): Record<string, unknown> {
  const raw = fieldValue(line, 'body');
  assert.strictEqual(typeof raw, 'string', `${event} must carry a body string (stderr: ${JSON.stringify(stderr)})`);
  const payload: unknown = JSON.parse(raw as string);
  assert.ok(isMapping(payload), `${event} must carry a JSON object body`);
  return payload;
}

function nested(value: unknown, where: string, ...keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    assert.ok(isMapping(current), `${where}: expected an object on the way to ${key}`);
    current = current[key];
  }
  return current;
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
    assert.deepStrictEqual(list.map(entry => entry.name), ['alpha', 'beta']);
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
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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
    yamlRule('Review nothing.', { included: ['nothing/**/*.yaml'] }),
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
    yamlRule('Review nothing.', { included: ['nothing/**/*.yaml'] }),
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
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$'",
      'check:',
      '  examples:',
      '    good:',
      `      - '${SENTINEL_EXAMPLE}'`,
      `  rule: 'Follow ${SENTINEL_POLICY}.'`,
      '',
    ].join('\n'),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), `service:\n  name: api\n  token: ${SENTINEL_SOURCE}\n`);

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug'], project, {
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
  assert.ok(
    !result.stderr.includes('prompt_tokens'),
    `--debug must not carry the response body (stderr: ${JSON.stringify(result.stderr)})`,
  );
  for (const line of diagnosticLines(result, 'debug')) {
    assert.ok(!line.includes(' body='), `--debug must not serialize a body (line: ${line})`);
  }
});

test('a failing response reports its status and host without echoing the body or the credential', async () => {
  const project = plain.isolated('failing-response');
  const rulePath = writeFile(
    join(project.rules, 'failing.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');

  const result = await runCli(['check', '.', '--rules', rulePath, '--debug'], project, {
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

test('--verbose logs the whole outbound decision payload rather than a truncated excerpt', async () => {
  backend.reset();
  const project = plain.isolated('verbose-request-body');
  const rulePath = writeFile(join(project.rules, 'handler.yaml'), HANDLER_RULE);
  writeFile(join(project.cwd, 'src', 'handler.js'), `${HANDLER}\n`);

  const result = await runCli(['check', '.', '--rules', rulePath, '--verbose'], project);
  entries(result, 'verbose request body');
  assert.strictEqual(backend.requests.length, 1, 'the run must decide its one source');
  const sent = backend.requests[0]!;

  const requests = linesFor(result, 'verbose', 'http.request');
  assert.strictEqual(requests.length, 1, `one verbose request expected (stderr: ${JSON.stringify(result.stderr)})`);
  const line = requests[0]!;
  const reported = fieldValue(line, 'body');
  assert.strictEqual(typeof reported, 'string', '--verbose must report the outbound body as a serialized string');
  assert.strictEqual(reported, JSON.stringify(sent.body), 'the logged body must be the payload the endpoint received');

  const payload = fieldBody(line, 'http.request', result.stderr);
  assert.strictEqual(
    nested(payload, 'http.request body', 'state', 'scope', 'source'),
    HANDLER,
    'the whole matched source must travel, not a five-line excerpt of it',
  );
  const serialized = reported as string;
  assert.ok(serialized.includes('step18'), `the full source must be logged (body: ${serialized})`);
  assert.ok(result.stderr.includes('step18'), 'the last line of the source must reach stderr, not an ellipsis');
  assert.ok(!result.stderr.includes('[REDACTED]'), 'nothing but a configured credential may be redacted');
  assert.doesNotMatch(result.stderr, /authorization|bearer/i, 'the diagnostics must not name the credential header');
  assertNoAnsi(result, 'verbose request body');
  assert.ok(result.stdout.trimEnd().endsWith(']'), 'stdout must stay a single JSON report');
  assert.doesNotMatch(result.stdout, /\[(debug|verbose)\]/, 'diagnostics must never reach stdout');
});

test('--verbose logs the body of a successful response beside a body-free debug report', async () => {
  backend.reset();
  const project = plain.isolated('verbose-response-body');
  const rulePath = writeFile(join(project.rules, 'handler.yaml'), HANDLER_RULE);
  writeFile(join(project.cwd, 'src', 'handler.js'), `${HANDLER}\n`);

  const result = await runCli(['check', '.', '--rules', rulePath, '--verbose'], project);
  entries(result, 'verbose response body');
  const responses = linesFor(result, 'verbose', 'http.response.body');
  assert.strictEqual(responses.length, 1, `one verbose response body expected (stderr: ${JSON.stringify(result.stderr)})`);
  const line = responses[0]!;
  assert.strictEqual(fieldValue(line, 'status'), 200, 'the response body must carry its status');
  assert.deepStrictEqual(
    fieldBody(line, 'http.response.body', result.stderr),
    FIXTURE_DECISION,
    'the logged body must be the decision the endpoint returned',
  );

  const requests = linesFor(result, 'verbose', 'http.request');
  assert.strictEqual(requests.length, 1, 'the request must be logged beside its response');
  assert.strictEqual(
    fieldValue(line, 'id'),
    fieldValue(requests[0]!, 'id'),
    'the response body must answer the request it belongs to',
  );

  const debug = linesFor(result, 'debug', 'http.response');
  assert.strictEqual(debug.length, 1, `one debug response expected (stderr: ${JSON.stringify(result.stderr)})`);
  assert.ok(!debug[0]!.includes(' body='), 'the debug response must stay free of the body');
  assert.ok(!debug[0]!.includes('prompt_tokens'), 'the debug response must not echo the returned payload');
  assert.doesNotMatch(result.stderr, /authorization|bearer/i, 'the diagnostics must not name the credential header');
  assertNoAnsi(result, 'verbose response body');
});

test('--verbose logs a failing response body and its status without touching stdout', async () => {
  flexible.reset();
  const project = plain.isolated('verbose-failing-body');
  const rulePath = writeFile(
    join(project.rules, 'failing.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');
  flexible.answer = { status: FAILURE_STATUS, body: JSON.stringify({ error: SENTINEL_RESPONSE }) };

  const result = await runCli(['check', '.', '--rules', rulePath, '--verbose'], project, {
    TYPESAFE_BASE_URL: flexible.baseUrl,
    TYPESAFE_API_KEY: SENTINEL_KEY,
  });
  assertFailed(result, 'verbose failing response');
  assert.strictEqual(flexible.requests.length, 1, 'the run must attempt the decision exactly once');
  assert.strictEqual(flexible.requests[0]!.authorization, `Bearer ${SENTINEL_KEY}`, 'the attempt must carry the sentinel key');
  assert.strictEqual(linesFor(result, 'verbose', 'http.request').length, 1, 'the request must be logged even though it failed');

  const responses = linesFor(result, 'verbose', 'http.response.body');
  assert.strictEqual(responses.length, 1, `the failing body must be reported (stderr: ${JSON.stringify(result.stderr)})`);
  assert.strictEqual(fieldValue(responses[0]!, 'status'), FAILURE_STATUS, 'the failing body must carry its status');
  assert.deepStrictEqual(
    fieldBody(responses[0]!, 'http.response.body', result.stderr),
    { error: SENTINEL_RESPONSE },
    '--verbose must expose the body of a failing response',
  );

  const failure = linesFor(result, 'debug', 'http.failure');
  assert.strictEqual(failure.length, 1, `one debug failure expected (stderr: ${JSON.stringify(result.stderr)})`);
  assert.ok(!failure[0]!.includes(SENTINEL_RESPONSE), 'the debug failure must stay free of the body');
  assert.ok(!failure[0]!.includes(' body='), 'the debug failure must stay free of the body');
  assert.ok(!result.stderr.includes(SENTINEL_KEY), 'the diagnostics must never print the credential');
  assert.doesNotMatch(result.stderr, /authorization|bearer/i, 'the diagnostics must not name the credential header');
  assert.doesNotMatch(result.stderr, /\n\s+at [^\n]*:\d+:\d+/, 'the diagnostics must not carry a stack');
  assertNoAnsi(result, 'verbose failing response');
});

test('--verbose logs a malformed 2xx body before the decision is rejected', async () => {
  flexible.reset();
  const project = plain.isolated('verbose-malformed-body');
  const rulePath = writeFile(
    join(project.rules, 'malformed.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'service:\n  name: api\n');
  flexible.answer = { status: 200, body: JSON.stringify({ model: MODEL }) };

  const result = await runCli(['check', '.', '--rules', rulePath, '--verbose'], project, {
    TYPESAFE_BASE_URL: flexible.baseUrl,
    TYPESAFE_API_KEY: SENTINEL_KEY,
  });
  assertFailed(result, 'verbose malformed 2xx body');
  assert.strictEqual(flexible.requests.length, 1, 'the run must attempt the decision exactly once');

  const responses = linesFor(result, 'verbose', 'http.response.body');
  assert.strictEqual(responses.length, 1, `the malformed body must be reported (stderr: ${JSON.stringify(result.stderr)})`);
  assert.strictEqual(fieldValue(responses[0]!, 'status'), 200, 'the malformed body must carry its status');
  assert.deepStrictEqual(
    fieldBody(responses[0]!, 'http.response.body', result.stderr),
    { model: MODEL },
    'the malformed body must be logged before it is rejected',
  );

  assert.ok(emits(result, 'debug', 'http.response.invalid'), 'the rejected response must still be reported');
  const invalid = linesFor(result, 'debug', 'http.response.invalid')[0]!;
  assert.ok(!invalid.includes(' body='), 'the debug rejection must stay free of the body');
  assert.ok(!result.stderr.includes(SENTINEL_KEY), 'the diagnostics must never print the credential');
  assertNoAnsi(result, 'verbose malformed 2xx body');
});

test('--verbose redacts the configured key wherever the payload or the response echoes it', async () => {
  flexible.reset();
  const project = plain.isolated('verbose-redaction');
  const rulePath = writeFile(
    join(project.rules, 'token.yaml'),
    [
      "version: 'v1'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$'",
      'check:',
      "  rule: 'Review the configured service.'",
      '',
    ].join('\n'),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), `service:\n  name: api\n  token: ${SENTINEL_KEY}\n`);
  flexible.answer = { status: 200, body: JSON.stringify({ ...FIXTURE_DECISION, echo: SENTINEL_KEY }) };

  const result = await runCli(['check', '.', '--rules', rulePath, '--verbose'], project, {
    TYPESAFE_BASE_URL: flexible.baseUrl,
    TYPESAFE_API_KEY: SENTINEL_KEY,
  });
  entries(result, 'verbose redaction');
  assert.strictEqual(flexible.requests.length, 1, 'the run must decide its one source');
  assert.strictEqual(flexible.requests[0]!.authorization, `Bearer ${SENTINEL_KEY}`, 'the attempt must carry the sentinel key');
  assert.ok(
    JSON.stringify(flexible.requests[0]!.body).includes(SENTINEL_KEY),
    'the key must reach the endpoint, so hiding it means something',
  );
  assert.ok(
    result.stderr.includes('[REDACTED]'),
    `the credential must be replaced (stderr: ${JSON.stringify(result.stderr)})`,
  );
  assert.ok(
    !result.stderr.includes(SENTINEL_KEY),
    `the diagnostics must never print the credential (stderr: ${JSON.stringify(result.stderr)})`,
  );
  assert.doesNotMatch(result.stderr, /authorization|bearer/i, 'the diagnostics must not name the credential header');

  const request = fieldBody(linesFor(result, 'verbose', 'http.request')[0]!, 'http.request', result.stderr);
  assert.strictEqual(
    nested(request, 'http.request body', 'state', 'scope', 'data', 'service', 'token'),
    '[REDACTED]',
    'the credential the rule carried must be redacted in the logged request body',
  );
  const response = fieldBody(linesFor(result, 'verbose', 'http.response.body')[0]!, 'http.response.body', result.stderr);
  assert.strictEqual(response.echo, '[REDACTED]', 'the credential the response echoed must be redacted too');
  assert.deepStrictEqual(
    nested(response, 'http.response.body', 'answers', 'follows_instructions'),
    { type: 'noul', noul: FIXTURE_PROBABILITY },
    'redaction must leave the decision itself intact',
  );
  assertNoAnsi(result, 'verbose redaction');
});

test('--verbose correlates every logged response body with the request id it answers', async () => {
  scheduler.reset();
  scheduler.limit = 3;
  const project = held.isolated('verbose-correlation');
  const { keysByRule } = writeRuleSet(project, ['alpha'], 3);
  const keys = keysByRule.flat();
  const probabilities = answerPerKey(keys);
  setAnswers(scheduler, probabilities);

  const run = runCli(
    ['check', '.', '--rules', project.rules, '--verbose', '--concurrency', '3', '--threshold', String(THRESHOLD)],
    project,
  );
  try {
    await drainDecisions(scheduler, keys.length, 3);
    const result = await run;
    assert.strictEqual(scheduler.peak, 3, '--verbose must keep the configured parallelism');
    assert.strictEqual(scheduler.violations, 0, '--verbose must keep the configured limit for every wave');

    const requests = linesFor(result, 'verbose', 'http.request');
    const responses = linesFor(result, 'verbose', 'http.response.body');
    assert.strictEqual(requests.length, keys.length, 'every decision must log its request body');
    assert.strictEqual(responses.length, keys.length, 'every decision must log its response body');

    const filepaths = requests.map(line => {
      const body = fieldBody(line, 'http.request', result.stderr);
      return String(nested(body, 'http.request body', 'state', 'filepath'));
    });
    assert.deepStrictEqual([...filepaths].sort(), [...keys].sort(), 'the logged request bodies must cover every decided source');
    assert.strictEqual(new Set(requests.map(line => fieldValue(line, 'id'))).size, keys.length, 'each request must take its own id');

    for (const line of responses) {
      const id = fieldValue(line, 'id');
      const answered = requests.filter(request => fieldValue(request, 'id') === id);
      assert.strictEqual(answered.length, 1, `a response body must answer exactly one logged request (id ${String(id)})`);
      const asked = fieldBody(answered[0]!, 'http.request', result.stderr);
      const key = String(nested(asked, 'http.request body', 'state', 'filepath'));
      assert.strictEqual(fieldValue(line, 'status'), 200, `id ${String(id)} must report its status`);
      assert.strictEqual(
        nested(fieldBody(line, 'http.response.body', result.stderr), 'http.response.body', 'answers', 'follows_instructions', 'noul'),
        probabilities.get(key),
        `id ${String(id)} must carry the answer for ${key}`,
      );
    }
    assert.ok(result.stdout.trimEnd().endsWith(']'), 'stdout must stay a single JSON report');
    assert.doesNotMatch(result.stdout, /\[(debug|verbose)\]/, 'diagnostics must never reach stdout');
  } finally {
    scheduler.releaseAll();
  }
});

test('--debug still rejects an unusable --concurrency before deciding anything', async () => {
  backend.reset();
  const project = plain.isolated('debug-invalid-limit');
  const rulePath = writeFile(
    join(project.rules, 'valid.yaml'),
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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
    yamlRule('Review every source.', { included: ['**/*.yaml'] }),
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
