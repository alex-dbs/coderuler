# Rulekeeper
<p align="center">
  <img src="rulekeeper-icon.webp" alt="Rulekeeper shield logo" width="144">
</p>

Do your AI  agents keep missing rules from your prompts / AGENTS.md? If repeated agent reviews are eating time and tokens, move those policies into executable code. Rulekeeper runs the same rules against your working tree whenever you need them. It will never miss one! You can see it as linter on steroid.

Write deterministic rules in TypeScript (or JavaScript). When a policy needs judgment, send it to an AI decision API. AI rules use the selected scope as context by default, rather than sending the whole repository. You choose what each rule selects, so each AI request can stay focused.

## Install from source

Rulekeeper requires Node.js 24 or later. Git is required only when you use `check --diff`.

The package is not published to npm yet. In a repository checkout, install dependencies and build it:

```sh
npm ci
npm run build
```

Run the CLI from the checkout with `npm start --`. For example:

```sh
npm start -- --help
```

## Write a rule

Save rules in `.rulekeeper` (or any subfolders) with a name that ends in `.rule.ts`, `.rule.mts`, `.rule.js`, or `.rule.mjs`. A rule is a class that extends `Rule` and is the module's default export. Save the example below as `.rulekeeper/no-any.rule.ts`.

This rule reports explicit `any` types in TypeScript files. It also tests a violating case and a passing case:

```ts
import { Rule, scopes, test, violation } from 'rulekeeper';

export default class NoAny extends Rule {
  files = ['src/**/*.{ts,tsx}'];

  scope = scopes.astGrep({
    language: 'typescript',
    rule: {
      kind: 'predefined_type',
      pattern: { context: 'type ExplicitAny = any;', selector: 'predefined_type' },
    },
  });

  check = () => violation('Replace explicit any with a specific type or unknown and narrow it.');
}

export const tests = [
  test('explicit any violates').withFiles({
    'src/example.ts': 'let value: any;',
  }).violates(),
  test('a specific type passes').withFiles({
    'src/example.ts': 'let value: string;',
  }).passes(),
];
```

### Regular-expression rule

Use a regular expression for a pattern with a clear pass or fail condition. This rule selects HTTP binding URLs from protobuf files and requires versioned lowercase plural paths, such as `/v1/invoices`.

```ts
import { Rule, regex, scopes } from 'rulekeeper';

export default class PublicApiPaths extends Rule {
  files = ['api/**/*.proto'];
  scope = scopes.protobuf({ path: '$.rpcs[*].http.bindings[*].url' });
  check = regex({
    pattern: /^\/v\d+\/[a-z][a-z0-9_]*s(?:\/.*)?$/,
    violationMessage: 'Use a versioned lowercase plural path.',
  });
}
```

Add inline tests for paths that match and do not match the pattern.

### AI rule

Use an AI rule when a policy needs meaning or context that a fixed pattern cannot capture. This rule sends one selected function to the AI decision API, Jev from [Typesafe](https://typesafe.ai/).

```ts
import { Rule, ai, scopes } from 'rulekeeper';
import type { ScopeSubject } from 'rulekeeper';

export default class SafeResponseHeaders extends Rule {
  files = ['src/**/*.js'];
  scope = scopes.astGrep({
    language: 'javascript',
    rule: { kind: 'function_declaration' },
  });
  check = ai({
    rule: 'Report a violation only when this function writes request data into an HTTP response header without rejecting CR and LF first. Judge only this function. Do not assume unseen callers or helpers validate the data.',
    input: subject => (subject as ScopeSubject).source,
    violationMessage: 'Reject CR and LF in request data before writing a response header.',
  });
}
```

This example shows an AI check for CWE-113. The call cost depends on the configured model, input size, and token prices.

AI rules require a configured service and can incur charges.

> [!TIP]
> Keep the selected scope as small as the rule allows. A smaller input can reduce token costs and help the model focus on relevant code. Include enough context for the policy to make a sound decision.

Run validation, tests, and the rule against a project from the checkout:

```sh
npm start -- validate .rulekeeper/no-any.rule.ts
npm start -- test .rulekeeper/no-any.rule.ts
npm start -- check . --rules .rulekeeper/no-any.rule.ts
```

## Rule pipeline

A scope is a file or selected part of a file. Rulekeeper validates selected rules, then applies this pipeline to each rule:

`enabled → when → files and excludes → scope or select → filter → group → check → report`

- `enabled` defaults to `true`. Set it to `false` to disable a rule.
- `when(context)` runs once for each enabled rule before file selection. It defaults to `true`. Return `false` to skip the rule, or return `{ applies: false, reason: '...' }` to explain why. An example: apply a rule based on some conditions, for instance, the Go version of the project.
- `files` is a nonempty list of root-relative globs. It defaults to `['**/*']`. `exclude` is a list of root-relative globs that removes matching files. It defaults to `[]`.
- `scope` selects the parts of each file to evaluate. Without it, Rulekeeper uses one whole-file scope. Use `scopes.file()`, `scopes.json()`, `scopes.yaml()`, `scopes.csv()`, `scopes.protobuf()`, or `scopes.astGrep()` to choose the source or data.
- Override `select(context)` when you need custom file or scope selection. Call `context.select({ files, exclude, scope })` to reuse built-in selection.
- `filter(subject, context)` runs once per selected scope, before grouping. It defaults to `true`. Return `false` or `{ applies: false, reason: '...' }` to skip a scope. Put applicability and required-data checks here (null check for instance).
- `group` controls which scopes the evaluator sees together. It defaults to `'scope'`, which evaluates each scope separately. Set it to `'file'`, `'folder'`, `'project'`, or `{ by: 'folder', level }`. `folder` groups scopes within each containing folder. `project` groups all selected scopes together. `level` is a nonpositive integer.
- `check` is the required evaluator. Assign `regex(...)`, `ai(...)`, or a function as a property. Return `pass()` or `violation(message)` from a custom function.

The `settings` field sets AI options for one rule, such as its model, decision threshold, and input or output token prices.

> [!TIP]
> Browse the [`.rulekeeper` folder](.rulekeeper) for rule examples.

## Commands

- `validate [rule-path]` loads rules and validates their structure without running them.
- `test [rule-path]` runs the inline tests declared by selected rules.
- `check [path]` runs selected rules against a file or folder. It exits with status 1 when a rule reports a violation.
- `inspect <rule> [folder]` shows how one rule selects and evaluates subjects.
- `skill install` and `skill update` install or refresh Rulekeeper's rule-writing skill for coding agents.

Without an explicit rule path, Rulekeeper discovers rules under `.rulekeeper` in the project and `~/.rulekeeper` in the user home directory. Use `--help` after a command for its options.

## AI decisions

AI rules use Jev through Typesafe. Set `TYPESAFE_API_KEY` before running a rule that uses `ai()`. You can set `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` to choose the service URL and model. See [`.env.example`](.env.example) for the available environment variables and pricing defaults.

AI calls can send rule input to the configured service and can incur charges. The normal `test` command runs offline. Use `test --ai` to run cases declared as `aiTests`.

## FAQ

### Why not use a linter?

Use a linter for common syntax and style rules. Use Rulekeeper for project policies that need custom code, structured scopes, or AI judgment. The tools work well together.

### Why not use `AGENTS.md`?

`AGENTS.md` guides coding agents, but it does not enforce the instructions by itself. Rulekeeper runs executable rules against project files and reports violations. Use both when you need instructions and enforcement.

### Why not use a subagent?

A subagent can review code, but each review uses time and tokens. Rulekeeper lets you save recurring policies as rules and run them when needed. Use a subagent for broad reviews or questions that do not fit a rule.

### Why TypeScript or JavaScript?

Neither language is chosen for raw execution speed. Many developers already know one of them, and a rule can live in a single module. Rulekeeper keeps work focused with file and scope selection, and it bounds concurrency. We replace LONG and COSTLY AI Agent verification checks by predictable code, running at the speed of less than 1ms per verification; way faster than any LLM.

### Does Rulekeeper support every language?

Rules are TypeScript or JavaScript modules, but they can inspect text files in any language. AST rules use the built-in and bundled ast-grep grammars. If a language has no grammar, write a custom selector or evaluator that reads its source text.

### Can I do anything with a rule?

Rule modules are trusted Node.js code. You can write custom selectors, filters, and evaluators, and choose how Rulekeeper groups scopes. Rulekeeper does not sandbox rules, so run only code you trust.

## Contributing

Before you contribute, install dependencies and run the project checks from the repository root:

```sh
npm ci
npm run typecheck
npm test
```

Add or update tests for changes to rule behavior. The [rule-writing skill](skills/rulekeeper-new-rule/SKILL.md) explains how to create rules, add inline tests, and inspect rule behavior.

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).