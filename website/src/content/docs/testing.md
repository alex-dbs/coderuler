---
title: Testing rules
description: Test rule behavior with temporary fixtures and separate offline and live AI cases.
section: Build rules
order: 6
---

# Testing rules

Inline tests live beside the rule as a named `tests` export. Each case creates a temporary project from its file map and runs the rule against those fixtures.

A passing test means the actual result matches the expected result. A test that expects a violation passes when the rule reports a violation.

## Write the cases

```ts
import { test } from '@alex-dbs/coderuler';

export const tests = [
  test('internal URL passes').withFiles({
    'config/url.txt': '/internal/jobs',
  }).passes(),
  test('public URL violates').withFiles({
    'config/url.txt': '/public/jobs',
  }).violates(),
];
```

Use this export in the [quickstart rule](/docs/quickstart/). `test(name).withFiles(files)` accepts a nonblank name and a map of root-relative fixture paths to JSON-compatible values.

Strings become literal file content. Objects, arrays, numbers, booleans, and `null` become pretty-printed JSON. For YAML-specific syntax or several YAML documents, supply a string rather than an object.

The helper supports `.passes()`, `.violates()`, and `.skips()`. Use passing and violating examples when you create a policy. Skipped input does not reach the check, so a skip assertion does not prove policy behavior.

Each case uses a fresh temporary root. Rule modules can be reused by test workers, so do not rely on mutable module state or case order.

## Run offline tests

```sh
coderuler test .coderuler/internal-url.rule.ts
coderuler test
coderuler test . --failures-only --concurrency 4 --timeout 30s
```

An explicit module or directory replaces rule discovery. Without a path, the command tests discovered project and home rules. `--failures-only` hides successful case details, but keeps the summary.

A rule with `enabled = false` does not run its inline test cases.

The default concurrency is `1`. The default timeout is `10s` per case. `--timeout` accepts positive durations with `ms`, `s`, or `m`. A timed-out case fails, and later cases can still run.

Output stays in declaration order even with concurrent execution. A mismatch, including a timeout, exits with status `1`. Loading, validation, and execution failures exit with status `2`.

## Keep ordinary tests offline

Ordinary `tests` cannot use CodeRuler's AI decision backend. If a check calls it, the case fails with `Inline rule tests must not call the decision backend`.

This guard still applies to ordinary cases when the command also includes `--ai`. It is not a network sandbox: rule modules are trusted Node.js code and can call external APIs directly. Keep those calls out of offline tests.

Test deterministic selection and applicability with fixtures. Keep live semantic expectations in the separate `aiTests` export.

## Run live AI cases explicitly

```ts
export const aiTests = [
  test('a concrete instruction passes').withFiles({
    'guides/cache.md': 'Delete the cache directory. Finish when it no longer exists.',
  }).passes(),
];
```

Use these cases with a matching AI rule, such as the example in [AI checks](/docs/ai-checks/). They use independent examples, not copies of the prompt's conditioning examples.

```sh
export TYPESAFE_API_KEY='your-api-key'
coderuler test .coderuler/actionable-instructions.rule.ts --ai --timeout 45s
```

`--ai` adds `aiTests` to the ordinary test cases. It authorizes live provider calls for those cases. The requests send selected fixture content to the configured service and can incur charges. Results can vary. Provider errors are errors, not passes.

## What validation does not test

`validate` checks rule structure, not TypeScript semantics or policy behavior. Neither `validate` nor `check` executes inline tests.

A selected rule set with no test cases from enabled rules is an error. If only `aiTests` exist, an ordinary `test` run tells you to include them with `--ai`. Do not use an empty dataset as a successful test run.

After tests pass, [inspect the rule](/docs/cli/#inspect) on representative project files. Fixtures cannot show whether your real project globs and data select the intended subjects.

See the [test helper source](https://github.com/alex-dbs/coderuler/blob/main/src/app/rule-tests.ts) and [worker implementation](https://github.com/alex-dbs/coderuler/blob/main/src/adapter/filesystem/rule-test-worker.ts) for execution details.
