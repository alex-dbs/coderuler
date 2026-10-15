import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { groupContexts, type DecisionContext } from './decision/group.ts';
import type { ScopeMatch } from './plugins/index.ts';
import { parseRule, type CompiledRule } from './rule.ts';
import {
  assertFailed,
  createSandbox,
  entries,
  fileContext,
  isMapping,
  requireString,
  ROOT,
  runCli,
  runGit,
  soleEntry,
  startDecisionFixture,
  writeFile,
  type CheckEntry,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
} from '../tests/support.ts';

const FIXTURE = resolve(ROOT, 'tests', 'decision-golden.json');

const GOLDEN_CWD = resolve('/', 'project');

interface GoldenInput {
  readonly filepath: string;
  readonly source: string;
}

interface GoldenGroup {
  readonly group: { readonly type: string; readonly path: string };
  readonly files: readonly { readonly filepath: string; readonly scopes: readonly unknown[] }[];
}

interface GoldenCase {
  readonly name: string;
  readonly rule: string;
  readonly compiled: unknown;
  readonly inputs: readonly GoldenInput[];
  readonly contexts?: readonly unknown[] | undefined;
  readonly groups?: readonly GoldenGroup[] | undefined;
  readonly error?: 'group' | undefined;
}

const DOCUMENT_KEYS: readonly string[] = ['scopes', 'cases'];
const SCOPE_KEYS: readonly string[] = ['global', 'container'];
const CASE_KEYS: readonly string[] = ['name', 'scope', 'included', 'filter', 'decisionLines', 'compiled', 'inputs', 'expected'];
const INPUT_KEYS: readonly string[] = ['filepath', 'lines'];
const EXPECTED_KEYS: readonly string[] = ['contexts', 'groups', 'error'];

function requireMapping(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${where}.${key} is not a fixture field`);
  }
  return value;
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of strings`);
  return value.map((item: unknown, index: number) => requireString(item, `${where}[${index}]`));
}

function optionalLines(value: unknown, where: string): string[] | undefined {
  return value === null || value === undefined ? undefined : stringList(value, where);
}

function goldenCases(): GoldenCase[] {
  const document = requireMapping(JSON.parse(readFileSync(FIXTURE, 'utf8')), DOCUMENT_KEYS, 'decision-golden');
  const scopes = requireMapping(document.scopes, SCOPE_KEYS, 'decision-golden.scopes');
  const fragments: Record<string, string[]> = {};
  for (const kind of SCOPE_KEYS) fragments[kind] = stringList(scopes[kind], `decision-golden.scopes.${kind}`);
  if (!Array.isArray(document.cases)) throw new Error('decision-golden.cases must be an array');

  return document.cases.map((value: unknown, index: number) => {
    const where = `decision-golden.cases[${index}]`;
    const entry = requireMapping(value, CASE_KEYS, where);
    const name = requireString(entry.name, `${where}.name`);
    const kind = requireString(entry.scope, `${where}.scope`);
    const fragment = fragments[kind];
    if (fragment === undefined) throw new Error(`${where}.scope names no shared scope fragment`);

    const lines = ["version: 'v1'", `name: '${name.replaceAll("'", "''")}'`, 'files:', '  included:'];
    for (const glob of stringList(entry.included, `${where}.included`)) lines.push(`    - '${glob}'`);
    lines.push('scope:', ...fragment.map(line => `  ${line}`));
    const filter = optionalLines(entry.filter, `${where}.filter`);
    if (filter !== undefined) lines.push('filter:', ...filter.map(line => `  ${line}`));
    const decisionLines = optionalLines(entry.decisionLines, `${where}.decisionLines`);
    if (decisionLines !== undefined) lines.push('decision:', ...decisionLines.map(line => `  ${line}`));
    lines.push('rule: Review the selected scopes.', '');

    if (!Array.isArray(entry.inputs)) throw new Error(`${where}.inputs must be an array`);
    const inputs = entry.inputs.map((input: unknown, inputIndex: number) => {
      const at = `${where}.inputs[${inputIndex}]`;
      const fields = requireMapping(input, INPUT_KEYS, at);
      return {
        filepath: requireString(fields.filepath, `${at}.filepath`),
        source: stringList(fields.lines, `${at}.lines`).join('\n'),
      };
    });

    const expected = requireMapping(entry.expected, EXPECTED_KEYS, `${where}.expected`);
    const named = [expected.contexts, expected.groups, expected.error].filter(field => field !== undefined);
    if (named.length !== 1) throw new Error(`${where}.expected must name exactly one of contexts, groups or error`);
    if (expected.error !== undefined && expected.error !== 'group') throw new Error(`${where}.expected.error must be "group"`);

    return {
      name,
      rule: lines.join('\n'),
      compiled: entry.compiled,
      inputs,
      contexts: expected.contexts as readonly unknown[] | undefined,
      groups: expected.groups as readonly GoldenGroup[] | undefined,
      error: expected.error as 'group' | undefined,
    };
  });
}

function selectedScope(scope: ScopeMatch): unknown {
  const selected: Record<string, unknown> = { id: scope.id };
  if (scope.data === undefined) selected.source = scope.source;
  else selected.data = scope.data;
  if (scope.captures !== undefined) selected.captures = scope.captures;
  return selected;
}

function selected(context: DecisionContext): unknown {
  if ('group' in context) {
    return {
      group: context.group,
      files: context.files.map(file => ({ filepath: file.filepath, scopes: file.scopes.map(selectedScope) })),
    };
  }
  return { filepath: context.filepath, scope: selectedScope(context.scope) };
}

function runGoldenCase(golden: GoldenCase): void {
  const rule: CompiledRule = parseRule(golden.rule);
  assert.deepStrictEqual(rule.decision, golden.compiled, `${golden.name}: the decision is not the normalized grouping`);
  const contexts = golden.inputs.flatMap(input => rule.match({ filepath: input.filepath, source: input.source }));

  if (golden.error !== undefined) {
    // The rejection is only the one the case means when the grouping had something outside the root
    // to reject, so a case that selected nothing can never pass on an empty selection.
    assert.ok(contexts.length > 0, `${golden.name}: the inputs selected nothing to group`);
    assert.throws(
      () => groupContexts(contexts, rule.decision, GOLDEN_CWD),
      Error,
      `${golden.name}: expected the grouping to be rejected`,
    );
    return;
  }

  const grouped = groupContexts(contexts, rule.decision, GOLDEN_CWD).map(selected);
  assert.deepStrictEqual(grouped, golden.contexts ?? golden.groups, `${golden.name}: the grouping differs`);
}

try {
  for (const golden of goldenCases()) test(golden.name, () => runGoldenCase(golden));
} catch (error) {
  // A fixture that cannot be read is a failure of this suite, not of the pipeline it is meant to pin.
  test('the grouped golden fixture', () => {
    throw error;
  });
}

let sandbox!: SandboxRoot;
let backend!: DecisionFixture;

before(async () => {
  backend = await startDecisionFixture();
  sandbox = createSandbox('rulekeeper-grouping-', backend.env);
});

after(async () => {
  sandbox.cleanup();
  await backend.close();
});

function globalRule(name: string, decision: readonly string[], included: readonly string[] = ['**/*.yaml']): string {
  const lines = ["version: 'v1'", `name: '${name}'`, 'files:', '  included:'];
  for (const glob of included) lines.push(`    - '${glob}'`);
  lines.push('scope:', '  format: yaml', "  path: '$'");
  if (decision.length > 0) lines.push('decision:', ...decision.map(line => `  ${line}`));
  lines.push('rule: Review the selected scopes.', '');
  return lines.join('\n');
}

function itemRule(name: string, decision: readonly string[], filter?: readonly string[]): string {
  const lines = ["version: 'v1'", `name: '${name}'`, 'files:', '  included:', "    - '**/*.yaml'"];
  lines.push('scope:', '  format: yaml', "  path: '$.items[*]'", "  key: '$.id'");
  if (filter !== undefined) lines.push('filter:', ...filter.map(line => `  ${line}`));
  lines.push('decision:', ...decision.map(line => `  ${line}`), 'rule: Review the selected items.', '');
  return lines.join('\n');
}

function items(...ids: readonly string[]): string {
  return `${['items:', ...ids.map(id => `  - id: ${id}`)].join('\n')}\n`;
}

function createRepo(label: string, branch = 'main'): Sandbox {
  const repo = sandbox.isolated(label);
  runGit(repo.cwd, ['init', '-q', '-b', branch], repo.env);
  return repo;
}

function commit(repo: Sandbox, message: string): void {
  runGit(repo.cwd, ['add', '-A'], repo.env);
  runGit(repo.cwd, ['commit', '-q', '-m', message], repo.env);
}

function checkoutNew(repo: Sandbox, name: string): void {
  runGit(repo.cwd, ['checkout', '-q', '-b', name], repo.env);
}

interface ContextView {
  readonly filepath: string;
  readonly id: string;
}

function contextViews(entry: CheckEntry, label: string): ContextView[] {
  return entry.contexts.map((value: unknown, index: number) => {
    const where = `${label}.contexts[${index}]`;
    if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
    const scope = value.scope;
    if (!isMapping(scope)) throw new Error(`${where}.scope must be a mapping`);
    return {
      filepath: requireString(value.filepath, `${where}.filepath`),
      id: requireString(scope.id, `${where}.scope.id`),
    };
  });
}

function findState(match: (state: Record<string, unknown>) => boolean, label: string): Record<string, unknown> {
  for (const request of backend.requests) {
    if (!isMapping(request.body)) continue;
    const state = request.body.state;
    if (isMapping(state) && match(state)) return state;
  }
  throw new Error(`${label}: no recorded request carried the expected state`);
}

test('check groups a project from the current tree with no repository and an unused base', async () => {
  backend.reset();
  const project = sandbox.isolated('grouped-no-repository');
  const rulePath = writeFile(join(project.rules, 'project.yaml'), globalRule('project review', ['group_by: project']));
  writeFile(join(project.cwd, 'src', 'app.yaml'), 'name: src-app');
  writeFile(join(project.cwd, 'top.yaml'), 'name: top');

  // There is no repository here and no base resolves: a grouped-only run must not consult Git at all.
  const entry = soleEntry(
    await runCli(['check', '.', '--rules', rulePath, '--diff-only', '--base', 'no-such-ref'], project),
    'grouped without a repository',
  );

  assert.deepStrictEqual(entry.contexts, [
    fileContext('src/app.yaml', 'name: src-app'),
    fileContext('top.yaml', 'name: top'),
  ]);
  assert.deepStrictEqual(entry.decisions, [
    {
      group: { type: 'project', path: '.' },
      members: [
        { filepath: 'src/app.yaml', scopeId: '0:' },
        { filepath: 'top.yaml', scopeId: '0:' },
      ],
      follows: true,
      probability: 0.9,
      model: 'testmodel',
    },
  ]);
  assert.strictEqual(backend.requests.length, 1, 'one group must be one decision');
  assert.deepStrictEqual(findState(state => isMapping(state.group) && state.group.path === '.', 'grouped without a repository'), {
    group: { type: 'project', path: '.' },
    files: [
      { filepath: 'src/app.yaml', scopes: [{ id: '0:', data: { name: 'src-app' } }] },
      { filepath: 'top.yaml', scopes: [{ id: '0:', data: { name: 'top' } }] },
    ],
  });
  backend.reset();
});

test('check reads the committed change for a scope rule and the current tree for a grouped rule', async () => {
  backend.reset();
  const repo = createRepo('mixed-modes');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), 'name: base');
  writeFile(join(repo.cwd, 'charts/other/values.yaml'), 'name: other');
  commit(repo, 'base');
  checkoutNew(repo, 'feature');
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), 'name: committed');
  commit(repo, 'committed change');
  // The working tree moves on after the commit, and one file was never committed at all.
  writeFile(join(repo.cwd, 'charts/app/values.yaml'), 'name: dirty');
  writeFile(join(repo.cwd, 'charts/new/values.yaml'), 'name: new');
  writeFile(join(repo.rules, 'a-scope.yaml'), globalRule('scope review', []));
  writeFile(join(repo.rules, 'b-grouped.yaml'), globalRule('grouped review', ['group_by: project']));

  const list = entries(
    await runCli(['check', '.', '--rules', repo.rules, '--diff-only', '--base', 'main'], repo),
    'mixed modes',
  );
  assert.deepStrictEqual(list.map(entry => entry.name), ['scope review', 'grouped review']);

  const scopeEntry = list[0]!;
  const groupedEntry = list[1]!;
  // The scope rule reviews the frozen committed change: neither the dirty edit nor the untracked file.
  assert.deepStrictEqual(contextViews(scopeEntry, 'scope review').map(view => view.filepath), ['charts/app/values.yaml']);
  assert.deepStrictEqual(scopeEntry.decisions, [
    { filepath: 'charts/app/values.yaml', scopeId: '0:', follows: true, probability: 0.9, model: 'testmodel' },
  ]);
  // The grouped rule reviews the whole current tree, unchanged, dirty and untracked files alike.
  assert.deepStrictEqual(
    contextViews(groupedEntry, 'grouped review').map(view => view.filepath),
    ['charts/app/values.yaml', 'charts/new/values.yaml', 'charts/other/values.yaml'],
  );
  assert.deepStrictEqual(groupedEntry.decisions, [
    {
      group: { type: 'project', path: '.' },
      members: [
        { filepath: 'charts/app/values.yaml', scopeId: '0:' },
        { filepath: 'charts/new/values.yaml', scopeId: '0:' },
        { filepath: 'charts/other/values.yaml', scopeId: '0:' },
      ],
      follows: true,
      probability: 0.9,
      model: 'testmodel',
    },
  ]);

  assert.strictEqual(backend.requests.length, 2, 'one committed scope and one current-tree group');
  const scopeState = findState(state => state.filepath === 'charts/app/values.yaml', 'mixed modes');
  assert.strictEqual(scopeState.filepath, 'charts/app/values.yaml');
  assert.deepStrictEqual(scopeState.scope, { id: '0:', data: { name: 'committed' } });
  const patch = scopeState.diff;
  assert.ok(
    typeof patch === 'string' && patch.includes('-name: base') && patch.includes('+name: committed'),
    'the scope rule must review the committed change, not the working tree',
  );
  assert.deepStrictEqual(findState(state => isMapping(state.group) && state.group.path === '.', 'mixed modes'), {
    group: { type: 'project', path: '.' },
    files: [
      { filepath: 'charts/app/values.yaml', scopes: [{ id: '0:', data: { name: 'dirty' } }] },
      { filepath: 'charts/new/values.yaml', scopes: [{ id: '0:', data: { name: 'new' } }] },
      { filepath: 'charts/other/values.yaml', scopes: [{ id: '0:', data: { name: 'other' } }] },
    ],
  });
  backend.reset();
});

test('check narrows a grouped rule to the target and keeps the group of the narrowed file', async () => {
  const project = sandbox.isolated('grouped-target');
  const rulePath = writeFile(join(project.rules, 'folder.yaml'), globalRule('folder review', ['group_by: folder']));
  writeFile(join(project.cwd, 'charts', 'app', 'values.yaml'), 'name: app');
  writeFile(join(project.cwd, 'other', 'values.yaml'), 'name: other');
  writeFile(join(project.cwd, 'other', 'deep', 'values.yaml'), 'name: deep');

  for (const target of ['charts', 'charts/app/values.yaml']) {
    backend.reset();
    const label = `target ${target}`;
    const entry = soleEntry(await runCli(['check', target, '--rules', rulePath], project), label);

    assert.deepStrictEqual(entry.contexts, [fileContext('charts/app/values.yaml', 'name: app')], `${label}: wrong files`);
    assert.deepStrictEqual(
      entry.decisions,
      [
        {
          group: { type: 'folder', path: 'charts/app' },
          members: [{ filepath: 'charts/app/values.yaml', scopeId: '0:' }],
          follows: true,
          probability: 0.9,
          model: 'testmodel',
        },
      ],
      `${label}: wrong groups`,
    );
    assert.strictEqual(backend.requests.length, 1, `${label}: one group must be one decision`);
    const state = findState(state => isMapping(state.group) && state.group.path === 'charts/app', label);
    assert.deepStrictEqual(state.group, { type: 'folder', path: 'charts/app' }, `${label}: wrong group path`);
    backend.reset();
  }
});

test('check keeps every loaded descriptor out of a mixed scan', async () => {
  backend.reset();
  const project = sandbox.isolated('descriptor-exclusion');
  // Both descriptors are inside the scanned tree and both rules select every YAML file, so a
  // descriptor that leaks into either collection shows up as a reviewed source.
  writeFile(join(project.cwd, 'rules', 'a-scope.yaml'), globalRule('scope rule', []));
  writeFile(join(project.cwd, 'rules', 'b-grouped.yaml'), globalRule('grouped rule', ['group_by: file']));
  writeFile(join(project.cwd, 'src', 'a.yaml'), 'name: alpha');

  const list = entries(
    await runCli(['check', '.', '--rules', join(project.cwd, 'rules')], project),
    'descriptor exclusion',
  );
  assert.deepStrictEqual(list.map(entry => entry.name), ['scope rule', 'grouped rule']);
  for (const entry of list) {
    const files = contextViews(entry, entry.name).map(view => view.filepath);
    assert.deepStrictEqual(files, ['src/a.yaml'], `${entry.name}: a loaded descriptor became a source`);
  }
  // The grouped rule must not turn the scope-mode descriptor into a group of its own either.
  assert.deepStrictEqual(
    list[1]!.decisions,
    [
      {
        group: { type: 'file', path: 'src/a.yaml' },
        members: [{ filepath: 'src/a.yaml', scopeId: '0:' }],
        follows: true,
        probability: 0.9,
        model: 'testmodel',
      },
    ],
    'grouped rule: the wrong files were grouped',
  );
  assert.strictEqual(backend.requests.length, 2, 'one scope and one group were decided');
  backend.reset();
});

test('check asks once per group and lists every member scope in order', async () => {
  backend.reset();
  const project = sandbox.isolated('grouped-members');
  const rulePath = writeFile(join(project.rules, 'items.yaml'), itemRule('item review', ['group_by: file']));
  writeFile(join(project.cwd, 'src', 'app', 'values.yaml'), items('a', 'b', 'c'));
  writeFile(join(project.cwd, 'src', 'lib', 'values.yaml'), items('x', 'y'));

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'grouped members');

  assert.deepStrictEqual(
    contextViews(entry, 'grouped members').map(view => `${view.filepath} ${view.id}`),
    [
      'src/app/values.yaml 0:a',
      'src/app/values.yaml 0:b',
      'src/app/values.yaml 0:c',
      'src/lib/values.yaml 0:x',
      'src/lib/values.yaml 0:y',
    ],
  );
  assert.deepStrictEqual(entry.decisions, [
    {
      group: { type: 'file', path: 'src/app/values.yaml' },
      members: [
        { filepath: 'src/app/values.yaml', scopeId: '0:a' },
        { filepath: 'src/app/values.yaml', scopeId: '0:b' },
        { filepath: 'src/app/values.yaml', scopeId: '0:c' },
      ],
      follows: true,
      probability: 0.9,
      model: 'testmodel',
    },
    {
      group: { type: 'file', path: 'src/lib/values.yaml' },
      members: [
        { filepath: 'src/lib/values.yaml', scopeId: '0:x' },
        { filepath: 'src/lib/values.yaml', scopeId: '0:y' },
      ],
      follows: true,
      probability: 0.9,
      model: 'testmodel',
    },
  ]);
  // Five scopes in two groups: a group is answered once, never split, and never fanned out per scope.
  assert.strictEqual(backend.requests.length, 2, 'one group must be one decision');
  assert.deepStrictEqual(findState(state => isMapping(state.group) && state.group.path === 'src/app/values.yaml', 'grouped members').files, [
    {
      filepath: 'src/app/values.yaml',
      scopes: [
        { id: '0:a', data: { id: 'a' } },
        { id: '0:b', data: { id: 'b' } },
        { id: '0:c', data: { id: 'c' } },
      ],
    },
  ]);
  assert.deepStrictEqual(findState(state => isMapping(state.group) && state.group.path === 'src/lib/values.yaml', 'grouped members').files, [
    {
      filepath: 'src/lib/values.yaml',
      scopes: [
        { id: '0:x', data: { id: 'x' } },
        { id: '0:y', data: { id: 'y' } },
      ],
    },
  ]);
  backend.reset();
});

test('check keeps the groups of distinct rules apart', async () => {
  backend.reset();
  const project = sandbox.isolated('rule-isolation');
  writeFile(join(project.rules, 'a-charts.yaml'), globalRule('charts review', ['group_by: file'], ['charts/**/*.yaml']));
  writeFile(join(project.rules, 'b-other.yaml'), globalRule('other review', ['group_by: project'], ['other/**/*.yaml']));
  writeFile(join(project.cwd, 'charts', 'one.yaml'), 'name: one');
  writeFile(join(project.cwd, 'charts', 'two.yaml'), 'name: two');
  writeFile(join(project.cwd, 'other', 'three.yaml'), 'name: three');

  const list = entries(await runCli(['check', '.', '--rules', project.rules], project), 'rule isolation');

  assert.deepStrictEqual(list.map(entry => entry.name), ['charts review', 'other review']);
  assert.deepStrictEqual(list[0]!.decisions, [
    {
      group: { type: 'file', path: 'charts/one.yaml' },
      members: [{ filepath: 'charts/one.yaml', scopeId: '0:' }],
      follows: true,
      probability: 0.9,
      model: 'testmodel',
    },
    {
      group: { type: 'file', path: 'charts/two.yaml' },
      members: [{ filepath: 'charts/two.yaml', scopeId: '0:' }],
      follows: true,
      probability: 0.9,
      model: 'testmodel',
    },
  ]);
  // The second rule's project group covers its own files only: no group carries two rules' sources.
  assert.deepStrictEqual(list[1]!.decisions, [
    {
      group: { type: 'project', path: '.' },
      members: [{ filepath: 'other/three.yaml', scopeId: '0:' }],
      follows: true,
      probability: 0.9,
      model: 'testmodel',
    },
  ]);
  assert.strictEqual(backend.requests.length, 3, 'each group of each rule is decided once');
  backend.reset();
});

test('check stops at the group the backend fails on and writes nothing', async () => {
  backend.reset();
  const project = sandbox.isolated('grouped-failure');
  const rulePath = writeFile(join(project.rules, 'items.yaml'), itemRule('failing review', ['group_by: file']));
  for (const name of ['a', 'b', 'c']) writeFile(join(project.cwd, `${name}.yaml`), items(name));

  // One group at a time, so the first group is answered and the second is not, and the third is
  // never taken once the failure is observed.
  backend.failFromRequest = 1;
  assertFailed(await runCli(['check', '.', '--rules', rulePath, '--concurrency', '1'], project), 'grouped failure');
  assert.strictEqual(backend.requests.length, 2, 'the run must stop at the group that failed');
  backend.reset();
});

test('check asks for no decision when a grouped rule selects no scope', async () => {
  backend.reset();
  const project = sandbox.isolated('grouped-empty');
  const rulePath = writeFile(
    join(project.rules, 'items.yaml'),
    itemRule('empty review', ['group_by: file'], ["non_empty: '$.data.missing'"]),
  );
  writeFile(join(project.cwd, 'src', 'values.yaml'), items('a'));

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'grouped empty selection');

  assert.deepStrictEqual(entry.contexts, []);
  assert.deepStrictEqual(entry.decisions, [], 'a grouped rule with no selected scope must emit no decision');
  assert.strictEqual(backend.requests.length, 0, 'nothing selected means nothing was asked');
  backend.reset();
});

const ALPHA = ['function alpha() {', '  return 1;', '}'].join('\n');
const BETA = ['function beta() {', '  return 2;', '}'].join('\n');

test('check sends a source-only scope with its source for a grouped rule', async () => {
  backend.reset();
  const project = sandbox.isolated('grouped-source-only');
  const rulePath = writeFile(
    join(project.rules, 'functions.yaml'),
    [
      "version: 'v1'",
      "name: 'function review'",
      'files:',
      '  included:',
      "    - '**/*.js'",
      'scope:',
      '  format: ast-grep',
      '  language: javascript',
      '  rule:',
      '    kind: function_declaration',
      'decision:',
      '  group_by: file',
      'rule: Review every function.',
      '',
    ].join('\n'),
  );
  writeFile(join(project.cwd, 'src', 'script.js'), `${ALPHA}\n\n${BETA}\n`);

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'grouped source-only scopes');

  // An ast-grep scope carries no data at all, so the raw contexts report the matched source.
  assert.deepStrictEqual(entry.contexts, [
    {
      filepath: 'src/script.js',
      scope: { id: 'function_declaration:alpha', source: ALPHA, captures: {}, lines: { start: 1, end: 3 } },
    },
    {
      filepath: 'src/script.js',
      scope: { id: 'function_declaration:beta', source: BETA, captures: {}, lines: { start: 5, end: 7 } },
    },
  ]);
  assert.deepStrictEqual(entry.decisions, [
    {
      group: { type: 'file', path: 'src/script.js' },
      members: [
        { filepath: 'src/script.js', scopeId: 'function_declaration:alpha' },
        { filepath: 'src/script.js', scopeId: 'function_declaration:beta' },
      ],
      follows: true,
      probability: 0.9,
      model: 'testmodel',
    },
  ]);
  // With no data to send, the scope's own source travels instead — never an empty placeholder.
  assert.deepStrictEqual(findState(state => isMapping(state.group) && state.group.path === 'src/script.js', 'grouped source-only scopes'), {
    group: { type: 'file', path: 'src/script.js' },
    files: [
      {
        filepath: 'src/script.js',
        scopes: [
          { id: 'function_declaration:alpha', source: ALPHA, captures: {} },
          { id: 'function_declaration:beta', source: BETA, captures: {} },
        ],
      },
    ],
  });
  backend.reset();
});

test('check rejects a source outside the project root before asking for any group decision', async () => {
  // Each rule names the file beside the project directly, so the candidates are exactly sources a
  // folder or project group cannot name a project-relative path for.
  for (const [label, decision] of [
    ['folder', ['group_by: folder']],
    ['project', ['group_by: project']],
  ] as const) {
    backend.reset();
    const project = sandbox.isolated(`outside-${label}`);
    const rulePath = writeFile(
      join(project.rules, 'outside.yaml'),
      globalRule(`outside ${label}`, decision, ['../outside.yaml']),
    );
    // The target `..` is the project's parent, so this file is scanned and the rule selects it as
    // `../outside.yaml`; the grouping root stays the project cwd, which cannot name it relatively.
    writeFile(join(project.cwd, '..', 'outside.yaml'), 'name: outside');

    assertFailed(await runCli(['check', '..', '--rules', rulePath], project), `outside ${label}`);
    assert.strictEqual(backend.requests.length, 0, `outside ${label}: nothing may be asked before the grouping fails`);
  }
});
