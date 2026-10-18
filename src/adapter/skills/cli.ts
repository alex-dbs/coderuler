import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants, homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'rulekeeper-new-rule';
export const SKILL_SOURCE = fileURLToPath(new URL(`../../../skills/${SKILL_NAME}`, import.meta.url));

export interface SkillOptions {
  readonly global?: boolean;
  readonly project?: boolean;
  readonly agent?: readonly string[];
  readonly yes?: boolean;
  readonly copy?: boolean;
}

interface SkillsResult {
  readonly status: number;
  readonly stdout: string;
}

function skillsExecutable(): string {
  const manifestPath = createRequire(import.meta.url).resolve('skills/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly bin: { readonly skills: string };
  };
  return resolve(dirname(manifestPath), manifest.bin.skills);
}

function runSkills(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  capture: boolean,
): Promise<SkillsResult> {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<SkillsResult>();
  const child = spawn(process.execPath, [executable, ...args], {
    cwd,
    env,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });
  let stdout = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.once('error', reject);
  child.once('close', (code, signal) => {
    resolveResult({ status: code ?? 128 + (signal === null ? 0 : constants.signals[signal]), stdout });
  });
  return promise;
}

export function createSkillManager(
  cwd: string,
  env: NodeJS.ProcessEnv,
  executable?: string,
): (operation: 'install' | 'update', options: SkillOptions) => Promise<number> {
  return async (operation, options) => {
    const cli = executable ?? skillsExecutable();
    const scope = options.global === true ? ['--global'] : [];
    // Never let environment detection choose a different destination during a refresh.
    const targets = options.agent ?? ['universal'];
    const agents = ['--agent', ...targets];
    if (operation === 'update') {
      const allAgents = targets.includes('*');
      const filter = allAgents ? [] : agents;
      const listed = await runSkills(cli, ['list', '--json', ...scope, ...filter], cwd, env, true);
      if (listed.status !== 0) return listed.status;
      const installed = JSON.parse(listed.stdout) as readonly {
        readonly name: string;
        readonly scope: 'project' | 'global';
        readonly agents: readonly string[];
        readonly path: string;
      }[];
      const selectedScope = options.global === true ? 'global' : 'project';
      const matching = installed.filter(skill => skill.name === SKILL_NAME && skill.scope === selectedScope);
      if (matching.length === 0) {
        throw new Error(`${SKILL_NAME} is not installed in this scope; run rulekeeper skill install first`);
      }
      // List filters also scan other agents. Universal has no agent label in JSON,
      // so verify its canonical path; ordinary targets must match display labels.
      // An explicit '*' deliberately opts into installing for every upstream agent.
      const home = env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] ?? homedir();
      const universalPath = targets.includes('universal')
        ? resolve(options.global === true ? home : cwd, '.agents', 'skills', SKILL_NAME)
        : undefined;
      if (!allAgents) {
        for (const target of targets) {
          const normalized = target.toLowerCase().replace(/[^a-z0-9]/g, '');
          const verified = target === 'universal'
            ? matching.some(skill => skill.path === universalPath)
            : normalized !== '' && matching.some(skill => Array.isArray(skill.agents)
              && skill.agents.some((agent: unknown) =>
                typeof agent === 'string' && agent.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized,
              ));
          if (!verified) {
            throw new Error(
              `${SKILL_NAME} is not installed for agent "${target}" in this scope, or its installation cannot be verified; `
              + 'use a supported installed --agent target or universal, or run rulekeeper skill install first',
            );
          }
        }
      }
    }
    const args = ['add', SKILL_SOURCE, '--skill', SKILL_NAME, ...scope, ...agents];
    if (operation === 'update' || options.yes === true) args.push('--yes');
    if (options.copy === true) args.push('--copy');
    return (await runSkills(cli, args, cwd, env, false)).status;
  };
}
