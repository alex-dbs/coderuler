import { Buffer } from 'node:buffer';

interface ProtoToken {
  readonly kind: 'ident' | 'number' | 'punct' | 'string';
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

type ProtoHttpBinding = {
  readonly method: string;
  readonly url: string;
};

type ProtoRpcData = {
  readonly id: string;
  readonly package: string;
  readonly service: string;
  readonly name: string;
  readonly http: { readonly bindings: readonly ProtoHttpBinding[] };
};

interface ProtoRpcRecord {
  readonly id: string;
  readonly source: string;
  readonly data: ProtoRpcData;
}

const STANDARD_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

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

type ProtoEscape = {
  readonly next: number;
  readonly text?: string;
  readonly byte?: number;
};

function readEscape(source: string, index: number): ProtoEscape {
  const ch = source[index + 1];
  if (ch === undefined) throw new Error('Unterminated escape sequence in string literal');
  switch (ch) {
    case 'n':
      return { next: index + 2, text: '\n' };
    case 'r':
      return { next: index + 2, text: '\r' };
    case 't':
      return { next: index + 2, text: '\t' };
    case 'a':
      return { next: index + 2, text: '\u0007' };
    case 'b':
      return { next: index + 2, text: '\b' };
    case 'f':
      return { next: index + 2, text: '\f' };
    case 'v':
      return { next: index + 2, text: '\v' };
    case '\\':
      return { next: index + 2, text: '\\' };
    case '"':
      return { next: index + 2, text: '"' };
    case "'":
      return { next: index + 2, text: "'" };
    case '/':
      return { next: index + 2, text: '/' };
    case '?':
      return { next: index + 2, text: '?' };
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
          value = value * 8 + (digit.charCodeAt(0) - 48);
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
    } else {
      bytes.push(escape.byte);
    }
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
    if (isWhitespace(ch)) {
      index++;
      continue;
    }
    if (ch === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < length && source[index] !== '\n') index++;
      continue;
    }
    if (ch === '/' && source[index + 1] === '*') {
      index += 2;
      let closed = false;
      while (index < length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          index += 2;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) throw new Error('Unterminated block comment in protobuf source');
      continue;
    }
    if (ch === '#') {
      index++;
      while (index < length && source[index] !== '\n') index++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const [token, next] = readStringToken(source, index);
      tokens.push(token);
      index = next;
      continue;
    }
    if (isIdentStart(ch)) {
      const start = index;
      index++;
      while (index < length && isIdentPart(source[index]!)) index++;
      tokens.push({ kind: 'ident', text: source.slice(start, index), start, end: index });
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = index;
      index++;
      while (index < length && (isIdentPart(source[index]!) || source[index] === '.')) index++;
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
    if (token.kind !== 'punct') {
      cursor++;
      continue;
    }
    const text = token.text;
    if (text === '{') {
      depth++;
      cursor++;
      continue;
    }
    if (text === '}') {
      if (depth === 0) return cursor;
      depth--;
      cursor++;
      if (depth === 0) return cursor;
      continue;
    }
    if (text === '(' || text === '[' || text === '<') {
      cursor = skipBalanced(tokens, cursor);
      continue;
    }
    if (text === ';' && depth === 0) return cursor + 1;
    cursor++;
  }
  return cursor;
}

interface CustomDraft {
  kind?: string;
  path?: string;
}

type RuleEntry =
  | { readonly kind: 'binding'; readonly method: string; readonly url: string }
  | { readonly kind: 'custom'; readonly draft: CustomDraft };

interface RuleDraft {
  readonly entries: RuleEntry[];
  readonly customs: CustomDraft[];
  currentAddition?: RuleDraft;
}

function additionDraft(rule: RuleDraft): RuleDraft {
  return rule.currentAddition ?? newAdditionDraft(rule);
}

function newAdditionDraft(rule: RuleDraft): RuleDraft {
  const child: RuleDraft = { entries: rule.entries, customs: [] };
  rule.currentAddition = child;
  return child;
}

function customDraft(rule: RuleDraft, field: 'kind' | 'path'): CustomDraft {
  for (let index = rule.customs.length - 1; index >= 0; index--) {
    const draft = rule.customs[index]!;
    if (draft[field] === undefined) return draft;
  }
  const draft: CustomDraft = {};
  rule.customs.push(draft);
  rule.entries.push({ kind: 'custom', draft });
  return draft;
}

function flattenRule(rule: RuleDraft, out: ProtoHttpBinding[]): void {
  for (const entry of rule.entries) {
    if (entry.kind === 'binding') out.push({ method: entry.method, url: entry.url });
    else out.push({ method: entry.draft.kind ?? '', url: entry.draft.path ?? '' });
  }
}

interface PendingRecord {
  readonly service: string;
  readonly name: string;
  readonly bindings: readonly ProtoHttpBinding[];
  readonly source: string;
}

class ProtoReader {
  private readonly tokens: readonly ProtoToken[];
  private readonly source: string;
  private index = 0;
  private packageName = '';
  private readonly records: PendingRecord[] = [];

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenizeProto(source);
  }

  read(): readonly ProtoRpcRecord[] {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!;
      let next: number;
      if (token.kind === 'ident' && token.text === 'package') next = this.readPackage();
      else if (token.kind === 'ident' && token.text === 'service') next = this.readService();
      else next = skipStatement(this.tokens, this.index);
      this.index = next > this.index ? next : this.index + 1;
    }
    return this.records.map((record) => {
      const id = [this.packageName, record.service, record.name].filter(Boolean).join('.');
      const data: ProtoRpcData = {
        id,
        package: this.packageName,
        service: record.service,
        name: record.name,
        http: { bindings: record.bindings },
      };
      return { id, source: record.source, data };
    });
  }

  private readPackage(): number {
    let cursor = this.index + 1;
    const parts: string[] = [];
    let closed = false;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === ';') {
        closed = true;
        cursor++;
        break;
      }
      if (token.kind === 'ident') parts.push(token.text);
      else if (token.text !== '.') throw new Error('Malformed package declaration in protobuf source');
      cursor++;
    }
    if (!closed) throw new Error('Unterminated package declaration in protobuf source');
    this.packageName = parts.join('.');
    return cursor;
  }

  private readService(): number {
    let cursor = this.index + 1;
    const nameToken = this.tokens[cursor];
    if (nameToken === undefined || nameToken.kind !== 'ident') throw new Error('Malformed service declaration in protobuf source');
    const serviceName = nameToken.text;
    cursor++;
    while (cursor < this.tokens.length && this.tokens[cursor]!.text !== '{') {
      if (this.tokens[cursor]!.text === ';') return cursor + 1;
      cursor++;
    }
    if (cursor >= this.tokens.length) throw new Error('Unterminated service declaration in protobuf source');
    cursor++;
    return this.readServiceBody(cursor, serviceName);
  }

  private readServiceBody(start: number, serviceName: string): number {
    let cursor = start;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === '}') return cursor + 1;
      if (token.kind === 'ident' && token.text === 'rpc') cursor = this.readRpc(cursor, serviceName);
      else {
        const next = skipStatement(this.tokens, cursor);
        cursor = next > cursor ? next : cursor + 1;
      }
    }
    throw new Error('Unterminated service body in protobuf source');
  }

  private readRpc(start: number, serviceName: string): number {
    const startOffset = this.tokens[start]!.start;
    let cursor = start + 1;
    const nameToken = this.tokens[cursor];
    if (nameToken === undefined || nameToken.kind !== 'ident') throw new Error('Malformed rpc declaration in protobuf source');
    const name = nameToken.text;
    cursor++;
    if (this.tokens[cursor]?.text !== '(') throw new Error('Malformed rpc signature in protobuf source');
    cursor = skipBalanced(this.tokens, cursor);
    if (this.tokens[cursor]?.text !== 'returns') throw new Error('Malformed rpc signature in protobuf source');
    cursor++;
    if (this.tokens[cursor]?.text !== '(') throw new Error('Malformed rpc signature in protobuf source');
    cursor = skipBalanced(this.tokens, cursor);

    let bindings: readonly ProtoHttpBinding[] = [];
    let endOffset: number;
    const bodyToken = this.tokens[cursor];
    if (bodyToken?.text === ';') {
      endOffset = bodyToken.end;
      cursor++;
    } else if (bodyToken?.text === '{') {
      const body = this.readRpcBody(cursor);
      bindings = body.bindings;
      cursor = body.next;
      const terminator = this.tokens[cursor];
      if (terminator?.text === ';') {
        endOffset = terminator.end;
        cursor++;
      } else {
        endOffset = body.closeEnd;
      }
    } else {
      throw new Error('Malformed rpc declaration in protobuf source');
    }

    this.records.push({
      service: serviceName,
      name,
      bindings,
      source: this.source.slice(startOffset, endOffset),
    });
    return cursor;
  }

  private readRpcBody(start: number): { bindings: readonly ProtoHttpBinding[]; next: number; closeEnd: number } {
    const rule: RuleDraft = { entries: [], customs: [] };
    let cursor = start + 1;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === '}') {
        const bindings: ProtoHttpBinding[] = [];
        flattenRule(rule, bindings);
        return { bindings, next: cursor + 1, closeEnd: token.end };
      }
      if (token.kind === 'ident' && token.text === 'option') cursor = this.readOption(cursor, rule);
      else {
        const next = skipStatement(this.tokens, cursor);
        cursor = next > cursor ? next : cursor + 1;
      }
    }
    throw new Error('Unterminated rpc body in protobuf source');
  }

  private readOption(start: number, rule: RuleDraft): number {
    if (this.tokens[start + 1]?.text !== '(') return skipStatement(this.tokens, start);
    const name = this.readOptionName(start + 1);
    if (name.name !== 'google.api.http') return skipStatement(this.tokens, start);
    let cursor = name.next;
    if (this.tokens[cursor]?.text === '=') cursor++;
    return this.assignHttpPath(name.fields, cursor, rule);
  }

  private readOptionName(start: number): { name: string; fields: readonly string[]; next: number } {
    let cursor = start + 1;
    let name = '';
    while (cursor < this.tokens.length && this.tokens[cursor]!.text !== ')') {
      const token = this.tokens[cursor]!;
      if (token.kind === 'ident' || token.text === '.') name += token.text;
      cursor++;
    }
    if (this.tokens[cursor]?.text !== ')') throw new Error('Unterminated option name in protobuf source');
    cursor++;
    const fields: string[] = [];
    while (this.tokens[cursor]?.text === '.' && this.tokens[cursor + 1]?.kind === 'ident') {
      fields.push(this.tokens[cursor + 1]!.text);
      cursor += 2;
    }
    return { name: name.replace(/^\.+/, ''), fields, next: cursor };
  }

  private assignHttpPath(fields: readonly string[], cursor: number, rule: RuleDraft): number {
    let target = rule;
    let index = 0;
    while (fields[index] === 'additional_bindings') {
      const terminal = index + 1 === fields.length;
      if (terminal && this.tokens[cursor]?.text === '[') return this.readBindingList(cursor, target);
      target = terminal ? newAdditionDraft(target) : additionDraft(target);
      index++;
    }
    const head = fields[index];
    if (head === undefined) {
      const form = this.tokens[cursor]?.text;
      if (form === '{') return this.readHttpRule(cursor, target);
      if (form === '<') return this.readHttpRule(cursor, target, '>');
      if (form === '[') return this.readBindingList(cursor, target);
      return skipStatement(this.tokens, cursor);
    }
    if (head === 'custom') {
      if (index + 1 === fields.length) return this.readCustom(cursor, target);
      const field = fields[index + 1];
      if (index + 2 === fields.length && (field === 'kind' || field === 'path')) {
        const value = this.readStringValue(cursor);
        const draft = customDraft(target, field);
        if (field === 'kind') draft.kind = value.value;
        else draft.path = value.value;
        return value.next;
      }
      return skipStatement(this.tokens, cursor);
    }
    const verb = STANDARD_VERBS[head];
    if (verb !== undefined && index + 1 === fields.length) {
      const value = this.readStringValue(cursor);
      target.entries.push({ kind: 'binding', method: verb, url: value.value });
      return value.next;
    }
    return skipStatement(this.tokens, cursor);
  }

  private readHttpRule(start: number, rule: RuleDraft, close = '}'): number {
    let cursor = start + 1;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === close) return cursor + 1;
      if (token.kind !== 'ident') {
        cursor++;
        continue;
      }
      const field = token.text;
      let valueStart = cursor + 1;
      if (this.tokens[valueStart]?.text === ':') valueStart++;
      const verb = STANDARD_VERBS[field];
      if (verb !== undefined) {
        const value = this.readStringValue(valueStart);
        rule.entries.push({ kind: 'binding', method: verb, url: value.value });
        cursor = value.next;
        continue;
      }
      if (field === 'custom') {
        cursor = this.readCustom(valueStart, rule);
        continue;
      }
      if (field === 'additional_bindings') {
        const form = this.tokens[valueStart]?.text;
        if (form === '{') {
          cursor = this.readHttpRule(valueStart, newAdditionDraft(rule));
          continue;
        }
        if (form === '<') {
          cursor = this.readHttpRule(valueStart, newAdditionDraft(rule), '>');
          continue;
        }
        if (form === '[') {
          cursor = this.readBindingList(valueStart, rule);
          continue;
        }
      }
      cursor = this.skipValue(valueStart);
    }
    throw new Error('Unterminated google.api.http option in protobuf source');
  }

  private readBindingList(start: number, rule: RuleDraft): number {
    let cursor = start + 1;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === ']') return cursor + 1;
      if (token.text === '{') {
        cursor = this.readHttpRule(cursor, newAdditionDraft(rule));
        continue;
      }
      if (token.text === '<') {
        cursor = this.readHttpRule(cursor, newAdditionDraft(rule), '>');
        continue;
      }
      cursor++;
    }
    throw new Error('Unterminated additional_bindings list in protobuf source');
  }

  private readCustom(start: number, rule: RuleDraft): number {
    const open = this.tokens[start]?.text;
    if (open !== '{' && open !== '<') return this.skipValue(start);
    const close = open === '{' ? '}' : '>';
    const draft: CustomDraft = {};
    rule.customs.push(draft);
    rule.entries.push({ kind: 'custom', draft });
    let cursor = start + 1;
    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.text === close) return cursor + 1;
      if (token.kind !== 'ident') {
        cursor++;
        continue;
      }
      const field = token.text;
      let valueStart = cursor + 1;
      if (this.tokens[valueStart]?.text === ':') valueStart++;
      if (field === 'kind' || field === 'path') {
        const value = this.readStringValue(valueStart);
        if (field === 'kind') draft.kind = value.value;
        else draft.path = value.value;
        cursor = value.next;
        continue;
      }
      cursor = this.skipValue(valueStart);
    }
    throw new Error('Unterminated custom http binding in protobuf source');
  }

  private readStringValue(start: number): { value: string; next: number } {
    const first = this.tokens[start];
    if (first === undefined || first.kind !== 'string') {
      throw new Error('Expected a string literal in google.api.http option');
    }
    const out: string[] = [];
    const bytes: number[] = [];
    let cursor = start;
    while (this.tokens[cursor]?.kind === 'string') {
      decodeStringLiteral(this.tokens[cursor]!.text, bytes, out);
      cursor++;
    }
    flushByteRun(bytes, out);
    return { value: out.join(''), next: cursor };
  }

  private skipValue(start: number): number {
    const token = this.tokens[start];
    if (token === undefined) return start;
    if (token.kind === 'punct' && CLOSERS[token.text] !== undefined) return skipBalanced(this.tokens, start);
    return start + 1;
  }
}

export function readRpcRecords(source: string): readonly ProtoRpcRecord[] {
  return new ProtoReader(source).read();
}
