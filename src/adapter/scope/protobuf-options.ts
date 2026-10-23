import type { JsonValue } from '../../app/rule.js';
import { pointerSegment } from './structured.js';

export type ProtoSpan = { readonly start: number; readonly end: number };

export type OptionScalar = { readonly kind: 'scalar'; readonly value: string | number | boolean; readonly span: ProtoSpan };

export type OptionMessage = { readonly kind: 'message'; readonly fields: Map<string, OptionField>; span?: ProtoSpan };

export type OptionNode = OptionScalar | OptionMessage;

type OptionField = { readonly values: OptionNode[]; repeated: boolean; span: ProtoSpan };

export function optionMessage(span?: ProtoSpan): OptionMessage {
  return span === undefined ? { kind: 'message', fields: new Map() } : { kind: 'message', fields: new Map(), span };
}

export function extendSpan(current: ProtoSpan | undefined, next: ProtoSpan): ProtoSpan {
  return current === undefined
    ? next
    : { start: Math.min(current.start, next.start), end: Math.max(current.end, next.end) };
}

export function addOptionField(message: OptionMessage, key: string, values: readonly OptionNode[], span: ProtoSpan, list: boolean): void {
  const field = message.fields.get(key);
  if (field === undefined) {
    message.fields.set(key, { values: [...values], repeated: list, span });
    return;
  }
  field.values.push(...values);
  field.repeated = true;
  field.span = extendSpan(field.span, span);
}

export function assignOption(
  root: OptionMessage,
  path: readonly string[],
  values: readonly OptionNode[],
  valueSpan: ProtoSpan,
  list: boolean,
  entrySpan: ProtoSpan,
): void {
  root.span = extendSpan(root.span, entrySpan);
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const field = current.fields.get(segment);
    if (field === undefined) {
      const child = optionMessage(entrySpan);
      current.fields.set(segment, { values: [child], repeated: false, span: entrySpan });
      current = child;
      continue;
    }
    const child = field.values[0];
    if (field.repeated || field.values.length !== 1 || child?.kind !== 'message') {
      throw new Error(`Option "${path.join('.')}" sets a field inside a non-message value`);
    }
    child.span = extendSpan(child.span, entrySpan);
    current = child;
  }
  addOptionField(current, path[path.length - 1]!, values, valueSpan, list);
}

export function optionsJson(message: OptionMessage, pointer: string, spans: Map<string, ProtoSpan>): { readonly [key: string]: JsonValue } {
  if (message.span !== undefined) spans.set(pointer, message.span);
  const result: Record<string, JsonValue> = {};
  for (const [key, field] of message.fields) {
    const childPointer = `${pointer}/${pointerSegment(key)}`;
    if (field.repeated) {
      spans.set(childPointer, field.span);
      const values = field.values.map((value, index) => nodeJson(value, `${childPointer}/${index}`, spans));
      Object.defineProperty(result, key, { value: values, enumerable: true, writable: true, configurable: true });
    } else {
      Object.defineProperty(result, key, { value: nodeJson(field.values[0]!, childPointer, spans), enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}

function nodeJson(node: OptionNode, pointer: string, spans: Map<string, ProtoSpan>): JsonValue {
  if (node.kind === 'scalar') {
    spans.set(pointer, node.span);
    return node.value;
  }
  return optionsJson(node, pointer, spans);
}

