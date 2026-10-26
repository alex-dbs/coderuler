---
title: Introduction
description: Turn project policies into executable rules with optional AI checks.
section: Getting started
order: 1
---

# CodeRuler documentation

CodeRuler runs project policies against files in your working tree. Write a rule in TypeScript or JavaScript. Add examples that pass and violate it, then run the CLI locally or in CI.

Store important policies as rules so enforcement does not depend on an AI agent remembering instructions. Run checks before review or make violations fail CI.

Use deterministic code for patterns, numbers, structure, and equality. Use an optional AI check when the policy needs judgment about meaning. AI checks send selected content to an external service and can incur charges.

A rule is a class with a required `check` property. It chooses files, selects content, and returns a pass or violation. The project you check can use any language. Rules can inspect its text files. Structured selectors support JSON, YAML, CSV, Protobuf, and code syntax through ast-grep.

## Start here

Follow the [quickstart](/docs/quickstart/) to install the CLI and run a complete offline rule. Then read [how it works](/docs/how-it-works/) to understand selection and evaluation.

If you already have a policy, start with [writing rules](/docs/writing-rules/). Add [inline tests](/docs/testing/) before you apply it to project files.

## Choose your next step

| Task | Guide |
| --- | --- |
| Select files or structured content | [Scopes](/docs/scopes/) |
| Set rule members and grouping | [Configuration](/docs/configuration/) |
| Add semantic judgment | [AI checks](/docs/ai-checks/) |
| Import an npm library in a rule | [Dependencies](/docs/dependencies/) |
| Look up commands and output formats | [CLI reference](/docs/cli/) |
| Run rules on a pull request | [CI and GitHub](/docs/ci/) |
| Diagnose a skip, failure, or unexpected result | [Troubleshooting](/docs/troubleshooting/) |

## Trust and limits

Rules are trusted Node.js code. CodeRuler does not sandbox them. Run only rule modules and dependencies that you trust.

A linter remains useful for established language and style rules. CodeRuler adds executable policies specific to your project. Instructions in `AGENTS.md` can explain a policy, but the rule supplies its executable test.

Examples in these guides are rules you can create. They are not a set of automatically enabled, shipped rules.

These guides follow the source repository. For the flags in your installed release, run `coderuler <command> --help`.

The CLI requires Node.js `^24.15.0 || >=26.0.0`. Git is required for diff and pull-request checks. The source is on [GitHub](https://github.com/alex-dbs/coderuler), under the [Apache License 2.0](https://github.com/alex-dbs/coderuler/blob/main/LICENSE).
