import { matchesGlob } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compileDescriptor } from './descriptor.ts';
import type { CompiledScope, ScopeMatch } from '../scope/types.ts';
import type {
  CompiledRule,
  Context,
  FileInput,
  MatchOptions,
  RuleCompileDependencies,
  RuleInput,
} from './types.ts';

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

export function compileRule(definition: unknown, dependencies: RuleCompileDependencies): CompiledRule {
  const descriptor = compileDescriptor(definition, dependencies.warnUnknownField);
  const { name, rule: instruction, title, examples, decision, selection, filter } = descriptor;
  const { changed, options, format } = descriptor.scope;

  const compiledScope: CompiledScope = dependencies.registry
    .get(format)
    .compile(options, { warnUnknownField: dependencies.warnUnknownField });

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
