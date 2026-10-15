/**
 * One non-executable JSONPath selection grammar for every JSONPath selector this tool compiles: a
 * rule's `filter`, the YAML scope's own `path` and `key`, and the protobuf scope's `path`. Only the
 * `where` label differs between callers, so the rejection itself lives here once and every caller
 * keeps naming its own selector.
 */
import { JSONPath } from 'jsonpath-plus';

/**
 * Reject executable JSONPath at compile time on the normalized tokens the library would evaluate:
 * `[?(...)]` filters and `[(...)]` scripts are code, and quoting hides nothing because the library
 * normalizes `['(0)']` to the same `(0)` token as `[(0)]`.
 */
export function assertNonExecutable(selector: string, where: string): void {
  for (const token of JSONPath.toPathArray(selector)) {
    if (token.startsWith('?(') || token.startsWith('(')) {
      throw new Error(`The ${where} must not contain executable JSONPath expressions`);
    }
  }
}
