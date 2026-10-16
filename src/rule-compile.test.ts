import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { compileRule } from './app/rule/compile.ts';
import type { CompiledRule } from './app/rule/types.ts';
import { PluginRegistry } from './app/scope/registry.ts';
import type { ScopeMatch, ScopePlugin } from './app/scope/types.ts';

const RULE_FILE = join('/', 'rules', 'Isolated.yaml');

const DEFINITION: Record<string, unknown> = {
  version: 'v1',
  files: { included: ['src/**'] },
  scope: { format: 'isolated', prefix: '+' },
  check: { rule: 'p' },
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
      RULE_FILE,
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
    () => compileRule(DEFINITION, RULE_FILE, dependencies),
    /No scope plugin is registered for format "isolated"/,
  );
  assert.throws(
    () => compileRule({ ...DEFINITION, scope: { format: 'yaml', path: '$' } }, RULE_FILE, dependencies),
    /No scope plugin is registered for format "yaml"/,
  );
});

test('the rule name is the filename stem of the compiled file', () => {
  const dependencies = { registry: new PluginRegistry([isolated]), warnUnknownField: () => {} };
  const cases: readonly [filepath: string, expected: string][] = [
    [join('/', 'rules', 'nested-name.yaml'), 'nested-name'],
    [join('/', 'rules', 'memory.yml'), 'memory'],
    [join('/', 'rules', 'Deep.YAML'), 'Deep'],
    ['billing-http-url.yaml', 'billing-http-url'],
  ];
  for (const [filepath, expected] of cases) {
    assert.strictEqual(compileRule(DEFINITION, filepath, dependencies).name, expected, filepath);
  }
});

test('a rule without a usable filepath is rejected instead of guessing a name', () => {
  const dependencies = { registry: new PluginRegistry([isolated]), warnUnknownField: () => {} };
  for (const filepath of ['', '   ', join('/', 'rules', '.yaml'), join('/', 'rules', '.yml')]) {
    assert.throws(() => compileRule(DEFINITION, filepath, dependencies), Error, JSON.stringify(filepath));
  }
});

test('the check kind defaults to AI and accepts only the two exact spellings', () => {
  const dependencies = { registry: new PluginRegistry([isolated]), warnUnknownField: () => {} };
  const kindOf = (check: Record<string, unknown>): string =>
    compileRule({ ...DEFINITION, check }, RULE_FILE, dependencies).kind;

  assert.strictEqual(compileRule(DEFINITION, RULE_FILE, dependencies).kind, 'AI');
  assert.strictEqual(kindOf({ rule: 'p' }), 'AI');
  assert.strictEqual(kindOf({ kind: 'AI', rule: 'p' }), 'AI');
  assert.strictEqual(kindOf({ kind: 'regex', rule: 'MUST_.*' }), 'regex');
  for (const kind of ['ai', 'Ai', 'Regex', 'REGEX', 'regexp', 'llm', '', 42, null, true, ['regex'], {}]) {
    assert.throws(() => compileRule({ ...DEFINITION, check: { kind, rule: 'p' } }, RULE_FILE, dependencies), Error, `kind: ${JSON.stringify(kind)}`);
  }
});

test('a regex check is validated at compile time and keeps the raw source', () => {
  const dependencies = { registry: new PluginRegistry([isolated]), warnUnknownField: () => {} };
  const source = '^v\\d+\\.\\d+\\.[0-9]+$';
  const rule = compileRule({ ...DEFINITION, check: { kind: 'regex', rule: source } }, RULE_FILE, dependencies);
  assert.strictEqual(rule.rule, source, 'the regex source stays verbatim for the matcher to compile');

  for (const invalid of ['(', 'a{2,1}', '[a-', '\\', '(?<name>a)(?<name>b)']) {
    assert.throws(
      () => compileRule({ ...DEFINITION, check: { kind: 'regex', rule: invalid } }, RULE_FILE, dependencies),
      /rule\.check\.rule must be a valid JavaScript regular expression/,
      `regex: ${JSON.stringify(invalid)}`,
    );
  }

  // An AI instruction is prose, never a pattern: the same text is accepted unchanged there.
  assert.doesNotThrow(
    () => compileRule({ ...DEFINITION, check: { kind: 'AI', rule: '(' } }, RULE_FILE, dependencies),
  );
});
