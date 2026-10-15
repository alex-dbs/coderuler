import { matchesGlob } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { compileFilter } from './filter.ts';
import type { CompiledFilter, FilterDefinition } from './filter.ts';
import { createPluginRegistry, PluginRegistry } from './plugins/index.ts';
import type { CompiledScope, ScopeMatch } from './plugins/index.ts';
import { warnUnknownField } from './warnings.ts';

export interface FileSelection {
  readonly included: readonly string[];
  readonly excluded?: readonly string[];
}

export interface ScopeDefinition {
  readonly format: string;
  readonly changed?: boolean;
  readonly [option: string]: unknown;
}

export interface RuleExamples {
  readonly good: readonly string[];
  readonly bad: readonly string[];
}

export type DecisionGrouping =
  | { readonly group_by: 'scope' }
  | { readonly group_by: 'file' }
  | { readonly group_by: 'project' }
  | { readonly group_by: 'folder'; readonly level?: number };

export interface RuleDefinition {
  readonly version: 'v1';
  readonly name: string;
  readonly files: FileSelection;
  readonly scope: ScopeDefinition;
  readonly rule: string;
  readonly examples?: Readonly<Partial<RuleExamples>>;
  readonly filter?: FilterDefinition;
  readonly decision?: DecisionGrouping;
  readonly title?: string;
}

export interface RuleInput {
  readonly filepath: string;
  readonly diff: string;
  readonly head: string;
  readonly base?: string;
}

export interface FileInput {
  readonly filepath: string;
  readonly source: string;
}

export interface MatchOptions {
  readonly changedOnly?: boolean;
}

export interface Context {
  readonly filepath: string;
  readonly diff?: string;
  readonly scope: ScopeMatch;
}

export interface CompiledRule {
  readonly version: 'v1';
  readonly name: string;
  readonly rule: string;
  readonly examples: RuleExamples;
  readonly decision: DecisionGrouping;
  readonly title?: string;
  matchesFile(filepath: string): boolean;
  match(input: RuleInput | FileInput, options?: MatchOptions): Context[];
}

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

interface CompiledSelection {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warnUnknownKeys(value: Record<string, unknown>, allowed: Record<string, true>, path: string): void {
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

function compileExamples(value: unknown): RuleExamples {
  if (value === undefined) return { good: [], bad: [] };
  if (!isMapping(value)) throw new Error('rule.examples must be a mapping');
  warnUnknownKeys(value, EXAMPLE_FIELDS, 'rule.examples');
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

function compileSelection(value: unknown): CompiledSelection {
  if (!isMapping(value)) throw new Error('rule.files must be a mapping');
  warnUnknownKeys(value, FILE_FIELDS, 'rule.files');
  const included = stringList(value.included, 'rule.files.included');
  if (included.length === 0) throw new Error('rule.files.included must contain at least one glob');
  return { included, excluded: value.excluded === undefined ? [] : stringList(value.excluded, 'rule.files.excluded') };
}

function compileDecision(value: unknown): DecisionGrouping {
  if (value === undefined) return { group_by: 'scope' };
  if (!isMapping(value)) throw new Error('rule.decision must be a mapping');
  const { group_by: rawGroupBy } = value;
  if (rawGroupBy !== 'scope' && rawGroupBy !== 'file' && rawGroupBy !== 'folder' && rawGroupBy !== 'project') {
    throw new Error('rule.decision.group_by must be one of "scope", "file", "folder" or "project"');
  }
  if (rawGroupBy !== 'folder') {
    warnUnknownKeys(value, DECISION_FIELDS, 'rule.decision');
    return { group_by: rawGroupBy };
  }
  warnUnknownKeys(value, DECISION_FOLDER_FIELDS, 'rule.decision');
  const { level } = value;
  if (level === undefined) return { group_by: 'folder', level: 0 };
  if (typeof level !== 'number' || !Number.isSafeInteger(level) || level > 0) {
    throw new Error('rule.decision.level must be a non-positive integer');
  }
  return { group_by: 'folder', level };
}

function compileScope(value: unknown): { format: string; changed: boolean; options: Record<string, unknown> } {
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

function rejectDuplicateIds(scopes: readonly ScopeMatch[], revision: string): void {
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (typeof scope?.id !== 'string' || scope.id === '') {
      throw new Error(`Every ${revision} scope must carry a non-empty string id`);
    }
    if (seen.has(scope.id)) throw new Error(`Duplicate scope id "${scope.id}" in the ${revision} revision`);
    seen.add(scope.id);
  }
}

function sameScope(base: ScopeMatch, head: ScopeMatch): boolean {
  return base.source === head.source
    && isDeepStrictEqual(base.data, head.data)
    && isDeepStrictEqual(base.captures, head.captures);
}

function changedOnlyOf(options: MatchOptions | undefined): boolean {
  if (options === undefined) return false;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Match options must be a mapping');
  }
  const { changedOnly } = options;
  if (changedOnly !== undefined && typeof changedOnly !== 'boolean') {
    throw new Error('Match options.changedOnly must be a boolean');
  }
  return changedOnly === true;
}

let builtinRegistry: PluginRegistry | undefined;

function defaultRegistry(): PluginRegistry {
  builtinRegistry ??= createPluginRegistry();
  return builtinRegistry;
}

export function compileRule(definition: unknown, registry?: PluginRegistry): CompiledRule {
  if (!isMapping(definition)) throw new Error('Rule must be a YAML mapping');
  warnUnknownKeys(definition, TOP_LEVEL_FIELDS, 'rule');

  const { version, name, rule: instruction, examples: rawExamples } = definition;
  if (version !== 'v1') throw new Error('rule.version must be the string "v1"');
  if (typeof name !== 'string' || name.trim() === '') throw new Error('rule.name must be a non-empty string');
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new Error('rule.rule must be a non-empty string');
  }
  // The title is validated here, before any source is seen, so a malformed description fails a rule
  // even when a future match selects no scope at all.
  const title = optionalTitle(definition.title);
  const examples = compileExamples(rawExamples);
  // The filter is validated here, before any source is seen, so an invalid or executable filter
  // fails a rule even when a future match selects no scope at all.
  const filter: CompiledFilter = compileFilter(definition.filter);
  // The grouping is validated here too, before any source is seen, so a malformed decision fails a
  // rule even when it would select no scope at all.
  const decision = compileDecision(definition.decision);

  const selection = compileSelection(definition.files);
  const { format, changed, options } = compileScope(definition.scope);
  const plugin = (registry ?? defaultRegistry()).get(format);
  const compiledScope: CompiledScope = plugin.compile(options);

  // Compile the file selection once and share it: `matchesFile` and `match` must agree on which
  // filepaths a rule applies to, so neither re-derives the globs per call or per source.
  const matchesFile = (filepath: string): boolean => {
    if (typeof filepath !== 'string') throw new Error('A file selection requires a filepath');
    if (!selection.included.some(glob => matchesGlob(filepath, glob))) return false;
    if (selection.excluded.some(glob => matchesGlob(filepath, glob))) return false;
    return true;
  };

  // Selection and context building are compiled once and parameterized by the call's filepath, so a
  // match allocates no helpers of its own. Both input shapes select the same way; only the revision
  // a source belongs to differs, and it names the source in the duplicate-id error.
  const scopesOf = (filepath: string, source: string, revision: string): readonly ScopeMatch[] => {
    const scopes = compiledScope.select({ filepath, source });
    rejectDuplicateIds(scopes, revision);
    return scopes;
  };
  // One pass over the head scopes yields the contexts the filter accepts, in source order. A
  // revision context carries the file's diff; a file-mode context omits the property entirely
  // because there is none. When the caller compares revisions, `baseById` is the base snapshot and
  // an unchanged scope is skipped here rather than collected into a changed-scopes list: the filter
  // narrows what changed rather than deciding what counts as changed, so parser and duplicate-id
  // errors always surface.
  const contextsOf = (
    filepath: string,
    scopes: readonly ScopeMatch[],
    diff?: string,
    baseById?: ReadonlyMap<string, ScopeMatch>,
  ): Context[] => {
    const contexts: Context[] = [];
    for (const scope of scopes) {
      const previous = baseById?.get(scope.id);
      if (previous !== undefined && sameScope(previous, scope)) continue;
      if (filter.applies(scope)) contexts.push(diff === undefined ? { filepath, scope } : { filepath, diff, scope });
    }
    return contexts;
  };

  return {
    version: 'v1',
    name,
    rule: instruction,
    examples,
    decision,
    ...(title === undefined ? {} : { title }),
    matchesFile,
    match(input: RuleInput | FileInput, options?: MatchOptions): Context[] {
      const changedOnly = changedOnlyOf(options);
      const filepath = input?.filepath;
      if (typeof filepath !== 'string') throw new Error('Rule match requires a filepath');

      if (!matchesFile(filepath)) return [];

      if (decision.group_by !== 'scope') {
        // A grouped rule reads the current tree alone: it never compares revisions, so no base is
        // required or consulted, `changedOnly` has nothing to force, and the returned contexts
        // carry no diff. The filter alone decides which selected scopes a group reviews.
        if ('source' in input) {
          if (Object.hasOwn(input, 'head') || Object.hasOwn(input, 'base') || Object.hasOwn(input, 'diff')) {
            throw new Error('Rule match input must not mix a file source with revision fields');
          }
          const { source } = input;
          if (typeof source !== 'string') throw new Error('A file match requires the source');
          return contextsOf(filepath, scopesOf(filepath, source, 'file'));
        }
        const { head } = input;
        if (typeof head !== 'string') throw new Error('Rule match requires the head revision');
        // A deleted file has no head to review, and a grouped rule reads no base snapshot to
        // validate against it.
        if (head === '') return [];
        return contextsOf(filepath, scopesOf(filepath, head, 'head'));
      }

      if ('source' in input) {
        // A selected file is either one file's text or a revision pair, never both: silently
        // picking one reading of a mixed input would hide the caller's mistake.
        if (Object.hasOwn(input, 'head') || Object.hasOwn(input, 'base') || Object.hasOwn(input, 'diff')) {
          throw new Error('Rule match input must not mix a file source with revision fields');
        }
        // One text has no base to compare against, so a forced comparison cannot be honored: a
        // caller asking for it here would silently get the unchanged file reading instead.
        if (changedOnly) throw new Error('A changed-only match requires the head and base revisions');
        const { source } = input;
        if (typeof source !== 'string') throw new Error('A file match requires the source');
        // File mode has no base to compare, so the filter alone decides which selected scopes are
        // reviewed.
        return contextsOf(filepath, scopesOf(filepath, source, 'file'));
      }

      const { diff, head } = input;
      if (typeof diff !== 'string') throw new Error('Rule match requires the diff');
      if (typeof head !== 'string') throw new Error('Rule match requires the head revision');

      // `changedOnly` overrides the rule's own `scope.changed: false`: the caller is asking for a
      // revision comparison of this filepath, so an opt-out rule still compares base against head.
      if (!changed && !changedOnly) return contextsOf(filepath, scopesOf(filepath, head, 'head'), diff);

      const { base } = input;
      if (typeof base !== 'string') throw new Error('A changed rule requires the base revision');
      if (head === '') {
        // A deleted file emits no contexts, but its base snapshot is still a real revision:
        // extract and validate it so base duplicate ids and plugin failures surface instead of
        // being swallowed as an empty result. The deleted head is never extracted.
        scopesOf(filepath, base, 'base');
        return [];
      }

      // The head snapshot is selected first, so a head parser or duplicate-id failure wins and the
      // base extraction pays only for a head that can still produce contexts.
      const headScopes = scopesOf(filepath, head, 'head');
      // A Map, not a record: scope ids are arbitrary runtime strings (a `__proto__` id must look up
      // its own base scope rather than the prototype slot).
      const baseById = new Map<string, ScopeMatch>();
      for (const scope of scopesOf(filepath, base, 'base')) baseById.set(scope.id, scope);
      return contextsOf(filepath, headScopes, diff, baseById);
    },
  };
}

export function parseRule(source: string, registry?: PluginRegistry): CompiledRule {
  if (typeof source !== 'string') throw new Error('Rule source must be a string');
  let definition: unknown;
  try {
    definition = parse(source, { uniqueKeys: true });
  } catch (error) {
    throw new Error(`Rule YAML could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return compileRule(definition, registry);
}
