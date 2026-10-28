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

Set environment variables in the process that runs CodeRuler:

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

Save this module as `.coderuler/actionable-instructions.rule.ts`:

```ts
import { Rule, ai, test } from '@alex-dbs/coderuler';

export default class ActionableInstructions extends Rule {
  files = ['guides/**/*.md'];
  check = ai({
    instruction: 'Each instruction names a clear action and a completion condition.',
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

Write `instruction` as the requirement for compliant content. Start with a direct statement of expected behavior. For example, use "Check each Go pointer for nil before dereferencing it," not "Report a violation when a pointer is dereferenced without a nil check."

Add only boundaries or real exceptions needed to define the policy. Keep one policy per instruction. Put reporting text in `violationMessage`, examples in `examples`, and cases in `aiTests`. Use `instruction` for new rules; the deprecated `rule` option remains accepted. Provide exactly one option.

Put every test case for an AI rule in `aiTests`; do not add a separate `tests` export. The fixed question is "Is the rule respected?" Yes/true means no problems. No/false means at least one violation. `examples.good` and `examples.bad` condition the model, and `violationMessage` controls reporting. Neither is an instruction.

For an imperative policy, write:

```ts
check = ai({ instruction: 'Return an error for invalid input.' });
```

`ai()` returns an evaluator. It validates its options at construction but makes no network request while the rule loads.

Run the live test only when you intend to contact the service:

```sh
coderuler test .coderuler/actionable-instructions.rule.ts --ai --ai-scores --timeout 45s
```

`--ai` authorizes live provider calls for `aiTests`. It requires the API key and can incur charges. `--ai-scores` displays each Jev probability, but does not authorize calls by itself. Both options are needed to run AI tests and display scores.

Compare instruction styles on the same fixtures, model version, examples, input, and threshold. Change only the instruction. Compliant cases need scores near `1`; violations need scores near `0`. Compare both groups separately and inspect individual regressions, not just averages. `PASS` means the test expectation matched, so a passing violation test still needs a low score. Repeat close comparisons, and do not change fixtures or thresholds to hide weak wording. See [testing](/docs/testing/) for running live cases. `check` and `inspect` also make live calls.

## Advanced: customize the input

By default, AI receives the selected scopes, including their path and scope metadata, plus the rule instruction and examples. It does not receive the whole repository. Keep Jev's input to the smallest scope that still supports a correct decision. For function-local code policies, use `scopes.astGrep` to select one function or method per scope and filter for relevant syntax, such as pointer dereferences.

Use the `input` option to reduce the context further. This example sends only the selected source text:

```ts
import { Rule, ai } from '@alex-dbs/coderuler';

export default class ActionableInstructions extends Rule {
  files = ['guides/**/*.md'];
  check = ai({
    instruction: 'Check that each instruction names a concrete action and an observable completion condition.',
    input: subject => subject.kind === 'scope'
      ? subject.source
      : subject.members.map(member => member.source),
  });
}
```

The [Go dereference guard](https://github.com/alex-dbs/coderuler/blob/main/.coderuler/go-dereference-guard.rule.ts) selects functions and methods with an explicit Go `*` operation. It sends the selected function and its Go file to the AI, so the AI can see pointer types in that file. A Go pointer dereference must be preceded by a nil check for that pointer on every path. Each nested pointer in the field path must have its own nil check. The rule does not send other files or check field access without an explicit `*`.

## Understand decisions and precedence

The service returns a probability of compliance. A probability of `1` means compliant, and `0` means noncompliant. The threshold is the cutoff for a passing result. A result passes only when its probability is strictly greater than the effective threshold. Equality is a violation.

Threshold precedence is CLI `check --threshold` → rule `settings.threshold` → `RK_THRESHOLD` → `0.4`. The threshold must be finite and between `0` and `1`.

Backend and model use rule settings → environment → defaults. `RuleSettings.backend` supports `'jev'`. Set `model`, `threshold`, `inputCostPerMillion`, and `outputCostPerMillion` on a rule to override defaults.

## Cost

Costs depend on the service, model, input size, and billing terms. Configured token prices produce estimates, not a billing guarantee. They do not change the decision.

Inspection reports calls, unreported calls, token counts, and estimated input/output costs. Missing provider counts remain unreported. Totals cover reported usage only. Override inspection prices with `--input-cost-per-million` and `--output-cost-per-million`.

See the [author reference](https://github.com/alex-dbs/coderuler/blob/main/skills/coderuler-new-rule/reference.md#ai-options-examples-and-settings) and [settings source](https://github.com/alex-dbs/coderuler/blob/main/src/infra/settings.ts) for the exact contracts.
