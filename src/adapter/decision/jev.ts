import axios, { type AxiosInstance } from 'axios';

import type {
  DecisionBackend,
  DecisionObserver,
  DecisionOutcome,
  DecisionRequest,
} from '../../app/ports.js';

export interface JevOptions {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

const ENDPOINT = 'v1/systemone';
const QUESTION_ID = 'follows_instructions';
const TIMEOUT_MS = 30_000;
const REDACTED = '[REDACTED]';
const URL_LABEL = 'Decision base URL (TYPESAFE_BASE_URL)';

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function requestFailure(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status !== undefined) {
      return new Error(`Decision request failed with HTTP ${status}`);
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new Error(`Decision request timed out after ${TIMEOUT_MS} ms`);
    }
    const code = error.code;
    return code === undefined
      ? new Error('Decision request failed: network error')
      : new Error(`Decision request failed: ${code}`);
  }
  return new Error(`Decision request failed: ${error instanceof Error ? error.message : String(error)}`);
}

function readDecision(data: unknown): DecisionOutcome {
  if (!isMapping(data)) {
    throw new Error('Decision response is not a JSON object');
  }
  const model = data.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('Decision response carries no model');
  }
  if (!isMapping(data.answers)) {
    throw new Error('Decision response carries no answers');
  }
  const answer = data.answers[QUESTION_ID];
  if (!isMapping(answer)) {
    throw new Error(`Decision response carries no '${QUESTION_ID}' answer`);
  }
  if (answer.type !== 'noul') {
    throw new Error(`Decision response '${QUESTION_ID}' answer is not a noul answer`);
  }
  const probability = answer.noul;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`Decision response '${QUESTION_ID}' answer is not a probability between 0 and 1`);
  }
  const rawUsage = data.usage;
  if (rawUsage === undefined) return { probability, model };
  if (!isMapping(rawUsage)) throw new Error('Decision response usage must be an object');
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

export class JevAdapter implements DecisionBackend {
  readonly #client: AxiosInstance;
  readonly #model: string;
  readonly #needles: readonly string[];

  constructor({ model, baseUrl, apiKey }: JevOptions) {
    this.#model = model;
    this.#needles = redactionNeedles(apiKey);
    this.#client = axios.create({
      baseURL: baseUrlOf(baseUrl),
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }

  async decide(request: DecisionRequest, observer?: DecisionObserver): Promise<DecisionOutcome> {
    const body = {
      model: this.#model,
      state: request.state,
      questions: {
        [QUESTION_ID]: { type: 'noul', instructions: request.instructions },
      },
    };

    const wire = JSON.stringify(body);
    observer?.({ type: 'request', body: redact(wire, this.#needles) });

    let data: unknown;
    try {
      const response = await this.#client.post<unknown>(ENDPOINT, wire, {
        headers: { 'Content-Type': 'application/json' },
      });
      data = response.data;
      observer?.({ type: 'response', status: response.status, body: redact(JSON.stringify(data) ?? '', this.#needles) });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response !== undefined) {
        observer?.({
          type: 'response',
          status: error.response.status,
          body: redact(JSON.stringify(error.response.data) ?? '', this.#needles),
        });
      }
      throw requestFailure(error);
    }

    return readDecision(data);
  }
}
