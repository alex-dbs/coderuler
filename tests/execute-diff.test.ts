import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Rule, pass } from '../dist/index.js';
import type { CheckContext, Grouping, RunContext, RunEvent, ScopeSubject, SelectionContext, Subject } from '../dist/index.js';
import { createProject } from '../dist/adapter/filesystem/project.js';
import { executeRules } from '../dist/app/execute.js';
import { createSandbox, writeFile } from './support.ts';

const sandbox = createSandbox('coderuler-execute-diff-');
after(() => sandbox.cleanup());

class RecordingRule extends Rule {
  files = ['**/*.txt'];
  readonly checked: Subject[] = [];
  readonly filtered: string[] = [];
  readonly comparisonFiles: string[][] = [];

  filter(subject: ScopeSubject): boolean {
    this.filtered.push(subject.filepath);
    return subject.source !== 'excluded';
  }

  check = async (subject: Subject, context: CheckContext) => {
    this.checked.push(subject);
    this.comparisonFiles.push((await context.select({ files: this.files })).map(item => item.filepath));
    return pass();
  };
}

function fixture(files: Readonly<Record<string, string>>) {
  const { cwd } = sandbox.isolated('project');
  for (const [filepath, source] of Object.entries(files)) writeFile(join(cwd, filepath), source);
  return createProject(cwd);
}

async function run(
  rule: Rule,
  project: RunContext['project'],
  changedFiles?: readonly string[],
  isTarget: RunContext['isTarget'] = () => true,
) {
  const events: RunEvent[] = [];
  const reports = await executeRules([{ name: 'diff', ruleFile: '.coderuler/diff.rule.ts', rule: rule as unknown as Rule<unknown> }], {
    project,
    isTarget,
    concurrency: 2,
    ...(changedFiles === undefined ? {} : { changedFiles: new Set(changedFiles) }),
    resolveDecision: () => { throw new Error('Local checks must not resolve AI'); },
    emit: event => events.push(event),
  });
  return { report: reports[0]!, events };
}

for (const group of ['scope', 'file'] as const) {
  test(`diff ${group} selection narrows before parsing and retains comparison context`, async () => {
    const project = fixture({ 'data/changed.txt': 'whole current file', 'data/unchanged.txt': 'comparison' });
    const rule = new RecordingRule();
    rule.group = group;
    const parsed: string[] = [];
    rule.scope = ({ filepath, source }) => {
      parsed.push(filepath);
      return [{ id: 'first', source }, { id: 'second', source }];
    };

    const { report } = await run(rule, project, ['data/changed.txt']);

    assert.equal(report.status, 'pass');
    assert.deepEqual(rule.filtered, ['data/changed.txt', 'data/changed.txt']);
    assert.equal(rule.checked.length, group === 'scope' ? 2 : 1);
    assert.deepEqual(parsed, ['data/changed.txt']);
    assert.deepEqual(rule.comparisonFiles[0], ['data/changed.txt', 'data/unchanged.txt']);
    assert.ok(report.evaluations.every(({ subject }) => subject.kind === 'scope'
      ? subject.source === 'whole current file'
      : subject.members.every(member => member.source === 'whole current file')));
  });
  test(`diff ${group} filters unchanged custom selections without narrowing CLI targets`, async () => {
    const project = fixture({ 'changed.txt': 'changed', 'unchanged.txt': 'unchanged' });
    class CustomRule extends RecordingRule {
      async select(_context: SelectionContext): Promise<readonly ScopeSubject[]> {
        return ['changed.txt', 'unchanged.txt'].map(filepath => ({
          kind: 'scope', filepath, id: 'whole', source: filepath,
        }));
      }
    }
    const rule = new CustomRule();
    rule.group = group;

    const { report } = await run(rule, project, ['changed.txt']);

    assert.equal(report.status, 'pass');
    assert.deepEqual(rule.filtered, ['changed.txt']);
    assert.equal(rule.checked.length, 1);
  });
}

test('diff folders retain unchanged members and trigger for deleted unselected paths', async () => {
  const project = fixture({
    'services/api/a.txt': 'a',
    'services/api/b.txt': 'b',
    'services/worker/a.txt': 'worker',
  });
  const rule = new RecordingRule();
  rule.group = 'folder';

  const { report, events } = await run(rule, project, ['services/api/deleted.json']);

  assert.equal(report.status, 'pass');
  assert.deepEqual(rule.checked, [{
    kind: 'group',
    group: { type: 'folder', path: 'services/api' },
    members: [
      { kind: 'scope', filepath: 'services/api/a.txt', id: '$', source: 'a', lines: { start: 1, end: 1 } },
      { kind: 'scope', filepath: 'services/api/b.txt', id: '$', source: 'b', lines: { start: 1, end: 1 } },
    ],
  }]);
  assert.equal(events.filter(event => event.type === 'group').length, 1);
});

test('diff folder levels gate by ancestor folder rather than immediate selected members', async () => {
  const project = fixture({
    'services/api/config/a.txt': 'a',
    'services/api/config/b.txt': 'b',
    'services/worker/config/a.txt': 'worker',
  });
  const rule = new RecordingRule();
  rule.group = { by: 'folder', level: -1 };

  await run(rule, project, ['services/api/src/deleted.ts']);

  assert.equal(rule.checked.length, 1);
  const subject = rule.checked[0]!;
  assert.equal(subject.kind, 'group');
  if (subject.kind !== 'group') throw new Error('Expected folder group');
  assert.deepEqual(subject.group, { type: 'folder', path: 'services/api' });
  assert.deepEqual(subject.members.map(member => member.filepath), ['services/api/config/a.txt', 'services/api/config/b.txt']);
});

for (const group of ['folder', 'project', { by: 'folder', level: -1 }] satisfies Grouping[]) {
  test(`diff ${JSON.stringify(group)} ignores changed paths outside the positional target`, async () => {
    const project = fixture({ 'services/api/config/a.txt': 'a', 'services/worker/config/a.txt': 'worker' });
    const rule = new RecordingRule();
    rule.group = group;

    const { report, events } = await run(rule, project, ['services/worker/deleted.txt'], path => path.startsWith('services/api/'));

    assert.equal(report.status, 'skipped');
    assert.deepEqual(report.evaluations, []);
    assert.deepEqual(rule.checked, []);
    assert.equal(events.filter(event => event.type === 'group').length, 0);
  });
}

test('diff folder boundaries do not confuse sibling path prefixes', async () => {
  const project = fixture({ 'services/api/a.txt': 'a' });
  const rule = new RecordingRule();
  rule.group = 'folder';

  const { report } = await run(rule, project, ['services/api-v2/deleted.txt']);

  assert.equal(report.status, 'skipped');
  assert.deepEqual(rule.checked, []);
});

test('diff project checks retain all selected members and full project access', async () => {
  const project = fixture({ 'target/a.txt': 'a', 'target/b.txt': 'b', 'context/reference.json': '{"limit":2}' });
  class ProjectRule extends RecordingRule {
    check = async (subject: Subject, context: CheckContext) => {
      this.checked.push(subject);
      assert.deepEqual(await context.project.readJson('context/reference.json'), { limit: 2 });
      return pass();
    };
  }
  const rule = new ProjectRule();
  rule.group = 'project';

  const { report } = await run(rule, project, ['target/deleted.txt'], path => path.startsWith('target/'));

  assert.equal(report.status, 'pass');
  const subject = rule.checked[0]!;
  assert.equal(subject.kind, 'group');
  if (subject.kind !== 'group') throw new Error('Expected project group');
  assert.deepEqual(subject.members.map(member => member.filepath), ['target/a.txt', 'target/b.txt']);
});

test('diff empty changes and fully removed groups are skipped without synthetic groups', async () => {
  const project = fixture({ 'survivor/a.txt': 'a' });
  for (const changes of [[], ['removed/deleted.txt']]) {
    const rule = new RecordingRule();
    rule.group = 'folder';
    const { report } = await run(rule, project, changes);
    assert.equal(report.status, 'skipped');
    assert.deepEqual(rule.checked, []);
  }
});

test('diff grouping still trusts filters and does not create groups with rejected members', async () => {
  const project = fixture({ 'data/a.txt': 'excluded' });
  const rule = new RecordingRule();
  rule.group = 'project';

  const { report } = await run(rule, project, ['data/a.txt']);

  assert.equal(report.status, 'skipped');
  assert.deepEqual(rule.filtered, ['data/a.txt']);
  assert.deepEqual(rule.checked, []);
});

test('normal execution keeps unchanged subjects when no changed-file set is supplied', async () => {
  const project = fixture({ 'a.txt': 'a', 'b.txt': 'b' });
  const rule = new RecordingRule();

  const { report } = await run(rule, project);

  assert.equal(report.status, 'pass');
  assert.deepEqual(rule.filtered, ['a.txt', 'b.txt']);
  assert.equal(rule.checked.length, 2);
});
