import { JSONPath, type ReturnObject } from 'jsonpath-plus';
import { assertNonExecutable } from '../../app/jsonpath.ts';
import { warnUnknownField } from '../console/warnings.ts';
import { SourceLines } from './lines.ts';
import { readRpcRecords, type ProtoRpcRecord, type ProtoSpan } from './protobuf-parser.ts';
import type {
  CompiledScope,
  JsonValue,
  ScopeCompileContext,
  ScopeInput,
  ScopeMatch,
  ScopePlugin,
} from '../../app/scope/types.ts';

function pointerSegments(pointer: string): readonly string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Unexpected JSON Pointer "${pointer}"`);
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function indexSegment(segment: string | undefined): number | undefined {
  if (segment === undefined || !/^\d+$/.test(segment)) return undefined;
  return Number(segment);
}

type HttpNodeKind = 'http' | 'bindings' | 'binding' | 'method' | 'url';

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

type SelectedNode = {
  readonly id: string;
  readonly data: JsonValue;
  readonly span: ProtoSpan;
};

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
): ScopeMatch {
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

class ProtobufScope implements CompiledScope {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  select(input: ScopeInput): readonly ScopeMatch[] {
    const records = readRpcRecords(input.source);
    const raw: unknown = JSONPath({
      path: this.path,
      json: { rpcs: records.map((record) => record.data) },
      resultType: 'all',
      wrap: true,
      eval: false,
    });
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const lines = new SourceLines(input.source);
    return raw.map((entry) => {
      const { pointer, parentProperty } = entry as ReturnObject;
      if (typeof pointer !== 'string') {
        throw new Error(`protobuf scope path "${this.path}" produced a scope without a pointer`);
      }
      if (parentProperty === null) throw outsideSelection(pointer);
      return selectNode(records, pointer, input.source, lines);
    });
  }
}

function compileProtobufScope(
  options: Readonly<Record<string, unknown>>,
  context?: ScopeCompileContext,
): CompiledScope {
  const warn = context?.warnUnknownField ?? warnUnknownField;
  for (const key of Object.keys(options)) {
    if (key !== 'path') warn(`rule.scope.${key}`);
  }
  const path = options.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('protobuf scope option path must be a non-empty string');
  }
  if (!path.startsWith('$')) {
    throw new Error('protobuf scope option path must be a JSONPath expression beginning with $');
  }
  assertNonExecutable(path, 'protobuf scope option path');
  try {
    JSONPath({ path, json: { rpcs: [] }, eval: false });
  } catch (error) {
    throw new Error(`Invalid protobuf scope path: ${(error as Error).message}`);
  }
  return new ProtobufScope(path);
}

export const protobufPlugin: ScopePlugin = {
  format: 'protobuf',
  compile: compileProtobufScope,
};
