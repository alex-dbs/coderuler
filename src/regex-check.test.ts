import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import {
  assertFailed,
  createSandbox,
  entries,
  isMapping,
  runCli,
  soleEntry,
  writeFile,
  type CheckDecision,
  type CheckEntry,
  type SandboxRoot,
} from '../tests/support.ts';

const NO_CREDENTIALS: NodeJS.ProcessEnv = {
  TYPESAFE_API_KEY: undefined,
  TYPESAFE_BASE_URL: 'not a URL',
  TYPESAFE_DEFAULT_MODEL: undefined,
  RK_THRESHOLD: 'invalid',
  RK_BACKEND: 'other',
};

const FLAGS = [
  'flags:',
  '  enabled: false',
  '  count: 0',
  '  note: null',
  "  label: ''",
  '  name: api',
  '',
].join('\n');

const PROTO = [
  'syntax = "proto3";',
  '',
  'package acme.billing.v1;',
  '',
  'service BillingService {',
  '  rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {',
  '    option (google.api.http) = {',
  '      get: "/v1/invoices/{invoice_id}"',
  '    };',
  '  }',
  '',
  '  rpc CreateInvoice(CreateInvoiceRequest) returns (CreateInvoiceResponse) {',
  '    option (google.api.http) = {',
  '      post: "/firstparty/v2/invoices"',
  '    };',
  '  }',
  '}',
  '',
].join('\n');

const GO = [
  'package main',
  '',
  'func tags(values []string) []string {',
  '\tout := make([]string, len(values))',
  '\treturn out',
  '}',
  '',
].join('\n');

let sandbox!: SandboxRoot;

before(() => {
  sandbox = createSandbox('rulekeeper-regex-');
});

after(() => {
  sandbox.cleanup();
});

interface RegexRuleShape {
  readonly included: readonly string[];
  readonly scope: readonly string[];
  readonly pattern: string;
  readonly decision?: readonly string[];
}

function regexRule(shape: RegexRuleShape): string {
  return [
    "version: 'v1'",
    'files:',
    '  included:',
    ...shape.included.map(glob => `    - '${glob}'`),
    'scope:',
    ...shape.scope,
    ...(shape.decision ?? []),
    'check:',
    '  kind: regex',
    `  rule: '${shape.pattern}'`,
    '',
  ].join('\n');
}

function writeRules(folder: string, files: readonly { readonly name: string; readonly source: string }[]): string {
  for (const file of files) writeFile(join(folder, file.name), file.source);
  return folder;
}

function entryNamed(list: readonly CheckEntry[], stem: string): CheckEntry {
  const match = list.find(entry => basename(entry.ruleFile).replace(/\.ya?ml$/, '') === stem);
  if (match === undefined) {
    throw new Error(`no entry for ${stem}.yaml; got ${list.map(entry => entry.ruleFile).join(', ')}`);
  }
  return match;
}

function assertBinary(decision: CheckDecision, follows: boolean, label: string): void {
  assert.deepStrictEqual(
    { follows: decision.follows, probability: decision.probability, model: decision.model },
    { follows, probability: follows ? 1 : 0, model: 'regex' },
    label,
  );
}

function scopeOf(context: unknown, label: string): Record<string, unknown> {
  if (!isMapping(context)) throw new Error(`${label}: a context must be a JSON mapping`);
  const scope = context.scope;
  if (!isMapping(scope)) throw new Error(`${label}: a context must carry a scope mapping`);
  return scope;
}

test('regex rules match scalar scope data, including false, zero, null and an empty string', async () => {
  const project = sandbox.isolated('regex-scalars');
  writeFile(join(project.cwd, 'flags.yaml'), FLAGS);
  const included = ['**/*.yaml'];
  const folder = writeRules(join(project.rules, 'scalars'), [
    { name: 'enabled.yaml', source: regexRule({ included, scope: ['  format: yaml', "  path: '$.flags.enabled'"], pattern: '^false$' }) },
    { name: 'count.yaml', source: regexRule({ included, scope: ['  format: yaml', "  path: '$.flags.count'"], pattern: '^0$' }) },
    { name: 'note.yaml', source: regexRule({ included, scope: ['  format: yaml', "  path: '$.flags.note'"], pattern: '^null$' }) },
    { name: 'label.yaml', source: regexRule({ included, scope: ['  format: yaml', "  path: '$.flags.label'"], pattern: '^$' }) },
    { name: 'name.yaml', source: regexRule({ included, scope: ['  format: yaml', "  path: '$.flags.name'"], pattern: '^web-' }) },
  ]);

  const list = entries(await runCli(['check', '.', '--rules', folder], project, NO_CREDENTIALS), 'scalar data');

  assert.deepStrictEqual(
    list.map(entry => basename(entry.ruleFile)).sort(),
    ['count.yaml', 'enabled.yaml', 'label.yaml', 'name.yaml', 'note.yaml'],
  );
  assertBinary(entryNamed(list, 'enabled').decisions[0]!, true, 'a false scalar is matched as "false"');
  assertBinary(entryNamed(list, 'count').decisions[0]!, true, 'a zero scalar is matched as "0"');
  assertBinary(entryNamed(list, 'note').decisions[0]!, true, 'a null scalar is matched as "null"');
  assertBinary(entryNamed(list, 'label').decisions[0]!, true, 'an empty scalar is matched as ""');
  assertBinary(entryNamed(list, 'name').decisions[0]!, false, 'a scalar outside the pattern violates');
});

test('regex rules match protobuf url leaves by their data, not by their quoted source', async () => {
  const project = sandbox.isolated('regex-protobuf');
  writeFile(join(project.cwd, 'proto', 'billing', 'service.proto'), PROTO);
  const rulePath = writeFile(
    join(project.rules, 'proto-version.yaml'),
    regexRule({
      included: ['**/*.proto'],
      scope: ['  format: protobuf', "  path: '$.rpcs[*].http.bindings[*].url'"],
      pattern: '^/v\\d+/',
    }),
  );

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project, NO_CREDENTIALS), 'protobuf urls');

  assert.deepStrictEqual(
    entry.contexts.map((context, index) => scopeOf(context, `protobuf url ${index}`).data),
    ['/v1/invoices/{invoice_id}', '/firstparty/v2/invoices'],
    'every url leaf must carry its bare url as scope data',
  );
  assert.strictEqual(entry.decisions.length, 2, 'each binding is decided on its own');
  assertBinary(entry.decisions[0]!, true, 'a versioned url leaf passes');
  assertBinary(entry.decisions[1]!, false, 'a url leaf without a version prefix violates');
});

test('structured scope data falls back to the selected source instead of being stringified', async () => {
  const project = sandbox.isolated('regex-structured');
  writeFile(join(project.cwd, 'flags.yaml'), FLAGS);
  const root = ['  format: yaml', "  path: '$'"];
  const folder = writeRules(join(project.rules, 'structured'), [
    { name: 'source.yaml', source: regexRule({ included: ['**/*.yaml'], scope: root, pattern: 'enabled: false' }) },
    { name: 'stringified.yaml', source: regexRule({ included: ['**/*.yaml'], scope: root, pattern: '^\\{"flags"' }) },
  ]);

  const list = entries(await runCli(['check', '.', '--rules', folder], project, NO_CREDENTIALS), 'structured data');

  assertBinary(entryNamed(list, 'source').decisions[0]!, true, 'an object scope is matched against its source text');
  assertBinary(entryNamed(list, 'stringified').decisions[0]!, false, 'an object scope is never stringified as JSON');
});

test('a scope that selects no data is matched against its source', async () => {
  const project = sandbox.isolated('regex-ast-grep');
  writeFile(join(project.cwd, 'main.go'), GO);
  const astGrep = [
    '  format: ast-grep',
    '  language: go',
    '  rule:',
    "    pattern: 'make($$$ARGS)'",
  ];
  const folder = writeRules(join(project.rules, 'astgrep'), [
    { name: 'source.yaml', source: regexRule({ included: ['**/*.go'], scope: astGrep, pattern: 'len\\(values\\)' }) },
    { name: 'mismatch.yaml', source: regexRule({ included: ['**/*.go'], scope: astGrep, pattern: '^len\\(' }) },
  ]);

  const list = entries(await runCli(['check', '.', '--rules', folder], project, NO_CREDENTIALS), 'ast-grep source');

  assert.deepStrictEqual(
    scopeOf(entryNamed(list, 'source').contexts[0], 'ast-grep source').data,
    undefined,
    'an ast-grep scope carries no data',
  );
  assertBinary(entryNamed(list, 'source').decisions[0]!, true, 'the node source matches');
  assertBinary(entryNamed(list, 'mismatch').decisions[0]!, false, 'a pattern that only matches the whole node violates');
});

test('a grouped regex rule passes only when every member scope matches', async () => {
  const project = sandbox.isolated('regex-grouped');
  writeFile(join(project.cwd, 'flags.yaml'), FLAGS);
  const scope = ['  format: yaml', "  path: '$.flags.*'"];
  const decision = ['decision:', '  group_by: file'];
  const folder = writeRules(join(project.rules, 'grouped'), [
    { name: 'all-short.yaml', source: regexRule({ included: ['**/*.yaml'], scope, decision, pattern: '^.{0,5}$' }) },
    { name: 'all-present.yaml', source: regexRule({ included: ['**/*.yaml'], scope, decision, pattern: '^.+$' }) },
  ]);

  const list = entries(await runCli(['check', '.', '--rules', folder], project, NO_CREDENTIALS), 'grouped regex');
  const members = [
    { filepath: 'flags.yaml', scopeId: '0:/flags/enabled' },
    { filepath: 'flags.yaml', scopeId: '0:/flags/count' },
    { filepath: 'flags.yaml', scopeId: '0:/flags/note' },
    { filepath: 'flags.yaml', scopeId: '0:/flags/label' },
    { filepath: 'flags.yaml', scopeId: '0:/flags/name' },
  ];

  assert.deepStrictEqual(
    entryNamed(list, 'all-short').decisions,
    [{ group: { type: 'file', path: 'flags.yaml' }, members, follows: true, probability: 1, model: 'regex' }],
    'every member matched, so the group passes',
  );
  assert.deepStrictEqual(
    entryNamed(list, 'all-present').decisions,
    [{ group: { type: 'file', path: 'flags.yaml' }, members, follows: false, probability: 0, model: 'regex' }],
    'the empty member did not match, so the group violates',
  );
});

test('a regex rule ignores the AI threshold', async () => {
  const project = sandbox.isolated('regex-threshold');
  writeFile(join(project.cwd, 'flags.yaml'), FLAGS);
  const scope = ['  format: yaml', "  path: '$.flags.name'"];
  const folder = writeRules(join(project.rules, 'threshold'), [
    { name: 'match.yaml', source: regexRule({ included: ['**/*.yaml'], scope, pattern: '^api$' }) },
    { name: 'mismatch.yaml', source: regexRule({ included: ['**/*.yaml'], scope, pattern: '^web-' }) },
  ]);

  const high = entries(await runCli(['check', '.', '--rules', folder, '--threshold', '1'], project, NO_CREDENTIALS), 'threshold one');
  assertBinary(entryNamed(high, 'match').decisions[0]!, true, 'a match stays a pass at threshold 1');

  const low = entries(await runCli(['check', '.', '--rules', folder, '--threshold', '0'], project, NO_CREDENTIALS), 'threshold zero');
  assertBinary(entryNamed(low, 'mismatch').decisions[0]!, false, 'a mismatch stays a violation at threshold 0');
});

test('a rule whose regex does not compile is rejected before any decision', async () => {
  const project = sandbox.isolated('regex-invalid');
  writeFile(join(project.cwd, 'flags.yaml'), FLAGS);
  const rulePath = writeFile(
    join(project.rules, 'broken.yaml'),
    regexRule({ included: ['**/*.yaml'], scope: ['  format: yaml', "  path: '$'"], pattern: '(' }),
  );

  const checked = await runCli(['check', '.', '--rules', rulePath], project, NO_CREDENTIALS);
  assertFailed(checked, 'an invalid regex must fail the check');
  assert.match(checked.stderr, /regex|regular expression/i, 'the failure must name the invalid regex');

  assertFailed(await runCli(['validate', rulePath], project, NO_CREDENTIALS), 'an invalid regex must fail validation');
  assertFailed(await runCli(['inspect', rulePath], project, NO_CREDENTIALS), 'an invalid regex must fail the walkthrough');
});

test('inspect prints the regex pattern, its inputs and the local match', async () => {
  const project = sandbox.isolated('regex-inspect');
  writeFile(join(project.cwd, 'proto', 'billing', 'service.proto'), PROTO);
  const rulePath = writeFile(
    join(project.rules, 'proto-version.yaml'),
    regexRule({
      included: ['**/*.proto'],
      scope: ['  format: protobuf', "  path: '$.rpcs[*].http.bindings[*].url'"],
      pattern: '^/v\\d+/',
    }),
  );

  const result = await runCli(['inspect', rulePath], project, NO_CREDENTIALS);
  const output = stripVTControlCharacters(result.stdout);

  assert.strictEqual(result.status, 0, `the walkthrough must not need a backend (stderr: ${result.stderr})`);
  assert.match(output, /Kind\s+regex, matched locally without a decision backend/);
  assert.ok(output.includes(JSON.stringify('^/v\\d+/')), 'the walkthrough must show the exact pattern');
  assert.ok(
    output.includes(`${JSON.stringify('/v1/invoices/{invoice_id}')}  match`),
    'a matching url leaf is marked as a match',
  );
  assert.ok(
    output.includes(`${JSON.stringify('/firstparty/v2/invoices')}  no match`),
    'a non-matching url leaf is marked as no match',
  );
  assert.match(output, /Match\s+YES/);
  assert.match(output, /Match\s+NO/);
  assert.match(output, /model regex/);
  assert.match(output, /Evaluator\s+regex, matched locally/);
  assert.match(output, /2 ran: 1 PASS, 1 VIOLATION/);
  assert.doesNotMatch(output, /Request\s+serialized body/, 'a regex rule must not print a backend request');
  assert.doesNotMatch(output, /Response\s+HTTP/, 'a regex rule must not print a backend response');
  assert.doesNotMatch(output, /API key is redacted/, 'a regex rule must not talk about an API key');
});

test('inspect keeps a multiline regex input distinguishable', async () => {
  const project = sandbox.isolated('regex-inspect-multiline');
  writeFile(join(project.cwd, 'service.yaml'), 'service:\n  name: api\n');
  const rulePath = writeFile(
    join(project.rules, 'source.yaml'),
    regexRule({ included: ['**/*.yaml'], scope: ['  format: yaml', "  path: '$'"], pattern: 'name: api' }),
  );

  const result = await runCli(['inspect', rulePath], project, NO_CREDENTIALS);
  const output = stripVTControlCharacters(result.stdout);

  assert.strictEqual(result.status, 0, `the walkthrough must not need a backend (stderr: ${result.stderr})`);
  assert.ok(
    output.includes('"service:\\n  name: api'),
    'the selected source must keep its line breaks as escaped newlines',
  );
  assert.doesNotMatch(output, /service:  name: api/, 'the line break must not be silently dropped');
});

test('inspect shows a regex rule that matches nothing without claiming a backend ran', async () => {
  const project = sandbox.isolated('regex-inspect-empty');
  const rulePath = writeFile(
    join(project.rules, 'nothing.yaml'),
    regexRule({ included: ['**/*.proto'], scope: ['  format: protobuf', "  path: '$.rpcs[*].http.bindings[*].url'"], pattern: '^/v\\d+/' }),
  );

  const result = await runCli(['inspect', rulePath], project, NO_CREDENTIALS);
  const output = stripVTControlCharacters(result.stdout);

  assert.strictEqual(result.status, 0, `the walkthrough must not need a backend (stderr: ${result.stderr})`);
  assert.match(output, /no verification ran/);
  assert.match(output, /Evaluator\s+regex, matched locally/);
});
