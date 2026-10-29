import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';

export default class TsSetMap extends Rule {
  enabled = false;
  files = ['**/*.{ts,tsx,mts,cts}'];
  exclude = ['**/*.d.{ts,mts,cts}'];

  scope = scopes.astGrep({
    language: 'typescript',
    rule: {
      kind: 'program',
      has: {
        kind: 'new_expression',
        all: [
          { has: { kind: 'identifier', field: 'constructor', regex: '^(Set|Map)$' } },
          { has: { kind: 'arguments', field: 'arguments', has: { kind: 'array', nthChild: 1 } } },
        ],
        stopBy: 'end',
      },
    },
  });

  check = ai({
    instruction: `Use a typed \`Record\` or object for a small, fixed, string-keyed \`Map\` lookup when it only retrieves values and the simpler form preserves behavior.
Preserve membership checks, mutation, size, clearing, iteration order, and observable allocation or identity.
Keep non-string keys, custom or shadowed constructors, and collections with unknown consumers or external callers.
Before converting a \`Map\`, preserve missing- and duplicate-key behavior, distinguish absent keys from present \`undefined\`, and handle prototype-sensitive string keys safely.
Keep \`Map\` for safe arbitrary-key behavior when no safe object equivalent is clear.`,
    examples: {
      good: [
        `const labels: Record<'ready' | 'busy', string> = { ready: 'Ready', busy: 'Busy' };
export function statusLabel(status: 'ready' | 'busy') {
  return labels[status];
}`,
        `const permissions = new Set<string>(['read']);
export function grant(permission: string) {
  permissions.add(permission);
}
export function permitted(permission: string) {
  return permissions.has(permission);
}`,
        `const reserved = new Set(['__proto__', 'constructor', 'toString']);
export function isReserved(name: string) {
  return reserved.has(name);
}`,
        `const owner = { id: 'owner' };
const counts = new Map([[owner, 1]]);
export function ownerCount() {
  return counts.get(owner);
}`,
        `export const labels = new Map([['ready', 'Ready'], ['busy', 'Busy']]);`,
        `const values = new Map<string, string | undefined>([['unset', undefined]]);
export function contains(key: string) {
  return values.has(key);
}`,
      ],
      bad: [
        `const labels = new Map([['ready', 'Ready'], ['busy', 'Busy']]);
export function statusLabel(status: 'ready' | 'busy') {
  return labels.get(status);
}`,
        `const codes = new Map<string, number>([['success', 200], ['missing', 404]]);
export function responseCode(outcome: 'success' | 'missing') {
  return codes.get(outcome);
}`,
      ],
    },
    violationMessage: 'Use a typed Record or object for this small fixed string-keyed value lookup when collection semantics are unnecessary.',
  });
}

export const aiTests = [
  test('fixed delivery fees need only a string-keyed value lookup').withFiles({
    'delivery.ts': `const deliveryFees = new Map<string, number>([
  ['economy', 4],
  ['courier', 12],
  ['overnight', 25],
]);

export function deliveryFee(method: 'economy' | 'courier' | 'overnight') {
  return deliveryFees.get(method);
}`,
  }).violates(),
  test('membership in retrieved arrays does not require Map semantics').withFiles({
    'service-ports.ts': `const servicePorts = new Map<string, readonly number[]>([
  ['web', [80, 443]],
  ['mail', [25, 587]],
]);

export function supportsPort(service: 'web' | 'mail', port: number) {
  return servicePorts.get(service)?.includes(port) ?? false;
}`,
  }).violates(),
  test('numeric sensor codes retain nonstring key identity').withFiles({
    'sensors.ts': `const sensorUnits = new Map<number, string>([
  [101, 'celsius'],
  [205, 'kilopascals'],
]);

export function sensorUnit(code: number | string) {
  return typeof code === 'number' ? sensorUnits.get(code) : undefined;
}`,
  }).passes(),
  test('present undefined overrides differ from absent prototype-sensitive keys').withFiles({
    'overrides.ts': `const overrides = new Map<string, string | undefined>([
  ['__proto__', undefined],
  ['constructor', 'custom-constructor'],
]);

export function resolveOverride(key: string, fallback: string) {
  return overrides.has(key) ? overrides.get(key) : fallback;
}`,
  }).passes(),
] as const;
