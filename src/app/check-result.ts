import type { GroupedContext } from './decision/group.ts';
import type { Context, RuleExamples } from './rule/types.ts';

export interface CheckedScopeDecision {
  readonly filepath: string;
  readonly scopeId: string;
  readonly follows: boolean;
  readonly probability: number;
  readonly model: string;
}

export interface CheckedGroupDecision {
  readonly group: GroupedContext['group'];
  readonly members: readonly { readonly filepath: string; readonly scopeId: string }[];
  readonly follows: boolean;
  readonly probability: number;
  readonly model: string;
}

export type CheckedDecision = CheckedScopeDecision | CheckedGroupDecision;

export interface CheckedRule {
  readonly ruleFile: string;
  readonly name: string;
  readonly rule: string;
  readonly examples: RuleExamples;
  readonly contexts: readonly Context[];
  readonly decisions: readonly CheckedDecision[];
  readonly violationMessage?: string;
}

export interface DecisionProgress {
  readonly matchingRules: number;
  readonly scopes: number;
  readonly total: number;
}

export interface CheckProgress {
  rulesLoaded(total: number): void;
  sources(total: number): void;
  sourceComplete(): void;
  decisions(info: DecisionProgress): void;
  decisionComplete(): void;
}
