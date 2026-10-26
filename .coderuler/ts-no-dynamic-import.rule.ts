import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';

export default class TsNoDynamicImport extends Rule {
  files = ['**/*.{ts,tsx,mts,cts}'];
  exclude = ['**/*.d.{ts,mts,cts}'];

  scope = scopes.astGrep({
    language: 'typescript',
    rule: {
      kind: 'program',
      has: {
        kind: 'call_expression',
        all: [
          { has: { kind: 'import', field: 'function' } },
          {
            has: {
              kind: 'arguments',
              field: 'arguments',
              has: {
                any: [
                  { kind: 'string' },
                  { kind: 'template_string', not: { has: { kind: 'template_substitution' } } },
                ],
                nthChild: { position: 1, ofRule: { not: { kind: 'comment' } } },
              },
            },
          },
        ],
        inside: {
          kind: 'await_expression',
          stopBy: { not: { kind: 'parenthesized_expression' } },
        },
        stopBy: 'end',
      },
    },
  });

  check = ai({
    rule: `Use top-level static imports for known module dependencies unless dynamic loading preserves a meaningful loading or initialization boundary visible in the file.
Assess only directly awaited imports, possibly through parentheses, whose first argument is a string literal or a template literal without substitutions.

First distinguish type dependencies from runtime loading. TypeScript's import type declarations do not execute the imported module. If the only existing import of a dependency is type-only, its awaited import is still the first runtime load. A feature flag or early return that avoids this first load, especially to avoid initialization side effects, is a legitimate loading boundary and respects this rule. Repeating a module path in a type import and a runtime import is not redundant loading.

An awaited import that merely retrieves exports from the same module specifier already loaded by a runtime static import in this file is redundant and violates this rule. The dependency is already eagerly loaded, even if the static and dynamic imports retrieve different exports. An enclosing exported or async function does not make that dependency lazy. Keep public async signatures; replacing the redundant import does not require making the function synchronous.
An existing runtime import is concrete evidence, not an unknown loading requirement: do not excuse redundancy by speculating about unseen callers or hypothetical initialization effects. A feature flag around a second import cannot make an already runtime-loaded dependency lazy.

Preserve intentional lazy loading or code splitting of dependencies that have not already been eagerly loaded, optional dependencies with failure handling, platform-specific modules, initialization-order or cycle constraints, and tests genuinely exercising fresh module initialization or mocking boundaries. A visible fresh-loading boundary or different import attributes can justify a dynamic import even when another import exists.
Apply an exception only when the supplied file supports that loading behavior. Merely putting a literal import inside a function, retaining an async API, or fetching another export from an already loaded dependency is not such an exception.

For other literal imports, report a violation when visible evidence establishes unnecessary deferred loading and an equivalent static import preserves intended behavior. If that evidence is absent, preserve the import rather than inventing module side effects or a loading contract.
Ignore import types, static imports themselves, computed specifiers, and imports not directly awaited.`,
    examples: {
      good: [
        `// Load the editor's large dependency only after the user opens it.
export async function openEditor(host: HTMLElement) {
  const { mount } = await import('./heavy-editor.js');
  return mount(host);
}`,
        `export async function readClipboard() {
  if (process.platform !== 'darwin') return undefined;
  // This optional native dependency is installed only on macOS.
  try {
    const { read } = await import('macos-native-clipboard');
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}`,
        `import { expect, test, vi } from 'vitest';
test('configuration is read at module initialization', async () => {
  vi.resetModules();
  vi.stubEnv('FEATURE_ENABLED', 'true');
  try {
    const { enabled } = await import('./feature-config.js');
    expect(enabled).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});`,
        `import type { Preview } from './preview-engine.js';
export async function openPreview(requested: boolean, text: string): Promise<Preview | undefined> {
  if (!requested) return;
  // The engine registers process hooks at initialization; load it only when preview is requested.
  const { renderPreview } = await import('./preview-engine.js');
  return renderPreview(text);
}`,
      ],
      bad: [
        `import { dirname } from 'node:path';
// node:path is already eagerly loaded; this wrapper has no loading boundary.
export async function fileName(filepath: string) {
  const { basename } = await import('node:path');
  return { directory: dirname(filepath), name: basename(filepath) };
}`,
        `import { createHash } from 'node:crypto';
export function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
// The same built-in is already loaded and used above.
export async function sha512(text: string) {
  const { createHash } = await import('node:crypto');
  return createHash('sha512').update(text).digest('hex');
}`,
        `import { buildVersion } from './image-tools.js';
export const imageToolsVersion = buildVersion;
export async function thumbnail(enabled: boolean, input: Uint8Array) {
  if (!enabled) return;
  const { resize } = await import('./image-tools.js');
  return resize(input);
}`,
      ],
    },
    violationMessage: 'Use a static import when deferred module loading serves no purpose and eager loading preserves the intended behavior.',
  });
}

export const aiTests = [
  test('asset URLs reload a built-in already used for installation paths').withFiles({
    'assets.ts': `import { fileURLToPath } from 'node:url';

export const installationDirectory = fileURLToPath(new URL('.', import.meta.url));

export async function assetUrl(filepath: string) {
  const { pathToFileURL } = await import('node:url');
  return pathToFileURL(filepath).href;
}`,
  }).violates(),
  test('support details reload the operating system module used at startup').withFiles({
    'support.ts': `import { hostname } from 'node:os';

export const machine = hostname();

export async function supportDetails() {
  const { platform, release } = await import('node:os');
  return { machine, platform: platform(), release: release() };
}`,
  }).violates(),
  test('an optional Linux battery integration tolerates an absent dependency').withFiles({
    'battery.ts': `export async function batteryStatus() {
  if (process.platform !== 'linux') return undefined;
  // Desktop installations may include this optional native integration.
  try {
    const { readBattery } = await import('linux-battery-status');
    return readBattery();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}`,
  }).passes(),
  test('telemetry connects only after the user enables collection').withFiles({
    'telemetry.ts': `export async function reportUsage(enabled: boolean, event: string) {
  if (!enabled) return;
  // Evaluating the runtime opens a connection; consent must come first.
  const { record } = await import('./telemetry-runtime.js');
  record(event);
}`,
    'telemetry-runtime.ts': `import { createConnection } from 'node:net';

const connection = createConnection({ host: '127.0.0.1', port: 4317 });
connection.on('error', (error) => console.error('Telemetry unavailable:', error.message));

export function record(event: string) {
  connection.write(JSON.stringify({ event }) + '\\n');
}`,
  }).passes(),
  test('a type-only import does not eagerly load a conditional runtime dependency').withFiles({
    'reporting.ts': `import type { Reporter } from './reporter.js';

export async function openReporter(enabled: boolean): Promise<Reporter | undefined> {
  if (!enabled) return;
  // Evaluating the reporter installs process hooks; disabled launches must avoid those hooks.
  const { createReporter } = await import('./reporter.js');
  return createReporter();
}`,
    'reporter.ts': `export interface Reporter {
  close(): void;
}

const onWarning = (warning: Error) => console.warn(warning.message);
process.on('warning', onWarning);

export function createReporter(): Reporter {
  return { close() { process.off('warning', onWarning); } };
}`,
  }).passes(),
  test('a feature flag cannot defer a dependency already imported at runtime').withFiles({
    'locations.ts': `import { basename } from 'node:path';

export const workingDirectoryName = basename(process.cwd());

export async function absoluteLocation(enabled: boolean, filepath: string) {
  if (!enabled) return;
  const { resolve } = await import('node:path');
  return resolve(filepath);
}`,
  }).violates(),
] as const;
