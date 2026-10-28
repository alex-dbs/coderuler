import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Rule, pass, violation } from '../dist/index.js';
import type { CheckContext, Grouping, JsonValue, LineRange, ProjectContext, RunContext, RunEvent, ScopeMatch, ScopeSubject, SelectionContext, Subject } from '../dist/index.js';
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
  changedLines?: ReadonlyMap<string, readonly LineRange[]>,
) {
  const events: RunEvent[] = [];
  const reports = await executeRules([{ name: 'diff', ruleFile: '.coderuler/diff.rule.ts', rule: rule as unknown as Rule<unknown> }], {
    project,
    isTarget,
    concurrency: 2,
    ...(changedFiles === undefined ? {} : { changedFiles: new Set(changedFiles) }),
    ...(changedLines === undefined ? {} : { changedLines }),
    resolveDecision: () => { throw new Error('Local checks must not resolve AI'); },
    emit: event => events.push(event),
  });
  return { report: reports[0]!, events };
}

function rangesFor(context: ProjectContext, filepath: string): readonly LineRange[] | undefined {
  return context.changedLines?.get(filepath);
}

function overlaps(line: number, ranges: readonly LineRange[] | undefined): boolean {
  return ranges === undefined || ranges.some(range => line >= range.start && line <= range.end);
}

function lineScopes(source: string, ranges: readonly LineRange[] | undefined): readonly ScopeMatch<JsonValue>[] {
  return source.split('\n').flatMap((line, index) => {
    const number = index + 1;
    return overlaps(number, ranges)
      ? [{ id: `line-${number}`, source: line, lines: { start: number, end: number } }]
      : [];
  });
}

class RangeAwareRule extends Rule {
  files = ['**/*.txt'];
  readonly selected: ScopeSubject[] = [];
  readonly filtered: string[] = [];
  readonly whenResults: boolean[] = [];
  nestedSources: string[] = [];
  filterWithoutSelectionNarrowing = false;

  when(context: ProjectContext): boolean {
    const ranges = rangesFor(context, 'src/a.txt');
    const changed = context.changedFiles;
    const applies = changed === undefined
      ? true
      : changed.has('src/a.txt') && (ranges === undefined || ranges.length > 0);

    this.whenResults.push(applies);
    return applies;
  }

  async select(context: SelectionContext): Promise<readonly ScopeSubject[]> {
    const candidates = await context.select<JsonValue>({ files: this.files, scope: (file, nestedContext) =>
      lineScopes(file.source, this.filterWithoutSelectionNarrowing
        ? undefined
        : rangesFor(nestedContext ?? context, file.filepath)) });

    return this.filterWithoutSelectionNarrowing
      ? candidates.filter(candidate => overlaps(candidate.lines?.start ?? 1, rangesFor(context, candidate.filepath)))
      : candidates;
  }

  filter(subject: ScopeSubject, context: ProjectContext): boolean {
    this.filtered.push(`${subject.filepath}:${subject.lines?.start}`);
    const ranges = rangesFor(context, subject.filepath);
    return ranges === undefined || overlaps(subject.lines?.start ?? 1, ranges);
  }

  check = async (subject: Subject, context: CheckContext) => {
    this.selected.push(...(subject.kind === 'group' ? subject.members : [subject]));
    const nested = await context.select<JsonValue>({ files: this.files, scope: (file, nestedContext) =>
      lineScopes(file.source, rangesFor(nestedContext ?? context, file.filepath)) });
    this.nestedSources = nested.map(candidate => candidate.source);
    const ranges = rangesFor(context, 'src/a.txt');
    const candidates = subject.kind === 'group' ? subject.members : [subject];
    const changedBad = candidates.find(candidate => candidate.source.startsWith('BAD')
      && (context.changedFiles === undefined || ranges === undefined || overlaps(candidate.lines?.start ?? 1, ranges)));
    if (changedBad !== undefined) {
      const lines = changedBad.lines;
      return violation('Changed bad line', [{ filepath: changedBad.filepath, ...(lines === undefined ? {} : { lines }) }]);
    }
    return pass();
  };
}

class RangeIgnoringRule extends Rule {
  files = ['**/*.txt'];
  readonly checked: ScopeSubject[] = [];

  scope = ({ source }: { filepath: string; source: string }) => lineScopes(source, undefined);

  check = async (subject: Subject) => {
    this.checked.push(...(subject.kind === 'group' ? subject.members : [subject]));
    return pass();
  };
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

test('range-aware scope selection reports only the changed line while nested contexts retain its range', async () => {
  const project = fixture({ 'src/a.txt': 'BAD unchanged\nBAD changed\nclean' });
  const rule = new RangeAwareRule();
  const { report } = await run(rule, project, ['src/a.txt'], () => true, new Map([
    ['src/a.txt', [{ start: 2, end: 2 }]],
  ]));

  assert.equal(report.status, 'violation');
  assert.equal(report.evaluations.length, 1);
  assert.deepEqual(report.evaluations[0]?.result, {
    status: 'violation',
    message: 'Changed bad line',
    locations: [{ filepath: 'src/a.txt', lines: { start: 2, end: 2 } }],
  });
  assert.deepEqual(rule.whenResults, [true]);
  assert.deepEqual(rule.filtered, ['src/a.txt:2']);
  assert.deepEqual(rule.selected.map(subject => subject.source), ['BAD changed']);
  assert.deepEqual(rule.nestedSources, ['BAD changed']);
});

test('range-ignoring selectors still evaluate every scope in a changed file', async () => {
  const project = fixture({ 'src/a.txt': 'BAD unchanged\nBAD changed\nclean' });
  const rule = new RangeIgnoringRule();

  const { report } = await run(rule, project, ['src/a.txt'], () => true, new Map([
    ['src/a.txt', [{ start: 2, end: 2 }]],
  ]));

  assert.equal(report.status, 'pass');
  assert.deepEqual(rule.checked.map(subject => subject.source), ['BAD unchanged', 'BAD changed', 'clean']);
});

test('missing diff data takes the range-aware full-scan branch and empty diff has no subjects', async () => {
  const project = fixture({ 'src/a.txt': 'BAD unchanged\nBAD changed\nclean' });
  const fullScan = new RangeAwareRule();

  const withoutDiff = await run(fullScan, project);

  assert.equal(withoutDiff.report.status, 'violation');
  assert.deepEqual(fullScan.whenResults, [true]);
  assert.deepEqual(fullScan.selected.map(subject => subject.source), ['BAD unchanged', 'BAD changed', 'clean']);

  const emptyDiff = new RangeAwareRule();
  const noChanges = await run(emptyDiff, project, []);

  assert.equal(noChanges.report.status, 'skipped');
  assert.deepEqual(emptyDiff.whenResults, [false]);
  assert.deepEqual(emptyDiff.selected, []);
});

test('range-aware overridden selection and filter use line ranges to choose subjects', async () => {
  const project = fixture({ 'src/a.txt': 'BAD unchanged\nBAD changed\nclean' });
  const rule = new RangeAwareRule();
  rule.group = 'file';

  const { report } = await run(rule, project, ['src/a.txt'], () => true, new Map([
    ['src/a.txt', [{ start: 2, end: 2 }]],
  ]));

  assert.equal(report.status, 'violation');
  assert.deepEqual(rule.filtered, ['src/a.txt:2']);
  assert.deepEqual(rule.selected.map(subject => subject.source), ['BAD changed']);
});

test('range-aware filter drops unchanged scopes returned by the overridden selector', async () => {
  const project = fixture({ 'src/a.txt': 'BAD unchanged\nBAD changed\nclean' });
  const rule = new RangeAwareRule();
  rule.filterWithoutSelectionNarrowing = true;

  await run(rule, project, ['src/a.txt'], () => true, new Map([
    ['src/a.txt', [{ start: 2, end: 2 }]],
  ]));

  assert.deepEqual(rule.filtered, ['src/a.txt:2']);
  assert.deepEqual(rule.selected.map(subject => subject.source), ['BAD changed']);
});

test('when can skip an otherwise changed file with no changed-line ranges', async () => {
  const project = fixture({ 'src/a.txt': 'BAD unchanged\nBAD changed\nclean' });
  const rule = new RangeAwareRule();

  const { report } = await run(rule, project, ['src/a.txt'], () => true, new Map([
    ['src/a.txt', []],
  ]));

  assert.equal(report.status, 'skipped');
  assert.deepEqual(rule.whenResults, [false]);
  assert.deepEqual(rule.filtered, []);
  assert.deepEqual(rule.selected, []);
});

