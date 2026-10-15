import type { RuleExamples } from '../rule/types.ts';
import type { JsonValue } from '../scope/types.ts';

export interface DecisionInstructions {
  readonly rule: string;
  readonly examples: RuleExamples;
  readonly question: string;
}

export type DecisionCaptures = Readonly<Record<string, string | readonly string[]>>;

export type DecisionScope =
  | { readonly id: string; readonly data: JsonValue; readonly captures?: DecisionCaptures }
  | { readonly id: string; readonly source: string; readonly captures?: DecisionCaptures };

export interface DecisionScopeState {
  readonly filepath: string;
  readonly diff?: string;
  readonly scope: DecisionScope;
}

export interface DecisionGroup {
  readonly type: 'file' | 'folder' | 'project';
  readonly path: string;
}

export interface DecisionGroupFile {
  readonly filepath: string;
  readonly scopes: readonly DecisionScope[];
}

export interface DecisionGroupState {
  readonly group: DecisionGroup;
  readonly files: readonly DecisionGroupFile[];
}

export type DecisionState = DecisionScopeState | DecisionGroupState;

export interface DecisionRequest {
  readonly context: DecisionState;
  readonly instructions: DecisionInstructions;
}

export interface BackendDecision {
  readonly probability: number;
  readonly model: string;
}

export interface DecisionBackend {
  decide(request: DecisionRequest): Promise<BackendDecision>;
}
