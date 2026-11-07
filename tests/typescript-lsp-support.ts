import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sandbox } from './support.js';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/typescript-lsp/', import.meta.url));

export async function createTypescriptLspFixture(target: Sandbox): Promise<Sandbox> {
  const projectFixture = join(FIXTURE_ROOT, 'project');
  for (const entry of await readdir(projectFixture)) {
    await cp(join(projectFixture, entry), join(target.cwd, entry), { recursive: true });
  }
  await cp(join(FIXTURE_ROOT, 'project-dependency'), join(target.root, 'project-dependency'), { recursive: true });
  return target;
}
