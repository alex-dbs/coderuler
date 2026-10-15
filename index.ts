import { Command } from 'commander';
import { checkCommand } from './command/check.ts';
import { validateCommand } from './command/validate.ts';

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
  .description('decide every selected scope against its rule with the configured backend, and print each rule, its examples, the surviving scope candidates and their decisions as JSON')
  .argument('[path]', 'source file or directory to check; defaults to the current directory', '.')
  .option('--rules <path>', 'rule YAML file or folder; defaults to the discovered rules')
  .option('--diff-only', 'check the committed change from a merge base instead of reading working-tree sources')
  .option('--base <ref>', 'ref to merge-base HEAD against with --diff-only; defaults to origin/HEAD, then origin/main, origin/master, main, master')
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
