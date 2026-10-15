import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { isMapping } from '../tests/support.ts';
import { JevAdapter } from './adapter/decision/jev.ts';
import type { DecisionState } from './app/decision/port.ts';
import { DecisionService, type DecisionInput } from './app/decision/service.ts';
import type { DiagnosticFields, Diagnostics } from './app/ports/diagnostics.ts';
import type { Context, RuleExamples } from './app/rule/types.ts';
import { createDecisionService } from './infra/decision.ts';

const API_KEY = 'loopback-key';
const RULE = 'Every handler must return a promise.';
const EXAMPLES: RuleExamples = { good: ['async function save(): Promise<void> {}'], bad: ['function save(): void {}'] };
const FILEPATH = 'src/save.ts';
const DIFF = '@@ -1 +1 @@\n-function save(): void {}\n+async function save(): Promise<void> {}';
const SOURCE = 'async function save(): Promise<void> {}';
const CONTEXT: Context = { filepath: FILEPATH, diff: DIFF, scope: { id: '0:', source: SOURCE } };
const INPUT: DecisionInput = { context: CONTEXT, rule: RULE, examples: EXAMPLES };
const PROJECTED: DecisionState = { filepath: FILEPATH, diff: DIFF, scope: { id: '0:', source: SOURCE } };

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface Loopback {
  readonly origin: string;
  readonly baseUrl: string;
  readonly sent: Sent[];
  answer: Reply;
  reset(): void;
  close(): Promise<void>;
}

function noulReply(noul: number, model = 'jev-1.13.0'): Reply {
  return jsonReply({ model, answers: { follows_instructions: { type: 'noul', noul } }, usage: { input_tokens: 296, output_tokens: 20 } });
}

function jsonReply(body: unknown, status = 200): Reply {
  return { status, body: JSON.stringify(body) };
}

function answersReply(answers: unknown, model: unknown = 'jev-1.13.0'): Reply {
  return jsonReply({ model, answers });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind a TCP port');
  return address.port;
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error === undefined ? resolve() : reject(error)));
  });
}

async function startLoopback(): Promise<Loopback> {
  const sent: Sent[] = [];
  let backend: Loopback;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // A body that is not JSON stays recorded verbatim.
      }
      sent.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(backend.answer.status ?? 200, { 'content-type': 'application/json', ...(backend.answer.headers ?? {}) });
      response.end(backend.answer.body ?? '');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${boundPort(server)}`;
  backend = {
    origin,
    baseUrl: origin,
    sent,
    answer: noulReply(0.9),
    reset(): void {
      sent.length = 0;
      backend.answer = noulReply(0.9);
    },
    close: (): Promise<void> => stopServer(server),
  };
  return backend;
}

function decisionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('RK_') || name.startsWith('TYPESAFE_')) continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

function serviceFor(backend: Loopback, overrides: NodeJS.ProcessEnv = {}, threshold?: number): DecisionService {
  return createDecisionService(
    decisionEnv({ TYPESAFE_BASE_URL: backend.baseUrl, TYPESAFE_API_KEY: API_KEY, ...overrides }),
    undefined,
    threshold,
  );
}

async function failed(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Error, 'a failed decision must reject with an Error');
    return error;
  }
  throw new Error('expected the decision to fail, but it resolved');
}

function onlySent(backend: Loopback): Sent {
  assert.equal(backend.sent.length, 1, 'exactly one request must have been sent');
  return backend.sent[0]!;
}

function wireBody(backend: Loopback): Record<string, unknown> {
  const body = onlySent(backend).body;
  assert.ok(isMapping(body), 'the request body must be a JSON object');
  return body;
}

function sentState(backend: Loopback): Record<string, unknown> {
  const state = wireBody(backend).state;
  assert.ok(isMapping(state), 'the request must carry an object state');
  return state;
}

function sentQuestion(backend: Loopback): Record<string, unknown> {
  const questions = wireBody(backend).questions;
  assert.ok(isMapping(questions), 'the request must carry a questions map');
  const question = questions.follows_instructions;
  assert.ok(isMapping(question), 'the request must carry a follows_instructions question');
  return question;
}

function sentInstructions(backend: Loopback): Record<string, unknown> {
  const instructions = sentQuestion(backend).instructions;
  assert.ok(isMapping(instructions), 'the question must carry instructions');
  return instructions;
}

let backend!: Loopback;

const savedProxies: Record<string, string> = {};

before(async () => {
  // Axios resolves a proxy from this process's environment when it sends a request, never from the
  // environment handed to the factory, so every proxy variable is cleared for the whole suite: a
  // request this module makes can only ever arrive at the loopback server.
  for (const name of Object.keys(process.env)) {
    if (!name.toLowerCase().endsWith('proxy')) continue;
    savedProxies[name] = process.env[name] ?? '';
    delete process.env[name];
  }
  backend = await startLoopback();
});

after(async () => {
  await backend.close();
  for (const [name, value] of Object.entries(savedProxies)) process.env[name] = value;
});

test('one decision posts the rule, its examples and the projected scope to the configured endpoint', async () => {
  backend.reset();
  const decision = await serviceFor(backend).decide(INPUT);

  const request = onlySent(backend);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/systemone');
  assert.equal(request.authorization, `Bearer ${API_KEY}`);

  const body = wireBody(backend);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(sentState(backend), PROJECTED);
  assert.equal(sentQuestion(backend).type, 'noul');
  const instructions = sentInstructions(backend);
  assert.equal(instructions.rule, RULE);
  assert.deepEqual(instructions.examples, EXAMPLES);
  assert.ok(typeof instructions.question === 'string' && instructions.question.trim() !== '', 'the instructions must phrase a question in words');

  assert.deepEqual(decision, { follows: true, probability: 0.9, model: 'jev-1.13.0' });
});

test('a scope with a structured payload is sent as that payload, without a copy of its matched text', async () => {
  backend.reset();
  const captures = { name: 'save', params: ['first', 'last'] };
  const context: Context = {
    filepath: FILEPATH,
    scope: { id: '4:9', source: 'async function save(first: string, last: string) {}', data: { kind: 'function', name: 'save', returns: null }, captures },
  };

  await serviceFor(backend).decide({ context, rule: RULE, examples: EXAMPLES });

  const state = sentState(backend);
  assert.deepEqual(state, {
    filepath: FILEPATH,
    scope: { id: '4:9', data: { kind: 'function', name: 'save', returns: null }, captures },
  });
  const scope = state.scope;
  assert.ok(isMapping(scope), 'the state must carry the selected scope');
  assert.ok(!('source' in scope), 'a scope with a payload must not carry its matched text as well');
  assert.ok(!('diff' in state), 'a context without a diff must not send an empty one');
});

test('a payload of null, false, 0 or an empty string is sent as data rather than read as absent', async () => {
  for (const data of [null, false, 0, ''] as const) {
    backend.reset();
    const context: Context = { filepath: FILEPATH, scope: { id: '0:', source: 'return 0;', data } };

    await serviceFor(backend).decide({ context, rule: RULE, examples: EXAMPLES });

    assert.deepEqual(sentState(backend), { filepath: FILEPATH, scope: { id: '0:', data } }, `a payload of ${JSON.stringify(data)}`);
  }
});

test('a scope with no payload falls back to its matched text, keeping its location, diff and captures', async () => {
  backend.reset();
  const context: Context = {
    filepath: 'src/handlers/load.ts',
    diff: DIFF,
    scope: { id: '1:2', source: 'export const load = 1;', captures: { name: 'load' } },
  };

  await serviceFor(backend).decide({ context, rule: RULE, examples: EXAMPLES });

  assert.deepEqual(sentState(backend), {
    filepath: 'src/handlers/load.ts',
    diff: DIFF,
    scope: { id: '1:2', source: 'export const load = 1;', captures: { name: 'load' } },
  });
});

test('a group is sent as one state carrying every file and scope, with no diff anywhere', async () => {
  backend.reset();
  const grouped: DecisionInput = {
    rule: RULE,
    examples: EXAMPLES,
    context: {
      group: { type: 'folder', path: 'src/payments' },
      files: [
        {
          filepath: 'src/payments/save.ts',
          scopes: [
            { id: '0:', source: 'async function save() {}' },
            { id: '3:0', source: 'async function load() {}', data: { kind: 'function', waits: true }, captures: { name: 'load' } },
          ],
        },
        { filepath: 'src/payments/refund.ts', scopes: [{ id: '0:', source: 'function refund() {}', data: null }] },
      ],
    },
  };

  const decision = await serviceFor(backend).decide(grouped);

  assert.deepEqual(sentState(backend), {
    group: { type: 'folder', path: 'src/payments' },
    files: [
      {
        filepath: 'src/payments/save.ts',
        scopes: [{ id: '0:', source: 'async function save() {}' }, { id: '3:0', data: { kind: 'function', waits: true }, captures: { name: 'load' } }],
      },
      { filepath: 'src/payments/refund.ts', scopes: [{ id: '0:', data: null }] },
    ],
  });
  assert.ok(!JSON.stringify(sentState(backend)).includes('diff'), 'a group must not carry per-file review evidence');
  assert.deepEqual(decision, { follows: true, probability: 0.9, model: 'jev-1.13.0' });
});

test('the endpoint path is appended to whatever base path the deployment configures', async () => {
  for (const [basePath, path] of [
    ['', '/v1/systemone'],
    ['/', '/v1/systemone'],
    ['/gateway/decide', '/gateway/decide/v1/systemone'],
    ['/gateway/decide/', '/gateway/decide/v1/systemone'],
  ] as const) {
    backend.reset();
    backend.answer = noulReply(0.2);
    await serviceFor(backend, { TYPESAFE_BASE_URL: `${backend.origin}${basePath}` }).decide(INPUT);
    assert.equal(onlySent(backend).path, path);
  }
});

test('a probability of exactly 0.4 is not a following decision, and the answer is preserved', async () => {
  for (const [noul, follows] of [
    [0, false],
    [0.3999999, false],
    [0.4, false],
    [0.4000001, true],
    [0.9, true],
    [1, true],
  ] as const) {
    backend.reset();
    backend.answer = noulReply(noul);
    const decision = await serviceFor(backend).decide(INPUT);
    assert.deepEqual(decision, { follows, probability: noul, model: 'jev-1.13.0' }, `a noul of ${noul}`);
  }
});

test('a malformed answer is rejected instead of read as a decision', async () => {
  const answers = (value: unknown): unknown => ({ follows_instructions: { type: 'noul', noul: value } });
  const cases: readonly (readonly [string, Reply])[] = [
    ['a body that is not JSON', { body: 'the sky is blue' }],
    ['a JSON body that is not an object', { body: '42' }],
    ['an empty object', jsonReply({})],
    ['a model that is not a string', answersReply(answers(1), 7)],
    ['a blank model', answersReply(answers(1), '  ')],
    ['no answers map', jsonReply({ model: 'jev-1.13.0' })],
    ['an answers map that is an array', answersReply([])],
    ['the question answered under another id', answersReply({ follows: { type: 'noul', noul: 1 } })],
    ['an answer that is not an object', answersReply({ follows_instructions: 'yes' })],
    ['another answer type', answersReply({ follows_instructions: { type: 'choice', noul: 1 } })],
    ['a noul that is a string', answersReply(answers('1'))],
    ['a noul that is null', answersReply(answers(null))],
    ['a noul below zero', answersReply(answers(-0.1))],
    ['a noul above one', answersReply(answers(1.1))],
    ['a noul that is not finite', { body: '{"model":"jev-1.13.0","answers":{"follows_instructions":{"type":"noul","noul":1e400}}}' }],
  ];

  for (const [label, reply] of cases) {
    backend.reset();
    backend.answer = reply;
    const error = await failed(() => serviceFor(backend).decide(INPUT));
    assert.ok(error.message.trim() !== '', `${label}: the failure must say something`);
    assert.ok(!error.message.includes(API_KEY), `${label}: the failure must not carry the key`);
    assert.ok(!error.message.includes(RULE), `${label}: the failure must not echo the request body`);
  }
});

test('an HTTP failure is reported with its status and without the key', async () => {
  for (const status of [401, 500]) {
    backend.reset();
    backend.answer = jsonReply({ error: `invalid key ${API_KEY}`, received: INPUT }, status);

    const error = await failed(() => serviceFor(backend).decide(INPUT));

    assert.match(error.message, new RegExp(`HTTP ${status}`), `status ${status}`);
    assert.ok(!error.message.includes(API_KEY), 'the failure must not carry the key');
    assert.ok(!error.message.includes('Bearer'), 'the failure must not carry the authorization header');
    assert.ok(!error.message.includes(backend.origin), 'the failure must not carry the endpoint');
  }
});

test('an unreachable endpoint fails as a network error without the key', async () => {
  const temporary = createServer();
  temporary.listen(0, '127.0.0.1');
  await once(temporary, 'listening');
  const origin = `http://127.0.0.1:${boundPort(temporary)}`;
  await stopServer(temporary);

  const error = await failed(() => serviceFor(backend, { TYPESAFE_BASE_URL: origin }).decide(INPUT));

  assert.match(error.message, /ECONNREFUSED/);
  assert.ok(!error.message.includes(API_KEY), 'the failure must not carry the key');
  assert.ok(!error.message.includes(origin), 'the failure must not carry the endpoint');
});

test('a redirect is refused instead of followed', async () => {
  backend.reset();
  backend.answer = { status: 302, headers: { location: `${backend.baseUrl}/elsewhere` }, body: '' };

  const error = await failed(() => serviceFor(backend).decide(INPUT));

  assert.equal(onlySent(backend).path, '/v1/systemone', 'only the configured endpoint is asked');
  assert.ok(!error.message.includes(API_KEY), 'the failure must not carry the key');
});

test('a base URL that cannot reach the endpoint is refused before any request', () => {
  for (const [label, baseUrl] of [
    ['a relative path', 'v1/systemone'],
    ['a scheme that is not HTTP', 'ftp://api.example.com'],
    ['a query string', 'http://127.0.0.1:1?key=secret'],
    ['a bare query delimiter', 'http://127.0.0.1:1?'],
    ['a fragment', 'http://127.0.0.1:1#frag'],
    ['a bare fragment delimiter', 'http://127.0.0.1:1#'],
    ['embedded credentials', 'http://user:secret@127.0.0.1:1'],
  ] as const) {
    assert.throws(() => new JevAdapter({ model: 'jev-latest', baseUrl, apiKey: API_KEY }), Error, label);
  }
});

test('configuration refuses an unknown backend, an empty setting and a missing key', () => {
  for (const [label, overrides] of [
    ['an unknown backend', { RK_BACKEND: 'other', TYPESAFE_API_KEY: API_KEY }],
    ['a blank backend', { RK_BACKEND: '  ', TYPESAFE_API_KEY: API_KEY }],
    ['a blank model', { TYPESAFE_API_KEY: API_KEY, TYPESAFE_DEFAULT_MODEL: ' ' }],
    ['a blank base URL', { TYPESAFE_API_KEY: API_KEY, TYPESAFE_BASE_URL: '' }],
    ['a base URL that is not a URL', { TYPESAFE_API_KEY: API_KEY, TYPESAFE_BASE_URL: 'api.example.com' }],
    ['no key at all', {}],
    ['a blank key', { TYPESAFE_API_KEY: '  ' }],
  ] as const) {
    assert.throws(() => createDecisionService(decisionEnv(overrides)), Error, label);
  }
});

test('a supplied threshold decides strictly above itself, and zero and one are usable boundaries', async () => {
  for (const [threshold, noul, follows] of [
    [0, 0, false],
    [0, 0.0000001, true],
    [0.4, 0.4, false],
    [0.4, 0.4000001, true],
    [0.5, 0.9, true],
    [1, 0.9999999, false],
    [1, 1, false],
  ] as const) {
    backend.reset();
    backend.answer = noulReply(noul);
    const decision = await serviceFor(backend, {}, threshold).decide(INPUT);
    assert.deepEqual(
      decision,
      { follows, probability: noul, model: 'jev-1.13.0' },
      `a threshold of ${threshold} with a noul of ${noul}`,
    );
  }
});

test('RK_THRESHOLD configures the run, reading a zero threshold as zero rather than as absent', async () => {
  for (const [value, noul, follows] of [
    ['0.6', 0.6, false],
    ['0.6', 0.6000001, true],
    ['0', 0, false],
    ['0', 0.0000001, true],
    ['1', 1, false],
  ] as const) {
    backend.reset();
    backend.answer = noulReply(noul);
    const decision = await serviceFor(backend, { RK_THRESHOLD: value }).decide(INPUT);
    assert.deepEqual(
      decision,
      { follows, probability: noul, model: 'jev-1.13.0' },
      `RK_THRESHOLD ${value} with a noul of ${noul}`,
    );
  }
});

test('a supplied threshold outranks RK_THRESHOLD, which outranks the default', async () => {
  for (const [label, overrides, threshold, noul, follows] of [
    ['nothing configured ties at the default', {}, undefined, 0.4, false],
    ['nothing configured follows above the default', {}, undefined, 0.4000001, true],
    ['a setting alone', { RK_THRESHOLD: '0.9' }, undefined, 0.7, false],
    ['a supplied threshold beside a setting', { RK_THRESHOLD: '0.9' }, 0.5, 0.7, true],
    ['a supplied zero beside a setting', { RK_THRESHOLD: '0.9' }, 0, 0.0000001, true],
  ] as const) {
    backend.reset();
    backend.answer = noulReply(noul);
    const decision = await serviceFor(backend, overrides, threshold).decide(INPUT);
    assert.deepEqual(decision, { follows, probability: noul, model: 'jev-1.13.0' }, label);
  }
});

test('an unusable threshold is refused before any request', async () => {
  backend.reset();
  for (const value of ['', '   ', 'abc', 'NaN', 'Infinity', '-0.5', '1.5', '2', '0.5.5']) {
    assert.throws(() => serviceFor(backend, { RK_THRESHOLD: value }), Error, `RK_THRESHOLD ${JSON.stringify(value)}`);
  }
  for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, -0.5, 1.5, 2]) {
    assert.throws(() => serviceFor(backend, {}, threshold), Error, `a supplied threshold of ${String(threshold)}`);
  }
  assert.equal(backend.sent.length, 0, 'an unusable threshold must be refused before any request');
});

test('the effective threshold and where it came from are reported once they are resolved', () => {
  const events: { readonly event: string; readonly fields: DiagnosticFields | undefined }[] = [];
  const diagnostics: Diagnostics = {
    important: (event, fields) => {
      events.push({ event, fields });
    },
  };

  for (const [overrides, threshold, expected] of [
    [{}, undefined, { threshold: 0.4, source: 'default' }],
    [{ RK_THRESHOLD: '0.7' }, undefined, { threshold: 0.7, source: 'env' }],
    [{ RK_THRESHOLD: '0.7' }, 0.2, { threshold: 0.2, source: 'flag' }],
  ] as const) {
    events.length = 0;
    createDecisionService(decisionEnv({ TYPESAFE_API_KEY: API_KEY, ...overrides }), diagnostics, threshold);
    assert.deepEqual(
      events.filter(({ event }) => event === 'decision.threshold').map(({ fields }) => fields),
      [expected],
      `the threshold beside ${JSON.stringify(overrides)}`,
    );
  }
});

test('a group is judged against the same threshold as a scope decision', async () => {
  const grouped: DecisionInput = {
    rule: RULE,
    examples: EXAMPLES,
    context: {
      group: { type: 'folder', path: 'src/payments' },
      files: [
        { filepath: 'src/payments/save.ts', scopes: [{ id: '0:', source: 'async function save() {}' }] },
        { filepath: 'src/payments/refund.ts', scopes: [{ id: '0:', source: 'function refund() {}' }] },
      ],
    },
  };

  for (const [label, overrides, threshold, probability, follows] of [
    ['the default threshold ties a group at exactly 0.4', {}, undefined, 0.4, false],
    ['a supplied threshold below the group answer', {}, 0.2, 0.5, true],
    ['a setting above the group answer', { RK_THRESHOLD: '0.8' }, undefined, 0.5, false],
    ['a setting below the group answer', { RK_THRESHOLD: '0.4' }, undefined, 0.5, true],
  ] as const) {
    backend.reset();
    backend.answer = noulReply(probability);
    const decision = await serviceFor(backend, overrides, threshold).decide(grouped);
    assert.deepEqual(decision, { follows, probability, model: 'jev-1.13.0' }, label);
    assert.equal(backend.sent.length, 1, `${label}: one group must be one decision`);
  }
});
