import { JSONPath } from 'jsonpath-plus';

export function assertNonExecutable(selector: string, where: string): void {
  for (const token of JSONPath.toPathArray(selector)) {
    if (token.startsWith('?(') || token.startsWith('(')) {
      throw new Error(`The ${where} must not contain executable JSONPath expressions`);
    }
  }
}
