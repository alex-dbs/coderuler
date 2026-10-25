import { CliExit, EXIT_OK } from '../exit.js';
import type { UpdateServices } from '../services.js';

async function runUpdate(services: UpdateServices): Promise<void> {
  const status = await services.updateTool();
  if (status !== EXIT_OK) throw new CliExit(status);
}

export { runUpdate };
