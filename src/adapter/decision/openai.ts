import type OpenAI from 'openai';

import type {
  DecisionBackend,
  DecisionObserver,
  DecisionOutcome,
  DecisionRequest,
} from '../../app/ports.js';
import { isRecord } from '../../app/validate.js';

export interface OpenAIOptions {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

const QUESTION_NAME = 'follows_instructions';
const TIMEOUT_MS = 30_000;
const REDACTED = '[REDACTED]';
const URL_LABEL = 'Decision base URL (OPENAI_BASE_URL)';

function baseUrlOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${URL_LABEL} is not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${URL_LABEL} must use http or https`);
  }
  if (baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new Error(`${URL_LABEL} must not carry a query or a fragment`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${URL_LABEL} must not embed credentials`);
  }
  return baseUrl;
}

function redactionNeedles(apiKey: string): readonly string[] {
  if (apiKey === '') return [];
  const escaped = JSON.stringify(apiKey).slice(1, -1);
  return escaped === apiKey ? [apiKey] : [escaped, apiKey];
}

function redact(text: string, needles: readonly string[]): string {
  let redacted = text;
  for (const needle of needles) redacted = redacted.replaceAll(needle, REDACTED);
  return redacted;
}

function formattedInstructions(request: DecisionRequest): string {
  const { rule, question, examples } = request.instructions;
  const sections = [`Rule:\n${rule}`];
  if (examples?.good !== undefined && examples.good.length > 0) {
    sections.push(`Good examples (the rule is respected):\n${JSON.stringify(examples.good)}`);
  }
  if (examples?.bad !== undefined && examples.bad.length > 0) {
    sections.push(`Bad examples (the rule is not respected):\n${JSON.stringify(examples.bad)}`);
  }
  sections.push(question);
  return sections.join('\n\n');
}

function readDecision(data: unknown): DecisionOutcome {
  if (!isRecord(data)) throw new Error('Decision response is not a JSON object');
  const model = data.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('Decision response carries no model');
  }
  const answers = data.answers;
  if (!Array.isArray(answers)) throw new Error('Decision response carries no answers');
  const answer: unknown = answers.find(
    (candidate: unknown) => isRecord(candidate) && candidate.name === QUESTION_NAME,
  );
  if (!isRecord(answer)) {
    throw new Error(`Decision response carries no '${QUESTION_NAME}' answer`);
  }
  if (answer.type === 'refusal') {
    throw new Error(`Decision response '${QUESTION_NAME}' answer was refused`);
  }
  if (answer.type !== 'predicate') {
    throw new Error(`Decision response '${QUESTION_NAME}' answer is not a predicate answer`);
  }
  const probability = answer.probability;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`Decision response '${QUESTION_NAME}' answer is not a probability between 0 and 1`);
  }
  const rawUsage = data.usage;
  if (rawUsage === undefined) return { probability, model };
  if (!isRecord(rawUsage)) throw new Error('Decision response usage must be an object');
  const inputTokens = rawUsage.input_tokens;
  const outputTokens = rawUsage.output_tokens;
  if (
    typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
    typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 0
  ) {
    throw new Error('Decision response usage must carry nonnegative safe integer input_tokens and output_tokens');
  }
  return { probability, model, usage: { inputTokens, outputTokens } };
}


export class OpenAIAdapter implements DecisionBackend {
  #client: OpenAI | undefined;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #needles: readonly string[];

  constructor({ model, baseUrl, apiKey }: OpenAIOptions) {
    this.#model = model;
    this.#baseUrl = baseUrlOf(baseUrl);
    this.#apiKey = apiKey;
    this.#needles = redactionNeedles(apiKey);
  }

  async decide(request: DecisionRequest, observer?: DecisionObserver): Promise<DecisionOutcome> {
    const payload = {
      model: this.#model,
      input: JSON.stringify(request.state)!,
      questions: [{
        type: 'predicate' as const,
        name: QUESTION_NAME,
        instructions: formattedInstructions(request),
      }],
    };
    const observedPayload = {
      ...payload,
      input: redact(payload.input, this.#needles),
      questions: payload.questions.map(question => ({
        ...question,
        instructions: redact(question.instructions, this.#needles),
      })),
    };
    observer?.({
      type: 'request',
      body: redact(JSON.stringify(observedPayload), this.#needles),
    });

    // Load the SDK only when an AI decision runs, matching Jev's lazy provider dependency.
    const sdk = await import('openai');
    let data: unknown;
    let status: number;
    try {
      const client = this.#client ??= new sdk.default({
        apiKey: this.#apiKey,
        baseURL: this.#baseUrl,
        timeout: TIMEOUT_MS,
        maxRetries: 2,
        fetchOptions: { redirect: 'manual' },
        logLevel: 'off',
        defaultHeaders: { Authorization: `Bearer ${this.#apiKey}` },
      });
      const result = await client.decisions.create(payload).withResponse();
      data = result.data;
      status = result.response.status;
    } catch (error) {
      if (error instanceof sdk.APIError && error.status !== undefined) {
        const body = error.error === undefined ? error.message : JSON.stringify(error.error) ?? error.message;
        observer?.({ type: 'response', status: error.status, body: redact(body, this.#needles) });
        throw new Error(`Decision request failed with HTTP ${error.status}`);
      }
      if (error instanceof sdk.APIConnectionTimeoutError) {
        throw new Error(`Decision request timed out after ${TIMEOUT_MS} ms`);
      }
      if (error instanceof sdk.APIConnectionError) {
        throw new Error('Decision request failed: network error');
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Decision request failed: ${redact(message, this.#needles)}`);
    }

    observer?.({
      type: 'response',
      status,
      body: redact(JSON.stringify(data) ?? '', this.#needles),
    });
    return readDecision(data);
  }
}
