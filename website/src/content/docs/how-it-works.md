---
title: How it works
description: Understand rule discovery, selection, grouping, evaluation, and reports.
section: Getting started
order: 3
---

# How it works

A scope is a file or a selected part of a file. A subject is the scope or group of scopes passed to a check.

RuleKeeper loads and structurally validates all selected rules before it runs this pipeline:

```text
enabled → when → files and excludes → scope or select → filter → group → check → report
```

The homepage [rule workflow](/#rule-workflow) pairs each rule section with an animated step. Select a check mode to restart the example, or select an individual step.

The final step evaluates the retained context and shows one result. Regex and code run locally. The AI example illustrates a request and response.

With reduced motion enabled, select a step to inspect its source and result without animation.

## Find the rules

Without an explicit rule path, RuleKeeper searches `.rulekeeper/` in the project and `~/.rulekeeper/` in your home directory. It searches subfolders for `.rule.ts`, `.rule.mts`, `.rule.js`, and `.rule.mjs` files.

The filename without its rule suffix becomes the rule name. Two rules cannot share a name, even in different folders. Explicit rule paths replace discovery rather than adding to it.

For `check` and `validate`, the project root is the current working directory. `check src/` narrows eligible target files without changing root-relative rule globs. Inspection uses its selected folder as the project root.

## Decide whether a rule applies

`enabled = false` skips a rule, but its structure must still be valid. `when(context)` runs once for each enabled rule before source selection.

Use `when` for project-level conditions. For example, return `context.project.hasFiles('package.json')` to apply only to package projects. Return `{ applies: false, reason: 'Package projects only' }` when an explanation helps.

A skip means that the rule did not apply. It is not a passing policy decision.

## Select files and scopes

`files` selects root-relative globs. `exclude` removes matches, and exclusions win. Without a `scope`, RuleKeeper selects one whole-file scope per eligible file.

A structured selector can instead select JSON values, YAML documents, CSV rows, Protobuf declarations and options, or syntax nodes. Scopes preserve identity and source locations so findings can refer to the selected content.

Override `select(context)` for custom selection. Reuse `context.select({ files, exclude, scope })` instead of recreating file traversal. See [scopes](/docs/scopes/) for signatures and boundaries.

## Filter before grouping

`filter(subject, context)` receives each scope before grouping. Use it to establish required data and applicability.

Return `true` for applicable data. Return `false` or `{ applies: false, reason }` for data outside the policy. Throw an error for broken execution or invalid assumptions.

A retained match still needs a check. A filter result is not a pass or violation.

Do not filter out the violation itself. If a missing field violates the policy, select its parent and report that missing field in the check.

## Group the evidence

The default group is `'scope'`, so the check runs once per selected scope. Use `'file'`, `'folder'`, or `'project'` when a decision needs several scopes together.

Each group produces one decision. Empty groups are not evaluated. A project group can compare identifiers across files, while a file group can compare rows in one CSV file.

Diff checks evaluate all applicable scopes in changed files, not only scopes on changed lines. Affected groups can include unchanged members. See [CI and GitHub](/docs/ci/).

## Evaluate and report

A check returns `pass()` or `violation(message)`. Built-in `regex()` checks allowed patterns. Optional `ai()` checks use an external decision service.

RuleKeeper can run selection and evaluation tasks concurrently. Keep check results independent of execution order and mutable shared state.

Normal `check` output focuses on violations. Add `--output-all` to see passing and skipped results. Use `inspect` for selected content, filter reasons, groups, traces, and decisions. Runtime errors remain errors rather than becoming passes.

Read [configuration](/docs/configuration/) for defaults or the [CLI reference](/docs/cli/) for formats and exit codes. The implementation contracts are in [rule.ts](https://github.com/alex-dbs/rulekeeper/blob/main/src/app/rule.ts).
