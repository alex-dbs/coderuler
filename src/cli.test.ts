import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { parse } from 'yaml';

import {
  assertFailed,
  createSandbox,
  entries,
  fileContext,
  GOLDEN_ROOT,
  isMapping,
  requireString,
  runCli,
  soleEntry,
  startDecisionFixture,
  writeFile,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
} from '../tests/support.ts';

const MALFORMED_YAML = 'a: [unclosed\n';

let sandbox!: SandboxRoot;
let backend!: DecisionFixture;

before(async () => {
  backend = await startDecisionFixture();
  sandbox = createSandbox('rulekeeper-check-', backend.env);
});

after(async () => {
  sandbox.cleanup();
  await backend.close();
});

function yamlRule(
  name: string,
  rule: string,
  files: { readonly included: readonly string[]; readonly excluded?: readonly string[] },
  filter?: readonly string[],
): string {
  const lines = ["version: 'v1'", `name: '${name}'`, 'files:', '  included:'];
  for (const glob of files.included) lines.push(`    - '${glob}'`);
  if (files.excluded !== undefined) {
    lines.push('  excluded:');
    for (const glob of files.excluded) lines.push(`    - '${glob}'`);
  }
  lines.push('scope:', '  format: yaml', "  path: '$'");
  if (filter !== undefined) lines.push('filter:', ...filter);
  lines.push(`rule: '${rule}'`, '');
  return lines.join('\n');
}

interface GoldenFileCase {
  readonly rulePath: string;
  readonly name: string;
  readonly rule: string;
  readonly examples: unknown;
  readonly contexts: readonly unknown[];
  readonly sources: readonly { readonly filepath: string; readonly source: string }[];
}

function goldenFileCase(group: string, name: string): GoldenFileCase {
  const rulePath = join(GOLDEN_ROOT, group, 'rule.yaml');
  const ruleDocument: unknown = parse(readFileSync(rulePath, 'utf8'));
  if (!isMapping(ruleDocument)) throw new Error(`${group}/rule.yaml must be a mapping`);

  const fixture: unknown = parse(readFileSync(join(GOLDEN_ROOT, group, 'cases', `${name}.yaml`), 'utf8'));
  if (!isMapping(fixture)) throw new Error(`${group}/${name} must be a mapping`);
  const inputs = fixture.inputs;
  if (!Array.isArray(inputs)) throw new Error(`${group}/${name}.inputs must be an array`);
  const expected = fixture.expected;
  if (!isMapping(expected)) throw new Error(`${group}/${name}.expected must be a mapping`);
  const contexts = expected.contexts;
  if (!Array.isArray(contexts)) throw new Error(`${group}/${name}.expected.contexts must be an array`);

  const sources = inputs.map((input: unknown, index: number) => {
    const where = `${group}/${name}.inputs[${index}]`;
    if (!isMapping(input)) throw new Error(`${where} must be a mapping`);
    const filepath = requireString(input.filepath, `${where}.filepath`);
    const source = input.source;
    if (typeof source !== 'string') throw new Error(`${group}/${name}: input ${filepath} is not a file-only source`);
    return { filepath, source };
  });

  return {
    rulePath,
    name: requireString(ruleDocument.name, `${group}/rule.yaml.name`),
    rule: requireString(ruleDocument.rule, `${group}/rule.yaml.rule`),
    examples: ruleDocument.examples,
    contexts,
    sources,
  };
}

async function goldenCheck(label: string, group: string, name: string): Promise<void> {
  const project = sandbox.isolated(label);
  const golden = goldenFileCase(group, name);
  for (const source of golden.sources) writeFile(join(project.cwd, source.filepath), source.source);

  const entry = soleEntry(await runCli(['check', '.', '--rules', golden.rulePath], project), label);

  assert.strictEqual(entry.ruleFile, resolve(golden.rulePath), `${label}: rule file differs`);
  assert.strictEqual(entry.name, golden.name, `${label}: rule name differs`);
  assert.strictEqual(entry.rule, golden.rule, `${label}: rule text differs`);
  assert.deepStrictEqual(entry.examples, golden.examples, `${label}: examples differ`);
  assert.deepStrictEqual(entry.contexts, golden.contexts, `${label}: contexts differ`);
}

test('validate reports every unusable rule as a failure', async () => {
  const cases: readonly (readonly [string, (project: Sandbox) => string])[] = [
    ['a version that is not v1', () => join(GOLDEN_ROOT, 'invalid-version', 'rule.yaml')],
    [
      'a legacy rule that declares no version',
      (project) =>
        writeFile(
          join(project.rules, 'legacy.yaml'),
          "name: legacy\nfiles:\n  included: ['**/*.ts']\nscope:\n  format: yaml\n  path: '$'\nrule: Review the change.\n",
        ),
    ],
    [
      'a rule file that is not valid YAML',
      (project) => writeFile(join(project.rules, 'malformed.yaml'), "version: 'v1'\nname: [unclosed\n"),
    ],
    ['a rule file that cannot be read', (project) => join(project.rules, 'absent.yaml')],
  ];

  for (const [label, rulePath] of cases) {
    const project = sandbox.isolated('validate');
    assertFailed(await runCli(['validate', rulePath(project)], project), `validate ${label}`);
  }
});

test('check scans the current directory recursively and prints one entry with real contexts', async () => {
  const project = sandbox.isolated('check-default-scan');
  const rulePath = writeFile(
    join(project.rules, 'recursive.yaml'),
    yamlRule('Recursive review', 'Review every YAML file.', { included: ['**/*.yaml'] }),
  );
  const source = '{service: {name: api}}';
  writeFile(join(project.cwd, 'a', 'b', 'deep.yaml'), source);

  const entry = soleEntry(await runCli(['check', '--rules', rulePath], project), 'default scan');

  assert.strictEqual(entry.ruleFile, rulePath);
  assert.deepStrictEqual(entry.contexts, [fileContext('a/b/deep.yaml', source)]);
});

test('check prints a JSON array even for a single explicit rule that selects nothing', async () => {
  const project = sandbox.isolated('check-empty-contexts');
  const rulePath = writeFile(
    join(project.rules, 'unmatched.yaml'),
    yamlRule('Unmatched review', 'Review nothing.', { included: ['nothing/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), '{a: 1}');

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'no selected files');

  assert.deepStrictEqual(entry.contexts, []);
});

test('check narrows the scan to a positional target without rebasing the rule globs', async () => {
  const project = sandbox.isolated('check-target');
  const rulePath = writeFile(
    join(project.rules, 'scoped.yaml'),
    yamlRule('Scoped review', 'Review selected sources.', { included: ['src/**/*.yaml'] }),
  );
  const inside = '{service: {name: inside}}';
  const single = '{service: {name: single}}';
  writeFile(join(project.cwd, 'src', 'inside.yaml'), inside);
  writeFile(join(project.cwd, 'src', 'single.yaml'), single);
  writeFile(join(project.cwd, 'other', 'outside.yaml'), '{service: {name: outside}}');

  const cases: readonly (readonly [string, readonly unknown[]])[] = [
    ['src', [fileContext('src/inside.yaml', inside), fileContext('src/single.yaml', single)]],
    ['src/single.yaml', [fileContext('src/single.yaml', single)]],
  ];
  for (const [target, expected] of cases) {
    const label = `target ${target}`;
    const entry = soleEntry(await runCli(['check', target, '--rules', rulePath], project), label);
    // The logical filepath stays relative to the process working directory, so the `src/**` glob
    // still selects what was scanned although only the target was read, and the sibling directory
    // outside the target contributes nothing.
    assert.deepStrictEqual(entry.contexts, expected, `${label}: contexts differ`);
  }
});

test('check aggregates the contexts of every selected file in lexical filepath order', async () => {
  const project = sandbox.isolated('check-aggregate');
  const rulePath = writeFile(
    join(project.rules, 'aggregate.yaml'),
    yamlRule('Aggregate review', 'Review all sources.', { included: ['**/*.yaml'] }),
  );
  const alpha = '{service: {name: alpha}}';
  const mid = '{service: {name: mid}}';
  const zeta = '{service: {name: zeta}}';
  writeFile(join(project.cwd, 'src', 'z.yaml'), zeta);
  writeFile(join(project.cwd, 'src', 'a.yaml'), alpha);
  writeFile(join(project.cwd, 'src', 'm.yaml'), mid);

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'aggregate');

  assert.deepStrictEqual(entry.contexts, [
    fileContext('src/a.yaml', alpha),
    fileContext('src/m.yaml', mid),
    fileContext('src/z.yaml', zeta),
  ]);
});

test('check applies the rule filter so an irrelevant selected file contributes nothing', async () => {
  const project = sandbox.isolated('check-filter');
  const rulePath = writeFile(
    join(project.rules, 'filtered.yaml'),
    yamlRule(
      'Filtered review',
      'Review configured services.',
      { included: ['**/*.yaml'] },
      ["  non_empty: '$.data.service'"],
    ),
  );
  const relevant = '{service: {name: api}}';
  writeFile(join(project.cwd, 'src', 'kept.yaml'), relevant);
  writeFile(join(project.cwd, 'src', 'dropped.yaml'), '{replicas: 2}');

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'filtered');

  assert.deepStrictEqual(entry.contexts, [fileContext('src/kept.yaml', relevant)]);
});

test('check loads a rules directory recursively and keeps one entry per rule in path order', async () => {
  const project = sandbox.isolated('check-rules-directory');
  const alpha = writeFile(
    join(project.rules, 'alpha.yaml'),
    yamlRule('Alpha review', 'Review alpha.', { included: ['**/*.yaml'] }),
  );
  const beta = writeFile(
    join(project.rules, 'nested', 'beta.yaml'),
    yamlRule('Beta review', 'Review beta.', { included: ['**/*.yaml'] }),
  );
  const source = '{service: {name: api}}';
  writeFile(join(project.cwd, 'src', 'a.yaml'), source);

  const list = entries(await runCli(['check', '.', '--rules', project.rules], project), 'rules directory');

  assert.deepStrictEqual(list.map(entry => entry.ruleFile), [alpha, beta]);
  assert.deepStrictEqual(list.map(entry => entry.name), ['Alpha review', 'Beta review']);
  for (const entry of list) assert.deepStrictEqual(entry.contexts, [fileContext('src/a.yaml', source)]);
});

test('check skips the rule files of the rules directory it is scanning', async () => {
  const project = sandbox.isolated('check-skip-rule-file');
  const rulePath = writeFile(
    join(project.cwd, 'rules', 'rule.yaml'),
    yamlRule('Self review', 'Review sources but not itself.', { included: ['**/*.yaml'] }),
  );
  const source = '{service: {name: api}}';
  writeFile(join(project.cwd, 'src', 'a.yaml'), source);

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'rule file skipped');

  assert.strictEqual(entry.ruleFile, rulePath);
  assert.deepStrictEqual(entry.contexts, [fileContext('src/a.yaml', source)]);
});

test('check never reviews the rule file an explicit --rules link resolves to', async () => {
  const project = sandbox.isolated('check-rule-alias');
  const rulePath = writeFile(
    join(project.cwd, 'rules', 'policy.yaml'),
    yamlRule('Aliased review', 'Review sources but not the rule file.', { included: ['**/*.yaml'] }),
  );
  const source = '{value: 42}';
  writeFile(join(project.cwd, 'data.yaml'), source);
  // Two linked spellings of that one descriptor: a link to the file, and a link to its directory.
  symlinkSync(rulePath, join(project.cwd, 'alias.yaml'));
  symlinkSync(join(project.cwd, 'rules'), join(project.cwd, 'aliasdir'));

  const cases: readonly (readonly [string, string, string])[] = [
    ['a linked rule file', 'alias.yaml', join(project.cwd, 'alias.yaml')],
    ['a linked rules directory', 'aliasdir', join(project.cwd, 'aliasdir', 'policy.yaml')],
  ];
  for (const [label, alias, reported] of cases) {
    const entry = soleEntry(await runCli(['check', '.', '--rules', alias], project), label);
    // The rule is reported under the link the caller named, yet the file that link resolves to is
    // not one of the sources: the descriptor is excluded by real path, not by the spelling used.
    assert.strictEqual(entry.ruleFile, reported, `${label}: wrong reported rule file`);
    assert.deepStrictEqual(entry.contexts, [fileContext('data.yaml', source)], `${label}: contexts differ`);
  }
});

test('check never descends into .git, node_modules or .rulekeeper', async () => {
  const project = sandbox.isolated('check-skip-directories');
  const rulePath = writeFile(
    join(project.rules, 'skip.yaml'),
    yamlRule('Skip review', 'Review real sources.', { included: ['**/*.yaml'] }),
  );
  const source = '{service: {name: api}}';
  writeFile(join(project.cwd, 'src', 'a.yaml'), source);
  writeFile(join(project.cwd, '.git', 'bad.yaml'), MALFORMED_YAML);
  writeFile(join(project.cwd, 'node_modules', 'bad.yaml'), MALFORMED_YAML);
  writeFile(join(project.cwd, '.rulekeeper', 'bad.yaml'), MALFORMED_YAML);

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'skipped directories');

  assert.deepStrictEqual(entry.contexts, [fileContext('src/a.yaml', source)]);
});

test('check skips symlink entries instead of following them', async () => {
  const project = sandbox.isolated('check-skip-symlinks');
  const rulePath = writeFile(
    join(project.rules, 'skip-links.yaml'),
    yamlRule('Skip link review', 'Review real sources.', { included: ['**/*.yaml'] }),
  );
  const source = '{service: {name: api}}';
  writeFile(join(project.cwd, 'src', 'a.yaml'), source);
  writeFile(join(project.home, 'away', 'malformed.yaml'), MALFORMED_YAML);
  symlinkSync(join(project.home, 'away', 'malformed.yaml'), join(project.cwd, 'linked.yaml'));
  // A directory link back to the project root: following it would loop, so it must be skipped.
  symlinkSync(project.cwd, join(project.cwd, 'loop'));

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'skipped symlinks');

  assert.deepStrictEqual(entry.contexts, [fileContext('src/a.yaml', source)]);
});

test('check fails on an explicitly named source symlink instead of reporting success', async () => {
  const project = sandbox.isolated('check-explicit-symlink');
  const rulePath = writeFile(
    join(project.rules, 'explicit-link.yaml'),
    yamlRule('Explicit link review', 'Review sources.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.home, 'away', 'real.yaml'), '{service: {name: api}}');
  symlinkSync(join(project.home, 'away', 'real.yaml'), join(project.cwd, 'linked.yaml'));

  assertFailed(await runCli(['check', 'linked.yaml', '--rules', rulePath], project), 'explicit source symlink');
});

test('check never parses a source no rule selects', async () => {
  const selected = '{service: {name: api}}';
  const cases: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
    [
      'an excluded source',
      yamlRule('Excluded review', 'Review non-vendor sources.', {
        included: ['config/**/*.yaml'],
        excluded: ['config/vendor/**'],
      }),
      [
        ['config/app.yaml', selected],
        ['config/vendor/bad.yaml', MALFORMED_YAML],
      ],
    ],
    [
      'an unselected source',
      yamlRule('Selected review', 'Review selected sources.', { included: ['config/**/*.yaml'] }),
      [
        ['config/app.yaml', selected],
        ['other/bad.yaml', MALFORMED_YAML],
      ],
    ],
  ];

  for (const [label, rule, files] of cases) {
    const project = sandbox.isolated('check-skip-source');
    const rulePath = writeFile(join(project.rules, 'rule.yaml'), rule);
    for (const [filepath, source] of files) writeFile(join(project.cwd, filepath), source);

    const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), label);

    assert.deepStrictEqual(entry.contexts, [fileContext('config/app.yaml', selected)], `${label}: contexts differ`);
  }
});

test('check fails without stdout for every unusable input', async () => {
  interface FailureCase {
    readonly label: string;
    readonly setup: (project: Sandbox) => readonly string[];
    readonly needles?: readonly RegExp[];
  }

  const cases: readonly FailureCase[] = [
    {
      label: 'a selected source that fails after a valid earlier one',
      setup: (project) => {
        const rulePath = writeFile(
          join(project.rules, 'atomic.yaml'),
          yamlRule('Atomic review', 'Review every source.', { included: ['**/*.yaml'] }),
        );
        writeFile(join(project.cwd, 'src', 'a.yaml'), '{service: {name: api}}');
        writeFile(join(project.cwd, 'src', 'b.yaml'), MALFORMED_YAML);
        return ['check', '.', '--rules', rulePath];
      },
      // The failure must name both the source that failed and the rule that was running.
      needles: [/src[/\\]b\.yaml/, /atomic\.yaml/],
    },
    {
      label: 'an invalid rule in the rules directory',
      setup: (project) => {
        writeFile(
          join(project.rules, 'good.yaml'),
          yamlRule('Good review', 'Review sources.', { included: ['**/*.yaml'] }),
        );
        writeFile(
          join(project.rules, 'bad.yaml'),
          "version: 'v2'\nname: Bad\nfiles:\n  included: ['**/*.yaml']\nscope:\n  format: yaml\n  path: '$'\nrule: Review.\n",
        );
        writeFile(join(project.cwd, 'src', 'a.yaml'), '{a: 1}');
        return ['check', '.', '--rules', project.rules];
      },
    },
    {
      label: 'an empty rules directory',
      setup: (project) => {
        writeFile(join(project.cwd, 'src', 'a.yaml'), '{a: 1}');
        return ['check', '.', '--rules', project.rules];
      },
    },
    {
      label: 'a source target that does not exist',
      setup: (project) => {
        const rulePath = writeFile(
          join(project.rules, 'missing-target.yaml'),
          yamlRule('Missing target review', 'Review sources.', { included: ['**/*.yaml'] }),
        );
        return ['check', 'absent', '--rules', rulePath];
      },
    },
    {
      label: 'no discovered rule and no rule named',
      setup: (project) => {
        writeFile(join(project.cwd, 'src', 'a.yaml'), '{a: 1}');
        return ['check', '.'];
      },
    },
  ];

  // Every case fails while the rules or the sources are being read, before any decision could be
  // requested, so the fixture must still see no request once the loop is through.
  backend.reset();
  for (const { label, setup, needles } of cases) {
    const project = sandbox.isolated('check-failure');
    const result = await runCli(setup(project), project);
    assertFailed(result, label);
    for (const needle of needles ?? []) {
      assert.match(result.stderr, needle, `${label}: expected the message to name what failed`);
    }
  }
  assert.strictEqual(backend.requests.length, 0, 'a failing run must not have asked for a decision');
});

test('check decides every context and reports each scope under its own filepath and id', async () => {
  const project = sandbox.isolated('check-decisions');
  const rulePath = writeFile(
    join(project.rules, 'decided.yaml'),
    yamlRule('Decided review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), '{service: {name: alpha}}');
  writeFile(join(project.cwd, 'src', 'b.yaml'), '{service: {name: beta}}');

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'decisions follow');

  // One decision per context, in the contexts' own order, each naming the scope it reviewed.
  assert.deepStrictEqual(entry.decisions, [
    { filepath: 'src/a.yaml', scopeId: '0:', follows: true, probability: 0.9, model: 'testmodel' },
    { filepath: 'src/b.yaml', scopeId: '0:', follows: true, probability: 0.9, model: 'testmodel' },
  ]);

  // A probability that only ties the boundary is not a positive: neither scope follows the rule.
  backend.probability = 0.5;
  const tie = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'decisions tie');
  assert.deepStrictEqual(tie.decisions, [
    { filepath: 'src/a.yaml', scopeId: '0:', follows: false, probability: 0.5, model: 'testmodel' },
    { filepath: 'src/b.yaml', scopeId: '0:', follows: false, probability: 0.5, model: 'testmodel' },
  ]);
  backend.reset();
});

test('check asks the backend for a decision on the whole scope under the documented instruction', async () => {
  backend.reset();
  const project = sandbox.isolated('check-decision-request');
  const rulePath = writeFile(
    join(project.rules, 'request.yaml'),
    [
      "version: 'v1'",
      "name: 'Request review'",
      'files:',
      '  included:',
      "    - '**/*.yaml'",
      'scope:',
      '  format: yaml',
      "  path: '$'",
      'examples:',
      "  good: ['name: api']",
      "  bad: ['name: legacy']",
      "rule: 'Review the service name.'",
      '',
    ].join('\n'),
  );
  const source = '{name: api}';
  writeFile(join(project.cwd, 'config', 'app.yaml'), source);

  const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project), 'decision request');

  assert.strictEqual(backend.requests.length, 1, 'the run must ask for exactly one decision');
  const request = backend.requests[0]!;
  assert.strictEqual(request.method, 'POST', 'a decision must be asked for with a POST');
  // The adapter owns the versioned operation path, so the base URL carries no prefix of its own.
  assert.strictEqual(request.path, '/v1/systemone', 'the adapter must send the versioned operation path');
  assert.strictEqual(request.authorization, `Bearer ${backend.apiKey}`, 'the key must travel as a bearer');

  const body = request.body;
  if (!isMapping(body)) throw new Error('the decision request must be a JSON mapping');
  const questions = body.questions;
  if (!isMapping(questions)) throw new Error('the decision request must carry its questions');
  const asked = questions.follows_instructions;
  if (!isMapping(asked)) throw new Error('the decision request must ask follows_instructions');
  const instructions = asked.instructions;
  if (!isMapping(instructions)) throw new Error('the decision request must carry the instructions');
  // The question is prose the service owns, so this pins that one was asked, not how it is worded.
  assert.notStrictEqual(
    requireString(instructions.question, 'instructions.question').trim(),
    '',
    'the instruction must carry a review question',
  );
  // The review state carries where the scope lives and the data selected for it, beside the rule
  // and examples it is judged against, and nothing else. The parsed data already carries the whole
  // scope, so the raw source text is not repeated on the wire.
  assert.deepStrictEqual(body, {
    model: backend.model,
    state: { filepath: 'config/app.yaml', scope: { id: '0:', data: { name: 'api' } } },
    questions: {
      follows_instructions: {
        type: 'noul',
        instructions: {
          rule: 'Review the service name.',
          examples: { good: ['name: api'], bad: ['name: legacy'] },
          question: instructions.question,
        },
      },
    },
  });
  assert.deepStrictEqual(entry.decisions, [
    { filepath: 'config/app.yaml', scopeId: '0:', follows: true, probability: 0.9, model: 'testmodel' },
  ]);
});

test('check prints nothing when the backend fails after answering an earlier context', async () => {
  backend.reset();
  const project = sandbox.isolated('check-backend-failure');
  const rulePath = writeFile(
    join(project.rules, 'partial.yaml'),
    yamlRule('Partial review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), '{service: {name: api}}');
  writeFile(join(project.cwd, 'src', 'b.yaml'), '{service: {name: legacy}}');

  // The first context is answered and the second is not: the run must not report the first decision alone.
  backend.failFromRequest = 1;
  const result = await runCli(['check', '.', '--rules', rulePath], project);
  assertFailed(result, 'backend failure');
  assert.strictEqual(backend.requests.length, 2, 'the run must stop at the context that failed');
  backend.reset();
});

test('check and validate never call the backend when there is nothing to decide', async () => {
  backend.reset();
  const project = sandbox.isolated('check-no-decision');
  const rulePath = writeFile(
    join(project.rules, 'unmatched.yaml'),
    yamlRule('Unmatched review', 'Review nothing.', { included: ['nothing/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), '{a: 1}');

  // Neither run is given a credential at all, so a run that tried to ask for a decision would fail
  // before sending anything: reaching a normal exit proves the backend was never consulted.
  const noCredentials: NodeJS.ProcessEnv = {
    RULEKEEPER_DECISION_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const entry = soleEntry(
    await runCli(['check', '.', '--rules', rulePath], project, noCredentials),
    'no selection',
  );
  assert.deepStrictEqual(entry.contexts, []);
  assert.deepStrictEqual(entry.decisions, [], 'an empty selection must emit no decision');

  const validated = await runCli(['validate', rulePath], project, noCredentials);
  assert.strictEqual(validated.status, 0, `validate: expected success (stderr: ${validated.stderr})`);

  assert.strictEqual(backend.requests.length, 0, 'neither run may have asked for a decision');
});

test('check fails without a backend key instead of reaching a backend', async () => {
  backend.reset();
  const project = sandbox.isolated('check-missing-key');
  const rulePath = writeFile(
    join(project.rules, 'keyed.yaml'),
    yamlRule('Keyed review', 'Review every source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src', 'a.yaml'), '{service: {name: api}}');

  // The sandbox points at the fixture; this run withholds every key, so it must fail before asking.
  // The key fallback itself is pinned by the adapter's own loopback suite, not here.
  const result = await runCli(['check', '.', '--rules', rulePath], project, {
    RULEKEEPER_DECISION_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  });
  assertFailed(result, 'missing backend key');
  assert.strictEqual(backend.requests.length, 0, 'a missing key must fail before any request');
});

test('the CLI loads decision settings from .env without overriding shell settings', async () => {
  const project = sandbox.isolated('check-dotenv');
  const rulePath = writeFile(
    join(project.rules, 'dotenv.yaml'),
    yamlRule('Environment review', 'Review the source.', { included: ['**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'app.yaml'), '{name: api}');
  writeFile(join(project.cwd, '.env'), [
    `RULEKEEPER_DECISION_BASE_URL=${backend.baseUrl}`,
    'RULEKEEPER_DECISION_API_KEY=dotenv-key',
    'RULEKEEPER_DECISION_MODEL=dotenv-model',
    '',
  ].join('\n'));

  for (const [model, key, expectedModel, expectedKey] of [
    [undefined, undefined, 'dotenv-model', 'dotenv-key'],
    ['shell-model', 'shell-key', 'shell-model', 'shell-key'],
  ] as const) {
    backend.reset();
    const entry = soleEntry(await runCli(['check', '.', '--rules', rulePath], project, {
      RULEKEEPER_DECISION_BASE_URL: undefined,
      RULEKEEPER_DECISION_API_KEY: key,
      RULEKEEPER_DECISION_MODEL: model,
      TYPESAFE_API_KEY: undefined,
    }), 'dotenv configuration');
    assert.deepStrictEqual(entry.decisions, [
      { filepath: 'app.yaml', scopeId: '0:', follows: true, probability: 0.9, model: 'testmodel' },
    ]);
    assert.strictEqual(backend.requests.length, 1);
    const request = backend.requests[0]!;
    assert.strictEqual(request.authorization, `Bearer ${expectedKey}`);
    assert.ok(isMapping(request.body));
    assert.strictEqual(request.body.model, expectedModel);
  }
});

test('check reviews the memory-ratio golden sources through the real rule', async () => {
  await goldenCheck('golden-memory', 'memory-ratio', '11-file-containers-mixed');
});

test('check leaves the memory-ratio empty settings out of the contexts', async () => {
  await goldenCheck('golden-memory-empty', 'memory-ratio', '12-file-empty-and-null-settings');
});

test('check reviews the protobuf billing golden source through the real rule', async () => {
  await goldenCheck('golden-billing', 'billing-http-url', '11-file-rpcs');
});

test('check reviews the Go golden source through the real rule', async () => {
  await goldenCheck('golden-go', 'go-slice-append', 'file-candidates-and-noncandidates');
});
