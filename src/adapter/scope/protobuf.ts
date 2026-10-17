import { JSONPath, type ReturnObject } from 'jsonpath-plus';
import type { JsonValue, ScopeMatch, ScopeSelector, SourceFile } from '../../app/rule.js';
import { SourceLines, type LineSpan } from './lines.js';
import { readRpcRecords, type ProtoRpcRecord, type ProtoSpan } from './protobuf-parser.js';
import { pointerSegments, validatePath } from './structured.js';

export interface ProtobufScopeOptions {
  readonly path?: string;
}

const DEFAULT_PATH = '$.rpcs[*]';

type HttpNodeKind = 'http' | 'bindings' | 'binding' | 'method' | 'url';

interface SelectedNode {
  readonly id: string;
  readonly data: JsonValue;
  readonly span: ProtoSpan;
}

interface SelectedScope {
  readonly id: string;
  readonly source: string;
  readonly data: JsonValue;
  readonly lines: LineSpan;
}

function indexSegment(segment: string | undefined): number | undefined {
  if (segment === undefined || !/^\d+$/.test(segment)) return undefined;
  return Number(segment);
}

function httpNodeKind(tail: readonly string[]): HttpNodeKind | undefined {
  if (tail[0] !== 'http') return undefined;
  if (tail.length === 1) return 'http';
  if (tail[1] !== 'bindings') return undefined;
  if (tail.length === 2) return 'bindings';
  if (tail.length !== 3 && tail.length !== 4) return undefined;
  if (indexSegment(tail[2]) === undefined) return undefined;
  if (tail.length === 3) return 'binding';
  if (tail[3] === 'method') return 'method';
  if (tail[3] === 'url') return 'url';
  return undefined;
}

function outsideSelection(pointer: string): Error {
  return new Error(`protobuf scope path selected "${pointer}", which is not an RPC record or its http annotation`);
}

function selectHttpNode(record: ProtoRpcRecord, tail: readonly string[], pointer: string): SelectedNode {
  const kind = httpNodeKind(tail);
  if (kind === undefined) throw outsideSelection(pointer);
  const id = `${record.id}:/${tail.join('/')}`;
  const http = record.data.http;
  if (kind === 'http') return { id, data: http as unknown as JsonValue, span: record.spans.http };
  if (kind === 'bindings') return { id, data: http.bindings as unknown as JsonValue, span: record.spans.http };
  const index = indexSegment(tail[2]);
  const binding = index === undefined ? undefined : http.bindings[index];
  const spans = index === undefined ? undefined : record.spans.bindings[index];
  if (binding === undefined || spans === undefined) throw outsideSelection(pointer);
  if (kind === 'binding') return { id, data: binding as unknown as JsonValue, span: spans.span };
  if (kind === 'method') return { id, data: binding.method, span: spans.method };
  return { id, data: binding.url, span: spans.url };
}

function selectNode(
  records: readonly ProtoRpcRecord[],
  pointer: string,
  source: string,
  lines: SourceLines,
): SelectedScope {
  const segments = pointerSegments(pointer);
  const position = segments[0] === 'rpcs' ? indexSegment(segments[1]) : undefined;
  const record = position === undefined ? undefined : records[position];
  if (record === undefined) throw outsideSelection(pointer);
  if (segments.length === 2) {
    return {
      id: record.id,
      source: record.source,
      data: record.data as unknown as JsonValue,
      lines: lines.span(record.start, record.end),
    };
  }
  const node = selectHttpNode(record, segments.slice(2), pointer);
  return {
    id: node.id,
    source: source.slice(node.span.start, node.span.end),
    data: node.data,
    lines: lines.span(node.span.start, node.span.end),
  };
}

function resolvePath(options?: ProtobufScopeOptions): string {
  const path = options?.path === undefined ? DEFAULT_PATH : options.path;
  validatePath(path, 'protobuf scope option path');
  return path;
}

export function protobuf<T = JsonValue>(options?: ProtobufScopeOptions): ScopeSelector<T> {
  const path = resolvePath(options);
  return (file: SourceFile): readonly ScopeMatch<T>[] => {
    const records = readRpcRecords(file.source);
    const raw: unknown = JSONPath({
      path,
      json: { rpcs: records.map((record) => record.data) },
      resultType: 'all',
      wrap: true,
      eval: false,
    });
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const lines = new SourceLines(file.source);
    return raw.map((entry) => {
      const { pointer, parentProperty } = entry as ReturnObject;
      if (typeof pointer !== 'string') {
        throw new Error(`protobuf scope path "${path}" produced a scope without a pointer`);
      }
      if (parentProperty === null) throw outsideSelection(pointer);
      const scope = selectNode(records, pointer, file.source, lines);
      return {
        id: scope.id,
        source: scope.source,
        data: scope.data as unknown as T,
        lines: scope.lines,
      };
    });
  };
}
