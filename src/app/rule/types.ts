import type { FilterDefinition } from '../filter.ts';
import type { PluginRegistry } from '../scope/registry.ts';
import type { ScopeMatch, WarnUnknownField } from '../scope/types.ts';

export interface FileSelection {
  readonly included: readonly string[];
  readonly excluded?: readonly string[];
}

export interface ScopeDefinition {
  readonly format: string;
  readonly changed?: boolean;
  readonly [option: string]: unknown;
}

export interface RuleExamples {
  readonly good: readonly string[];
  readonly bad: readonly string[];
}

export type DecisionGrouping =
  | { readonly group_by: 'scope' }
  | { readonly group_by: 'file' }
  | { readonly group_by: 'project' }
  | { readonly group_by: 'folder'; readonly level?: number };

export interface RuleDefinition {
  readonly version: 'v1';
  readonly name: string;
  readonly files: FileSelection;
  readonly scope: ScopeDefinition;
  readonly rule: string;
  readonly examples?: Readonly<Partial<RuleExamples>>;
  readonly filter?: FilterDefinition;
  readonly decision?: DecisionGrouping;
  readonly title?: string;
}

export interface RuleInput {
  readonly filepath: string;
  readonly diff: string;
  readonly head: string;
  readonly base?: string;
}

export interface FileInput {
  readonly filepath: string;
  readonly source: string;
}

export interface MatchOptions {
  readonly changedOnly?: boolean;
}

export interface Context {
  readonly filepath: string;
  readonly diff?: string;
  readonly scope: ScopeMatch;
}

export interface CompiledRule {
  readonly version: 'v1';
  readonly name: string;
  readonly rule: string;
  readonly examples: RuleExamples;
  readonly decision: DecisionGrouping;
  readonly title?: string;
  matchesFile(filepath: string): boolean;
  match(input: RuleInput | FileInput, options?: MatchOptions): Context[];
}

export interface RuleCompileDependencies {
  readonly registry: PluginRegistry;
  readonly warnUnknownField: WarnUnknownField;
}
