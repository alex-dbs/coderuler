import { styleText, stripVTControlCharacters } from 'node:util';

import type { DecisionContext, GroupedContext } from '../../app/decision/group.ts';
import type { InspectionEvent, InspectionFile, InspectionObserver } from '../../app/inspect-result.ts';
import type { Context, DecisionGrouping } from '../../app/rule/types.ts';
import type { LineSpan } from '../../app/scope/types.ts';

export type InspectionReporter = InspectionObserver & {
  readonly failed: (error: unknown) => void;
};

const COLOR = { stream: process.stdout } as const;

const FIELD_WIDTH = 15;

const SCOPE_STATUS_WIDTH = 9;

const INDENT = '   ';

const DETAIL_INDENT = '     ';

const MEMBER_INDENT = '       ';

const BODY_INDENT = '       ';

const FIELD_PADDING = ' '.repeat(FIELD_WIDTH);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

const MESSAGE_BREAKS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const HIGH_CONTROL_CHARACTERS = /[\u007f-\u009f]/g;

function text(value: string): string {
  return stripVTControlCharacters(value).replace(CONTROL_CHARACTERS, '');
}

function escaped(value: string): string {
  return value.replace(
    HIGH_CONTROL_CHARACTERS,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function messageLines(message: string): string[] {
  return stripVTControlCharacters(message)
    .replace(MESSAGE_BREAKS, ' ')
    .split('\n')
    .map(line => line.trimEnd());
}

function heading(label: string): string {
  return styleText(['bold', 'cyan'], label, COLOR);
}

function bold(value: string): string {
  return styleText('bold', value, COLOR);
}

function dim(value: string): string {
  return styleText('dim', value, COLOR);
}

function green(value: string): string {
  return styleText('green', value, COLOR);
}

function red(value: string): string {
  return styleText('red', value, COLOR);
}

function yellow(value: string): string {
  return styleText('yellow', value, COLOR);
}

function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? '' : 's'}`;
}

function field(label: string, value: string, indent: string = INDENT): string {
  return `${indent}${bold(label.padEnd(FIELD_WIDTH))}${value}`;
}

function fieldBlock(label: string, values: readonly string[], indent: string = INDENT): string[] {
  const lines = values.length === 0 ? [''] : values;
  return lines.map(
    (value, index) => `${indent}${index === 0 ? bold(label.padEnd(FIELD_WIDTH)) : FIELD_PADDING}${value}`,
  );
}

function groupingLabel(grouping: DecisionGrouping): string {
  if (grouping.group_by === 'folder') {
    return grouping.level === undefined ? 'per folder' : `per folder, level ${grouping.level}`;
  }
  return `per ${grouping.group_by}`;
}

function location(filepath: string, id: string, lines: LineSpan | undefined): string {
  const path = text(filepath);
  const where = lines === undefined ? path : `${path}:${lines.start}-${lines.end}`;
  return `${where}  scope id ${text(id)}`;
}

function prettyBody(body: string): string {
  if (body === '') return '(empty body)';
  try {
    return escaped(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    return escaped(JSON.stringify(body));
  }
}

function bodyLines(body: string): string[] {
  return prettyBody(body)
    .split('\n')
    .map(line => `${BODY_INDENT}${line}`);
}

function groupDescriptor(context: GroupedContext): string {
  if (context.group.type === 'project') return 'per project, the whole folder';
  return `per ${context.group.type} ${text(context.group.path)}`;
}

function contextLines(context: DecisionContext): string[] {
  if (!('group' in context)) {
    return [
      field('Context', `scope ${location(context.filepath, context.scope.id, context.scope.lines)}`, DETAIL_INDENT),
      field('Members', '1 scope', DETAIL_INDENT),
    ];
  }

  const members = context.files.reduce((total, file) => total + file.scopes.length, 0);
  const lines = [
    field('Context', `group ${groupDescriptor(context)}`, DETAIL_INDENT),
    field('Members', `${count(members, 'scope')} in ${count(context.files.length, 'file')}`, DETAIL_INDENT),
  ];
  for (const file of context.files) {
    lines.push(`${MEMBER_INDENT}${bold(text(file.filepath))}`);
    for (const scope of file.scopes) {
      lines.push(`${MEMBER_INDENT}  ${location(file.filepath, scope.id, scope.lines)}`);
    }
  }
  return lines;
}

function consideredScopes(file: InspectionFile): readonly Context[] {
  return file.selected.length > 0 ? file.selected : [...file.accepted, ...file.filtered];
}

function statusWord(status: 'kept' | 'filtered' | 'selected'): string {
  const label = status.padEnd(SCOPE_STATUS_WIDTH);
  if (status === 'kept') return green(label);
  if (status === 'filtered') return yellow(label);
  return dim(label);
}

interface FileBlock {
  readonly lines: readonly string[];
  readonly scopes: number;
  readonly kept: number;
  readonly filtered: number;
}

function fileBlock(file: InspectionFile): FileBlock {
  const considered = consideredScopes(file);
  const accepted = new Set(file.accepted);
  const rejected = new Set(file.filtered);
  const scopeLines: string[] = [];
  let kept = 0;
  let filtered = 0;

  for (const context of considered) {
    const isKept = accepted.has(context);
    const isFiltered = !isKept && rejected.has(context);
    const status = isKept ? 'kept' : isFiltered ? 'filtered' : 'selected';
    if (isKept) kept++;
    else if (isFiltered) filtered++;
    scopeLines.push(
      `${DETAIL_INDENT}${statusWord(status)}${location(context.filepath, context.scope.id, context.scope.lines)}`,
    );
  }

  const status =
    considered.length === 0
      ? dim('no scope matches')
      : filtered === 0
        ? green('all scopes kept')
        : kept === 0
          ? yellow('fully filtered')
          : yellow('partially filtered');
  const counts =
    considered.length === 0
      ? ''
      : `  (${count(considered.length, 'scope')}: ${kept} kept, ${filtered} filtered)`;

  return {
    lines: [`${INDENT}${bold(text(file.filepath))}  ${status}${counts}`, ...scopeLines],
    scopes: considered.length,
    kept,
    filtered,
  };
}

function zeroReason(eligibleFiles: number, scopes: number, kept: number): string | undefined {
  if (eligibleFiles === 0) return "no file under the working root matched the rule's files.included patterns";
  if (scopes === 0) return `none of the ${count(eligibleFiles, 'eligible file')} matched a scope`;
  if (kept === 0) return `the rule filter removed all ${count(scopes, 'selected scope')}`;
  return undefined;
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function createInspectionReporter(): InspectionReporter {
  const startedAt = performance.now();
  let folder = '';
  let ruleFile = '';
  let ruleName = '';
  let ruleKind: 'AI' | 'regex' = 'AI';
  let enabled = true;
  let reason: string | undefined;
  let verificationHeadingWritten = false;
  let awaitingResponse = false;
  let rendered = false;
  let renderedFailure: string | undefined;

  function write(lines: readonly string[]): void {
    rendered = true;
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  function reportRule(event: Extract<InspectionEvent, { type: 'rule' }>): void {
    folder = text(event.cwd);
    ruleFile = text(event.ruleFile);
    ruleName = text(event.name);
    ruleKind = event.kind;
    enabled = event.enabled;
    const lines = [heading('Rulekeeper inspect'), '', heading('1. Rule'), field('File', ruleFile)];
    if (event.violationMessage !== undefined) {
      const message = text(event.violationMessage);
      if (message !== '') lines.push(field('Message', message));
    }
    lines.push(field('Name', ruleName));
    if (ruleKind === 'regex') lines.push(field('Kind', 'regex, matched locally without a decision backend'));
    if (!enabled) lines.push(field('Status', yellow('DISABLED')));
    lines.push(field('Grouping', groupingLabel(event.grouping)));
    if (ruleKind === 'regex') {
      lines.push(field('Pattern', escaped(JSON.stringify(event.rule))));
    } else {
      lines.push(...fieldBlock('Rule', event.rule.split('\n').map(line => text(line.trimEnd()))));
    }
    lines.push(field('Folder', folder), '');
    write(lines);
  }

  function reportSelection(event: Extract<InspectionEvent, { type: 'selection' }>): void {
    if (!enabled) {
      reason = 'the rule is disabled, so no source file was scanned';
      write([heading('2. Files'), field('Folder', folder), field('Note', reason), '']);
      return;
    }
    const blocks = event.files.map(fileBlock);
    const scopes = blocks.reduce((total, block) => total + block.scopes, 0);
    const kept = blocks.reduce((total, block) => total + block.kept, 0);
    const filtered = blocks.reduce((total, block) => total + block.filtered, 0);
    const matched = blocks.filter(block => block.scopes > 0).length;
    reason = zeroReason(event.files.length, scopes, kept);

    const lines = [
      heading('2. Files'),
      field('Folder', folder),
      field('Eligible', `${count(event.files.length, 'file')}, ${matched} with scopes`),
      field('Scopes', `${scopes} selected, ${kept} kept, ${filtered} filtered`),
    ];
    if (filtered > 0) {
      lines.push(field('Filter', 'filtered scopes are removed after scope selection and never decided'));
    }
    if (reason !== undefined) lines.push(field('Note', reason));
    lines.push('', ...blocks.flatMap(block => block.lines), '');
    write(lines);
  }

  function reportVerification(event: Extract<InspectionEvent, { type: 'verification' }>): void {
    const lines: string[] = [];
    if (verificationHeadingWritten) {
      lines.push('');
    } else {
      verificationHeadingWritten = true;
      lines.push(heading('3. Verifications'), '');
    }
    lines.push(`${INDENT}${bold(`Verification ${event.index} of ${event.total}`)}`);
    lines.push(...contextLines(event.context), '');
    awaitingResponse = false;
    write(lines);
  }

  function reportExchange(event: Extract<InspectionEvent, { type: 'exchange' }>): void {
    const { exchange } = event;
    if (exchange.type === 'request') {
      awaitingResponse = true;
      write([
        field('Request', 'serialized body sent to the backend, configured API key redacted', DETAIL_INDENT),
        ...bodyLines(exchange.body),
        '',
      ]);
      return;
    }
    awaitingResponse = false;
    write([field('Response', `HTTP ${exchange.status}, raw body as received`, DETAIL_INDENT), ...bodyLines(exchange.body), '']);
  }

  function reportRegex(event: Extract<InspectionEvent, { type: 'regex' }>): void {
    const inputs = event.inputs.map(
      input =>
        `${location(input.filepath, input.scopeId, undefined)}  ${escaped(JSON.stringify(input.value))}  ${input.matched ? green('match') : red('no match')}`,
    );
    write([
      field('Pattern', escaped(JSON.stringify(event.pattern)), DETAIL_INDENT),
      ...fieldBlock('Input', inputs, DETAIL_INDENT),
      field('Match', event.matched ? green('YES') : red('NO'), DETAIL_INDENT),
      '',
    ]);
  }

  function reportDecision(event: Extract<InspectionEvent, { type: 'decision' }>): void {
    const { decision } = event;
    const verdict = decision.follows ? green('PASS') : red('VIOLATION');
    const probability = `${decision.probability}`;
    write([field('Result', `${verdict}  probability ${probability}  model ${text(decision.model)}`, DETAIL_INDENT), '']);
  }

  function reportFailure(event: Extract<InspectionEvent, { type: 'failure' }>): void {
    renderedFailure = event.message;
    const lines = [`${DETAIL_INDENT}${bold('Result'.padEnd(FIELD_WIDTH))}${red('ERROR')}`];
    for (const line of messageLines(event.message)) lines.push(`${DETAIL_INDENT}${FIELD_PADDING}${line}`);
    if (awaitingResponse) {
      lines.push(`${DETAIL_INDENT}${FIELD_PADDING}${dim('no HTTP response was received for this request')}`);
    }
    awaitingResponse = false;
    write([...lines, '']);
  }

  function reportComplete(event: Extract<InspectionEvent, { type: 'complete' }>): void {
    const { summary } = event;
    const lines: string[] = [];
    if (!verificationHeadingWritten) {
      verificationHeadingWritten = true;
      lines.push(heading('3. Verifications'), field('Verifications', 'no verification ran'));
      if (reason !== undefined) lines.push(field('Reason', reason));
      lines.push('');
    }
    lines.push(heading('4. Summary'));
    if (summary.verifications === 0) {
      lines.push(field('Verdict', yellow(enabled ? 'NO VERIFICATION RAN' : 'DISABLED')));
      if (reason !== undefined) lines.push(field('Reason', reason));
    } else {
      lines.push(field('Verdict', summary.violations > 0 ? red('VIOLATION') : green('PASS')));
      lines.push(
        field(
          'Verifications',
          `${summary.verifications} ran: ${green(`${summary.passed} PASS`)}, ${red(`${summary.violations} ${summary.violations === 1 ? 'VIOLATION' : 'VIOLATIONS'}`)}`,
        ),
      );
    }
    lines.push(field('Rule', `${ruleName} (${ruleFile})`));
    lines.push(field('Files', enabled
      ? `${count(summary.eligibleFiles, 'file')} eligible, ${summary.matchedFiles} with scopes`
      : 'no source file was scanned'));
    lines.push(
      field(
        'Scopes',
        `${summary.selectedScopes} selected, ${summary.selectedScopes - summary.filteredScopes} kept, ${summary.filteredScopes} filtered`,
      ),
    );
    lines.push(field('Elapsed', formatElapsed(performance.now() - startedAt)));
    if (ruleKind === 'regex') {
      lines.push(field('Evaluator', 'regex, matched locally'));
    } else if (summary.verifications === 0) {
      lines.push(field('Note', 'no request was sent to the decision backend, so no API key or backend configuration was needed'));
    }
    write(lines);
  }

  function handle(event: InspectionEvent): void {
    switch (event.type) {
      case 'rule':
        reportRule(event);
        break;
      case 'selection':
        reportSelection(event);
        break;
      case 'verification':
        reportVerification(event);
        break;
      case 'exchange':
        reportExchange(event);
        break;
      case 'regex':
        reportRegex(event);
        break;
      case 'decision':
        reportDecision(event);
        break;
      case 'failure':
        reportFailure(event);
        break;
      case 'complete':
        reportComplete(event);
        break;
    }
  }

  function failed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const shown = renderedFailure === message;
    renderedFailure = message;
    if (shown || !rendered) return;
    write([heading('Inspect failed'), ...messageLines(message).map(line => `${INDENT}${line}`), '']);
  }

  return Object.assign(handle, { failed });
}
