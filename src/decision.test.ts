import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { isMapping } from '../tests/support.ts';
import { createDecisionService } from './decision/config.ts';
import { JevAdapter } from './decision/jev.ts';
import type { DecisionState } from './decision/port.ts';
import { DecisionService, type DecisionInput } from './decision/service.ts';
import type { Context, RuleExamples } from './rule.ts';

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
    if (name.startsWith('RULEKEEPER_DECISION_') || name === 'TYPESAFE_API_KEY') continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

function serviceFor(backend: Loopback, overrides: NodeJS.ProcessEnv = {}): DecisionService {
  return createDecisionService(
    decisionEnv({ RULEKEEPER_DECISION_BASE_URL: backend.baseUrl, RULEKEEPER_DECISION_API_KEY: API_KEY, ...overrides }),
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
    await serviceFor(backend, { RULEKEEPER_DECISION_BASE_URL: `${backend.origin}${basePath}` }).decide(INPUT);
    assert.equal(onlySent(backend).path, path);
  }
});

test('a probability of exactly 0.5 is not a following decision, and the answer is preserved', async () => {
  for (const [noul, follows] of [
    [0, false],
    [0.4999999, false],
    [0.5, false],
    [0.5000001, true],
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

  const error = await failed(() => serviceFor(backend, { RULEKEEPER_DECISION_BASE_URL: origin }).decide(INPUT));

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
    ['an unknown backend', { RULEKEEPER_DECISION_BACKEND: 'other', RULEKEEPER_DECISION_API_KEY: API_KEY }],
    ['a blank backend', { RULEKEEPER_DECISION_BACKEND: '  ', RULEKEEPER_DECISION_API_KEY: API_KEY }],
    ['a blank model', { RULEKEEPER_DECISION_API_KEY: API_KEY, RULEKEEPER_DECISION_MODEL: ' ' }],
    ['a blank base URL', { RULEKEEPER_DECISION_API_KEY: API_KEY, RULEKEEPER_DECISION_BASE_URL: '' }],
    ['a base URL that is not a URL', { RULEKEEPER_DECISION_API_KEY: API_KEY, RULEKEEPER_DECISION_BASE_URL: 'api.example.com' }],
    ['no key at all', {}],
    ['a blank key', { RULEKEEPER_DECISION_API_KEY: '  ' }],
  ] as const) {
    assert.throws(() => createDecisionService(decisionEnv(overrides)), Error, label);
  }
});

test('the official key and the default model are used when only TYPESAFE_API_KEY is set', async () => {
  backend.reset();

  const decision = await createDecisionService(
    decisionEnv({ RULEKEEPER_DECISION_BASE_URL: backend.baseUrl, TYPESAFE_API_KEY: 'official-key' }),
  ).decide(INPUT);

  assert.equal(onlySent(backend).authorization, 'Bearer official-key');
  assert.equal(wireBody(backend).model, 'jev-latest');
  assert.deepEqual(decision, { follows: true, probability: 0.9, model: 'jev-1.13.0' });
});

test('the rulekeeper key and model win over the official key and the default model', async () => {
  backend.reset();

  await serviceFor(backend, {
    RULEKEEPER_DECISION_API_KEY: 'rulekeeper-key',
    TYPESAFE_API_KEY: 'official-key',
    RULEKEEPER_DECISION_MODEL: 'jev-9.9.9',
    RULEKEEPER_DECISION_BACKEND: 'jev',
  }).decide(INPUT);

  assert.equal(onlySent(backend).authorization, 'Bearer rulekeeper-key');
  assert.equal(wireBody(backend).model, 'jev-9.9.9');
});
