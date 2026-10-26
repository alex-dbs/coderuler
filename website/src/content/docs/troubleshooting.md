---
title: Troubleshooting
description: Fix discovery, selection, test, dependency, AI, and GitHub failures.
section: Reference
order: 12
---

# Troubleshooting

Start with the explicit rule path. Validate its structure, run its fixtures, then inspect representative project files:

```sh
coderuler validate .coderuler/internal-url.rule.ts
coderuler test .coderuler/internal-url.rule.ts
coderuler inspect .coderuler/internal-url.rule.ts .
```

Replace the example path with your rule. Inspection executes the actual check, including live AI calls.

## The CLI does not start

Use Node.js `^24.15.0 || >=26.0.0`. Node.js 25 is outside that supported range. Run `node --version` in the same terminal or CI job as CodeRuler.

If `coderuler` is not on your PATH, use `npx coderuler` with a project-local installation. For a built source checkout, use `node /absolute/path/to/coderuler/dist/cli.js` from the project you want to analyze. Follow the [source installation steps](/docs/quickstart/#install) when the built file does not exist.

## No rule files are found

Discovery expects `.rule.ts`, `.rule.mts`, `.rule.js`, or `.rule.mjs` under the project or home `.coderuler/` directory. A plain `.ts` helper is not discovered as a rule.

Run from the intended project root. Use an explicit module path to separate a discovery problem from a loading problem. Discovery skips symlinks, `old`, `node_modules`, and temporary installation directories.

A duplicate name error lists the matching rule files. Rename one file or select one explicit module. A subfolder does not give a duplicate filename a separate name.

## A rule loads but fails validation

Default-export a constructible class that extends `Rule`. Set `check` as a function-valued property, not a method. Keep `files` nonempty and use `enabled = false` to disable a rule.

Validation still applies to disabled rules. It does not type-check your TypeScript or prove the policy. See [configuration](/docs/configuration/) for contracts.

## A check produces no findings

Normal output hides passing and skipped results. Add `--output-all`, then inspect the rule:

```sh
coderuler check . --rules .coderuler/internal-url.rule.ts --output-all
```

Follow the stages in order. Review the root, `files`, `exclude`, selector path or AST query, filter reasons, and group members. A rule with no applicable subjects is not evidence that the policy passes.

Do not target reserved directories. Traversal excludes `.git`, `node_modules`, `.coderuler`, `old`, and root-level `dist` or `coverage`, along with symlinks.

## A regex makes the opposite decision
`regex()` matches mean pass. Express the allowed pattern, not the forbidden pattern. For example, `/^\/internal\//` passes an internal URL and violates a public one.

Default input is scalar parsed data converted to a string, or source text for other scopes. Supply `input` if the selected value is not the text you intend to match. For groups, every member must match.

## Structured data fails to parse or select

JSON is strict. Remove comments, trailing commas, duplicate keys, and nonfinite numbers. Use the YAML selector for YAML rather than treating it as JSON.

Use nonempty `$`-rooted JSONPath. Executable expressions are rejected. A JSON/YAML `key` must yield exactly one string or finite number for each selected value. A CSV key needs headers, an existing column, and nonblank unique values.

Inspect `data` and `source` separately. Generic types describe your expectations but do not validate parsed data. Establish check preconditions in `filter`, but do not hide genuine violations there.

## Tests have no cases or time out

Export a named `tests` array. If the module has only `aiTests`, ordinary `test` does not select them. Use `--ai` only when you intend to authorize live calls.

The errors `No rule test cases found in the selected rules` and `No ordinary rule test cases found in the selected rules; run with --ai to include aiTests` are not successful runs.

A timeout fails the case. Inspect the slow or hanging behavior first. If a legitimate case needs more time, use `--timeout 30s` or another supported positive duration. Reducing `--concurrency` can help isolate shared-state problems.

If you see `Inline rule tests must not call the decision backend`, move the live expectation to `aiTests`. Keep ordinary cases offline. Do not turn provider errors into passing results.

## AI needs credentials or gives an unexpected result

`No decision API key: set TYPESAFE_API_KEY` means an actual AI call needs the credential in the current process. Setting `GH_TOKEN` or `GITHUB_TOKEN` does not configure the AI provider.

Inspect selected input before changing the prompt. Structured scopes send parsed data instead of source by default. Small scopes can omit necessary context, while broad groups can add unrelated material.

A probability equal to the threshold violates. Only a strictly greater probability passes. CLI `--threshold` overrides the rule and environment. See [AI checks](/docs/ai-checks/) for model, pricing, precedence, and privacy details.

## An imported package cannot resolve

Declare supported public npm dependencies with `coderuler deps add <package>`. After checkout or lock changes, run `coderuler deps sync`. Do not assume application-installed packages are declared rule dependencies.

Use `--global` or `--directory` if the package belongs to another rule directory. The manager rejects unsupported package sources, install scripts, native add-ons, and graph or integrity mismatches. Fix the package declaration or restore the committed lock rather than editing the installed tree.

## Diff or GitHub comments fail

Git is required for `--diff` and `--pr`. Make sure that the selected base ref exists locally for working-tree diffs. In CI, `HEAD` often has no working-tree changes, so choose an explicit fetched comparison base.

`--base` requires diff or PR mode. `--auto-comment` also requires diff or PR mode. Commenting requires a nonblank `GITHUB_TOKEN` with pull-request write permission. `GH_TOKEN` is not an alternative for these code paths.

Without explicit `--pr`, comment target discovery needs GitHub event context or one open PR for the current branch and origin. Fork workflows can lack write permission or secrets. Keep offline checks independent of comments.

If the PR head changes, CodeRuler refuses stale comments. Re-run on the current revision. If no current diff anchor fits a finding, expect an ordinary summary comment instead of an inline review comment.

## Report a problem or contribute

Use [GitHub issues](https://github.com/alex-dbs/coderuler/issues) for reproducible failures. Include the command, Node.js version, a minimal rule and fixture, and the observed error. Remove secrets and private source first. Raw check JSON can contain unredacted report content.

The repository's contribution workflow is:

```sh
npm ci
NODE_COMPILE_CACHE="${TMPDIR:-/tmp}/coderuler-node-compile-cache" npm test
node dist/cli.js deps sync
npm run typecheck
```

Run those commands from a source checkout when you contribute. Add or update tests for behavior changes. The [authoring skill](https://github.com/alex-dbs/coderuler/blob/main/skills/coderuler-new-rule/SKILL.md) describes policy development, and the [API reference](https://github.com/alex-dbs/coderuler/blob/main/skills/coderuler-new-rule/reference.md) gives detailed contracts.

CodeRuler uses the [Apache License, Version 2.0](https://github.com/alex-dbs/coderuler/blob/main/LICENSE). Read the [source repository](https://github.com/alex-dbs/coderuler) for implementation and contribution context.
