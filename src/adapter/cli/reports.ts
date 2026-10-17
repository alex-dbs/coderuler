import { Buffer } from 'node:buffer';
import { styleText } from 'node:util';

import { applyEdits, format, visit } from 'jsonc-parser';
import stringWidth from 'string-width';

import type { LoadedRule, RuleReport, RunEvent } from '../../app/ports.js';
import type { RuleTestResult } from '../../app/rule-tests.js';
import type { JsonValue, ScopeSubject, Subject } from '../../app/rule.js';

const MAX_VIOLATIONS = 10;
const MAX_SOURCE_LINES = 5;
const MAX_GROUP_MEMBERS = 5;
const REDACTED = '[REDACTED]';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const TAB_WIDTH = 4;
const GRAPHEMES = new Intl.Segmenter();
const STYLE_CLOSE: Readonly<Record<number, number>> = { 1: 22, 2: 22, 31: 39, 32: 39, 33: 39, 36: 39, 90: 39 };

type TextStyle = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'cyan' | 'gray';

function paint(text: string, style: TextStyle, color: boolean): string {
  return color ? styleText(style, text, { validateStream: false }) : text;
}

function sourceText(line: string): string {
  let tab = line.indexOf('\t');
  if (tab === -1) return escapeText(line);
  let rendered = '';
  let column = 0;
  let start = 0;
  while (tab !== -1) {
    const span = escapeText(line.slice(start, tab));
    rendered += span;
    column += stringWidth(span);
    const spaces = TAB_WIDTH - (column % TAB_WIDTH);
    rendered += ' '.repeat(spaces);
    column += spaces;
    start = tab + 1;
    tab = line.indexOf('\t', start);
  }
  return rendered + escapeText(line.slice(start));
}

export type TextWriter = (text: string) => void;
export type TextRedactor = (text: string) => string;
export type RuleHeadings = (name: string) => readonly string[];

export function escapeText(text: string): string {
  return text.replace(
    CONTROL_CHARACTERS,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function renderRuleTestHeading(ruleName: string, redact: TextRedactor, color: boolean): string {
  return `${paint(escapeText(redact(ruleName)), 'bold', color)}\n`;
}

export function renderRuleTestResult(
  result: RuleTestResult,
  redact: TextRedactor,
  color: boolean,
  lastInRule: boolean,
): string {
  const safe = (text: string): string => escapeText(redact(text));
  const matches = result.expected === result.actual;
  const label = paint(safe(matches ? 'PASS' : 'FAIL'), matches ? 'green' : 'red', color);
  const branch = paint(lastInRule ? '└─ ' : '├─ ', 'dim', color);
  const detail = matches
    ? ''
    : safe(` (expected ${result.expected}, actual ${result.actual})`);
  const duration = paint(safe(` (${formatDuration(result.durationMs)})`), 'dim', color);
  return `${branch}${label} ${safe(result.name)}${detail}${duration}\n`;
}

export function renderRuleTestSummary(
  passed: number,
  failed: number,
  durationMs: number,
  redact: TextRedactor,
  color: boolean,
): string {
  const safe = (text: string): string => escapeText(redact(text));
  const passing = paint(safe(`${passed} passed`), 'green', color);
  const failing = paint(safe(`${failed} failed`), failed === 0 ? 'dim' : 'red', color);
  return `${passing}, ${failing}${safe(`  Time: ${formatDuration(durationMs)}`)}\n`;
}

export function createRedactor(values: readonly (string | undefined)[]): TextRedactor {
  const needles = new Set<string>();
  for (const value of values) {
    if (value === undefined || value.trim() === '') continue;
    for (const candidate of [value, value.trim()]) {
      needles.add(candidate);
      needles.add(escapeText(candidate));
      needles.add(JSON.stringify(candidate).slice(1, -1));
    }
  }
  const replacements = [...needles]
    .filter(needle => needle !== '')
    .sort((left, right) => right.length - left.length)
    .map(needle => [needle, needle.replace(/[^\r\n]+/g, REDACTED)] as const);
  if (replacements.length === 0) return text => text;
  return text => {
    let redacted = text;
    for (const [needle, replacement] of replacements) {
      redacted = redacted.replaceAll(needle, replacement);
    }
    return redacted;
  };
}

function reasonSuffix(reason: string | undefined): string {
  return reason === undefined ? '' : ` (${escapeText(reason)})`;
}

function sourceLines(source: string): readonly string[] {
  const lines: string[] = [];
  let current = '';
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 10 || code === 13) {
      lines.push(current);
      current = '';
      if (code === 13 && source.charCodeAt(index + 1) === 10) index += 1;
    } else {
      current += source.charAt(index);
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function reportFlags(outputAll: boolean): string {
  return outputAll ? '--json --output-all or --jsonl --output-all' : '--json or --jsonl';
}

function excerptLines(
  subject: ScopeSubject<JsonValue>,
  limit: number,
  redact: TextRedactor,
  color = false,
  outputAll = false,
): readonly string[] {
  const lines = sourceLines(redact(subject.source));
  const shown = lines.slice(0, limit);
  const start = subject.lines?.start ?? 1;
  const width = String(start + Math.max(shown.length - 1, 0)).length;
  const rendered = shown.map(
    (line, index) =>
      `${paint(`    ${String(start + index).padStart(width)} |`, 'dim', color)} ${sourceText(line)}`,
  );
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    rendered.push(
      paint(
        `    ... ${hidden} more ${hidden === 1 ? 'line' : 'lines'}; rerun with ${reportFlags(outputAll)} for the complete source.`,
        'dim',
        color,
      ),
    );
  }
  return rendered;
}

function subjectLabel(subject: Subject<JsonValue>): string {
  return subject.kind === 'group'
    ? `group ${subject.group.type} ${escapeText(subject.group.path)}`
    : `${escapeText(subject.filepath)} ${escapeText(subject.id)}`;
}

export function createRuleHeadings(rules: readonly LoadedRule[]): RuleHeadings {
  const byName = new Map<string, LoadedRule>(rules.map(entry => [entry.name, entry] as const));
  return name => {
    const entry = byName.get(name);
    if (entry === undefined) return [];
    const fields: readonly (readonly [string, unknown])[] = [
      ['files', entry.rule.files],
      ['exclude', entry.rule.exclude],
      ['group', entry.rule.group],
      ['settings', entry.rule.settings],
    ];
    return [
      `  file: ${escapeText(entry.ruleFile)}`,
      ...fields.map(
        ([label, value]) => `  ${label}: ${escapeText(JSON.stringify(value) ?? String(value))}`,
      ),
    ];
  };
}

export function createMetadataRenderer(
  write: TextWriter,
  redact: TextRedactor,
): (event: RunEvent) => void {
  return event => {
    write(`${redact(metadataLine(event))}\n`);
  };
}

function metadataLine(event: RunEvent): string {
  switch (event.type) {
    case 'progress':
      return `progress ${event.phase} ${event.completed}/${event.total}`;
    case 'rule':
      return `rule ${escapeText(event.name)} ${escapeText(event.ruleFile)}`;
    case 'gate':
      return `gate ${escapeText(event.name)} enabled=${String(event.enabled)} applies=${String(
        event.applies,
      )}${reasonSuffix(event.reason)}`;
    case 'file':
      return `file ${escapeText(event.name)} ${escapeText(event.filepath)} ${
        event.selected ? 'selected' : 'excluded'
      }${reasonSuffix(event.reason)}`;
    case 'scope':
      return `scope ${escapeText(event.name)} ${subjectLabel(event.subject)} ${
        event.accepted ? 'accepted' : 'filtered'
      }${reasonSuffix(event.reason)}`;
    case 'group':
      return `group ${escapeText(event.name)} ${subjectLabel(event.subject)} members=${event.subject.members.length}`;
    case 'evaluation':
      return `evaluation ${event.evaluationId} ${escapeText(event.name)} ${subjectLabel(event.subject)}`;
    case 'request':
      return `request ${escapeText(event.name)} ${subjectLabel(event.subject)} ${Buffer.byteLength(
        event.body,
        'utf8',
      )} bytes`;
    case 'response':
      return `response ${escapeText(event.name)} ${subjectLabel(event.subject)} HTTP ${
        event.status
      } ${Buffer.byteLength(event.body, 'utf8')} bytes`;
    case 'result':
      return `result ${escapeText(event.name)} ${subjectLabel(event.subject)} ${event.result.status}`;
    case 'trace': {
      const summary = `trace ${escapeText(event.name)} ${escapeText(event.message)}`;
      const details = event.details;
      if (details === undefined) return summary;
      const shape =
        typeof details !== 'object' || details === null
          ? typeof details
          : Array.isArray(details)
            ? `array[${details.length}]`
            : Object.keys(details).join(',');
      return `${summary} details=${escapeText(shape)}`;
    }
    case 'error':
      return event.name === undefined
        ? `error stage=${escapeText(event.stage)} ${escapeText(event.message)}`
        : `error ${escapeText(event.name)} stage=${escapeText(event.stage)} ${escapeText(event.message)}`;
  }
}

function walkthroughText(
  value: string,
  redact: TextRedactor,
  color: boolean,
  style?: TextStyle,
): string {
  const text = escapeText(redact(value));
  return style === undefined ? text : paint(text, style, color);
}

function walkthroughField(
  label: string,
  value: string,
  redact: TextRedactor,
  color: boolean,
  style?: TextStyle,
): string {
  return `  ${label}: ${walkthroughText(value, redact, color, style)}`;
}

function walkthroughPayload(serialized: string, redact: TextRedactor, raw = false): readonly string[] {
  let formatted = redact(serialized);
  let valid = true;
  if (!raw) visit(formatted, { onError: () => { valid = false; } }, {
    disallowComments: true, allowTrailingComma: false, allowEmptyContent: false,
  });
  if (!raw && valid) {
    formatted = applyEdits(formatted, format(formatted, undefined, {
      insertSpaces: true, tabSize: 2, eol: '\n',
    }));
  }
  return redact(formatted).split('\n').map(line => `    ${escapeText(line)}`);
}

function walkthroughSubject(
  subject: Subject<JsonValue>,
  redact: TextRedactor,
  color: boolean,
): readonly string[] {
  if (subject.kind === 'group') {
    return [
      walkthroughField('group', subject.group.type, redact, color),
      walkthroughField('path', subject.group.path, redact, color, 'dim'),
    ];
  }
  const location = subject.lines === undefined
    ? subject.filepath
    : `${subject.filepath}:${subject.lines.start}-${subject.lines.end}`;
  return [
    walkthroughField('file', location, redact, color, 'dim'),
    walkthroughField('scope', subject.id, redact, color, 'cyan'),
  ];
}

function writeWalkthroughBlock(write: TextWriter, lines: readonly string[]): void {
  write(`${lines.join('\n')}\n\n`);
}

function wrapCardLine(line: string, width: number): readonly string[] {
  const styles: { readonly offset: number; readonly sequence: string; readonly code: number }[] = [];
  let text = '';
  let cursor = 0;
  for (const match of line.matchAll(/\u001b\[(\d+)m/g)) {
    text += line.slice(cursor, match.index);
    styles.push({ offset: text.length, sequence: match[0], code: Number(match[1]) });
    cursor = match.index + match[0].length;
  }
  text += line.slice(cursor);
  const active = new Set<number>();
  const rows: string[] = [];
  let row = '';
  let cells = 0;
  let styleIndex = 0;
  const appendStyle = (): void => {
    const style = styles[styleIndex++]!;
    row += style.sequence;
    if (STYLE_CLOSE[style.code] !== undefined) {
      if (STYLE_CLOSE[style.code] === 39) {
        for (const code of active) if (STYLE_CLOSE[code] === 39) active.delete(code);
      }
      active.add(style.code);
    } else {
      for (const code of active) if (STYLE_CLOSE[code] === style.code) active.delete(code);
    }
  };
  for (const { segment, index } of GRAPHEMES.segment(text)) {
    const size = stringWidth(segment);
    if (cells > 0 && cells + size > width) {
      rows.push(row + (active.size === 0 ? '' : '\u001b[0m'));
      row = [...active].map(code => `\u001b[${code}m`).join('');
      cells = 0;
    }
    const end = index + segment.length;
    let start = index;
    while (styleIndex < styles.length && styles[styleIndex]!.offset < end) {
      row += text.slice(start, styles[styleIndex]!.offset);
      start = styles[styleIndex]!.offset;
      appendStyle();
    }
    row += text.slice(start, end);
    cells += size;
  }
  while (styleIndex < styles.length) appendStyle();
  rows.push(row + (active.size === 0 ? '' : '\u001b[0m'));
  return rows;
}

export interface WalkthroughOptions {
  readonly write: TextWriter;
  readonly headings: RuleHeadings;
  readonly redact: TextRedactor;
  readonly color?: boolean;
  readonly raw?: boolean;
  readonly columns?: () => number;
  readonly concurrency?: number;
}

export interface WalkthroughRenderer {
  readonly emit: (event: RunEvent) => void;
  readonly finish: () => void;
}

interface EvaluationCard {
  readonly width: number;
  readonly lines: string[];
}

export function createWalkthroughRenderer(options: WalkthroughOptions): WalkthroughRenderer {
  const { write, headings, redact } = options;
  const raw = options.raw === true;
  const color = options.color === true && !raw;
  const buffered = (options.concurrency ?? 1) > 1;
  const cards = new Map<number, EvaluationCard>();
  const progress = new Map<Extract<RunEvent, { type: 'progress' }>['phase'], RunEvent>();
  const pending: RunEvent[] = [];
  let finished = false;

  const field = (label: string, value: string, style?: TextStyle): string =>
    walkthroughField(label, value, redact, color, style);
  const section = (card: EvaluationCard, title: string, lines: readonly string[]): readonly string[] => {
    const heading = `  ${title}`;
    if (raw) return ['', heading, ...lines];
    const remaining = card.width - 4 - stringWidth(heading) - 1;
    const divider = remaining > 0 ? ` ${paint('─'.repeat(remaining), 'dim', color)}` : '';
    return ['', paint(heading, 'bold', color) + divider, ...lines];
  };
  const columns = (): number => {
    const width = options.columns?.() ?? 80;
    return Number.isFinite(width) ? Math.max(8, Math.floor(width)) : 80;
  };
  const border = (card: EvaluationCard, top: boolean): string =>
    raw ? '' : `${top ? '╭' : '╰'}${'─'.repeat(card.width - 2)}${top ? '╮' : '╯'}\n`;
  const framed = (card: EvaluationCard, lines: readonly string[]): string =>
    raw ? `${lines.join('\n')}\n` : lines.flatMap(line => wrapCardLine(line, card.width - 4)).map(line =>
      `│ ${line}${' '.repeat(Math.max(0, card.width - 4 - stringWidth(line)))} │\n`,
    ).join('');
  const append = (card: EvaluationCard, lines: readonly string[]): void => {
    const text = framed(card, lines);
    if (buffered) card.lines.push(text);
    else write(text);
  };
  const standalone = (event: RunEvent): void => {
    writeWalkthroughBlock(write, walkthroughLines(event, headings, redact, color, raw));
  };
  const drain = (): void => {
    if (!buffered && cards.size > 0) return;
    for (const event of pending.splice(0)) standalone(event);
    for (const event of progress.values()) standalone(event);
    progress.clear();
  };
  const close = (id: number, incomplete = false): void => {
    const card = cards.get(id)!;
    if (incomplete) append(card, section(card, 'Incomplete', [`  ${field('status', 'incomplete', 'yellow')}`]));
    if (buffered) write(border(card, true) + card.lines.join('') + border(card, false) + '\n');
    else write(border(card, false) + '\n');
    cards.delete(id);
    drain();
  };
  const source = (subject: Subject<JsonValue>): readonly string[] =>
    subject.kind === 'scope'
      ? excerptLines(subject, Number.POSITIVE_INFINITY, redact, color)
      : subject.members.flatMap(member => [
        ...walkthroughSubject(member, redact, color),
        ...excerptLines(member, Number.POSITIVE_INFINITY, redact, color),
        '',
      ]);
  const nested = (card: EvaluationCard, event: RunEvent): readonly string[] => {
    switch (event.type) {
      case 'request':
        return section(card, 'Request', [
          paint('    body:', 'gray', color),
          ...walkthroughPayload(event.body, redact, raw).map(line => paint(`  ${line}`, 'gray', color)),
        ]);
      case 'response':
        return section(card, 'Response', [
          `  ${field('status', `HTTP ${event.status}`, event.status >= 400 ? 'red' : event.status >= 300 ? 'yellow' : 'green')}`,
          paint('    body:', 'gray', color),
          ...walkthroughPayload(event.body, redact, raw).map(line => paint(`  ${line}`, 'gray', color)),
        ]);
      case 'result':
        return section(card, 'Result', [
          `  ${field('status', event.result.status, event.result.status === 'pass' ? 'green' : 'red')}`,
          ...(event.result.message === undefined ? [] : [`  ${field('message', event.result.message)}`]),
          ...(event.result.probability === undefined ? [] : [`  ${field('probability', String(event.result.probability))}`]),
          ...(event.result.threshold === undefined ? [] : [`  ${field('threshold', String(event.result.threshold))}`]),
          ...(event.result.model === undefined ? [] : [`  ${field('model', event.result.model)}`]),
        ]);
      case 'trace':
        return section(card, 'Trace', [
          `  ${field('message', event.message)}`,
          ...(event.details === undefined ? [] : [
            '    details:', ...walkthroughPayload(JSON.stringify(event.details), redact, raw).map(line => `  ${line}`),
          ]),
        ]);
      case 'file':
        return section(card, 'File', [
          `  ${field('file', event.filepath, 'dim')}`,
          `  ${field('status', event.selected ? 'selected' : 'excluded', event.selected ? 'green' : 'yellow')}`,
          ...(event.reason === undefined ? [] : [`  ${field('reason', event.reason)}`]),
        ]);
      case 'error':
        return section(card, 'Error', [
          `  ${field('stage', event.stage)}`,
          `  ${field('message', event.message, 'red')}`,
        ]);
      default:
        throw new Error(`Unexpected evaluation event: ${event.type}`);
    }
  };

  return {
    emit: event => {
      if (finished) return;
      if ((event.type === 'scope' && event.accepted) || event.type === 'group') return;
      if (event.type === 'evaluation') {
        if (cards.has(event.evaluationId)) throw new Error(`Duplicate evaluation start: ${event.evaluationId}`);
        if (!buffered && cards.size > 0) throw new Error('Concurrent evaluations require buffered walkthrough rendering');
        const card: EvaluationCard = { width: columns(), lines: [] };
        cards.set(event.evaluationId, card);
        if (!buffered) write(border(card, true));
        append(card, [
          `${paint('evaluation', 'cyan', color)} ${walkthroughText(event.name, redact, color, 'bold')}`,
          ...walkthroughSubject(event.subject, redact, color),
          ...(event.subject.kind === 'group' ? [field('members', String(event.subject.members.length))] : []),
          ...section(card, 'Source', source(event.subject)),
        ]);
        return;
      }
      if ('evaluationId' in event && event.evaluationId !== undefined) {
        const card = cards.get(event.evaluationId);
        if (card === undefined) throw new Error(`Missing evaluation start: ${event.evaluationId}`);
        append(card, nested(card, event));
        if (event.type === 'result' || event.type === 'error') close(event.evaluationId);
        return;
      }
      if (event.type === 'request' || event.type === 'response' || event.type === 'result') {
        throw new Error(`Missing evaluation ID for ${event.type}`);
      }
      if (event.type === 'error' && cards.size > 0) {
        for (const id of cards.keys()) close(id, true);
        standalone(event);
        return;
      }
      if (!buffered && cards.size > 0) {
        if (event.type === 'progress') progress.set(event.phase, event);
        else pending.push(event);
        return;
      }
      standalone(event);
    },
    finish: () => {
      if (finished) return;
      finished = true;
      for (const id of cards.keys()) close(id, true);
      drain();
    },
  };
}

function walkthroughLines(
  event: RunEvent,
  headings: RuleHeadings,
  redact: TextRedactor,
  color: boolean,
  raw = false,
): readonly string[] {
  const header = (name: string | undefined, style: TextStyle = 'cyan'): string =>
    `${paint(event.type, style, color)}${name === undefined ? '' : ` ${walkthroughText(name, redact, color, 'bold')}`}`;
  const field = (label: string, value: string, style?: TextStyle): string =>
    walkthroughField(label, value, redact, color, style);
  const reason = (value: string | undefined): readonly string[] =>
    value === undefined ? [] : [field('reason', value)];
  switch (event.type) {
    case 'progress':
      return [paint(`  progress ${event.phase} ${event.completed}/${event.total}`, 'dim', color)];
    case 'rule': {
      const metadata = headings(event.name);
      return [
        header(event.name),
        ...(metadata.some(line => line.startsWith('  file: ')) ? [] : [field('file', event.ruleFile, 'dim')]),
        ...metadata.flatMap(line => {
          const match = /^  ([a-z]+): (.*)$/.exec(line);
          if (match === null) return [walkthroughText(line, redact, color)];
          const label = match[1]!;
          const value = match[2]!;
          return value.startsWith('{') || value.startsWith('[')
            ? [`  ${label}:`, ...walkthroughPayload(value, redact, raw)]
            : [field(label, value, label === 'file' ? 'dim' : undefined)];
        }),
      ];
    }
    case 'gate':
      return [
        header(event.name),
        field('status', event.enabled ? (event.applies ? 'applies' : 'skipped') : 'disabled',
          event.enabled && event.applies ? 'green' : 'yellow'),
        ...reason(event.reason),
      ];
    case 'file':
      return [
        header(event.name),
        field('file', event.filepath, 'dim'),
        field('status', event.selected ? 'selected' : 'excluded', event.selected ? 'green' : 'yellow'),
        ...reason(event.reason),
      ];
    case 'scope':
      return [
        header(event.name),
        ...walkthroughSubject(event.subject, redact, color),
        field('status', 'filtered', 'yellow'),
        ...reason(event.reason),
        '  source:', ...excerptLines(event.subject, Number.POSITIVE_INFINITY, redact, color),
      ];
    case 'trace':
      return [
        header(event.name),
        field('message', event.message),
        ...(event.details === undefined ? [] : [
          '  details:', ...walkthroughPayload(JSON.stringify(event.details), redact, raw),
        ]),
      ];
    case 'error':
      return [header(event.name, 'red'), field('stage', event.stage), field('message', event.message, 'red')];
    default:
      throw new Error(`Evaluation event rendered outside its card: ${event.type}`);
  }
}

export interface InspectRenderer {
  readonly emit: (event: RunEvent) => void;
  readonly finish: (reports: readonly RuleReport[], error?: string) => void;
}

export interface InspectOptions {
  readonly write: TextWriter;
  readonly headings: RuleHeadings;
  readonly redact: TextRedactor;
  readonly color?: boolean;
  readonly raw?: boolean;
  readonly columns?: () => number;
}

export function createInspectRenderer(options: InspectOptions): InspectRenderer {
  const render = createWalkthroughRenderer({ ...options, concurrency: 1 });
  const color = options.color === true && options.raw !== true;
  const gateExplained = new Set<string>();
  let finished = false;

  return {
    emit: event => {
      if (finished) return;
      const skippedGate = event.type === 'gate' && (!event.enabled || !event.applies);
      if (skippedGate) gateExplained.add(event.name);
      render.emit(event);
    },

    finish: reports => {
      if (finished) return;
      finished = true;
      render.finish();
      for (const report of reports) {
        if (report.status !== 'skipped' || report.evaluations.length > 0) continue;
        if (gateExplained.has(report.name)) continue;
        writeWalkthroughBlock(options.write, [
          `${paint('result', 'cyan', color)} ${walkthroughText(report.name, options.redact, color, 'bold')}`,
          walkthroughField('status', 'skipped', options.redact, color, 'yellow'),
          walkthroughField('reason', report.reason ?? 'no matching subjects', options.redact, color),
        ]);
      }
    },
  };
}

export function countViolations(reports: readonly RuleReport[]): number {
  let total = 0;
  for (const report of reports) {
    for (const evaluation of report.evaluations) {
      if (evaluation.result.status === 'violation') total += 1;
    }
  }
  return total;
}

export interface CheckReportOptions {
  readonly durationMs: number;
  readonly outputAll?: boolean;
  readonly color?: boolean;
}

function includedReports(reports: readonly RuleReport[], outputAll: boolean): readonly RuleReport[] {
  if (outputAll) return reports;
  const included: RuleReport[] = [];
  for (const report of reports) {
    if (report.status !== 'violation') continue;
    included.push({
      ...report,
      evaluations: report.evaluations.filter(evaluation => evaluation.result.status === 'violation'),
    });
  }
  return included;
}

export function renderCheckJson(reports: readonly RuleReport[], options: CheckReportOptions): string {
  return `${JSON.stringify({
    durationMs: options.durationMs,
    reports: includedReports(reports, options.outputAll === true),
  }, null, 2)}\n`;
}

export function renderCheckJsonl(reports: readonly RuleReport[], options: CheckReportOptions): string {
  let output = '';
  for (const report of includedReports(reports, options.outputAll === true)) {
    output += `${JSON.stringify({ type: 'rule', ...report })}\n`;
  }
  return output;
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 86_400_000) return `${(durationMs / 86_400_000).toFixed(2)}d`;
  if (durationMs >= 3_600_000) return `${(durationMs / 3_600_000).toFixed(2)}h`;
  if (durationMs >= 60_000) return `${(durationMs / 60_000).toFixed(2)}min`;
  if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(2)}s`;
  return `${durationMs.toFixed(2)}ms`;
}

export function renderCheckSummary(
  reports: readonly RuleReport[],
  redact: TextRedactor,
  options: CheckReportOptions,
): string {
  const color = options.color === true;
  const outputAll = options.outputAll === true;
  const safe = (text: string): string => escapeText(redact(text));
  const muted = (text: string): string => paint(text, 'dim', color);
  const name = (text: string): string => paint(safe(text), 'bold', color);
  const skipped = reports.filter(report => report.status === 'skipped');
  const verifications = reports.reduce((total, report) => total + report.evaluations.length, 0);
  const violations = countViolations(reports);
  const lines = [
    [
      `Rules: ${reports.length}`,
      paint(`Skipped: ${skipped.length}`, skipped.length > 0 ? 'yellow' : 'dim', color),
      `Verifications: ${verifications}`,
      paint(`Violations: ${violations}`, violations > 0 ? 'red' : 'green', color),
      `Time: ${formatDuration(options.durationMs)}`,
    ].join('  '),
    '',
  ];

  if (outputAll && skipped.length > 0) {
    lines.push(paint('Skipped:', 'yellow', color));
    for (const report of skipped) {
      lines.push(`  ${name(report.name)}: ${safe(report.reason ?? 'skipped')}`);
    }
    lines.push('');
  }

  const entries: {
    readonly name: string;
    readonly subject: Subject<JsonValue>;
    readonly message: string | undefined;
    readonly status: 'pass' | 'violation';
  }[] = [];
  for (const report of reports) {
    for (const evaluation of report.evaluations) {
      if (!outputAll && evaluation.result.status !== 'violation') continue;
      entries.push({
        name: report.name,
        subject: evaluation.subject,
        message: evaluation.result.message,
        status: evaluation.result.status,
      });
    }
  }

  if (entries.length > 0) {
    lines.push(outputAll ? 'Verifications:' : paint('🚓 Violations:', 'red', color));
    const shown = outputAll ? entries : entries.slice(0, MAX_VIOLATIONS);
    for (const entry of shown) {
      const subject = entry.subject;
      const prefix = entry.status === 'pass' ? `${paint('✓', 'green', color)} ` : '';
      const ruleName = `${prefix}${paint(
        name(entry.name), entry.status === 'violation' ? 'red' : 'green', color,
      )}`;
      if (subject.kind === 'group') {
        lines.push(
          `  ${ruleName}: ${muted(
            `group ${subject.group.type} ${safe(subject.group.path)} (${subject.members.length} members)`,
          )}`,
        );
        if (entry.message !== undefined) lines.push(`    ${safe(entry.message)}`);
        const members = subject.members.slice(0, MAX_GROUP_MEMBERS);
        for (const member of members) {
          lines.push(
            muted(
              `    ${safe(member.filepath)}${
                member.lines === undefined ? '' : `:${member.lines.start}-${member.lines.end}`
              } ${safe(member.id)}`,
            ),
          );
          lines.push(...excerptLines(member, MAX_SOURCE_LINES, redact, color, outputAll));
        }
        const hiddenMembers = subject.members.length - members.length;
        if (hiddenMembers > 0) {
          lines.push(
            muted(
              `    ... ${hiddenMembers} more ${hiddenMembers === 1 ? 'member' : 'members'}; rerun with ${reportFlags(outputAll)} for the complete report.`,
            ),
          );
        }
        continue;
      }
      const location = `${safe(subject.filepath)}${
        subject.lines === undefined ? '' : `:${subject.lines.start}-${subject.lines.end}`
      }`;
      lines.push(`  ${ruleName}: ${muted(location)}`);
      if (entry.message !== undefined) lines.push(`    ${safe(entry.message)}`);
      lines.push(...excerptLines(subject, MAX_SOURCE_LINES, redact, color, outputAll));
    }
    if (!outputAll && entries.length > MAX_VIOLATIONS) {
      lines.push(
        muted(`  ${entries.length - MAX_VIOLATIONS} more violations; rerun with ${reportFlags(false)} for the complete report.`),
      );
    }
    lines.push('');
  }

  if (verifications === 0) lines.push(paint('No verifications were run.', 'yellow', color));
  return `${lines.join('\n')}\n`;
}
