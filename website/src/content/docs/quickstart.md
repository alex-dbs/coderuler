---
title: Quickstart
description: Install RuleKeeper and run a complete deterministic rule with inline tests.
section: Getting started
order: 2
---

# Quickstart

This example requires each text file in `config/` to start with `/internal/`. It uses a regular expression and makes no AI calls.

## Install

Use Node.js `^24.15.0 || >=26.0.0`. The CLI command is `rulekeeper`. The npm package name is `@alex-dbs/rulekeeper`.

For a project-local installation, run these commands from your project root:

```sh
npm install --save-dev @alex-dbs/rulekeeper
npx rulekeeper --help
npx rulekeeper --version
```

This guide uses `npx rulekeeper`. If you prefer a global installation, run `npm install -g @alex-dbs/rulekeeper` and use `rulekeeper` instead. A global CLI can load rules without a project-local SDK dependency.

Use `rulekeeper update` for a global npm installation. See the [update commands](/docs/cli/#update) for project-local installations.

To use an unreleased source checkout instead of the npm package:

```sh
git clone https://github.com/alex-dbs/rulekeeper.git
cd rulekeeper
npm ci
npm run build
npm start -- --help
```

From another project's root, invoke the built CLI with `node /absolute/path/to/rulekeeper/dist/cli.js` instead of `npx rulekeeper`.

## Save a rule and its tests

Create `.rulekeeper/internal-url.rule.ts` in your project. Copy this complete module:

```ts
import { Rule, regex, test } from '@alex-dbs/rulekeeper';

export default class InternalUrl extends Rule {
  files = ['config/*.txt'];
  check = regex({ pattern: /^\/internal\//, violationMessage: 'Use an /internal/ URL' });
}
export const tests = [
  test('internal URL passes').withFiles({ 'config/url.txt': '/internal/jobs' }).passes(),
  test('public URL violates').withFiles({ 'config/url.txt': '/public/jobs' }).violates(),
];
```

The filename gives this rule the name `internal-url`. The `files` property selects root-relative paths. Without a scope selector, the check receives each whole file separately.

`regex()` treats a match as a pass. A nonmatch is a violation. The tests create temporary files, so they do not write `config/url.txt` into your project.

## Validate and test

Run these commands from your project root:

```sh
npx rulekeeper validate .rulekeeper/internal-url.rule.ts
npx rulekeeper test .rulekeeper/internal-url.rule.ts
```

If the module meets the rule contract, validation prints `Valid rule: internal-url` and exits with status `0`. It does not evaluate the policy or type-check TypeScript.

The test command runs both cases. Both tests pass: the second case expects a violation. Successful tests exit with status `0`.

## See what the rule selected

Inspection runs the rule on real project files and shows its pipeline:

```sh
npx rulekeeper inspect .rulekeeper/internal-url.rule.ts .
```

If no files match, the rule does not evaluate a subject. A skip does not prove that the policy works. Keep both passing and violating tests, and inspect representative files.

Next, read [how it works](/docs/how-it-works/) or [writing rules](/docs/writing-rules/). This example also appears in the [rule author reference](https://github.com/alex-dbs/rulekeeper/blob/main/skills/rulekeeper-new-rule/reference.md#regex-matching-means-passing).
