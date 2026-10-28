import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DecisionExchange, DecisionObserver, DecisionRequest, JsonValue } from '../dist/index.js';
import { JevAdapter } from '../dist/adapter/decision/jev.js';
import { OpenAIAdapter } from '../dist/adapter/decision/openai.js';
import { createDecisionResolver } from '../dist/infra/settings.js';
import { startDecisionFixture, type DecisionFixture } from './support.ts';

const API_KEY = 'openai-fixture-key';
const MODEL = 'gpt-6-luna';
const RULE = 'Only accept changes that preserve the public API.';
const QUESTION = 'Is the rule respected?';
const REQUEST: DecisionRequest = {
  state: { filepath: 'src/api.ts', scope: { id: '0:', source: 'export function api(): void {}' } },
  instructions: { rule: RULE, question: QUESTION },
};
const USAGE = { input_tokens: 23, output_tokens: 7 };

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1, `expected exactly one item, saw ${items.length}`);
  return items[0]!;
}

function predicate(probability = 0.9): Record<string, unknown> {
  return { type: 'predicate', name: 'follows_instructions', probability };
}

function response(
  answer: unknown = predicate(),
  options: { readonly model?: unknown; readonly usage?: unknown; readonly includeUsage?: boolean } = {},
): unknown {
  return {
    model: options.model ?? MODEL,
    answers: [answer],
    ...(options.includeUsage === true ? { usage: options.usage } : {}),
  };
}

function reply(body: unknown, status = 200) {
  return { status, body: JSON.stringify(body) };
}

function adapterFor(fixture: DecisionFixture, apiKey = API_KEY): OpenAIAdapter {
  return new OpenAIAdapter({ model: MODEL, baseUrl: `${fixture.baseUrl}/v1`, apiKey });
}

function openAIEnv(
  fixture: DecisionFixture,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    RK_BACKEND: 'openai',
    OPENAI_API_KEY: fixture.apiKey,
    OPENAI_BASE_URL: `${fixture.baseUrl}/v1`,
    ...overrides,
  };
}


function exchangesOf(): { readonly exchanges: DecisionExchange[]; readonly observer: DecisionObserver } {
  const exchanges: DecisionExchange[] = [];
  return { exchanges, observer: (exchange: DecisionExchange) => exchanges.push(exchange) };
}

test('posts a Decisions predicate request and normalizes its named answer and usage', async () => {
  const fixture = await startDecisionFixture();
  fixture.answer = () => reply({
    model: MODEL,
    usage: USAGE,
    answers: [{ type: 'predicate', name: 'other', probability: 0.1 }, predicate(0.73)],
  });
  try {
    const { exchanges, observer } = exchangesOf();
    const outcome = await adapterFor(fixture).decide(REQUEST, observer);

    assert.deepEqual(outcome, {
      probability: 0.73,
      model: MODEL,
      usage: { inputTokens: 23, outputTokens: 7 },
    });

    assert.deepEqual(exchanges.map(exchange => exchange.type), ['request', 'response']);
    const responseEvent = exchanges[1];
    assert.ok(responseEvent?.type === 'response');
    assert.equal(responseEvent.status, 200);
    const responseData = record(JSON.parse(responseEvent.body), 'observed response');
    assert.equal(responseData.model, MODEL);
    assert.deepEqual(responseData.usage, USAGE);
    const sent = only(fixture.requests);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, '/v1/decisions');
    assert.equal(sent.authorization, `Bearer ${API_KEY}`);
    const body = record(sent.body, 'request body');
    assert.equal(body.model, MODEL);
    assert.equal(body.input, JSON.stringify(REQUEST.state));
    assert.deepEqual(JSON.parse(body.input as string), REQUEST.state);

    const questions = body.questions;
    assert.ok(Array.isArray(questions));
    const question = record(questions[0], 'predicate question');
    assert.equal(question.type, 'predicate');
    assert.equal(question.name, 'follows_instructions');
    assert.equal(typeof question.instructions, 'string');
    assert.ok((question.instructions as string).includes(`Rule:\n${RULE}`));
    assert.ok((question.instructions as string).includes(QUESTION));
  } finally {
    await fixture.close();
  }
});

test('JSON-stringifies full scope, group, and scalar decision inputs', async () => {
  const fixture = await startDecisionFixture();
  fixture.answer = () => reply(response());
  try {
    const states: readonly JsonValue[] = [
      {
        scope: { filepath: 'src/a.ts', id: '0:', source: 'function a() {}' },
        group: { name: 'handlers', members: ['src/a.ts', 'src/b.ts'] },
        custom: { count: 3, active: false, optional: null },
      },
      'custom scalar',
      17,
      false,
      null,
      ['nested', 4, true, null],
    ];
    const adapter = adapterFor(fixture);

    for (const [index, state] of states.entries()) {
      await adapter.decide({ state, instructions: REQUEST.instructions });
      const body = record(fixture.requests[index]!.body, `request ${index}`);
      assert.equal(body.input, JSON.stringify(state));
      assert.deepEqual(JSON.parse(body.input as string), state);
    }
  } finally {
    await fixture.close();
  }
});

test('preserves rule policy and example polarity in predicate instructions', async () => {
  const fixture = await startDecisionFixture();
  fixture.answer = () => reply(response());
  try {
    const instructions = {
      rule: 'Every exported handler must return a promise.',
      question: QUESTION,
      examples: {
        good: ['export async function save(): Promise<void> {}'],
        bad: ['export function save(): void {}'],
      },
    };
    await adapterFor(fixture).decide({ state: REQUEST.state, instructions });

    const body = record(only(fixture.requests).body, 'request body');
    assert.ok(Array.isArray(body.questions));
    const question = record(body.questions[0], 'predicate question');
    const text = question.instructions as string;
    assert.ok(text.includes(`Rule:\n${instructions.rule}`));
    assert.ok(text.includes('Good examples (the rule is respected):'));
    assert.ok(text.includes(JSON.stringify(instructions.examples.good)));
    assert.ok(text.includes('Bad examples (the rule is not respected):'));
    assert.ok(text.includes(JSON.stringify(instructions.examples.bad)));
    assert.ok(text.includes(QUESTION));
  } finally {
    await fixture.close();
  }
});

test('rejects missing, refused, wrong-type, and invalid-probability answers', async () => {
  const fixture = await startDecisionFixture();
  const adapter = adapterFor(fixture);
  try {
    const cases: readonly { readonly body: unknown; readonly message: string }[] = [
      { body: { model: MODEL, answers: [] }, message: "Decision response carries no 'follows_instructions' answer" },
      {
        body: response({ type: 'refusal', name: 'follows_instructions', refusal: 'not enough information' }),
        message: "Decision response 'follows_instructions' answer was refused",
      },
      {
        body: response({ type: 'score', name: 'follows_instructions', probability: 0.9 }),
        message: "Decision response 'follows_instructions' answer is not a predicate answer",
      },
      {
        body: response(predicate(-0.01)),
        message: "Decision response 'follows_instructions' answer is not a probability between 0 and 1",
      },
      {
        body: response(predicate(1.01)),
        message: "Decision response 'follows_instructions' answer is not a probability between 0 and 1",
      },
      {
        body: response({ type: 'predicate', name: 'follows_instructions', probability: '0.9' }),
        message: "Decision response 'follows_instructions' answer is not a probability between 0 and 1",
      },
    ];

    for (const { body, message } of cases) {
      fixture.answer = () => reply(body);
      await assert.rejects(() => adapter.decide(REQUEST), { message });
    }
  } finally {
    await fixture.close();
  }
});
test('accepts predicate probabilities at both inclusive bounds', async () => {
  const fixture = await startDecisionFixture();
  try {
    for (const probability of [0, 1]) {
      fixture.answer = () => reply(response(predicate(probability)));
      assert.deepEqual(await adapterFor(fixture).decide(REQUEST), { probability, model: MODEL });
    }
  } finally {
    await fixture.close();
  }
});

test('keeps missing usage absent and rejects malformed usage and invalid response envelopes', async () => {
  const fixture = await startDecisionFixture();
  const adapter = adapterFor(fixture);
  try {
    fixture.answer = () => reply({ model: MODEL, answers: [predicate()] });
    assert.deepEqual(await adapter.decide(REQUEST), { probability: 0.9, model: MODEL });

    for (const usage of [{ input_tokens: 1 }, null, { input_tokens: -1, output_tokens: 0 }]) {
      fixture.answer = () => reply(response(predicate(), { includeUsage: true, usage }));
      await assert.rejects(() => adapter.decide(REQUEST), /usage/i);
    }

    fixture.answer = () => reply([]);
    await assert.rejects(() => adapter.decide(REQUEST), /response/i);
    fixture.answer = () => reply({ model: '   ', answers: [predicate()] });
    await assert.rejects(() => adapter.decide(REQUEST), /model/i);
    fixture.answer = () => reply({ model: MODEL, answers: {} });
    await assert.rejects(() => adapter.decide(REQUEST), /answers/i);
  } finally {
    await fixture.close();
  }
});

test('redacts literal and JSON-escaped keys inside observed input and instructions only', async () => {
  const key = 'loop"back\\key';
  const escapedKey = JSON.stringify(key).slice(1, -1);
  const fixture = await startDecisionFixture();
  fixture.answer = () => reply(response());
  try {
    const state: JsonValue = { literal: key, scope: { source: `token = ${key}` } };
    const instructions = {
      rule: `Do not expose ${key}.`,
      question: QUESTION,
      examples: { good: [key], bad: [`rejected ${key}`] },
    };
    const { exchanges, observer } = exchangesOf();
    await adapterFor(fixture, key).decide({ state, instructions }, observer);

    const request = exchanges.find(exchange => exchange.type === 'request');
    assert.ok(request?.type === 'request');
    const observed = record(JSON.parse(request.body), 'observed request');
    assert.equal(typeof observed.input, 'string');
    assert.deepEqual(JSON.parse(observed.input as string), {
      literal: '[REDACTED]',
      scope: { source: 'token = [REDACTED]' },
    });
    assert.ok(!(observed.input as string).includes(key));
    assert.ok(!(observed.input as string).includes(escapedKey));
    assert.ok(Array.isArray(observed.questions));
    const observedQuestion = record(observed.questions[0], 'observed question');
    assert.ok(!(observedQuestion.instructions as string).includes(key));
    assert.ok(!(observedQuestion.instructions as string).includes(escapedKey));
    assert.ok((observedQuestion.instructions as string).includes('[REDACTED]'));
    assert.ok(!JSON.stringify(exchanges).includes(key));
    assert.ok(!JSON.stringify(exchanges).includes(escapedKey));

    const sent = record(only(fixture.requests).body, 'wire request');
    assert.deepEqual(JSON.parse(sent.input as string), state);
    const wireQuestion = record((sent.questions as unknown[])[0], 'wire question');
    assert.ok((wireQuestion.instructions as string).includes(key));
    assert.ok((wireQuestion.instructions as string).includes(JSON.stringify([key])));
  } finally {
    await fixture.close();
  }
});

test('normalizes HTTP failures and redacts response observation without SDK diagnostics', async () => {
  const fixture = await startDecisionFixture();
  fixture.answer = () => reply({ error: { message: `private detail for ${API_KEY}`, type: 'invalid_api_key' } }, 401);
  try {
    const { exchanges, observer } = exchangesOf();
    await assert.rejects(
      () => adapterFor(fixture).decide(REQUEST, observer),
      error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Decision request failed with HTTP 401');
        assert.ok(!error.message.includes(API_KEY));
        assert.ok(!error.message.includes('private detail'));
        return true;
      },
    );

    assert.deepEqual(exchanges.map(exchange => exchange.type), ['request', 'response']);
    const responseEvent = exchanges[1];
    assert.ok(responseEvent?.type === 'response');
    assert.equal(responseEvent.status, 401);
    assert.ok(responseEvent.body.includes('[REDACTED]'));
    assert.ok(!responseEvent.body.includes(API_KEY));
    assert.ok(!responseEvent.body.includes('Authorization'));
  } finally {
    await fixture.close();
  }
});

test('normalizes connection failures without emitting a response event', { timeout: 5_000 }, async () => {
  const fixture = await startDecisionFixture();
  let closed = false;
  try {
    await fixture.close();
    closed = true;
    const { exchanges, observer } = exchangesOf();
    await assert.rejects(
      () => adapterFor(fixture).decide(REQUEST, observer),
      error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Decision request failed: network error');
        return true;
      },
    );
    assert.deepEqual(exchanges.map(exchange => exchange.type), ['request']);
  } finally {
    if (!closed) await fixture.close();
  }
});

test('validates OpenAI base URLs before constructing a client', () => {
  const invalid = [
    'not a URL',
    'ftp://example.invalid',
    'https://api.openai.com/v1?key=secret',
    'https://api.openai.com/v1#fragment',
    'https://user:secret@api.openai.com/v1',
  ];
  for (const baseUrl of invalid) {
    assert.throws(
      () => new OpenAIAdapter({ model: MODEL, baseUrl, apiKey: API_KEY }),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /OPENAI_BASE_URL/);
        assert.ok(!error.message.includes(baseUrl));
        assert.ok(!error.message.includes(API_KEY));
        return true;
      },
    );
  }
  assert.doesNotThrow(() => new OpenAIAdapter({ model: MODEL, baseUrl: 'https://api.openai.com/v1', apiKey: API_KEY }));
});

test('keeps concurrent Decisions calls and observer exchanges local to each call', async () => {
  const fixture = await startDecisionFixture({ hold: true });
  fixture.answer = request => {
    const body = record(request.body, 'held request');
    const state = record(JSON.parse(body.input as string), 'request input');
    return reply(response(predicate(state.id === 'first' ? 0.91 : 0.12), { model: `model-${state.id}` }));
  };
  try {
    const adapter = adapterFor(fixture);
    const first = exchangesOf();
    const second = exchangesOf();
    const firstRequest: DecisionRequest = { ...REQUEST, state: { id: 'first' } };
    const secondRequest: DecisionRequest = { ...REQUEST, state: { id: 'second' } };
    const pending = [
      adapter.decide(firstRequest, first.observer),
      adapter.decide(secondRequest, second.observer),
    ];
    await fixture.waitForRequests(2);
    assert.deepEqual(first.exchanges.map(exchange => exchange.type), ['request']);
    assert.deepEqual(second.exchanges.map(exchange => exchange.type), ['request']);
    fixture.releaseAll();
    const [firstOutcome, secondOutcome] = await Promise.all(pending);

    assert.deepEqual(firstOutcome, { probability: 0.91, model: 'model-first' });
    assert.deepEqual(secondOutcome, { probability: 0.12, model: 'model-second' });
    assert.deepEqual(first.exchanges.map(exchange => exchange.type), ['request', 'response']);
    assert.deepEqual(second.exchanges.map(exchange => exchange.type), ['request', 'response']);
    assert.ok(first.exchanges.every(exchange => !JSON.stringify(exchange).includes('second')));
    assert.ok(second.exchanges.every(exchange => !JSON.stringify(exchange).includes('first')));
  } finally {
    fixture.releaseAll();
    await fixture.close();
  }
});

test('selects OpenAI via RK_BACKEND and keeps Jev as the default with rule overrides', async () => {
  const fixture = await startDecisionFixture();
  fixture.answer = request => request.path.endsWith('/decisions')
    ? reply(response(predicate(0.8)))
    : reply({
      model: 'jev-response',
      answers: { follows_instructions: { type: 'noul', noul: 0.6 } },
    });
  try {
    const jevEnv = {
      TYPESAFE_API_KEY: 'jev-key',
      TYPESAFE_BASE_URL: fixture.baseUrl,
      TYPESAFE_DEFAULT_MODEL: 'jev-custom',
    };
    assert.ok(createDecisionResolver(jevEnv)({}).backend instanceof JevAdapter, 'Jev remains the default');

    const selectedOpenAI = createDecisionResolver({
      ...openAIEnv(fixture),
      ...jevEnv,
    })({});
    assert.ok(selectedOpenAI.backend instanceof OpenAIAdapter);
    assert.equal(selectedOpenAI.threshold, 0.4);
    await selectedOpenAI.backend.decide(REQUEST);
    assert.equal(fixture.requests.at(-1)?.path, '/v1/decisions');

    const ruleSelectsJev = createDecisionResolver(openAIEnv(fixture, jevEnv))({ backend: 'jev' });
    assert.ok(ruleSelectsJev.backend instanceof JevAdapter);
    await ruleSelectsJev.backend.decide(REQUEST);
    assert.equal(fixture.requests.at(-1)?.path, '/v1/systemone');

    const ruleSelectsOpenAI = createDecisionResolver({
      RK_BACKEND: 'jev',
      ...jevEnv,
      OPENAI_API_KEY: API_KEY,
      OPENAI_BASE_URL: `${fixture.baseUrl}/v1`,
    })({ backend: 'openai' });
    assert.ok(ruleSelectsOpenAI.backend instanceof OpenAIAdapter);
    await ruleSelectsOpenAI.backend.decide(REQUEST);
    assert.equal(fixture.requests.at(-1)?.path, '/v1/decisions');
  } finally {
    await fixture.close();
  }
});

test('rejects unknown environment backends with the supported values', () => {
  assert.throws(
    () => createDecisionResolver({ RK_BACKEND: 'other' })({}),
    { message: "Unknown decision backend 'other'; supported backends: jev, openai" },
  );
});

test('uses selected-provider model and pricing defaults while preserving override precedence', async () => {
  const fixture = await startDecisionFixture();
  fixture.answer = request => request.path.endsWith('/decisions')
    ? reply(response(predicate()))
    : reply({ model: 'jev-response', answers: { follows_instructions: { type: 'noul', noul: 0.9 } } });
  try {
    const defaults = createDecisionResolver(openAIEnv(fixture))({});
    assert.equal(defaults.threshold, 0.4);
    assert.deepEqual(defaults.pricing, { inputCostPerMillion: 0.1, outputCostPerMillion: 0 });
    assert.ok(defaults.backend instanceof OpenAIAdapter);
    await defaults.backend.decide(REQUEST);
    assert.equal(record(fixture.requests.at(-1)!.body, 'default request').model, 'gpt-6-luna');

    const env = openAIEnv(fixture, {
      OPENAI_DEFAULT_MODEL: ' env-model ',
      RK_THRESHOLD: '0.8',
      RK_INPUT_COST_PER_MILLION: '1.5',
      RK_OUTPUT_COST_PER_MILLION: '2.5',
    });
    const fromEnvironment = createDecisionResolver(env)({});
    assert.equal(fromEnvironment.threshold, 0.8);
    assert.deepEqual(fromEnvironment.pricing, { inputCostPerMillion: 1.5, outputCostPerMillion: 2.5 });
    await fromEnvironment.backend.decide(REQUEST);
    assert.equal(record(fixture.requests.at(-1)!.body, 'environment request').model, 'env-model');

    const fromRule = createDecisionResolver(env)({
      model: 'rule-model',
      threshold: 0.6,
      inputCostPerMillion: 3,
      outputCostPerMillion: 4,
    });
    assert.equal(fromRule.threshold, 0.6);
    assert.deepEqual(fromRule.pricing, { inputCostPerMillion: 3, outputCostPerMillion: 4 });
    await fromRule.backend.decide(REQUEST);
    assert.equal(record(fixture.requests.at(-1)!.body, 'rule request').model, 'rule-model');

    const fromInspection = createDecisionResolver(env, 0.7, {
      inputCostPerMillion: 5,
      outputCostPerMillion: 6,
    })({ threshold: 0.5, inputCostPerMillion: 7, outputCostPerMillion: 8 });
    assert.equal(fromInspection.threshold, 0.7);
    assert.deepEqual(fromInspection.pricing, { inputCostPerMillion: 5, outputCostPerMillion: 6 });
  } finally {
    await fixture.close();
  }
});

test('reads only selected-provider settings and resolves OpenAI keys and settings lazily', async () => {
  const fixture = await startDecisionFixture();
  fixture.answer = () => reply(response());
  try {
    const openAISelected = createDecisionResolver(openAIEnv(fixture, {
      OPENAI_DEFAULT_MODEL: ' openai-env-model ',
      TYPESAFE_API_KEY: ' ',
      TYPESAFE_BASE_URL: 'not a URL',
      TYPESAFE_DEFAULT_MODEL: ' ',
    }))({});
    assert.ok(openAISelected.backend instanceof OpenAIAdapter);
    await openAISelected.backend.decide(REQUEST);
    assert.equal(fixture.requests.at(-1)?.authorization, `Bearer ${fixture.apiKey}`);
    assert.equal(record(fixture.requests.at(-1)!.body, 'OpenAI request').model, 'openai-env-model');

    const jevSelected = createDecisionResolver({
      RK_BACKEND: 'jev',
      TYPESAFE_API_KEY: API_KEY,
      TYPESAFE_BASE_URL: fixture.baseUrl,
      OPENAI_API_KEY: ' ',
      OPENAI_BASE_URL: 'not a URL',
      OPENAI_DEFAULT_MODEL: ' ',
    })({});
    assert.ok(jevSelected.backend instanceof JevAdapter);

    const missingKey = createDecisionResolver({ RK_BACKEND: 'openai' });
    assert.doesNotThrow(() => createDecisionResolver({ RK_BACKEND: 'openai' }));
    assert.throws(() => missingKey({}), { message: 'No decision API key: set OPENAI_API_KEY' });

    const blankKey = createDecisionResolver(openAIEnv(fixture, { OPENAI_API_KEY: '   ' }));
    assert.throws(() => blankKey({}), /OPENAI_API_KEY is set but empty/);

    const blankBase = createDecisionResolver(openAIEnv(fixture, { OPENAI_BASE_URL: ' ' }));
    assert.throws(() => blankBase({}), /OPENAI_BASE_URL is set but empty/);

    const blankModel = createDecisionResolver(openAIEnv(fixture, { OPENAI_DEFAULT_MODEL: ' ' }));
    assert.throws(() => blankModel({}), /OPENAI_DEFAULT_MODEL is set but empty/);
    assert.doesNotThrow(() => blankModel({ model: 'rule-model' }), 'a rule model override shadows the environment model');
  } finally {
    await fixture.close();
  }
});
