import axios, { type AxiosInstance } from 'axios';
import type { BackendDecision, DecisionBackend, DecisionRequest } from './port.ts';

export interface JevOptions {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

const ENDPOINT = 'v1/systemone';

const QUESTION_ID = 'follows_instructions';

const TIMEOUT_MS = 30_000;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function baseUrlOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Decision base URL (RULEKEEPER_DECISION_BASE_URL) is not an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Decision base URL (RULEKEEPER_DECISION_BASE_URL) must use http or https');
  }
  // A bare `?` or `#` parses to an empty search or hash, yet either delimiter still swallows the
  // path a request appends, so the raw delimiter decides rather than the parsed component. An
  // encoded `%3F` or `%23` is part of the path and stays allowed.
  if (baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new Error('Decision base URL (RULEKEEPER_DECISION_BASE_URL) must not carry a query or a fragment');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Decision base URL (RULEKEEPER_DECISION_BASE_URL) must not embed credentials');
  }
  return baseUrl;
}

function requestFailure(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status !== undefined) return new Error(`Decision request failed with HTTP ${status}`);
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new Error(`Decision request timed out after ${TIMEOUT_MS} ms`);
    }
    // An axios code is a category of its own (`ECONNREFUSED`, `ERR_FR_TOO_MANY_REDIRECTS`); the
    // error's own message is not reused, because it can carry the request URL.
    return new Error(`Decision request failed: ${error.code ?? 'network error'}`);
  }
  return new Error(`Decision request failed: ${error instanceof Error ? error.message : String(error)}`);
}

function readBackendDecision(data: unknown): BackendDecision {
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
  return { probability, model };
}

export class JevAdapter implements DecisionBackend {
  readonly #client: AxiosInstance;
  readonly #model: string;

  constructor({ model, baseUrl, apiKey }: JevOptions) {
    this.#model = model;
    this.#client = axios.create({
      baseURL: baseUrlOf(baseUrl),
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }

  async decide(request: DecisionRequest): Promise<BackendDecision> {
    const body = {
      model: this.#model,
      // The state is data the model reads, not a template this adapter reshapes: it is sent exactly
      // as the service projected it, and it stays distinguishable from the instruction beside it.
      state: request.context,
      questions: {
        [QUESTION_ID]: { type: 'noul', instructions: request.instructions },
      },
    };

    let data: unknown;
    try {
      const response = await this.#client.post<unknown>(ENDPOINT, body);
      data = response.data;
    } catch (error) {
      throw requestFailure(error);
    }
    return readBackendDecision(data);
  }
}
