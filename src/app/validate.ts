import { RULE_BRAND } from './rule.js';
import type {
  AiUsage,
  CheckResult,
  JsonValue,
  PredicateResult,
  Rule,
  ScopeMatch,
  ScopeSubject,
  Subject,
  ViolationLocation,
} from './rule.js';

function invalid(label: string, detail: string): never {
  throw new Error(`${label}: ${detail}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isStringList(value: unknown, allowEmpty: boolean): boolean {
  if (!Array.isArray(value)) return false;
  if (!allowEmpty && value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
    const entry: unknown = value[index];
    if (typeof entry !== 'string' || entry.length === 0) return false;
  }
  return true;
}

function validateSettings(settings: Record<string, unknown>, at: string): void {
  const backend = settings['backend'];
  if (backend !== undefined && backend !== 'jev' && backend !== 'openai') {
    invalid(at, 'settings.backend must be "jev" or "openai"');
  }

  const model = settings['model'];
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    invalid(at, 'settings.model must be a non-blank string');
  }

  const threshold = settings['threshold'];
  if (
    threshold !== undefined &&
    (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)
  ) {
    invalid(at, 'settings.threshold must be a finite number between 0 and 1');
  }

  for (const key of ['inputCostPerMillion', 'outputCostPerMillion']) {
    const value = settings[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      invalid(at, `settings.${key} must be a finite nonnegative number`);
    }
  }
}

function isGrouping(value: unknown): boolean {
  if (value === 'scope' || value === 'file' || value === 'folder' || value === 'project') return true;
  if (!isRecord(value) || value['by'] !== 'folder') return false;
  const level = value['level'];
  return typeof level === 'number' && Number.isInteger(level) && level <= 0;
}

export function isRuleBranded(value: unknown): boolean {
  const target: unknown = typeof value === 'function' ? value.prototype : value;
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return false;
  return Reflect.get(target, RULE_BRAND) === true;
}

export function validateRule(value: unknown, ruleFile: string): Rule<unknown> {
  const at = `Invalid rule at ${ruleFile}`;
  if (!isRecord(value)) invalid(at, 'expected a rule object');

  if (typeof value['enabled'] !== 'boolean') invalid(at, 'enabled must be a boolean');
  if (!isStringList(value['files'], false)) {
    invalid(at, 'files must be a non-empty array of non-empty glob strings');
  }
  if (!isStringList(value['exclude'], true)) {
    invalid(at, 'exclude must be an array of non-empty glob strings');
  }
  const tags = value['tags'];
  if (tags !== undefined && !isStringList(tags, true)) {
    invalid(at, 'tags must be an array of non-empty strings');
  }

  const scope = value['scope'];
  if (scope !== undefined && typeof scope !== 'function') invalid(at, 'scope must be a function');

  const settings = value['settings'];
  if (!isRecord(settings)) invalid(at, 'settings must be an object');
  validateSettings(settings, at);

  const comment = value['comment'];
  if (comment !== undefined && (typeof comment !== 'string' || comment.trim() === '')) {
    invalid(at, 'comment must be a non-blank string');
  }

  if (!isGrouping(value['group'])) {
    invalid(at, 'group must be "scope", "file", "folder", "project", or { by: "folder", level: integer <= 0 }');
  }

  for (const hook of ['when', 'filter', 'select', 'check'] as const) {
    if (typeof value[hook] !== 'function') invalid(at, `${hook} must be a function`);
  }

  return value as unknown as Rule<unknown>;
}

export function validateJsonValue(value: unknown, label: string): JsonValue {
  assertJsonCompatible(value, label, new Set());
  return value as JsonValue;
}

function assertJsonCompatible(value: unknown, label: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(label, 'numbers must be finite');
    return;
  }
  if (typeof value !== 'object') {
    invalid(label, `expected JSON-compatible data, received ${typeof value}`);
  }

  const container: object = value;
  if (ancestors.has(container)) invalid(label, 'cyclic data is not supported');
  ancestors.add(container);

  if ('toJSON' in value && typeof value.toJSON === 'function') {
    invalid(label, 'expected plain JSON data without a toJSON serialization hook');
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) invalid(label, `arrays must not be sparse (missing index ${index})`);
      assertJsonCompatible(value[index], `${label}[${index}]`, ancestors);
    }
  } else if (!isRecord(value)) {
    invalid(label, 'expected a plain JSON object or array');
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      invalid(label, 'expected a plain JSON object or array');
    }
    for (const key of Object.keys(value)) assertJsonCompatible(value[key], `${label}.${key}`, ancestors);
  }

  ancestors.delete(container);
}

function plainCaptures(value: unknown, label: string): Readonly<Record<string, string | readonly string[]>> {
  if (!isRecord(value)) invalid(label, 'captures must be an object of strings or string arrays');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    invalid(label, 'captures must be a plain object of strings or string arrays');
  }
  const captures: Record<string, string | readonly string[]> = {};
  for (const key of Object.keys(value)) {
    const capture = value[key];
    const entry: unknown =
      typeof capture === 'string'
        ? capture
        : Array.isArray(capture) && isDenseStringArray(capture)
          ? [...capture]
          : undefined;
    if (entry === undefined) invalid(label, `capture "${key}" must be a string or an array of strings`);
    Object.defineProperty(captures, key, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return captures;
}

function isDenseStringArray(value: readonly unknown[]): value is readonly string[] {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== 'string') return false;
  }
  return true;
}

function plainLines(value: unknown, label: string): { readonly start: number; readonly end: number } {
  if (!isRecord(value)) invalid(label, 'lines must be an object with start and end');
  const { start, end } = value;
  if (!isLineNumber(start) || !isLineNumber(end) || start > end) {
    invalid(label, 'lines must be an increasing 1-based inclusive range');
  }
  return { start, end };
}

export function validateScopeMatch(value: unknown, label: string): ScopeMatch<JsonValue> {
  if (!isRecord(value)) invalid(label, 'expected a scope match object');

  const id = value['id'];
  if (typeof id !== 'string' || id === '') invalid(label, 'scope id must be a non-empty string');

  const source = value['source'];
  if (typeof source !== 'string') invalid(label, 'scope source must be a string');

  const rawData = value['data'];
  const data: JsonValue | undefined =
    rawData === undefined ? undefined : validateJsonValue(rawData, `${label}.data`);

  const rawCaptures = value['captures'];
  const captures = rawCaptures === undefined ? undefined : plainCaptures(rawCaptures, `${label}.captures`);

  const rawLines = value['lines'];
  const lines = rawLines === undefined ? undefined : plainLines(rawLines, `${label}.lines`);

  return {
    id,
    source,
    ...(data === undefined ? {} : { data }),
    ...(captures === undefined ? {} : { captures }),
    ...(lines === undefined ? {} : { lines }),
  };
}

export function validateScopeSubject(value: unknown, label: string): ScopeSubject<JsonValue> {
  if (!isRecord(value)) invalid(label, 'expected a scope subject object');
  if (value['kind'] !== 'scope') invalid(label, 'kind must be "scope"');
  const filepath = value['filepath'];
  if (typeof filepath !== 'string' || filepath === '') {
    invalid(label, 'filepath must be a non-empty working-root-relative string');
  }
  return { kind: 'scope', filepath, ...validateScopeMatch(value, label) };
}

export function validateScopeSubjects(value: unknown, label: string): readonly ScopeSubject<JsonValue>[] {
  if (!Array.isArray(value)) invalid(label, 'selection must be an array of scope subjects');
  const subjects = value.map((entry, index) => validateScopeSubject(entry, `${label}[${index}]`));
  const seen = new Set<string>();
  for (const subject of subjects) {
    const key = `${subject.filepath}\u0000${subject.id}`;
    if (seen.has(key)) invalid(label, `duplicate scope id "${subject.id}" for ${subject.filepath}`);
    seen.add(key);
  }
  return subjects;
}

export function validatePredicateResult(value: unknown, label: string): PredicateResult {
  if (typeof value === 'boolean') return value;
  if (isRecord(value) && typeof value['applies'] === 'boolean') {
    const reason = value['reason'];
    if (reason !== undefined && typeof reason !== 'string') invalid(label, 'predicate reason must be a string');
    return value as unknown as PredicateResult;
  }
  invalid(label, 'predicate must return a boolean or { applies, reason? }');
}

export function validateAiUsage(value: unknown, label: string): AiUsage {
  if (!isRecord(value)) invalid(label, 'usage must be an object');
  for (const key of ['calls', 'unreportedCalls', 'inputTokens', 'outputTokens']) {
    const count = value[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      invalid(label, `usage.${key} must be a nonnegative safe integer`);
    }
  }
  if ((value['unreportedCalls'] as number) > (value['calls'] as number)) {
    invalid(label, 'usage.unreportedCalls must not exceed usage.calls');
  }
  for (const key of ['inputCost', 'outputCost']) {
    const cost = value[key];
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      invalid(label, `usage.${key} must be a finite nonnegative number`);
    }
  }
  return value as unknown as AiUsage;
}

type LocationRangeIndex = {
  readonly unbounded: boolean;
  readonly ranges: readonly { readonly start: number; readonly maxEnd: number }[];
};

type LocationMembers = {
  readonly all: ScopeSubject<unknown>[];
  readonly byId: Map<string, ScopeSubject<unknown>[]>;
  rangeIndex?: LocationRangeIndex;
};

function indexLocationMembers(subject: Subject<unknown>): Map<string, LocationMembers> {
  const byFilepath = new Map<string, LocationMembers>();
  const members = subject.kind === 'group' ? subject.members : [subject];
  for (const member of members) {
    const { filepath, id } = member;
    let file = byFilepath.get(filepath);
    if (file === undefined) {
      file = { all: [], byId: new Map() };
      byFilepath.set(filepath, file);
    }
    file.all.push(member);
    const matches = file.byId.get(id);
    if (matches === undefined) file.byId.set(id, [member]);
    else matches.push(member);
  }
  return byFilepath;
}

function indexLocationRanges(members: readonly ScopeSubject<unknown>[]): LocationRangeIndex {
  const ranges: { start: number; maxEnd: number }[] = [];
  for (const member of members) {
    const lines = member.lines;
    if (lines === undefined) return { unbounded: true, ranges };
    ranges.push({ start: lines.start, maxEnd: lines.end });
  }
  ranges.sort((left, right) => left.start - right.start);
  let maxEnd = 0;
  for (const range of ranges) {
    maxEnd = Math.max(maxEnd, range.maxEnd);
    range.maxEnd = maxEnd;
  }
  return { unbounded: false, ranges };
}

function containsLocationRange(
  file: LocationMembers,
  lines: { readonly start: number; readonly end: number },
): boolean {
  const { unbounded, ranges } = file.rangeIndex ??= indexLocationRanges(file.all);
  if (unbounded) return true;
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ranges[middle]!.start <= lines.start) low = middle + 1;
    else high = middle;
  }
  return low > 0 && ranges[low - 1]!.maxEnd >= lines.end;
}

function plainViolationLocations(
  value: unknown,
  label: string,
  subject?: Subject<unknown>,
): readonly ViolationLocation[] {
  if (!Array.isArray(value)) invalid(label, 'check locations must be an array');
  const locations: ViolationLocation[] = [];
  let membersByFilepath: Map<string, LocationMembers> | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const at = `${label} locations[${index}]`;
    if (!Object.hasOwn(value, index)) invalid(at, 'missing location entry');
    const location: unknown = value[index];
    if (!isRecord(location)) invalid(at, 'location must be an object');
    const { filepath, scopeId, lines: rawLines } = location;
    if (typeof filepath !== 'string' || filepath === '') {
      invalid(at, 'location filepath must be a non-empty string');
    }
    if (scopeId !== undefined && (typeof scopeId !== 'string' || scopeId === '')) {
      invalid(at, 'location scopeId must be a non-empty string');
    }
    let lines = rawLines === undefined ? undefined : plainLines(rawLines, at);
    if (scopeId === undefined && lines === undefined) {
      invalid(at, 'location must specify scopeId or lines');
    }
    if (subject !== undefined) {
      const file = (membersByFilepath ??= indexLocationMembers(subject)).get(filepath);
      if (file === undefined) invalid(at, 'location must reference an evaluated scope or group member');
      const members = scopeId === undefined ? file.all : file.byId.get(scopeId);
      if (members === undefined) invalid(at, 'location must reference an evaluated scope or group member');
      let contained = false;
      let resolvedLines: ViolationLocation['lines'];
      if (scopeId === undefined && lines !== undefined) {
        contained = containsLocationRange(file, lines);
      } else {
        for (const member of members) {
          const memberLines = member.lines;
          if (lines !== undefined) {
            if (memberLines === undefined ||
                (lines.start >= memberLines.start && lines.end <= memberLines.end)) {
              contained = true;
            }
          } else if (memberLines !== undefined) {
            if (resolvedLines !== undefined &&
                (resolvedLines.start !== memberLines.start || resolvedLines.end !== memberLines.end)) {
              invalid(at, 'location scopeId identifies multiple line ranges');
            }
            resolvedLines = { start: memberLines.start, end: memberLines.end };
          }
        }
      }
      if (lines !== undefined && !contained) {
        invalid(at, 'location lines must be contained in an evaluated scope or group member');
      }
      lines ??= resolvedLines;
    }
    locations.push({
      filepath,
      ...(scopeId === undefined ? {} : { scopeId }),
      ...(lines === undefined ? {} : { lines }),
    });
  }
  return locations;
}

export function validateCheckResult(value: unknown, label: string, subject?: Subject<unknown>): CheckResult {
  if (!isRecord(value)) invalid(label, 'check must return a check result object');

  const status = value['status'];
  if (status !== 'pass' && status !== 'violation') {
    invalid(label, 'check status must be "pass" or "violation"');
  }

  const message = value['message'];
  if (message !== undefined && typeof message !== 'string') {
    invalid(label, 'check message must be a string');
  }

  const model = value['model'];
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    invalid(label, 'check model must be a non-blank string');
  }

  const probability = value['probability'];
  if (
    probability !== undefined &&
    (typeof probability !== 'number' ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1)
  ) {
    invalid(label, 'check probability must be a finite number between 0 and 1');
  }

  const threshold = value['threshold'];
  if (
    threshold !== undefined &&
    (typeof threshold !== 'number' ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1)
  ) {
    invalid(label, 'check threshold must be a finite number between 0 and 1');
  }

  const rawUsage = value['usage'];
  const usage = rawUsage === undefined ? undefined : validateAiUsage(rawUsage, label);
  const rawLocations = value['locations'];
  if (rawLocations !== undefined && status !== 'violation') {
    invalid(label, 'check locations are only allowed on violation results');
  }
  const locations = rawLocations === undefined ? undefined : plainViolationLocations(rawLocations, label, subject);

  return {
    status,
    ...(message === undefined ? {} : { message }),
    ...(probability === undefined ? {} : { probability }),
    ...(threshold === undefined ? {} : { threshold }),
    ...(model === undefined ? {} : { model }),
    ...(usage === undefined ? {} : { usage }),
    ...(locations === undefined ? {} : { locations }),
  };
}
