import { DEFAULT_CONCURRENCY, mapConcurrent } from './concurrency.ts';
import type { LoadedRule, RuleFiles, RuleLoader } from './ports/rules.ts';
import type { CompiledRule } from './rule/types.ts';

export function createRuleLoader(
  files: RuleFiles,
  compile: (source: string, filepath: string) => CompiledRule,
): RuleLoader {
  return async (rulePath, concurrency = DEFAULT_CONCURRENCY, diagnostics) => {
    const started = diagnostics === undefined ? 0 : performance.now();
    const source = rulePath === undefined ? 'discovery' : 'explicit';
    const { files: discovered, missingRulesError } = await files.find(rulePath);
    diagnostics?.important('rules.discovered', {
      source,
      files: discovered.length,
      ms: Math.round(performance.now() - started),
    });
    if (missingRulesError !== undefined) throw missingRulesError;

    const verbose = diagnostics?.verbose;
    return await mapConcurrent(discovered, concurrency, async (filepath): Promise<LoadedRule> => {
      const compiled = verbose === undefined ? 0 : performance.now();
      let text: string;
      try {
        text = await files.read(filepath);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Rule file ${filepath} could not be read: ${detail}`, { cause: error });
      }
      let rule: CompiledRule;
      try {
        rule = compile(text, filepath);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Rule file ${filepath} is invalid: ${detail}`, { cause: error });
      }
      if (verbose !== undefined) {
        verbose('rules.rule', {
          file: filepath,
          name: rule.name,
          version: rule.version,
          group_by: rule.decision.group_by,
          level: rule.decision.group_by === 'folder' ? rule.decision.level : undefined,
          examples_good: rule.examples.good.length,
          examples_bad: rule.examples.bad.length,
          ms: Math.round(performance.now() - compiled),
        });
      }
      return { filepath, rule };
    });
  };
}
