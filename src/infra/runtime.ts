import { createProgram } from '../adapter/cli/program.ts';
import { createRuleFiles } from '../adapter/filesystem/rule-files.ts';
import { createSourceRepository } from '../adapter/filesystem/sources.ts';
import { createCheck } from '../app/check.ts';
import { createContextCollector } from '../app/collect-contexts.ts';
import { createRuleLoader } from '../app/load-rules.ts';
import { createValidate } from '../app/validate.ts';
import { createDecisionService } from './decision.ts';
import { parseRule } from './rules.ts';

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  try {
    try {
      process.loadEnvFile();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }

    const loadRules = createRuleLoader(createRuleFiles(), parseRule);
    const check = createCheck({
      loadRules,
      contexts: createContextCollector(createSourceRepository()),
      createDecisionService: (diagnostics, threshold) => createDecisionService(undefined, diagnostics, threshold),
      cwd: process.cwd(),
    });
    const program = createProgram({ check, validate: createValidate(loadRules) });

    await program.parseAsync([...argv]);
  } catch (error) {
    process.stderr.write(`rulekeeper: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
