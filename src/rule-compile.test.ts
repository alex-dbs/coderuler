import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { compileRule } from './app/rule/compile.ts';
import type { CompiledRule } from './app/rule/types.ts';
import { PluginRegistry } from './app/scope/registry.ts';
import type { ScopeMatch, ScopePlugin } from './app/scope/types.ts';

const DEFINITION: Record<string, unknown> = {
  version: 'v1',
  name: 'Isolated',
  files: { included: ['src/**'] },
  scope: { format: 'isolated', prefix: '+' },
  rule: 'p',
};

const isolated: ScopePlugin = {
  format: 'isolated',
  compile(options, context) {
    for (const key of Object.keys(options)) {
      if (key !== 'prefix') context?.warnUnknownField(`rule.scope.${key}`);
    }
    if (typeof options.prefix !== 'string' || options.prefix === '') {
      throw new Error('isolated scope requires a non-empty "prefix" string');
    }
    const { prefix } = options;
    return {
      select({ source }): readonly ScopeMatch[] {
        return source.startsWith(prefix) ? [{ id: 'a', source }] : [];
      },
    };
  },
};

function captureStderr(t: TestContext, run: () => void): string[] {
  const stderr: string[] = [];
  const write = t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr.push(stripVTControlCharacters(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')));
    return true;
  });
  try {
    run();
  } finally {
    write.mock.restore();
  }
  return stderr;
}

test('the injected warning sink receives rule and plugin warnings, and nothing reaches stderr', (t) => {
  const warned: string[] = [];
  let rule!: CompiledRule;
  const stderr = captureStderr(t, () => {
    rule = compileRule(
      {
        ...DEFINITION,
        decision: { group_by: 'folder', depth: 2 },
        scope: { format: 'isolated', prefix: '+', extra: true },
        ignored: 'x',
      },
      { registry: new PluginRegistry([isolated]), warnUnknownField: (path) => warned.push(path) },
    );
  });

  assert.deepStrictEqual(warned, ['rule.ignored', 'rule.decision.depth', 'rule.scope.extra']);
  assert.deepStrictEqual(stderr, [], 'a pure compile must not reach for a console sink');
  assert.deepStrictEqual(rule.match({ filepath: 'src/a.ts', source: '+a=1\n' }).map(context => context.scope.id), ['a']);
});

test('the app compiler compiles only the registry it is given, with no built-in fallback', () => {
  const dependencies = { registry: new PluginRegistry(), warnUnknownField: () => {} };
  assert.throws(
    () => compileRule(DEFINITION, dependencies),
    /No scope plugin is registered for format "isolated"/,
  );
  assert.throws(
    () => compileRule({ ...DEFINITION, scope: { format: 'yaml', path: '$' } }, dependencies),
    /No scope plugin is registered for format "yaml"/,
  );
});
