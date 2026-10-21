import { resolve } from 'node:path';

import { escapeDiagnostic, runProgram, type CliServices } from '../adapter/cli/program.js';
import { terminalCapabilities } from '../adapter/cli/progress.js';
import { createRedactor } from '../adapter/cli/reports.js';
import { createProject, resolveTarget } from '../adapter/filesystem/project.js';
import { runRuleTests } from '../adapter/filesystem/rule-tests.js';
import { createRuleLoader, resolveRuleSelector } from '../adapter/filesystem/rules.js';
import { changedFiles } from '../adapter/git/changes.js';
import { createGithubCommenter } from '../adapter/github/comments.js';
import { createPullRequestCheckout } from '../adapter/github/pull-request.js';
import { createSkillManager } from '../adapter/skills/cli.js';
import { executeRules } from '../app/execute.js';
import { createDecisionResolver } from './settings.js';

const EXIT_FAILURE = 2;
const ENVIRONMENT_FILE = '.env';

function loadEnvironment(cwd: string): void {
  try {
    process.loadEnvFile(resolve(cwd, ENVIRONMENT_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function createServices(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): CliServices {
  const loader = createRuleLoader();
  const redact = createRedactor([env.TYPESAFE_API_KEY, env.GITHUB_TOKEN]);
  return {
    cwd,
    redact,
    terminal: terminalCapabilities({
      stdoutIsTTY: process.stdout.isTTY === true,
      stderrIsTTY: process.stderr.isTTY === true,
      get columns() { return process.stderr.columns; },
      get stdoutColumns() { return process.stdout.columns; },
    }, env),

    loadRules: selection => loader.load(selection),

    runRules: executeRules,

    testRules: (rules, onResult, timeoutMs, concurrency, includeAI) =>
      runRuleTests(rules, onResult, timeoutMs, concurrency, includeAI),

    createProject,

    resolveTarget,

    changedFiles,

    checkoutPullRequest: createPullRequestCheckout(cwd, env),

    commentOnPullRequest: createGithubCommenter(env),

    resolveRuleSelector,

    manageSkill: createSkillManager(cwd, env),

    decisionResolver(thresholdOverride, pricingOverrides) {
      return createDecisionResolver(env, thresholdOverride, pricingOverrides);
    },

    write(text) {
      process.stdout.write(text);
    },

    writeError(text) {
      process.stderr.write(text);
    },
  };
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const cwd = process.cwd();
  try {
    loadEnvironment(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redact = createRedactor([process.env.TYPESAFE_API_KEY, process.env.GITHUB_TOKEN]);
    process.stderr.write(`rulekeeper: ${redact(escapeDiagnostic(message))}\n`);
    return EXIT_FAILURE;
  }
  return runProgram(argv, createServices(cwd, process.env));
}
