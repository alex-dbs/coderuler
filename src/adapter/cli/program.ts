import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';

import type { SkillOptions } from '../skills/cli.js';
import { CliExit, EXIT_FAILURE, EXIT_OK } from './exit.js';
import type {
  CheckOptions,
  CliServices,
  DependencyOptions,
  InspectOptions,
  TestOptions,
} from './services.js';
import { escapeDiagnostic } from './text.js';

const SUCCESSFUL_COMMANDER_CODES: Record<string, true> = {
  'commander.help': true,
  'commander.helpDisplayed': true,
  'commander.version': true,
};
const CONCURRENCY_HINT = 'must be a positive safe integer';
const THRESHOLD_HINT = 'must be a decimal number between 0 and 1';
const THRESHOLD_PATTERN = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;
const TIMEOUT_HINT = 'must be a positive duration in ms, s, or m, at most 2147483647ms';
const TIMEOUT_UNITS = { ms: 1, s: 1_000, m: 60_000 } as const;

function parseConcurrency(value: string): number {
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(CONCURRENCY_HINT);
  }
  return parsed;
}

function parseThreshold(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!THRESHOLD_PATTERN.test(trimmed) || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError(THRESHOLD_HINT);
  }
  return parsed;
}

function parseTokenPrice(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!THRESHOLD_PATTERN.test(trimmed) || !Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError('must be a finite nonnegative decimal number (USD per million tokens)');
  }
  return parsed;
}

function parseTimeout(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)(ms|s|m)$/.exec(value.trim());
  const durationMs = match === null
    ? NaN
    : Number(match[1]) * TIMEOUT_UNITS[match[2] as keyof typeof TIMEOUT_UNITS];
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 2_147_483_647) {
    throw new InvalidArgumentError(TIMEOUT_HINT);
  }
  return durationMs;
}

export function createProgram(services: CliServices): Command {
  const program = new Command();
  program
    .name('coderuler')
    .description('Evaluate trusted TypeScript rules against the current working tree')
    .configureOutput({
      writeOut: text => services.write(text),
      writeErr: text => services.writeError(`coderuler: ${services.redact(escapeDiagnostic(text))}`),
    })
    .version(services.version)
    .exitOverride();

  program
    .command('update')
    .description('Upgrade the active global npm installation of CodeRuler to the latest version')
    .action(async () => {
      const { runUpdate } = await import('./commands/update.js');
      const commandServices = await services.load.update(services);
      await runUpdate(commandServices);
    });

  const skill = program
    .command('skill')
    .description('Install or refresh the bundled coderuler-new-rule Agent Skill');
  skill
    .command('install')
    .description('Install the bundled skill; defaults to the shared universal skills directory')
    .option('-g, --global', 'install globally instead of prompting for scope')
    .option('-a, --agent <agents...>', 'target agents (use "*" for all agents)')
    .option('-y, --yes', 'skip prompts (project scope unless --global)')
    .option('--copy', 'copy files instead of symlinking agent directories')
    .action(async (options: SkillOptions) => {
      const { runSkill } = await import('./commands/skill.js');
      const commandServices = await services.load.skill(services);
      await runSkill('install', options, commandServices);
    });

  skill
    .command('update')
    .description('Refresh an existing bundled-skill installation; defaults to the universal target')
    .addOption(new Option('-g, --global', 'refresh a global installation').conflicts('project'))
    .addOption(new Option('-p, --project', 'refresh a project installation (default)').conflicts('global'))
    .option('-a, --agent <agents...>', 'target agents (use "*" for all agents)')
    .option('--copy', 'copy files instead of symlinking agent directories')
    .addHelpText('after', '\nUpgrade CodeRuler first to obtain newer skill content. Local sources are refreshed with skills add, not skills update.')
    .action(async (options: SkillOptions) => {
      const { runSkill } = await import('./commands/skill.js');
      const commandServices = await services.load.skill(services);
      await runSkill('update', options, commandServices);
    });

  const dependencies = program
    .command('deps')
    .description('Manage the public npm packages declared by trusted rules');
  const dependencyOptions = (command: Command): Command => command
    .addOption(new Option('--global', 'manage home rules instead of project rules').conflicts('directory'))
    .addOption(new Option('--directory <path>', 'manage a rule directory relative to the working directory').conflicts('global'));
  for (const operation of ['add', 'remove'] as const) {
    dependencyOptions(dependencies.command(operation))
      .description(operation === 'add' ? 'Add or update packages and save exact locked versions' : 'Remove declared direct packages')
      .argument(operation === 'add' ? '<packages...>' : '<names...>', 'public npm packages')
      .action(async (packages: string[], options: DependencyOptions) => {
        const { runDeps } = await import('./commands/deps.js');
        const commandServices = await services.load.deps(services);
        await runDeps(operation, packages, options, commandServices);
      });
    }
  dependencyOptions(dependencies.command('sync'))
    .description('Acquire locked packages and refresh SDK and dependency editor links')
    .action(async (options: DependencyOptions) => {
      const { runDeps } = await import('./commands/deps.js');
      const commandServices = await services.load.deps(services);
      await runDeps('sync', [], options, commandServices);
    });

  program
    .command('validate')
    .description('Load and structurally validate the selected rules without running them')
    .argument('[rule]', 'rule name, module path, or directory')
    .action(async (rulePath: string | undefined) => {
      const { runValidate } = await import('./commands/validate.js');
      const commandServices = await services.load.validate(services);
      await runValidate(rulePath, services, commandServices);
    });

  program
    .command('test')
    .description('Run the declared test cases for the selected rules')
    .argument('[rule]', 'rule name, module path, or directory')
    .option('--ai', 'include aiTests that use the configured decision backend')
    .option('--ai-scores', 'show AI scores for aiTests')
    .option('--failures-only', 'show only failed test cases')
    .addOption(
      new Option('--timeout <duration>', 'per-test timeout (ms, s, or m)')
        .argParser(parseTimeout)
        .default(10_000, '10s'),
    )
    .option(
      '--concurrency <number>',
      `bounded in-flight test cases (${CONCURRENCY_HINT})`,
      parseConcurrency,
      1,
    )
    .action(async (rulePath: string | undefined, options: TestOptions) => {
      const { runTest } = await import('./commands/test.js');
      const commandServices = await services.load.test(services);
      await runTest(rulePath, options, services, commandServices);
    });

  program
    .command('check')
    .description('Evaluate every selected rule against the working tree')
    .argument('[path]', 'target file or folder that narrows selection', '.')
    .option('--rules <rule>', 'rule name, module path, directory, or Git repository URL[#revision]')
    .option('--tags <tags...>', 'run rules matching any listed tag', [])
    .option('--exclude-tags <tags...>', 'exclude rules matching any listed tag', [])
    .option('--json', 'print violations as {durationMs, reports} JSON on stdout')
    .option('--jsonl', 'print violation rule records as JSON Lines')
    .option('--output-all', 'include passing and skipped rules and every verification in the output')
    .option('--debug', 'stream framework metadata and force concurrency 1')
    .option('--verbose', 'stream the redacted walkthrough at the configured concurrency')
    .option('--diff, --diff-only', 'evaluate changed files and affected groups against a Git base')
    .option('--pr <number-or-url>', 'check a GitHub PR in a temporary checkout (implies --diff-only)')
    .option('--auto-comment', 'post GitHub inline violation comments, with a summary fallback (requires --diff or --pr)')
    .option('--base <ref>', 'Git base for --diff-only (default: HEAD), or base branch for --pr')
    .option(
      '--concurrency <number>',
      `bounded in-flight selection and evaluation tasks (${CONCURRENCY_HINT})`,
      parseConcurrency,
      8,
    )
    .option('--threshold <number>', `decision threshold override (${THRESHOLD_HINT})`, parseThreshold)
    .action(async (target: string, options: CheckOptions) => {
      if (options.json === true && options.jsonl === true) {
        throw new Error('--json and --jsonl are mutually exclusive');
      }
      const diffOnly = options.diffOnly === true || options.pr !== undefined;
      if (options.base !== undefined && !diffOnly) {
        throw new Error('--base requires --diff-only or --pr');
      }
      if (options.autoComment === true && !diffOnly) {
        throw new Error('--auto-comment requires --diff (or --diff-only) or --pr');
      }
      const { runCheck } = await import('./commands/check.js');
      const commandServices = await services.load.check(services);
      await runCheck(target, options, services, commandServices);
    });

  program
    .command('inspect')
    .description('Walk one rule through selection, filtering, grouping and evaluation')
    .argument('<rule>', 'rule module path or exact rule name')
    .argument('[folder]', 'folder to inspect', '.')
    .option('--json', 'print the complete redacted inspection as one JSON document')
    .option('--jsonl', 'stream redacted inspection events and reports as JSON Lines')
    .option('--raw', 'print the complete redacted inspection as undecorated text')
    .option('--input-cost-per-million <number>', 'input token price override (USD per million tokens)', parseTokenPrice)
    .option('--output-cost-per-million <number>', 'output token price override (USD per million tokens)', parseTokenPrice)
    .action(async (rule: string, folder: string, options: InspectOptions) => {
      const formats = [
        ...(options.json === true ? ['--json'] : []),
        ...(options.jsonl === true ? ['--jsonl'] : []),
        ...(options.raw === true ? ['--raw'] : []),
      ];
      if (formats.length > 1) {
        throw new Error(`${formats.join(', ')} are mutually exclusive`);
      }
      const { runInspect } = await import('./commands/inspect.js');
      const commandServices = await services.load.inspect(services);
      await runInspect(rule, folder, options, services, commandServices);
    });

  return program;
}

export async function runProgram(argv: readonly string[], services: CliServices): Promise<number> {
  try {
    await createProgram(services).parseAsync(argv, { from: 'user' });
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliExit) return error.exitCode;
    if (error instanceof CommanderError) {
      return error.exitCode === EXIT_OK && SUCCESSFUL_COMMANDER_CODES[error.code] === true
        ? EXIT_OK
        : EXIT_FAILURE;
    }
    const message = error instanceof Error ? error.message : String(error);
    services.writeError(`coderuler: ${services.redact(escapeDiagnostic(message))}\n`);
    return EXIT_FAILURE;
  }
}
