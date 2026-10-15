import type { LoadedRule, RuleLoader } from './ports/rules.ts';

export type Validate = (ruleFile?: string) => Promise<LoadedRule[]>;

export function createValidate(loadRules: RuleLoader): Validate {
  return function validate(ruleFile?: string): Promise<LoadedRule[]> {
    return loadRules(ruleFile);
  };
}
