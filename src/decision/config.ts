import { JevAdapter } from './jev.ts';
import { DecisionService } from './service.ts';

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

export function createDecisionService(env: NodeJS.ProcessEnv = process.env): DecisionService {
  const backend = setting(env, 'RULEKEEPER_DECISION_BACKEND') ?? DEFAULT_BACKEND;
  if (backend !== 'jev') {
    throw new Error(`Unknown decision backend '${backend}'; supported backends: ${DEFAULT_BACKEND}`);
  }

  const model = setting(env, 'RULEKEEPER_DECISION_MODEL') ?? DEFAULT_MODEL;
  const baseUrl = setting(env, 'RULEKEEPER_DECISION_BASE_URL') ?? DEFAULT_BASE_URL;
  const apiKey = setting(env, 'RULEKEEPER_DECISION_API_KEY') ?? setting(env, 'TYPESAFE_API_KEY');
  if (apiKey === undefined) {
    throw new Error('No decision API key: set RULEKEEPER_DECISION_API_KEY or TYPESAFE_API_KEY');
  }

  return new DecisionService(new JevAdapter({ model, baseUrl, apiKey }));
}
