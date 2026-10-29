import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';

export default class TsNoDeprecatedLeftovers extends Rule {
  enabled = false;
  files = ['**/*.{ts,tsx,mts,cts}'];
  exclude = ['**/*.d.{ts,mts,cts}'];

  scope = scopes.astGrep({
    language: 'typescript',
    rule: {
      kind: 'program',
      has: {
        kind: 'comment',
        all: [
          { regex: '^/\\*\\*[^*]' },
          { regex: '(?:^/\\*\\*[ \\t]*|[\\r\\n][ \\t]*\\*?[ \\t]*)@deprecated(?:[ \\t\\r\\n]|\\*/)' },
        ],
        stopBy: 'end',
      },
    },
  });

  check = ai({
    instruction: `Remove obsolete unexported deprecated aliases and forwarding wrappers after completing the internal migration, even when no local callers remain.
Use comments, definitions, and replacement uses in this file to establish that the migration is complete; do not infer callers or migration status from other files.
Keep public symbols during a supported migration window, third-party declarations, and deprecated symbols that still contain their implementation.`,
    examples: {
      good: [
        `export function parseConfig(text: string) { return JSON.parse(text); }
/**
 * @deprecated Use parseConfig. Public SDK consumers may still use readConfig
 * throughout version 2; remove only in the announced version 3 breaking release.
 */
export function readConfig(text: string) { return parseConfig(text); }`,
        `function normalizeName(name: string) { return name.trim(); }
/** @deprecated The public oldName API remains supported until version 4. */
function oldName(name: string) { return normalizeName(name); }
// Intentional compatibility test for the supported public migration window.
it('keeps the old API compatible', () => {
  expect(oldName(' Ada ')).toBe(normalizeName(' Ada '));
});`,
        `// Ambient declaration supplied by a third-party integration; we do not own its API.
/** @deprecated Upstream recommends createSession instead. */
declare function openSession(): unknown;
export function connect() { return openSession(); }`,
        `/** @deprecated Prefer the new streaming API for future integrations. */
export function readAll(chunks: readonly string[]) { return chunks.join(''); }`,
      ],
      bad: [
        `function parseConfig(text: string) { return JSON.parse(text); }
// This module is private. Its refactor is complete; every internal caller now uses parseConfig.
/** @deprecated Temporary pre-refactor name; no compatibility contract remains. */
const readConfig = parseConfig;
export function load(text: string) { return parseConfig(text); }`,
        `function normalizeName(name: string) { return name.trim(); }
// Private implementation: the internal rename is complete, with no supported transition.
/** @deprecated Left behind from the completed internal rename. */
function cleanName(name: string) { return normalizeName(name); }
export function greet(name: string) { return 'Hello ' + normalizeName(name); }`,
      ],
    },
    violationMessage: 'Complete the established internal migration and remove the obsolete deprecated alias or wrapper.',
  });
}

export const aiTests = [
  test('a private alias remains after the scheduler key rename is complete').withFiles({
    'src/internal/scheduler/job-key.ts': `function canonicalJobKey(queue: string, name: string) {
  return queue + ':' + name.trim().toLowerCase().replace(/\\s+/g, '-');
}

// Scheduler-private helpers. The key rename is complete; both entry points use canonicalJobKey.
/** @deprecated Former internal name retained from the completed scheduler refactor. */
const getJobName = canonicalJobKey;

export function scheduledJobKey(queue: string, name: string) {
  return canonicalJobKey(queue, name);
}

export function retryJobKey(queue: string, name: string, attempt: number) {
  return canonicalJobKey(queue, name) + ':retry:' + attempt;
}`,
  }).violates(),
  test('a private forwarding wrapper remains after all local callers migrate').withFiles({
    'src/internal/worker/backoff.ts': `function retryDelay(attempt: number, baseMs: number) {
  return Math.min(baseMs * 2 ** attempt, 30_000);
}

// Private worker implementation; the retry-delay rename is complete in this module.
/** @deprecated Old internal spelling from before the retryDelay rename. */
function waitTime(attempt: number, baseMs: number) {
  return retryDelay(attempt, baseMs);
}

export function nextAttempt(attempt: number, baseMs: number, now: number) {
  return { attempt: attempt + 1, readyAt: now + retryDelay(attempt, baseMs) };
}

export function retrySchedule(count: number, baseMs: number) {
  return Array.from({ length: count }, (_, attempt) => retryDelay(attempt, baseMs));
}`,
  }).violates(),
  test('a public download URL wrapper remains supported during its migration window').withFiles({
    'packages/storage-sdk/src/downloads.ts': `export function downloadUrl(objectId: string, options: { expiresIn: number }) {
  return '/downloads/' + encodeURIComponent(objectId) + '?ttl=' + options.expiresIn;
}

/**
 * @deprecated Use downloadUrl with an options object.
 * SDK 5 integrations and third-party storage adapters use the positional signature.
 * It remains supported through SDK 5.x and will be removed in the SDK 6 breaking release.
 */
export function getDownloadLink(objectId: string, expiresIn: number) {
  return downloadUrl(objectId, { expiresIn });
}`,
  }).passes(),
  test('a deprecated credential decoder still contains its real implementation').withFiles({
    'packages/auth/src/legacy-credentials.ts': `/**
 * @deprecated New integrations should send bearer tokens instead of legacy credentials.
 */
export function decodeLegacyCredentials(header: string): { user: string; secret: string } {
  if (!header.startsWith('Legacy ')) {
    throw new Error('Expected a Legacy credential header');
  }
  const payload = decodeURIComponent(header.slice(7));
  const separator = payload.indexOf(':');
  if (separator < 1) {
    throw new Error('Missing credential separator');
  }
  return { user: payload.slice(0, separator), secret: payload.slice(separator + 1) };
}`,
  }).passes(),
] as const;
