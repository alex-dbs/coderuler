import { basename } from 'node:path';
import { compileFilter } from '../filter.ts';
import type { CompiledFilter } from '../filter.ts';
import { validateThreshold } from '../decision/threshold.ts';
import type { WarnUnknownField } from '../scope/types.ts';
import type { DecisionGrouping, RuleExamples, RuleKind, RuleSettings } from './types.ts';

const TOP_LEVEL_FIELDS: Record<string, true> = {
  version: true,
  files: true,
  scope: true,
  check: true,
  filter: true,
  decision: true,
  enabled: true,
  settings: true,
};
const CHECK_FIELDS: Record<string, true> = {
  kind: true,
  rule: true,
  examples: true,
  'violation-message': true,
};
const FILE_FIELDS: Record<string, true> = { included: true, excluded: true };
const EXAMPLE_FIELDS: Record<string, true> = { good: true, bad: true };
const DECISION_FIELDS: Record<string, true> = { group_by: true };
const DECISION_FOLDER_FIELDS: Record<string, true> = { group_by: true, level: true };
const SETTINGS_FIELDS: Record<string, true> = { model: true, threshold: true, backend: true };

const RULE_EXTENSION = /\.ya?ml$/i;

export interface CompiledSelection {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
}

export interface CompiledScopeDefinition {
  readonly format: string;
  readonly changed: boolean;
  readonly options: Record<string, unknown>;
}

interface CompiledCheck {
  readonly kind: RuleKind;
  readonly rule: string;
  readonly examples: RuleExamples;
  readonly violationMessage?: string;
}

export interface CompiledDescriptor {
  readonly name: string;
  readonly kind: RuleKind;
  readonly rule: string;
  readonly violationMessage?: string;
  readonly enabled: boolean;
  readonly settings: RuleSettings;
  readonly examples: RuleExamples;
  readonly filter: CompiledFilter;
  readonly decision: DecisionGrouping;
  readonly selection: CompiledSelection;
  readonly scope: CompiledScopeDefinition;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warnUnknownKeys(
  value: Record<string, unknown>,
  allowed: Record<string, true>,
  path: string,
  warnUnknownField: WarnUnknownField,
): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(allowed, key)) warnUnknownField(`${path}.${key}`);
  }
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be a sequence of glob strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry === '') throw new Error(`${path}[${index}] must be a non-empty string`);
    return entry;
  });
}

function exampleList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be a sequence of example strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${path}[${index}] must be a non-blank string`);
    }
    return entry;
  });
}

function compileExamples(value: unknown, warnUnknownField: WarnUnknownField): RuleExamples {
  if (value === undefined) return { good: [], bad: [] };
  if (!isMapping(value)) throw new Error('rule.check.examples must be a mapping');
  warnUnknownKeys(value, EXAMPLE_FIELDS, 'rule.check.examples', warnUnknownField);
  return {
    good: value.good === undefined ? [] : exampleList(value.good, 'rule.check.examples.good'),
    bad: value.bad === undefined ? [] : exampleList(value.bad, 'rule.check.examples.bad'),
  };
}

function optionalViolationMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('rule.check.violation-message must be a non-empty string');
  }
  return value;
}

function optionalKind(value: unknown): RuleKind {
  if (value === undefined) return 'AI';
  if (value !== 'AI' && value !== 'regex') throw new Error('rule.check.kind must be "AI" or "regex"');
  return value;
}

function validateRegex(source: string): void {
  try {
    new RegExp(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`rule.check.rule must be a valid JavaScript regular expression: ${detail}`, { cause: error });
  }
}

function compileCheck(value: unknown, warnUnknownField: WarnUnknownField): CompiledCheck {
  if (!isMapping(value)) throw new Error('rule.check must be a mapping');
  warnUnknownKeys(value, CHECK_FIELDS, 'rule.check', warnUnknownField);

  const kind = optionalKind(value.kind);
  const { rule: instruction } = value;
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new Error('rule.check.rule must be a non-empty string');
  }
  if (kind === 'regex') validateRegex(instruction);

  const violationMessage = optionalViolationMessage(value['violation-message']);
  const examples = compileExamples(value.examples, warnUnknownField);
  return {
    kind,
    rule: instruction,
    examples,
    ...(violationMessage === undefined ? {} : { violationMessage }),
  };
}

function deriveName(filepath: string): string {
  if (typeof filepath !== 'string' || filepath.trim() === '') throw new Error('A rule requires its filepath');
  const stem = basename(filepath).replace(RULE_EXTENSION, '');
  if (stem === '') throw new Error(`Rule file ${filepath} has no name: its filename has no stem before the extension`);
  return stem;
}

function optionalEnabled(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error('rule.enabled must be a boolean');
  return value;
}

function compileSettings(value: unknown, warnUnknownField: WarnUnknownField): RuleSettings {
  if (value === undefined) return {};
  if (!isMapping(value)) throw new Error('rule.settings must be a mapping');
  warnUnknownKeys(value, SETTINGS_FIELDS, 'rule.settings', warnUnknownField);

  const { model, threshold, backend } = value;
  const settings: { model?: string; threshold?: number; backend?: 'jev' } = {};
  if (model !== undefined) {
    if (typeof model !== 'string' || model.trim() === '') {
      throw new Error('rule.settings.model must be a non-empty string');
    }
    settings.model = model.trim();
  }
  if (threshold !== undefined) {
    if (typeof threshold !== 'number') {
      throw new Error('rule.settings.threshold must be a number between 0 and 1');
    }
    settings.threshold = validateThreshold(threshold, 'rule.settings.threshold');
  }
  if (backend !== undefined) {
    if (backend !== 'jev') throw new Error('rule.settings.backend must be "jev"');
    settings.backend = backend;
  }
  return settings;
}

function compileSelection(value: unknown, warnUnknownField: WarnUnknownField): CompiledSelection {
  if (!isMapping(value)) throw new Error('rule.files must be a mapping');
  warnUnknownKeys(value, FILE_FIELDS, 'rule.files', warnUnknownField);
  const included = stringList(value.included, 'rule.files.included');
  if (included.length === 0) throw new Error('rule.files.included must contain at least one glob');
  return { included, excluded: value.excluded === undefined ? [] : stringList(value.excluded, 'rule.files.excluded') };
}

function compileDecision(value: unknown, warnUnknownField: WarnUnknownField): DecisionGrouping {
  if (value === undefined) return { group_by: 'scope' };
  if (!isMapping(value)) throw new Error('rule.decision must be a mapping');
  const { group_by: rawGroupBy } = value;
  if (rawGroupBy !== 'scope' && rawGroupBy !== 'file' && rawGroupBy !== 'folder' && rawGroupBy !== 'project') {
    throw new Error('rule.decision.group_by must be one of "scope", "file", "folder" or "project"');
  }
  if (rawGroupBy !== 'folder') {
    warnUnknownKeys(value, DECISION_FIELDS, 'rule.decision', warnUnknownField);
    return { group_by: rawGroupBy };
  }
  warnUnknownKeys(value, DECISION_FOLDER_FIELDS, 'rule.decision', warnUnknownField);
  const { level } = value;
  if (level === undefined) return { group_by: 'folder', level: 0 };
  if (typeof level !== 'number' || !Number.isSafeInteger(level) || level > 0) {
    throw new Error('rule.decision.level must be a non-positive integer');
  }
  return { group_by: 'folder', level };
}

function compileScope(value: unknown): CompiledScopeDefinition {
  if (!isMapping(value)) throw new Error('rule.scope must be a mapping');
  const { format, changed: rawChanged } = value;
  if (typeof format !== 'string' || format === '') throw new Error('rule.scope.format must be a non-empty string');
  if (rawChanged !== undefined && typeof rawChanged !== 'boolean') {
    throw new Error('rule.scope.changed must be a boolean');
  }
  // Copy plugin-owned keys as own data properties. Plain assignment would route a `__proto__`
  // key into the prototype slot, hiding that key from the plugin and letting inherited values
  // such as `path` slip past its option validation.
  const options: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'format' && key !== 'changed'),
  );
  return { format, changed: rawChanged === undefined ? true : rawChanged, options };
}

export function compileDescriptor(
  definition: unknown,
  filepath: string,
  warnUnknownField: WarnUnknownField,
): CompiledDescriptor {
  if (!isMapping(definition)) throw new Error('Rule must be a YAML mapping');
  warnUnknownKeys(definition, TOP_LEVEL_FIELDS, 'rule', warnUnknownField);

  const { version } = definition;
  if (version !== 'v1') throw new Error('rule.version must be the string "v1"');
  const name = deriveName(filepath);
  // Metadata is validated here, before any plugin compiles and before any source is seen, so a
  // malformed description fails a rule even when it is disabled or would select no scope at all.
  const check = compileCheck(definition.check, warnUnknownField);
  const enabled = optionalEnabled(definition.enabled);
  const settings = compileSettings(definition.settings, warnUnknownField);
  // The filter is validated here too, before any source is seen, so an invalid or executable filter
  // fails a rule even when a future match selects no scope at all.
  const filter: CompiledFilter = compileFilter(definition.filter);
  // The grouping is validated here too, before any source is seen, so a malformed decision fails a
  // rule even when it would select no scope at all.
  const decision = compileDecision(definition.decision, warnUnknownField);

  const selection = compileSelection(definition.files, warnUnknownField);
  const scope = compileScope(definition.scope);

  return {
    name,
    kind: check.kind,
    rule: check.rule,
    ...(check.violationMessage === undefined ? {} : { violationMessage: check.violationMessage }),
    enabled,
    settings,
    examples: check.examples,
    filter,
    decision,
    selection,
    scope,
  };
}
