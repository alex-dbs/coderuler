import { Rule, ai, scopes, test } from 'rulekeeper';

export default class TsNoTinyFunctions extends Rule {
  files = ['**/*.{ts,tsx,mts,cts}'];
  exclude = ['**/*.d.{ts,mts,cts}'];

  scope = scopes.astGrep({
    language: 'typescript',
    rule: {
      kind: 'program',
      has: {
        any: [
          {
            any: [{ kind: 'function_declaration' }, { kind: 'method_definition' }],
            has: { field: 'body', matches: 'single-return' },
          },
          {
            kind: 'variable_declarator',
            all: [
              { has: { field: 'name', kind: 'identifier' } },
              {
                has: {
                  field: 'value',
                  any: [
                    { kind: 'function_expression', has: { field: 'body', matches: 'single-return' } },
                    {
                      kind: 'arrow_function',
                      has: {
                        field: 'body',
                        any: [{ matches: 'single-return' }, { not: { kind: 'statement_block' } }],
                      },
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
    utils: {
      'single-return': {
        kind: 'statement_block',
        has: {
          kind: 'return_statement',
          has: { pattern: '$VALUE' },
          all: [
            { nthChild: { position: 1, ofRule: { not: { kind: 'comment' } } } },
            { nthChild: { position: 1, ofRule: { not: { kind: 'comment' } }, reverse: true } },
          ],
        },
      },
    },
  });

  check = ai({
    rule: `Named local one-expression helpers must add a meaningful contract or behavior, not merely rename an ordinary operation.

A local helper is unnecessary wrapper indirection when its body only forwards a standard operation, property read, primitive conversion, or similarly trivial expression; its visible uses are direct local calls; and replacing those calls with the expression preserves evaluation and behavior. This combination is positive evidence of a violation, even with only one call. A descriptive synonym for the underlying operation is not a domain abstraction by itself.

Apply exceptions to the helper being assessed, not to its enclosing function. A private helper inside an exported function or JSX component is still private: the enclosing export, async signature, or component contract does not turn that helper into a public API. Likewise, ordinary parameter annotations do not create a useful type-level boundary.

Preserve helpers that express real domain concepts or non-obvious formulas, stable public/exported contracts, type predicates that preserve narrowing, callback identity, dependency-injection or test seams, framework/protocol methods, and meaningful repeated behavior that must change together. Preserve wrappers whose removal changes binding, evaluation timing, or another observable property.

Assess each named helper independently. A valid enclosing function does not excuse a needless helper nested inside it. Conversely, a one-expression body or a single visible call alone is not enough: the implementation and uses must establish the redundant forwarding described above.
Use the supplied file to assess local helpers; do not invent unseen callers or identity requirements to excuse a helper whose definition and direct uses are visible. When the file does not establish redundancy, preserve the helper.
Anonymous inline callbacks and multi-statement functions are outside this policy.`,
    examples: {
      good: [
        `type Order = { total: number; paid: number };
export function outstandingBalance(order: Order) {
  return order.total - order.paid;
}`,
        `type User = { name: string };
export function isUser(value: unknown): value is User {
  return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string';
}`,
        `export function watch(button: HTMLButtonElement) {
  const onClick = () => console.log('clicked');
  button.addEventListener('click', onClick);
  return () => button.removeEventListener('click', onClick);
}`,
        `export function secondsUntil(expiry: number, now: () => number = () => Date.now()) {
  return (expiry - now()) / 1000;
}`,
        `export function annuityPayment(principal: number, rate: number, periods: number) {
  return principal * rate / (1 - (1 + rate) ** -periods);
}`,
        `export function buildLinks(origin: string, accountId: string) {
  const accountPath = (suffix: string) => origin + '/accounts/' + encodeURIComponent(accountId) + suffix;
  return { profile: accountPath('/profile'), billing: accountPath('/billing') };
}`,
      ],
      bad: [
        `export function firstLabel(labels: string[]) {
  const getFirst = (items: string[]) => items[0];
  return getFirst(labels);
}`,
        `export function titleLength(title: string) {
  function readLength(value: string) { return value.length; }
  return readLength(title);
}`,
        `export function currentName(record: { name: string }) {
  const getName = function(value: { name: string }) { return value.name; };
  return getName(record);
}`,
      ],
    },
    violationMessage: 'Remove demonstrably unnecessary local wrapper indirection; preserve meaningful small functions.',
  });
}

export const aiTests = [
  test('a local arrow merely forwards trimming at its only call').withFiles({
    'search-query.ts': `export function encodeSearchQuery(query: string) {
  const trim = (value: string) => value.trim();
  const normalized = trim(query);
  return encodeURIComponent(normalized);
}`,
  }).violates(),
  test('a local single-return helper merely forwards number conversion in TSX').withFiles({
    'pending-count.tsx': `export function PendingCount(props: { count: number }) {
  function asText(value: number) {
    return value.toString();
  }
  const text = asText(props.count);
  return <output aria-live="polite">{text}</output>;
}`,
  }).violates(),
  test('a public shipping formula expresses a real domain contract').withFiles({
    'shipping.ts': `export type Parcel = {
  massKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

export function billableWeightKg(parcel: Parcel): number {
  return Math.max(parcel.massKg, parcel.lengthCm * parcel.widthCm * parcel.heightCm / 5000);
}`,
  }).passes(),
  test('a local discriminant guard preserves useful callback type narrowing').withFiles({
    'acknowledgements.ts': `type Packet =
  | { kind: 'ack'; sequence: number }
  | { kind: 'payload'; body: Uint8Array };

export function acknowledgedSequences(packets: readonly Packet[]) {
  function isAcknowledgement(packet: Packet): packet is Extract<Packet, { kind: 'ack' }> {
    return packet.kind === 'ack';
  }
  return packets.filter(isAcknowledgement).map(packet => packet.sequence);
}`,
  }).passes(),
  test('a publicly exported primitive adapter retains its external contract').withFiles({
    'packages/number-format/src/decimal.ts': `export function toDecimalString(value: bigint): string {
  return value.toString(10);
}`,
  }).passes(),
] as const;
