import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { isMapping } from '../tests/support.ts';
import type { DecisionExchange, DecisionObserver } from './app/decision/port.ts';
import type { DecisionInput } from './app/decision/service.ts';
import type { DiagnosticFields, Diagnostics } from './app/ports/diagnostics.ts';
import type { Context, RuleExamples } from './app/rule/types.ts';
import { createDecisionService } from './infra/decision.ts';

const API_KEY = 'loopback-key';
const JSON_KEY = 'loop"back\\key';
const RULE = 'Every handler must return a promise.';
const EXAMPLES: RuleExamples = { good: ['async function save(): Promise<void> {}'], bad: ['function save(): void {}'] };
const FILEPATH = 'src/save.ts';
const SOURCE = 'async function save(): Promise<void> {}';
const CONTEXT: Context = { filepath: FILEPATH, scope: { id: '0:', source: SOURCE } };
const INPUT: DecisionInput = { context: CONTEXT, rule: RULE, examples: EXAMPLES };
const ANSWER = { model: 'jev-1.13.0', answers: { follows_instructions: { type: 'noul', noul: 0.9 } } };

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly contentType?: string;
}

interface Sent {
  readonly raw: string;
  readonly parsed: unknown;
  readonly contentType: string | undefined;
}

interface Loopback {
  readonly origin: string;
  readonly sent: Sent[];
  answer: Reply;
  reset(): void;
  close(): Promise<void>;
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      sent.push({ raw, parsed, contentType: request.headers['content-type'] });
      response.writeHead(backend.answer.status ?? 200, { 'content-type': backend.answer.contentType ?? 'application/json' });
      response.end(backend.answer.body ?? '');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${boundPort(server)}`;
  backend = {
    origin,
    sent,
    answer: { status: 200, body: JSON.stringify(ANSWER) },
    reset(): void {
      sent.length = 0;
      backend.answer = { status: 200, body: JSON.stringify(ANSWER) };
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

function serviceFor(backend: Loopback, overrides: NodeJS.ProcessEnv = {}) {
  return createDecisionService(decisionEnv({ TYPESAFE_BASE_URL: backend.origin, TYPESAFE_API_KEY: API_KEY, ...overrides }));
}

function exchangesOf(): { readonly exchanges: DecisionExchange[]; readonly observer: DecisionObserver } {
  const exchanges: DecisionExchange[] = [];
  return {
    exchanges,
    observer: exchange => {
      exchanges.push(exchange);
    },
  };
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

let backend!: Loopback;

const savedProxies: Record<string, string> = {};

before(async () => {
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

test('an observer alone reports the payload the endpoint receives and the answer it produced', async () => {
  backend.reset();
  const { exchanges, observer } = exchangesOf();

  const decision = await serviceFor(backend).decide(INPUT, observer);

  assert.deepEqual(decision, { follows: true, probability: 0.9, model: 'jev-1.13.0' });
  assert.deepEqual(exchanges.map(exchange => exchange.type), ['request', 'response']);
  const [request, response] = exchanges;
  assert.ok(request?.type === 'request' && response?.type === 'response');
  assert.equal(request.body, onlySent(backend).raw, 'the reported request must be the payload the endpoint received');
  assert.deepEqual(JSON.parse(request.body), onlySent(backend).parsed);
  const payload = JSON.parse(request.body);
  assert.ok(isMapping(payload), 'the reported request must be a JSON object');
  assert.equal(payload.model, 'jev-latest');
  const state = payload.state;
  assert.ok(isMapping(state), 'the reported request must carry the projected state');
  assert.equal(state.filepath, FILEPATH);
  assert.deepEqual(state.scope, { id: '0:', source: SOURCE });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), ANSWER, 'the reported answer must be the body the endpoint sent');
});

test('observed scope data preserves every JSON key on the wire', async () => {
  backend.reset();
  const data = JSON.parse('{"__proto__":{"flag":true},"constructor":"setting"}');
  const context: Context = { filepath: FILEPATH, scope: { id: '0:', source: '{}', data } };
  const { exchanges, observer } = exchangesOf();

  await serviceFor(backend).decide({ context, rule: RULE, examples: EXAMPLES }, observer);

  const request = exchanges[0];
  assert.ok(request?.type === 'request');
  const sent = onlySent(backend);
  assert.equal(request.body, sent.raw);
  assert.deepEqual(JSON.parse(sent.raw).state.scope.data, data);
  assert.ok(sent.contentType?.startsWith('application/json'), `the payload must arrive as JSON (content type: ${sent.contentType})`);

  backend.reset();
  await serviceFor(backend).decide({ context, rule: RULE, examples: EXAMPLES });

  const unwatched = onlySent(backend);
  assert.equal(unwatched.raw, sent.raw, 'a decision with no observer must put the same payload on the wire');
  assert.deepEqual(Object.keys(JSON.parse(unwatched.raw).state.scope.data), ['__proto__', 'constructor']);
});

test('the outbound payload is reported before the endpoint can have received it', async () => {
  backend.reset();
  const inFlight: number[] = [];

  await serviceFor(backend).decide(INPUT, exchange => {
    if (exchange.type === 'request') inFlight.push(backend.sent.length);
  });

  assert.deepEqual(inFlight, [0], 'the payload must be reported before the request is sent');
  assert.equal(backend.sent.length, 1);
});

test('a credential carrying JSON delimiters is masked for an observer that has no diagnostics', async () => {
  backend.reset();
  const source = `const token = '${JSON_KEY}';`;
  const context: Context = { filepath: FILEPATH, scope: { id: '0:', source } };
  const { exchanges, observer } = exchangesOf();

  const decision = await serviceFor(backend, { TYPESAFE_API_KEY: JSON_KEY }).decide({ context, rule: RULE, examples: EXAMPLES }, observer);

  assert.equal(decision.follows, true);
  const [request] = exchanges;
  assert.ok(request?.type === 'request');
  const escaped = JSON.stringify(JSON_KEY).slice(1, -1);
  assert.ok(request.body.includes('[REDACTED]'), `the credential must be replaced (body: ${request.body})`);
  assert.ok(!request.body.includes(escaped), `the credential must not survive (body: ${request.body})`);
  assert.equal(JSON.parse(request.body).state.scope.source, "const token = '[REDACTED]';");
  const sent = onlySent(backend);
  assert.ok(sent.raw.includes(escaped), 'the endpoint must still receive the real payload');
  assert.deepEqual(sent.parsed, JSON.parse(request.body.replaceAll('[REDACTED]', escaped)), 'nothing but the credential may differ from the wire payload');
  assert.ok(!JSON.stringify(exchanges).includes(escaped), 'no exchange may carry the credential');
});

test('a failing status and its non-JSON body are reported before the failure is raised', async () => {
  backend.reset();
  backend.answer = { status: 401, contentType: 'text/plain', body: `invalid key ${API_KEY}` };
  const { exchanges, observer } = exchangesOf();

  const error = await failed(() => serviceFor(backend).decide(INPUT, observer));

  assert.match(error.message, /HTTP 401/);
  assert.deepEqual(exchanges.map(exchange => exchange.type), ['request', 'response']);
  const response = exchanges[1];
  assert.ok(response?.type === 'response');
  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.body), 'invalid key [REDACTED]', 'the received text must be reported as it arrived');
  assert.ok(!JSON.stringify(exchanges).includes(API_KEY), 'no exchange may carry the credential');
});

test('an unusable answer is reported in full before the decision is rejected', async () => {
  backend.reset();
  backend.answer = { status: 200, body: JSON.stringify({ model: 'jev-1.13.0' }) };
  const { exchanges, observer } = exchangesOf();

  const error = await failed(() => serviceFor(backend).decide(INPUT, observer));

  assert.match(error.message, /answers/, 'the malformed answer must be rejected as before');
  assert.deepEqual(exchanges.map(exchange => exchange.type), ['request', 'response']);
  const response = exchanges[1];
  assert.ok(response?.type === 'response');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { model: 'jev-1.13.0' });
});

test('a decision that never reaches a response reports its request alone', async () => {
  const temporary = createServer();
  temporary.listen(0, '127.0.0.1');
  await once(temporary, 'listening');
  const origin = `http://127.0.0.1:${boundPort(temporary)}`;
  await stopServer(temporary);
  const { exchanges, observer } = exchangesOf();

  const error = await failed(() => serviceFor(backend, { TYPESAFE_BASE_URL: origin }).decide(INPUT, observer));

  assert.match(error.message, /ECONNREFUSED/);
  assert.deepEqual(exchanges.map(exchange => exchange.type), ['request'], 'a missing response must report no response');
  const [request] = exchanges;
  assert.ok(request?.type === 'request');
  assert.ok(request.body.includes(RULE), 'the reported request must still be the payload that was attempted');
});

test('both sinks read one payload, and an observer covers only the call it was given to', async () => {
  backend.reset();
  const { diagnostics, events } = recorder();
  const { exchanges, observer } = exchangesOf();
  const service = createDecisionService(decisionEnv({ TYPESAFE_BASE_URL: backend.origin, TYPESAFE_API_KEY: API_KEY }), diagnostics);

  await service.decide(INPUT, observer);

  assert.deepEqual(exchanges.map(exchange => exchange.type), ['request', 'response']);
  const [request] = exchanges;
  const response = exchanges[1];
  assert.ok(request?.type === 'request' && response?.type === 'response');
  assert.equal(request.body, onlySent(backend).raw);
  const [reportedRequest] = verboseFields(events, 'http.request');
  assert.equal(reportedRequest?.body, request.body, 'both sinks must read the same serialization of one payload');
  const [reportedResponse] = verboseFields(events, 'http.response.body');
  assert.equal(reportedResponse?.body, response.body, 'both sinks must read the same serialization of one answer');

  const reported = exchanges.length;
  await service.decide(INPUT);
  assert.equal(exchanges.length, reported, 'a call without an observer must report nothing');
});
