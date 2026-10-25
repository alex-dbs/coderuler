import type { RuleTestResult } from '../../../app/rule-tests.js';
import { CliExit, EXIT_VIOLATION } from '../exit.js';
import { createProgress } from '../progress.js';
import {
  renderRuleTestHeading,
  renderRuleTestResult,
  renderRuleTestSummary,
} from '../reports.js';
import type { CliContext, TestOptions, TestServices } from '../services.js';
import { ruleSelection } from './rules.js';

async function runTest(
  rulePath: string | undefined,
  options: TestOptions,
  context: CliContext,
  services: TestServices,
): Promise<void> {
  const progress = context.terminal?.interactive === true
    ? createProgress(context.writeError, () => context.terminal?.columns ?? 80)
    : undefined;
  const color = context.terminal?.color === true;
  let passed = 0;
  let failed = 0;
  let durationMs = 0;
  let previousRuleName: string | undefined;
  const failures: RuleTestResult[] | undefined = options.failuresOnly ? [] : undefined;
  let testsStarted = false;
  const flushFailures = () => {
    if (failures === undefined || failures.length === 0) return;
    if (previousRuleName !== undefined) context.write('\n');
    const ruleName = failures[0]!.ruleName;
    context.write(renderRuleTestHeading(ruleName, context.redact, color));
    previousRuleName = ruleName;
    for (let index = 0; index < failures.length; index += 1) {
      context.write(renderRuleTestResult(
        failures[index]!,
        context.redact,
        color,
        index === failures.length - 1,
      ));
    }
    failures.length = 0;
  };
  try {
    const choice = rulePath === undefined
      ? {}
      : await services.resolveRuleSelector(rulePath, context.cwd, true);
    const rules = await services.loadRules(ruleSelection(context.cwd, choice, context.cwd));
    progress?.message('Running tests');
    testsStarted = true;
    await services.testRules(rules, (result, lastInRule) => {
      progress?.clear();
      if (result.expected === result.actual) passed += 1;
      else failed += 1;
      durationMs += result.durationMs;
      if (failures !== undefined) {
        if (result.expected !== result.actual) failures.push(result);
        if (lastInRule) flushFailures();
      } else {
        if (result.ruleName !== previousRuleName) {
          if (previousRuleName !== undefined) context.write('\n');
          context.write(renderRuleTestHeading(result.ruleName, context.redact, color));
          previousRuleName = result.ruleName;
        }
        context.write(renderRuleTestResult(result, context.redact, color, lastInRule));
      }
      progress?.message(`Running tests (${passed + failed} completed)`);
    }, options.timeout, options.concurrency, options.ai === true);
  } finally {
    progress?.stop();
    if (failures !== undefined && testsStarted) {
      flushFailures();
      if (previousRuleName !== undefined) context.write('\n');
      context.write(renderRuleTestSummary(passed, failed, durationMs, context.redact, color));
    }
  }
  if (failures === undefined) {
    if (previousRuleName !== undefined) context.write('\n');
    context.write(renderRuleTestSummary(passed, failed, durationMs, context.redact, color));
  }
  if (failed > 0) throw new CliExit(EXIT_VIOLATION);
}

export { runTest };
