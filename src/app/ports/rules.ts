import type { CompiledRule } from '../rule/types.ts';
import type { Diagnostics } from './diagnostics.ts';

export interface LoadedRule {
  readonly filepath: string;
  readonly rule: CompiledRule;
}

export type RuleLoader = (
  rulePath?: string,
  concurrency?: number,
  diagnostics?: Diagnostics,
) => Promise<LoadedRule[]>;

export interface RuleDiscovery {
  readonly files: readonly string[];
  readonly missingRulesError?: Error;
}

export interface RuleFiles {
  find(rulePath?: string): Promise<RuleDiscovery>;
  read(filepath: string): Promise<string>;
}

export interface RuleSource {
  readonly filepath: string;
  readonly source: string;
}

export interface RuleSelector {
  select(selector: string): Promise<RuleSource>;
}
