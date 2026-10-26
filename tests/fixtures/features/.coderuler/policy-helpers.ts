import type { CsvRow, JsonValue } from '@alex-dbs/coderuler';

export function isMapping(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRow(value: CsvRow | undefined): value is Readonly<Record<string, string>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}
