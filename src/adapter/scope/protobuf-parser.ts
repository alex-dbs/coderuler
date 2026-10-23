import { Buffer } from 'node:buffer';

import type { JsonValue } from '../../app/rule.js';
import { assignOption, extendSpan, optionMessage, optionsJson, type OptionMessage, type OptionNode, type OptionScalar, type ProtoSpan } from './protobuf-options.js';
import { pointerSegment } from './structured.js';
export const DECLARATION_LISTS = ['services', 'rpcs', 'messages', 'fields', 'oneofs', 'enums', 'enumValues', 'extensions'] as const;
export type DeclarationList = (typeof DECLARATION_LISTS)[number];
export type ProtoDeclaration = {
  readonly id: string;
  readonly name: string;
  readonly parent: string | null;
  readonly options: { readonly [key: string]: JsonValue };
};
export type ProtoDocument = {
  readonly options: { readonly [key: string]: JsonValue };
  readonly services: readonly ProtoDeclaration[];
  readonly rpcs: readonly ProtoDeclaration[];
  readonly messages: readonly ProtoDeclaration[];
  readonly fields: readonly ProtoDeclaration[];
  readonly oneofs: readonly ProtoDeclaration[];
  readonly enums: readonly ProtoDeclaration[];
  readonly enumValues: readonly ProtoDeclaration[];
  readonly extensions: readonly ProtoDeclaration[];
};
export type ProtoFile = { readonly data: ProtoDocument; readonly spans: ReadonlyMap<string, ProtoSpan> };

interface ProtoToken {
  readonly kind: 'ident' | 'number' | 'punct' | 'string';
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const CLOSERS: Record<string, string> = { '{': '}', '(': ')', '[': ']', '<': '>' };

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v' || ch === '\uFEFF';
}

function hexValue(ch: string): number | undefined {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'a' && ch <= 'f') return ch.charCodeAt(0) - 87;
  if (ch >= 'A' && ch <= 'F') return ch.charCodeAt(0) - 55;
  return undefined;
}

type ProtoEscape = { readonly next: number; readonly text?: string; readonly byte?: number };

function readEscape(source: string, index: number): ProtoEscape {
  const ch = source[index + 1];
  if (ch === undefined) throw new Error('Unterminated escape sequence in string literal');
  switch (ch) {
    case 'n': return { next: index + 2, text: '\n' };
    case 'r': return { next: index + 2, text: '\r' };
    case 't': return { next: index + 2, text: '\t' };
    case 'a': return { next: index + 2, text: '\u0007' };
    case 'b': return { next: index + 2, text: '\b' };
    case 'f': return { next: index + 2, text: '\f' };
    case 'v': return { next: index + 2, text: '\v' };
    case '\\': return { next: index + 2, text: '\\' };
    case '"': return { next: index + 2, text: '"' };
    case "'": return { next: index + 2, text: "'" };
    case '/': return { next: index + 2, text: '/' };
    case '?': return { next: index + 2, text: '?' };
    case 'x':
    case 'X': {
      let value = 0;
      let count = 0;
      let cursor = index + 2;
      while (count < 2) {
        const digit = source[cursor];
        if (digit === undefined) break;
        const parsed = hexValue(digit);
        if (parsed === undefined) break;
        value = value * 16 + parsed;
        cursor++;
        count++;
      }
      if (count === 0) throw new Error('Invalid hex escape in string literal');
      return { next: cursor, byte: value };
    }
    case 'u':
    case 'U': {
      const width = ch === 'u' ? 4 : 8;
      let value = 0;
      let cursor = index + 2;
      for (let offset = 0; offset < width; offset++) {
        const digit = source[cursor];
        const parsed = digit === undefined ? undefined : hexValue(digit);
        if (parsed === undefined) throw new Error('Invalid unicode escape in string literal');
        value = value * 16 + parsed;
        cursor++;
      }
      if (value > 0x10ffff) throw new Error('Unicode escape out of range in string literal');
      return { next: cursor, text: String.fromCodePoint(value) };
    }
    default: {
      if (ch >= '0' && ch <= '7') {
        let value = 0;
        let count = 0;
        let cursor = index + 1;
        while (count < 3) {
          const digit = source[cursor];
          if (digit === undefined || digit < '0' || digit > '7') break;
          value = value * 8 + digit.charCodeAt(0) - 48;
          cursor++;
          count++;
        }
        return { next: cursor, byte: value & 0xff };
      }
      return { next: index + 2, text: ch };
    }
  }
}

function flushByteRun(bytes: number[], out: string[]): void {
  if (bytes.length === 0) return;
  out.push(Buffer.from(bytes).toString('utf8'));
  bytes.length = 0;
}

function decodeStringLiteral(raw: string, bytes: number[], out: string[]): void {
  const end = raw.length - 1;
  let index = 1;
  let literalStart = index;
  while (index < end) {
    if (raw[index] !== '\\') {
      index++;
      continue;
    }
    if (literalStart < index) {
      flushByteRun(bytes, out);
      out.push(raw.slice(literalStart, index));
    }
    const escape = readEscape(raw, index);
    if (escape.byte === undefined) {
      flushByteRun(bytes, out);
      out.push(escape.text!);
    } else bytes.push(escape.byte);
    index = escape.next;
    literalStart = index;
  }
  if (literalStart < end) {
    flushByteRun(bytes, out);
    out.push(raw.slice(literalStart, end));
  }
}

function readStringToken(source: string, start: number): readonly [ProtoToken, number] {
  const quote = source[start]!;
  let index = start + 1;
  for (;;) {
    if (index >= source.length) throw new Error('Unterminated string literal in protobuf source');
    const ch = source[index]!;
    if (ch === quote) {
      const end = index + 1;
      return [{ kind: 'string', text: source.slice(start, end), start, end }, end];
    }
    if (ch === '\n' || ch === '\r') throw new Error('Unterminated string literal in protobuf source');
    if (ch === '\\') {
      index = readEscape(source, index).next;
      continue;
    }
    index++;
  }
}

function tokenizeProto(source: string): readonly ProtoToken[] {
  const tokens: ProtoToken[] = [];
  let index = 0;
  const length = source.length;
  while (index < length) {
    const ch = source[index]!;
    if (isWhitespace(ch)) { index++; continue; }
    if (ch === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < length && source[index] !== '\n') index++;
      continue;
    }
    if (ch === '/' && source[index + 1] === '*') {
      index += 2;
      let closed = false;
      while (index < length) {
        if (source[index] === '*' && source[index + 1] === '/') { index += 2; closed = true; break; }
        index++;
      }
      if (!closed) throw new Error('Unterminated block comment in protobuf source');
      continue;
    }
    if (ch === '#') { index++; while (index < length && source[index] !== '\n') index++; continue; }
    if (ch === '"' || ch === "'") {
      const [token, next] = readStringToken(source, index);
      tokens.push(token);
      index = next;
      continue;
    }
    if (isIdentStart(ch)) {
      const start = index++;
      while (index < length && isIdentPart(source[index]!)) index++;
      tokens.push({ kind: 'ident', text: source.slice(start, index), start, end: index });
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && source[index + 1] !== undefined && source[index + 1]! >= '0' && source[index + 1]! <= '9')) {
      const start = index++;
      const hexadecimal = ch === '0' && (source[index] === 'x' || source[index] === 'X');
      while (index < length) {
        const next = source[index]!;
        if (isIdentPart(next) || next === '.') { index++; continue; }
        if (!hexadecimal && (next === '+' || next === '-') && (source[index - 1] === 'e' || source[index - 1] === 'E')) { index++; continue; }
        break;
      }
      tokens.push({ kind: 'number', text: source.slice(start, index), start, end: index });
      continue;
    }
    tokens.push({ kind: 'punct', text: ch, start: index, end: index + 1 });
    index++;
  }
  return tokens;
}

function skipBalanced(tokens: readonly ProtoToken[], index: number): number {
  const open = tokens[index]!.text;
  const close = CLOSERS[open]!;
  let depth = 0;
  let cursor = index;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (token.kind === 'punct' && token.text === open) depth++;
    else if (token.kind === 'punct' && token.text === close) {
      depth--;
      if (depth === 0) return cursor + 1;
    }
    cursor++;
  }
  throw new Error(`Unbalanced '${open}' in protobuf source`);
}

function skipStatement(tokens: readonly ProtoToken[], index: number): number {
  let cursor = index;
  let depth = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (token.kind !== 'punct') { cursor++; continue; }
    const text = token.text;
    if (text === '{') { depth++; cursor++; continue; }
    if (text === '}') {
      if (depth === 0) return cursor;
      depth--;
      cursor++;
      if (depth === 0) return cursor;
      continue;
    }
    if (text === '(' || text === '[' || text === '<') { cursor = skipBalanced(tokens, cursor); continue; }
    if (text === ';' && depth === 0) return cursor + 1;
    cursor++;
  }
  return cursor;
}

type Draft = {
  readonly list: DeclarationList;
  localId: string;
  name: string;
  readonly parent?: Draft;
  readonly options: OptionMessage;
  span?: ProtoSpan;
  readonly nameSpan: ProtoSpan;
};

type ParsedValue = { readonly values: OptionNode[]; readonly list: boolean; readonly span: ProtoSpan; readonly next: number };
type ParsedName = { readonly path: readonly string[]; readonly next: number };

class ProtoReader {
  private readonly tokens: readonly ProtoToken[];
  private readonly source: string;
  private index = 0;
  private packageName = '';
  private readonly fileOptions = optionMessage();
  private readonly drafts: Draft[] = [];

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenizeProto(source);
  }

  read(): ProtoFile {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!;
      let next: number;
      if (token.kind === 'ident' && token.text === 'package') next = this.readPackage(this.index);
      else if (token.kind === 'ident' && token.text === 'option') next = this.readOption(this.index, this.fileOptions);
      else if (token.kind === 'ident' && token.text === 'message') next = this.readNamedBody(this.index, 'message', 'messages', undefined);
      else if (token.kind === 'ident' && token.text === 'enum') next = this.readNamedBody(this.index, 'enum', 'enums', undefined);
      else if (token.kind === 'ident' && token.text === 'service') next = this.readNamedBody(this.index, 'service', 'services', undefined);
      else if (token.kind === 'ident' && token.text === 'extend') next = this.readExtend(this.index, undefined);
      else next = skipStatement(this.tokens, this.index);
      this.index = next > this.index ? next : this.index + 1;
    }
    const spans = new Map<string, ProtoSpan>();
    spans.set('', { start: 0, end: this.source.length });
    const output = new Map<DeclarationList, ProtoDeclaration[]>();
    for (const list of DECLARATION_LISTS) output.set(list, []);
    const indexes = new Map<DeclarationList, number>();
    for (const draft of this.drafts) {
      const index = indexes.get(draft.list) ?? 0;
      indexes.set(draft.list, index + 1);
      const pointer = `/${pointerSegment(draft.list)}/${index}`;
      if (draft.span !== undefined) spans.set(pointer, draft.span);
      spans.set(`${pointer}/name`, draft.nameSpan);
      const options = optionsJson(draft.options, `${pointer}/options`, spans);
      const id = this.qualify(draft.localId);
      const parent = draft.parent === undefined ? null : this.qualify(draft.parent.localId);
      output.get(draft.list)!.push({ id, name: draft.name, parent, options });
    }
    const options = optionsJson(this.fileOptions, '/options', spans);
    const data: ProtoDocument = {
      options,
      services: output.get('services')!,
      rpcs: output.get('rpcs')!,
      messages: output.get('messages')!,
      fields: output.get('fields')!,
      oneofs: output.get('oneofs')!,
      enums: output.get('enums')!,
      enumValues: output.get('enumValues')!,
      extensions: output.get('extensions')!,
    };
    return { data, spans };
  }

  private qualify(localId: string): string {
    return this.packageName === '' ? localId : `${this.packageName}.${localId}`;
  }

  private readPackage(start: number): number {
    let cursor = start + 1;
    const parts: string[] = [];
    while (cursor < this.tokens.length && this.tokens[cursor]!.text !== ';') {
      const token = this.tokens[cursor]!;
      if (token.kind === 'ident') parts.push(token.text);
      else if (token.text !== '.') throw new Error('Malformed package declaration in protobuf source');
      cursor++;
    }
    if (this.tokens[cursor]?.text !== ';') throw new Error('Unterminated package declaration in protobuf source');
    this.packageName = parts.join('.');
    return cursor + 1;
  }
  private createDraft(list: DeclarationList, name: string, localId: string, parent: Draft | undefined, nameToken: ProtoToken): Draft {
    const draft: Draft = {
      list,
      localId,
      name,
      ...(parent === undefined ? {} : { parent }),
      options: optionMessage(),
      nameSpan: { start: nameToken.start, end: nameToken.end },
    };
    this.drafts.push(draft);
    return draft;
  }

  private readNamedBody(start: number, kind: 'message' | 'enum' | 'service' | 'oneof', list: DeclarationList, parent: Draft | undefined): number {
    const nameToken = this.tokens[start + 1];
    if (nameToken === undefined || nameToken.kind !== 'ident' || this.tokens[start + 2]?.text !== '{') {
      throw new Error(`Malformed ${kind} declaration in protobuf source`);
    }
    const localId = parent === undefined ? nameToken.text : `${parent.localId}.${nameToken.text}`;
    const draft = this.createDraft(list, nameToken.text, localId, parent, nameToken);
    return this.readBody(start + 3, kind, draft, this.tokens[start]!.start);
  }

  private readExtend(start: number, parent: Draft | undefined): number {
    let cursor = start + 1;
    let sawName = false;
    while (cursor < this.tokens.length && this.tokens[cursor]!.text !== '{') {
      const token = this.tokens[cursor]!;
      if (token.kind === 'ident' || token.text === '.') sawName = true;
      else throw new Error('Malformed extend declaration in protobuf source');
      cursor++;
    }
    if (!sawName || this.tokens[cursor]?.text !== '{') throw new Error('Malformed extend declaration in protobuf source');
    return this.readBody(cursor + 1, 'extend', parent, this.tokens[start]!.start);
  }

  private readBody(start: number, kind: 'message' | 'oneof' | 'enum' | 'service' | 'rpc' | 'extend', owner: Draft | undefined, declarationStart: number): number {
    let cursor = start;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === '}') {
        if (kind === 'extend') return cursor + 1;
        const hasSemicolon = kind === 'rpc' && this.tokens[cursor + 1]?.text === ';';
        const end = hasSemicolon ? this.tokens[cursor + 1]!.end : token.end;
        if (owner !== undefined) owner.span = extendSpan(owner.span, { start: declarationStart, end });
        return cursor + (hasSemicolon ? 2 : 1);
      }
      if (token.text === ';') { cursor++; continue; }
      if (kind === 'message') {
        if (token.kind === 'ident' && token.text === 'message') cursor = this.readNamedBody(cursor, 'message', 'messages', owner);
        else if (token.kind === 'ident' && token.text === 'enum') cursor = this.readNamedBody(cursor, 'enum', 'enums', owner);
        else if (token.kind === 'ident' && token.text === 'extend') cursor = this.readExtend(cursor, owner);
        else if (token.kind === 'ident' && token.text === 'oneof') cursor = this.readNamedBody(cursor, 'oneof', 'oneofs', owner);
        else if (token.kind === 'ident' && token.text === 'option') cursor = this.readOption(cursor, owner!.options);
        else if (token.kind === 'ident' && (token.text === 'reserved' || token.text === 'extensions')) cursor = skipStatement(this.tokens, cursor);
        else cursor = this.readField(cursor, owner!, false);
      } else if (kind === 'oneof') {
        if (token.kind === 'ident' && token.text === 'option') cursor = this.readOption(cursor, owner!.options);
        else cursor = this.readField(cursor, owner!.parent, false);
      } else if (kind === 'enum') {
        if (token.kind === 'ident' && token.text === 'option') cursor = this.readOption(cursor, owner!.options);
        else if (token.kind === 'ident' && token.text === 'reserved') cursor = skipStatement(this.tokens, cursor);
        else cursor = this.readEnumValue(cursor, owner!);
      } else if (kind === 'service') {
        if (token.kind === 'ident' && token.text === 'option') cursor = this.readOption(cursor, owner!.options);
        else if (token.kind === 'ident' && token.text === 'rpc') cursor = this.readRpc(cursor, owner!);
        else cursor = skipStatement(this.tokens, cursor);
      } else if (kind === 'rpc') {
        if (token.kind === 'ident' && token.text === 'option') cursor = this.readOption(cursor, owner!.options);
        else cursor = skipStatement(this.tokens, cursor);
      } else if (kind === 'extend') cursor = this.readField(cursor, owner, true);
      if (cursor <= start) cursor++;
      start = cursor;
    }
    throw new Error(`Unterminated ${kind} body in protobuf source`);
  }

  private readRpc(start: number, service: Draft): number {
    const nameToken = this.tokens[start + 1];
    if (nameToken === undefined || nameToken.kind !== 'ident') throw new Error('Malformed rpc declaration in protobuf source');
    let cursor = start + 2;
    if (this.tokens[cursor]?.text !== '(') throw new Error('Malformed rpc signature in protobuf source');
    cursor = skipBalanced(this.tokens, cursor);
    if (this.tokens[cursor]?.text !== 'returns') throw new Error('Malformed rpc signature in protobuf source');
    cursor++;
    if (this.tokens[cursor]?.text !== '(') throw new Error('Malformed rpc signature in protobuf source');
    cursor = skipBalanced(this.tokens, cursor);
    if (this.tokens[cursor]?.kind === 'ident' && this.tokens[cursor]!.text === 'stream') cursor++;
    const rpcLocalId = `${service.localId}.${nameToken.text}`;
    const draft = this.createDraft('rpcs', nameToken.text, rpcLocalId, service, nameToken);
    const body = this.tokens[cursor];
    if (body?.text === ';') { draft.span = { start: this.tokens[start]!.start, end: body.end }; return cursor + 1; }
    if (body?.text !== '{') throw new Error('Malformed rpc declaration in protobuf source');
    return this.readBody(cursor + 1, 'rpc', draft, this.tokens[start]!.start);
  }


  private readField(start: number, parent: Draft | undefined, extension: boolean): number {
    let cursor = start;
    let equal = -1;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === '=') { equal = cursor; break; }
      if (token.text === '<') { cursor = skipBalanced(this.tokens, cursor); continue; }
      if (token.text === ';' || token.text === '{' || token.text === '}') throw new Error('Malformed field declaration in protobuf source');
      cursor++;
    }
    if (equal < 0) throw new Error('Malformed field declaration in protobuf source');
    const nameToken = this.tokens[equal - 1];
    const number = this.tokens[equal + 1];
    if (nameToken?.kind !== 'ident' || number?.kind !== 'number') throw new Error('Malformed field declaration in protobuf source');
    const list: DeclarationList = extension ? 'extensions' : 'fields';
    const localId = `${parent?.localId ?? ''}${parent === undefined ? '' : '.'}${nameToken.text}`;
    const draft = this.createDraft(list, nameToken.text, localId, parent, nameToken);
    cursor = equal + 2;
    if (this.tokens[cursor]?.text === '[') {
      const parsed = this.readInlineOptions(cursor, draft.options);
      cursor = parsed.next;
    }
    const token = this.tokens[cursor];
    if (token?.text === ';') {
      draft.span = { start: this.tokens[start]!.start, end: token.end };
      return cursor + 1;
    }
    if (token?.text === '{') {
      const groupName = nameToken.text;
      draft.name = groupName.toLowerCase();
      draft.localId = `${parent?.localId ?? ''}${parent === undefined ? '' : '.'}${draft.name}`;
      const messageLocalId = `${parent?.localId ?? ''}${parent === undefined ? '' : '.'}${groupName}`;
      const group = this.createDraft('messages', groupName, messageLocalId, parent, nameToken);
      const after = this.readBody(cursor + 1, 'message', group, this.tokens[start]!.start);
      const close = this.tokens[after - 1]!;
      draft.span = { start: this.tokens[start]!.start, end: close.end };
      group.span = { start: this.tokens[start]!.start, end: close.end };
      return after;
    }
    throw new Error('Malformed field declaration in protobuf source');
  }

  private readEnumValue(start: number, parent: Draft): number {
    const name = this.tokens[start];
    if (name?.kind !== 'ident' || this.tokens[start + 1]?.text !== '=') throw new Error('Malformed enum value declaration in protobuf source');
    let cursor = start + 2;
    if (this.tokens[cursor]?.text === '-') cursor++;
    if (this.tokens[cursor]?.kind !== 'number') throw new Error('Malformed enum value declaration in protobuf source');
    const localId = `${parent.localId}.${name.text}`;
    const draft = this.createDraft('enumValues', name.text, localId, parent, name);
    cursor++;
    if (this.tokens[cursor]?.text === '[') cursor = this.readInlineOptions(cursor, draft.options).next;
    if (this.tokens[cursor]?.text !== ';') throw new Error('Malformed enum value declaration in protobuf source');
    draft.span = { start: name.start, end: this.tokens[cursor]!.end };
    return cursor + 1;
  }

  private readOption(start: number, message: OptionMessage): number {
    const name = this.readOptionName(start + 1);
    if (this.tokens[name.next]?.text !== '=') throw new Error('Expected "=" after option name in protobuf source');
    const value = this.readValue(name.next + 1);
    if (this.tokens[value.next]?.text !== ';') throw new Error('Expected ";" after option in protobuf source');
    const end = this.tokens[value.next]!;
    assignOption(message, name.path, value.values, value.span, value.list, { start: this.tokens[start]!.start, end: end.end });
    return value.next + 1;
  }

  private readOptionName(start: number): ParsedName {
    let cursor = start;
    const path: string[] = [];
    let needSegment = true;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (needSegment) {
        if (token.text === '(') {
          cursor++;
          if (this.tokens[cursor]?.text === '.') cursor++;
          const parts: string[] = [];
          if (this.tokens[cursor]?.kind !== 'ident') throw new Error(this.tokens[cursor] === undefined ? 'Unterminated option name in protobuf source' : 'Malformed option name in protobuf source');
          parts.push(this.tokens[cursor++]!.text);
          while (this.tokens[cursor]?.text === '.' && this.tokens[cursor + 1]?.kind === 'ident') { parts.push(this.tokens[cursor + 1]!.text); cursor += 2; }
          if (this.tokens[cursor]?.text !== ')') throw new Error(this.tokens[cursor] === undefined ? 'Unterminated option name in protobuf source' : 'Malformed option name in protobuf source');
          path.push(parts.join('.'));
          cursor++;
        } else if (token.kind === 'ident') { path.push(token.text); cursor++; }
        else throw new Error('Malformed option name in protobuf source');
        needSegment = false;
        continue;
      }
      if (token.text !== '.') return { path, next: cursor };
      cursor++;
      if (cursor >= this.tokens.length) throw new Error('Unterminated option name in protobuf source');
      needSegment = true;
    }
    if (needSegment) throw new Error('Unterminated option name in protobuf source');
    return { path, next: cursor };
  }

  private readInlineOptions(start: number, message: OptionMessage): { next: number } {
    let cursor = start + 1;
    while (cursor <= this.tokens.length) {
      if (this.tokens[cursor] === undefined) throw new Error('Unterminated inline options in protobuf source');
      if (this.tokens[cursor]!.text === ']') { cursor++; break; }
      const name = this.readOptionName(cursor);
      if (this.tokens[name.next]?.text !== '=') throw new Error('Malformed inline options in protobuf source');
      const value = this.readValue(name.next + 1);
      assignOption(message, name.path, value.values, value.span, value.list, { start: this.tokens[cursor]!.start, end: value.span.end });
      cursor = value.next;
      if (this.tokens[cursor]?.text === ',') {
        cursor++;
        if (this.tokens[cursor]?.text === ']') throw new Error('Malformed inline options in protobuf source');
      } else if (this.tokens[cursor] === undefined) throw new Error('Unterminated inline options in protobuf source');
      else if (this.tokens[cursor]?.text !== ']') throw new Error('Malformed inline options in protobuf source');
    }
    return { next: cursor };
  }

  private readValue(start: number): ParsedValue {
    const first = this.tokens[start];
    if (first === undefined || first.text === ';' || first.text === ']' || first.text === ',' || first.text === '}') throw new Error('Expected an option value in protobuf source');
    if (first.text === '-' && (this.tokens[start + 1]?.kind === 'number' || (this.tokens[start + 1]?.kind === 'ident' && !['true', 'false'].includes(this.tokens[start + 1]!.text)))) return this.scalarValue(start, start + 1, true);
    if (first.kind === 'number' || first.kind === 'string' || first.kind === 'ident') return this.scalarValue(start, start, false);
    if (first.text === '{' || first.text === '<') return this.messageValue(start);
    if (first.text === '[') return this.listValue(start);
    throw new Error('Malformed option value in protobuf source');
  }

  private scalarValue(start: number, tokenIndex: number, negative: boolean): ParsedValue {
    const first = this.tokens[start]!;
    const token = this.tokens[tokenIndex]!;
    let value: string | number | boolean;
    let cursor = tokenIndex + 1;
    let end = token.end;
    if (token.kind === 'string') {
      const parts: string[] = [];
      const bytes: number[] = [];
      cursor = tokenIndex;
      while (this.tokens[cursor]?.kind === 'string') {
        const stringToken = this.tokens[cursor]!;
        decodeStringLiteral(stringToken.text, bytes, parts);
        end = stringToken.end;
        cursor++;
      }
      flushByteRun(bytes, parts);
      value = parts.join('');
    } else if (token.kind === 'ident') value = !negative && (token.text === 'true' || token.text === 'false') ? token.text === 'true' : `${negative ? '-' : ''}${token.text}`;
    else value = parseNumber(token.text, negative);
    const startOffset = negative ? first.start : token.start;
    const span = { start: startOffset, end };
    const scalar: OptionScalar = { kind: 'scalar', value, span };
    return { values: [scalar], list: false, span, next: cursor };
  }

  private messageValue(start: number): ParsedValue {
    const open = this.tokens[start]!;
    const closeText = open.text === '{' ? '}' : '>';
    const message = optionMessage();
    let cursor = start + 1;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === closeText) {
        const span = { start: open.start, end: token.end };
        message.span = span;
        return { values: [message], list: false, span, next: cursor + 1 };
      }
      if (token.text === '}' || token.text === '>') throw new Error('Malformed option value in protobuf source');
      if (token.text === ',' || token.text === ';') { cursor++; continue; }
      if (token.kind !== 'ident' && token.text !== '[') throw new Error('Malformed option value in protobuf source');
      const key = this.readAggregateKey(cursor);
      cursor = key.next;
      if (this.tokens[cursor]?.text === ':') cursor++;
      const valueToken = this.tokens[cursor];
      if (valueToken === undefined) throw new Error('Unterminated option value in protobuf source');
      if (valueToken.kind !== 'ident' && valueToken.kind !== 'number' && valueToken.kind !== 'string' && valueToken.text !== '-' && valueToken.text !== '{' && valueToken.text !== '<' && valueToken.text !== '[') {
        throw new Error('Malformed option value in protobuf source');
      }
      const value = this.readValue(cursor);
      assignOption(message, [key.key], value.values, value.span, value.list, { start: key.start, end: value.span.end });
      cursor = value.next;
    }
    throw new Error('Unterminated option value in protobuf source');
  }

  private readAggregateKey(start: number): { key: string; next: number; start: number } {
    const token = this.tokens[start]!;
    if (token.kind === 'ident') return { key: token.text, next: start + 1, start: token.start };
    if (token.text !== '[') throw new Error('Malformed option value in protobuf source');
    let cursor = start + 1;
    let key = '';
    while (cursor < this.tokens.length && this.tokens[cursor]!.text !== ']') key += this.tokens[cursor++]!.text;
    if (this.tokens[cursor]?.text !== ']') throw new Error('Unterminated option value in protobuf source');
    if (cursor === start + 1) throw new Error('Malformed option value in protobuf source');
    return { key, next: cursor + 1, start: token.start };
  }

  private listValue(start: number): ParsedValue {
    const open = this.tokens[start]!;
    const values: OptionNode[] = [];
    let cursor = start + 1;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === ']') return { values, list: true, span: { start: open.start, end: token.end }, next: cursor + 1 };
      if (token.text === ',') { cursor++; continue; }
      if (token.text === ';' || token.text === '}') throw new Error('Malformed option value in protobuf source');
      const value = this.readValue(cursor);
      if (value.list || value.values.length !== 1) throw new Error('Malformed option value in protobuf source');
      values.push(value.values[0]!);
      cursor = value.next;
    }
    throw new Error('Unterminated option value in protobuf source');
  }
}

function parseNumber(text: string, negative: boolean): string | number {
  const signed = `${negative ? '-' : ''}${text}`;
  if (/^(?:0|[1-9][0-9]*)$/.test(text)) {
    const value = Number(text);
    return Number.isSafeInteger(value) ? (negative ? -value : value) : signed;
  }
  if (/^(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+(?=[eE]))(?:[eE][+-]?[0-9]+)?$/.test(text)) {
    const value = Number(signed);
    return Number.isFinite(value) ? value : signed;
  }
  return signed;
}

export function readProtoFile(source: string): ProtoFile {
  return new ProtoReader(source).read();
}
