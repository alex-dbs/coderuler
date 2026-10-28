---
title: CLI reference
description: Commands, accepted flags, output formats, defaults, and exit codes.
section: Reference
order: 10
---

# CLI reference

Run commands from the project root. For a project-local installation, replace `coderuler` with `npx coderuler`. Use `coderuler --help` or `coderuler <command> --help` for installed-release help.

## Version

```sh
coderuler --version
```

Print the installed package version. `-V` is the short form.

## Update

```sh
coderuler update
```

Upgrade the active global npm installation to the `latest` release. npm must be on `PATH`. The command uses your npm registry configuration.

Local installations and temporary `npx` copies cannot self-update. For a project-local npm development dependency, run:

```sh
npm install --save-dev @alex-dbs/coderuler@latest
```

For other installation methods, use the package manager that installed CodeRuler. An npm update failure returns npm's exit code.

## Validate

```sh
coderuler validate [rule]
```

Load and structurally validate rules without evaluating them. The optional rule can be a rule name, module path, or directory. There are no command-specific flags.

For all three selectors, a rule name is the exact filename stem of a discovered rule. Discovery searches project `.coderuler/` and home `~/.coderuler/`, including subfolders. A name filters discovered rules; an explicit path or directory replaces discovery.

Validation does not execute inline tests or type-check TypeScript. Rule modules still execute as trusted Node.js code when loaded.

## Test

```sh
coderuler test [rule] [options]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--ai` | Off | Include live `aiTests` and authorize provider calls |
| `--ai-scores` | Off | Display each Jev probability; does not authorize AI calls |
| `--failures-only` | Off | Hide successful case details |
| `--timeout <duration>` | `10s` | Per-case limit, using `ms`, `s`, or `m` |
| `--concurrency <number>` | `1` | Maximum in-flight test cases |

The optional rule is a rule name, module path, or directory. Ordinary `tests` remain offline, including when `--ai` also selects live cases. For an AI rule, put every case in `aiTests` and do not add a separate `tests` export. `--ai-scores` only displays scores when AI cases run with `--ai`. See [testing](/docs/testing/) for fixtures and timeout behavior.

## Check

```sh
coderuler check [path] [options]
```

The default target is `.`. A file or folder target narrows selection inside the current project root.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--rules <rule>` | Discovery | Rule name, module path, or directory |
| `--tags <tags...>` | `[]` | Run rules that match any listed tag |
| `--exclude-tags <tags...>` | `[]` | Exclude rules that match any listed tag |
| `--json` | Off | Print one JSON document |
| `--jsonl` | Off | Print JSON Lines rule records |
| `--output-all` | Off | Include passes, skips, and every evaluation |
| `--debug` | Off | Stream framework metadata and force concurrency `1` |
| `--verbose` | Off | Stream a redacted execution walkthrough |
| `--diff`, `--diff-only` | Off | Limit checks to changed files and affected groups |
| `--pr <number-or-url>` | None | Analyze a GitHub PR in a temporary checkout, implying diff mode |
| `--auto-comment` | Off | Post GitHub findings when violations exist |
| `--base <ref>` | `HEAD` for diff | Set the diff base, or the base branch for a PR |
| `--concurrency <number>` | `8` | Maximum in-flight selection and evaluation tasks |
| `--threshold <number>` | Rule/environment | Override the AI decision threshold |

For rule-name and discovery behavior, see the description under [Validate](#validate).
Tags are space-separated, exact, and case-sensitive. Exclusion takes precedence over inclusion. With no tag flags, `check` uses every rule. If the filters match no rules, `check` succeeds with zero rules.

```sh
coderuler check src --tags go security --exclude-tags experimental
```

`--json` and `--jsonl` are mutually exclusive. `--base` requires diff mode or `--pr`. `--auto-comment` also requires diff mode or `--pr`.

Concurrency must be a positive safe integer. Threshold must be a decimal between `0` and `1`. AI checks execute live during `check`, without a separate opt-in flag. See [CI and GitHub](/docs/ci/) before using PR checks or comments.

## Inspect

```sh
coderuler inspect <rule> [folder] [options]
```

`<rule>` is a module path or exact discovered name. It selects one rule, not a directory. The folder defaults to `.`, and becomes the inspected project root.

| Flag | Meaning |
| --- | --- |
| `--json` | Complete redacted inspection as one JSON document |
| `--jsonl` | Stream redacted events and reports as JSON Lines |
| `--raw` | Complete redacted inspection as undecorated text |
| `--input-cost-per-million <number>` | Override estimated USD per million input tokens |
| `--output-cost-per-million <number>` | Override estimated USD per million output tokens |

Choose only one of `--json`, `--jsonl`, or `--raw`. Prices must be finite nonnegative decimals. Inspection runs at concurrency `1` and executes the actual check, including live AI calls.

## Dependencies

```sh
coderuler deps add <packages...> [options]
coderuler deps remove <names...> [options]
coderuler deps sync [options]
```

All three commands accept `--global` or `--directory <path>`. They are mutually exclusive. Without either, commands manage the project's `.coderuler/` directory.

Add accepts public npm names, versions, ranges, and tags. Remove accepts unversioned direct names. Sync acquires the committed graph and refreshes editor links. See [rule dependencies](/docs/dependencies/).

## Coding-agent skill

```sh
coderuler skill install [options]
coderuler skill update [options]
```

These commands install or refresh the bundled `coderuler-new-rule` skill for coding agents.

| Install flag | Meaning |
| --- | --- |
| `-g, --global` | Select global installation without a scope prompt |
| `-a, --agent <agents...>` | Target agents, using `"*"` for all |
| `-y, --yes` | Skip prompts, using project scope unless global |
| `--copy` | Copy files instead of symlinking agent directories |

| Update flag | Meaning |
| --- | --- |
| `-g, --global` | Refresh global installation |
| `-p, --project` | Refresh project installation, the default scope |
| `-a, --agent <agents...>` | Target agents, using `"*"` for all |
| `--copy` | Copy files instead of symlinking agent directories |

Global and project update flags are mutually exclusive. The default target is the shared universal skills directory. Upgrade CodeRuler before updating to obtain newer bundled content. Local skill sources refresh through `skills add`, not `skills update`.

## Machine-readable output

Check JSON has this envelope:

```json
{
  "durationMs": 12,
  "reports": []
}
```

The number is illustrative, not a performance claim. A report contains `name`, `ruleFile`, `status`, `durationMs`, `evaluations`, and an optional `reason`. Each evaluation contains `subject` and `result`.

By default, both machine formats include violating rules and violation evaluations only. Add `--output-all` to include every report and evaluation. A successful default check can therefore have an empty `reports` array.

Check JSON Lines emits one report per line with `type: 'rule'`. It has no envelope or final summary record. An all-passing check can produce no JSON Lines records unless `--output-all` is set.

Inspection JSON uses `{ events, reports, error?, usage? }`. Inspection JSON Lines streams `type: 'event'`, `type: 'report'`, and optional `type: 'summary'` or `type: 'error'` records. It includes passes and skips without `--output-all`.

Check JSON and JSON Lines serialize raw reports. They do not apply the inspection renderer's text redaction. Treat machine-readable check artifacts as potentially sensitive. Inspection formats are redacted, but still review selected source before sharing output.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command succeeds, or help is displayed |
| `1` | Check/inspection finds a violation, or a test expectation fails |
| `2` | Invalid command, loading/validation/runtime failure, or command error |

A test timeout is an expectation failure and uses `1`. A skipped rule is not a violation. Runtime failures are not converted into policy passes.

The authoritative command definitions are in [program.ts](https://github.com/alex-dbs/coderuler/blob/main/src/adapter/cli/program.ts). Check serializers are in [reports.ts](https://github.com/alex-dbs/coderuler/blob/main/src/adapter/cli/reports.ts), and inspection formats are in [inspect-json.ts](https://github.com/alex-dbs/coderuler/blob/main/src/adapter/cli/inspect-json.ts).
