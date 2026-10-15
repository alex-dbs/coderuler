import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { compileRule, parseRule, type CompiledRule } from './infra/rules.ts';
import type {
  DecisionGrouping,
  FileInput,
  MatchOptions,
  RuleExamples,
  RuleInput,
} from './app/rule/types.ts';
import { PluginRegistry } from './app/scope/registry.ts';
import type { ScopeMatch, ScopePlugin } from './app/scope/types.ts';
import { createPluginRegistry } from './infra/plugins.ts';
import { astGrepPlugin } from './adapter/scope/astgrep.ts';
import { protobufPlugin } from './adapter/scope/protobuf.ts';
import { yamlPlugin } from './adapter/scope/yaml.ts';

const kvPlugin: ScopePlugin = {
  format: 'kv',
  compile(options) {
    for (const key of Object.keys(options)) {
      if (key !== 'prefix') throw new Error(`kv scope has no option "${key}"`);
    }
    const { prefix } = options;
    if (typeof prefix !== 'string' || prefix === '') {
      throw new Error('kv scope requires a non-empty "prefix" string');
    }
    return {
      select({ source }): readonly ScopeMatch[] {
        const scopes: ScopeMatch[] = [];
        for (const line of source.split('\n')) {
          if (!line.startsWith(prefix)) continue;
          const body = line.slice(prefix.length);
          const separator = body.indexOf('=');
          const key = separator === -1 ? body : body.slice(0, separator);
          if (key === '') continue;
          scopes.push({
            id: key,
            source: line,
            data: { key, value: separator === -1 ? null : body.slice(separator + 1) },
          });
        }
        return scopes;
      },
    };
  },
};

const registry = new PluginRegistry([kvPlugin]);

const DEFINITION: Record<string, unknown> = {
  version: 'v1',
  name: 'R',
  files: { included: ['src/**'] },
  scope: { format: 'kv', prefix: '+' },
  rule: 'p',
};

function definition(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...DEFINITION, ...fields };
}

function kvRule(scope: Readonly<Record<string, unknown>> = {}): CompiledRule {
  return compileRule(definition({ scope: { format: 'kv', prefix: '+', ...scope } }), registry);
}

function kvFiltered(filter: unknown, scope: Readonly<Record<string, unknown>> = {}): CompiledRule {
  return compileRule(definition({ scope: { format: 'kv', prefix: '+', ...scope }, filter }), registry);
}

function groupedRule(decision: unknown, extra: Record<string, unknown> = {}): CompiledRule {
  return compileRule(definition({ decision, ...extra }), registry);
}

function idsOf(rule: CompiledRule, input: RuleInput | FileInput): string[] {
  return rule.match(input).map(context => context.scope.id);
}

function captureOutput(t: TestContext, run: () => void): { readonly stderr: string[]; readonly stdout: string[] } {
  const decoder = (into: string[]) => (chunk: string | Uint8Array) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    into.push(stripVTControlCharacters(text));
    return true;
  };
  const stderr: string[] = [];
  const stdout: string[] = [];
  const err = t.mock.method(process.stderr, 'write', decoder(stderr));
  const out = t.mock.method(process.stdout, 'write', decoder(stdout));
  try {
    run();
  } finally {
    out.mock.restore();
    err.mock.restore();
  }
  return { stderr, stdout };
}

function assertWarned(t: TestContext, paths: readonly string[], run: () => void): void {
  const { stderr, stdout } = captureOutput(t, run);
  assert.deepStrictEqual(
    [...stderr].sort(),
    paths.map(path => `WARN Unknown field: ${path} (ignored)\n`).sort(),
    'every unknown field must be warned about exactly once, and nothing else may reach stderr',
  );
  assert.deepStrictEqual(stdout, [], 'the warning must never reach stdout');
}

test('only the exact v1 version string is accepted', () => {
  for (const version of [undefined, '', 1, 'v2', 'V1', null, true, ['v1']]) {
    assert.throws(() => compileRule(definition({ version }), registry), Error, `version: ${String(version)}`);
  }
});

test('obsolete and unknown top-level keys warn and are ignored, with no alias', (t) => {
  for (const key of ['prompt', 'violation', 'variables', 'when', 'from', 'watch', 'extract', 'where', 'context', 'condition']) {
    let rule!: CompiledRule;
    assertWarned(t, [`rule.${key}`], () => {
      rule = compileRule(definition({ [key]: { nested: ['x'] } }), registry);
    });
    assert.strictEqual(rule.rule, 'p', `${key}: an ignored key must not become the instruction`);
    assert.strictEqual(rule.title, undefined, `${key}: an ignored key must not become the title`);
    assert.strictEqual(rule.name, 'R', key);
    assert.deepStrictEqual(idsOf(rule, { filepath: 'src/a.ts', head: '+a=1\n', base: '', diff: '' }), ['a'], key);
  }
});

test('an unknown field warns in yellow on stderr and writes nothing to stdout', () => {
  const script = [
    `import { compileRule } from ${JSON.stringify(new URL('./infra/rules.ts', import.meta.url).href)};`,
    'const rule = compileRule({',
    "  version: 'v1',",
    "  name: 'R',",
    "  files: { included: ['src/**'] },",
    "  scope: { format: 'yaml', path: '$' },",
    "  rule: 'p',",
    '  extra: true,',
    '});',
    'process.stdout.write(`${rule.name}\\n`);',
    '',
  ].join('\n');
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '1' };
  delete env.NO_COLOR;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.strictEqual(result.status, 0, `an unknown field must not fail the rule (stderr: ${result.stderr})`);
  assert.strictEqual(result.stderr, '\u001b[33mWARN Unknown field: rule.extra (ignored)\u001b[39m\n');
  assert.strictEqual(result.stdout, 'R\n', 'stdout must carry the program output alone');
});

test('a blank or missing rule instruction is rejected before any plugin runs', () => {
  for (const rule of ['', '   ', '\n\t ', 42, null, undefined, ['p']]) {
    assert.throws(() => compileRule(definition({ rule }), registry), Error, `rule: ${String(rule)}`);
  }
});

test('an optional title is validated before any plugin runs', () => {
  for (const title of ['', '   ', '\n\t ', 42, null, true, ['t'], {}]) {
    assert.throws(() => compileRule(definition({ title }), registry), Error, `title: ${String(title)}`);
  }
  const blankInYaml = [
    'version: v1',
    'name: V',
    "files: { included: ['src/**'] }",
    "scope: { format: 'kv', prefix: '+' }",
    'rule: p',
    'title: "   "',
    '',
  ].join('\n');
  assert.throws(() => parseRule(blankInYaml, registry), Error, 'a blank YAML title must be rejected too');
});

test('malformed examples are rejected before any plugin runs', () => {
  const invalid: unknown[] = [
    null, 'snippets', [], 7, true,
    { good: null }, { good: 'x' }, { good: [1] }, { good: ['   '] }, { good: [null] },
    { bad: null }, { bad: {} }, { bad: ['ok', ''] },
  ];
  for (const examples of invalid) {
    assert.throws(() => compileRule(definition({ examples }), registry), Error, JSON.stringify(examples));
  }
});

test('examples normalize per category and keep every snippet verbatim', () => {
  const cases: readonly [label: string, examples: unknown, expected: RuleExamples][] = [
    ['both categories omitted', undefined, { good: [], bad: [] }],
    ['good omitted', { bad: ['bad'] }, { good: [], bad: ['bad'] }],
    ['bad omitted', { good: ['good'] }, { good: ['good'], bad: [] }],
    ['both categories empty', { good: [], bad: [] }, { good: [], bad: [] }],
    // A non-blank snippet reaches the reviewer exactly as written: never trimmed, never re-wrapped.
    ['verbatim snippet text', { good: ['  indented\n  '], bad: ['\nbad\n'] }, { good: ['  indented\n  '], bad: ['\nbad\n'] }],
  ];
  for (const [label, examples, expected] of cases) {
    assert.deepStrictEqual(compileRule(definition({ examples }), registry).examples, expected, label);
  }
});

test('an unknown example key is ignored while every known category stays validated', (t) => {
  let named!: CompiledRule;
  let misspeltOnly!: CompiledRule;
  assertWarned(t, ['rule.examples.extra', 'rule.examples.extra', 'rule.examples.goood', 'rule.examples.goood'], () => {
    named = compileRule(definition({ examples: { good: ['g'], bad: ['b'], extra: ['x'], goood: ['typo'] } }), registry);
    misspeltOnly = compileRule(definition({ examples: { goood: ['typo'] } }), registry);
    // A malformed value under a *known* key is still a failure, whatever unknown keys sit beside it.
    assert.throws(() => compileRule(definition({ examples: { extra: ['x'], good: [7] } }), registry), Error);
  });
  assert.deepStrictEqual(named.examples, { good: ['g'], bad: ['b'] });
  assert.deepStrictEqual(misspeltOnly.examples, { good: [], bad: [] }, 'a misspelt category contributes nothing');
});

test('malformed rule fields are rejected before any plugin runs', () => {
  for (const notAMapping of ['not a mapping', ['nope'], 7, true]) {
    assert.throws(() => compileRule(notAMapping, registry), Error, `not a mapping: ${JSON.stringify(notAMapping)}`);
  }
  const invalid: readonly [label: string, fields: Record<string, unknown>][] = [
    ['blank name', { name: '' }],
    ['non-string name', { name: 42 }],
    ['files is not a mapping', { files: [] }],
    ['files without "included"', { files: { excluded: ['a'] } }],
    ['included is not a sequence', { files: { included: 'a' } }],
    ['included is empty', { files: { included: [] } }],
    ['excluded is not a sequence', { files: { included: ['a'], excluded: 'b' } }],
    ['scope is missing', { scope: undefined }],
    ['scope is not a mapping', { scope: 'kv' }],
    ['scope without a format', { scope: {} }],
    ['blank format', { scope: { format: '' } }],
    ['non-boolean changed', { scope: { format: 'kv', prefix: '+', changed: 'yes' } }],
  ];
  for (const [label, fields] of invalid) {
    assert.throws(() => compileRule(definition(fields), registry), Error, label);
  }
});

test('parseRule rejects duplicate YAML keys and non-v1 mappings', () => {
  const duplicate = [
    'version: v1',
    'version: v1',
    'name: R',
    "files: { included: ['src/**'] }",
    "scope: { format: 'kv', prefix: '+' }",
    'rule: p',
    '',
  ].join('\n');
  assert.throws(() => parseRule(duplicate, registry), Error);

  const noVersion = [
    'name: Legacy',
    "files: { included: ['src/**'] }",
    "scope: { format: 'kv', prefix: '+' }",
    'rule: p',
    '',
  ].join('\n');
  assert.throws(() => parseRule(noVersion, registry), Error);
});

test('a YAML rule with unknown keys parses, warns once per key and keeps its known fields', (t) => {
  let rule!: CompiledRule;
  assertWarned(
    t,
    ['rule.decision.depth', 'rule.examples.typo', 'rule.files.ignored', 'rule.prompt'],
    () => {
      rule = parseRule([
        'version: v1',
        'name: Unknown keys',
        "files: { included: ['src/**'], ignored: ['**'] }",
        "scope: { format: 'kv', prefix: '+' }",
        'rule: p',
        'examples: { good: [g], bad: [b], typo: [] }',
        'decision: { group_by: folder, level: -1, depth: 2 }',
        'prompt: a legacy instruction that is not read',
        '',
      ].join('\n'), registry);
    },
  );
  assert.deepStrictEqual(rule.examples, { good: ['g'], bad: ['b'] });
  assert.deepStrictEqual(rule.decision, { group_by: 'folder', level: -1 }, 'the known level must survive');
  assert.deepStrictEqual(idsOf(rule, { filepath: 'src/a.ts', source: '+a=1\n' }), ['a']);
  assert.strictEqual(rule.matchesFile('lib/a.ts'), false, 'the known "included" glob still decides');
});

test('an ignored files key leaves the known selection contract intact', (t) => {
  let rule!: CompiledRule;
  assertWarned(t, ['rule.files.ignore'], () => {
    rule = compileRule(definition({ files: { included: ['src/**'], ignore: ['**'], excluded: ['src/skip/**'] } }), registry);
  });
  assert.strictEqual(rule.matchesFile('src/a.ts'), true);
  assert.strictEqual(rule.matchesFile('src/skip/a.ts'), false, 'the known "excluded" glob still decides');
  assert.strictEqual(rule.matchesFile('lib/a.ts'), false, 'an ignored glob must not widen the selection');

  assertWarned(t, ['rule.files.include'], () => {
    assert.throws(() => compileRule(definition({ files: { include: ['a'] } }), registry), Error);
  });
  assertWarned(t, ['rule.files.extra'], () => {
    assert.throws(() => compileRule(definition({ files: { included: [], extra: 'x' } }), registry), Error);
  });
});

test('the plugin owns its options; common scope keys are stripped, not forwarded', () => {
  // `changed` is the tool's own scope key: it is stripped before the plugin sees the options, so
  // the rule compiles and then reads the file as one unchanged revision.
  assert.deepStrictEqual(
    idsOf(kvRule({ changed: false }), { filepath: 'src/a.ts', head: '+a=1\n', diff: '' }),
    ['a'],
  );
  const invalid: readonly [label: string, scope: Readonly<Record<string, unknown>>][] = [
    ['unknown option reaches the plugin', { format: 'kv', prefix: '+', path: '$' }],
    ['plugin option is invalid', { format: 'kv', prefix: 7 }],
    ['plugin option is missing', { format: 'kv' }],
    ['format is unknown', { format: 'missing', path: '$' }],
  ];
  for (const [label, scope] of invalid) {
    assert.throws(() => compileRule(definition({ scope }), registry), Error, label);
  }
});

test('prototype-like scope keys reach the plugin as own options, not as a prototype', () => {
  const head = [
    'version: v1',
    'name: Proto',
    "files: { included: ['config/**/*.yaml'] }",
    'scope:',
    '  format: yaml',
  ];
  const tail = ['rule: Review.', ''];
  const rule = parseRule([...head, "  path: '$'", ...tail].join('\n'));
  // The real yaml plugin selected the document root, so `path` arrived as the option it is.
  assert.strictEqual(rule.match({ filepath: 'config/a.yaml', source: 'k: 1\n' }).length, 1);
  // `path` is a real yaml option, so a `__proto__` key routed into the prototype slot would smuggle
  // it past the plugin's unknown-option check; forwarded as an own key it is rejected instead.
  assert.throws(() => parseRule([...head, '  __proto__: { path: $ }', ...tail].join('\n')), Error);
});

test('a custom plugin plugs in without modifying core and drives real matching', () => {
  const rule = kvRule();
  assert.deepStrictEqual(
    rule.match({ filepath: 'src/a.ts', head: '+a=1\n+b=2\n', base: '+a=1\n', diff: '@@ diff @@' }),
    [{
      filepath: 'src/a.ts',
      diff: '@@ diff @@',
      scope: { id: 'b', source: '+b=2', data: { key: 'b', value: '2' } },
    }],
  );
});

test('changed mode emits additions and edits in head order, never removed scopes', () => {
  const rule = kvRule();
  const file = 'src/a.ts';
  const ids = (input: RuleInput): string[] => rule.match(input).map(context => context.scope.id);

  assert.deepStrictEqual(ids({ filepath: file, head: '+a=1\n+b=2\n', base: '+a=1\n+b=2\n', diff: '' }), []);
  assert.deepStrictEqual(ids({ filepath: file, head: '+a=1\n+b=2\n', base: '+a=1\n', diff: '' }), ['b']);
  assert.deepStrictEqual(ids({ filepath: file, head: '+a=2\n', base: '+a=1\n', diff: '' }), ['a']);
  assert.deepStrictEqual(ids({ filepath: file, head: '+a=1\n', base: '+a=1\n+b=2\n', diff: '' }), []);
  assert.deepStrictEqual(ids({ filepath: file, head: '+b=2\n+a=1\n', base: '+a=1\n+b=2\n', diff: '' }), []);
  assert.deepStrictEqual(ids({ filepath: file, head: '+a=1\n+b=2\n', base: '', diff: '' }), ['a', 'b']);
  assert.deepStrictEqual(ids({ filepath: file, head: '', base: '+a=1\n', diff: '' }), []);
});

test('changed false emits every selected head scope without consulting base', () => {
  const rule = kvRule({ changed: false });
  assert.deepStrictEqual(
    rule.match({ filepath: 'src/a.ts', head: '+a=1\n+b=2\n', diff: 'ignored evidence' }).map(context => context.scope.id),
    ['a', 'b'],
  );
  assert.deepStrictEqual(rule.match({ filepath: 'src/a.ts', head: '', diff: '' }), []);
});

test('excluded and unselected files short-circuit before sources are required', () => {
  const rule = compileRule(definition({ files: { included: ['src/**'], excluded: ['src/generated/**'] } }), registry);
  assert.deepStrictEqual(rule.match({ filepath: 'src/generated/a.ts', diff: '' } as RuleInput), []);
  assert.deepStrictEqual(rule.match({ filepath: 'lib/b.ts', diff: '' } as RuleInput), []);
});

test('a changed rule requires head and base revisions', () => {
  const rule = kvRule();
  assert.throws(() => rule.match({ filepath: 'src/a.ts', diff: '' } as RuleInput), Error);
  assert.throws(() => rule.match({ filepath: 'src/a.ts', head: '+a=1\n', diff: '' } as RuleInput), Error);
});

test('duplicate scope ids in either revision are rejected', () => {
  const rule = kvRule();
  assert.throws(() => rule.match({ filepath: 'src/a.ts', head: '+a=1\n+a=2\n', base: '', diff: '' }), Error);
  assert.throws(() => rule.match({ filepath: 'src/a.ts', head: '+a=1\n', base: '+a=1\n+a=2\n', diff: '' }), Error);
});

test('a deleted file validates its base snapshot and emits no contexts', () => {
  const rule = kvRule();
  assert.deepStrictEqual(rule.match({ filepath: 'src/a.ts', head: '', base: '+a=1\n', diff: '' }), []);
  assert.throws(() => rule.match({ filepath: 'src/a.ts', head: '', base: '+a=1\n+a=2\n', diff: '' }), Error);
});

test('changedOnly forces a revision comparison on a rule that opted out of changed mode', () => {
  const rule = kvRule({ changed: false });
  const filepath = 'src/a.ts';
  const input: RuleInput = { filepath, head: '+a=1\n+b=2\n+c=3\n', base: '+a=1\n+b=9\n', diff: '@@ -1 +1 @@' };

  // As compiled, the rule reviews every head scope it selects, unchanged sibling included.
  assert.deepStrictEqual(rule.match(input).map(context => context.scope.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(rule.match(input, {}).map(context => context.scope.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(rule.match(input, { changedOnly: false }).map(context => context.scope.id), ['a', 'b', 'c']);

  // Forced, the same rule compares base against head: the untouched `a` is dropped while the
  // edited `b` and the added `c` survive in head order, carrying the file's diff.
  assert.deepStrictEqual(rule.match(input, { changedOnly: true }), [
    { filepath, diff: '@@ -1 +1 @@', scope: { id: 'b', source: '+b=2', data: { key: 'b', value: '2' } } },
    { filepath, diff: '@@ -1 +1 @@', scope: { id: 'c', source: '+c=3', data: { key: 'c', value: '3' } } },
  ]);
});

test('changedOnly reads exactly like a rule that asked for changed mode', () => {
  const filepath = 'src/a.ts';
  const input: RuleInput = { filepath, head: '+a=1\n+b=2\n', base: '+a=1\n', diff: 'd' };
  const forced = kvRule({ changed: false }).match(input, { changedOnly: true });
  assert.deepStrictEqual(kvRule().match(input), forced);
  assert.deepStrictEqual(kvRule().match(input, { changedOnly: true }), forced);
  // An unselected filepath still short-circuits, options or not.
  assert.deepStrictEqual(kvRule({ changed: false }).match({ ...input, filepath: 'lib/a.ts' }, { changedOnly: true }), []);
});

test('match options are read-only, and file mode refuses a forced comparison', () => {
  const rule = kvRule({ changed: false });
  const input: RuleInput = { filepath: 'src/a.ts', head: '+a=1\n+b=2\n', base: '+a=1\n', diff: 'd' };
  const options: MatchOptions = { changedOnly: true };
  const inputBefore = structuredClone(input);
  const optionsBefore = structuredClone(options);

  assert.deepStrictEqual(rule.match(input, options).map(context => context.scope.id), ['b']);
  assert.deepStrictEqual(input, inputBefore);
  assert.deepStrictEqual(options, optionsBefore);
  // The forced call leaves the rule matching its own compiled way afterwards.
  assert.deepStrictEqual(rule.match(input).map(context => context.scope.id), ['a', 'b']);

  const file: FileInput = { filepath: 'src/a.ts', source: '+a=1\n' };
  const fileBefore = structuredClone(file);
  assert.deepStrictEqual(rule.match(file, { changedOnly: false }).map(context => context.scope.id), ['a']);
  assert.deepStrictEqual(file, fileBefore);
  // One text has no base to compare against, so a forced comparison cannot be honored.
  assert.throws(() => rule.match(file, { changedOnly: true }), Error);

  for (const invalid of [{ changedOnly: 'yes' }, { changedOnly: 1 }, { changedOnly: null }, [], null]) {
    assert.throws(() => rule.match(input, invalid as unknown as MatchOptions), Error);
  }
});

test('plugin failures surface instead of collapsing to an empty result', () => {
  const throwing: ScopePlugin = {
    format: 'throwing',
    compile() {
      return { select() { throw new Error('select exploded'); } };
    },
  };
  const rule = compileRule(definition({ scope: { format: 'throwing' } }), new PluginRegistry([throwing]));
  assert.throws(() => rule.match({ filepath: 'src/a.ts', head: 'x', base: '', diff: '' }), Error);
  assert.throws(() => rule.match({ filepath: 'src/a.ts', head: '', base: 'x', diff: '' }), Error);

  const uncompilable: ScopePlugin = {
    format: 'uncompilable',
    compile() { throw new Error('cannot compile'); },
  };
  assert.throws(
    () => compileRule(definition({ scope: { format: 'uncompilable' } }), new PluginRegistry([uncompilable])),
    Error,
  );
});

test('the registry rejects empty and duplicate formats and unknown lookups', () => {
  assert.throws(() => new PluginRegistry([kvPlugin, kvPlugin]), Error);
  assert.throws(() => new PluginRegistry([{ ...kvPlugin, format: '' }]), Error);
  assert.throws(() => new PluginRegistry([kvPlugin]).register(kvPlugin), Error);
  assert.throws(() => new PluginRegistry().get('kv'), Error);
});

test('createPluginRegistry seeds the three builtins plus host extras, per registry', () => {
  const defaults = createPluginRegistry();
  assert.strictEqual(defaults.get(yamlPlugin.format), yamlPlugin);
  assert.strictEqual(defaults.get(protobufPlugin.format), protobufPlugin);
  assert.strictEqual(defaults.get(astGrepPlugin.format), astGrepPlugin);

  const extended = createPluginRegistry([kvPlugin]);
  assert.strictEqual(extended.get(kvPlugin.format), kvPlugin);
  assert.strictEqual(extended.get(yamlPlugin.format), yamlPlugin);
  assert.throws(() => createPluginRegistry().get(kvPlugin.format), Error);
});

test('matching never mutates the input or reuses contexts across files', () => {
  const rule = kvRule({ changed: false });
  const input: RuleInput = { filepath: 'src/a.ts', head: '+a=1\n', diff: 'd1' };
  const snapshot = structuredClone(input);
  const first = rule.match(input);

  assert.deepStrictEqual(input, snapshot);
  assert.deepStrictEqual(first, [{
    filepath: 'src/a.ts',
    diff: 'd1',
    scope: { id: 'a', source: '+a=1', data: { key: 'a', value: '1' } },
  }]);

  const second = rule.match({ filepath: 'src/b.ts', head: '+b=2\n', diff: 'd2' });
  assert.deepStrictEqual(second.map(context => context.scope.id), ['b']);
  assert.notStrictEqual(second[0], first[0]);
  assert.deepStrictEqual(rule.match(input), first);
});

test('a filter narrows selected scopes, and an absent filter accepts them all', () => {
  const source = '+a=1\n+b=\n+c\n';
  const input: RuleInput = { filepath: 'src/a.ts', head: source, diff: '' };
  assert.deepStrictEqual(idsOf(kvRule({ changed: false }), input), ['a', 'b', 'c']);
  assert.deepStrictEqual(idsOf(kvFiltered({ non_empty: '$.data.value' }, { changed: false }), input), ['a']);
});

test('the filter narrows changed head scopes after revision selection', () => {
  const rule = kvFiltered({ non_empty: '$.data.value' });
  const filepath = 'src/a.ts';
  assert.deepStrictEqual(idsOf(rule, { filepath, head: '+a=1\n+b=2\n', base: '+a=1\n', diff: '' }), ['b']);
  assert.deepStrictEqual(idsOf(rule, { filepath, head: '+a=\n', base: '+a=1\n', diff: '' }), []);
  assert.deepStrictEqual(idsOf(rule, { filepath, head: '+a=1\n+b=2\n', base: '+a=1\n+b=2\n', diff: '' }), []);
  assert.deepStrictEqual(idsOf(rule, { filepath, head: '+a=1\n', base: '+a=1\n+b=2\n', diff: '' }), []);
  assert.deepStrictEqual(idsOf(rule, { filepath, head: '+a=1\n+b=\n', base: '', diff: '' }), ['a']);
});

test('the filter is a top-level rule field, never a plugin option', () => {
  const rule = kvFiltered({ non_empty: '$.data.value' });
  assert.deepStrictEqual(idsOf(rule, { filepath: 'src/a.ts', head: '+a=1\n+b=\n', base: '', diff: '' }), ['a']);
  // Nested in `scope` it is just an unknown option, which the plugin itself rejects.
  assert.throws(
    () => compileRule(definition({ scope: { format: 'kv', prefix: '+', filter: { non_empty: '$.data.value' } } }), registry),
    Error,
  );
});

test('an invalid filter fails compilation even when no scope could be selected', () => {
  const unmatched = definition({ files: { included: ['never/**'] } });
  // The file selection matches nothing, yet a valid filter is compiled and an unusable one fails
  // now: validation never waits for a source that would never be read.
  const rule = compileRule({ ...unmatched, filter: { non_empty: '$.data.value' } }, registry);
  assert.deepStrictEqual(rule.match({ filepath: 'src/a.ts', head: '+a=1\n', diff: '' }), []);
  assert.throws(() => compileRule({ ...unmatched, filter: { non_empty: '$[?(@.value)]' } }, registry), Error);
});

test('filtering never suppresses plugin or duplicate-id errors', () => {
  const rejecting = kvFiltered({ not: { non_empty: '$' } }, { changed: false });
  assert.deepStrictEqual(rejecting.match({ filepath: 'src/a.ts', head: '+a=1\n', diff: '' }), []);
  assert.throws(() => rejecting.match({ filepath: 'src/a.ts', head: '+a=1\n+a=2\n', diff: '' }), Error);
  assert.throws(() => rejecting.match({ filepath: 'src/a.ts', head: '+a=1\n+a=2\n', base: '', diff: '' }), Error);

  const throwing: ScopePlugin = {
    format: 'throwing',
    compile() {
      return { select() { throw new Error('select exploded'); } };
    },
  };
  const throwingRule = compileRule(
    definition({ scope: { format: 'throwing' }, filter: { not: { non_empty: '$' } } }),
    new PluginRegistry([throwing]),
  );
  assert.throws(() => throwingRule.match({ filepath: 'src/a.ts', head: 'x', base: '', diff: '' }), Error);
  assert.throws(() => throwingRule.match({ filepath: 'src/a.ts', source: 'x' }), Error);
});

test('file mode reviews every selected scope without revision metadata', () => {
  const rule = kvRule();
  assert.deepStrictEqual(rule.match({ filepath: 'src/a.ts', source: '+a=1\n+b=2\n' }), [
    { filepath: 'src/a.ts', scope: { id: 'a', source: '+a=1', data: { key: 'a', value: '1' } } },
    { filepath: 'src/a.ts', scope: { id: 'b', source: '+b=2', data: { key: 'b', value: '2' } } },
  ]);
  assert.equal('diff' in rule.match({ filepath: 'src/a.ts', source: '+a=1\n' })[0]!, false);
  assert.deepStrictEqual(rule.match({ filepath: 'src/a.ts', source: '' }), []);
});

test('one compiled rule filters file and revision inputs alike', () => {
  const rule = kvFiltered({ non_empty: '$.data.value' });
  assert.deepStrictEqual(idsOf(rule, { filepath: 'src/a.ts', source: '+a=1\n+b=\n' }), ['a']);
  assert.deepStrictEqual(idsOf(rule, { filepath: 'src/a.ts', head: '+a=1\n+b=\n', base: '', diff: '' }), ['a']);
});

test('file mode still honors file selection and duplicate scope ids', () => {
  const rule = compileRule(definition({ files: { included: ['src/**'], excluded: ['src/generated/**'] } }), registry);
  assert.deepStrictEqual(rule.match({ filepath: 'lib/a.ts', source: '+a=1\n' }), []);
  assert.deepStrictEqual(rule.match({ filepath: 'src/generated/a.ts', source: '+a=1\n' }), []);
  assert.equal(rule.match({ filepath: 'src/a.ts', source: '+a=1\n' })[0]!.scope.id, 'a');
  assert.throws(() => rule.match({ filepath: 'src/a.ts', source: '+a=1\n+a=2\n' }), Error);
});

test('mixing a file source with revision fields is rejected for selected files only', () => {
  const rule = kvRule({ changed: false });
  const withHead = { filepath: 'src/a.ts', source: '+a=1\n', head: '+a=1\n', diff: '' };
  const withDiff = { filepath: 'src/a.ts', source: '+a=1\n', diff: '' };
  const withBase = { filepath: 'src/a.ts', source: '+a=1\n', base: '' };
  const unselected = { filepath: 'lib/a.ts', source: '+a=1\n', head: 'x', diff: '' };
  assert.throws(() => rule.match(withHead), Error);
  assert.throws(() => rule.match(withDiff), Error);
  assert.throws(() => rule.match(withBase), Error);
  assert.throws(() => rule.match({ filepath: 'src/a.ts', source: 7 } as unknown as FileInput), Error);
  // An unselected file short-circuits before the input shape is even read.
  assert.deepStrictEqual(rule.match(unselected), []);
});

test('a filter sees YAML plugin data, where 0 is present and an empty value is absent', () => {
  const rule = parseRule([
    "version: 'v1'",
    'name: Replicas',
    'files: { included: ["config/*.yaml"] }',
    'scope:',
    '  format: yaml',
    "  path: '$'",
    '  changed: false',
    "filter: { non_empty: '$.data.spec.replicas' }",
    'rule: Review the replicas.',
    '',
  ].join('\n'));
  const contexts = [
    ['spec: {replicas: 0}', 1], // zero is a present value
    ['spec: {replicas: ""}', 0],
    ['spec: {replicas: []}', 0],
    ['kind: Service', 0],
  ] as const;
  for (const [head, expected] of contexts) {
    assert.equal(rule.match({ filepath: 'config/a.yaml', head, diff: '' }).length, expected, head);
  }
});

test('decision defaults to scope and normalizes every grouping', () => {
  // Omitted entirely (no `decision` key at all) is the default scope grouping.
  assert.deepStrictEqual(compileRule(DEFINITION, registry).decision, { group_by: 'scope' });

  const cases: readonly [label: string, decision: unknown, expected: DecisionGrouping][] = [
    ['undefined', undefined, { group_by: 'scope' }],
    ['explicit scope', { group_by: 'scope' }, { group_by: 'scope' }],
    ['file', { group_by: 'file' }, { group_by: 'file' }],
    ['project', { group_by: 'project' }, { group_by: 'project' }],
    ['folder defaults to level 0', { group_by: 'folder' }, { group_by: 'folder', level: 0 }],
    ['folder -1', { group_by: 'folder', level: -1 }, { group_by: 'folder', level: -1 }],
    ['folder -2', { group_by: 'folder', level: -2 }, { group_by: 'folder', level: -2 }],
    // A large negative level is still a valid safe integer; the clamp happens later, at grouping.
    ['folder deep', { group_by: 'folder', level: -1000 }, { group_by: 'folder', level: -1000 }],
  ];
  for (const [label, decision, expected] of cases) {
    assert.deepStrictEqual(groupedRule(decision).decision, expected, label);
  }
});

test('malformed decisions are rejected before any plugin runs', () => {
  const invalid: readonly [label: string, decision: unknown][] = [
    ['null', null],
    ['scalar', 'scope'],
    ['sequence', ['scope']],
    ['number', 1],
    ['empty mapping', {}],
    ['unknown group_by', { group_by: 'dir' }],
    ['non-string group_by', { group_by: 1 }],
    ['group_by missing but a key present', { level: -1 }],
    ['positive folder level', { group_by: 'folder', level: 1 }],
    ['fractional folder level', { group_by: 'folder', level: -1.5 }],
    ['string folder level', { group_by: 'folder', level: '-1' }],
    ['NaN folder level', { group_by: 'folder', level: Number.NaN }],
    ['infinite folder level', { group_by: 'folder', level: Number.POSITIVE_INFINITY }],
    ['unsafe folder level', { group_by: 'folder', level: -(2 ** 53) }],
  ];
  for (const [label, decision] of invalid) {
    assert.throws(() => groupedRule(decision), Error, label);
  }
});

test('an unknown decision key is ignored while the known grouping stays enforced', (t) => {
  const cases: readonly [label: string, decision: Record<string, unknown>, expected: DecisionGrouping][] = [
    ['scope', { group_by: 'scope', level: 0 }, { group_by: 'scope' }],
    ['file', { group_by: 'file', level: 0 }, { group_by: 'file' }],
    ['project', { group_by: 'project', extra: true }, { group_by: 'project' }],
    ['folder', { group_by: 'folder', depth: 1 }, { group_by: 'folder', level: 0 }],
    ['folder with a level', { group_by: 'folder', level: -2, depth: 1 }, { group_by: 'folder', level: -2 }],
  ];
  for (const [label, decision, expected] of cases) {
    const ignored = Object.keys(decision).filter(key => key !== 'group_by' && (key !== 'level' || decision.group_by !== 'folder'));
    let rule!: CompiledRule;
    assertWarned(t, ignored.map(key => `rule.decision.${key}`), () => {
      rule = compileRule(definition({ decision }), registry);
    });
    assert.deepStrictEqual(rule.decision, expected, label);
  }

  assertWarned(t, [], () => {
    assert.throws(() => compileRule(definition({ decision: { level: -1 } }), registry), Error);
  });
  assertWarned(t, [], () => {
    assert.throws(() => compileRule(definition({ decision: { groupby: 'folder', depth: 1 } }), registry), Error);
  });
  // A malformed `level` beside an ignored key still fails on the known value.
  assertWarned(t, ['rule.decision.depth'], () => {
    assert.throws(() => compileRule(definition({ decision: { group_by: 'folder', level: 1, depth: 1 } }), registry), Error);
  });
});

test('a grouped rule reviews the whole head with no diff and no revision comparison', () => {
  const rule = groupedRule({ group_by: 'file' });
  const filepath = 'src/a.ts';

  // An unchanged scope survives: a grouped rule never compares base against head, and it never
  // needs a diff or a base to read the head.
  assert.deepStrictEqual(rule.match({ filepath, head: '+a=1\n+b=2\n', base: '+a=1\n+b=2\n', diff: '@@ d @@' }), [
    { filepath, scope: { id: 'a', source: '+a=1', data: { key: 'a', value: '1' } } },
    { filepath, scope: { id: 'b', source: '+b=2', data: { key: 'b', value: '2' } } },
  ]);
  assert.deepStrictEqual(rule.match({ filepath, head: '+a=1\n' } as RuleInput), [
    { filepath, scope: { id: 'a', source: '+a=1', data: { key: 'a', value: '1' } } },
  ]);
  assert.equal('diff' in rule.match({ filepath, head: '+a=1\n' } as RuleInput)[0]!, false);

  // The option shape is still validated even though a grouped rule has no comparison to force.
  assert.throws(() => rule.match({ filepath, head: '+a=1\n' } as RuleInput, { changedOnly: 'yes' } as unknown as MatchOptions), Error);
});

test('a grouped rule ignores base and deleted heads', () => {
  const rule = groupedRule({ group_by: 'project' });
  const filepath = 'src/a.ts';
  // A duplicate-id base would fail a scope rule; a grouped rule never parses it.
  assert.deepStrictEqual(idsOf(rule, { filepath, head: '+a=1\n', base: '+a=1\n+a=2\n', diff: '' }), ['a']);
  // A non-string base is likewise never consulted.
  assert.deepStrictEqual(idsOf(rule, { filepath, head: '+a=1\n', base: 7 as unknown as string, diff: '' }), ['a']);
  // No head at all is a rejected input; an empty head is a deleted file with nothing to review.
  assert.throws(() => rule.match({ filepath, diff: '' } as RuleInput), Error);
  assert.deepStrictEqual(rule.match({ filepath, head: '', base: '+a=1\n+a=2\n', diff: '' }), []);
  assert.deepStrictEqual(rule.match({ filepath, head: '' } as RuleInput), []);
});

test('grouped file mode accepts one source, ignores changedOnly and rejects mixed inputs', () => {
  const rule = groupedRule({ group_by: 'folder' });
  const file: FileInput = { filepath: 'src/a.ts', source: '+a=1\n' };
  // A grouped rule has no comparison to force, so `changedOnly` is inert rather than an error.
  assert.deepStrictEqual(rule.match(file, { changedOnly: true }).map(context => context.scope.id), ['a']);
  assert.deepStrictEqual(rule.match(file, { changedOnly: false }).map(context => context.scope.id), ['a']);
  assert.equal('diff' in rule.match(file)[0]!, false);

  for (const mixed of [
    { filepath: 'src/a.ts', source: '+a=1\n', head: 'x' },
    { filepath: 'src/a.ts', source: '+a=1\n', diff: '' },
    { filepath: 'src/a.ts', source: '+a=1\n', base: '' },
  ]) {
    assert.throws(() => rule.match(mixed as unknown as FileInput), Error, JSON.stringify(mixed));
  }
  assert.throws(() => rule.match({ filepath: 'src/a.ts', source: 7 } as unknown as FileInput), Error);
  // File selection still short-circuits before the input shape is read.
  assert.deepStrictEqual(rule.match({ filepath: 'lib/a.ts', source: '+a=1\n', head: 'x' } as unknown as FileInput), []);
});

test('a grouped rule still applies its filter and duplicate-id checks', () => {
  const rule = groupedRule({ group_by: 'file' }, { filter: { non_empty: '$.data.value' } });
  assert.deepStrictEqual(idsOf(rule, { filepath: 'src/a.ts', head: '+a=1\n+b=\n', diff: '' }), ['a']);
  assert.deepStrictEqual(idsOf(rule, { filepath: 'src/a.ts', source: '+a=1\n+b=\n' }), ['a']);
  assert.throws(() => rule.match({ filepath: 'src/a.ts', head: '+a=1\n+a=2\n', diff: '' }), Error);
});
