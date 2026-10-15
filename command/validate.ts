import { loadRules } from '../src/rule-loader.ts';

/**
 * Compile one explicit rule YAML file, or every discovered rule, and report each identity on
 * stdout. Every rule is loaded and compiled before anything is written, so a missing file or a
 * malformed rule anywhere fails without a partial success line; the error propagates to the process
 * error boundary.
 */
export async function validateCommand(ruleFile: string | undefined): Promise<void> {
  const loaded = await loadRules(ruleFile);
  process.stdout.write(loaded.map(({ rule }) => `Valid rule: ${rule.name} (v${rule.version})\n`).join(''));
}
