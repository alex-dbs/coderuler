---
title: Writing rules
description: Build a focused rule with typed data, runtime filters, checks, and useful findings.
section: Build rules
order: 4
---

# Writing rules

Give each rule one policy. Define the applicable input, a violating example, and a passing counterpart before you write the check.

Save the module under `.coderuler/` with a supported rule suffix. Default-export a constructible class that extends `Rule`. Use ordinary modules for shared helpers, without a `.rule` suffix.

## A rule with structured data

This example allows an absent `spec.replicas`. For integer counts, it requires at least two replicas. Save it as `.coderuler/k8s-replica-floor.rule.ts`:

```ts
import { Rule, pass, scopes, test, violation } from '@alex-dbs/coderuler';
import type { Evaluator, ScopeSubject } from '@alex-dbs/coderuler';

type Deployment = { replicas?: number };

export default class ReplicaFloor extends Rule<Deployment> {
  files = ['deploy/**/*.yml'];
  scope = scopes.yaml<Deployment>({ path: '$.spec' });

  filter({ data }: ScopeSubject<Deployment>) {
    return {
      applies: data !== null && typeof data === 'object' && !Array.isArray(data)
        && (data.replicas === undefined || Number.isInteger(data.replicas)),
      reason: 'Requires a spec object with an absent or integer replicas count',
    };
  }

  check: Evaluator<Deployment> = subject => {
    const { replicas } = (subject as ScopeSubject<Deployment>).data!;
    return replicas === undefined || replicas >= 2
      ? pass()
      : violation(`Set spec.replicas to at least 2; found ${replicas}`);
  };
}

export const tests = [
  test('the minimum replica count passes').withFiles({
    'deploy/api.yml': { spec: { replicas: 2 } },
  }).passes(),
  test('an absent replica count passes').withFiles({
    'deploy/api.yml': { spec: {} },
  }).passes(),
  test('one replica violates').withFiles({
    'deploy/api.yml': { spec: { replicas: 1 } },
  }).violates(),
  test('zero is a real value, not missing data').withFiles({
    'deploy/api.yml': { spec: { replicas: 0 } },
  }).violates(),
];
```

The filter admits deployment spec objects with an absent or integer replica count. The check allows an absent count or a count of at least two.

## Define a check property

`check` must be a function-valued property, not a class method. Choose the type that fits your policy:

- `regex()` for a text pattern.
- `ai()` for a judgment about meaning.
- A custom function for calculations or parsed fields.

### Match text with `regex()`

This rule checks each whole file in `config/*.txt`. A match passes. A nonmatch violates the policy.

```ts
import { Rule, regex } from '@alex-dbs/coderuler';

export default class InternalUrl extends Rule {
  files = ['config/*.txt'];
  check = regex({
    pattern: /^\/internal\//,
    violationMessage: 'Use an /internal/ URL',
  });
}
```

For example, `/internal/jobs` passes and `/public/jobs` violates.

### Review meaning with `ai()`

AI checks are optional. Configure the provider in [AI checks](/docs/ai-checks/) before you run this rule.

This rule sends each whole guide file to the AI check:

```ts
import { Rule, ai } from '@alex-dbs/coderuler';

export default class ActionableInstructions extends Rule {
  files = ['guides/**/*.md'];
  check = ai({
    instruction: 'Check that each instruction names a concrete action and an observable completion condition.',
    examples: {
      good: ['Run the migration until it exits successfully.'],
      bad: ['Handle the migration.'],
    },
    violationMessage: 'Name the action and how to recognize completion',
  });
}
```

### Write a custom function

Use a function when the policy needs your own logic. The [ReplicaFloor example above](#a-rule-with-structured-data) selects `$.spec` and filters its data before this member runs. It includes the required imports and type:

```ts
check: Evaluator<Deployment> = subject => {
  const { replicas } = (subject as ScopeSubject<Deployment>).data!;
  return replicas === undefined || replicas >= 2
    ? pass()
    : violation(`Set spec.replicas to at least 2; found ${replicas}`);
};
```

A custom function receives the selected subject and a context object. Return `pass()` for compliance or `violation(message, locations?)` for a policy failure. Async functions can return the same results. Throw an error when execution fails.

## Use context helpers

The hooks receive `project` readers and `trace(message, details?)`. `select` also receives `context.select(...)`. Checks also receive `ruleName` and `context.ai(...)`.

| Project reader | Result |
| --- | --- |
| `project.glob(patterns)` | Eligible paths in lexical order |
| `project.hasFiles(patterns)` | Whether any eligible file matches |
| `project.stat(path)` | File/directory kind, or `undefined` for a missing path |
| `project.readText(path)` | Strict UTF-8 text |
| `project.readJson(path)` | Parsed JSON value |
| `project.readYaml(path)` | Values from nonempty YAML documents |
| `project.readCsv(path, options?)` | CSV records or arrays |

Reader paths are root-relative. Absolute paths, parent escapes, and symlink traversal are rejected. Readers throw for invalid or unreadable input. Do not convert those errors into empty data or passes.

Use traces for inspection evidence rather than ad-hoc console output. Keep instance and module state independent of evaluation order because checks can run concurrently.

## Attribute violations

A scope violation uses its source lines by default. A group violation does not automatically blame every member. Return locations for the offending members:

```ts
violation('This selected identifier is duplicated', [{
  filepath: member.filepath,
  scopeId: member.id,
}]);
```

Each location needs a real evaluated filepath and a scope ID, line span, or both. Line spans use positive, inclusive file coordinates. `locations: []` disables automatic scope attribution.

Use [inline tests](/docs/testing/) to exercise the policy. Then use `inspect` on real files before normal checks. See [configuration](/docs/configuration/) for members and [the full source reference](https://github.com/alex-dbs/coderuler/blob/main/skills/coderuler-new-rule/reference.md) for contracts.
