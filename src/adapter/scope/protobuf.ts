import type { JsonValue, ScopeMatch, ScopeSelector, SourceFile } from '../../app/rule.js';
import { SourceLines } from './lines.js';
import { DECLARATION_LISTS, readProtoFile, type DeclarationList, type ProtoDocument } from './protobuf-parser.js';
import type { ProtoSpan } from './protobuf-options.js';
import { pointerSegments, query, validatePath } from './structured.js';

export interface ProtobufScopeOptions {
  readonly path?: string;
}

const DEFAULT_PATH = '$.rpcs[*]';

function resolvePath(options?: ProtobufScopeOptions): string {
  const path = options?.path === undefined ? DEFAULT_PATH : options.path;
  validatePath(path, 'protobuf scope option path');
  return path;
}

function isDeclarationList(value: string): value is DeclarationList {
  return (DECLARATION_LISTS as readonly string[]).includes(value);
}

function scopeId(document: ProtoDocument, pointer: string): string {
  if (pointer === '') return '$';
  const segments = pointerSegments(pointer);
  const list = segments[0];
  if (list === undefined || !isDeclarationList(list)) return pointer;
  const index = Number(segments[1]);
  const declaration = Number.isInteger(index) ? document[list][index] : undefined;
  if (declaration === undefined) return pointer;
  const declarationPointer = `/${segments[0]}/${segments[1]}`;
  return segments.length === 2 ? declaration.id : `${declaration.id}:${pointer.slice(declarationPointer.length)}`;
}

function spanAt(spans: ReadonlyMap<string, ProtoSpan>, pointer: string): ProtoSpan {
  let candidate = pointer;
  while (true) {
    const span = spans.get(candidate);
    if (span !== undefined) return span;
    const slash = candidate.lastIndexOf('/');
    candidate = slash <= 0 ? '' : candidate.slice(0, slash);
  }
}

export function protobuf<T = JsonValue>(options?: ProtobufScopeOptions): ScopeSelector<T> {
  const path = resolvePath(options);
  return (file: SourceFile): readonly ScopeMatch<T>[] => {
    const parsed = readProtoFile(file.source);
    const matches = query(parsed.data, path);
    const lines = new SourceLines(file.source);
    return matches.map(({ pointer, value }) => {
      const span = spanAt(parsed.spans, pointer);
      return {
        id: scopeId(parsed.data, pointer),
        source: file.source.slice(span.start, span.end),
        data: value as T,
        lines: lines.span(span.start, span.end),
      };
    });
  };
}
