import type { CliContext, ValidateServices } from '../services.js';
import { escapeText } from '../text.js';
import { ruleSelection } from './rules.js';

async function runValidate(
  rulePath: string | undefined,
  context: CliContext,
  services: ValidateServices,
): Promise<void> {
  const choice = rulePath === undefined
    ? {}
    : await services.resolveRuleSelector(rulePath, context.cwd, true);
  const rules = await services.loadRules(ruleSelection(context.cwd, choice, context.cwd));
  for (const entry of rules) {
    context.write(context.redact(`Valid rule: ${escapeText(entry.name)}\n`));
  }
}

export { runValidate };
