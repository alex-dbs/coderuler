import { Rule, ai, scopes, test } from 'rulekeeper';

const namedIsRecord = {
  has: { field: 'name', kind: 'identifier', regex: '^isRecord$' },
};
const callable = { any: [{ kind: 'arrow_function' }, { kind: 'function_expression' }] };

export default class TsNoLocalIsRecord extends Rule {
  files = ['**/*.{ts,tsx,mts,cts}'];
  exclude = ['**/*.d.{ts,mts,cts}'];

  scope = scopes.astGrep({
    language: 'typescript',
    rule: {
      kind: 'program',
      has: {
        any: [
          { kind: 'function_declaration', ...namedIsRecord },
          {
            kind: 'variable_declarator',
            all: [
              namedIsRecord,
              {
                has: {
                  field: 'value',
                  any: [
                    callable,
                    {
                      kind: 'parenthesized_expression',
                      has: { ...callable, stopBy: { not: { kind: 'parenthesized_expression' } } },
                    },
                  ],
                },
              },
            ],
          },
        ],
        stopBy: 'end',
      },
    },
  });

  check = ai({
    rule: `Assess the locally defined isRecord functions in this complete TypeScript file, using their implementations, uses, exports, comments, and filepath as evidence.
Report a violation only when visible evidence establishes redundant local recreation of an available equivalent guard, repeated partial validation in place of an established domain validator, or use of a generic Record guard as if it validated a real domain contract.
An object/non-null/non-array check establishes only an object shape, not required properties, property types, or a generic value type. Checking a few fields and asserting the remaining domain contract without validation is also misuse.

Permit one canonical shared or package guard, including an exported generic guard that actually validates its claimed value type. Permit legitimate staged object narrowing followed by the required property checks, and schema validation at a boundary. Do not demand a schema library when explicit property checks validate the contract. A local guard with no established duplication or validation misuse is valid, even if tiny or unexported.
The name isRecord and candidate presence alone are never violations. Do not infer unseen callers, other files' implementations, available shared helpers, or external compatibility constraints. Pass when evidence of duplication or validation misuse is absent. Never recommend replacing validation with a type assertion on unknown input.`,
    examples: {
      good: [
        `// packages/guards/src/is-record.ts: the canonical shared object guard.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}`,
        `function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function readUser(value: unknown): { id: string; active: boolean } {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.active !== 'boolean') {
    throw new Error('Invalid user');
  }
  return { id: value.id, active: value.active };
}`,
        `import { z } from 'zod';
const userSchema = z.object({ id: z.string(), active: z.boolean() });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function readEnvelope(raw: unknown) {
  if (!isRecord(raw)) throw new Error('Invalid envelope');
  return userSchema.parse(raw.user);
}`,
        `export function isRecord<T>(value: unknown, isValue: (item: unknown) => item is T): value is Record<string, T> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(isValue);
}`,
      ],
      bad: [
        `function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function readPayload(value: unknown) {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  return isRecord(value) ? value : undefined;
}
export function readMetadata(value: unknown) {
  return isRecord(value) ? value : undefined;
}`,
        `const isRecord = <T,>(value: unknown): value is Record<string, T> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function readScores(raw: unknown): number[] {
  if (!isRecord<number>(raw)) throw new Error('Invalid scores');
  return Object.values(raw).map(score => score.toFixed(2)).map(Number);
}`,
        `type User = { id: string; active: boolean };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseUser(value: unknown): User {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.active !== 'boolean') {
    throw new Error('Invalid user');
  }
  return { id: value.id, active: value.active };
}
export const canonicalUser = parseUser;
export function readOwner(raw: unknown): User {
  if (!isRecord(raw) || typeof raw.id !== 'string') throw new Error('Invalid owner');
  return raw as User;
}
export function readMember(raw: unknown): User {
  if (!isRecord(raw) || typeof raw.id !== 'string') throw new Error('Invalid member');
  return raw as User;
}`,
      ],
    },
    violationMessage: 'Reuse an established record guard or validate the actual domain contract; an object check alone is not domain validation.',
  });
}

export const aiTests = [
  test('a request reader recreates a visibly available equivalent guard').withFiles({
    'src/http/read-headers.ts': `export function isObjectMap(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function readHeaders(input: unknown): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(input)) throw new Error('Invalid headers');
  return input;
}

export function readQuery(input: unknown): Record<string, unknown> {
  if (!isObjectMap(input)) throw new Error('Invalid query');
  return input;
}`,
  }).violates(),
  test('an object-only generic guard claims unvalidated delivery values').withFiles({
    'src/delivery/read-endpoints.ts': `type Delivery = { enabled: boolean; endpoint: string };

const isRecord = <Value,>(input: unknown): input is Record<string, Value> =>
  input !== null && typeof input === 'object' && !Array.isArray(input);

export function readEndpoints(input: unknown): string[] {
  if (!isRecord<Delivery>(input)) throw new Error('Invalid deliveries');
  return Object.values(input)
    .filter(delivery => delivery.enabled)
    .map(delivery => delivery.endpoint.trim());
}`,
  }).violates(),
  test('an exported canonical guard promises only the object shape it validates').withFiles({
    'packages/value-guards/src/record.ts': `export const isRecord = function (input: unknown): input is Record<string, unknown> {
  if (input === null || Array.isArray(input)) return false;
  return typeof input === 'object';
};

export function ownEntries(input: unknown): [string, unknown][] {
  if (!isRecord(input)) throw new Error('Expected an object');
  return Object.entries(input);
}`,
  }).passes(),
  test('staged narrowing validates every retry-policy property before returning it').withFiles({
    'src/config/retry-policy.ts': `type RetryPolicy = { maxAttempts: number; backoffMs: number };

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function readRetryPolicy(input: unknown): RetryPolicy {
  if (!isRecord(input)) throw new Error('Expected a retry policy object');
  const { maxAttempts, backoffMs } = input;
  if (typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Invalid attempt count');
  }
  if (typeof backoffMs !== 'number' || !Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error('Invalid backoff');
  }
  return { maxAttempts, backoffMs };
}`,
  }).passes(),
] as const;
