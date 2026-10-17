import type {
  CheckResult,
  GroupSubject,
  JsonValue,
  Rule,
  RuleSettings,
  ScopeSubject,
  Subject,
} from './rule.js';

export interface Project {
  readonly root: string;
  glob(patterns: string | readonly string[]): Promise<readonly string[]>;
  hasFiles(patterns: string | readonly string[]): Promise<boolean>;
  stat(path: string): Promise<{ readonly kind: 'file' | 'directory' } | undefined>;
  readText(path: string): Promise<string>;
  readJson(path: string): Promise<JsonValue>;
  readYaml(path: string): Promise<readonly JsonValue[]>;
  readCsv(path: string, options?: CsvOptions): Promise<readonly CsvRow[]>;
}

export interface CsvOptions {
  readonly headers?: boolean;
  readonly delimiter?: string;
  readonly key?: string;
}

export type CsvRow = Readonly<Record<string, string>> | readonly string[];

export interface RuleSelection {
  readonly root: string;
  readonly explicit?: string;
  readonly name?: string;
  readonly invocationCwd: string;
}

export interface LoadedRule {
  readonly name: string;
  readonly ruleFile: string;
  readonly rule: Rule<unknown>;
}

export interface RuleLoader {
  load(selection: RuleSelection): Promise<readonly LoadedRule[]>;
}

export interface DecisionInstructions {
  readonly rule: string;
  readonly question: string;
  readonly examples?: { readonly good: readonly string[]; readonly bad: readonly string[] };
}

export interface DecisionRequest {
  readonly state: JsonValue;
  readonly instructions: DecisionInstructions;
}

export interface DecisionOutcome {
  readonly probability: number;
  readonly model: string;
}

export type DecisionExchange =
  | { readonly type: 'request'; readonly body: string }
  | { readonly type: 'response'; readonly status: number; readonly body: string };

export type DecisionObserver = (exchange: DecisionExchange) => void;

export interface DecisionBackend {
  decide(request: DecisionRequest, observer?: DecisionObserver): Promise<DecisionOutcome>;
}

export interface DecisionRuntime {
  readonly backend: DecisionBackend;
  readonly threshold: number;
}

export interface RunContext {
  readonly project: Project;
  readonly isTarget: (filepath: string) => boolean;
  readonly concurrency: number;
  readonly resolveDecision: (settings: RuleSettings) => DecisionRuntime;
  readonly emit?: (event: RunEvent) => void;
}

export interface RuleEvaluation {
  readonly subject: Subject;
  readonly result: CheckResult;
}

export interface RuleReport {
  readonly name: string;
  readonly ruleFile: string;
  readonly status: 'pass' | 'violation' | 'skipped';
  readonly reason?: string;
  readonly evaluations: readonly RuleEvaluation[];
}

export type RunEvent =
  | { readonly type: 'rule'; readonly name: string; readonly ruleFile: string }
  | {
      readonly type: 'gate';
      readonly name: string;
      readonly enabled: boolean;
      readonly applies: boolean;
      readonly reason?: string;
    }
  | {
      readonly type: 'file';
      readonly name: string;
      readonly filepath: string;
      readonly selected: boolean;
      readonly reason?: string;
    }
  | {
      readonly type: 'scope';
      readonly name: string;
      readonly subject: ScopeSubject;
      readonly accepted: boolean;
      readonly reason?: string;
    }
  | { readonly type: 'group'; readonly name: string; readonly subject: GroupSubject }
  | { readonly type: 'request'; readonly name: string; readonly subject: Subject; readonly body: string }
  | {
      readonly type: 'response';
      readonly name: string;
      readonly subject: Subject;
      readonly status: number;
      readonly body: string;
    }
  | { readonly type: 'result'; readonly name: string; readonly subject: Subject; readonly result: CheckResult }
  | { readonly type: 'trace'; readonly name: string; readonly message: string; readonly details?: JsonValue }
  | { readonly type: 'error'; readonly name?: string; readonly stage: string; readonly message: string };
