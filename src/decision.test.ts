import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { isMapping } from '../tests/support.ts';
import { JevAdapter } from './adapter/decision/jev.ts';
import type { DecisionState } from './app/decision/port.ts';
import { DecisionService, type DecisionInput } from './app/decision/service.ts';
import type { DiagnosticFields, Diagnostics } from './app/ports/diagnostics.ts';
import type { Context, RuleExamples, RuleSettings } from './app/rule/types.ts';
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

function serviceFor(
  backend: Loopback,
  overrides: NodeJS.ProcessEnv = {},
  threshold?: number,
  settings: RuleSettings = {},
): DecisionService {
  return createDecisionService(
    decisionEnv({ TYPESAFE_BASE_URL: backend.baseUrl, TYPESAFE_API_KEY: API_KEY, ...overrides }),
    undefined,
    threshold,
    settings,
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

interface Captured {
  readonly level: 'debug' | 'verbose';
  readonly event: string;
  readonly fields: DiagnosticFields | undefined;
}

function recorder(): { diagnostics: Diagnostics; events: Captured[] } {
  const events: Captured[] = [];
  return {
    events,
    diagnostics: {
      important: (event, fields) => {
        events.push({ level: 'debug', event, fields });
      },
      verbose: (event, fields) => {
        events.push({ level: 'verbose', event, fields });
      },
    },
  };
}

function verboseFields(events: readonly Captured[], event: string): readonly DiagnosticFields[] {
  return events.filter(entry => entry.level === 'verbose' && entry.event === event).map(entry => entry.fields ?? {});
}

function debugExtras(events: readonly Captured[], event: string): readonly DiagnosticFields[] {
  return events.filter(entry => entry.level === 'debug' && entry.event === event).map(entry => entry.fields ?? {});
}

function withDiagnostics(backend: Loopback, diagnostics: Diagnostics): DecisionService {
  return createDecisionService(decisionEnv({ TYPESAFE_BASE_URL: backend.baseUrl, TYPESAFE_API_KEY: API_KEY }), diagnostics);
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

function sentExamples(backend: Loopback): Record<string, unknown> {
  const examples = sentInstructions(backend).examples;
  assert.ok(isMapping(examples), 'the instructions must carry the examples');
  return examples;
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

test('one decision posts the rule, its examples and the question with the projected scope to the configured endpoint', async () => {
  backend.reset();
  const decision = await serviceFor(backend).decide(INPUT);

  const request = onlySent(backend);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/systemone');
  assert.equal(request.authorization, `Bearer ${API_KEY}`);

  const body = wireBody(backend);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(sentState(backend), PROJECTED);
  const question = sentQuestion(backend);
  assert.equal(question.type, 'noul');
  assert.deepEqual(
    sentInstructions(backend),
    { rule: RULE, examples: EXAMPLES, question: 'Is the rule respected?' },
    'the instructions must carry the rule, its examples and the question',
  );
  assert.ok(!('criteria' in question), 'the question must carry no criteria');

  assert.deepEqual(decision, { follows: true, probability: 0.9, model: 'jev-1.13.0' });
});

test('each example travels once, inside the instructions beside the rule', async () => {
  backend.reset();
  const good = 'async function load(): Promise<void> {}';
  const bad = 'function load(): void {}';
  const examples: RuleExamples = { good: [good], bad: [bad] };

  await serviceFor(backend).decide({ context: CONTEXT, rule: RULE, examples });

  assert.deepEqual(sentExamples(backend), { good: [good], bad: [bad] }, 'the examples must stand under the instructions');
  const wire = JSON.stringify(wireBody(backend));
  assert.equal(wire.split(good).length - 1, 1, 'a good example must reach the wire once');
  assert.equal(wire.split(bad).length - 1, 1, 'a bad example must reach the wire once');
});

test('the instructions judge the rule itself, unchanged by what is evaluated', async () => {
  backend.reset();
  await serviceFor(backend).decide(INPUT);
  const instructions = sentInstructions(backend);

  backend.reset();
  const grouped: DecisionInput = {
    rule: RULE,
    examples: EXAMPLES,
    context: {
      group: { type: 'folder', path: 'src/payments' },
      files: [
        { filepath: 'src/payments/save.ts', scopes: [{ id: '0:', source: 'async function save() {}' }] },
        { filepath: 'src/payments/refund.ts', scopes: [{ id: '0:', source: 'null', data: null }] },
      ],
    },
  };
  await serviceFor(backend).decide(grouped);
  assert.deepEqual(sentInstructions(backend), instructions, 'the instructions must not depend on what is evaluated');
});

test('multiline examples reach the wire as written', async () => {
  backend.reset();
  const good = 'async function save(): Promise<void> {\n  await store.put();\n}';
  const bad = 'function save(): void {\n  store.put();\n}';
  await serviceFor(backend).decide({ context: CONTEXT, rule: RULE, examples: { good: [good], bad: [bad] } });
  assert.deepEqual(sentExamples(backend).good, [good], 'a multiline good example must travel verbatim');
  assert.deepEqual(sentExamples(backend).bad, [bad], 'a multiline bad example must travel verbatim');
});

test('empty example lists are omitted from the instructions', async () => {
  backend.reset();
  await serviceFor(backend).decide({ context: CONTEXT, rule: RULE, examples: { good: [], bad: [] } });
  assert.deepEqual(sentInstructions(backend), { rule: RULE, question: 'Is the rule respected?' });
});

test('either populated example category is preserved in the instructions', async () => {
  const cases: readonly RuleExamples[] = [
    { good: ['async function save() {}'], bad: [] },
    { good: [], bad: ['function save() {}'] },
  ];
  for (const examples of cases) {
    backend.reset();
    await serviceFor(backend).decide({ context: CONTEXT, rule: RULE, examples });
    assert.deepEqual(sentExamples(backend), examples);
  }
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

test('the verbose request body is the exact payload the endpoint receives, beside the fields it already carried', async () => {
  backend.reset();
  backend.answer = noulReply(0.9);
  const { diagnostics, events } = recorder();

  await withDiagnostics(backend, diagnostics).decide(INPUT);

  const [request] = verboseFields(events, 'http.request');
  assert.ok(request !== undefined, 'the verbose request event must be reported');
  assert.strictEqual(typeof request.body, 'string', 'the request body must be reported as a serialized string');
  assert.strictEqual(request.body, JSON.stringify(wireBody(backend)), 'the logged body must be the exact payload that was sent');
  assert.deepStrictEqual(JSON.parse(request.body as string), wireBody(backend));
  assert.strictEqual(request.method, 'POST');
  assert.strictEqual(request.host, new URL(backend.baseUrl).host);
  assert.strictEqual(request.path, '/v1/systemone');
  assert.strictEqual(request.model, 'jev-latest');
  assert.strictEqual(request.timeout_ms, 30_000);
  for (const entry of events) {
    if (entry.level === 'debug') assert.ok(!('body' in (entry.fields ?? {})), `--debug must stay body-free (${entry.event})`);
  }
});

test('the successful response body is reported on the verbose level while the debug response stays body-free', async () => {
  backend.reset();
  backend.answer = noulReply(0.9);
  const { diagnostics, events } = recorder();

  const decision = await withDiagnostics(backend, diagnostics).decide(INPUT);

  assert.deepStrictEqual(decision, { follows: true, probability: 0.9, model: 'jev-1.13.0' });
  const [responseBody] = verboseFields(events, 'http.response.body');
  assert.ok(responseBody !== undefined, 'the verbose response body must be reported');
  assert.strictEqual(responseBody.status, 200);
  assert.strictEqual(typeof responseBody.body, 'string', 'the response body must be reported as a serialized string');
  assert.deepStrictEqual(JSON.parse(responseBody.body as string), JSON.parse(backend.answer.body!));
  const [request] = verboseFields(events, 'http.request');
  assert.strictEqual(responseBody.id, request?.id, 'the response body must answer its own request');
  const responses = debugExtras(events, 'http.response');
  assert.strictEqual(responses.length, 1, 'the debug response must still be reported');
  assert.ok(!('body' in responses[0]!), 'the debug response must stay free of the body');
});

test('a failing response body is reported on the verbose level with the credential it echoes redacted', async () => {
  backend.reset();
  backend.answer = jsonReply({ error: `invalid key ${API_KEY}` }, 401);
  const { diagnostics, events } = recorder();

  const error = await failed(() => withDiagnostics(backend, diagnostics).decide(INPUT));

  assert.match(error.message, /HTTP 401/);
  const [responseBody] = verboseFields(events, 'http.response.body');
  assert.ok(responseBody !== undefined, 'the failing body must be reported');
  assert.strictEqual(responseBody.status, 401);
  const reported = responseBody.body as string;
  assert.ok(reported.includes('[REDACTED]'), `the echoed credential must be replaced (body: ${reported})`);
  assert.ok(!reported.includes(API_KEY), `the echoed credential must not survive (body: ${reported})`);
  assert.deepStrictEqual(JSON.parse(reported), { error: 'invalid key [REDACTED]' });

  const failures = debugExtras(events, 'http.failure');
  assert.strictEqual(failures.length, 1, 'the debug failure must still be reported');
  assert.ok(!('body' in failures[0]!), 'the debug failure must stay free of the body');
  for (const entry of events) {
    const serialized = JSON.stringify(entry.fields ?? {});
    assert.ok(!serialized.includes(API_KEY), `no event may carry the credential (${entry.event})`);
    assert.ok(!serialized.includes('Bearer'), `no event may carry the authorization header (${entry.event})`);
  }
});

test('a malformed 2xx body is reported on the verbose level before the decision is rejected', async () => {
  backend.reset();
  backend.answer = jsonReply({ model: 'jev-1.13.0' });
  const { diagnostics, events } = recorder();

  const error = await failed(() => withDiagnostics(backend, diagnostics).decide(INPUT));

  assert.match(error.message, /answers/, 'the malformed answer must be rejected as before');
  const [responseBody] = verboseFields(events, 'http.response.body');
  assert.ok(responseBody !== undefined, 'the malformed body must be reported before validation');
  assert.strictEqual(responseBody.status, 200);
  assert.deepStrictEqual(JSON.parse(responseBody.body as string), { model: 'jev-1.13.0' });
  const invalid = debugExtras(events, 'http.response.invalid');
  assert.strictEqual(invalid.length, 1, 'the rejected response must still be reported');
  assert.ok(!('body' in invalid[0]!), 'the debug rejection must stay free of the body');
});

test('the credential is redacted from the request body the rule happens to carry', async () => {
  backend.reset();
  backend.answer = noulReply(0.9);
  const context: Context = { filepath: FILEPATH, scope: { id: '0:', source: `const token = '${API_KEY}';` } };
  const { diagnostics, events } = recorder();

  await withDiagnostics(backend, diagnostics).decide({ context, rule: RULE, examples: EXAMPLES });

  const [request] = verboseFields(events, 'http.request');
  assert.ok(request !== undefined, 'the verbose request event must be reported');
  const reported = request.body as string;
  assert.ok(reported.includes('[REDACTED]'), `the credential must be replaced (body: ${reported})`);
  assert.ok(!reported.includes(API_KEY), `the credential must not survive (body: ${reported})`);
  assert.ok(JSON.stringify(wireBody(backend)).includes(API_KEY), 'the endpoint must still receive the real payload');
});

test('a request that fails before any response reports no body', async () => {
  const temporary = createServer();
  temporary.listen(0, '127.0.0.1');
  await once(temporary, 'listening');
  const origin = `http://127.0.0.1:${boundPort(temporary)}`;
  await stopServer(temporary);
  const { diagnostics, events } = recorder();

  await failed(() =>
    createDecisionService(decisionEnv({ TYPESAFE_BASE_URL: origin, TYPESAFE_API_KEY: API_KEY }), diagnostics).decide(INPUT),
  );

  assert.strictEqual(verboseFields(events, 'http.request').length, 1, 'the outbound payload must still be reported');
  assert.deepStrictEqual(
    verboseFields(events, 'http.response.body'),
    [],
    'a request that never saw a response must report no body',
  );
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

  const cases: readonly (readonly [
    NodeJS.ProcessEnv,
    number | undefined,
    RuleSettings,
    { readonly threshold: number; readonly source: string },
  ])[] = [
    [{}, undefined, {}, { threshold: 0.4, source: 'default' }],
    [{ RK_THRESHOLD: '0.7' }, undefined, {}, { threshold: 0.7, source: 'env' }],
    [{ RK_THRESHOLD: '0.7' }, 0.2, {}, { threshold: 0.2, source: 'flag' }],
    [{ RK_THRESHOLD: '0.7' }, undefined, { threshold: 0.3 }, { threshold: 0.3, source: 'rule' }],
    [{ RK_THRESHOLD: 'abc' }, undefined, { threshold: 0.3 }, { threshold: 0.3, source: 'rule' }],
    [{ RK_THRESHOLD: 'abc' }, 0.9, { threshold: 0.3 }, { threshold: 0.9, source: 'flag' }],
  ];

  for (const [overrides, threshold, settings, expected] of cases) {
    events.length = 0;
    createDecisionService(decisionEnv({ TYPESAFE_API_KEY: API_KEY, ...overrides }), diagnostics, threshold, settings);
    assert.deepEqual(
      events.filter(({ event }) => event === 'decision.threshold').map(({ fields }) => fields),
      [expected],
      `the threshold beside ${JSON.stringify(overrides)} and ${JSON.stringify(settings)}`,
    );
  }
});

test('a rule setting outranks the environment and masks an unusable lower-priority setting', async () => {
  backend.reset();
  backend.answer = noulReply(0.9);
  const settings: RuleSettings = { model: 'rule-model', threshold: 0.2, backend: 'jev' };

  const decision = await serviceFor(
    backend,
    { RK_BACKEND: '', RK_THRESHOLD: 'abc', TYPESAFE_DEFAULT_MODEL: '   ' },
    undefined,
    settings,
  ).decide(INPUT);

  assert.deepEqual(decision, { follows: true, probability: 0.9, model: 'jev-1.13.0' });
  assert.equal(wireBody(backend).model, 'rule-model', 'the rule model must reach the wire');
  assert.equal(backend.sent.length, 1, 'one masked setting must not refuse the run');
});

test('an environment setting beneath a rule setting is still refused when it stays in charge', () => {
  assert.throws(
    () => serviceFor(backend, { TYPESAFE_DEFAULT_MODEL: '' }, undefined, { threshold: 0.5 }),
    /TYPESAFE_DEFAULT_MODEL is set but empty/,
    'a blank model the rule does not override stays unusable',
  );
  assert.throws(
    () => serviceFor(backend, { RK_THRESHOLD: 'abc' }, undefined, { model: 'rule-model' }),
    /RK_THRESHOLD/,
    'an unusable threshold the rule does not override stays unusable',
  );
  assert.throws(
    () => serviceFor(backend, { RK_BACKEND: 'other' }, undefined, { model: 'rule-model' }),
    /Unknown decision backend 'other'/,
    'an unsupported backend the rule does not override stays refused',
  );
});

test('a run threshold outranks a rule setting, which outranks the environment', async () => {
  const cases: readonly (readonly [
    string,
    NodeJS.ProcessEnv,
    number | undefined,
    RuleSettings,
    number,
    boolean,
  ])[] = [
    ['nothing configured ties at the default', {}, undefined, {}, 0.4, false],
    ['a rule setting alone', {}, undefined, { threshold: 0.9 }, 0.7, false],
    ['a rule setting below the answer', {}, undefined, { threshold: 0.2 }, 0.5, true],
    ['a rule setting over an unusable environment value', { RK_THRESHOLD: 'abc' }, undefined, { threshold: 0.2 }, 0.5, true],
    ['a rule setting over a usable environment value', { RK_THRESHOLD: '0.1' }, undefined, { threshold: 0.9 }, 0.5, false],
    ['a run threshold over a rule setting', {}, 0.8, { threshold: 0.2 }, 0.5, false],
    ['a run threshold over a rule setting and an unusable value', { RK_THRESHOLD: 'abc' }, 0.8, { threshold: 0.2 }, 0.9, true],
    ['the environment alone', { RK_THRESHOLD: '0.4' }, undefined, {}, 0.5, true],
  ];

  for (const [label, overrides, threshold, settings, noul, follows] of cases) {
    backend.reset();
    backend.answer = noulReply(noul);
    const decision = await serviceFor(backend, overrides, threshold, settings).decide(INPUT);
    assert.deepEqual(decision, { follows, probability: noul, model: 'jev-1.13.0' }, label);
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
