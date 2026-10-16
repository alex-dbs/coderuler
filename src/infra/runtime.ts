import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../adapter/cli/program.ts';
import { createRuleFiles } from '../adapter/filesystem/rule-files.ts';
import { createSourceRepository } from '../adapter/filesystem/sources.ts';
import { createSqliteStatistics } from '../adapter/sqlite/statistics.ts';
import { createCheck } from '../app/check.ts';
import { createContextCollector } from '../app/collect-contexts.ts';
import { createRuleLoader } from '../app/load-rules.ts';
import { trackCheck } from '../app/statistics.ts';
import { createValidate } from '../app/validate.ts';
import { createDecisionService } from './decision.ts';
import { createInspectCommand } from './inspect.ts';
import { parseRule } from './rules.ts';

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  try {
    try {
      process.loadEnvFile();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }

    const loadRules = createRuleLoader(createRuleFiles(), parseRule);
    const statistics = createSqliteStatistics(join(homedir(), '.rulekeeper', 'stats.sqlite'));
    const check = createCheck({
      loadRules,
      contexts: createContextCollector(createSourceRepository()),
      createDecisionService: (settings, diagnostics, threshold) =>
        createDecisionService(undefined, diagnostics, threshold, settings),
      cwd: process.cwd(),
    });
    const program = createProgram({
      check: trackCheck(check, realpathSync(process.cwd()), statistics, () => performance.now()),
      validate: createValidate(loadRules),
      inspect: createInspectCommand(statistics),
      statistics,
    });

    await program.parseAsync([...argv]);
  } catch (error) {
    process.stderr.write(`rulekeeper: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
