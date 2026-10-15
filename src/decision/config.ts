import type { Diagnostics } from '../diagnostics.ts';
import { JevAdapter } from './jev.ts';
import { DecisionService } from './service.ts';
import { DEFAULT_THRESHOLD, parseThreshold, validateThreshold } from './threshold.ts';

const DEFAULT_BACKEND = 'jev';

const DEFAULT_MODEL = 'jev-latest';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${name} is set but empty`);
  return trimmed;
}

interface ResolvedThreshold {
  readonly threshold: number;
  readonly source: 'flag' | 'env' | 'default';
}

function resolveThreshold(env: NodeJS.ProcessEnv, override: number | undefined): ResolvedThreshold {
  if (override !== undefined) return { threshold: validateThreshold(override), source: 'flag' };
  const raw = setting(env, 'RK_THRESHOLD');
  if (raw === undefined) return { threshold: DEFAULT_THRESHOLD, source: 'default' };
  return { threshold: parseThreshold(raw, 'RK_THRESHOLD'), source: 'env' };
}

export function createDecisionService(
  env: NodeJS.ProcessEnv = process.env,
  diagnostics?: Diagnostics,
  thresholdOverride?: number,
): DecisionService {
  const backend = setting(env, 'RK_BACKEND') ?? DEFAULT_BACKEND;
  if (backend !== 'jev') {
    throw new Error(`Unknown decision backend '${backend}'; supported backends: ${DEFAULT_BACKEND}`);
  }

  const model = setting(env, 'TYPESAFE_DEFAULT_MODEL') ?? DEFAULT_MODEL;
  const baseUrl = setting(env, 'TYPESAFE_BASE_URL') ?? DEFAULT_BASE_URL;
  const apiKey = setting(env, 'TYPESAFE_API_KEY');
  if (apiKey === undefined) {
    throw new Error('No decision API key: set TYPESAFE_API_KEY');
  }

  const { threshold, source } = resolveThreshold(env, thresholdOverride);
  diagnostics?.important('decision.threshold', { threshold, source });

  return new DecisionService(new JevAdapter({ model, baseUrl, apiKey }, diagnostics), threshold);
}
