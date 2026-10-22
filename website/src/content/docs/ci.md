---
title: CI and GitHub
description: Run offline rules in GitHub Actions and choose diff, PR, and comment modes deliberately.
section: Reference
order: 11
---

# CI and GitHub

Continuous integration (CI) runs saved rules on each change. Separate deterministic checks from live AI work so credentials, data transfer, and cost stay explicit.

## Install the CLI

Install RuleKeeper globally:

```sh
npm install -g @alex-dbs/rulekeeper
```

Commit your rules and any `.rulekeeper/rulekeeper.lock`. If your rules use managed npm packages, run `rulekeeper deps sync` before the check.

## Run rules in GitHub Actions

Save this workflow under `.github/workflows/rulekeeper.yml` in your project:

```yaml
name: RuleKeeper

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  rules:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '24.15.0'
      - run: npm install -g @alex-dbs/rulekeeper
      - run: rulekeeper check
```

Node.js must satisfy `^24.15.0 || >=26.0.0`. `check` discovers your saved rules. Any selected AI checks run live, so keep them separate from offline rules.

A check violation fails the job with status `1`. Command failures use status `2`.

Rules and npm installation scripts are executable code. Run untrusted contributions only under your repository's security policy. Do not expose privileged secrets to untrusted changes.

## Check only changed files

```sh
rulekeeper check . --diff
rulekeeper check . --diff --base origin/main
```

Diff mode requires Git. Its default base is `HEAD`. It includes changed files and untracked nonignored files. Deleted files cannot produce scopes because they are absent from the working tree.

In CI, choose a base that represents the comparison you intend. After checkout, `HEAD` alone can leave no working-tree changes. Fetch the base ref before using it. A full checkout history helps make base references available.

Diff mode evaluates all applicable scopes in changed files. It does not select individual scopes by changed lines. Affected groups also include unchanged members needed for the comparison.

## Analyze a GitHub pull request

```sh
rulekeeper check . --pr 123
rulekeeper check . --pr https://github.com/owner/repository/pull/123
rulekeeper check . --pr 123 --base main
```

PR mode fetches the head and selected or default base branch into temporary checkouts. It compares the head with their merge base and uses rules from the base branch. `--pr` implies diff mode.

This means a proposed rule change is not automatically used as the trusted PR policy. Test proposed rule edits separately in a job with appropriate permissions. RuleKeeper cleans up the temporary checkout after the command.

Normal PR discovery also includes home rules. An explicit `--rules` path replaces discovery, so review that selection rather than assuming base-branch rules always apply.

PR metadata reads can run without a token for accessible public repositories. Set `GITHUB_TOKEN` when repository access or API limits require authentication. These code paths do not read `GH_TOKEN`.

## Post findings deliberately

```sh
export GITHUB_TOKEN='your-token'
rulekeeper check . --pr 123 --auto-comment
```

`--auto-comment` requires diff mode or `--pr`. It contacts GitHub for comments only when violations exist. The token needs pull-request read/write permission, and the repository or organization must allow the operation.

For GitHub Actions comment jobs, request `pull-requests: write` and pass an appropriate token as `GITHUB_TOKEN`. Fork PR workflows often receive read-only tokens and no secrets. Keep rule checks independent so they still run without comment permission.

With `--diff --auto-comment` and no explicit `--pr`, RuleKeeper first uses `GITHUB_REF` and `GITHUB_REPOSITORY` to identify the PR. Next, it tries `GITHUB_EVENT_PATH`. Finally, it uses the current Git branch and origin. The branch fallback requires exactly one open PR. A detached checkout needs PR context from the environment or an explicit PR selection.

Do not switch to a privileged event that executes untrusted PR code merely to obtain write access. Separate trusted comment handling from untrusted evaluation according to your repository's security model.

RuleKeeper uses inline review comments when a finding maps to the current PR diff. Findings without a usable anchor go into an ordinary PR comment. A rule's `comment` property can replace its finding body without changing locations or decisions.

For PR analysis, comments refer to the analyzed revision. If the PR head changes during analysis or comment planning, RuleKeeper refuses to post stale findings. Re-run against the current head rather than forcing an outdated review.

## Enable live AI separately

A live job needs `TYPESAFE_API_KEY` and deliberate selection of AI rules or `test --ai`. Selected content leaves the runner for the configured service. Calls can incur charges.

Use repository secrets only in workflows that can safely receive them. Do not assume ordinary tests, raw machine-readable output, or GitHub comments make sensitive rule content safe to share.

See the [CLI reference](/docs/cli/) for all flags. Source details are in [Git changes](https://github.com/alex-dbs/rulekeeper/blob/main/src/adapter/git/changes.ts), [PR checkout](https://github.com/alex-dbs/rulekeeper/blob/main/src/adapter/github/pull-request.ts), and [comments](https://github.com/alex-dbs/rulekeeper/blob/main/src/adapter/github/comments.ts).
