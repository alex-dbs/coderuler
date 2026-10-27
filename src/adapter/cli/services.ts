import type {
  LoadedRule,
  Project,
  RuleReport,
  RuleSelection,
  RunContext,
} from '../../app/ports.js';
import type { RuleTestResult } from '../../app/rule-tests.js';
import type { TokenPricing } from '../../app/rule.js';
import type { ViolationComment } from '../../app/violation-comments.js';
import type { PullRequest, PullRequestCheckout } from '../github/pull-request.js';
import type { SkillOptions } from '../skills/cli.js';
import type { TerminalCapabilities } from './progress.js';
import type { TextRedactor, TextWriter } from './text.js';

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

export interface CheckOptions {
  readonly rules?: string;
  readonly tags: readonly string[];
  readonly excludeTags: readonly string[];
  readonly json?: boolean;
  readonly jsonl?: boolean;
  readonly outputAll?: boolean;
  readonly debug?: boolean;
  readonly verbose?: boolean;
  readonly diffOnly?: boolean;
  readonly pr?: string;
  readonly autoComment?: boolean;
  readonly base?: string;
  readonly concurrency: number;
  readonly threshold?: number;
}

export interface InspectOptions {
  readonly json?: boolean;
  readonly jsonl?: boolean;
  readonly raw?: boolean;
  readonly inputCostPerMillion?: number;
  readonly outputCostPerMillion?: number;
}

export interface TestOptions {
  readonly timeout: number;
  readonly concurrency: number;
  readonly ai?: boolean;
  readonly failuresOnly?: boolean;
  readonly aiScores?: boolean;
}

export interface DependencyOptions {
  readonly global?: boolean;
  readonly directory?: string;
}

export interface CliContext {
  readonly cwd: string;
  readonly version: string;
  readonly redact: TextRedactor;
  readonly write: TextWriter;
  readonly writeError: TextWriter;
  readonly terminal?: TerminalCapabilities;
}

export interface RuleServices {
  readonly loadRules: (selection: RuleSelection) => Promise<readonly LoadedRule[]>;
  readonly resolveRuleSelector: (
    selector: string,
    invocationCwd: string,
    allowDirectory?: boolean,
  ) => Promise<RuleSelectorResolution>;
}

export interface ExecutionServices extends RuleServices {
  readonly createProject: (
    root: string,
    options?: { readonly excludeFiles?: readonly string[] },
  ) => Project;
  readonly resolveTarget: (root: string, target: string) => Promise<CliTarget>;
  readonly runRules: (
    rules: readonly LoadedRule[],
    context: RunContext,
  ) => Promise<readonly RuleReport[]>;
  readonly decisionResolver: (
    thresholdOverride?: number,
    pricingOverrides?: Partial<TokenPricing>,
  ) => RunContext['resolveDecision'];
}

export interface CheckServices extends ExecutionServices {
  readonly changedFiles: (root: string, base: string) => Promise<ReadonlySet<string>>;
  readonly checkoutPullRequest: (selector: string, baseBranch?: string) => Promise<PullRequestCheckout>;
  readonly commentOnPullRequest: (
    root: string,
    comments: readonly ViolationComment[],
    pullRequest?: PullRequest,
  ) => Promise<void>;
}

export type InspectServices = ExecutionServices;
export type ValidateServices = RuleServices;

export interface TestServices extends RuleServices {
  readonly testRules: (
    rules: readonly LoadedRule[],
    onResult: (result: RuleTestResult, lastInRule: boolean) => void,
    timeoutMs: number,
    concurrency: number,
    includeAI: boolean,
  ) => Promise<readonly RuleTestResult[]>;
}

export interface UpdateServices {
  readonly updateTool: () => Promise<number>;
}

export interface SkillServices {
  readonly manageSkill: (operation: 'install' | 'update', options: SkillOptions) => Promise<number>;
}

export interface DependencyServices {
  readonly manageDependencies: (
    operation: 'add' | 'remove' | 'sync',
    packages: readonly string[],
    options: DependencyOptions,
  ) => Promise<void>;
}

export interface CliServices extends CliContext {
  readonly load: {
    readonly check: (context: CliContext) => Promise<CheckServices>;
    readonly inspect: (context: CliContext) => Promise<InspectServices>;
    readonly test: (context: CliContext) => Promise<TestServices>;
    readonly validate: (context: CliContext) => Promise<ValidateServices>;
    readonly update: (context: CliContext) => Promise<UpdateServices>;
    readonly skill: (context: CliContext) => Promise<SkillServices>;
    readonly deps: (context: CliContext) => Promise<DependencyServices>;
  };
}
