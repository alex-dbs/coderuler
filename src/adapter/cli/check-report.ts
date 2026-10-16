import { stripVTControlCharacters, styleText } from 'node:util';
import ora from 'ora';
import type {
  CheckProgress,
  CheckedGroupDecision,
  CheckedRule,
  CheckedScopeDecision,
  DecisionProgress,
} from '../../app/check-result.ts';
import type { Context } from '../../app/rule/types.ts';

export interface CheckReporter extends CheckProgress {
  finish(results: readonly CheckedRule[]): void;
  stop(): void;
}

interface ViolationBlock {
  readonly label: string;
  readonly lines: readonly string[];
}

interface ViolationEntry {
  readonly header: string;
  readonly blocks: readonly ViolationBlock[];
}

interface CheckSummary {
  readonly totalRules: number;
  readonly totalScopes: number;
  readonly files: number;
  readonly decisions: number;
  readonly passed: number;
  readonly violations: number;
  readonly reportedViolations: readonly ViolationEntry[];
  readonly hiddenViolations: number;
  readonly elapsed: string;
}

const DEFAULT_COLUMNS = 80;
const MINIMUM_WIDTH = 16;
const SPINNER_RESERVED_COLUMNS = 2;
const MINIMUM_BAR_WIDTH = 6;
const MAXIMUM_BAR_WIDTH = 28;
const MAXIMUM_ACTIVITY_LINES = 4;
const MAXIMUM_REPORTED_VIOLATIONS = 10;
const MAXIMUM_SOURCE_LINES = 5;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const SOURCE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const COLOR_STREAM = { stream: process.stdout } as const;

function sanitizeText(value: string): string {
  return stripVTControlCharacters(value).replace(CONTROL_CHARACTERS, '').trim();
}

function sanitizeSourceLine(value: string): string {
  return stripVTControlCharacters(value).replace(SOURCE_CONTROL_CHARACTERS, '');
}

function fitAsciiLine(line: string, width: number): string {
  const characters = [...stripVTControlCharacters(line)];
  if (characters.length <= width) return characters.join('');
  if (width <= 1) return characters.slice(0, Math.max(0, width)).join('');
  return `${characters.slice(0, width - 1).join('')}…`;
}

function progressBar(done: number, total: number, width: number): string {
  const ratio = total <= 0 ? 1 : Math.min(1, Math.max(0, done / total));
  const filled = Math.round(ratio * width);
  return `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
}

function progressLine(label: string, done: number, total: number, width: number): string {
  const counts = `${done}/${total}`;
  const barWidth = Math.min(MAXIMUM_BAR_WIDTH, width - label.length - counts.length - 4);
  if (barWidth >= MINIMUM_BAR_WIDTH) {
    return `${label} [${progressBar(done, total, barWidth)}] ${counts}`;
  }
  const plain = `${label} ${counts}`;
  if (plain.length <= width) return plain;
  const labelRoom = width - counts.length - 2;
  if (labelRoom < 1) return counts;
  return `${label.slice(0, labelRoom - 1)}… ${counts}`;
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function stderrWidth(): number {
  return Math.max(MINIMUM_WIDTH, (process.stderr.columns ?? DEFAULT_COLUMNS) - SPINNER_RESERVED_COLUMNS);
}

function contextIndex(contexts: readonly Context[]): Map<string, Context> {
  const index = new Map<string, Context>();
  for (const context of contexts) index.set(`${context.filepath}\u0000${context.scope.id}`, context);
  return index;
}

function sourceLines(source: string): string[] {
  const lines = source.split('\n', MAXIMUM_SOURCE_LINES + 2);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function sourceBlock(context: Context | undefined): readonly string[] {
  if (context === undefined) return [];
  const start = context.scope.lines?.start;
  const lines = sourceLines(context.scope.source);
  const truncated = lines.length > MAXIMUM_SOURCE_LINES;
  if (truncated) lines.length = MAXIMUM_SOURCE_LINES;
  const width = start === undefined ? 0 : String(start + lines.length - 1).length;
  const rendered = lines.map((line, position) => {
    const text = sanitizeSourceLine(line);
    return start === undefined ? `    ${text}` : `    ${String(start + position).padStart(width)} | ${text}`;
  });
  if (truncated) rendered.push('    …');
  return rendered;
}

function scopeLabel(filepath: string, context: Context | undefined): string {
  const path = sanitizeText(filepath);
  const lines = context?.scope.lines;
  return lines === undefined ? path : `${path}:${lines.start}-${lines.end}`;
}

function violationHeader(rule: CheckedRule): string {
  const base = sanitizeText(rule.name);
  if (rule.violationMessage === undefined) return base;
  const message = sanitizeText(rule.violationMessage);
  return message === '' ? base : `${base} — ${message}`;
}

function scopeViolation(
  rule: CheckedRule,
  decision: CheckedScopeDecision,
  index: ReadonlyMap<string, Context>,
): ViolationEntry {
  const context = index.get(`${decision.filepath}\u0000${decision.scopeId}`);
  return {
    header: violationHeader(rule),
    blocks: [{ label: scopeLabel(decision.filepath, context), lines: sourceBlock(context) }],
  };
}

function groupViolation(
  rule: CheckedRule,
  decision: CheckedGroupDecision,
  index: ReadonlyMap<string, Context>,
): ViolationEntry {
  return {
    header: violationHeader(rule),
    blocks: decision.members.map((member) => {
      const context = index.get(`${member.filepath}\u0000${member.scopeId}`);
      return { label: scopeLabel(member.filepath, context), lines: sourceBlock(context) };
    }),
  };
}

function summarize(results: readonly CheckedRule[], elapsedMs: number): CheckSummary {
  const files = new Set<string>();
  const reportedViolations: ViolationEntry[] = [];
  let totalScopes = 0;
  let decisions = 0;
  let passed = 0;
  let violations = 0;

  for (const rule of results) {
    totalScopes += rule.contexts.length;
    for (const context of rule.contexts) files.add(context.filepath);
    let index: Map<string, Context> | undefined;
    for (const decision of rule.decisions) {
      decisions++;
      if (decision.follows) {
        passed++;
        continue;
      }
      violations++;
      if (reportedViolations.length < MAXIMUM_REPORTED_VIOLATIONS) {
        index ??= contextIndex(rule.contexts);
        reportedViolations.push(
          'group' in decision ? groupViolation(rule, decision, index) : scopeViolation(rule, decision, index),
        );
      }
    }
  }

  return {
    totalRules: results.length,
    totalScopes,
    files: files.size,
    decisions,
    passed,
    violations,
    reportedViolations,
    hiddenViolations: violations - reportedViolations.length,
    elapsed: formatElapsed(elapsedMs),
  };
}

function summaryLines(summary: CheckSummary): string[] {
  const lines = [
    `🚀 ${summary.totalRules} ${summary.totalRules === 1 ? 'rule' : 'rules'} checked`,
  ];

  if (summary.decisions === 0) {
    lines.push('0 verifications ran (no matching scopes)');
  } else {
    const passed = styleText('green', `${summary.passed} passed`, COLOR_STREAM);
    const violations = styleText('red', `${summary.violations} ${summary.violations === 1 ? 'violation' : 'violations'}`, COLOR_STREAM);
    lines.push(`${summary.decisions} ${summary.decisions === 1 ? 'verification' : 'verifications'} ran (${passed}, ${violations})`);
  }
  lines.push(`Selected scopes: ${summary.totalScopes} in ${summary.files} ${summary.files === 1 ? 'file' : 'files'}`);

  if (summary.violations > 0) {
    const heading = summary.hiddenViolations > 0
      ? `${styleText('red', `Violations (${summary.reportedViolations.length} of ${summary.violations})`, COLOR_STREAM)}; ${styleText('yellow', 'run with --json for the full list', COLOR_STREAM)}:`
      : `${styleText('red', `Violations (${summary.violations})`, COLOR_STREAM)}:`;
    lines.push(heading);
    for (const entry of summary.reportedViolations) {
      lines.push(`  ${styleText('red', entry.header, COLOR_STREAM)}`);
      for (const block of entry.blocks) {
        if (block.label !== '') lines.push(`    ${styleText('red', block.label, COLOR_STREAM)}`);
        for (const line of block.lines) lines.push(line);
      }
      lines.push('');
    }
  }

  lines.push(`Elapsed ${summary.elapsed}`);
  return lines;
}

function renderSummary(summary: CheckSummary): string {
  return `${summaryLines(summary).join('\n')}\n`;
}

export function createCheckReporter(options: { readonly activity?: boolean } = {}): CheckReporter {
  const startedAt = performance.now();
  const interactive =
    options.activity !== false && process.stderr.isTTY === true && process.env.TERM !== 'dumb' && !process.env.CI;
  const spinner = ora({
    stream: process.stderr,
    isEnabled: interactive,
    hideCursor: true,
    discardStdin: false,
  });

  let rules: number | undefined;
  let sourcesTotal: number | undefined;
  let sourcesDone = 0;
  let decisionProgress: DecisionProgress | undefined;
  let decisionsDone = 0;
  let stopped = false;

  function activityLines(): string[] {
    if (rules === undefined) return ['Loading rules'];

    const lines = [`Loaded ${rules} rules`];
    if (sourcesTotal === undefined) {
      lines.push('Discovering source files');
    } else if (sourcesTotal === 0) {
      lines.push('No source files to match');
    } else {
      lines.push(progressLine('Matching sources', sourcesDone, sourcesTotal, stderrWidth()));
    }

    if (decisionProgress !== undefined) {
      lines.push(`Matching rules ${decisionProgress.matchingRules}, scopes ${decisionProgress.scopes}`);
      lines.push(
        decisionProgress.total === 0
          ? 'No decisions requested'
          : progressLine('Deciding', decisionsDone, decisionProgress.total, stderrWidth()),
      );
    }

    return lines;
  }

  function renderActivity(): string {
    const width = stderrWidth();
    return activityLines()
      .slice(0, MAXIMUM_ACTIVITY_LINES)
      .map((line) => fitAsciiLine(line, width))
      .join('\n');
  }

  if (interactive) spinner.start(renderActivity());

  function stopReporter(): void {
    if (stopped) return;
    stopped = true;
    spinner.stop();
  }

  return {
    rulesLoaded(total: number): void {
      rules = total;
      spinner.text = renderActivity();
    },

    sources(total: number): void {
      sourcesTotal = total;
      sourcesDone = 0;
      spinner.text = renderActivity();
    },

    sourceComplete(): void {
      sourcesDone++;
      spinner.text = renderActivity();
    },

    decisions(info: DecisionProgress): void {
      decisionProgress = info;
      decisionsDone = 0;
      spinner.text = renderActivity();
    },

    decisionComplete(): void {
      decisionsDone++;
      spinner.text = renderActivity();
    },

    finish(results: readonly CheckedRule[]): void {
      const summary = summarize(results, performance.now() - startedAt);
      stopReporter();
      process.stdout.write(renderSummary(summary));
    },

    stop: stopReporter,
  };
}
