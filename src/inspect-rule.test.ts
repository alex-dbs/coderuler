import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { createRuleSelector, resolveInspectionFolder } from './adapter/filesystem/rule-selector.ts';
import type { RuleSelector } from './app/ports/rules.ts';

interface Roots {
  readonly workspace: string;
  readonly invocation: string;
  readonly project: string;
  readonly home: string;
}

async function withRoots(run: (roots: Roots) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'rulekeeper-inspect-rule-'));
  try {
    const roots: Roots = {
      workspace,
      invocation: join(workspace, 'invocation'),
      project: join(workspace, 'project'),
      home: join(workspace, 'home'),
    };
    for (const root of [roots.invocation, roots.project, roots.home]) mkdirSync(root, { recursive: true });
    await run(roots);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function ruleYaml(included = '**/*.yaml'): string {
  return [
    "version: 'v1'",
    'files:',
    '  included:',
    `    - '${included}'`,
    'scope:',
    '  format: yaml',
    "  path: '$'",
    'check:',
    '  rule: Review the named source.',
    '',
  ].join('\n');
}

function writeRule(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ruleYaml(), 'utf8');
  return path;
}

function selectorFor(roots: Roots): RuleSelector {
  return createRuleSelector({ cwd: roots.project, invocationCwd: roots.invocation, home: roots.home });
}

test('inspect selects an explicit rule file resolved from the invocation cwd', async () => {
  await withRoots(async (roots) => {
    const outside = writeRule(join(roots.workspace, 'outside', 'rules.yml'));
    const selector = selectorFor(roots);

    const fromParent = await selector.select('../outside/rules.yml');
    assert.deepStrictEqual(fromParent, { filepath: outside, source: ruleYaml() });

    const fromAbsolute = await selector.select(outside);
    assert.strictEqual(fromAbsolute.filepath, outside, 'an absolute selector is used as given');
  });
});

test('an existing rule path wins over a discovered rule of the same stem', async () => {
  await withRoots(async (roots) => {
    const explicit = writeRule(join(roots.invocation, 'rules.yml'));
    const discovered = writeRule(join(roots.project, '.rulekeeper', 'rules.yaml'));
    const selector = selectorFor(roots);

    const byPath = await selector.select('rules.yml');
    assert.strictEqual(byPath.filepath, explicit);
    assert.strictEqual(byPath.source, ruleYaml());

    // The stem is the identity, so the discovered rule answers to it once no such path exists.
    assert.strictEqual((await selector.select('rules')).filepath, discovered);
  });
});

test('inspect resolves an exact rule stem inside the selected folder and the home root', async () => {
  await withRoots(async (roots) => {
    const local = writeRule(join(roots.project, '.rulekeeper', 'alpha.yml'));
    const home = writeRule(join(roots.home, '.rulekeeper', 'deep', 'beta.yaml'));
    const pathLooking = writeRule(join(roots.project, '.rulekeeper', 'path-looking.yml'));
    const selector = selectorFor(roots);

    assert.strictEqual((await selector.select('alpha')).filepath, local);
    assert.strictEqual((await selector.select('beta')).filepath, home);
    assert.strictEqual((await selector.select('path-looking')).filepath, pathLooking);

    await assert.rejects(selector.select('Alpha'), /No rule named 'Alpha' found under .*project\/\.rulekeeper or .*home\/\.rulekeeper/);
    await assert.rejects(selector.select('gamma'), /No rule named 'gamma' found/);
    // The extension is not part of the identity: a filename-looking selector is either a reachable
    // path or a miss, never a stem.
    await assert.rejects(selector.select('alpha.yml'), {
      message: `Rule path ${join(roots.invocation, 'alpha.yml')} does not exist`,
    });
  });
});

test('a legacy declared name is not an identity: only the filename stem resolves', async () => {
  await withRoots(async (roots) => {
    const legacy = join(roots.project, '.rulekeeper', 'legacy.yml');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, `name: Legacy rule\n${ruleYaml()}`, 'utf8');

    const selector = selectorFor(roots);
    assert.strictEqual((await selector.select('legacy')).filepath, legacy);
    await assert.rejects(selector.select('Legacy rule'), /No rule named 'Legacy rule' found/);
  });
});

test('an ambiguous rule stem lists every matching rule file', async () => {
  await withRoots(async (roots) => {
    const local = writeRule(join(roots.project, '.rulekeeper', 'dup.yml'));
    const home = writeRule(join(roots.home, '.rulekeeper', 'dup.yaml'));

    await assert.rejects(selectorFor(roots).select('dup'), (error: Error) => {
      assert.match(error.message, /Rule name 'dup' matches 2 rule files:/);
      assert.deepStrictEqual(error.message.split('\n').slice(1), [`  ${local}`, `  ${home}`]);
      return true;
    });
  });
});

test('inspect rejects a directory, a missing path and a symlinked rule file', async () => {
  await withRoots(async (roots) => {
    const selector = selectorFor(roots);
    mkdirSync(join(roots.invocation, '.rulekeeper'), { recursive: true });

    await assert.rejects(selector.select('.rulekeeper'), {
      message: `Inspect takes exactly one rule file, but ${join(roots.invocation, '.rulekeeper')} is a directory`,
    });
    await assert.rejects(selector.select('nope/missing.yml'), {
      message: `Rule path ${join(roots.invocation, 'nope', 'missing.yml')} does not exist`,
    });
    await assert.rejects(selector.select('./'), {
      message: `Inspect takes exactly one rule file, but ${roots.invocation} is a directory`,
    });

    const real = writeRule(join(roots.invocation, 'real.yml'));
    const link = join(roots.invocation, 'link.yml');
    symlinkSync(real, link);
    await assert.rejects(selector.select('link.yml'), {
      message: `Rule path ${link} is a symbolic link; point inspect at the real rule file`,
    });
  });
});

test('selecting a rule never parses a sibling descriptor', async () => {
  await withRoots(async (roots) => {
    const local = join(roots.project, '.rulekeeper');
    mkdirSync(local, { recursive: true });
    const brokenPath = join(local, 'broken.yml');
    writeFileSync(brokenPath, 'name: [broken\n', 'utf8');
    writeFileSync(join(local, 'not-a-rule.txt'), 'name: Good rule\n', 'utf8');
    const good = writeRule(join(local, 'good.yml'));

    assert.strictEqual((await selectorFor(roots).select('good')).filepath, good);

    const broken = await selectorFor(roots).select(brokenPath);
    assert.ok(broken.source.startsWith('name: [broken'), 'a path selector returns the raw source unvalidated');
  });
});

test('resolveInspectionFolder validates the working root without touching the process cwd', async () => {
  await withRoots(async (roots) => {
    const before = process.cwd();
    assert.strictEqual(await resolveInspectionFolder('.', roots.project), roots.project);
    assert.strictEqual(await resolveInspectionFolder(join('nested', '..'), roots.project), roots.project);
    assert.strictEqual(process.cwd(), before);

    await assert.rejects(resolveInspectionFolder('absent', roots.project), {
      message: `Inspection folder ${join(roots.project, 'absent')} does not exist`,
    });

    const file = writeRule(join(roots.project, 'rules.yml'));
    await assert.rejects(resolveInspectionFolder('rules.yml', roots.project), {
      message: `Inspection folder ${file} is not a directory`,
    });
    await assert.rejects(resolveInspectionFolder('.', file), {
      message: `Inspection folder ${file} is not a directory`,
    });
    await assert.rejects(resolveInspectionFolder(join('rules.yml', 'nested'), roots.project), {
      message: `Inspection folder ${join(file, 'nested')} does not exist`,
    });

    const link = join(roots.workspace, 'linked');
    symlinkSync(roots.project, link);
    await assert.rejects(resolveInspectionFolder(link, roots.workspace), {
      message: `Inspection folder ${link} is a symbolic link; point inspect at the real directory`,
    });
  });
});
