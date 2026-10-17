import { parse } from 'csv-parse/sync';

import type { CsvOptions, CsvRow } from '../../app/ports.js';
import type { ScopeMatch, ScopeSelector } from '../../app/rule.js';
import { textLineSpan } from './lines.js';

interface RawRecord {
  readonly record: readonly string[];
  readonly endByte: number;
}

interface LocatedRecord {
  readonly fields: readonly string[];
  readonly source: string;
  readonly lines: { readonly start: number; readonly end: number };
}

interface ResolvedCsvOptions {
  readonly headers: boolean;
  readonly delimiter: string;
  readonly key: string | undefined;
}

const LEADING_BREAKS = /^(?:\r\n|\r|\n)+/;
const TRAILING_BREAK = /(?:\r\n|\r|\n)$/;
const LINE_BREAKS = /\r\n|\r|\n/g;

function isSingleCodePoint(value: string): boolean {
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined && value.length === (codePoint > 0xffff ? 2 : 1);
}

function resolveOptions(options?: CsvOptions): ResolvedCsvOptions {
  const headers = options?.headers === undefined ? true : options.headers;
  if (typeof headers !== 'boolean') throw new Error('The CSV "headers" option must be a boolean');

  const delimiter = options?.delimiter === undefined ? ',' : options.delimiter;
  if (
    typeof delimiter !== 'string'
    || !isSingleCodePoint(delimiter)
    || delimiter === '"'
    || delimiter === '\r'
    || delimiter === '\n'
  ) {
    throw new Error('The CSV "delimiter" must be a single character other than CR, LF, or a quote');
  }

  const key: unknown = options?.key;
  if (key !== undefined) {
    if (typeof key !== 'string' || key === '') throw new Error('The CSV "key" must be a non-empty string');
    if (!headers) throw new Error('The CSV "key" option requires headers');
  }

  return { headers, delimiter, key };
}

function parseRecords(source: string, delimiter: string): readonly RawRecord[] {
  let parsed: unknown;
  try {
    parsed = parse(source, {
      bom: true,
      cast: false,
      delimiter,
      info: true,
      relax_column_count: false,
      skip_empty_lines: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`CSV source could not be parsed: ${reason}`);
  }
  if (!Array.isArray(parsed)) throw new Error('CSV source could not be parsed: unexpected parser output');

  return parsed.map((entry) => {
    const candidate: unknown = entry;
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error('CSV source could not be parsed: unexpected record shape');
    }
    const record: unknown = 'record' in candidate ? candidate.record : undefined;
    const info: unknown = 'info' in candidate ? candidate.info : undefined;
    const endByte: unknown =
      info !== null && typeof info === 'object' && 'bytes' in info ? info.bytes : undefined;
    if (
      !Array.isArray(record)
      || typeof endByte !== 'number'
      || !Number.isInteger(endByte)
      || endByte < 0
    ) {
      throw new Error('CSV source could not be parsed: unexpected record shape');
    }
    return { record, endByte };
  });
}

function locateRecords(source: string, records: readonly RawRecord[]): readonly LocatedRecord[] {
  const located: LocatedRecord[] = [];
  let charIndex = 0;
  let byteIndex = 0;
  let sliceStart = 0;
  let startLine = 1;
  for (const record of records) {
    while (byteIndex < record.endByte) {
      const codePoint = source.codePointAt(charIndex);
      if (codePoint === undefined) {
        throw new Error('CSV source could not be parsed: record offset exceeds the source');
      }
      byteIndex += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
      charIndex += codePoint > 0xffff ? 2 : 1;
    }
    let sliced = source.slice(sliceStart, charIndex);
    if (sliceStart === 0 && sliced.charCodeAt(0) === 0xfeff) sliced = sliced.slice(1);
    sliceStart = charIndex;
    const leading = sliced.match(LEADING_BREAKS)?.[0] ?? '';
    startLine += leading.match(LINE_BREAKS)?.length ?? 0;
    const text = sliced.slice(leading.length).replace(TRAILING_BREAK, '');
    located.push({ fields: record.record, source: text, lines: textLineSpan(startLine, text) });
    startLine += (text.match(LINE_BREAKS)?.length ?? 0) + 1;
  }
  return located;
}

function headerNames(located: LocatedRecord | undefined): readonly string[] {
  if (located === undefined) return [];
  const names = new Set<string>();
  for (const name of located.fields) {
    if (name === '') throw new Error('CSV header names must be nonempty');
    if (names.has(name)) throw new Error(`CSV header names must be unique but "${name}" appears twice`);
    names.add(name);
  }
  return located.fields;
}

function toRecord(header: readonly string[], fields: readonly string[]): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  header.forEach((name, index) => {
    const value = fields[index];
    if (value === undefined) throw new Error('CSV record has fewer fields than its header');
    Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
  });
  return record;
}

function rowsOf(located: readonly LocatedRecord[], options: ResolvedCsvOptions): readonly CsvRow[] {
  if (!options.headers) return located.map(record => record.fields);
  const header = headerNames(located[0]);
  return located.slice(1).map(record => toRecord(header, record.fields));
}

export function parseCsv(source: string, options?: CsvOptions): readonly CsvRow[] {
  const resolved = resolveOptions(options);
  return rowsOf(locateRecords(source, parseRecords(source, resolved.delimiter)), resolved);
}

function selectScopes(source: string, options: ResolvedCsvOptions): readonly ScopeMatch<CsvRow>[] {
  const located = locateRecords(source, parseRecords(source, options.delimiter));
  if (!options.headers) {
    return located.map((record, index) => ({
      id: `row:${index + 1}`,
      source: record.source,
      data: record.fields,
      lines: record.lines,
    }));
  }

  const header = headerNames(located[0]);
  const column = options.key;
  if (column !== undefined && !header.includes(column)) {
    throw new Error(`The CSV key column "${column}" is not present in the header`);
  }

  const ids = new Set<string>();
  return located.slice(1).map((record, index) => {
    const data = toRecord(header, record.fields);
    const key = column === undefined ? undefined : data[column];
    if (column !== undefined && (key === undefined || key === '')) {
      throw new Error(`The CSV key column "${column}" is blank in data row ${index + 1}`);
    }
    const id = key ?? `row:${index + 1}`;
    if (ids.has(id)) throw new Error(`CSV scope ids must be unique but "${id}" appears twice`);
    ids.add(id);
    return { id, source: record.source, data, lines: record.lines };
  });
}

export function csv(options?: CsvOptions): ScopeSelector<CsvRow> {
  const resolved = resolveOptions(options);
  return ({ source }) => selectScopes(source, resolved);
}
