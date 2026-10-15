import { JSONPath } from 'jsonpath-plus';
import { assertNonExecutable } from '../jsonpath.ts';
import { warnUnknownField } from '../warnings.ts';
import { SourceLines } from './lines.ts';
import { readRpcRecords } from './protobuf-parser.ts';
import type { CompiledScope, JsonValue, ScopeInput, ScopeMatch, ScopePlugin } from './types.ts';

class ProtobufScope implements CompiledScope {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  select(input: ScopeInput): readonly ScopeMatch[] {
    const records = readRpcRecords(input.source);
    // The parser already produced the exact contract payloads; index the same references that are
    // handed to JSONPath so non-executable selection resolves them by identity, never by copy.
    const index = new Map<object, number>();
    records.forEach((record, position) => index.set(record.data, position));
    const raw = JSONPath({ path: this.path, json: { rpcs: records.map((record) => record.data) }, eval: false });
    const selected = Array.isArray(raw) ? raw : [raw];
    if (selected.length === 0) return [];
    const lines = new SourceLines(input.source);
    return selected.map((result) => {
      const position = result !== null && typeof result === 'object' ? index.get(result) : undefined;
      if (position === undefined) throw new Error('protobuf scope path selected a node that is not an RPC record');
      const record = records[position]!;
      return {
        id: record.id,
        source: record.source,
        data: record.data as unknown as JsonValue,
        lines: lines.span(record.start, record.end),
      };
    });
  }
}

function compileProtobufScope(options: Readonly<Record<string, unknown>>): CompiledScope {
  for (const key of Object.keys(options)) {
    if (key !== 'path') warnUnknownField(`rule.scope.${key}`);
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
