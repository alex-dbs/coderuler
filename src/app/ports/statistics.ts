export interface StatisticsTotals {
  readonly runs: number;
  readonly rules: number;
  readonly verifications: number;
  readonly violations: number;
  readonly elapsedMs: number;
}

export interface ProjectStatistics extends StatisticsTotals {
  readonly project: string;
}

export interface StatisticsSnapshot {
  readonly total: StatisticsTotals;
  readonly projects: readonly ProjectStatistics[];
}

export interface EvaluationStatistics {
  readonly rules: number;
  readonly verifications: number;
  readonly violations: number;
  readonly elapsedMs: number;
}

export interface StatisticsStore {
  record(project: string, evaluation: EvaluationStatistics): void;
  read(): StatisticsSnapshot;
  reset(): void;
}
