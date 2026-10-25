import type { SkillOptions } from '../../skills/cli.js';
import { CliExit, EXIT_OK } from '../exit.js';
import type { SkillServices } from '../services.js';

async function runSkill(
  operation: 'install' | 'update',
  options: SkillOptions,
  services: SkillServices,
): Promise<void> {
  const status = await services.manageSkill(operation, options);
  if (status !== EXIT_OK) throw new CliExit(status);
}

export { runSkill };
