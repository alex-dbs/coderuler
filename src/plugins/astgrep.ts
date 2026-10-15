/**
 * ast-grep scope format: selects real syntax-tree nodes from one revision with a native ast-grep
 * rule (`@ast-grep/napi`). Scopes are whole matched nodes, never a regex over the text.
 *
 * Every published grammar is available with no host setup: `@ast-grep/napi` bundles
 * JavaScript/TypeScript/TSX/CSS/HTML, and the 26 remaining catalog grammars (`@ast-grep/lang-*`) are
 * registered together, once, the first time a rule names one — so a builtin-only rule never loads a
 * dynamic library. ast-grep accepts `registerDynamicLanguage` only once per process, so a host that
 * needs grammars of its own must merge the whole catalog into that single call
 * (`registerDynamicLanguage({ ...createAstGrepLanguageRegistrations(), ...custom })`); registering
 * more languages later cannot work, and `resolveAstGrepLanguage` says so instead of leaving the
 * native missing-parser failure to explain it. When a language already resolves by the time a rule
 * needs it — a host registered it some other way — nothing is registered and that parser is used.
 * Language names fold to their canonical spelling case-insensitively and accept the conventional
 * aliases (`py`, `golang`, `c++`, `md`, ...); a name outside the catalog reaches the native parser
 * exactly as written, so a language a host registered itself keeps working.
 *
 * The AST is syntactic and tolerant: no type checking, dataflow or capacity reasoning happens here.
 * Candidates are intentionally broad so genuinely correct code (for example a loop that already
 * pre-sizes its slice) is still handed to the reviewer rather than filtered out.
 *
 * Identity: named declarations are keyed by their kind, their enclosing named declarations and
 * their own name (Go methods additionally include the receiver type, so `Add` on two types never
 * collides). This stays stable when lines are inserted before the declaration because source
 * positions are never part of the identity. A legal overload or a redefinition parses as its own
 * declaration with the same name, so a repeated identity takes a `#N` suffix in document order
 * (`add`, `add#1`): the first keeps the identity it has on its own, and no two ids of a revision are
 * equal, so a file of overloads extracts instead of aborting on the duplicate the core rejects.
 * Matches with no name field fall back to `kind#occurrence`, a deterministic approximation that may
 * re-review anonymous or reordered matches; such extra review is accepted, and so is the ordinal
 * reading of overloads, which renumbers the ids after a declaration inserted ahead of a repeat.
 */
import { parse, type NapiConfig, type SgNode } from '@ast-grep/napi';
import { resolveAstGrepLanguage } from './astgrep-languages.ts';
import type { CompiledScope, ScopeInput, ScopeMatch, ScopePlugin } from './types.ts';

/** One named metavariable a native rule binds, and whether `$$$` makes it a multi capture. */
interface CaptureSpec {
  readonly name: string;
  readonly multiple: boolean;
}

const OPTION_KEYS: readonly string[] = ['language', 'rule', 'constraints', 'utils'];

/** `$NAME` (single node) or `$$$NAME` (zero or more nodes); anonymous names are all underscores. */
const METAVARIABLE = /\$\$\$([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const ANONYMOUS = /^_+$/;

/** Narrow to a plain mapping (not an array or scalar). */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one optional option that must be a mapping when present. */
function optionalMapping(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isMapping(value)) throw new Error(`ast-grep scope option ${name} must be a mapping`);
  return value;
}

/** Record every named metavariable that appears in a single pattern source string. */
function addPatternCaptures(pattern: string, specs: Map<string, boolean>): void {
  for (const match of pattern.matchAll(METAVARIABLE)) {
    const multiple = match[1] !== undefined;
    const name = multiple ? match[1]! : match[2]!;
    if (ANONYMOUS.test(name)) continue;
    if (multiple || !specs.has(name)) specs.set(name, multiple);
  }
}

/**
 * Collect the named metavariables a rule can bind by walking its `pattern` values only; unrelated
 * configuration strings (regexes, kinds) never contribute capture names.
 */
function collectCaptureSpecs(value: unknown, specs: Map<string, boolean>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCaptureSpecs(item, specs);
    return;
  }
  if (!isMapping(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'pattern') {
      if (typeof child === 'string') addPatternCaptures(child, specs);
      else if (isMapping(child) && typeof child.context === 'string') addPatternCaptures(child.context, specs);
      continue;
    }
    collectCaptureSpecs(child, specs);
  }
}

/** Read the metavariables actually bound on one match; unavailable ones are omitted. */
function readCaptures(node: SgNode, specs: readonly CaptureSpec[]): Readonly<Record<string, string | readonly string[]>> {
  const captures: Record<string, string | readonly string[]> = {};
  for (const spec of specs) {
    if (spec.multiple) {
      const nodes = node.getMultipleMatches(spec.name);
      if (nodes.length > 0) captures[spec.name] = nodes.map((child) => child.text());
    } else {
      const match = node.getMatch(spec.name);
      if (match !== null) captures[spec.name] = match.text();
    }
  }
  return captures;
}

/** Text of the first descendant (depth-first) of the given kind, or null. */
function firstDescendantText(node: SgNode, kind: string): string | null {
  for (const child of node.namedChildren()) {
    if (child.kind() === kind) return child.text();
    const nested = firstDescendantText(child, kind);
    if (nested !== null) return nested;
  }
  return null;
}

/** The receiver's type name for a Go method, e.g. `Cart` for `func (c *Cart) Add(...)`. */
function receiverTypeName(method: SgNode): string | null {
  const receiver = method.field('receiver');
  return receiver === null ? null : firstDescendantText(receiver, 'type_identifier');
}

/** One declaration's stable identity segment; null when the node declares no name. */
function declarationSegment(node: SgNode): string | null {
  const nameNode = node.field('name');
  if (nameNode === null) return null;
  const name = nameNode.text();
  if (name === '') return null;
  const kind = node.kind();
  if (kind !== 'method_declaration') return `${kind}:${name}`;
  const receiver = receiverTypeName(node);
  return receiver === null ? `${kind}:${name}` : `${kind}:${receiver}.${name}`;
}

/**
 * One match's identity segment: enclosing named declarations from outermost to innermost, then the
 * match itself. Anonymous matches fall back to `kind#occurrence` in document order, which is already
 * unique within a kind; repeated named declarations share the identity here and are told apart by
 * {@link uniqueIds}.
 */
function identityOf(node: SgNode, occurrence: number): string {
  const own = declarationSegment(node);
  if (own === null) return `${node.kind()}#${occurrence}`;
  const enclosing: string[] = [];
  let ancestor = node.parent();
  while (ancestor !== null) {
    const segment = declarationSegment(ancestor);
    if (segment !== null) enclosing.unshift(segment);
    const parent = ancestor.parent();
    if (parent === null || parent.id() === ancestor.id()) break;
    ancestor = parent;
  }
  return [...enclosing, own].join('/');
}

/**
 * Make one revision's identities unique: a declaration that repeats an earlier identity takes a
 * deterministic `#N` suffix in document order (`add`, `add#1`), the numbering anonymous matches
 * already use. Every identity stays reserved for the match that owns it, so a name that already
 * looks suffixed keeps its own id and the repeat moves past it, in either order; an identity that
 * occurs once is returned exactly as it came in.
 */
function uniqueIds(bases: readonly string[]): readonly string[] {
  const taken = new Set(bases);
  const nextSuffix = new Map<string, number>();
  const ids: string[] = [];
  for (const base of bases) {
    const suffixFrom = nextSuffix.get(base);
    if (suffixFrom === undefined) {
      nextSuffix.set(base, 1);
      ids.push(base);
      continue;
    }
    let suffix = suffixFrom;
    while (taken.has(`${base}#${suffix}`)) suffix += 1;
    const id = `${base}#${suffix}`;
    nextSuffix.set(base, suffix + 1);
    taken.add(id);
    ids.push(id);
  }
  return ids;
}

/** Validate one ast-grep scope's options and return the compiled selector. */
function compileAstGrepScope(options: Readonly<Record<string, unknown>>): CompiledScope {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) throw new Error(`Unknown ast-grep scope option '${key}'`);
  }

  const language = options.language;
  if (typeof language !== 'string' || language === '') {
    throw new Error('ast-grep scope option language must be a non-empty string');
  }
  const rule = options.rule;
  if (!isMapping(rule)) throw new Error('ast-grep scope option rule must be a mapping');
  const constraints = optionalMapping(options.constraints, 'constraints');
  const utils = optionalMapping(options.utils, 'utils');

  // Resolve the requested language to the name the native parser takes: catalog aliases and casing
  // fold to the canonical spelling (registering the bundled grammars on first need), while a name
  // the catalog does not know is the host's own language and reaches the parser exactly as written.
  const nativeLanguage = resolveAstGrepLanguage(language);

  const config: Record<string, unknown> = { rule };
  if (constraints !== undefined) config.constraints = constraints;
  if (utils !== undefined) config.utils = utils;
  // Rule options come from rule YAML, so their shape is unknown to the compiler; the native
  // parser validates them on the call below, which is exactly where a bad rule must surface.
  const nativeConfig = config as unknown as NapiConfig;

  // Compile and validate the native query before any match; invalid language/rule/regex throw.
  parse(nativeLanguage, '').root().findAll(nativeConfig);

  const specs = new Map<string, boolean>();
  collectCaptureSpecs([rule, constraints, utils], specs);
  const captureSpecs: CaptureSpec[] = [...specs].map(([name, multiple]) => ({ name, multiple }));

  return {
    select(input: ScopeInput): readonly ScopeMatch[] {
      const matches = parse(nativeLanguage, input.source).root().findAll(nativeConfig);
      const occurrences = new Map<string, number>();
      const bases: string[] = [];
      for (const node of matches) {
        // `SgNode.kind()` is documented to return the node-kind name; its native type also admits the
        // numeric index of the language types map, which no real syntax node uses, so narrow here.
        const kind = node.kind() as string;
        const occurrence = occurrences.get(kind) ?? 0;
        occurrences.set(kind, occurrence + 1);
        bases.push(identityOf(node, occurrence));
      }
      const ids = uniqueIds(bases);
      return matches.map((node, index) => ({
        id: ids[index]!,
        source: node.text(),
        captures: readCaptures(node, captureSpecs),
      }));
    },
  };
}

/** The builtin ast-grep scope format. */
export const astGrepPlugin: ScopePlugin = {
  format: 'ast-grep',
  compile: compileAstGrepScope,
};
