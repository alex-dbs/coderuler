---
title: AI checks
description: Configure optional Jev checks, customize selected input, and understand decisions and cost.
section: Build rules
order: 7
---

# AI checks

Use AI when a policy needs judgment about meaning that deterministic code cannot express. Keep file selection, required-data checks, and applicability deterministic.

The built-in AI backend is Jev from [Typesafe](https://typesafe.ai/). AI is optional. Deterministic rules do not need an API key.

## Configure the service

Set environment variables in the process that runs RuleKeeper:

```sh
export TYPESAFE_API_KEY='your-api-key'
export TYPESAFE_DEFAULT_MODEL='jev-latest'
```

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | None | Required credential for live calls |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Service base URL |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Default model |
| `RK_BACKEND` | `jev` | Built-in decision backend |
| `RK_THRESHOLD` | `0.4` | Decision threshold |
| `RK_INPUT_COST_PER_MILLION` | `0.042` | Estimated USD per million input tokens |
| `RK_OUTPUT_COST_PER_MILLION` | `0` | Estimated USD per million output tokens |

The key is required only when an AI call runs. Do not commit credentials to rules or fixtures.

## Write a focused policy

Save this module as `.rulekeeper/actionable-instructions.rule.ts`:

```ts
import { Rule, ai, test } from '@alex-dbs/rulekeeper';

export default class ActionableInstructions extends Rule {
  files = ['guides/**/*.md'];
  check = ai({
    rule: 'Instructions name a concrete action and its observable completion condition.',
    examples: {
      good: ['Run the migration until it exits successfully.'],
      bad: ['Handle the migration.'],
    },
    violationMessage: 'Name the action and how to recognize completion',
  });
}

export const aiTests = [
  test('a concrete instruction passes').withFiles({
    'guides/cache.md': 'Delete the cache directory. Finish when it no longer exists.',
  }).passes(),
];
```

`rule` is the semantic policy. State its exceptions and what visible evidence permits a violation. `examples.good` and `examples.bad` condition the model. `violationMessage` controls reporting and is not sent as an instruction.

`ai()` returns an evaluator. It validates its options at construction but makes no network request while the rule loads.

Run the live test only when you intend to contact the service:

```sh
rulekeeper test .rulekeeper/actionable-instructions.rule.ts --ai --timeout 45s
```

Both `check` and `inspect` run actual AI checks. They do not require a separate `--ai` flag. See [testing](/docs/testing/) for the offline/live distinction.

## Advanced: customize the input

By default, AI receives the selected scopes, including their path and scope metadata, plus the rule instruction and examples. It does not receive the whole repository. Scope selection keeps the review context focused.

Use the `input` option to reduce the context further. This example sends only the selected source text:

```ts
import { Rule, ai } from '@alex-dbs/rulekeeper';

export default class ActionableInstructions extends Rule {
  files = ['guides/**/*.md'];
  check = ai({
    rule: 'Instructions name a concrete action and its observable completion condition.',
    input: subject => subject.kind === 'scope'
      ? subject.source
      : subject.members.map(member => member.source),
  });
}
```

The [Go append rule](https://github.com/alex-dbs/rulekeeper/blob/main/.rulekeeper/go-append-slice.rule.ts) selects functions with an `append` call inside a loop. Its AI check decides whether the final length is known. Conditional appends can pass because their final count depends on the data.

## Understand decisions and precedence

The service returns a probability of compliance. A probability of `1` means compliant, and `0` means noncompliant. The threshold is the cutoff for a passing result. A result passes only when its probability is strictly greater than the effective threshold. Equality is a violation.

Threshold precedence is CLI `check --threshold` → rule `settings.threshold` → `RK_THRESHOLD` → `0.4`. The threshold must be finite and between `0` and `1`.

Backend and model use rule settings → environment → defaults. `RuleSettings.backend` supports `'jev'`. Set `model`, `threshold`, `inputCostPerMillion`, and `outputCostPerMillion` on a rule to override defaults.

## Cost

Costs depend on the service, model, input size, and billing terms. Configured token prices produce estimates, not a billing guarantee. They do not change the decision.

Inspection reports calls, unreported calls, token counts, and estimated input/output costs. Missing provider counts remain unreported. Totals cover reported usage only. Override inspection prices with `--input-cost-per-million` and `--output-cost-per-million`.

See the [author reference](https://github.com/alex-dbs/rulekeeper/blob/main/skills/rulekeeper-new-rule/reference.md#ai-options-examples-and-settings) and [settings source](https://github.com/alex-dbs/rulekeeper/blob/main/src/infra/settings.ts) for the exact contracts.
