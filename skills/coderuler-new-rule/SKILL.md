---
name: coderuler-new-rule
description: Create CodeRuler rules, including custom selection, filters and checks, inline tests, and inspection.
---

# Create a CodeRuler rule

Use the installed `coderuler` CLI from the project root. In commands, `.` means this project. Import the public SDK from `@alex-dbs/coderuler`.

For all rule options, read [reference.md](reference.md) when that branch is needed.

## 1. Define the policy

Establish:

- **Applicability:** which files and scopes belong to this policy, and which data must exist?
- **Decision:** what exact condition separates a pass from a violation?
- **Evidence:** one realistic violation, one compliant counterpart, and the boundaries that could change the decision.

Each rule must check exactly one thing. Split independent checks into separate rules.

Use deterministic code for structural, numeric, equality, and pattern policies. Use AI when the decision genuinely requires semantic judgment; keep selection and applicability deterministic.

## 2. Write the dataset, then the rule

Create `.coderuler/<name>.rule.ts` and default-export a class extending `Rule`. The filename supplies the rule name. Supported module suffixes are `.rule.ts`, `.rule.mts`, `.rule.js`, and `.rule.mjs`; helper modules use ordinary filenames.

Start the name with its language or technology prefix, such as `go-`, `ts-`, or `pg-`, followed by the policy.

Keep rules short, with only a few lines of policy code. Reuse built-in selectors, evaluators, and standard libraries before writing custom logic. Add helpers only for real reuse.

Add a named `tests` export in the same file. Use `.passes()` and `.violates()` cases that exercise the policy. Omit `.skips()` assertions when creating a rule: skipped inputs never reach the check and provide no evidence of policy behavior.

Run the relevant cases before the policy change and require an assertion mismatch for the intended violation, not a loading error. Implement the policy, then require every case to pass.

This complete example requires at least two replicas whenever `spec.replicas` is an integer:

```ts
import { Rule, pass, scopes, test, violation } from '@alex-dbs/coderuler';
import type { Evaluator, ScopeSubject } from '@alex-dbs/coderuler';

type Deployment = { replicas: number };

export default class ReplicaFloor extends Rule<Deployment> {
  files = ['deploy/**/*.yml'];
  scope = scopes.yaml<Deployment>({ path: '$.spec' });

  filter({ data }: ScopeSubject<Deployment>) {
    return {
      applies: data !== null && typeof data === 'object'
        && Number.isInteger(data.replicas),
      reason: 'Requires an integer spec.replicas',
    };
  }

  check: Evaluator<Deployment> = subject => {
    const { replicas } = (subject as ScopeSubject<Deployment>).data!;
    return replicas >= 2 ? pass() : violation(`Set spec.replicas to at least 2; found ${replicas}`);
  };
}

export const tests = [
  test('the minimum replica count passes').withFiles({
    'deploy/api.yml': { spec: { replicas: 2 } },
  }).passes(),
  test('one replica violates').withFiles({
    'deploy/api.yml': { spec: { replicas: 1 } },
  }).violates(),
  test('zero is a real value, not missing data').withFiles({
    'deploy/api.yml': { spec: { replicas: 0 } },
  }).violates(),
];
```

Save it as `.coderuler/k8s-replica-floor.rule.ts`. The scope cast reflects the fixed default `group = 'scope'`; the non-null assertion reflects the filter's required-data precondition. A TypeScript generic describes expected data; the filter still establishes that shape at runtime. If a missing or malformed field is itself a violation, select its enclosing object and check that requirement instead of filtering it away.

## 3. Validate and run the tests

For the example:

```sh
coderuler validate .coderuler/k8s-replica-floor.rule.ts
coderuler test .coderuler/k8s-replica-floor.rule.ts
```

Then run the project's rules and their datasets:

```sh
coderuler validate
coderuler test
```

`validate` checks the module contract, not policy behavior or TypeScript semantics. `check` and `validate` do not execute inline tests. `test` with no selected cases is an error, not success.

Useful test options:

```sh
coderuler test . --failures-only
coderuler test . --concurrency 4 --timeout 30s
coderuler test .coderuler/k8s-semantic-policy.rule.ts --ai --timeout 45s
```

Replace the semantic-policy filename with the actual AI rule. `--ai` authorizes live provider calls for `aiTests`, requires provider configuration, and may incur charges. Outcomes can vary; provider errors are errors, not passes.

## 4. Inspect the rule on the project

Tests use temporary fixtures. Inspection uses actual files under `.`; create representative project data there if none exists yet.

```sh
coderuler inspect .coderuler/k8s-replica-floor.rule.ts .
coderuler inspect k8s-replica-floor . --json
```

An exact rule name uses discovery; a module path selects that file directly. Inspection accepts one rule, not a directory. Use one output format at a time (`--json`, `--jsonl`, or `--raw`).

Follow the pipeline:

`enabled → when → select → filter → group → check`

- **No files/scopes:** check globs, exclusions, selector paths, and the inspected root.
- **Filtered scopes:** read the applicability reason; confirm the filter excludes only out-of-policy data.
- **Unexpected decision:** inspect selected `data`/`source`, captures, group membership, and the result. Use `context.trace(message, details)` inside hooks/checks when intermediate domain values would explain the decision.
- **Runtime error:** fix invalid data, parsing, or implementation behavior; converting an error into a pass hides a broken rule.

Inspection runs the actual check, including live AI calls when present.

Finally exercise normal evaluation:

```sh
coderuler check . --rules .coderuler/k8s-replica-floor.rule.ts --output-all
```

## Good and bad practices

| Prefer | Avoid |
| --- | --- |
| Narrow selection, applicability in `when`/`filter`, policy in `check` | Repeating guards in the check or filtering out the violations the rule should report |
| A function-valued `check = ...` or typed `check: Evaluator<T> = ...` | A `check(...)` method instead of the required property |
| Actionable violations naming the field/value and required correction | Generic messages with no location-specific reason |
| Pure per-subject decisions and local state | Results depending on concurrent check order or mutable module caches |
| Real failing-before/passing-after datasets and an inspected applicable subject | Merely validating imports, running without selected subjects, or treating a skip as a pass |
