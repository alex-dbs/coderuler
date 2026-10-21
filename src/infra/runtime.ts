import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import npa from 'npm-package-arg';

import { escapeDiagnostic, runProgram, type CliServices } from '../adapter/cli/program.js';
import { terminalCapabilities } from '../adapter/cli/progress.js';
import { createRedactor } from '../adapter/cli/reports.js';
import { createRuleDependencyManager } from '../adapter/filesystem/dependencies.js';
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
  const redact = createRedactor([env.TYPESAFE_API_KEY, env.GITHUB_TOKEN]);
  const dependencies = createRuleDependencyManager({
    ...(env.RK_DEPENDENCY_CACHE === undefined ? {} : { cacheRoot: resolve(cwd, env.RK_DEPENDENCY_CACHE) }),
    onWarning: message => services.writeError(`rulekeeper: ${redact(escapeDiagnostic(message))}\n`),
  });
  const loader = createRuleLoader({ dependencies });
  const services: CliServices = {
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
    async manageDependencies(operation, packages, options) {
      if (options.global === true && options.directory !== undefined) {
        throw new Error('--global and --directory are mutually exclusive');
      }
      const directory = options.global === true
        ? resolve(homedir(), '.rulekeeper')
        : resolve(cwd, options.directory ?? '.rulekeeper');
      if (operation !== 'add' && !(await stat(directory)).isDirectory()) {
        throw new Error(`Rule dependency directory is not a directory: ${directory}`);
      }
      if (operation === 'sync') {
        const prepared = await dependencies.sync(directory);
        this.write(redact(escapeDiagnostic(`Rule dependencies ready: ${prepared.directory}`)) + '\n');
        return;
      }
      const prepared = await dependencies.change(directory, operation, packages);
      if (operation === 'add') {
        for (const specifier of packages) {
          const name = npa(specifier).name!;
          this.write(redact(escapeDiagnostic(`Added ${name}@${prepared.directVersions[name]}`)) + '\n');
        }
      } else {
        for (const name of packages) this.write(redact(escapeDiagnostic(`Removed ${name}`)) + '\n');
      }
      this.write(redact(escapeDiagnostic(join(prepared.directory, 'rulekeeper.lock'))) + '\n');
    },

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
  return services;
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
