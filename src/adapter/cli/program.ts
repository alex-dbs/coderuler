import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { Command, CommanderError, InvalidArgumentError } from 'commander';

import type {
  LoadedRule,
  Project,
  RuleReport,
  RuleSelection,
  RunContext,
  RunEvent,
} from '../../app/ports.js';
import {
  countViolations,
  createInspectRenderer,
  createMetadataRenderer,
  createRuleHeadings,
  createWalkthroughRenderer,
  escapeText,
  renderCheckJson,
  renderCheckSummary,
  type TextRedactor,
  type TextWriter,
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
  readonly createProject: (
    root: string,
    options?: { readonly excludeFiles?: readonly string[] },
  ) => Project;
  readonly resolveTarget: (root: string, target: string) => Promise<CliTarget>;
  readonly resolveRuleSelector: (
    selector: string,
    invocationCwd: string,
  ) => Promise<RuleSelectorResolution>;
  readonly decisionResolver: (thresholdOverride?: number) => RunContext['resolveDecision'];
  readonly redact: TextRedactor;
  readonly write: TextWriter;
  readonly writeError: TextWriter;
}

interface CheckOptions {
  readonly rules?: string;
  readonly json?: boolean;
  readonly debug?: boolean;
  readonly verbose?: boolean;
  readonly concurrency: number;
  readonly threshold?: number;
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
    .command('check')
    .description('Evaluate every selected rule against the working tree')
    .argument('[path]', 'target file or folder that narrows selection', '.')
    .option('--rules <path>', 'explicit rule module or directory instead of discovery')
    .option('--json', 'print the complete report as a JSON array on stdout')
    .option('--debug', 'stream framework metadata and force concurrency 1')
    .option('--verbose', 'stream the redacted walkthrough at the configured concurrency')
    .option(
      '--concurrency <number>',
      `bounded in-flight selection and evaluation tasks (${CONCURRENCY_HINT})`,
      parseConcurrency,
      8,
    )
    .option('--threshold <number>', `decision threshold override (${THRESHOLD_HINT})`, parseThreshold)
    .action(async (target: string, options: CheckOptions) => {
      const debug = options.debug === true;
      const verbose = options.verbose === true;
      const area = await services.resolveTarget(services.cwd, target);
      const prepared = await planWalk(
        services,
        area.root,
        filepath => area.contains(filepath),
        options.rules === undefined ? {} : { rulesPath: options.rules },
      );
      const render = (rules: readonly LoadedRule[]): ((event: RunEvent) => void) => {
        if (!verbose) return createMetadataRenderer(services.writeError, services.redact);
        return createWalkthroughRenderer(
          services.writeError,
          createRuleHeadings(rules),
          services.redact,
        );
      };
      const emit = debug || verbose ? render(prepared.rules) : undefined;
      const reports = await services.runRules(prepared.rules, {
        project: prepared.project,
        isTarget: prepared.isTarget,
        concurrency: debug ? 1 : options.concurrency,
        resolveDecision: services.decisionResolver(options.threshold),
        ...(emit === undefined ? {} : { emit }),
      });
      services.write(
        options.json === true
          ? renderCheckJson(reports)
          : renderCheckSummary(reports, services.redact),
      );
      if (countViolations(reports) > 0) throw new CliExit(EXIT_VIOLATION);
    });

  program
    .command('inspect')
    .description('Walk one rule through selection, filtering, grouping and evaluation')
    .argument('<rule>', 'rule module path or exact rule name')
    .argument('[folder]', 'folder to inspect', '.')
    .action(async (rule: string, folder: string) => {
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
      const inspect = createInspectRenderer({
        write: services.write,
        headings: createRuleHeadings(prepared.rules),
        redact: services.redact,
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
