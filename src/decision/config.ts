import { JevAdapter } from './jev.ts';
import { DecisionService } from './service.ts';

/** The backend selected when `RULEKEEPER_DECISION_BACKEND` is unset. */
const DEFAULT_BACKEND = 'jev';

/** The model selected when `RULEKEEPER_DECISION_MODEL` is unset. */
const DEFAULT_MODEL = 'jev-latest';

/**
 * The base URL selected when `RULEKEEPER_DECISION_BASE_URL` is unset: TypeSafe's origin, without a
 * path. The adapter owns the versioned endpoint it appends, so a deployment that overrides this with
 * its own prefix (or its own gateway path) is not required to carry a version segment here.
 */
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

/**
 * Read one setting from an environment. An unset variable is `undefined` and takes its default; a
 * variable set to nothing but blanks is a configuration error instead of a silent default, because
 * an empty value in a deployment means the setting was meant to be provided and was not. Surrounding
 * whitespace is never part of the value, so a key read from a file or a shell keeps no stray newline.
 */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${name} is set but empty`);
  return trimmed;
}

/**
 * Build the decision service one run uses, from the environment read at this call rather than at
 * import, so a caller that never checks a rule never needs a key and a test can point the same
 * factory at its own endpoint.
 *
 * The backend is selected by name — `jev` today, the only one that exists — and each further
 * backend adds its own arm here rather than a registry or a configuration file. The model and the
 * base URL default to TypeSafe's own; the key has no useful default and is required, with the
 * official `TYPESAFE_API_KEY` accepted as the fallback when the rulekeeper-specific name is unset.
 */
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
