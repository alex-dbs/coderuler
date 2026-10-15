import { compileFilter } from '../filter.ts';
import type { CompiledFilter } from '../filter.ts';
import type { WarnUnknownField } from '../scope/types.ts';
import type { DecisionGrouping, RuleExamples } from './types.ts';

const TOP_LEVEL_FIELDS: Record<string, true> = {
  version: true,
  name: true,
  files: true,
  scope: true,
  rule: true,
  examples: true,
  filter: true,
  decision: true,
  title: true,
};
const FILE_FIELDS: Record<string, true> = { included: true, excluded: true };
const EXAMPLE_FIELDS: Record<string, true> = { good: true, bad: true };
const DECISION_FIELDS: Record<string, true> = { group_by: true };
const DECISION_FOLDER_FIELDS: Record<string, true> = { group_by: true, level: true };

export interface CompiledSelection {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
}

export interface CompiledScopeDefinition {
  readonly format: string;
  readonly changed: boolean;
  readonly options: Record<string, unknown>;
}

export interface CompiledDescriptor {
  readonly name: string;
  readonly rule: string;
  readonly title?: string;
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
  if (!isMapping(value)) throw new Error('rule.examples must be a mapping');
  warnUnknownKeys(value, EXAMPLE_FIELDS, 'rule.examples', warnUnknownField);
  return {
    good: value.good === undefined ? [] : exampleList(value.good, 'rule.examples.good'),
    bad: value.bad === undefined ? [] : exampleList(value.bad, 'rule.examples.bad'),
  };
}

function optionalTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('rule.title must be a non-empty string');
  }
  return value;
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

export function compileDescriptor(definition: unknown, warnUnknownField: WarnUnknownField): CompiledDescriptor {
  if (!isMapping(definition)) throw new Error('Rule must be a YAML mapping');
  warnUnknownKeys(definition, TOP_LEVEL_FIELDS, 'rule', warnUnknownField);

  const { version, name, rule: instruction, examples: rawExamples } = definition;
  if (version !== 'v1') throw new Error('rule.version must be the string "v1"');
  if (typeof name !== 'string' || name.trim() === '') throw new Error('rule.name must be a non-empty string');
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new Error('rule.rule must be a non-empty string');
  }
  // The title is validated here, before any source is seen, so a malformed description fails a rule
  // even when a future match selects no scope at all.
  const title = optionalTitle(definition.title);
  const examples = compileExamples(rawExamples, warnUnknownField);
  // The filter is validated here, before any source is seen, so an invalid or executable filter
  // fails a rule even when a future match selects no scope at all.
  const filter: CompiledFilter = compileFilter(definition.filter);
  // The grouping is validated here too, before any source is seen, so a malformed decision fails a
  // rule even when it would select no scope at all.
  const decision = compileDecision(definition.decision, warnUnknownField);

  const selection = compileSelection(definition.files, warnUnknownField);
  const scope = compileScope(definition.scope);

  return {
    name,
    rule: instruction,
    ...(title === undefined ? {} : { title }),
    examples,
    filter,
    decision,
    selection,
    scope,
  };
}
