import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runRuleTests } from '../dist/adapter/filesystem/rule-tests.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const loader = createRuleLoader();
const rules = await loader.load({
  root: repoRoot,
  explicit: join(repoRoot, '.coderuler'),
  invocationCwd: repoRoot,
});

// These are behavior tests; project evaluation keeps non-security rules disabled.
for (const result of await runRuleTests(rules, undefined, 10_000, 4, false, true)) {
  test(`rule: ${result.ruleName}: ${result.name}`, () => {
    assert.equal(result.actual, result.expected);
  });
}

