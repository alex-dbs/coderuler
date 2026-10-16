import type {
  ProjectStatistics,
  StatisticsSnapshot,
  StatisticsStore,
  StatisticsTotals,
} from '../../app/ports/statistics.ts';

export interface StatsCommandOptions {
  readonly json?: boolean | undefined;
}

const HEADERS = ['Project', 'Runs', 'Rules', 'Verifications', 'Violations', 'Time'] as const;

const ALIGNMENTS = ['left', 'right', 'right', 'right', 'right', 'right'] as const;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function escapeControl(value: string): string {
  return value.replace(CONTROL, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function formatSeconds(elapsedMs: number): string {
  const trimmed = (elapsedMs / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${trimmed === '' ? '0' : trimmed}s`;
}

function cells(project: string, totals: StatisticsTotals): readonly string[] {
  return [
    project,
    String(totals.runs),
    String(totals.rules),
    String(totals.verifications),
    String(totals.violations),
    formatSeconds(totals.elapsedMs),
  ];
}

function line(values: readonly string[], widths: readonly number[]): string {
  return values
    .map((value, index) => (ALIGNMENTS[index] === 'left' ? value.padEnd(widths[index]!) : value.padStart(widths[index]!)))
    .join('  ')
    .trimEnd();
}

function renderTable(snapshot: StatisticsSnapshot): string {
  const rows: readonly (readonly string[])[] = [
    cells('GLOBAL', snapshot.total),
    ...snapshot.projects.map((project: ProjectStatistics) => cells(escapeControl(project.project), project)),
  ];
  const widths = HEADERS.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  return [line(HEADERS, widths), ...rows.map((row) => line(row, widths))].join('\n') + '\n';
}

export function statsCommand(store: StatisticsStore, options: StatsCommandOptions): void {
  const snapshot = store.read();
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    snapshot.projects.length === 0
      ? 'No evaluation statistics recorded yet.\n'
      : renderTable(snapshot),
  );
}

export function resetStatsCommand(store: StatisticsStore): void {
  store.reset();
  process.stdout.write('Cleared all recorded evaluation statistics.\n');
}
