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

import type { JsonValue, ScopeMatch, ScopeSelector } from '../../app/rule.js';
import { SourceLines } from './lines.js';
import { keyOf, pointerSegments, query, validatePath, type QueryMatch } from './structured.js';

export interface YamlScopeOptions {
  readonly path?: string;
  readonly key?: string;
}

type YamlDocument = Document.Parsed;

const MAX_ALIAS_COUNT = 100;

interface EffectiveEntry {
  readonly key: string;
  readonly value: unknown;
}

interface ParsedDocument {
  readonly index: number;
  readonly document: YamlDocument;
  readonly data: JsonValue;
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
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`YAML scope data could not be resolved: ${reason}`);
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

function isEmptyDocument(document: YamlDocument): boolean {
  const root: unknown = document.contents;
  if (root === null) return true;
  if (!isNode(root)) return false;
  const range = root.range;
  if (range === null || range === undefined || range[0] !== range[1]) return false;
  return !(isScalar(root) && root.tag !== undefined);
}

function parseDocuments(source: string): readonly ParsedDocument[] {
  if (source === '') return [];
  const documents = parseAllDocuments(source, { merge: true });
  const streamError = 'empty' in documents ? documents.errors[0] : undefined;
  if (streamError !== undefined) {
    throw new Error(`YAML source could not be parsed: ${streamError.message}`);
  }

  const parsed: ParsedDocument[] = [];
  documents.forEach((document, index) => {
    const firstError = document.errors[0];
    if (firstError !== undefined) {
      throw new Error(`YAML source could not be parsed: ${firstError.message}`);
    }
    if (isEmptyDocument(document)) return;
    parsed.push({ index, document, data: resolveData(document) });
  });
  return parsed;
}

export function parseYaml(source: string): readonly JsonValue[] {
  return parseDocuments(source).map(document => document.data);
}

function locationOf(
  node: unknown,
  source: string,
  lines: SourceLines,
): { readonly source: string; readonly lines: { readonly start: number; readonly end: number } } {
  const range = isNode(node) ? node.range : undefined;
  if (!range) throw new Error('The selected YAML node has no source range');
  return { source: source.slice(range[0], range[1]), lines: lines.span(range[0], range[1]) };
}

function selectScopes<T>(source: string, selector: string, keySelector: string | undefined): readonly ScopeMatch<T>[] {
  const lines = new SourceLines(source);
  const rootOnly = selector.trim() === '$';
  const scopes: ScopeMatch<T>[] = [];

  for (const { index, document, data } of parseDocuments(source)) {
    const resolved = new Map<YAMLMap<unknown, unknown>, EffectiveEntry[]>();
    const matches: readonly QueryMatch[] = rootOnly ? [{ pointer: '', value: data }] : query(data, selector);
    for (const match of matches) {
      const node = locate(document.contents, pointerSegments(match.pointer), document, resolved);
      const location = locationOf(node, source, lines);
      scopes.push({
        id: keySelector === undefined ? `${index}:${match.pointer}` : `${index}:${keyOf(match.value, keySelector)}`,
        source: location.source,
        data: match.value as T,
        lines: location.lines,
      });
    }
  }

  return scopes;
}

export function yaml<T = JsonValue>(options?: YamlScopeOptions): ScopeSelector<T> {
  const selector = options?.path === undefined ? '$' : options.path;
  if (typeof selector !== 'string') throw new Error('The YAML scope "path" must be a non-empty string');
  validatePath(selector, 'YAML scope path');

  const keySelector: unknown = options?.key;
  if (keySelector !== undefined && typeof keySelector !== 'string') {
    throw new Error('The YAML scope "key" must be a non-empty string');
  }
  if (keySelector !== undefined) validatePath(keySelector, 'YAML scope key');

  return ({ source }) => selectScopes<T>(source, selector, keySelector);
}
