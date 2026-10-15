/**
 * YAML scope plugin: turns one JSONPath selection over every YAML document into complete scopes.
 *
 * The plugin resolves each document to plain JSON-compatible data (aliases and `<<` merge keys
 * included) and queries it with jsonpath-plus under `eval: false`, so a rule can never run a
 * JSONPath script or filter. Every selected node becomes one scope carrying its exact source text
 * and its full resolved data, so a downstream reviewer always sees the whole resource (for example
 * both `request` and `limit`) regardless of which line the diff touched.
 */
import { JSONPath, type ReturnObject } from 'jsonpath-plus';
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type YAMLMap,
} from 'yaml';

import { assertNonExecutable } from '../jsonpath.ts';
import type { CompiledScope, JsonValue, ScopeMatch, ScopePlugin } from './types.ts';

/** A parsed YAML document; its contents may still be absent. */
type YamlDocument = Document.Parsed;

/**
 * The budget the `yaml` package charges every alias expansion against while it materializes a
 * document. Resolution that exceeds it is reported as a resource-exhaustion attack rather than
 * expanded, so an alias bomb fails instead of allocating without bound.
 */
const MAX_ALIAS_COUNT = 100;

/** One mapping entry after `<<` merge keys are applied, in first-wins insertion order. */
interface EffectiveEntry {
  readonly key: string;
  readonly value: unknown;
}

/** One resolved JSONPath match: the value and the JSON Pointer that located it. */
interface ResolvedMatch {
  readonly value: JsonValue;
  readonly pointer: string;
}

/**
 * Track `node` on the current merge-source walk so a self-referential merge fails loudly instead of
 * recursing forever; JSON cannot represent a cycle anyway.
 */
function withGuard<T>(node: unknown, active: Set<unknown>, work: () => T): T {
  if (active.has(node)) throw new Error('Recursive YAML aliases or merges are not supported');
  active.add(node);
  try {
    return work();
  } finally {
    active.delete(node);
  }
}

/** Follow an alias to its anchor target; other nodes pass through unchanged. */
function resolveAlias(node: unknown, document: YamlDocument): unknown {
  if (!isAlias(node)) return node;
  const target = node.resolve(document);
  if (target === undefined) throw new Error(`YAML alias "*${node.source}" has no matching anchor`);
  return target;
}

/**
 * The JSON object key a scalar mapping key contributes, mirroring YAML's key stringification: the
 * `yaml` package turns every non-null scalar key into a JS object key with `String(value)`, so
 * numbers stringify the same way, including the non-finite `.inf`/`-.inf`/`.nan` keys it accepts.
 */
function keyString(key: unknown): string {
  if (!isScalar(key)) throw new Error('A YAML scope requires scalar mapping keys');
  const value = key.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  throw new Error('A YAML mapping key must be a string, number, boolean or null');
}

/** The mappings a `<<` merge value contributes, accepting an alias or a sequence of aliases. */
function mergeSources(value: unknown, document: YamlDocument): YAMLMap<unknown, unknown>[] {
  const resolved = resolveAlias(value, document);
  if (isSeq(resolved)) {
    return resolved.items.map(item => {
      const source = resolveAlias(item, document);
      if (!isMap(source)) throw new Error('YAML merge sequence entries must be mappings');
      return source;
    });
  }
  if (!isMap(resolved)) throw new Error('A YAML merge value must be a mapping or a sequence of mappings');
  return [resolved];
}

/**
 * Mapping entries with merge keys applied: explicit keys always win, then each merge source adds
 * the keys it still owns (earlier sources winning over later ones). Results are memoized per
 * document, so a merge graph that reaches one source through many paths stays linear in the
 * number of distinct keys instead of expanding once per path.
 */
function effectiveEntries(
  map: YAMLMap<unknown, unknown>,
  document: YamlDocument,
  active: Set<unknown>,
  resolved: Map<YAMLMap<unknown, unknown>, EffectiveEntry[]>,
): EffectiveEntry[] {
  const cached = resolved.get(map);
  if (cached !== undefined) return cached;

  const entries = withGuard(map, active, () => {
    const explicit = new Map<string, unknown>();
    const order: string[] = [];
    const merges: unknown[] = [];
    for (const pair of map.items) {
      if (isScalar(pair.key) && typeof pair.key.value === 'symbol' && String(pair.key.value) === 'Symbol(<<)') {
        merges.push(pair.value);
        continue;
      }
      const key = pair.key === null || pair.key === undefined ? '' : keyString(pair.key);
      if (!explicit.has(key)) order.push(key);
      explicit.set(key, pair.value);
    }

    const resolvedEntries: EffectiveEntry[] = order.map(key => ({ key, value: explicit.get(key) ?? null }));
    const present = new Set(order);
    for (const merge of merges) {
      for (const source of mergeSources(merge, document)) {
        for (const entry of effectiveEntries(source, document, active, resolved)) {
          if (present.has(entry.key)) continue;
          present.add(entry.key);
          resolvedEntries.push(entry);
        }
      }
    }
    return resolvedEntries;
  });

  resolved.set(map, entries);
  return entries;
}

/** Reject values JSON cannot carry: cycles, non-finite numbers and non-plain objects. */
function assertJsonValue(value: unknown, visiting: Set<object>, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('YAML scope data must stay JSON-compatible: non-finite number');
    return;
  }
  if (typeof value !== 'object') throw new Error('YAML scope data must stay JSON-compatible: unsupported value');
  if (seen.has(value)) return;
  if (visiting.has(value)) throw new Error('YAML scope data must stay JSON-compatible: cyclic value');

  visiting.add(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, visiting, seen);
  } else if (prototype === Object.prototype || prototype === null) {
    for (const key of Object.keys(value)) {
      assertJsonValue((value as Record<string, unknown>)[key], visiting, seen);
    }
  } else {
    throw new Error('YAML scope data must stay JSON-compatible: unsupported value');
  }
  visiting.delete(value);
  seen.add(value);
}

/**
 * Resolve a document to plain JSON-compatible data. The `yaml` package expands aliases and `<<`
 * merge keys itself and charges every expansion against `MAX_ALIAS_COUNT`, so an alias bomb errors
 * instead of allocating without bound; the materialized value is then checked for JSON fit.
 */
function resolveData(document: YamlDocument): JsonValue {
  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`YAML scope data could not be resolved: ${detail}`);
  }
  assertJsonValue(data, new Set<object>(), new Set<object>());
  return data as JsonValue;
}

/** Walk the resolved JSON Pointer back to the source node, resolving aliases and merges. */
function locate(
  root: unknown,
  segments: readonly string[],
  document: YamlDocument,
  resolved: Map<YAMLMap<unknown, unknown>, EffectiveEntry[]>,
): unknown {
  let node: unknown = root;
  const active = new Set<unknown>();
  for (const segment of segments) {
    node = resolveAlias(node, document);
    if (isMap(node)) {
      const entry = effectiveEntries(node, document, active, resolved)
        .find(candidate => candidate.key === segment);
      if (entry === undefined) return null;
      node = entry.value;
    } else if (isSeq(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.items.length) return null;
      node = node.items[index] ?? null;
    } else {
      return null;
    }
  }
  return node;
}

/** Decode a JSON Pointer into path segments; the empty pointer is the document root. */
function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Unexpected JSON Pointer "${pointer}"`);
  return pointer
    .slice(1)
    .split('/')
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** The exact source text of a selected node, without surrounding comments or whitespace. */
function sourceOf(node: unknown, source: string): string {
  const range = isNode(node) ? node.range : undefined;
  if (!range) throw new Error('The selected YAML node has no source range');
  return source.slice(range[0], range[1]);
}

/** Run the selection under jsonpath-plus with evaluation disabled; executable forms are rejected. */
function queryAll(selector: string, data: JsonValue): ResolvedMatch[] {
  let result: unknown;
  try {
    result = JSONPath({ path: selector, json: data, resultType: 'all', wrap: true, eval: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`YAML scope path "${selector}" could not be evaluated: ${detail}`);
  }
  if (!Array.isArray(result)) return [];
  return result.map(entry => {
    const { value, pointer } = entry as ReturnObject;
    if (typeof pointer !== 'string') {
      throw new Error(`YAML scope path "${selector}" produced a scope without a pointer`);
    }
    return { value: value as JsonValue, pointer };
  });
}

/** Resolve a scope's `key` selector against its own data: exactly one string or finite number. */
function keyValue(data: JsonValue, selector: string): string {
  // jsonpath-plus reports nothing for a falsy document root, so `$` reads the scope's own data: a
  // key at the root must still resolve for `0`, `false` and the empty string.
  let value: unknown = data;
  if (selector.trim() !== '$') {
    const result = JSONPath({ path: selector, json: data, resultType: 'value', wrap: true, eval: false });
    if (!Array.isArray(result) || result.length !== 1) {
      throw new Error('The YAML scope "key" selector must match exactly one value');
    }
    value = result[0];
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error('The YAML scope "key" selector must resolve to a string or finite number');
}

/** Every scope the selector matches across every document in one revision's source. */
function selectScopes(source: string, selector: string, keySelector: string | undefined): ScopeMatch[] {
  if (source === '') return [];
  const documents = parseAllDocuments(source, { merge: true });
  // A stream with no document (`%YAML bad`) keeps its errors on the stream itself, so they have to
  // be read from there; a malformed stream must never look like a source with nothing to select.
  const streamError = 'empty' in documents ? documents.errors[0] : undefined;
  if (streamError !== undefined) {
    throw new Error(`YAML source could not be parsed: ${streamError.message}`);
  }
  const scopes: ScopeMatch[] = [];
  const rootOnly = selector.trim() === '$';

  documents.forEach((document, index) => {
    const firstError = document.errors[0];
    if (firstError !== undefined) {
      throw new Error(`YAML source could not be parsed: ${firstError.message}`);
    }
    const root = document.contents;
    if (root === null) return;

    const data = resolveData(document);
    const resolved = new Map<YAMLMap<unknown, unknown>, EffectiveEntry[]>();
    const matches: ResolvedMatch[] = rootOnly ? [{ value: data, pointer: '' }] : queryAll(selector, data);
    for (const match of matches) {
      const node = locate(root, pointerSegments(match.pointer), document, resolved);
      const id = keySelector === undefined
        ? `${index}:${match.pointer}`
        : `${index}:${keyValue(match.value, keySelector)}`;
      scopes.push({ id, source: sourceOf(node, source), data: match.value });
    }
  });

  return scopes;
}

/** The builtin `yaml` scope format: `{ path, key? }` selecting nodes of every YAML document. */
export const yamlPlugin: ScopePlugin = {
  format: 'yaml',
  compile(options: Readonly<Record<string, unknown>>): CompiledScope {
    for (const key of Object.keys(options)) {
      if (key !== 'path' && key !== 'key') throw new Error(`yaml scope has no option "${key}"`);
    }

    const selector = options.path;
    if (typeof selector !== 'string' || selector === '') {
      throw new Error('yaml scope requires a non-empty "path" string');
    }
    assertNonExecutable(selector, 'YAML scope path');

    const rawKey = options.key;
    if (rawKey !== undefined && (typeof rawKey !== 'string' || rawKey === '')) {
      throw new Error('yaml scope "key" must be a non-empty string when present');
    }
    const keySelector = typeof rawKey === 'string' ? rawKey : undefined;
    if (keySelector !== undefined) assertNonExecutable(keySelector, 'YAML scope key');

    return {
      select({ source }): readonly ScopeMatch[] {
        return selectScopes(source, selector, keySelector);
      },
    };
  },
};
