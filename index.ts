import { Command } from 'commander';
import { checkCommand } from './command/check.ts';
import { validateCommand } from './command/validate.ts';
import { DEFAULT_CONCURRENCY, parseConcurrency } from './src/concurrency.ts';
import { DEFAULT_THRESHOLD, parseThreshold } from './src/decision/threshold.ts';

const program = new Command();

program
  .name('rulekeeper')
  .description('Compile rule YAML files and check source files against their scopes');

program
  .command('validate')
  .description('compile one rule file, a folder of rules, or every discovered rule, and report each rule name')
  .argument('[rule-file]', 'rule YAML file or folder to read and compile; omit to compile the discovered rules')
  .action(validateCommand);

program
  .command('check')
  .description('decide every selected scope against its rule with the configured backend and print a compact human summary; pass --json for the full machine-readable report')
  .argument('[path]', 'source file or directory to check; defaults to the current directory', '.')
  .option('--rules <path>', 'rule YAML file or folder; defaults to the discovered rules')
  .option('--diff-only', 'check the committed change from a merge base instead of reading working-tree sources; a rule that groups its decisions still reads the current tree')
  .option('--base <ref>', 'ref to merge-base HEAD against with --diff-only; defaults to origin/HEAD, then origin/main, origin/master, main, master')
  .option('--json', 'print the checked rules, their examples, surviving scope candidates and decisions as a JSON array instead of the human summary')
  .option('--debug', 'run one unit of work at a time (forces concurrency 1) and log important troubleshooting diagnostics to stderr')
  .option('--verbose', 'log the important diagnostics plus finer-grained detail to stderr, keeping the configured concurrency')
  .option(
    '--concurrency <number>',
    'maximum rules, sources, and decisions in flight at once; the limit is global, not per rule',
    parseConcurrency,
    DEFAULT_CONCURRENCY,
  )
  .option(
    '--threshold <number>',
    `minimum probability to pass (strictly greater, 0 to 1); defaults to RK_THRESHOLD, then ${DEFAULT_THRESHOLD}`,
    value => parseThreshold(value),
  )
  .action(checkCommand);

try {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`rulekeeper: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
