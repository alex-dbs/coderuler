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

type YamlDocument = Document.Parsed;

const MAX_ALIAS_COUNT = 100;

interface EffectiveEntry {
  readonly key: string;
  readonly value: unknown;
}

interface ResolvedMatch {
  readonly value: JsonValue;
  readonly pointer: string;
}

function withGuard<T>(node: unknown, active: Set<unknown>, work: () => T): T {
  if (active.has(node)) throw new Error('Recursive YAML aliases or merges are not supported');
  active.add(node);
  try {
    return work();
  } finally {
    active.delete(node);
  }
}

function resolveAlias(node: unknown, document: YamlDocument): unknown {
  if (!isAlias(node)) return node;
  const target = node.resolve(document);
  if (target === undefined) throw new Error(`YAML alias "*${node.source}" has no matching anchor`);
  return target;
}

function keyString(key: unknown): string {
  if (!isScalar(key)) throw new Error('A YAML scope requires scalar mapping keys');
  const value = key.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  throw new Error('A YAML mapping key must be a string, number, boolean or null');
}

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

function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Unexpected JSON Pointer "${pointer}"`);
  return pointer
    .slice(1)
    .split('/')
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function sourceOf(node: unknown, source: string): string {
  const range = isNode(node) ? node.range : undefined;
  if (!range) throw new Error('The selected YAML node has no source range');
  return source.slice(range[0], range[1]);
}

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
