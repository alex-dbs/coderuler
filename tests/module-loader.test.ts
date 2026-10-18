import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Rule } from '../dist/index.js';
import type { RuleLoader, RuleSelection } from '../dist/app/ports.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';

const BRAND = Symbol.for('rulekeeper.Rule');

const TESTS_DIR = await realpath(fileURLToPath(new URL('.', import.meta.url)));
const tempRoots: string[] = [];

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(TESTS_DIR, `.tmp-${label}-`));
  tempRoots.push(root);
  return root;
}

async function writeModule(file: string, source: string): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source);
  return file;
}

function selectionFor(root: string, extra: { explicit?: string; name?: string } = {}): RuleSelection {
  const selection: { root: string; invocationCwd: string; explicit?: string; name?: string } = {
    root,
    invocationCwd: root,
  };
  if (extra.explicit !== undefined) selection.explicit = extra.explicit;
  if (extra.name !== undefined) selection.name = extra.name;
  return selection;
}

function loaderFor(root: string, home = join(root, 'home')): RuleLoader {
  return createRuleLoader({ home });
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

async function expectReject(
  label: string,
  run: () => Promise<unknown>,
  ...fragments: readonly string[]
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `${label}: expected a rejection`);
  const text = errorText(caught);
  for (const fragment of fragments) {
    assert.ok(
      text.includes(fragment),
      `${label}: expected ${JSON.stringify(text)} to include ${JSON.stringify(fragment)}`,
    );
  }
}

function plainRule(className: string, files = '**/*'): string {
  return `import { Rule, pass } from '@alex-dbs/rulekeeper';

export default class ${className} extends Rule {
  files = ['${files}'];
  check = async () => pass();
}
`;
}

function typedRule(className: string): string {
  return `import { Rule, pass, type CheckResult } from '@alex-dbs/rulekeeper';

export default class ${className} extends Rule {
  files: readonly string[] = ['**/*.md'];
  group: 'scope' | 'folder' = 'folder';
  check = async (): Promise<CheckResult> => pass();
}
`;
}

function names(loaded: readonly { readonly name: string }[]): readonly string[] {
  return loaded.map((entry) => entry.name);
}

test('loads TS, MTS, JS, and MJS rule modules and derives names from their file names', async () => {
  const root = await makeTempRoot('flavors');
  const dir = join(root, '.rulekeeper');
  const written: Record<string, string> = {};
  written.alpha = await writeModule(join(dir, 'alpha.rule.mjs'), plainRule('Alpha'));
  written.beta = await writeModule(join(dir, 'beta.rule.ts'), typedRule('Beta'));
  written.delta = await writeModule(join(dir, 'delta.rule.js'), plainRule('Delta'));
  written.gamma = await writeModule(join(dir, 'gamma.rule.mts'), typedRule('Gamma'));

  const loaded = await loaderFor(root).load(selectionFor(root));
  assert.deepStrictEqual(names(loaded), ['alpha', 'beta', 'delta', 'gamma']);

  for (const entry of loaded) {
    const file = written[entry.name];
    assert.ok(file, `${entry.name} should map to a written module`);
    assert.equal(await realpath(entry.ruleFile), file);
    assert.ok(entry.rule instanceof Rule, `${entry.name} should extend the public Rule class`);
    assert.equal(Reflect.get(entry.rule, BRAND), true);
  }

  const gamma = loaded.find((entry) => entry.name === 'gamma');
  assert.ok(gamma);
  assert.deepStrictEqual(gamma.rule.files, ['**/*.md']);
  assert.equal(gamma.rule.group, 'folder');
  assert.equal(gamma.rule.enabled, true);
});

test('walks discovery roots recursively in lexical order, local before home', async () => {
  const root = await makeTempRoot('roots');
  await writeModule(join(root, '.rulekeeper', 'a.rule.mjs'), plainRule('A'));
  await writeModule(join(root, '.rulekeeper', 'nested', 'z.rule.mjs'), plainRule('Z'));
  const homeRule = await writeModule(
    join(root, 'home', '.rulekeeper', 'c.rule.mjs'),
    plainRule('C'),
  );

  const loaded = await loaderFor(root).load(selectionFor(root));
  assert.deepStrictEqual(names(loaded), ['a', 'z', 'c']);
  const last = loaded[2];
  assert.ok(last);
  assert.equal(await realpath(last.ruleFile), homeRule);
});

test('deduplicates a discovery root that resolves to the same physical directory', async () => {
  const root = await makeTempRoot('dedupe');
  await writeModule(join(root, '.rulekeeper', 'only.rule.mjs'), plainRule('Only'));

  const loaded = await loaderFor(root, root).load(selectionFor(root));
  assert.deepStrictEqual(names(loaded), ['only']);
});

test('accepts a structurally valid rule carrying the shared brand without extending it', async () => {
  const root = await makeTempRoot('foreign-brand');
  await writeModule(
    join(root, '.rulekeeper', 'foreign.rule.mjs'),
    `const BRAND = Symbol.for('rulekeeper.Rule');

class ForeignBase {
  enabled = true;
  files = ['**/*'];
  exclude = [];
  settings = {};
  group = 'scope';
  when() { return true; }
  filter() { return true; }
  select(context) { return context.select({ files: this.files, exclude: this.exclude }); }
  check = async () => ({ status: 'pass' });
}

Object.defineProperty(ForeignBase.prototype, BRAND, { value: true, enumerable: false });

export default ForeignBase;
`,
  );

  const loaded = await loaderFor(root).load(selectionFor(root));
  assert.equal(loaded.length, 1);
  const rule = loaded[0]?.rule;
  assert.ok(rule);
  assert.ok(!(rule instanceof Rule));
  assert.equal(Reflect.get(rule, BRAND), true);
});

test('imports helper modules without discovering them as rules', async () => {
  const root = await makeTempRoot('helpers');
  await writeModule(join(root, '.rulekeeper', 'helper.mjs'), `export const files = ['**/*.md'];\n`);
  await writeModule(
    join(root, '.rulekeeper', 'uses-helper.rule.mjs'),
    `import { Rule, pass } from '@alex-dbs/rulekeeper';
import { files } from './helper.mjs';

export default class UsesHelper extends Rule {
  files = files;
  check = async () => pass();
}
`,
  );

  const loaded = await loaderFor(root).load(selectionFor(root));
  assert.deepStrictEqual(names(loaded), ['uses-helper']);
  assert.deepStrictEqual(loaded[0]?.rule.files, ['**/*.md']);
});

test('keeps additional fields and methods on a rule class', async () => {
  const root = await makeTempRoot('extra');
  await writeModule(
    join(root, '.rulekeeper', 'extra.rule.mjs'),
    `import { Rule, pass } from '@alex-dbs/rulekeeper';

export default class Extra extends Rule {
  label = 'extra';
  files = ['**/*.mjs'];
  check = async () => pass();
  describe() { return this.label; }
}
`,
  );

  const loaded = await loaderFor(root).load(selectionFor(root));
  const entry = loaded[0];
  assert.ok(entry);
  assert.equal(entry.name, 'extra');
  assert.ok('label' in entry.rule);
  assert.equal(entry.rule.label, 'extra');
  assert.ok('describe' in entry.rule);
  assert.equal(typeof entry.rule.describe, 'function');
});

test('loads a disabled rule and reports its disabled state', async () => {
  const root = await makeTempRoot('disabled');
  await writeModule(
    join(root, '.rulekeeper', 'off.rule.mjs'),
    `import { Rule, pass } from '@alex-dbs/rulekeeper';

export default class Off extends Rule {
  enabled = false;
  check = async () => pass();
}
`,
  );

  const loaded = await loaderFor(root).load(selectionFor(root));
  assert.deepStrictEqual(names(loaded), ['off']);
  assert.equal(loaded[0]?.rule.enabled, false);
});

test('skips symlinked rule entries and symlinked discovery roots', async () => {
  const root = await makeTempRoot('symlink');
  const outside = join(root, 'outside');
  const realRule = await writeModule(join(outside, 'linked.rule.mjs'), plainRule('Linked'));
  const dir = join(root, '.rulekeeper');
  await writeModule(join(dir, 'kept.rule.mjs'), plainRule('Kept'));
  await symlink(realRule, join(dir, 'linked.rule.mjs'));
  const nestedRule = await writeModule(
    join(outside, 'nested', 'inner.rule.mjs'),
    plainRule('Inner'),
  );
  await symlink(dirname(nestedRule), join(dir, 'linked-dir'));

  const loaded = await loaderFor(root).load(selectionFor(root));
  assert.deepStrictEqual(names(loaded), ['kept']);

  const symlinkedRoot = await makeTempRoot('symlink-root');
  const target = await makeTempRoot('symlink-target');
  const targetRules = join(target, 'rules');
  await writeModule(join(targetRules, 'hidden.rule.mjs'), plainRule('Hidden'));
  await symlink(targetRules, join(symlinkedRoot, '.rulekeeper'));
  const homeRule = await writeModule(
    join(symlinkedRoot, 'home', '.rulekeeper', 'visible.rule.mjs'),
    plainRule('Visible'),
  );

  const viaSymlink = await loaderFor(symlinkedRoot).load(selectionFor(symlinkedRoot));
  assert.deepStrictEqual(names(viaSymlink), ['visible']);
  const sole = viaSymlink[0];
  assert.ok(sole);
  assert.equal(await realpath(sole.ruleFile), homeRule);

  const symlinkOnly = await makeTempRoot('symlink-only');
  await symlink(targetRules, join(symlinkOnly, '.rulekeeper'));
  await expectReject(
    'symlinked discovery root without other rules',
    () => loaderFor(symlinkOnly).load(selectionFor(symlinkOnly)),
    '.rulekeeper',
  );
});

test('skips rule modules nested under an old directory', async () => {
  const root = await makeTempRoot('old-dir');
  await writeModule(join(root, '.rulekeeper', 'keep.rule.mjs'), plainRule('Keep'));
  await writeModule(join(root, '.rulekeeper', 'old', 'legacy.rule.mjs'), plainRule('Legacy'));

  const loaded = await loaderFor(root).load(selectionFor(root));
  assert.deepStrictEqual(names(loaded), ['keep']);
});

test('rejects a discovery root that lives inside an archived old directory', async () => {
  const base = await makeTempRoot('discovery-under-old');
  const root = join(base, 'old', 'subproject');
  const marker = join(root, '.rulekeeper', 'imported.marker');
  await writeModule(
    join(root, '.rulekeeper', 'legacy.rule.mjs'),
    `import { writeFileSync } from 'node:fs';

import { Rule, pass } from '@alex-dbs/rulekeeper';

writeFileSync(new URL('./imported.marker', import.meta.url), 'imported');

export default class UnderOld extends Rule {
  files = ['**/*'];
  check = async () => pass();
}
`,
  );

  await expectReject('discovery root under old', () => loaderFor(root).load(selectionFor(root)), 'old');

  assert.equal(
    await stat(marker).then(
      () => true,
      () => false,
    ),
    false,
    'the archived rule module must not be imported',
  );
});

test('reports a missing or malformed discovery root instead of a clean run', async () => {
  const empty = await makeTempRoot('no-rules');
  await expectReject(
    'no rules anywhere',
    () => loaderFor(empty).load(selectionFor(empty)),
    '.rulekeeper',
  );

  const rootFile = await makeTempRoot('root-file');
  await writeFile(join(rootFile, '.rulekeeper'), 'not a directory');
  await expectReject(
    'discovery root is a file',
    () => loaderFor(rootFile).load(selectionFor(rootFile)),
    '.rulekeeper',
  );

  const helpersOnly = await makeTempRoot('helpers-only');
  await writeModule(join(helpersOnly, '.rulekeeper', 'helper.mjs'), `export const value = 1;\n`);
  await expectReject(
    'helpers are not rules',
    () => loaderFor(helpersOnly).load(selectionFor(helpersOnly)),
    '.rulekeeper',
  );
});

test('loads one explicit rule file and ignores the other discovered rules', async () => {
  const root = await makeTempRoot('explicit-file');
  await writeModule(join(root, '.rulekeeper', 'alpha.rule.mjs'), plainRule('Alpha'));
  const beta = await writeModule(join(root, '.rulekeeper', 'beta.rule.mjs'), plainRule('Beta'));

  const loaded = await loaderFor(root).load(selectionFor(root, { explicit: beta }));
  assert.deepStrictEqual(names(loaded), ['beta']);
  const entry = loaded[0];
  assert.ok(entry);
  assert.equal(await realpath(entry.ruleFile), beta);
});

test('scans an explicit directory recursively instead of discovery', async () => {
  const root = await makeTempRoot('explicit-dir');
  await writeModule(join(root, '.rulekeeper', 'ignored.rule.mjs'), plainRule('Ignored'));
  const rules = join(root, 'rules');
  await writeModule(join(rules, 'a.rule.mjs'), plainRule('A'));
  await writeModule(join(rules, 'nested', 'b.rule.mjs'), plainRule('B'));

  const loaded = await loaderFor(root).load(selectionFor(root, { explicit: rules }));
  assert.deepStrictEqual(names(loaded), ['a', 'b']);
});

test('resolves an explicit path relative to the invocation directory', async () => {
  const root = await makeTempRoot('explicit-relative');
  await writeModule(join(root, 'work', 'rules', 'a.rule.mjs'), plainRule('A'));

  const loaded = await loaderFor(root).load({
    root,
    invocationCwd: join(root, 'work'),
    explicit: 'rules',
  });
  assert.deepStrictEqual(names(loaded), ['a']);
});

test('rejects explicit paths that are missing, unsupported, symlinked, or archived', async () => {
  const root = await makeTempRoot('explicit-rejects');
  await writeModule(join(root, 'notes.mjs'), plainRule('Notes'));
  const target = await writeModule(join(root, 'elsewhere', 'real.rule.mjs'), plainRule('Real'));
  const linkPath = join(root, '.rulekeeper', 'linked.rule.mjs');
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(target, linkPath);
  const archived = await writeModule(join(root, 'old', 'legacy.rule.mjs'), plainRule('Legacy'));
  await mkdir(join(root, 'empty-rules'), { recursive: true });
  const loader = loaderFor(root);

  await expectReject(
    'missing explicit path',
    () => loader.load(selectionFor(root, { explicit: join(root, 'missing.rule.mjs') })),
    'missing.rule.mjs',
  );
  await expectReject(
    'empty explicit directory',
    () => loader.load(selectionFor(root, { explicit: join(root, 'empty-rules') })),
    'empty-rules',
  );
  await expectReject(
    'unsupported explicit suffix',
    () => loader.load(selectionFor(root, { explicit: join(root, 'notes.mjs') })),
    'notes.mjs',
  );
  await expectReject(
    'symlinked explicit path',
    () => loader.load(selectionFor(root, { explicit: linkPath })),
    linkPath,
  );
  await expectReject(
    'archived explicit path',
    () => loader.load(selectionFor(root, { explicit: archived })),
    archived,
  );
});

test('resolves a rule by exact name across the working and home roots', async () => {
  const root = await makeTempRoot('by-name');
  await writeModule(join(root, '.rulekeeper', 'alpha.rule.mjs'), plainRule('Alpha'));
  await writeModule(join(root, 'home', '.rulekeeper', 'home-only.rule.mjs'), plainRule('HomeOnly'));
  const loader = loaderFor(root);

  assert.deepStrictEqual(names(await loader.load(selectionFor(root, { name: 'alpha' }))), ['alpha']);
  assert.deepStrictEqual(names(await loader.load(selectionFor(root, { name: 'home-only' }))), [
    'home-only',
  ]);
  await expectReject(
    'unknown rule name',
    () => loader.load(selectionFor(root, { name: 'missing' })),
    'missing',
  );
});

test('rejects a selection that mixes an explicit path with a rule name', async () => {
  const root = await makeTempRoot('mixed-selection');
  const file = await writeModule(join(root, '.rulekeeper', 'alpha.rule.mjs'), plainRule('Alpha'));

  await expectReject('mixed selection', () =>
    loaderFor(root).load(selectionFor(root, { explicit: file, name: 'alpha' })),
  );
});

test('validates every module before returning any loaded rule', async () => {
  const root = await makeTempRoot('validate-all');
  await writeModule(join(root, '.rulekeeper', 'a-good.rule.mjs'), plainRule('Good'));
  const bad = await writeModule(
    join(root, '.rulekeeper', 'b-throwing.rule.mjs'),
    `import { Rule, pass } from '@alex-dbs/rulekeeper';

export default class Throwing extends Rule {
  constructor() {
    super();
    throw new Error('boom ctor');
  }

  check = async () => pass();
}
`,
  );

  await expectReject(
    'whole load fails on a later module',
    () => loaderFor(root).load(selectionFor(root)),
    bad,
    'boom ctor',
  );
});

test('instantiates a fresh rule object per load', async () => {
  const root = await makeTempRoot('fresh');
  await writeModule(join(root, '.rulekeeper', 'alpha.rule.mjs'), plainRule('Alpha'));
  const loader = loaderFor(root);

  const first = await loader.load(selectionFor(root));
  const second = await loader.load(selectionFor(root));

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notStrictEqual(first[0], second[0]);
  assert.notStrictEqual(first[0]?.rule, second[0]?.rule);
  assert.ok(first[0]?.rule instanceof Rule);
  assert.ok(second[0]?.rule instanceof Rule);
});

interface MalformedCase {
  readonly label: string;
  readonly file: string;
  readonly source: string;
  readonly fragment?: string;
}

function ruleWith(className: string, members: string): string {
  return `import { Rule, pass } from '@alex-dbs/rulekeeper';

export default class ${className} extends Rule {
${members}
  check = async () => pass();
}
`;
}

const malformedCases: readonly MalformedCase[] = [
  { label: 'no default export', file: 'named.rule.mjs', source: `export const named = 1;\n` },
  {
    label: 'default instance',
    file: 'instance.rule.mjs',
    source: `import { Rule, pass } from '@alex-dbs/rulekeeper';

class Instance extends Rule {
  check = async () => pass();
}

export default new Instance();
`,
  },
  { label: 'default array', file: 'array.rule.mjs', source: `export default [];\n` },
  {
    label: 'default function',
    file: 'function.rule.mjs',
    source: `export default function notARule() {}\n`,
  },
  {
    label: 'default object',
    file: 'object.rule.mjs',
    source: `export default { files: ['**/*'] };\n`,
  },
  {
    label: 'missing brand',
    file: 'unbranded.rule.mjs',
    source: `class Plain {
  enabled = true;
  files = ['**/*'];
  exclude = [];
  settings = {};
  group = 'scope';
  when() { return true; }
  filter() { return true; }
  select() { return []; }
  check = async () => ({ status: 'pass' });
}

export default Plain;
`,
  },
  {
    label: 'missing check',
    file: 'no-check.rule.mjs',
    source: `import { Rule } from '@alex-dbs/rulekeeper';

export default class NoCheck extends Rule {}
`,
  },
  {
    label: 'non boolean enabled',
    file: 'enabled.rule.mjs',
    source: ruleWith('Enabled', `  enabled = 'yes';`),
  },
  {
    label: 'invalid threshold',
    file: 'threshold.rule.mjs',
    source: ruleWith('Threshold', `  settings = { threshold: 1.5 };`),
  },
  {
    label: 'invalid backend',
    file: 'backend.rule.mjs',
    source: ruleWith('Backend', `  settings = { backend: 'other' };`),
  },
  {
    label: 'invalid settings while disabled',
    file: 'disabled-invalid.rule.mjs',
    source: ruleWith('DisabledInvalid', `  enabled = false;\n  settings = { threshold: -1 };`),
  },
  { label: 'empty files', file: 'empty-files.rule.mjs', source: ruleWith('EmptyFiles', `  files = [];`) },
  {
    label: 'blank glob entry',
    file: 'blank-glob.rule.mjs',
    source: ruleWith('BlankGlob', `  files = [''];`),
  },
  {
    label: 'invalid grouping',
    file: 'grouping.rule.mjs',
    source: ruleWith('Grouping', `  group = 'nonsense';`),
  },
  {
    label: 'invalid folder level',
    file: 'level.rule.mjs',
    source: ruleWith('Level', `  group = { by: 'folder', level: 1 };`),
  },
  {
    label: 'import throws',
    file: 'import-throws.rule.mjs',
    source: `throw new Error('boom import');\n`,
    fragment: 'boom import',
  },
  {
    label: 'syntax error',
    file: 'syntax.rule.mjs',
    source: `import { Rule } from '@alex-dbs/rulekeeper';

export default class Broken extends Rule {
  check = async () => ({ status: 'pass' });
`,
  },
];

test('rejects malformed rule modules with their module path', async () => {
  for (const malformed of malformedCases) {
    const label = malformed.label;
    const root = await makeTempRoot(`bad-${malformed.file.replace(/[^a-zA-Z0-9]+/g, '-')}`);
    const file = await writeModule(join(root, '.rulekeeper', malformed.file), malformed.source);
    const fragments = malformed.fragment === undefined ? [file] : [file, malformed.fragment];
    await expectReject(label, () => loaderFor(root).load(selectionFor(root)), ...fragments);
  }
});

test('accepts every valid grouping form', async () => {
  const root = await makeTempRoot('groupings');
  await writeModule(
    join(root, '.rulekeeper', 'groupings.rule.mjs'),
    ruleWith('Groupings', `  group = { by: 'folder', level: 0 };`),
  );
  await writeModule(
    join(root, '.rulekeeper', 'clamped.rule.mjs'),
    ruleWith('Clamped', `  group = { by: 'folder', level: -2 };`),
  );
  await writeModule(
    join(root, '.rulekeeper', 'project.rule.mjs'),
    ruleWith('ProjectWide', `  group = 'project';`),
  );

  const loaded = await loaderFor(root).load(selectionFor(root));
  assert.deepStrictEqual(names(loaded), ['clamped', 'groupings', 'project']);
  const groupByName: Record<string, unknown> = {};
  for (const entry of loaded) groupByName[entry.name] = entry.rule.group;
  assert.deepStrictEqual(groupByName.clamped, { by: 'folder', level: -2 });
  assert.deepStrictEqual(groupByName.groupings, { by: 'folder', level: 0 });
  assert.equal(groupByName.project, 'project');
});

test('rejects an explicit rule reached through a directory symlink into the archive', async () => {
  const root = await makeTempRoot('explicit-archive-alias');
  const marker = join(root, 'old', 'imported.marker');
  const archived = await writeModule(
    join(root, 'old', 'legacy.rule.mjs'),
    `import { writeFileSync } from 'node:fs';

import { Rule, pass } from '@alex-dbs/rulekeeper';

writeFileSync(new URL('./imported.marker', import.meta.url), 'imported');

export default class AliasLegacy extends Rule {
  files = ['**/*'];
  check = async () => pass();
}
`,
  );
  await symlink(join(root, 'old'), join(root, 'alias-old'));
  const loader = loaderFor(root);

  await expectReject(
    'explicit file through an archive directory symlink',
    () => loader.load(selectionFor(root, { explicit: join(root, 'alias-old', 'legacy.rule.mjs') })),
    'legacy.rule.mjs',
  );
  await expectReject(
    'explicit directory symlink into the archive',
    () => loader.load(selectionFor(root, { explicit: join(root, 'alias-old') })),
    'alias-old',
  );
  await expectReject(
    'explicit physical archive path',
    () => loader.load(selectionFor(root, { explicit: archived })),
    archived,
  );

  assert.equal(
    await stat(marker).then(
      () => true,
      () => false,
    ),
    false,
    'the archived rule module must not be imported',
  );
});
