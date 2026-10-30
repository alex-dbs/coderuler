import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { runProgram } from '../adapter/cli/program.js';
import { terminalCapabilities } from '../adapter/cli/progress.js';
import type {
  CliContext,
  CliServices,
  DependencyOptions,
  RuleServices,
} from '../adapter/cli/services.js';
import { createRedactor, escapeDiagnostic } from '../adapter/cli/text.js';
import { installedVersion } from '../adapter/cli/version.js';
import type { RuleDependencyManager } from '../adapter/filesystem/dependencies.js';
import type { TokenPricing } from '../app/rule.js';

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
  const redact = createRedactor([env.TYPESAFE_API_KEY, env.OPENAI_API_KEY, env.GITHUB_TOKEN]);
  let dependenciesPromise: Promise<RuleDependencyManager> | undefined;
  let ruleServicesPromise: Promise<RuleServices> | undefined;
  const getDependencies = (context: CliContext): Promise<RuleDependencyManager> =>
    dependenciesPromise ??= (async () => {
      const { createRuleDependencyManager } = await import('../adapter/filesystem/dependencies.js');
      return createRuleDependencyManager({
        ...(env.RK_DEPENDENCY_CACHE === undefined ? {} : { cacheRoot: resolve(cwd, env.RK_DEPENDENCY_CACHE) }),
        onWarning: message => context.writeError(`coderuler: ${context.redact(escapeDiagnostic(message))}\n`),
      });
    })();
  const getRuleServices = (context: CliContext): Promise<RuleServices> =>
    ruleServicesPromise ??= (async () => {
      const dependencies = await getDependencies(context);
      const { createRuleLoader, resolveRuleSelector } = await import('../adapter/filesystem/rules.js');
      const loader = createRuleLoader({ dependencies });
      return {
        loadRules: selection => loader.load(selection),
        resolveRuleSelector,
      };
    })();
  const services: CliServices = {
    cwd,
    version: installedVersion,
    redact,
    terminal: terminalCapabilities({
      stdoutIsTTY: process.stdout.isTTY === true,
      stderrIsTTY: process.stderr.isTTY === true,
      get columns() { return process.stderr.columns; },
      get stdoutColumns() { return process.stdout.columns; },
    }, env),
    write(text) {
      process.stdout.write(text);
    },
    writeError(text) {
      process.stderr.write(text);
    },
    load: {
      async validate(context) {
        return getRuleServices(context);
      },
      async check(context) {
        const [ruleServices, project, execution, settings] = await Promise.all([
          getRuleServices(context),
          import('../adapter/filesystem/project.js'),
          import('../app/execute.js'),
          import('./settings.js'),
        ]);
        return {
          ...ruleServices,
          createProject: project.createProject,
          resolveTarget: project.resolveTarget,
          runRules: execution.executeRules,
          decisionResolver: (thresholdOverride?: number, pricingOverrides?: Partial<TokenPricing>) =>
            settings.createDecisionResolver(env, thresholdOverride, pricingOverrides),
          async collectChanges(root: string, base: string) {
            const { collectChanges } = await import('../adapter/git/changes.js');
            return collectChanges(root, base);
          },
          async checkoutPullRequest(selector: string, baseBranch?: string) {
            const { createPullRequestCheckout } = await import('../adapter/github/pull-request.js');
            return createPullRequestCheckout(cwd, env)(selector, baseBranch);
          },
          async checkoutRuleRepository(selector: string) {
            const { createRuleRepositoryCheckout } = await import('../adapter/git/rules.js');
            return createRuleRepositoryCheckout(env)(selector);
          },
          async commentOnPullRequest(root, comments, pullRequest) {
            const { createGithubCommenter } = await import('../adapter/github/comments.js');
            return createGithubCommenter(env)(root, comments, pullRequest);
          },
        };
      },
      async inspect(context) {
        const [ruleServices, project, execution, settings] = await Promise.all([
          getRuleServices(context),
          import('../adapter/filesystem/project.js'),
          import('../app/execute.js'),
          import('./settings.js'),
        ]);
        return {
          ...ruleServices,
          createProject: project.createProject,
          resolveTarget: project.resolveTarget,
          runRules: execution.executeRules,
          decisionResolver: (thresholdOverride?: number, pricingOverrides?: Partial<TokenPricing>) =>
            settings.createDecisionResolver(env, thresholdOverride, pricingOverrides),
        };
      },
      async test(context) {
        const ruleServices = await getRuleServices(context);
        const { runRuleTests } = await import('../adapter/filesystem/rule-tests.js');
        return {
          ...ruleServices,
          testRules: (rules, onResult, timeoutMs, concurrency, includeAI) =>
            runRuleTests(rules, onResult, timeoutMs, concurrency, includeAI),
        };
      },
      async update(_context: CliContext) {
        const { createToolUpdater } = await import('../adapter/cli/self-update.js');
        return { updateTool: createToolUpdater(cwd, env) };
      },
      async skill(_context: CliContext) {
        const { createSkillManager } = await import('../adapter/skills/cli.js');
        return { manageSkill: createSkillManager(cwd, env) };
      },
      async deps(context) {
        const dependencies = await getDependencies(context);
        const { default: npa } = await import('npm-package-arg');
        const manageDependencies = async (
          operation: 'add' | 'remove' | 'sync',
          packages: readonly string[],
          options: DependencyOptions,
        ): Promise<void> => {
          if (options.global === true && options.directory !== undefined) {
            throw new Error('--global and --directory are mutually exclusive');
          }
          const directory = options.global === true
            ? resolve(homedir(), '.coderuler')
            : resolve(cwd, options.directory ?? '.coderuler');
          if (operation !== 'add' && !(await stat(directory)).isDirectory()) {
            throw new Error(`Rule dependency directory is not a directory: ${directory}`);
          }
          if (operation === 'sync') {
            const prepared = await dependencies.sync(directory);
            context.write(context.redact(escapeDiagnostic(`Rule dependencies ready: ${prepared.directory}`)) + '\n');
            return;
          }
          const prepared = await dependencies.change(directory, operation, packages);
          if (operation === 'add') {
            for (const specifier of packages) {
              const name = npa(specifier).name!;
              context.write(context.redact(escapeDiagnostic(`Added ${name}@${prepared.directVersions[name]}`)) + '\n');
            }
          } else {
            for (const name of packages) context.write(context.redact(escapeDiagnostic(`Removed ${name}`)) + '\n');
          }
          context.write(context.redact(escapeDiagnostic(join(prepared.directory, 'coderuler.lock'))) + '\n');
        };
        return { manageDependencies };
      },
    },
  };
  return services;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const cwd = process.cwd();
  try {
    const versionOnly = argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V');
    if (!versionOnly) loadEnvironment(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redact = createRedactor([
      process.env.TYPESAFE_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.GITHUB_TOKEN,
    ]);
    process.stderr.write(`coderuler: ${redact(escapeDiagnostic(message))}\n`);
    return EXIT_FAILURE;
  }
  return runProgram(argv, createServices(cwd, process.env));
}
