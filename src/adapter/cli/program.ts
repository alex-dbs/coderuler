import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';

import type {
  LoadedRule,
  Project,
  RuleReport,
  RuleSelection,
  RunContext,
} from '../../app/ports.js';
import type { RuleTestResult } from '../../app/rule-tests.js';
import { createInspectJsonRenderer } from './inspect-json.js';
import { createProgress, type TerminalCapabilities } from './progress.js';
import {
  countViolations,
  createInspectRenderer,
  createMetadataRenderer,
  createRuleHeadings,
  createWalkthroughRenderer,
  escapeText,
  renderCheckJson,
  renderCheckJsonl,
  renderCheckSummary,
  renderRuleTestHeading,
  renderRuleTestResult,
  renderRuleTestSummary,
  type InspectRenderer,
  type TextRedactor,
  type TextWriter,
  type WalkthroughRenderer,
} from './reports.js';

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_FAILURE = 2;
const SUCCESSFUL_COMMANDER_CODES: Record<string, true> = {
  'commander.help': true,
  'commander.helpDisplayed': true,
  'commander.version': true,
};
const CONCURRENCY_HINT = 'must be a positive safe integer';
const THRESHOLD_HINT = 'must be a decimal number between 0 and 1';
const THRESHOLD_PATTERN = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;
const TIMEOUT_HINT = 'must be a positive duration in ms, s, or m, at most 2147483647ms';
const TIMEOUT_UNITS = { ms: 1, s: 1_000, m: 60_000 } as const;

export interface CliTarget {
  readonly root: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
  contains(filepath: string): boolean;
}

export interface RuleSelectorResolution {
  readonly explicit?: string;
  readonly name?: string;
}

export interface CliServices {
  readonly cwd: string;
  readonly loadRules: (selection: RuleSelection) => Promise<readonly LoadedRule[]>;
  readonly runRules: (
    rules: readonly LoadedRule[],
    context: RunContext,
  ) => Promise<readonly RuleReport[]>;
  readonly testRules: (
    rules: readonly LoadedRule[],
    onResult: (result: RuleTestResult, lastInRule: boolean) => void,
    timeoutMs: number,
    concurrency: number,
    includeAI: boolean,
  ) => Promise<readonly RuleTestResult[]>;
  readonly createProject: (
    root: string,
    options?: { readonly excludeFiles?: readonly string[] },
  ) => Project;
  readonly resolveTarget: (root: string, target: string) => Promise<CliTarget>;
  readonly changedFiles: (root: string, base: string) => Promise<ReadonlySet<string>>;
  readonly resolveRuleSelector: (
    selector: string,
    invocationCwd: string,
  ) => Promise<RuleSelectorResolution>;
  readonly decisionResolver: (thresholdOverride?: number) => RunContext['resolveDecision'];
  readonly redact: TextRedactor;
  readonly write: TextWriter;
  readonly writeError: TextWriter;
  readonly terminal?: TerminalCapabilities;
}

interface CheckOptions {
  readonly rules?: string;
  readonly json?: boolean;
  readonly jsonl?: boolean;
  readonly outputAll?: boolean;
  readonly debug?: boolean;
  readonly verbose?: boolean;
  readonly diffOnly?: boolean;
  readonly base?: string;
  readonly concurrency: number;
  readonly threshold?: number;
}

interface InspectOptions {
  readonly json?: boolean;
  readonly jsonl?: boolean;
  readonly raw?: boolean;
}

interface TestOptions {
  readonly timeout: number;
  readonly concurrency: number;
  readonly ai?: boolean;
  readonly failuresOnly?: boolean;
}

interface RuleChoice {
  readonly rulesPath?: string;
  readonly name?: string;
}

interface ExecutionPlan {
  readonly rules: readonly LoadedRule[];
  readonly project: Project;
  readonly isTarget: (filepath: string) => boolean;
}

class CliExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`rulekeeper exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}

export function escapeDiagnostic(text: string): string {
  return text
    .split('\n')
    .map(segment => escapeText(segment))
    .join('\n');
}

function parseConcurrency(value: string): number {
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(CONCURRENCY_HINT);
  }
  return parsed;
}

function parseThreshold(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!THRESHOLD_PATTERN.test(trimmed) || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError(THRESHOLD_HINT);
  }
  return parsed;
}

function parseTimeout(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)(ms|s|m)$/.exec(value.trim());
  const durationMs = match === null
    ? NaN
    : Number(match[1]) * TIMEOUT_UNITS[match[2] as keyof typeof TIMEOUT_UNITS];
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 2_147_483_647) {
    throw new InvalidArgumentError(TIMEOUT_HINT);
  }
  return durationMs;
}

function ruleSelection(
  services: CliServices,
  choice: RuleChoice,
  root: string,
): RuleSelection {
  const invocationCwd = services.cwd;
  if (choice.rulesPath !== undefined) {
    return { root, explicit: choice.rulesPath, invocationCwd };
  }
  if (choice.name !== undefined) {
    return { root, name: choice.name, invocationCwd };
  }
  return { root, invocationCwd };
}

async function planWalk(
  services: CliServices,
  root: string,
  isTarget: (filepath: string) => boolean,
  choice: RuleChoice,
): Promise<ExecutionPlan> {
  const rules = await services.loadRules(ruleSelection(services, choice, root));
  const project = services.createProject(root, {
    excludeFiles: rules.map(entry => entry.ruleFile),
  });
  return { rules, project, isTarget };
}

export function createProgram(services: CliServices): Command {
  const program = new Command();
  program
    .name('rulekeeper')
    .description('Evaluate trusted TypeScript rules against the current working tree')
    .configureOutput({
      writeErr: text => services.writeError(`rulekeeper: ${services.redact(escapeDiagnostic(text))}`),
    })
    .exitOverride();

  program
    .command('validate')
    .description('Load and structurally validate the selected rules without running them')
    .argument('[rule-path]', 'explicit rule module or directory instead of discovery')
    .action(async (rulePath: string | undefined) => {
      const rules = await services.loadRules(
        ruleSelection(
          services,
          rulePath === undefined ? {} : { rulesPath: rulePath },
          services.cwd,
        ),
      );
      for (const entry of rules) {
        services.write(services.redact(`Valid rule: ${escapeText(entry.name)}\n`));
      }
    });

  program
    .command('test')
    .description('Run the declared test cases for the selected rules')
    .argument('[rule-path]', 'explicit rule module or directory instead of discovery')
    .option('--ai', 'include aiTests that use the configured decision backend')
    .option('--failures-only', 'show only failed test cases')
    .addOption(
      new Option('--timeout <duration>', 'per-test timeout (ms, s, or m)')
        .argParser(parseTimeout)
        .default(10_000, '10s'),
    )
    .option(
      '--concurrency <number>',
      `bounded in-flight test cases (${CONCURRENCY_HINT})`,
      parseConcurrency,
      1,
    )
    .action(async (rulePath: string | undefined, options: TestOptions) => {
      const progress = services.terminal?.interactive === true
        ? createProgress(services.writeError, () => services.terminal?.columns ?? 80)
        : undefined;
      const color = services.terminal?.color === true;
      let passed = 0;
      let failed = 0;
      let durationMs = 0;
      let previousRuleName: string | undefined;
      const failures: RuleTestResult[] | undefined = options.failuresOnly ? [] : undefined;
      let testsStarted = false;
      const flushFailures = () => {
        if (failures === undefined || failures.length === 0) return;
        if (previousRuleName !== undefined) services.write('\n');
        const ruleName = failures[0]!.ruleName;
        services.write(renderRuleTestHeading(ruleName, services.redact, color));
        previousRuleName = ruleName;
        for (let index = 0; index < failures.length; index += 1) {
          services.write(renderRuleTestResult(
            failures[index]!,
            services.redact,
            color,
            index === failures.length - 1,
          ));
        }
        failures.length = 0;
      };
      try {
        const rules = await services.loadRules(
          ruleSelection(
            services,
            rulePath === undefined ? {} : { rulesPath: rulePath },
            services.cwd,
          ),
        );
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
              if (previousRuleName !== undefined) services.write('\n');
              services.write(renderRuleTestHeading(result.ruleName, services.redact, color));
              previousRuleName = result.ruleName;
            }
            services.write(renderRuleTestResult(result, services.redact, color, lastInRule));
          }
          progress?.message(`Running tests (${passed + failed} completed)`);
        }, options.timeout, options.concurrency, options.ai === true);
      } finally {
        progress?.stop();
        if (failures !== undefined && testsStarted) {
          flushFailures();
          if (previousRuleName !== undefined) services.write('\n');
          services.write(renderRuleTestSummary(passed, failed, durationMs, services.redact, color));
        }
      }
      if (failures === undefined) {
        if (previousRuleName !== undefined) services.write('\n');
        services.write(renderRuleTestSummary(passed, failed, durationMs, services.redact, color));
      }
      if (failed > 0) throw new CliExit(EXIT_VIOLATION);
    });

  program
    .command('check')
    .description('Evaluate every selected rule against the working tree')
    .argument('[path]', 'target file or folder that narrows selection', '.')
    .option('--rules <path>', 'explicit rule module or directory instead of discovery')
    .option('--json', 'print violations as {durationMs, reports} JSON on stdout')
    .option('--jsonl', 'print violation rule records as JSON Lines')
    .option('--output-all', 'include passing and skipped rules and every verification in the output')
    .option('--debug', 'stream framework metadata and force concurrency 1')
    .option('--verbose', 'stream the redacted walkthrough at the configured concurrency')
    .option('--diff-only', 'evaluate changed files and affected groups against a Git base')
    .option('--base <ref>', 'Git base for --diff-only (default: HEAD)')
    .option(
      '--concurrency <number>',
      `bounded in-flight selection and evaluation tasks (${CONCURRENCY_HINT})`,
      parseConcurrency,
      8,
    )
    .option('--threshold <number>', `decision threshold override (${THRESHOLD_HINT})`, parseThreshold)
    .action(async (target: string, options: CheckOptions) => {
      if (options.json === true && options.jsonl === true) {
        throw new Error('--json and --jsonl are mutually exclusive');
      }
      if (options.base !== undefined && options.diffOnly !== true) {
        throw new Error('--base requires --diff-only');
      }
      const debug = options.debug === true;
      const verbose = options.verbose === true;
      const machine = options.json === true || options.jsonl === true;
      const progress = services.terminal?.interactive === true && !machine && !debug && !verbose
        ? createProgress(services.writeError, () => services.terminal?.columns ?? 80)
        : undefined;
      let reports: readonly RuleReport[];
      let durationMs: number;
      let walkthrough: WalkthroughRenderer | undefined;
      try {
        const area = await services.resolveTarget(services.cwd, target);
        let changedFiles = options.diffOnly === true
          ? await services.changedFiles(area.root, options.base ?? 'HEAD')
          : undefined;
        const prepared = await planWalk(
          services,
          area.root,
          filepath => area.contains(filepath),
          options.rules === undefined ? {} : { rulesPath: options.rules },
        );
        if (changedFiles !== undefined) {
          const ruleFiles = new Set(prepared.rules.map(entry => relative(area.root, resolve(entry.ruleFile)).split(sep).join('/')));
          changedFiles = new Set([...changedFiles].filter(path => !ruleFiles.has(path)));
        }
        const concurrency = debug ? 1 : options.concurrency;
        walkthrough = verbose
          ? createWalkthroughRenderer({
            write: services.writeError,
            headings: createRuleHeadings(prepared.rules),
            redact: services.redact,
            columns: () => services.terminal?.columns ?? 80,
            concurrency,
          })
          : undefined;
        const emit = walkthrough?.emit ?? (debug
          ? createMetadataRenderer(services.writeError, services.redact)
          : progress?.emit);
        const context: RunContext = {
          project: prepared.project,
          isTarget: prepared.isTarget,
          concurrency,
          resolveDecision: services.decisionResolver(options.threshold),
          ...(emit === undefined ? {} : { emit }),
          ...(changedFiles === undefined ? {} : { changedFiles }),
        };
        const startedAt = performance.now();
        reports = await services.runRules(prepared.rules, context);
        durationMs = performance.now() - startedAt;
      } finally {
        walkthrough?.finish();
        progress?.stop();
      }
      const reportOptions = {
        durationMs,
        outputAll: options.outputAll === true,
        color: services.terminal?.color === true,
      };
      services.write(
        options.json === true
          ? renderCheckJson(reports, reportOptions)
          : options.jsonl === true
            ? renderCheckJsonl(reports, reportOptions)
            : renderCheckSummary(reports, services.redact, reportOptions),
      );
      if (countViolations(reports) > 0) throw new CliExit(EXIT_VIOLATION);
    });

  program
    .command('inspect')
    .description('Walk one rule through selection, filtering, grouping and evaluation')
    .argument('<rule>', 'rule module path or exact rule name')
    .argument('[folder]', 'folder to inspect', '.')
    .option('--json', 'print the complete redacted inspection as one JSON document')
    .option('--jsonl', 'stream redacted inspection events and reports as JSON Lines')
    .option('--raw', 'print the complete redacted inspection as undecorated text')
    .action(async (rule: string, folder: string, options: InspectOptions) => {
      const formats = [
        ...(options.json === true ? ['--json'] : []),
        ...(options.jsonl === true ? ['--jsonl'] : []),
        ...(options.raw === true ? ['--raw'] : []),
      ];
      if (formats.length > 1) {
        throw new Error(`${formats.join(', ')} are mutually exclusive`);
      }
      let inspect: InspectRenderer | undefined = options.json === true || options.jsonl === true
        ? createInspectJsonRenderer({
          write: services.write,
          redact: services.redact,
          format: options.json === true ? 'json' : 'jsonl',
        })
        : undefined;
      try {
        const resolved = await services.resolveRuleSelector(rule, services.cwd);
        const folderPath = resolve(services.cwd, folder);
        const relativeFolder = relative(services.cwd, folderPath);
        const insideInvocationRoot =
          relativeFolder !== '..' &&
          !relativeFolder.startsWith(`..${sep}`) &&
          !isAbsolute(relativeFolder);
        const area = await services.resolveTarget(
          insideInvocationRoot ? services.cwd : folderPath,
          insideInvocationRoot ? (relativeFolder === '' ? '.' : relativeFolder) : '.',
        );
        if (area.kind !== 'directory') {
          throw new Error(`Inspect folder ${escapeText(folder)} is not a directory`);
        }
        const prepared = await planWalk(
          services,
          join(area.root, area.path),
          () => true,
          resolved.explicit === undefined
            ? { name: resolved.name ?? rule }
            : { rulesPath: resolved.explicit },
        );
        inspect ??= createInspectRenderer({
          write: services.write,
          headings: createRuleHeadings(prepared.rules),
          redact: services.redact,
          color: options.raw !== true && services.terminal?.color === true,
          columns: () => services.terminal?.stdoutColumns ?? services.terminal?.columns ?? 80,
          raw: options.raw === true,
        });
        const reports = await services.runRules(prepared.rules, {
          project: prepared.project,
          isTarget: prepared.isTarget,
          concurrency: 1,
          resolveDecision: services.decisionResolver(),
          emit: inspect.emit,
        });
        inspect.finish(reports);
        if (countViolations(reports) > 0) throw new CliExit(EXIT_VIOLATION);
      } catch (error) {
        if (!(error instanceof CliExit)) {
          inspect?.finish([], error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        inspect?.finish([]);
      }
    });

  return program;
}

export async function runProgram(argv: readonly string[], services: CliServices): Promise<number> {
  try {
    await createProgram(services).parseAsync(argv, { from: 'user' });
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliExit) return error.exitCode;
    if (error instanceof CommanderError) {
      return error.exitCode === EXIT_OK && SUCCESSFUL_COMMANDER_CODES[error.code] === true
        ? EXIT_OK
        : EXIT_FAILURE;
    }
    const message = error instanceof Error ? error.message : String(error);
    services.writeError(`rulekeeper: ${services.redact(escapeDiagnostic(message))}\n`);
    return EXIT_FAILURE;
  }
}
