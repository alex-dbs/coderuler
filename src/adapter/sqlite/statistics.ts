import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Sqlite from 'better-sqlite3';
import type { Database as SqliteConnection } from 'better-sqlite3';

import type {
  ProjectStatistics,
  StatisticsSnapshot,
  StatisticsStore,
  StatisticsTotals,
} from '../../app/ports/statistics.ts';

const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS statistics (
  project TEXT PRIMARY KEY,
  runs INTEGER NOT NULL DEFAULT 0,
  rules INTEGER NOT NULL DEFAULT 0,
  verifications INTEGER NOT NULL DEFAULT 0,
  violations INTEGER NOT NULL DEFAULT 0,
  elapsed_ms REAL NOT NULL DEFAULT 0
)`;

const RECORD = `
INSERT INTO statistics (project, runs, rules, verifications, violations, elapsed_ms)
VALUES (?, 1, ?, ?, ?, ?)
ON CONFLICT (project) DO UPDATE SET
  runs = runs + 1,
  rules = rules + excluded.rules,
  verifications = verifications + excluded.verifications,
  violations = violations + excluded.violations,
  elapsed_ms = elapsed_ms + excluded.elapsed_ms`;

const TOTALS = `
SELECT
  COALESCE(SUM(runs), 0) AS runs,
  COALESCE(SUM(rules), 0) AS rules,
  COALESCE(SUM(verifications), 0) AS verifications,
  COALESCE(SUM(violations), 0) AS violations,
  COALESCE(SUM(elapsed_ms), 0) AS elapsedMs
FROM statistics`;

const PROJECTS = `
SELECT project, runs, rules, verifications, violations, elapsed_ms
FROM statistics
ORDER BY project`;

const TABLE_EXISTS = `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`;

const CLEAR = 'DELETE FROM statistics';

interface StatisticsRow {
  readonly project: string;
  readonly runs: number;
  readonly rules: number;
  readonly verifications: number;
  readonly violations: number;
  readonly elapsed_ms: number;
}

function open(filename: string, readonlyMode: boolean): SqliteConnection {
  return new Sqlite(filename, { readonly: readonlyMode, timeout: BUSY_TIMEOUT_MS });
}

function zeroTotals(): StatisticsTotals {
  return { runs: 0, rules: 0, verifications: 0, violations: 0, elapsedMs: 0 };
}

function emptySnapshot(): StatisticsSnapshot {
  return { total: zeroTotals(), projects: [] };
}

function hasTable(db: SqliteConnection): boolean {
  return db.prepare<[string], { present: number }>(TABLE_EXISTS).get('statistics') !== undefined;
}

function toProject(row: StatisticsRow): ProjectStatistics {
  return {
    project: row.project,
    runs: row.runs,
    rules: row.rules,
    verifications: row.verifications,
    violations: row.violations,
    elapsedMs: row.elapsed_ms,
  };
}

export function createSqliteStatistics(filename: string): StatisticsStore {
  return {
    record(project, evaluation) {
      mkdirSync(dirname(filename), { recursive: true });
      const db = open(filename, false);
      try {
        db.exec(SCHEMA);
        db.prepare<[string, number, number, number, number]>(RECORD).run(
          project,
          evaluation.rules,
          evaluation.verifications,
          evaluation.violations,
          evaluation.elapsedMs,
        );
      } finally {
        db.close();
      }
    },
    read() {
      if (!existsSync(filename)) return emptySnapshot();
      const db = open(filename, true);
      try {
        if (!hasTable(db)) return emptySnapshot();
        return db.transaction((): StatisticsSnapshot => {
          const projects = db.prepare<[], StatisticsRow>(PROJECTS).all().map(toProject);
          const totals = db.prepare<[], StatisticsTotals>(TOTALS).get() ?? zeroTotals();
          return { total: totals, projects };
        })();
      } finally {
        db.close();
      }
    },
    reset() {
      if (!existsSync(filename)) return;
      const db = open(filename, false);
      try {
        if (!hasTable(db)) return;
        const removed = db.transaction(() => db.prepare<[]>(CLEAR).run())();
        if (removed.changes > 0) db.exec('VACUUM');
      } finally {
        db.close();
      }
    },
  };
}
