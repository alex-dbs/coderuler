import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { parse, stringify } from 'yaml';

import { parseRule } from './infra/rules.ts';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCHEMA_FILE = resolve(PROJECT_ROOT, 'rule.schema.json');
const YAML_OUTPUT = { lineWidth: 0 } as const;

const FIXTURE_RULES: readonly string[] = [
  'tests/golden/memory-ratio/rule.yaml',
  'tests/golden/go-slice-append/rule.yaml',
  'tests/golden/file-scope/rule.yaml',
  'tests/golden/billing-http-url/rule.yaml',
  '.rulekeeper/memory.yaml',
  '.rulekeeper/duplicated-env.yaml',
  'docs/rules/billing-http-url.yaml',
];

type Document = Record<string, unknown>;

const schemaDocument: unknown = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));

const ajv = new Ajv2020({ allErrors: true });
let compiled: ValidateFunction | undefined;

function validateDocument(document: unknown): { accepted: boolean; errors: string } {
  compiled ??= ajv.compile(schemaDocument as AnySchemaObject);
  const accepted = compiled(document) === true;
  const errors = (compiled.errors ?? []).map(error => `${error.instancePath || '/'} ${error.keyword}`).join(', ');
  return { accepted, errors };
}

function assertAccepted(document: unknown, label: string): void {
  const result = validateDocument(document);
  assert.equal(result.accepted, true, `${label} must be accepted (${result.errors})`);
}

function assertCompiles(document: unknown, label: string): void {
  assert.doesNotThrow(
    () => parseRule(stringify(document, YAML_OUTPUT), 'rule.yaml'),
    `${label} must compile`,
  );
}

const POLICY = 'Every selected scope must satisfy the policy.';

const BASE: Document = {
  version: 'v1',
  files: { included: ['src/**'] },
  scope: { format: 'yaml', path: '$' },
  check: { rule: POLICY },
};

function rule(fields: Document = {}): Document {
  return { ...BASE, ...fields };
}

function check(fields: Document = {}): Document {
  return { check: { rule: POLICY, ...fields } };
}

function withoutRequired(key: string): Document {
  const copy: Document = { ...BASE };
  delete copy[key];
  return copy;
}

test('accepts the real rule fixtures that the compiler also accepts', () => {
  for (const fixture of FIXTURE_RULES) {
    const source = readFileSync(resolve(PROJECT_ROOT, fixture), 'utf8');
    assertAccepted(parse(source), fixture);
    assert.doesNotThrow(() => parseRule(source, fixture), `${fixture} must still compile`);
  }
});

test('rejects the unsupported-version fixture exactly as the compiler does', () => {
  const source = readFileSync(resolve(PROJECT_ROOT, 'tests/golden/invalid-version/rule.yaml'), 'utf8');
  assert.equal(validateDocument(parse(source)).accepted, false, 'the v2 fixture must be rejected');
  assert.throws(() => parseRule(source, 'tests/golden/invalid-version/rule.yaml'));
});

test('accepts every builtin scope variant and compiles the ones the runtime validates', () => {
  const variants: Readonly<Record<string, Document>> = {
    yamlScope: rule({
      scope: { format: 'yaml', path: '$.containers[*]', key: '$.name', changed: false },
      filter: { any: [{ non_empty: '$.data.resources.limits.memory' }, { not: { non_empty: '$.data.image' } }] },
      decision: { group_by: 'folder', level: -1 },
    }),
    protobufScope: rule({
      files: { included: ['proto/**/*.proto'], excluded: ['proto/generated/**'] },
      scope: { format: 'protobuf', path: '$.rpcs[*]' },
      filter: { all: [{ non_empty: '$.data.http.bindings' }] },
      decision: { group_by: 'project' },
    }),
    astGrepScope: rule({
      files: { included: ['**/*.go'] },
      scope: { format: 'ast-grep', language: 'go', rule: { pattern: 'append($SLICE,$$$ARGS)' } },
      decision: { group_by: 'file' },
    }),
  };

  for (const [label, document] of Object.entries(variants)) {
    assertAccepted(document, label);
    assertCompiles(document, label);
  }
});

test('accepts the native ast-grep constraints and utils options', () => {
  const constrained = rule({
    scope: {
      format: 'ast-grep',
      language: 'typescript',
      rule: { kind: 'method_definition' },
      constraints: { NAME: { regex: '^build' } },
      utils: { LOOP: { kind: 'for_statement' } },
    },
  });
  assertAccepted(constrained, 'an ast-grep scope with constraints and utils');
});

test('accepts a host-registered custom scope format with its own options', () => {
  assertAccepted(rule({ scope: { format: 'kv', prefix: '+', changed: false, extraOption: [1, 2] } }), 'a custom scope');
});

test('accepts the new metadata, settings and enabled fields', () => {
  const full = rule({
    ...check({
      'violation-message': 'Memory limit must not exceed 1.5 times the memory request.',
    }),
    enabled: false,
    settings: { model: 'jev-latest', threshold: 0.75, backend: 'jev' },
  });
  assertAccepted(full, 'a fully populated rule');
  assertCompiles(full, 'a fully populated rule');
  assertAccepted(
    rule({ ...check({ examples: {} }), settings: {}, enabled: true }),
    'a rule with empty optional mappings',
  );
});

test('rejects unknown, deprecated and mistyped fields', () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ['an empty document', {}],
    ['a missing version', withoutRequired('version')],
    ['a missing files', withoutRequired('files')],
    ['a missing scope', withoutRequired('scope')],
    ['a missing check', withoutRequired('check')],
    ['an unknown top-level field', rule({ scopes: {} })],
    ['the legacy top-level name', rule({ name: 'memory-ratio' })],
    ['the legacy top-level rule', rule({ rule: POLICY })],
    ['the legacy top-level examples', rule({ examples: { good: [] } })],
    ['the legacy top-level violation-message', rule({ 'violation-message': 'Do not.' })],
    ['the deprecated title key', rule(check({ title: 'Memory limit must not exceed 1.5 times the request.' }))],
    ['a version other than v1', rule({ version: 'v2' })],
    ['a numeric version', rule({ version: 1 })],
    ['a check that is not a mapping', rule({ check: POLICY })],
    ['a check with no rule', rule({ check: {} })],
    ['a blank check rule', rule(check({ rule: '' }))],
    ['a whitespace-only check rule', rule(check({ rule: ' \n ' }))],
    ['an unknown check key', rule(check({ policy: POLICY }))],
    ['an unknown check kind', rule(check({ kind: 'regexp' }))],
    ['a lowercase check kind', rule(check({ kind: 'ai' }))],
    ['a non-string check kind', rule(check({ kind: 1 }))],
    ['a blank check violation-message', rule(check({ 'violation-message': ' \n ' }))],
    ['a blank check example', rule(check({ examples: { good: ['a: 1'], bad: ['  '] } }))],
    ['a non-sequence check example category', rule(check({ examples: { good: 'a: 1' } }))],
    ['an unknown check examples key', rule(check({ examples: { good: [], typo: [] } }))],
    ['a non-boolean enabled', rule({ enabled: 'false' })],
    ['a null enabled', rule({ enabled: null })],
    ['files that are not a mapping', rule({ files: ['src/**'] })],
    ['an empty included list', rule({ files: { included: [] } })],
    ['a blank included glob', rule({ files: { included: [''] } })],
    ['an empty excluded glob', rule({ files: { included: ['src/**'], excluded: [''] } })],
    ['an unknown files key', rule({ files: { included: ['src/**'], exclude: ['src/vendor/**'] } })],
    ['a settings threshold above one', rule({ settings: { threshold: 1.5 } })],
    ['a negative settings threshold', rule({ settings: { threshold: -0.1 } })],
    ['a quoted settings threshold', rule({ settings: { threshold: '0.5' } })],
    ['a blank settings model', rule({ settings: { model: ' ' } })],
    ['an unsupported settings backend', rule({ settings: { backend: 'openai' } })],
    ['an unknown settings key', rule({ settings: { model: 'm', baseUrl: 'https://example.test' } })],
    ['a settings sequence', rule({ settings: [] })],
    ['a filter with two operators', rule({ filter: { all: [{ non_empty: '$.data.a' }], any: [{ non_empty: '$.data.b' }] } })],
    ['a filter with no operator', rule({ filter: {} })],
    ['a filter with an unknown operator', rule({ filter: { sometimes: '$.data.a' } })],
    ['an empty all group', rule({ filter: { all: [] } })],
    ['an empty any group', rule({ filter: { any: [] } })],
    ['a non_empty path without the root marker', rule({ filter: { non_empty: 'data.a' } })],
    ['a non_empty path that is not a string', rule({ filter: { non_empty: ['$.data.a'] } })],
    ['a nested filter that is not a mapping', rule({ filter: { not: '$.data.a' } })],
    ['a decision without group_by', rule({ decision: {} })],
    ['an unknown grouping', rule({ decision: { group_by: 'directory' } })],
    ['an unknown decision key', rule({ decision: { group_by: 'folder', depth: -1 } })],
    ['a positive folder level', rule({ decision: { group_by: 'folder', level: 1 } })],
    ['a fractional folder level', rule({ decision: { group_by: 'folder', level: -0.5 } })],
    ['a quoted folder level', rule({ decision: { group_by: 'folder', level: '-1' } })],
    ['a level on a non-folder grouping', rule({ decision: { group_by: 'file', level: -1 } })],
    ['a scope without format', rule({ scope: { path: '$' } })],
    ['a blank scope format', rule({ scope: { format: '' } })],
    ['a non-boolean scope changed', rule({ scope: { format: 'yaml', path: '$', changed: 'yes' } })],
    ['a yaml scope without path', rule({ scope: { format: 'yaml', key: '$.name' } })],
    ['a blank yaml path', rule({ scope: { format: 'yaml', path: '' } })],
    ['an unknown yaml option', rule({ scope: { format: 'yaml', path: '$', paths: '$' } })],
    ['a yaml scope carrying ast-grep options', rule({ scope: { format: 'yaml', path: '$', language: 'go' } })],
    ['a protobuf path without the root marker', rule({ scope: { format: 'protobuf', path: 'rpcs' } })],
    ['a protobuf scope without path', rule({ scope: { format: 'protobuf' } })],
    ['an ast-grep scope without language', rule({ scope: { format: 'ast-grep', rule: { kind: 'x' } } })],
    ['an ast-grep scope without rule', rule({ scope: { format: 'ast-grep', language: 'go' } })],
    ['an ast-grep rule that is not a mapping', rule({ scope: { format: 'ast-grep', language: 'go', rule: 'append($A)' } })],
    ['an unknown ast-grep option', rule({ scope: { format: 'ast-grep', language: 'go', rule: { kind: 'x' }, capture: {} } })],
    ['a blank custom format', rule({ scope: { format: '', prefix: '+' } })],
  ];

  for (const [label, document] of cases) {
    assert.equal(validateDocument(document).accepted, false, `${label} must be rejected`);
  }
});

test('accepts the inclusive boundaries of settings, level and enabled', () => {
  const cases: readonly (readonly [string, Document])[] = [
    ['a rule with only the required fields', rule()],
    ['an explicit AI kind', rule(check({ kind: 'AI' }))],
    ['a regex kind', rule(check({ kind: 'regex', rule: '^\\d+$' }))],
    ['threshold zero', rule({ settings: { threshold: 0 } })],
    ['threshold one', rule({ settings: { threshold: 1 } })],
    ['threshold fraction', rule({ settings: { threshold: 0.4 } })],
    ['empty settings', rule({ settings: {} })],
    ['enabled true', rule({ enabled: true })],
    ['enabled false', rule({ enabled: false })],
    ['an empty check examples category', rule(check({ examples: { good: [] } }))],
    ['empty check examples', rule(check({ examples: {} }))],
    ['an empty excluded list', rule({ files: { included: ['src/**'], excluded: [] } })],
    ['folder level zero', rule({ decision: { group_by: 'folder', level: 0 } })],
    ['folder level default', rule({ decision: { group_by: 'folder' } })],
    ['folder level parent', rule({ decision: { group_by: 'folder', level: -3 } })],
    ['folder level at the safe integer bound', rule({ decision: { group_by: 'folder', level: -9007199254740991 } })],
    ['deeply nested filters', rule({ filter: { all: [{ not: { any: [{ not: { non_empty: '$.data.a' } }] } }] } })],
  ];

  for (const [label, document] of cases) assertAccepted(document, label);
});

test('accepts both check kinds and compiles the runtime-validated ones', () => {
  assertCompiles(rule(check({ kind: 'AI' })), 'an explicit AI kind');
  assertCompiles(rule(check({ kind: 'regex', rule: '^\\d+$' })), 'a valid regex-kind pattern');
});
