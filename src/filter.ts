/**
 * Applicability filter: an optional rule-level predicate deciding whether one selected scope is
 * reviewed at all.
 *
 * A filter is a mapping holding exactly one operator, and its only leaf is `non_empty`, a
 * non-executable JSONPath selection over the {@link ScopeMatch} wrapper `{ id, source, data,
 * captures }`. Presence is structural, never truthy: `0` and `false` are real values, while an
 * absent, `null`, empty-string, empty-array or empty-object selection is not. Nothing is trimmed,
 * coerced, or evaluated, so a rule can never smuggle code through its filter.
 */
import { JSONPath } from 'jsonpath-plus';
import { assertNonExecutable } from './jsonpath.ts';
import type { ScopeMatch } from './plugins/index.ts';

/**
 * One applicability filter mapping as written in rule YAML. Exactly one operator per mapping:
 * `non_empty` tests a JSONPath selection, `all`/`any` combine a non-empty sequence of filters, and
 * `not` negates one nested filter.
 */
export type FilterDefinition =
  | { readonly non_empty: string }
  | { readonly all: readonly FilterDefinition[] }
  | { readonly any: readonly FilterDefinition[] }
  | { readonly not: FilterDefinition };

/** A compiled filter: whether one selected scope is applicable. */
export interface CompiledFilter {
  applies(scope: ScopeMatch): boolean;
}

/** The identity filter a rule without `filter` compiles to: every scope is applicable. */
const ACCEPT_ALL: CompiledFilter = { applies: () => true };

/** Narrow to a plain mapping (not an array or scalar). */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether one selected value is absent or empty. Absence, `null`, the empty string, the empty array
 * and the empty object are empty; every other value — including `0` and `false` — is present.
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Compile one `non_empty` leaf: a safe JSONPath over the scope wrapper, selected at match time. */
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

/** Compile an `all`/`any` group; every nested filter is compiled and validated up front. */
function compileGroup(operator: 'all' | 'any', value: unknown, active: Set<object>): CompiledFilter {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`rule.filter.${operator} must be a non-empty sequence of filters`);
  }
  const children = value.map(child => compileNode(child, active));
  return operator === 'all'
    ? { applies: scope => children.every(child => child.applies(scope)) }
    : { applies: scope => children.some(child => child.applies(scope)) };
}

/**
 * Compile one filter node. `active` holds every mapping on the current path, so a YAML alias cycle
 * (`filter: &f { not: *f }`) is rejected instead of recursing forever; a mapping reused without a
 * cycle is still accepted because it leaves `active` once its subtree is compiled.
 */
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

/** Compile a `not` node: the single negation of one nested filter. */
function compileNot(value: unknown, active: Set<object>): CompiledFilter {
  const child = compileNode(value, active);
  return { applies: scope => !child.applies(scope) };
}

/** Compile the optional `rule.filter`; a rule that omits it accepts every scope. */
export function compileFilter(definition: unknown): CompiledFilter {
  if (definition === undefined) return ACCEPT_ALL;
  return compileNode(definition, new Set<object>());
}
