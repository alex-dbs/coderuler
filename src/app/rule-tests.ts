import type { JsonValue } from './rule.js';

export interface RuleTestCase {
  readonly name: string;
  readonly files: Readonly<Record<string, JsonValue>>;
  readonly expected: 'pass' | 'violation' | 'skipped';
}

export interface RuleTestResult {
  readonly ruleName: string;
  readonly name: string;
  readonly expected: RuleTestCase['expected'];
  readonly actual: RuleTestCase['expected'] | 'timeout';
  readonly durationMs: number;
}

export function test(name: string) {
  return {
    withFiles(files: RuleTestCase['files']) {
      return {
        passes: (): RuleTestCase => ({ name, files, expected: 'pass' }),
        violates: (): RuleTestCase => ({ name, files, expected: 'violation' }),
        skips: (): RuleTestCase => ({ name, files, expected: 'skipped' }),
      };
    },
  };
}
