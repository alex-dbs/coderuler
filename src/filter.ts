import { JSONPath } from 'jsonpath-plus';
import { assertNonExecutable } from './jsonpath.ts';
import type { ScopeMatch } from './plugins/index.ts';

export type FilterDefinition =
  | { readonly non_empty: string }
  | { readonly all: readonly FilterDefinition[] }
  | { readonly any: readonly FilterDefinition[] }
  | { readonly not: FilterDefinition };

export interface CompiledFilter {
  applies(scope: ScopeMatch): boolean;
}

const ACCEPT_ALL: CompiledFilter = { applies: () => true };

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function compileNonEmpty(path: unknown): CompiledFilter {
  const where = 'rule.filter.non_empty';
  if (typeof path !== 'string') throw new Error(`${where} must be a non-empty JSONPath string`);
  if (!path.startsWith('$')) throw new Error(`${where} must be a JSONPath expression beginning with $`);
  assertNonExecutable(path, where);
  // The expression is validated now, not on first use: a selected file may yield no scopes at all,
  // and an invalid or executable path must fail then rather than look like an empty selection.
  try {
    JSONPath({ path, json: {}, eval: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${where} path "${path}": ${detail}`);
  }
  return {
    applies(scope: ScopeMatch): boolean {
      // `flatten: false` keeps each JSONPath result as the node the selector chose: a non-empty
      // array stays one present value instead of dissolving into its (possibly all-empty) elements.
      const selected = JSONPath({ path, json: scope, resultType: 'value', wrap: true, flatten: false, eval: false });
      return Array.isArray(selected) && selected.some(value => !isEmpty(value));
    },
  };
}

function compileGroup(operator: 'all' | 'any', value: unknown, active: Set<object>): CompiledFilter {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`rule.filter.${operator} must be a non-empty sequence of filters`);
  }
  const children = value.map(child => compileNode(child, active));
  return operator === 'all'
    ? { applies: scope => children.every(child => child.applies(scope)) }
    : { applies: scope => children.some(child => child.applies(scope)) };
}

function compileNode(value: unknown, active: Set<object>): CompiledFilter {
  if (!isMapping(value)) throw new Error('rule.filter must be a mapping with exactly one operator');
  if (active.has(value)) throw new Error('rule.filter must not contain a cycle');
  const operators = Object.keys(value);
  if (operators.length !== 1) {
    throw new Error('rule.filter must be a mapping with exactly one operator');
  }
  const operator = operators[0]!;
  active.add(value);
  try {
    switch (operator) {
      case 'non_empty':
        return compileNonEmpty(value.non_empty);
      case 'all':
      case 'any':
        return compileGroup(operator, value[operator], active);
      case 'not':
        return compileNot(value.not, active);
      default:
        throw new Error(`Unknown field: rule.filter.${operator}`);
    }
  } finally {
    active.delete(value);
  }
}

function compileNot(value: unknown, active: Set<object>): CompiledFilter {
  const child = compileNode(value, active);
  return { applies: scope => !child.applies(scope) };
}

export function compileFilter(definition: unknown): CompiledFilter {
  if (definition === undefined) return ACCEPT_ALL;
  return compileNode(definition, new Set<object>());
}
