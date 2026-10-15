import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { test } from 'node:test';

import { discoverRuleFiles, loadRules } from './rule-loader.ts';

interface Roots {
  readonly project: string;
  readonly home: string;
}

async function withRoots(run: (roots: Roots) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'rulekeeper-loader-'));
  try {
    const roots: Roots = { project: join(workspace, 'project'), home: join(workspace, 'home') };
    mkdirSync(roots.project, { recursive: true });
    mkdirSync(roots.home, { recursive: true });
    await run(roots);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function ruleYaml(name: string, included = '**/*.ts'): string {
  return [
    "version: 'v1'",
    `name: ${name}`,
    'files:',
    '  included:',
    `    - '${included}'`,
    'scope:',
    '  format: yaml',
    "  path: '$'",
    '  changed: false',
    'rule: Review the named source.',
  ].join('\n');
}

function writeRule(root: string, relativePath: string, name: string, included?: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ruleYaml(name, included), 'utf8');
  return path;
}

test('discovers nested rules of both roots, local first, each root lexically sorted', async () => {
  await withRoots(async ({ project, home }) => {
    const local = join(project, '.rulekeeper');
    const user = join(home, '.rulekeeper');
    const localAlpha = writeRule(local, 'alpha.yml', 'Alpha local rule');
    const localMiddle = writeRule(local, join('more', 'middle.yaml'), 'Middle local rule');
    const localDeep = writeRule(local, join('nested', 'Deep.YAML'), 'Deep local rule');
    writeFileSync(join(local, 'notes.txt'), 'not a rule\n', 'utf8');
    const userDeep = writeRule(user, join('deep', 'deeper', 'leaf.yml'), 'Leaf home rule');
    const userRoot = writeRule(user, 'root.yaml', 'Root home rule');

    const files = await discoverRuleFiles({ cwd: project, home });

    // The home root's paths sort before the project root's as plain strings, so this pins that the
    // local root still comes first and that each root's own rules are lexically ordered by path.
    assert.deepEqual(files, [localAlpha, localMiddle, localDeep, userDeep, userRoot]);
    assert.ok(files.every(isAbsolute));
  });
});

test('ignores non-rule files, symlinked entries and a symlink cycle inside a root', async () => {
  await withRoots(async ({ project, home }) => {
    const local = join(project, '.rulekeeper');
    const outside = join(project, 'outside.yaml');
    writeFileSync(outside, ruleYaml('Outside rule'), 'utf8');
    const kept = writeRule(local, join('sub', 'kept.yaml'), 'Kept rule');
    writeFileSync(join(local, 'readme'), 'no extension\n', 'utf8');
    writeFileSync(join(local, 'image.png'), 'binary-ish\n', 'utf8');
    mkdirSync(join(local, 'empty-dir'), { recursive: true });
    // A file symlink to a real rule and two directory symlinks — one back to the root itself — must
    // all be ignored, and the cycle must not make the walk recurse forever.
    symlinkSync(outside, join(local, 'linked.yaml'), 'file');
    symlinkSync(local, join(local, 'loop'), 'dir');
    symlinkSync(join(local, 'sub'), join(local, 'linked-dir'), 'dir');

    assert.deepEqual(await discoverRuleFiles({ cwd: project, home }), [kept]);
  });
});

test('ignores a root that is itself a symlink', async () => {
  await withRoots(async ({ project, home }) => {
    const real = join(project, 'real-rules');
    writeRule(real, 'rule.yaml', 'Linked root rule');
    symlinkSync(real, join(project, '.rulekeeper'), 'dir');

    assert.deepEqual(await discoverRuleFiles({ cwd: project, home }), []);
  });
});

test('an absent local root still yields the home root rules, and both absent yields none', async () => {
  await withRoots(async ({ project, home }) => {
    const homeRule = writeRule(join(home, '.rulekeeper'), 'only.yaml', 'Home rule');

    assert.deepEqual(await discoverRuleFiles({ cwd: project, home }), [homeRule]);
    assert.deepEqual(
      await discoverRuleFiles({ cwd: join(project, 'does-not-exist'), home: join(home, 'also-missing') }),
      [],
    );
  });
});

test('never walks above a root: an ancestor .rulekeeper is not searched', async () => {
  await withRoots(async ({ project, home }) => {
    writeRule(join(dirname(project), '.rulekeeper'), 'ancestor.yaml', 'Ancestor rule');
    const own = writeRule(join(project, '.rulekeeper'), 'own.yaml', 'Own rule');

    assert.deepEqual(await discoverRuleFiles({ cwd: project, home }), [own]);
  });
});

test('a root that is a file fails instead of being skipped', async () => {
  await withRoots(async ({ project, home }) => {
    writeFileSync(join(project, '.rulekeeper'), 'a file where a directory is expected\n', 'utf8');

    await assert.rejects(discoverRuleFiles({ cwd: project, home }), (error: unknown) => {
      assert.strictEqual((error as NodeJS.ErrnoException).code, 'ENOTDIR');
      return true;
    });
  });
});

test('a root reached through both roots is walked exactly once', async () => {
  await withRoots(async ({ project }) => {
    const rule = writeRule(join(project, '.rulekeeper'), join('nested', 'shared.yaml'), 'Shared rule');

    assert.deepEqual(await discoverRuleFiles({ cwd: project, home: project }), [rule]);
  });
});

test('roots that are one physical directory through a parent link load once, in the first spelling', async () => {
  await withRoots(async ({ project }) => {
    const rule = writeRule(join(project, '.rulekeeper'), join('nested', 'shared.yaml'), 'Shared rule');
    const alias = join(dirname(project), 'project-link');
    // Neither root is a link itself; both reach one physical `.rulekeeper`, so only the directory
    // identity — not the spelling — can tell the two roots apart.
    symlinkSync(project, alias, 'dir');
    const linkedRule = join(alias, '.rulekeeper', 'nested', 'shared.yaml');

    assert.deepEqual(await discoverRuleFiles({ cwd: project, home: alias }), [rule]);
    assert.deepEqual(await discoverRuleFiles({ cwd: alias, home: project }), [linkedRule]);
  });
});

test('loadRules rejects a malformed and a missing rule with the filepath and the cause', async () => {
  await withRoots(async ({ home }) => {
    const broken = writeRule(home, 'rules/broken.yaml', 'Broken rule');
    writeFileSync(broken, 'version: v2\nname: Broken rule\n', 'utf8');

    await assert.rejects(loadRules(broken), (error: unknown) => {
      const failure = error as Error;
      const cause = failure.cause;
      assert.match(failure.message, /rules[/\\]broken\.yaml/);
      assert.ok(cause instanceof Error);
      return true;
    });

    await assert.rejects(loadRules(join(home, 'no-such-rule.yaml')), (error: unknown) => {
      const failure = error as Error;
      const cause = failure.cause;
      assert.match(failure.message, /no-such-rule\.yaml/);
      assert.strictEqual((cause as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');
      return true;
    });
  });
});

test('loadRules compiles the .yaml and .yml rules under an explicit directory, nested and sorted', async () => {
  await withRoots(async ({ home }) => {
    const root = join(home, 'rules');
    const topRule = writeRule(root, 'b.yaml', 'Top rule', '**/*.ts');
    const nestedRule = writeRule(root, join('nested', 'a.yml'), 'Nested rule', '**/*.md');
    const upperRule = writeRule(root, join('nested', 'c.YML'), 'Upper rule', '**/*.json');
    writeFileSync(join(root, 'notes.txt'), ruleYaml('Not a rule'), 'utf8');
    writeFileSync(join(root, 'nested', 'image.png'), 'not yaml\n', 'utf8');
    // A link to a real rule in the same directory is skipped, exactly as discovery skips links.
    symlinkSync(topRule, join(root, 'linked.yaml'));

    const loaded = await loadRules(root);

    assert.deepEqual(loaded.map(entry => entry.filepath), [topRule, nestedRule, upperRule]);
    // The entries are compiled rules, not re-read shape: `matchesFile` is the compiled selection and
    // the real `yaml` plugin agrees with it, both accepting Markdown only through the nested rule.
    assert.deepEqual(loaded.map(entry => entry.rule.matchesFile('src/a.md')), [false, true, false]);
    const selecting = loaded.filter(entry => entry.rule.match({ filepath: 'src/a.md', source: 'a: 1\n' }).length === 1);
    assert.deepEqual(selecting.map(entry => entry.rule.name), ['Nested rule']);
  });
});

test('an explicit directory with no rule files fails naming that directory, not a discovery root', async () => {
  await withRoots(async ({ home }) => {
    const root = join(home, 'not-rules');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'notes.txt'), ruleYaml('Not a rule'), 'utf8');
    writeFileSync(join(root, 'sub', 'rule.json'), '{}\n', 'utf8');

    await assert.rejects(loadRules(root), (error: unknown) => {
      const failure = error as Error;
      assert.ok(failure.message.includes(root), `expected the failure to name ${root}: ${failure.message}`);
      return true;
    });
  });
});

test('loadRules rejects an invalid rule in an explicit directory before returning any rule', async () => {
  await withRoots(async ({ home }) => {
    const root = join(home, 'rules');
    // The valid rule sorts first, so a load that returned its valid prefix could resolve; the whole
    // load must reject instead, naming the broken file that a prefix-only load would never reach.
    writeRule(root, 'a-valid.yaml', 'Valid rule');
    const broken = writeRule(root, join('nested', 'b-broken.yaml'), 'Broken rule');
    writeFileSync(broken, "version: 'v1'\nname: Broken rule\nscope:\n  format: yaml\n  path: '$'\n", 'utf8');

    await assert.rejects(loadRules(root), (error: unknown) => {
      const failure = error as Error;
      assert.match(failure.message, /b-broken\.yaml/);
      assert.ok(failure.cause instanceof Error);
      return true;
    });
  });
});

test('an explicit rule file loads that file only, never the rules beside it', async () => {
  await withRoots(async ({ home }) => {
    const root = join(home, 'rules');
    const one = writeRule(root, 'one.yaml', 'One rule', '**/*.md');
    writeRule(root, 'two.yaml', 'Two rule', '**/*.md');

    const loaded = await loadRules(one);

    assert.deepEqual(loaded.map(entry => entry.filepath), [one]);
    assert.equal(loaded[0]!.rule.match({ filepath: 'src/a.md', source: 'a: 1\n' }).length, 1);
  });
});

test('an explicit path that is itself a symlink is followed, and loads under the name it was given', async () => {
  await withRoots(async ({ home }) => {
    const root = join(home, 'rules');
    const rule = writeRule(root, join('nested', 'rule.yaml'), 'Named rule');
    symlinkSync(root, join(home, 'rules-link'), 'dir');
    symlinkSync(rule, join(home, 'rule-link.yaml'), 'file');

    const directory = await loadRules(join(home, 'rules-link'));
    assert.deepEqual(directory.map(entry => entry.filepath), [join(home, 'rules-link', 'nested', 'rule.yaml')]);
    assert.equal(directory[0]!.rule.name, 'Named rule');

    const single = await loadRules(join(home, 'rule-link.yaml'));
    assert.deepEqual(single.map(entry => entry.filepath), [join(home, 'rule-link.yaml')]);
    assert.equal(single[0]!.rule.name, 'Named rule');
  });
});
