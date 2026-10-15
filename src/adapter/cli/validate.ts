import type { Validate } from '../../app/validate.ts';

export async function validateCommand(validate: Validate, ruleFile: string | undefined): Promise<void> {
  const loaded = await validate(ruleFile);
  process.stdout.write(loaded.map(({ rule }) => `Valid rule: ${rule.name} (v${rule.version})\n`).join(''));
}
