import { loadRules } from '../src/rule-loader.ts';

export async function validateCommand(ruleFile: string | undefined): Promise<void> {
  const loaded = await loadRules(ruleFile);
  process.stdout.write(loaded.map(({ rule }) => `Valid rule: ${rule.name} (v${rule.version})\n`).join(''));
}
