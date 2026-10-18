import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { DecisionExchange, DecisionObserver, DecisionRequest, JsonValue } from '../dist/index.js';
import { JevAdapter } from '../dist/adapter/decision/jev.js';
import { createDecisionResolver } from '../dist/infra/settings.js';

const API_KEY = 'loopback-key';
const MODEL = 'jev-latest';
const RULE = 'Every handler must return a promise.';
const QUESTION = 'Is the rule respected?';
const STATE: JsonValue = {
  filepath: 'src/save.ts',
  scope: { id: '0:', source: 'async function save(): Promise<void> {}' },
};
const INSTRUCTIONS = { rule: RULE, question: QUESTION };
const ANSWER = { model: 'jev-1.13.0', answers: { follows_instructions: { type: 'noul', noul: 0.9 } } };

function clearProxyVariables(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of Object.keys(process.env)) {
    if (!/proxy/i.test(name)) continue;
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

const restoreProxyEnvironment = clearProxyVariables();

after(() => {
  restoreProxyEnvironment();
});

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly contentType?: string;
  readonly location?: string;
  readonly hang?: boolean;
}

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly raw: string;
  readonly parsed: unknown;
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

async function startLoopback(onRequest?: () => void): Promise<Loopback> {
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
      sent.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        raw,
        parsed,
      });
      onRequest?.();
      const reply = backend.answer;
      if (reply.hang === true) return;
      const headers: Record<string, string> = { 'content-type': reply.contentType ?? 'application/json' };
      if (reply.location !== undefined) headers.location = reply.location;
      response.writeHead(reply.status ?? 200, headers);
      response.end(reply.body ?? '');
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

async function refuseConnections(): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${boundPort(server)}`;
  await stopServer(server);
  return origin;
}

function adapterFor(baseUrl: string, apiKey: string = API_KEY): JevAdapter {
  return new JevAdapter({ model: MODEL, baseUrl, apiKey });
}

function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1, `expected exactly one item, saw ${items.length}`);
  return items[0]!;
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

async function failed(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, saw ${String(error)}`);
    return error;
  }
  throw new Error('the call was expected to fail but resolved');
}

function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, saw ${String(error)}`);
    assert.notEqual(error.message.trim(), '', 'a rejected call must explain itself');
    return error;
  }
  throw new Error('the call was expected to fail but resolved');
}

function asReceived(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const REQUEST: DecisionRequest = { state: STATE, instructions: INSTRUCTIONS };

test('posts the exact systemone request with bearer auth and the bound model', async () => {
  const backend = await startLoopback();
  try {
    const outcome = await adapterFor(backend.origin).decide(REQUEST);

    assert.deepEqual(outcome, { probability: 0.9, model: 'jev-1.13.0' });
    const sent = only(backend.sent);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/v1/systemone');
    assert.equal(sent.headers.authorization, `Bearer ${API_KEY}`);
    assert.match(String(sent.headers['content-type']), /^application\/json/);
    assert.deepEqual(sent.parsed, {
      model: MODEL,
      state: STATE,
      questions: { follows_instructions: { type: 'noul', instructions: INSTRUCTIONS } },
    });
  } finally {
    await backend.close();
  }
});

test('forwards policy examples unchanged beside the rule and question', async () => {
  const backend = await startLoopback();
  try {
    const instructions = {
      rule: RULE,
      question: QUESTION,
      examples: { good: ['async function save(): Promise<void> {}'], bad: ['function save(): void {}'] },
    };
    await adapterFor(backend.origin).decide({ state: STATE, instructions });

    const body = only(backend.sent).parsed as {
      questions: { follows_instructions: { instructions: unknown } };
    };
    assert.deepEqual(body.questions.follows_instructions.instructions, instructions);
  } finally {
    await backend.close();
  }
});

test('preserves a base URL path prefix when joining the endpoint', async () => {
  for (const suffix of ['/api', '/api/']) {
    const backend = await startLoopback();
    try {
      await adapterFor(`${backend.origin}${suffix}`).decide(REQUEST);
      assert.equal(only(backend.sent).url, '/api/v1/systemone');
    } finally {
      await backend.close();
    }
  }
});

test('reports the outbound payload before the endpoint receives it', async () => {
  const backend = await startLoopback();
  try {
    const { exchanges, observer } = exchangesOf();
    const receivedWhenReported: number[] = [];

    await adapterFor(backend.origin).decide(REQUEST, (exchange: DecisionExchange) => {
      observer(exchange);
      if (exchange.type === 'request') receivedWhenReported.push(backend.sent.length);
    });

    assert.deepEqual(receivedWhenReported, [0]);
    assert.deepEqual(
      exchanges.map(exchange => exchange.type),
      ['request', 'response'],
    );
    const [request, response] = exchanges;
    assert.ok(request?.type === 'request' && response?.type === 'response');
    assert.equal(request.body, only(backend.sent).raw, 'the wire payload must be reported verbatim');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), ANSWER);
  } finally {
    await backend.close();
  }
});

test('redacts a literal credential in the reported request', async () => {
  const backend = await startLoopback();
  try {
    const state: JsonValue = { filepath: 'src/save.ts', scope: { id: '0:', source: `const token = '${API_KEY}';` } };
    const { exchanges, observer } = exchangesOf();

    await adapterFor(backend.origin).decide({ state, instructions: INSTRUCTIONS }, observer);

    const [request] = exchanges;
    assert.ok(request?.type === 'request');
    assert.ok(request.body.includes('[REDACTED]'), `the credential must be replaced (body: ${request.body})`);
    assert.ok(!request.body.includes(API_KEY), 'the credential must not survive in the report');
    const redactedState = JSON.parse(request.body) as { state: { scope: { source: string } } };
    assert.equal(redactedState.state.scope.source, "const token = '[REDACTED]';");

    const sent = only(backend.sent);
    assert.ok(sent.raw.includes(API_KEY), 'the endpoint must still receive the real payload');
    assert.deepEqual(
      JSON.parse(request.body.replaceAll('[REDACTED]', API_KEY)),
      sent.parsed,
      'nothing but the credential may differ from the wire payload',
    );
    assert.ok(!JSON.stringify(exchanges).includes(API_KEY), 'no exchange may carry the credential');
  } finally {
    await backend.close();
  }
});

test('redacts a credential that the JSON encoding escapes', async () => {
  const backend = await startLoopback();
  try {
    const jsonKey = 'loop"back\\key';
    const escaped = JSON.stringify(jsonKey).slice(1, -1);
    const state: JsonValue = { filepath: 'src/save.ts', scope: { id: '0:', source: `const token = '${jsonKey}';` } };
    const { exchanges, observer } = exchangesOf();

    await adapterFor(backend.origin, jsonKey).decide({ state, instructions: INSTRUCTIONS }, observer);

    const [request] = exchanges;
    assert.ok(request?.type === 'request');
    assert.ok(request.body.includes('[REDACTED]'), `the escaped credential must be replaced (body: ${request.body})`);
    assert.ok(!request.body.includes(escaped), 'the escaped credential must not survive in the report');
    const redactedState = JSON.parse(request.body) as { state: { scope: { source: string } } };
    assert.equal(redactedState.state.scope.source, "const token = '[REDACTED]';");
    assert.ok(only(backend.sent).raw.includes(escaped), 'the endpoint must still receive the real payload');
    assert.ok(!JSON.stringify(exchanges).includes(escaped), 'no exchange may carry the escaped credential');
  } finally {
    await backend.close();
  }
});

test('reports a failing status and its raw body before raising', async () => {
  const backend = await startLoopback();
  try {
    backend.answer = { status: 401, contentType: 'text/plain', body: `invalid key ${API_KEY}` };
    const { exchanges, observer } = exchangesOf();

    const error = await failed(() => adapterFor(backend.origin).decide(REQUEST, observer));

    assert.match(error.message, /HTTP 401/);
    assert.deepEqual(
      exchanges.map(exchange => exchange.type),
      ['request', 'response'],
    );
    const response = exchanges[1];
    assert.ok(response?.type === 'response');
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.body), 'invalid key [REDACTED]', 'the received text must be reported as it arrived');
    assert.ok(!JSON.stringify(exchanges).includes(API_KEY), 'no exchange may carry the credential');
  } finally {
    await backend.close();
  }
});

test('reports an unusable answer in full before rejecting', async () => {
  const backend = await startLoopback();
  try {
    backend.answer = { status: 200, body: JSON.stringify({ model: 'jev-1.13.0' }) };
    const { exchanges, observer } = exchangesOf();

    const error = await failed(() => adapterFor(backend.origin).decide(REQUEST, observer));

    assert.notEqual(error.message.trim(), '', 'a rejected decision must explain itself');
    assert.ok(!error.message.includes(API_KEY), 'the diagnostic must not leak the credential');
    assert.deepEqual(
      exchanges.map(exchange => exchange.type),
      ['request', 'response'],
    );
    const response = exchanges[1];
    assert.ok(response?.type === 'response');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { model: 'jev-1.13.0' });
  } finally {
    await backend.close();
  }
});

test('reports only the request when no response ever arrives', async () => {
  const origin = await refuseConnections();
  const { exchanges, observer } = exchangesOf();

  const error = await failed(() => adapterFor(origin).decide(REQUEST, observer));

  assert.match(error.message, /ECONNREFUSED/);
  assert.deepEqual(
    exchanges.map(exchange => exchange.type),
    ['request'],
    'a missing response must report no response',
  );
  const [request] = exchanges;
  assert.ok(request?.type === 'request');
  assert.ok(request.body.includes(RULE), 'the reported request must still be the payload that was attempted');
});

const MALFORMED: readonly { readonly label: string; readonly body: string }[] = [
  { label: 'non-JSON text', body: 'not json' },
  { label: 'an empty body', body: '' },
  { label: 'a JSON array', body: '[]' },
  { label: 'a JSON scalar', body: '42' },
  { label: 'no model', body: JSON.stringify({ answers: {} }) },
  { label: 'a blank model', body: JSON.stringify({ model: '   ', answers: {} }) },
  { label: 'no answers map', body: JSON.stringify({ model: 'jev-1.13.0' }) },
  {
    label: 'no follows_instructions answer',
    body: JSON.stringify({ model: 'jev-1.13.0', answers: {} }),
  },
  {
    label: 'a non-noul answer',
    body: JSON.stringify({ model: 'jev-1.13.0', answers: { follows_instructions: { type: 'other', noul: 0.5 } } }),
  },
  {
    label: 'a string probability',
    body: JSON.stringify({ model: 'jev-1.13.0', answers: { follows_instructions: { type: 'noul', noul: '0.9' } } }),
  },
  {
    label: 'a null probability',
    body: JSON.stringify({ model: 'jev-1.13.0', answers: { follows_instructions: { type: 'noul', noul: null } } }),
  },
  {
    label: 'a negative probability',
    body: JSON.stringify({ model: 'jev-1.13.0', answers: { follows_instructions: { type: 'noul', noul: -0.1 } } }),
  },
  {
    label: 'a probability above one',
    body: JSON.stringify({ model: 'jev-1.13.0', answers: { follows_instructions: { type: 'noul', noul: 1.1 } } }),
  },
];

test('rejects a decision response that is not a well-formed noul answer', async () => {
  const backend = await startLoopback();
  try {
    for (const { label, body } of MALFORMED) {
      backend.reset();
      backend.answer = { status: 200, body };
      const { exchanges, observer } = exchangesOf();

      const error = await failed(() => adapterFor(backend.origin).decide(REQUEST, observer));

      assert.notEqual(error.message.trim(), '', `${label}: a rejected decision must explain itself`);
      assert.ok(!error.message.includes(API_KEY), `${label}: the diagnostic must not leak the credential`);
      assert.deepEqual(
        exchanges.map(exchange => exchange.type),
        ['request', 'response'],
        `${label}: the answer must be reported before it is rejected`,
      );
      const response = exchanges[1];
      assert.ok(response?.type === 'response');
      assert.equal(response.status, 200, `${label}: the observed status must be reported`);
      assert.deepEqual(
        JSON.parse(response.body),
        asReceived(body),
        `${label}: the response must be reported as it arrived`,
      );
    }
  } finally {
    await backend.close();
  }
});

test('accepts a noul probability at both inclusive bounds', async () => {
  const backend = await startLoopback();
  try {
    for (const probability of [0, 1]) {
      backend.reset();
      backend.answer = {
        status: 200,
        body: JSON.stringify({
          model: 'jev-1.13.0',
          answers: { follows_instructions: { type: 'noul', noul: probability } },
        }),
      };

      const outcome = await adapterFor(backend.origin).decide(REQUEST);

      assert.deepEqual(outcome, { probability, model: 'jev-1.13.0' });
    }
  } finally {
    await backend.close();
  }
});

test('distinguishes absent usage from reported zero and accepts safe integer token counts', async () => {
  const backend = await startLoopback();
  try {
    for (const usage of [
      undefined,
      { input_tokens: 0, output_tokens: 0 },
      { input_tokens: 11, output_tokens: 1 },
      { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER },
    ]) {
      backend.answer = { body: JSON.stringify({ ...ANSWER, ...(usage === undefined ? {} : { usage }) }) };
      const outcome = await adapterFor(backend.origin).decide(REQUEST);
      assert.deepEqual(outcome, {
        probability: 0.9,
        model: 'jev-1.13.0',
        ...(usage === undefined ? {} : { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }),
      });
    }
  } finally {
    await backend.close();
  }
});

test('rejects supplied usage with missing, malformed, or unsafe token counts', async () => {
  const backend = await startLoopback();
  try {
    const malformed: unknown[] = [null, [], 'usage', {}, { input_tokens: 1 }, { output_tokens: 1 }];
    for (const field of ['input_tokens', 'output_tokens']) {
      for (const value of [null, '1', true, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
        malformed.push({ input_tokens: 1, output_tokens: 1, [field]: value });
      }
    }
    for (const usage of malformed) {
      backend.answer = { body: JSON.stringify({ ...ANSWER, usage }) };
      await assert.rejects(() => adapterFor(backend.origin).decide(REQUEST), JSON.stringify(usage));
    }
  } finally {
    await backend.close();
  }
});

test('does not follow a redirect', async () => {
  const elsewhere = await startLoopback();
  const backend = await startLoopback();
  try {
    backend.answer = { status: 302, location: `${elsewhere.origin}/elsewhere`, body: '' };

    const error = await failed(() => adapterFor(backend.origin).decide(REQUEST));

    assert.match(error.message, /HTTP 302/);
    assert.equal(backend.sent.length, 1, 'the endpoint must see exactly one request');
    assert.equal(elsewhere.sent.length, 0, 'the redirect target must never receive a request');
  } finally {
    await backend.close();
    await elsewhere.close();
  }
});

test('does not retry after an error status', async () => {
  const backend = await startLoopback();
  try {
    backend.answer = { status: 500, body: JSON.stringify({ error: 'boom' }) };

    const error = await failed(() => adapterFor(backend.origin).decide(REQUEST));

    assert.match(error.message, /HTTP 500/);
    assert.equal(backend.sent.length, 1, 'a failed request must not be re-sent');
  } finally {
    await backend.close();
  }
});

test('maps a refused connection to a sanitized network error', async () => {
  const origin = await refuseConnections();

  const error = await failed(() => adapterFor(origin).decide(REQUEST));

  assert.match(error.message, /ECONNREFUSED/);
  assert.ok(!error.message.includes(API_KEY), 'the diagnostic must not leak the credential');
  assert.ok(!error.message.includes('127.0.0.1'), 'the diagnostic must not leak the endpoint');
});

test('times out a stalled response after the fixed 30-second bound', { timeout: 5_000 }, async context => {
  const received = Promise.withResolvers<void>();
  const backend = await startLoopback(received.resolve);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    backend.answer = { hang: true };
    const { exchanges, observer } = exchangesOf();
    let settled = false;
    const pending = adapterFor(backend.origin).decide(REQUEST, observer);
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await received.promise;

    context.mock.timers.tick(29_999);
    await setImmediate();
    assert.equal(settled, false, 'the request must remain pending before the 30-second bound');
    context.mock.timers.tick(1);
    await setImmediate();
    assert.equal(settled, true, 'the request must reject at the 30-second bound');
    const error = await failed(() => pending);

    assert.match(error.message, /timed out/);
    assert.ok(!error.message.includes(API_KEY), 'the diagnostic must not leak the credential');
    assert.ok(!error.message.includes('127.0.0.1'), 'the diagnostic must not leak the endpoint');
    assert.equal(backend.sent.length, 1, 'a timed-out request must not be re-sent');
    assert.deepEqual(
      exchanges.map(exchange => exchange.type),
      ['request'],
      'a timed-out request reports no response',
    );
  } finally {
    context.mock.timers.reset();
    await backend.close();
  }
});

const UNSAFE: readonly { readonly label: string; readonly baseUrl: string; readonly usable: string }[] = [
  { label: 'a relative URL', baseUrl: 'not a URL', usable: 'http://127.0.0.1:1' },
  { label: 'a non-HTTP protocol', baseUrl: 'ftp://example.invalid', usable: 'http://example.invalid' },
  { label: 'a query string', baseUrl: 'http://127.0.0.1:1/api?token=1', usable: 'http://127.0.0.1:1/api' },
  { label: 'a fragment', baseUrl: 'http://127.0.0.1:1/api#frag', usable: 'http://127.0.0.1:1/api' },
  { label: 'embedded credentials', baseUrl: 'http://user:secret@127.0.0.1:1', usable: 'http://127.0.0.1:1' },
];

for (const { label, baseUrl, usable } of UNSAFE) {
  test(`refuses to build on ${label}`, () => {
    const error = thrownBy(() => new JevAdapter({ model: MODEL, baseUrl, apiKey: API_KEY }));

    assert.match(error.message, /TYPESAFE_BASE_URL/, 'the diagnostic must name the setting it came from');
    assert.ok(!error.message.includes(API_KEY), 'the diagnostic must not leak the credential');
    assert.ok(!error.message.includes(baseUrl), 'the diagnostic must not echo the rejected URL');
    assert.doesNotThrow(
      () => new JevAdapter({ model: MODEL, baseUrl: usable, apiKey: API_KEY }),
      'the same URL without that feature must be accepted',
    );
  });
}

test('accepts an encoded query or fragment delimiter inside the base path', () => {
  assert.doesNotThrow(() => new JevAdapter({ model: MODEL, baseUrl: 'http://127.0.0.1:1/a%3Fb%23c', apiKey: API_KEY }));
});

type TestEnv = Record<string, string | undefined>;

function withKey(overrides: TestEnv = {}): TestEnv {
  return { TYPESAFE_API_KEY: API_KEY, ...overrides };
}

test('resolves the jev backend with the default model and threshold', async () => {
  const backend = await startLoopback();
  try {
    const runtime = createDecisionResolver(withKey({ TYPESAFE_BASE_URL: backend.origin }))({});

    assert.equal(runtime.threshold, 0.4);
    assert.deepEqual(runtime.pricing, { inputCostPerMillion: 0.042, outputCostPerMillion: 0 });
    assert.ok(runtime.backend instanceof JevAdapter);
    await runtime.backend.decide(REQUEST);
    assert.equal((only(backend.sent).parsed as Record<string, unknown>).model, 'jev-latest');
  } finally {
    await backend.close();
  }
});

test('prefers the flag threshold, then the rule, then the environment, then the default', () => {
  const env = withKey({ RK_THRESHOLD: '0.9' });

  assert.equal(createDecisionResolver(env, 0.7)({ threshold: 0.5 }).threshold, 0.7);
  assert.equal(createDecisionResolver(env)({ threshold: 0.5 }).threshold, 0.5);
  assert.equal(createDecisionResolver(env)({}).threshold, 0.9);
  assert.equal(createDecisionResolver(withKey())({}).threshold, 0.4);
});

test('does not consult an invalid RK_THRESHOLD that a rule threshold shadows', () => {
  const env = withKey({ RK_THRESHOLD: 'abc' });

  assert.equal(createDecisionResolver(env)({ threshold: 0.5 }).threshold, 0.5);
  assert.throws(() => createDecisionResolver(env)({}), /RK_THRESHOLD/);
});

test('rejects an invalid rule threshold naming the setting', () => {
  assert.throws(() => createDecisionResolver(withKey())({ threshold: 2 }), /rule\.settings\.threshold/);
});

test('rejects an invalid flag threshold naming the flag', () => {
  assert.throws(() => createDecisionResolver(withKey(), 5)({}), /--threshold/);
});

test('resolves each price from flags, rule, environment, then defaults and preserves zero', () => {
  const env = withKey({ RK_INPUT_COST_PER_MILLION: '3', RK_OUTPUT_COST_PER_MILLION: '4' });
  assert.deepEqual(createDecisionResolver(withKey())({}).pricing, {
    inputCostPerMillion: 0.042, outputCostPerMillion: 0,
  });
  assert.deepEqual(createDecisionResolver(env)({}).pricing, { inputCostPerMillion: 3, outputCostPerMillion: 4 });
  assert.deepEqual(createDecisionResolver(env)({ inputCostPerMillion: 1, outputCostPerMillion: 2 }).pricing, {
    inputCostPerMillion: 1, outputCostPerMillion: 2,
  });
  assert.deepEqual(createDecisionResolver(env, undefined, { inputCostPerMillion: 0 })({
    inputCostPerMillion: 1, outputCostPerMillion: 2,
  }).pricing, { inputCostPerMillion: 0, outputCostPerMillion: 2 });
  assert.deepEqual(createDecisionResolver(env, undefined, { outputCostPerMillion: 0 })({}).pricing, {
    inputCostPerMillion: 3, outputCostPerMillion: 0,
  });
  assert.deepEqual(createDecisionResolver(withKey({
    RK_INPUT_COST_PER_MILLION: '0', RK_OUTPUT_COST_PER_MILLION: '0',
  }))({}).pricing, { inputCostPerMillion: 0, outputCostPerMillion: 0 });
  assert.deepEqual(createDecisionResolver(env)({ inputCostPerMillion: 0, outputCostPerMillion: 0 }).pricing, {
    inputCostPerMillion: 0, outputCostPerMillion: 0,
  });
});

test('accepts finite nonnegative price bounds and eagerly rejects invalid flag or shadowed rule prices', () => {
  for (const field of ['inputCostPerMillion', 'outputCostPerMillion'] as const) {
    for (const price of [0, Number.MIN_VALUE, Number.MAX_VALUE]) {
      assert.equal(createDecisionResolver(withKey(), undefined, { [field]: price })({}).pricing[field], price);
      assert.equal(createDecisionResolver(withKey())({ [field]: price }).pricing[field], price);
    }
    for (const price of [-1, NaN, Infinity, -Infinity]) {
      assert.throws(() => createDecisionResolver({}, undefined, { [field]: price }));
      assert.throws(() => createDecisionResolver(withKey(), undefined, { [field]: 0 })({ [field]: price }));
    }
  }
});

test('reads invalid environment prices lazily and ignores them only when that price is shadowed', () => {
  const env = withKey({ RK_INPUT_COST_PER_MILLION: 'invalid', RK_OUTPUT_COST_PER_MILLION: 'invalid' });
  assert.doesNotThrow(() => createDecisionResolver(env));
  assert.throws(() => createDecisionResolver(env)({}));
  assert.throws(() => createDecisionResolver(env)({ inputCostPerMillion: 0 }));
  assert.throws(() => createDecisionResolver(env, undefined, { outputCostPerMillion: 0 })({}));
  assert.deepEqual(createDecisionResolver(env, undefined, { inputCostPerMillion: 0 })({
    outputCostPerMillion: 0,
  }).pricing, { inputCostPerMillion: 0, outputCostPerMillion: 0 });
  for (const field of ['RK_INPUT_COST_PER_MILLION', 'RK_OUTPUT_COST_PER_MILLION']) {
    for (const price of ['', ' ', '-1', 'NaN', 'Infinity', '1e999']) {
      assert.throws(() => createDecisionResolver(withKey({ [field]: price }))({}), `${field}: ${price}`);
    }
  }
});

test('prefers the rule model over the environment model', async () => {
  const backend = await startLoopback();
  try {
    const env = withKey({ TYPESAFE_BASE_URL: backend.origin, TYPESAFE_DEFAULT_MODEL: 'env-model' });

    await createDecisionResolver(env)({ model: 'rule-model' }).backend.decide(REQUEST);
    assert.equal((only(backend.sent).parsed as Record<string, unknown>).model, 'rule-model');

    backend.reset();
    await createDecisionResolver(env)({}).backend.decide(REQUEST);
    assert.equal((only(backend.sent).parsed as Record<string, unknown>).model, 'env-model');
  } finally {
    await backend.close();
  }
});

test('refuses an unknown backend and accepts the supported one', () => {
  const env = withKey({ RK_BACKEND: 'other' });

  thrownBy(() => createDecisionResolver(env)({}));
  assert.doesNotThrow(() => createDecisionResolver(env)({ backend: 'jev' }));
});

test('constructs a resolver without reading provider settings', () => {
  assert.doesNotThrow(() =>
    createDecisionResolver({
      TYPESAFE_API_KEY: '',
      TYPESAFE_BASE_URL: 'not a url',
      TYPESAFE_DEFAULT_MODEL: '   ',
      RK_THRESHOLD: 'abc',
      RK_BACKEND: 'nope',
      RK_INPUT_COST_PER_MILLION: 'invalid',
      RK_OUTPUT_COST_PER_MILLION: 'invalid',
    }),
  );
});

test('requires an API key only when a decision is actually resolved', () => {
  const resolver = createDecisionResolver({});

  assert.match(thrownBy(() => resolver({})).message, /TYPESAFE_API_KEY/, 'the diagnostic must name the missing setting');
});

test('rejects a used environment setting that is blank', () => {
  const cases: readonly { readonly env: TestEnv; readonly name: string }[] = [
    { env: { TYPESAFE_API_KEY: '   ' }, name: 'TYPESAFE_API_KEY' },
    { env: { TYPESAFE_API_KEY: API_KEY, RK_THRESHOLD: '  ' }, name: 'RK_THRESHOLD' },
    { env: { TYPESAFE_API_KEY: API_KEY, TYPESAFE_DEFAULT_MODEL: '' }, name: 'TYPESAFE_DEFAULT_MODEL' },
  ];

  for (const { env, name } of cases) {
    assert.match(thrownBy(() => createDecisionResolver(env)({})).message, new RegExp(name), `a blank ${name} must be rejected`);
  }
});

test('does not consult a blank environment model that a rule model shadows', async () => {
  const backend = await startLoopback();
  try {
    const env = withKey({ TYPESAFE_BASE_URL: backend.origin, TYPESAFE_DEFAULT_MODEL: '  ' });

    await createDecisionResolver(env)({ model: 'rule-model' }).backend.decide(REQUEST);

    assert.equal((only(backend.sent).parsed as Record<string, unknown>).model, 'rule-model');
  } finally {
    await backend.close();
  }
});

test('takes the base URL from the environment only', async () => {
  const backend = await startLoopback();
  try {
    const runtime = createDecisionResolver(withKey({ TYPESAFE_BASE_URL: `${backend.origin}/api` }))({});

    await runtime.backend.decide(REQUEST);

    assert.equal(only(backend.sent).url, '/api/v1/systemone');
  } finally {
    await backend.close();
  }
});

test('rejects an unusable environment base URL when a decision is resolved', () => {
  const error = thrownBy(() => createDecisionResolver(withKey({ TYPESAFE_BASE_URL: 'ftp://example.invalid' }))({}));

  assert.match(error.message, /TYPESAFE_BASE_URL/, 'the diagnostic must name the setting it came from');
  assert.ok(!error.message.includes(API_KEY), 'the diagnostic must not leak the credential');
  assert.doesNotThrow(
    () => createDecisionResolver(withKey({ TYPESAFE_BASE_URL: 'http://127.0.0.1:1' }))({}),
    'the same environment with a usable base URL must resolve',
  );
});
