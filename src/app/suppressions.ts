import { matchesGlob } from 'node:path';

import type { CheckResult, LineRange, Subject, ViolationLocation } from './rule.js';

export interface SuppressionEntry {
  readonly files: readonly string[];
  readonly scope?: string;
  readonly lines?: LineRange;
  readonly reason: string;
}

export type SuppressionConfig = ReadonlyMap<string, readonly SuppressionEntry[]>;

export interface SuppressedLocation {
  readonly location: ViolationLocation;
  readonly reason: string;
}

export type EvaluationResult =
  | (CheckResult & { readonly suppressedLocations?: readonly SuppressedLocation[] })
  | (Omit<CheckResult, 'status' | 'locations'> & {
      readonly status: 'suppressed';
      readonly locations?: never;
      readonly suppressedLocations: readonly SuppressedLocation[];
    });

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(at: string, detail: string): never {
  throw new Error(`${at} ${detail}`);
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) invalid(`${at} field "${field}"`, 'is not allowed');
  }
}

function parseLines(value: unknown, at: string): LineRange {
  if (!isMapping(value)) invalid(`${at} field "lines"`, 'must be a mapping');
  rejectUnknownFields(value, ['start', 'end'], `${at} field "lines"`);
  const start = value['start'];
  const end = value['end'];
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1) {
    invalid(`${at} field "lines.start"`, 'must be a positive safe integer');
  }
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < 1) {
    invalid(`${at} field "lines.end"`, 'must be a positive safe integer');
  }
  if (start > end) invalid(`${at} field "lines"`, 'must have start <= end');
  return { start, end };
}

function parseEntry(value: unknown, ruleName: string, index: number): SuppressionEntry {
  const at = `rule "${ruleName}" entry ${index + 1}`;
  if (!isMapping(value)) invalid(at, 'must be a mapping');
  rejectUnknownFields(value, ['files', 'scope', 'lines', 'reason'], at);

  const rawFiles = value['files'];
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    invalid(`${at} field "files"`, 'must be a nonempty array of nonblank strings');
  }
  const files: string[] = [];
  for (let fileIndex = 0; fileIndex < rawFiles.length; fileIndex += 1) {
    const file = rawFiles[fileIndex];
    if (typeof file !== 'string' || file.trim() === '') {
      invalid(`${at} field "files[${fileIndex}]"`, 'must be a nonblank string');
    }
    files.push(file);
  }

  const reason = value['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') {
    invalid(`${at} field "reason"`, 'must be a nonblank string');
  }

  const hasScope = Object.hasOwn(value, 'scope');
  const hasLines = Object.hasOwn(value, 'lines');
  if (hasScope && hasLines) invalid(at, 'must not define both "scope" and "lines"');
  if (hasScope) {
    const scope = value['scope'];
    if (typeof scope !== 'string' || scope.length === 0) {
      invalid(`${at} field "scope"`, 'must be a nonempty string');
    }
    return { files, scope, reason };
  }
  if (hasLines) return { files, lines: parseLines(value['lines'], at), reason };
  return { files, reason };
}

export function parseSuppressionConfig(value: unknown): SuppressionConfig {
  if (!isMapping(value)) invalid('suppression configuration', 'must be a mapping');
  rejectUnknownFields(value, ['suppressions'], 'suppression configuration');
  const rawSuppressions = value['suppressions'];
  if (!isMapping(rawSuppressions)) invalid('field "suppressions"', 'must be a mapping');

  const config = new Map<string, readonly SuppressionEntry[]>();
  for (const [ruleName, rawEntries] of Object.entries(rawSuppressions)) {
    if (ruleName.trim() === '') invalid('rule name', 'must be nonblank');
    if (!Array.isArray(rawEntries)) invalid(`rule "${ruleName}"`, 'must contain an array of entries');
    const entries: SuppressionEntry[] = [];
    for (let index = 0; index < rawEntries.length; index += 1) {
      if (!Object.hasOwn(rawEntries, index)) invalid(`rule "${ruleName}" entry ${index + 1}`, 'must be a mapping');
      entries.push(parseEntry(rawEntries[index], ruleName, index));
    }
    config.set(ruleName, entries);
  }
  return config;
}

function contains(outer: LineRange, inner: LineRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function scopeIdForLocation(location: ViolationLocation, subject: Subject<unknown>): string | undefined {
  if (location.scopeId !== undefined) return location.scopeId;
  if (location.lines === undefined) return undefined;

  if (subject.kind === 'scope') {
    return subject.filepath === location.filepath ? subject.id : undefined;
  }

  const containingMembers = subject.members.filter(member =>
    member.filepath === location.filepath && member.lines !== undefined && contains(member.lines, location.lines!),
  );
  return containingMembers.length === 1 ? containingMembers[0]!.id : undefined;
}

function matchesEntry(
  entry: SuppressionEntry,
  location: ViolationLocation,
  scopeId: string | undefined,
): boolean {
  if (!entry.files.some(pattern => matchesGlob(location.filepath, pattern))) return false;
  if (entry.scope !== undefined) return scopeId === entry.scope;
  if (entry.lines !== undefined) return location.lines !== undefined && contains(entry.lines, location.lines);
  return true;
}

function reasonForLocation(
  entries: readonly SuppressionEntry[],
  location: ViolationLocation,
  scopeId: string | undefined,
): string | undefined {
  for (const entry of entries) {
    if (matchesEntry(entry, location, scopeId)) return entry.reason;
  }
  return undefined;
}

function subjectLocations(subject: Subject<unknown>): readonly ViolationLocation[] {
  const members = subject.kind === 'scope' ? [subject] : subject.members;
  return members.map(({ filepath, id, lines }) => ({
    filepath,
    scopeId: id,
    ...(lines === undefined ? {} : { lines }),
  }));
}

export function applySuppressions(
  config: SuppressionConfig,
  ruleName: string,
  subject: Subject<unknown>,
  result: CheckResult,
): EvaluationResult {
  if (result.status !== 'violation') return result;
  const entries = config.get(ruleName);
  if (entries === undefined || entries.length === 0) return result;

  if (result.locations === undefined || result.locations.length === 0) {
    const targets = subjectLocations(subject);
    if (targets.length === 0) return result;
    const suppressedLocations: SuppressedLocation[] = [];
    for (const location of targets) {
      const reason = reasonForLocation(entries, location, location.scopeId);
      if (reason === undefined) return result;
      suppressedLocations.push({ location, reason });
    }
    const { locations: _locations, ...withoutLocations } = result;
    return { ...withoutLocations, status: 'suppressed', suppressedLocations };
  }

  const active: ViolationLocation[] = [];
  const suppressedLocations: SuppressedLocation[] = [];
  for (const location of result.locations) {
    const scopeId = scopeIdForLocation(location, subject);
    const reason = reasonForLocation(entries, location, scopeId);
    if (reason === undefined) active.push(location);
    else suppressedLocations.push({ location, reason });
  }
  if (suppressedLocations.length === 0) return result;
  if (active.length === 0) {
    const { locations: _locations, ...withoutLocations } = result;
    return { ...withoutLocations, status: 'suppressed', suppressedLocations };
  }
  return { ...result, locations: active, suppressedLocations };
}
