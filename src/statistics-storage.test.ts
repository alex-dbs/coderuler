import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { createSqliteStatistics } from './adapter/sqlite/statistics.ts';
import type { EvaluationStatistics, StatisticsSnapshot, StatisticsTotals } from './app/ports/statistics.ts';

const ADAPTER = fileURLToPath(new URL('./adapter/sqlite/statistics.ts', import.meta.url));

const EMPTY: StatisticsSnapshot = {
  total: { runs: 0, rules: 0, verifications: 0, violations: 0, elapsedMs: 0 },
  projects: [],
};

interface Workspace {
  readonly dir: string;
  readonly db: string;
  cleanup(): void;
}

function createWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'rulekeeper-statistics-'));
  return { dir, db: join(dir, 'stats.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function evaluation(overrides: Partial<EvaluationStatistics> = {}): EvaluationStatistics {
  return { rules: 1, verifications: 1, violations: 0, elapsedMs: 1, ...overrides };
}

function sumProjects(snapshot: StatisticsSnapshot): StatisticsTotals {
  return snapshot.projects.reduce(
    (totals, project) => ({
      runs: totals.runs + project.runs,
      rules: totals.rules + project.rules,
      verifications: totals.verifications + project.verifications,
      violations: totals.violations + project.violations,
      elapsedMs: totals.elapsedMs + project.elapsedMs,
    }),
    { runs: 0, rules: 0, verifications: 0, violations: 0, elapsedMs: 0 },
  );
}

const RECORD_ARGUMENTS = '{ rules: 1, verifications: 2, violations: 1, elapsedMs: 2 }';

const TICK_LOOP = [
  "process.stdout.write('ready\\n');",
  'for (let index = 0; index < total; index += 1) {',
  '  step();',
  "  process.stdout.write('tick\\n');",
  '  const gate = Promise.withResolvers();',
  "  process.stdin.once('data', gate.resolve);",
  '  await gate.promise;',
  '}',
];

const PLAIN_LOOP = ['for (let index = 0; index < total; index += 1) step();'];

function recorderScript(ticked: boolean): string {
  return [
    `import { createSqliteStatistics } from ${JSON.stringify(pathToFileURL(ADAPTER).href)};`,
    'const [file, project, count] = process.argv.slice(2);',
    'const store = createSqliteStatistics(file);',
    'const total = Number(count);',
    `const step = () => store.record(project, ${RECORD_ARGUMENTS});`,
    ...(ticked ? TICK_LOOP : PLAIN_LOOP),
    '',
  ].join('\n');
}

function runRecorder(script: string, db: string, project: string, count: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(process.execPath, [script, db, project, String(count)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('exit', code => {
    if (code === 0) resolve();
    else reject(new Error(`recorder exited with ${String(code)}: ${stderr}`));
  });
  return promise;
}

interface Recorder {
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  nextTick(): Promise<void>;
  release(): void;
  finish(): void;
  stop(): void;
}

function startRecorder(script: string, db: string, project: string, count: number): Recorder {
  const child = spawn(process.execPath, [script, db, project, String(count)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const settled = Promise.withResolvers<void>();
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let stderr = '';
  let buffered = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const waiter = waiting.shift();
      if (waiter === undefined) queued.push(line);
      else waiter(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', settled.reject);
  child.on('exit', code => {
    for (const waiter of waiting.splice(0)) waiter('');
    if (code === 0) settled.resolve();
    else settled.reject(new Error(`recorder exited with ${String(code)}: ${stderr}`));
  });
  settled.promise.catch(() => undefined);

  const nextLine = (): Promise<string> => {
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    const { promise, resolve } = Promise.withResolvers<string>();
    waiting.push(resolve);
    return promise;
  };

  return {
    ready: nextLine().then(() => undefined),
    done: settled.promise,
    nextTick: () => nextLine().then(() => undefined),
    release: () => {
      child.stdin.write('go\n');
    },
    finish: () => {
      child.stdin.end();
    },
    stop: () => {
      child.kill();
    },
  };
}

test('a missing database reads as an empty snapshot without creating the file', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);

  const snapshot = createSqliteStatistics(workspace.db).read();

  assert.deepEqual(snapshot, EMPTY);
  assert.equal(existsSync(workspace.db), false);
});

test('recording counts one run per project', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  const store = createSqliteStatistics(workspace.db);

  store.record('/work/alpha', { rules: 3, verifications: 5, violations: 2, elapsedMs: 12 });

  assert.deepEqual(store.read(), {
    total: { runs: 1, rules: 3, verifications: 5, violations: 2, elapsedMs: 12 },
    projects: [{ project: '/work/alpha', runs: 1, rules: 3, verifications: 5, violations: 2, elapsedMs: 12 }],
  });
});

test('repeat recordings accumulate into the existing project row', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  const store = createSqliteStatistics(workspace.db);

  store.record('/work/alpha', evaluation({ rules: 1, verifications: 2, violations: 1, elapsedMs: 0.5 }));
  store.record('/work/alpha', evaluation({ rules: 2, verifications: 3, violations: 0, elapsedMs: 0.25 }));

  const expected = { runs: 2, rules: 3, verifications: 5, violations: 1, elapsedMs: 0.75 };
  assert.deepEqual(store.read().projects, [{ project: '/work/alpha', ...expected }]);
  assert.deepEqual(store.read().total, expected);
});

test('statistics keep one aggregate row per project with no dated or historical state', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  const store = createSqliteStatistics(workspace.db);

  store.record('/work/alpha', evaluation());
  store.record('/work/alpha', evaluation());
  store.record('/work/alpha', evaluation());
  store.record('/work/beta', evaluation());

  const db = new Database(workspace.db, { readonly: true });
  try {
    const columns = (
      db.prepare('SELECT name FROM pragma_table_info(?)').all('statistics') as { name: string }[]
    ).map(row => row.name);
    const dated = columns.filter(name =>
      /(^|_)(date|time|timestamp|at|created|updated|history|payload|source)(_|$)/.test(name),
    );
    assert.deepEqual(dated, [], 'statistics must not store dates, history, payloads or identities');
    const counted = db.prepare('SELECT COUNT(*) AS total FROM statistics').get() as { total: number };
    assert.equal(counted.total, 2, 'four recordings across two projects must keep one row per project');
  } finally {
    db.close();
  }
});

test('projects are ordered by path and totals sum every project', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  const store = createSqliteStatistics(workspace.db);

  store.record('/work/zeta', evaluation({ rules: 1, verifications: 1, violations: 0, elapsedMs: 1 }));
  store.record('/work/alpha', evaluation({ rules: 2, verifications: 4, violations: 3, elapsedMs: 2 }));
  store.record('/work/middle', evaluation({ rules: 1, verifications: 2, violations: 1, elapsedMs: 4 }));

  const snapshot = store.read();

  assert.deepEqual(
    snapshot.projects.map(project => project.project),
    ['/work/alpha', '/work/middle', '/work/zeta'],
  );
  assert.deepEqual(snapshot.total, { runs: 3, rules: 4, verifications: 7, violations: 4, elapsedMs: 7 });
});

test('a completed run without matches or enabled rules still counts a run', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  const store = createSqliteStatistics(workspace.db);

  store.record('/work/quiet', { rules: 0, verifications: 0, violations: 0, elapsedMs: 3 });

  assert.deepEqual(store.read(), {
    total: { runs: 1, rules: 0, verifications: 0, violations: 0, elapsedMs: 3 },
    projects: [{ project: '/work/quiet', runs: 1, rules: 0, verifications: 0, violations: 0, elapsedMs: 3 }],
  });
});

test('concurrent recorders accumulate without lost updates', async t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  const script = join(workspace.dir, 'record.mts');
  writeFileSync(script, recorderScript(false));
  const workers = 4;
  const perWorker = 25;

  await Promise.all(
    Array.from({ length: workers }, () => runRecorder(script, workspace.db, '/work/shared', perWorker)),
  );

  const snapshot = createSqliteStatistics(workspace.db).read();
  const expected = {
    project: '/work/shared',
    runs: workers * perWorker,
    rules: workers * perWorker,
    verifications: workers * perWorker * 2,
    violations: workers * perWorker,
    elapsedMs: workers * perWorker * 2,
  };
  assert.deepEqual(snapshot.projects, [expected]);
  const { project: _project, ...totals } = expected;
  assert.deepEqual(snapshot.total, totals);
});

test('total and project rows stay coherent for every record committed by another process', async t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  const script = join(workspace.dir, 'record.mts');
  writeFileSync(script, recorderScript(true));
  const store = createSqliteStatistics(workspace.db);
  store.record('/work/live', evaluation());

  const records = 25;
  const writer = startRecorder(script, workspace.db, '/work/live', records);
  t.after(writer.stop);
  await writer.ready;

  await writer.nextTick();
  for (let index = 1; index < records; index += 1) {
    writer.release();
    const snapshot = store.read();
    assert.deepEqual(snapshot.total, sumProjects(snapshot));
    assert.ok(snapshot.total.runs >= index + 1 && snapshot.total.runs <= index + 2);
    await writer.nextTick();
    assert.equal(store.read().total.runs, index + 2);
  }
  writer.release();
  writer.finish();
  await writer.done;

  const final = store.read();
  assert.deepEqual(sumProjects(final), final.total);
  assert.deepEqual(final.projects, [
    { project: '/work/live', runs: 26, rules: 26, verifications: 51, violations: 25, elapsedMs: 51 },
  ]);
});

test('reset clears every aggregate and keeps the database and neighbours', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  const store = createSqliteStatistics(workspace.db);
  store.record('/work/alpha', evaluation({ rules: 4, verifications: 4, violations: 4, elapsedMs: 40 }));
  store.record('/work/beta', evaluation({ rules: 2, verifications: 2, violations: 1, elapsedMs: 20 }));
  const neighbour = join(workspace.dir, 'rules.yaml');
  writeFileSync(neighbour, 'rules: []\n');

  store.reset();

  assert.deepEqual(store.read(), EMPTY);
  assert.equal(existsSync(workspace.db), true);
  assert.equal(existsSync(neighbour), true);
  const db = new Database(workspace.db, { readonly: true });
  try {
    const counted = db.prepare('SELECT COUNT(*) AS total FROM statistics').get() as { total: number };
    assert.equal(counted.total, 0);
  } finally {
    db.close();
  }
});

test('reset on a missing database is a no-op', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);

  createSqliteStatistics(workspace.db).reset();

  assert.equal(existsSync(workspace.db), false);
});

test('a file that is not a database surfaces the sqlite error', t => {
  const workspace = createWorkspace();
  t.after(workspace.cleanup);
  writeFileSync(workspace.db, 'this file is not a sqlite database');

  assert.throws(() => createSqliteStatistics(workspace.db).read());
});
