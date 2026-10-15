import type { Context, FileInput, RuleInput } from '../rule/types.ts';
import type { Diagnostics } from './diagnostics.ts';
import type { LoadedRule } from './rules.ts';

export interface TreeSourceJob {
  readonly kind: 'tree';
  readonly logical: string;
  readonly rules: readonly number[];
  read(): Promise<FileInput>;
}

export interface DiffSourceJob {
  readonly kind: 'diff';
  readonly logical: string;
  readonly previous: string;
  readonly rules: readonly number[];
  read(): Promise<RuleInput>;
}

export type SourceJob = TreeSourceJob | DiffSourceJob;

export interface TreeSourceRequest {
  readonly target: string;
  readonly rulePaths: ReadonlySet<string>;
  readonly select: (logical: string) => readonly number[];
}

export interface DiffSourceRequest extends TreeSourceRequest {
  readonly base?: string | undefined;
}

export interface SourceRepository {
  identities(
    paths: readonly string[],
    concurrency: number,
    diagnostics?: Diagnostics,
  ): Promise<readonly string[]>;
  treeJobs(request: TreeSourceRequest, diagnostics?: Diagnostics): Promise<readonly TreeSourceJob[]>;
  diffJobs(request: DiffSourceRequest, diagnostics?: Diagnostics): Promise<readonly DiffSourceJob[]>;
}

export interface SourceProgress {
  readonly start: (total: number) => void;
  readonly complete: () => void;
}

export interface CollectOptions {
  readonly diffOnly: boolean;
  readonly base?: string | undefined;
}

export interface ContextCollector {
  identities(
    loaded: readonly LoadedRule[],
    concurrency: number,
    diagnostics?: Diagnostics,
  ): Promise<Set<string>>;
  collect(
    target: string,
    options: CollectOptions,
    loaded: readonly LoadedRule[],
    grouped: readonly boolean[],
    rulePaths: ReadonlySet<string>,
    concurrency: number,
    progress?: SourceProgress,
    diagnostics?: Diagnostics,
  ): Promise<Context[][]>;
}
