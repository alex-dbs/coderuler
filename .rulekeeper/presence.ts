import type { JsonValue } from '@alex-dbs/rulekeeper';

export function isObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

export function isPresent(data: JsonValue | undefined, ...segments: string[]): boolean {
  let current: JsonValue | undefined = data;
  for (const segment of segments) {
    if (!isObject(current)) return false;
    current = current[segment];
  }
  return !isEmpty(current);
}
