import { parseTree, printParseErrorCode, type Node as JsonNode, type ParseError } from 'jsonc-parser';

import type { JsonValue, ScopeMatch, ScopeSelector } from '../../app/rule.js';
import { SourceLines } from './lines.js';
import { keyOf, pointerSegments, query, validatePath, type QueryMatch } from './structured.js';

export interface JsonScopeOptions {
  readonly path?: string;
  readonly key?: string;
}

interface ParsedJson {
  readonly data: JsonValue;
  readonly root: JsonNode;
}

const PARSE_OPTIONS = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false };

function memberOf(property: JsonNode): { readonly name: string; readonly value: JsonNode } | undefined {
  if (property.type !== 'property') return undefined;
  const pair = property.children ?? [];
  const key = pair[0];
  const value = pair[1];
  if (key === undefined || value === undefined || pair.length !== 2) return undefined;
  return { name: String(key.value), value };
}

function propertyValue(node: JsonNode, name: string): JsonNode | undefined {
  for (const property of node.children ?? []) {
    const member = memberOf(property);
    if (member !== undefined && member.name === name) return member.value;
  }
  return undefined;
}

function objectValue(node: JsonNode): JsonValue {
  const result: Record<string, JsonValue> = {};
  const names = new Set<string>();
  for (const property of node.children ?? []) {
    const member = memberOf(property);
    if (member === undefined) throw new Error('JSON source contains an invalid object member');
    if (names.has(member.name)) {
      throw new Error(`JSON source contains a duplicate object key "${member.name}"`);
    }
    names.add(member.name);
    Object.defineProperty(result, member.name, {
      value: nodeValue(member.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function nodeValue(node: JsonNode): JsonValue {
  switch (node.type) {
    case 'object':
      return objectValue(node);
    case 'array':
      return (node.children ?? []).map(nodeValue);
    case 'null':
      return null;
    case 'boolean':
      return node.value === true;
    case 'number': {
      const value: number = node.value;
      if (!Number.isFinite(value)) throw new Error('JSON source contains a non-finite number');
      return value;
    }
    case 'string':
      return node.value as string;
    default:
      throw new Error('JSON source contains an unsupported value');
  }
}

function parseDocument(source: string): ParsedJson {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, PARSE_OPTIONS);
  const first = errors[0];
  if (root === undefined || first !== undefined) {
    const problem = first === undefined
      ? 'no JSON content'
      : `${printParseErrorCode(first.error)} at offset ${first.offset}`;
    throw new Error(`JSON source could not be parsed: ${problem}`);
  }
  return { data: nodeValue(root), root };
}

export function parseJson(source: string): JsonValue {
  return parseDocument(source).data;
}

function nodeAt(root: JsonNode, segments: readonly string[]): JsonNode {
  let node = root;
  for (const segment of segments) {
    if (node.type === 'object') {
      const member = propertyValue(node, segment);
      if (member === undefined) throw new Error(`The JSON pointer segment "${segment}" does not exist`);
      node = member;
      continue;
    }
    if (node.type === 'array') {
      const index = Number(segment);
      const member = Number.isInteger(index) && index >= 0 ? (node.children ?? [])[index] : undefined;
      if (member === undefined) throw new Error(`The JSON pointer segment "${segment}" does not exist`);
      node = member;
      continue;
    }
    throw new Error(`The JSON pointer segment "${segment}" does not exist`);
  }
  return node;
}

function selectScopes<T>(source: string, selector: string, keySelector: string | undefined): readonly ScopeMatch<T>[] {
  const document = parseDocument(source);
  const lines = new SourceLines(source);
  const matches: readonly QueryMatch[] = selector.trim() === '$'
    ? [{ pointer: '', value: document.data }]
    : query(document.data, selector);
  return matches.map((match) => {
    const node = nodeAt(document.root, pointerSegments(match.pointer));
    const start = node.offset;
    const end = node.offset + node.length;
    return {
      id: keySelector === undefined ? (match.pointer === '' ? '$' : match.pointer) : keyOf(match.value, keySelector),
      source: source.slice(start, end),
      data: match.value as T,
      lines: lines.span(start, end),
    };
  });
}

export function json<T = JsonValue>(options?: JsonScopeOptions): ScopeSelector<T> {
  const selector = options?.path === undefined ? '$' : options.path;
  if (typeof selector !== 'string') throw new Error('The JSON scope "path" must be a non-empty string');
  validatePath(selector, 'JSON scope path');

  const keySelector: unknown = options?.key;
  if (keySelector !== undefined && typeof keySelector !== 'string') {
    throw new Error('The JSON scope "key" must be a non-empty string');
  }
  if (keySelector !== undefined) validatePath(keySelector, 'JSON scope key');

  return ({ source }) => selectScopes<T>(source, selector, keySelector);
}
