import { Buffer } from 'node:buffer';

import type { LoadedRule, RuleReport, RunEvent } from '../../app/ports.js';
import type { JsonValue, ScopeSubject, Subject } from '../../app/rule.js';

const MAX_VIOLATIONS = 10;
const MAX_SOURCE_LINES = 5;
const MAX_GROUP_MEMBERS = 5;
const REDACTED = '[REDACTED]';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export type TextWriter = (text: string) => void;
export type TextRedactor = (text: string) => string;
export type RuleHeadings = (name: string) => readonly string[];

export function escapeText(text: string): string {
  return text.replace(
    CONTROL_CHARACTERS,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
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
  const ordered = [...needles]
    .filter(needle => needle !== '')
    .sort((left, right) => right.length - left.length);
  if (ordered.length === 0) return text => text;
  return text => {
    let redacted = text;
    for (const needle of ordered) redacted = redacted.replaceAll(needle, REDACTED);
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

function excerptLines(subject: ScopeSubject<JsonValue>, limit: number): readonly string[] {
  const lines = sourceLines(subject.source);
  const shown = lines.slice(0, limit);
  const start = subject.lines?.start ?? 1;
  const rendered = shown.map(
    (line, index) => `    ${start + index} | ${escapeText(line)}`,
  );
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    rendered.push(
      `    ... ${hidden} more ${hidden === 1 ? 'line' : 'lines'}; rerun with --json for the complete source.`,
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

export function createWalkthroughRenderer(
  write: TextWriter,
  headings: RuleHeadings,
  redact: TextRedactor,
): (event: RunEvent) => void {
  return event => {
    write(`${redact(walkthroughLines(event, headings).join('\n'))}\n`);
  };
}

function walkthroughLines(event: RunEvent, headings: RuleHeadings): readonly string[] {
  switch (event.type) {
    case 'rule':
      return [`rule ${escapeText(event.name)}`, ...headings(event.name)];
    case 'gate':
      return [
        event.enabled
          ? `gate: ${event.applies ? 'applies' : `skipped${reasonSuffix(event.reason)}`}`
          : 'gate: disabled',
      ];
    case 'file':
      return [
        `file ${escapeText(event.name)} ${escapeText(event.filepath)}: ${
          event.selected ? 'selected' : 'excluded'
        }${reasonSuffix(event.reason)}`,
      ];
    case 'scope':
      return [
        `scope ${escapeText(event.name)} ${subjectLabel(event.subject)}: ${
          event.accepted ? 'accepted' : 'filtered'
        }${reasonSuffix(event.reason)}`,
        ...excerptLines(event.subject, Number.POSITIVE_INFINITY),
      ];
    case 'group':
      return [
        `group ${escapeText(event.name)} ${event.subject.group.type} ${escapeText(
          event.subject.group.path,
        )} (${event.subject.members.length} members)`,
        ...event.subject.members.map(
          member => `  ${escapeText(member.filepath)} ${escapeText(member.id)}`,
        ),
      ];
    case 'request':
      return [
        `request ${escapeText(event.name)} ${subjectLabel(event.subject)}:`,
        `  ${escapeText(event.body)}`,
      ];
    case 'response':
      return [
        `response ${escapeText(event.name)} ${subjectLabel(event.subject)} HTTP ${event.status}:`,
        `  ${escapeText(event.body)}`,
      ];
    case 'result': {
      const outcome: string[] = [event.result.status];
      if (event.result.message !== undefined) outcome.push(escapeText(event.result.message));
      if (event.result.probability !== undefined) outcome.push(`probability=${String(event.result.probability)}`);
      if (event.result.model !== undefined) outcome.push(`model=${escapeText(event.result.model)}`);
      return [`result ${escapeText(event.name)} ${subjectLabel(event.subject)}: ${outcome.join(' ')}`];
    }
    case 'trace': {
      const details = event.details;
      const summary = `trace ${escapeText(event.name)} ${escapeText(event.message)}`;
      return details === undefined
        ? [summary]
        : [summary, `  ${escapeText(JSON.stringify(details) ?? String(details))}`];
    }
    case 'error':
      return [
        `error${event.name === undefined ? '' : ` ${escapeText(event.name)}`} ${escapeText(
          event.stage,
        )}: ${escapeText(event.message)}`,
      ];
  }
}

export interface InspectRenderer {
  readonly emit: (event: RunEvent) => void;
  readonly finish: (reports: readonly RuleReport[]) => void;
}

export interface InspectOptions {
  readonly write: TextWriter;
  readonly headings: RuleHeadings;
  readonly redact: TextRedactor;
}

export function createInspectRenderer(options: InspectOptions): InspectRenderer {
  const render = createWalkthroughRenderer(options.write, options.headings, options.redact);
  const gateExplained = new Set<string>();
  let finished = false;

  return {
    emit: event => {
      const skippedGate = event.type === 'gate' && (!event.enabled || !event.applies);
      if (skippedGate) gateExplained.add(event.name);
      render(event);
    },

    finish: reports => {
      if (finished) return;
      finished = true;
      for (const report of reports) {
        if (report.status !== 'skipped' || report.evaluations.length > 0) continue;
        if (gateExplained.has(report.name)) continue;
        options.write(
          options.redact(
            `${escapeText(report.name)}: skipped${reasonSuffix(
              report.reason ?? 'no matching subjects',
            )}\n`,
          ),
        );
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

export function renderCheckJson(reports: readonly RuleReport[]): string {
  return `${JSON.stringify(reports, null, 2)}\n`;
}

export function renderCheckSummary(reports: readonly RuleReport[], redact: TextRedactor): string {
  const skipped = reports.filter(report => report.status === 'skipped');
  const verifications = reports.reduce((total, report) => total + report.evaluations.length, 0);
  const lines = [
    `Rules: ${reports.length}  Skipped: ${skipped.length}  Verifications: ${verifications}  Violations: ${countViolations(reports)}`,
    '',
  ];

  if (skipped.length > 0) {
    lines.push('Skipped:');
    for (const report of skipped) {
      lines.push(`  ${escapeText(report.name)}: ${escapeText(report.reason ?? 'skipped')}`);
    }
    lines.push('');
  }

  const entries: { readonly name: string; readonly subject: Subject<JsonValue>; readonly message: string }[] =
    [];
  for (const report of reports) {
    for (const evaluation of report.evaluations) {
      if (evaluation.result.status !== 'violation') continue;
      entries.push({
        name: report.name,
        subject: evaluation.subject,
        message: evaluation.result.message ?? `Rule "${report.name}" was violated`,
      });
    }
  }

  if (entries.length > 0) {
    lines.push('Violations:');
    for (const entry of entries.slice(0, MAX_VIOLATIONS)) {
      const subject = entry.subject;
      if (subject.kind === 'group') {
        lines.push(
          `  ${escapeText(entry.name)}: group ${subject.group.type} ${escapeText(
            subject.group.path,
          )} (${subject.members.length} members) - ${escapeText(entry.message)}`,
        );
        const members = subject.members.slice(0, MAX_GROUP_MEMBERS);
        for (const member of members) {
          lines.push(
            `    ${escapeText(member.filepath)}${
              member.lines === undefined ? '' : `:${member.lines.start}-${member.lines.end}`
            } ${escapeText(member.id)}`,
          );
          lines.push(...excerptLines(member, MAX_SOURCE_LINES));
        }
        const hiddenMembers = subject.members.length - members.length;
        if (hiddenMembers > 0) {
          lines.push(
            `    ... ${hiddenMembers} more ${hiddenMembers === 1 ? 'member' : 'members'}; rerun with --json for the complete report.`,
          );
        }
        continue;
      }
      const location = `${escapeText(subject.filepath)}${
        subject.lines === undefined ? '' : `:${subject.lines.start}-${subject.lines.end}`
      }`;
      lines.push(`  ${escapeText(entry.name)}: ${location} - ${escapeText(entry.message)}`);
      lines.push(...excerptLines(subject, MAX_SOURCE_LINES));
    }
    if (entries.length > MAX_VIOLATIONS) {
      lines.push(
        `  ${entries.length - MAX_VIOLATIONS} more violations; rerun with --json for the complete report.`,
      );
    }
    lines.push('');
  }

  if (verifications === 0) lines.push('No verifications were run.');
  return redact(`${lines.join('\n')}\n`);
}
