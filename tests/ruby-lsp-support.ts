import { execFileSync } from 'node:child_process';
import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sandbox } from './support.js';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/ruby-lsp/', import.meta.url));
const GEM_PATH = execFileSync('ruby', [
  '-rrubygems',
  '-e',
  'print Gem.path.join(File::PATH_SEPARATOR)',
], { encoding: 'utf8', env: process.env });

export async function createRubyLspFixture(target: Sandbox): Promise<Sandbox> {
  const projectFixture = join(FIXTURE_ROOT, 'project');
  for (const entry of await readdir(projectFixture)) {
    await cp(join(projectFixture, entry), join(target.cwd, entry), { recursive: true });
  }
  await cp(join(FIXTURE_ROOT, 'project-dependency'), join(target.root, 'project-dependency'), { recursive: true });

  const rubyOpt = target.env.RUBYOPT === undefined
    ? '-rbundler/setup'
    : `${target.env.RUBYOPT} -rbundler/setup`;
  return {
    ...target,
    env: {
      ...target.env,
      BUNDLE_GEMFILE: join(target.cwd, 'Gemfile'),
      BUNDLE_IGNORE_CONFIG: '1',
      BUNDLE_FROZEN: 'true',
      RUBYOPT: rubyOpt,
      GEM_PATH,
    },
  };
}
