import assert from 'node:assert/strict';
import { test } from 'node:test';

import DeprecatedLeftovers from '../.rulekeeper/ts-no-deprecated-leftovers.rule.ts';
import DynamicImports from '../.rulekeeper/ts-no-dynamic-import.rule.ts';
import LocalRecordGuards from '../.rulekeeper/ts-no-local-is-record.rule.ts';
import TinyFunctions from '../.rulekeeper/ts-no-tiny-functions.rule.ts';
import StaticCollections from '../.rulekeeper/ts-set-map.rule.ts';

const cases = [
  {
    name: 'deprecated API candidates distinguish JSDoc tags from text and tag prefixes',
    scope: new DeprecatedLeftovers().scope,
    files: {
      'legacy.ts': `function loadSettings() { return { retries: 3 }; }
/** @deprecated Use loadSettings. */
const loadConfig = loadSettings;`,
      'compat.tsx': `/** @deprecated Public v3 alias retained until the v4 migration. */
export const OldView = CurrentView;`,
      'comments.ts': `// @deprecated is discussed here.
/* @deprecated is not a JSDoc declaration tag. */
const text = '/** @deprecated Use another API. */';`,
      'prefix.ts': '/** @deprecatedSoon is not the deprecated tag. */\nexport const current = 1;',
    },
    selected: ['legacy.ts', 'compat.tsx'],
  },
  {
    name: 'tiny helper candidates select once per file without selecting anonymous callbacks or substantial bodies',
    scope: new TinyFunctions().scope,
    files: {
      'helpers.ts': `function readName(user: { name: string }) { return user.name; }
const readId = (user: { id: string }) => user.id;
console.log(readName({ name: 'Ada' }), readId({ id: '42' }));`,
      'view.tsx': 'const View = (props: { title: string }) => <div>{props.title}</div>;',
      'callbacks.ts': 'const ids = users.map(user => user.id);',
      'substantial.mts': `function readName(user: { name: string }) {
  const name = user.name.trim();
  return name.toUpperCase();
}
const readId = (user: { id: string }) => {
  const id = user.id.trim();
  return id.toLowerCase();
};`,
      'text.ts': 'const example = "function readName(user) { return user.name; }";',
    },
    selected: ['helpers.ts', 'view.tsx'],
  },
  {
    name: 'record guard candidates require an exact local function definition',
    scope: new LocalRecordGuards().scope,
    files: {
      'guard.mts': `export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}`,
      'expression.cts': `const isRecord = function(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
};`,
      'guard.tsx': `const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';`,
      'consumer.ts': `import { isRecord } from './type-guards';
const accepted = isRecord(input);`,
      'other.ts': `function isRecordLike(value: unknown) { return typeof value === 'object'; }
const isRecord = createGuard();
const example = 'function isRecord(value) { return true; }';`,
    },
    selected: ['guard.mts', 'expression.cts', 'guard.tsx'],
  },
  {
    name: 'dynamic import candidates require an awaited literal module rather than import types or computed loading',
    scope: new DynamicImports().scope,
    files: {
      'known.ts': `const first = await import('node:fs/promises');
const second = await import('node:path');`,
      'lazy.tsx': "async function load(enabled: boolean) { if (enabled) return await import(`./view`); }",
      'types.ts': `type Client = import('./client').Client;
import type { Settings } from './settings';`,
      'computed.cts': "const first = await import(moduleName);\nconst second = await import(`./plugins/${name}`);",
      'pending.mts': "const pending = import('./worker');\nconst other = await consume(import('./other'));",
      'text.ts': 'const example = "await import(\'./module\')";',
    },
    selected: ['known.ts', 'lazy.tsx'],
  },
  {
    name: 'collection candidates include literal initializers but exclude runtime inputs and other constructors',
    scope: new StaticCollections().scope,
    files: {
      'lookup.ts': `const labels = new Map([['ready', 'Ready']]);
const kinds = new Set(['ready', 'pending']);`,
      'lookup.tsx': "const labels = new Map<string, string>([['ready', 'Ready']]);",
      'identity.cts': "const attempts = new Map<object, number>([[job, 1]]);\nattempts.set(otherJob, 2);",
      'dynamic.mts': 'const labels = new Map(entries);\nconst kinds = new Set();\nconst pending = new Map();',
      'other.ts': "const weak = new WeakMap([[job, 1]]);\nconst custom = new Lookup([['ready', 'Ready']]);",
      'text.ts': 'const example = "new Map([[\'ready\', \'Ready\']])";',
    },
    selected: ['lookup.ts', 'lookup.tsx', 'identity.cts'],
  },
] as const;

for (const { name, scope, files, selected } of cases) {
  test(`golden: ${name}`, async () => {
    const actual: string[] = [];
    for (const [filepath, source] of Object.entries(files)) {
      actual.push(...(await scope({ filepath, source })).map(() => filepath));
    }
    assert.deepEqual(actual, selected);
  });
}
