import { Command } from 'commander';
import type { Check } from '../../app/check.ts';
import { DEFAULT_CONCURRENCY, parseConcurrency } from '../../app/concurrency.ts';
import { DEFAULT_THRESHOLD, parseThreshold } from '../../app/decision/threshold.ts';
import type { InspectCommand } from '../../app/inspect.ts';
import type { StatisticsStore } from '../../app/ports/statistics.ts';
import type { Validate } from '../../app/validate.ts';
import { checkCommand, type CheckCommandOptions } from './check.ts';
import { inspectCommand } from './inspect.ts';
import { resetStatsCommand, statsCommand } from './stats.ts';
import { validateCommand } from './validate.ts';

export interface Application {
  readonly check: Check;
  readonly validate: Validate;
  readonly inspect: InspectCommand;
  readonly statistics: StatisticsStore;
}

export function createProgram(application: Application): Command {
  const program = new Command();

  program
    .name('rulekeeper')
    .description('Compile rule YAML files and check source files against their scopes');

  program
    .command('validate')
    .description('compile one rule file, a folder of rules, or every discovered rule, and report each rule name')
    .argument('[rule-file]', 'rule YAML file or folder to read and compile; omit to compile the discovered rules')
    .action((ruleFile: string | undefined) => validateCommand(application.validate, ruleFile));

  program
    .command('check')
    .description('decide every selected scope against its rule and print a compact human summary; AI rules use the configured backend, regex rules are matched locally without one; pass --json for the full machine-readable report')
    .argument('[path]', 'source file or directory to check; defaults to the current directory', '.')
    .option('--rules <path>', 'rule YAML file or folder; defaults to the discovered rules')
    .option('--diff-only', 'check the committed change from a merge base instead of reading working-tree sources; a rule that groups its decisions still reads the current tree')
    .option('--base <ref>', 'ref to merge-base HEAD against with --diff-only; defaults to origin/HEAD, then origin/main, origin/master, main, master')
    .option('--json', 'print the checked rules, their examples, surviving scope candidates and decisions as a JSON array instead of the human summary')
    .option('--debug', 'run one unit of work at a time (forces concurrency 1) and log important troubleshooting stderr diagnostics whose failure metadata stays body-free')
    .option('--verbose', 'log the important diagnostics plus finer-grained detail to stderr, keeping the configured concurrency; adds the serialized outbound request body and every received response body, including HTTP error and malformed decision responses')
    .option(
      '--concurrency <number>',
      'maximum rules, sources, and decisions in flight at once; the limit is global, not per rule',
      parseConcurrency,
      DEFAULT_CONCURRENCY,
    )
    .option(
      '--threshold <number>',
      `minimum probability for an AI rule to pass (strictly greater, 0 to 1); a regex rule matches locally and ignores it; defaults to RK_THRESHOLD, then ${DEFAULT_THRESHOLD}`,
      value => parseThreshold(value),
    )
    .action((target: string, options: CheckCommandOptions) => checkCommand(application.check, target, options));

  program
    .command('inspect')
    .description(
      'walk through one rule: list the files and scopes it selects, then print the exact decision request and the raw response of every verification; a regex rule prints its pattern, inputs and local match instead',
    )
    .argument('<rule>', 'rule YAML filepath, or the exact name of one discovered rule')
    .argument('[folder]', 'working root for source globs, grouping, and named-rule discovery', '.')
    .action((rule: string, folder: string) => inspectCommand(application.inspect, rule, folder));

  const stats = program
    .command('stats')
    .description('print the cumulative evaluation statistics of every recorded project as a table; pass --json for the machine-readable snapshot')
    .option('--json', 'print the full statistics snapshot as a JSON object instead of the human table')
    .action((options: { readonly json?: boolean | undefined }) => statsCommand(application.statistics, options));

  stats
    .command('reset')
    .description('clear every recorded evaluation statistic')
    .action(() => resetStatsCommand(application.statistics));

  return program;
}
