import { JevAdapter } from '../adapter/decision/jev.js';
import type { DecisionRuntime } from '../app/ports.js';
import type { RuleSettings } from '../app/rule.js';

const DEFAULT_BACKEND = 'jev';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_THRESHOLD = 0.4;
const THRESHOLD_MESSAGE = 'must be a number between 0 and 1';
const DECIMAL = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;

type Env = Readonly<Record<string, string | undefined>>;

function validateThreshold(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} ${THRESHOLD_MESSAGE}, got ${String(value)}`);
  }
  return value;
}

function parseThreshold(value: string, label: string): number {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) throw new RangeError(`${label} ${THRESHOLD_MESSAGE}, got ${JSON.stringify(value)}`);
  return validateThreshold(Number(trimmed), label);
}

function setting(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${name} is set but empty`);
  return trimmed;
}

export function createDecisionResolver(
  env: Env,
  thresholdOverride?: number,
): (settings: RuleSettings) => DecisionRuntime {
  const flagThreshold = thresholdOverride === undefined ? undefined : validateThreshold(thresholdOverride, '--threshold');

  return settings => {
    const backend = settings.backend ?? setting(env, 'RK_BACKEND') ?? DEFAULT_BACKEND;
    if (backend !== 'jev') {
      throw new Error(`Unknown decision backend '${backend}'; supported backends: ${DEFAULT_BACKEND}`);
    }

    let threshold: number;
    if (flagThreshold !== undefined) {
      threshold = flagThreshold;
    } else if (settings.threshold !== undefined) {
      threshold = validateThreshold(settings.threshold, 'rule.settings.threshold');
    } else {
      const raw = setting(env, 'RK_THRESHOLD');
      threshold = raw === undefined ? DEFAULT_THRESHOLD : parseThreshold(raw, 'RK_THRESHOLD');
    }

    const model = settings.model ?? setting(env, 'TYPESAFE_DEFAULT_MODEL') ?? DEFAULT_MODEL;
    const baseUrl = setting(env, 'TYPESAFE_BASE_URL') ?? DEFAULT_BASE_URL;
    const apiKey = setting(env, 'TYPESAFE_API_KEY');
    if (apiKey === undefined) {
      throw new Error('No decision API key: set TYPESAFE_API_KEY');
    }

    return { backend: new JevAdapter({ model, baseUrl, apiKey }), threshold };
  };
}
