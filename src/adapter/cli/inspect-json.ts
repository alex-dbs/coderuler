import type { RuleReport, RunEvent } from '../../app/ports.js';
import type { CheckResult, GroupSubject, JsonValue, ScopeSubject, Subject } from '../../app/rule.js';
import type { InspectRenderer, TextRedactor, TextWriter } from './reports.js';

interface InspectJsonOptions {
  readonly write: TextWriter;
  readonly redact: TextRedactor;
  readonly format: 'json' | 'jsonl';
}

function redactRecord<T>(
  value: Readonly<Record<string, T>>,
  redact: TextRedactor,
  sanitize: (value: T) => T,
): Record<string, T> {
  const output = Object.create(null) as Record<string, T>;
  for (const [key, entry] of Object.entries(value)) {
    const redacted = redact(key);
    let unique = redacted;
    let suffix = 2;
    while (Object.hasOwn(output, unique)) unique = `${redacted}#${suffix++}`;
    output[unique] = sanitize(entry);
  }
  return output;
}

function redactJson(value: JsonValue, redact: TextRedactor): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(entry => redactJson(entry, redact));
  return redactRecord(value as Readonly<Record<string, JsonValue>>, redact, entry => redactJson(entry, redact));
}

function redactScope(subject: ScopeSubject, redact: TextRedactor): ScopeSubject {
  return {
    ...subject,
    filepath: redact(subject.filepath),
    id: redact(subject.id),
    source: redact(subject.source),
    ...(subject.lines === undefined ? {} : { lines: { ...subject.lines } }),
    ...(subject.data === undefined ? {} : { data: redactJson(subject.data, redact) }),
    ...(subject.captures === undefined ? {} : {
      captures: redactRecord(subject.captures, redact, value =>
        typeof value === 'string' ? redact(value) : value.map(redact)),
    }),
  };
}

function redactGroup(subject: GroupSubject, redact: TextRedactor): GroupSubject {
  return {
    ...subject,
    group: { ...subject.group, path: redact(subject.group.path) },
    members: subject.members.map(member => redactScope(member, redact)),
  };
}

function redactSubject(subject: Subject, redact: TextRedactor): Subject {
  return subject.kind === 'scope' ? redactScope(subject, redact) : redactGroup(subject, redact);
}

function redactResult(result: CheckResult, redact: TextRedactor): CheckResult {
  return {
    ...result,
    ...(result.message === undefined ? {} : { message: redact(result.message) }),
    ...(result.model === undefined ? {} : { model: redact(result.model) }),
  };
}

function redactReport(report: RuleReport, redact: TextRedactor): RuleReport {
  return {
    ...report,
    name: redact(report.name),
    ruleFile: redact(report.ruleFile),
    ...(report.reason === undefined ? {} : { reason: redact(report.reason) }),
    evaluations: report.evaluations.map(evaluation => ({
      subject: redactSubject(evaluation.subject, redact),
      result: redactResult(evaluation.result, redact),
    })),
  };
}

function redactEvent(event: RunEvent, redact: TextRedactor): RunEvent {
  switch (event.type) {
    case 'progress':
      return { ...event };
    case 'rule':
      return { ...event, name: redact(event.name), ruleFile: redact(event.ruleFile) };
    case 'gate':
    case 'file':
      return {
        ...event,
        name: redact(event.name),
        ...('filepath' in event ? { filepath: redact(event.filepath) } : {}),
        ...(event.reason === undefined ? {} : { reason: redact(event.reason) }),
      };
    case 'scope':
      return {
        ...event,
        name: redact(event.name),
        subject: redactScope(event.subject, redact),
        ...(event.reason === undefined ? {} : { reason: redact(event.reason) }),
      };
    case 'group':
      return { ...event, name: redact(event.name), subject: redactGroup(event.subject, redact) };
    case 'evaluation':
      return { ...event, name: redact(event.name), subject: redactSubject(event.subject, redact) };
    case 'request':
    case 'response':
      return { ...event, name: redact(event.name), subject: redactSubject(event.subject, redact), body: redact(event.body) };
    case 'result':
      return {
        ...event,
        name: redact(event.name),
        subject: redactSubject(event.subject, redact),
        result: redactResult(event.result, redact),
      };
    case 'trace':
      return {
        ...event,
        name: redact(event.name),
        message: redact(event.message),
        ...(event.details === undefined ? {} : { details: redactJson(event.details, redact) }),
      };
    case 'error':
      return {
        ...event,
        ...(event.name === undefined ? {} : { name: redact(event.name) }),
        stage: redact(event.stage),
        message: redact(event.message),
      };
  }
}

export function createInspectJsonRenderer(options: InspectJsonOptions): InspectRenderer {
  const events: RunEvent[] = [];
  let finished = false;
  const record = (value: unknown): void => options.write(`${JSON.stringify(value)}\n`);

  return {
    emit: event => {
      if (finished) return;
      const snapshot = redactEvent(event, options.redact);
      if (options.format === 'jsonl') record({ type: 'event', event: snapshot });
      else events.push(snapshot);
    },
    finish: (reports: readonly RuleReport[], error?: string) => {
      if (finished) return;
      finished = true;
      if (options.format === 'jsonl') {
        if (error !== undefined) record({ type: 'error', message: options.redact(error) });
        else for (const report of reports) record({ type: 'report', report: redactReport(report, options.redact) });
      } else {
        options.write(`${JSON.stringify({
          events,
          reports: error === undefined ? reports.map(report => redactReport(report, options.redact)) : [],
          ...(error === undefined ? {} : { error: options.redact(error) }),
        }, null, 2)}\n`);
      }
    },
  };
}
