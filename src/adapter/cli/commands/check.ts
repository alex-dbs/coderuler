import { relative, resolve, sep } from 'node:path';

import type { DiffChanges, LoadedRule, RuleReport, RunContext } from '../../../app/ports.js';
import type { PullRequestCheckout } from '../../github/pull-request.js';
import { CliExit, EXIT_VIOLATION } from '../exit.js';
import { createProgress } from '../progress.js';
import {
  countViolations,
  createMetadataRenderer,
  createRuleHeadings,
  createWalkthroughRenderer,
  renderCheckJson,
  renderCheckJsonl,
  renderCheckSummary,
  renderViolationComments,
  type WalkthroughRenderer,
} from '../reports.js';
import type { CheckOptions, CheckServices, CliContext } from '../services.js';
import { planWalk } from './rules.js';

async function runCheck(
  target: string,
  options: CheckOptions,
  context: CliContext,
  services: CheckServices,
): Promise<void> {
  const diffOnly = options.diffOnly === true || options.pr !== undefined;
  const debug = options.debug === true;
  const verbose = options.verbose === true;
  const machine = options.json === true || options.jsonl === true;
  const progress = context.terminal?.interactive === true && !machine && !debug && !verbose
    ? createProgress(context.writeError, () => context.terminal?.columns ?? 80)
    : undefined;
  let checkout: PullRequestCheckout | undefined;
  try {
    let reports: readonly RuleReport[];
    let durationMs: number;
    let root: string;
    let rules: readonly LoadedRule[];
    let walkthrough: WalkthroughRenderer | undefined;
    try {
      if (options.pr !== undefined) {
        checkout = await services.checkoutPullRequest(options.pr, options.base);
      }
      const area = await services.resolveTarget(checkout?.root ?? context.cwd, target);
      root = area.root;
      let changes: DiffChanges | undefined = checkout === undefined
        ? (diffOnly ? await services.collectChanges(area.root, options.base ?? 'HEAD') : undefined)
        : { changedFiles: checkout.changedFiles, changedLines: checkout.changedLines };
      const choice = options.rules === undefined
        ? {}
        : await services.resolveRuleSelector(options.rules, context.cwd, true);
      const prepared = await planWalk(
        context.cwd,
        services,
        area.root,
        filepath => area.contains(filepath),
        choice,
        checkout?.rulesRoot ?? area.root,
      );
      rules = options.tags.length === 0 && options.excludeTags.length === 0
        ? prepared.rules
        : prepared.rules.filter(({ rule }) =>
          (options.tags.length === 0 ||
            rule.tags?.some(tag => options.tags.includes(tag)) === true) &&
          !rule.tags?.some(tag => options.excludeTags.includes(tag)),
        );
      if (changes !== undefined) {
        const ruleFiles = new Set(prepared.rules.map(entry => relative(area.root, resolve(entry.ruleFile)).split(sep).join('/')));
        changes = {
          changedFiles: new Set([...changes.changedFiles].filter(path => !ruleFiles.has(path))),
          changedLines: new Map([...changes.changedLines].filter(([path]) => !ruleFiles.has(path))),
        };
      }
      const concurrency = debug ? 1 : options.concurrency;
      walkthrough = verbose
        ? createWalkthroughRenderer({
          write: context.writeError,
          headings: createRuleHeadings(rules),
          redact: context.redact,
          columns: () => context.terminal?.columns ?? 80,
          concurrency,
        })
        : undefined;
      const emit = walkthrough?.emit ?? (debug
        ? createMetadataRenderer(context.writeError, context.redact)
        : progress?.emit);
      const runContext: RunContext = {
        project: prepared.project,
        isTarget: prepared.isTarget,
        concurrency,
        resolveDecision: services.decisionResolver(options.threshold),
        ...(emit === undefined ? {} : { emit }),
        ...(changes === undefined ? {} : {
          changedFiles: changes.changedFiles,
          changedLines: changes.changedLines,
        }),
      };
      const startedAt = performance.now();
      reports = await services.runRules(rules, runContext);
      durationMs = performance.now() - startedAt;
    } finally {
      walkthrough?.finish();
      progress?.stop();
    }
    const reportOptions = {
      durationMs,
      outputAll: options.outputAll === true,
      color: context.terminal?.color === true,
    };
    context.write(
      options.json === true
        ? renderCheckJson(reports, reportOptions)
        : options.jsonl === true
          ? renderCheckJsonl(reports, reportOptions)
          : renderCheckSummary(reports, context.redact, reportOptions),
    );
    if (countViolations(reports) > 0) {
      if (options.autoComment === true) {
        await services.commentOnPullRequest(
          root,
          renderViolationComments(reports, context.redact, rules),
          checkout?.pullRequest,
        );
      }
      throw new CliExit(EXIT_VIOLATION);
    }
  } finally {
    await checkout?.cleanup();
  }
}

export { runCheck };
