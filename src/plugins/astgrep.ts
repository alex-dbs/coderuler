import { parse, type NapiConfig, type SgNode } from '@ast-grep/napi';
import { warnUnknownField } from '../warnings.ts';
import { resolveAstGrepLanguage } from './astgrep-languages.ts';
import { textLineSpan } from './lines.ts';
import type { CompiledScope, ScopeInput, ScopeMatch, ScopePlugin } from './types.ts';

interface CaptureSpec {
  readonly name: string;
  readonly multiple: boolean;
}

const OPTION_KEYS: readonly string[] = ['language', 'rule', 'constraints', 'utils'];

const METAVARIABLE = /\$\$\$([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const ANONYMOUS = /^_+$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalMapping(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isMapping(value)) throw new Error(`ast-grep scope option ${name} must be a mapping`);
  return value;
}

function addPatternCaptures(pattern: string, specs: Map<string, boolean>): void {
  for (const match of pattern.matchAll(METAVARIABLE)) {
    const multiple = match[1] !== undefined;
    const name = multiple ? match[1]! : match[2]!;
    if (ANONYMOUS.test(name)) continue;
    if (multiple || !specs.has(name)) specs.set(name, multiple);
  }
}

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

function firstDescendantText(node: SgNode, kind: string): string | null {
  for (const child of node.namedChildren()) {
    if (child.kind() === kind) return child.text();
    const nested = firstDescendantText(child, kind);
    if (nested !== null) return nested;
  }
  return null;
}

function receiverTypeName(method: SgNode): string | null {
  const receiver = method.field('receiver');
  return receiver === null ? null : firstDescendantText(receiver, 'type_identifier');
}

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

function compileAstGrepScope(options: Readonly<Record<string, unknown>>): CompiledScope {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) warnUnknownField(`rule.scope.${key}`);
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
      return matches.map((node, index) => {
        const text = node.text();
        return {
          id: ids[index]!,
          source: text,
          captures: readCaptures(node, captureSpecs),
          lines: textLineSpan(node.range().start.line + 1, text),
        };
      });
    },
  };
}

export const astGrepPlugin: ScopePlugin = {
  format: 'ast-grep',
  compile: compileAstGrepScope,
};
