import { JSONPath, JSONPathClass, type ReturnObject } from 'jsonpath-plus';

import { assertNonExecutable } from '../../app/jsonpath.js';
import type { JsonValue } from '../../app/rule.js';

export interface QueryMatch {
  readonly pointer: string;
  readonly value: JsonValue;
}

class SourcePointerJSONPath extends JSONPathClass {
  override _getPreferredOutput(match: ReturnObject): ReturnObject {
    const pointer = Array.isArray(match.path) && match.parentProperty !== null ? pointerOf(match.path) : undefined;
    super._getPreferredOutput(match);
    if (pointer !== undefined) match.pointer = pointer;
    return match;
  }
}

const PATH_PROBE = { a: { b: { c: 0 } }, items: [{ b: 0 }], list: [0] };

export function validatePath(path: string, label: string): void {
  if (typeof path !== 'string' || path === '') {
    throw new Error(`The ${label} must be a non-empty string`);
  }
  if (!path.startsWith('$')) throw new Error(`The ${label} must start with "$"`);
  assertNonExecutable(path, label);
  try {
    JSONPath({ path, json: PATH_PROBE, eval: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The ${label} "${path}" could not be evaluated: ${reason}`);
  }
}

export function query(data: JsonValue, path: string): readonly QueryMatch[] {
  if (path.trim() === '$') return [{ pointer: '', value: data }];

  let found: unknown;
  try {
    const engine = new SourcePointerJSONPath({ autostart: false, resultType: 'all', eval: false });
    found = engine.evaluate({ path, json: data, wrap: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The scope path "${path}" could not be evaluated: ${reason}`);
  }
  if (!Array.isArray(found)) return [];

  return found.map((entry) => {
    const { value, pointer } = entry as ReturnObject;
    if (typeof pointer !== 'string') {
      throw new Error(`The scope path "${path}" produced a match without a JSON pointer`);
    }
    return { pointer, value: value as JsonValue };
  });
}

function pointerOf(path: readonly (string | number)[]): string {
  let pointer = '';
  for (let index = 1; index < path.length; index += 1) {
    pointer += `/${String(path[index]).replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  return pointer;
}

export function pointerSegments(pointer: string): readonly string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Unexpected JSON pointer "${pointer}"`);
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function keyOf(data: JsonValue, path: string): string {
  let value: unknown = data;
  if (path.trim() !== '$') {
    const matches = query(data, path);
    if (matches.length !== 1) {
      throw new Error('The scope "key" selector must match exactly one value');
    }
    value = matches[0]?.value;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error('The scope "key" selector must resolve to a string or finite number');
}
