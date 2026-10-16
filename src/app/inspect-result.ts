import type { DecisionContext } from './decision/group.ts';
import type { DecisionExchange } from './decision/port.ts';
import type { RegexTarget } from './decision/regex.ts';
import type { Decision } from './decision/service.ts';
import type { Context, DecisionGrouping } from './rule/types.ts';

export interface InspectionFile {
  readonly filepath: string;
  readonly selected: readonly Context[];
  readonly accepted: readonly Context[];
  readonly filtered: readonly Context[];
}

export interface InspectionSummary {
  readonly eligibleFiles: number;
  readonly matchedFiles: number;
  readonly selectedScopes: number;
  readonly filteredScopes: number;
  readonly verifications: number;
  readonly passed: number;
  readonly violations: number;
}

export type InspectionEvent =
  | {
      readonly type: 'rule';
      readonly cwd: string;
      readonly ruleFile: string;
      readonly name: string;
      readonly kind: 'AI' | 'regex';
      readonly enabled: boolean;
      readonly violationMessage?: string;
      readonly rule: string;
      readonly grouping: DecisionGrouping;
    }
  | { readonly type: 'selection'; readonly files: readonly InspectionFile[] }
  | { readonly type: 'verification'; readonly index: number; readonly total: number; readonly context: DecisionContext }
  | {
      readonly type: 'regex';
      readonly index: number;
      readonly pattern: string;
      readonly inputs: readonly RegexTarget[];
      readonly matched: boolean;
    }
  | { readonly type: 'exchange'; readonly index: number; readonly exchange: DecisionExchange }
  | { readonly type: 'decision'; readonly index: number; readonly decision: Decision }
  | { readonly type: 'failure'; readonly index: number; readonly message: string }
  | { readonly type: 'complete'; readonly summary: InspectionSummary };

export type InspectionObserver = (event: InspectionEvent) => void;
