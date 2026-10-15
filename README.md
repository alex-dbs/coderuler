# rulekeeper

**One YAML file = one rule.** rulekeeper selects complete *scopes*, filters their applicability, and
builds each scope's review context. `check` then sends the rule, its examples, and every selected
context to the configured HTTP decision provider and reports the probability and model it answered with,
per scope — or per group, when a rule sets `decision.group_by` to `file`, `folder` or `project` and
judges one group at a time from the current working tree rather than a diff. It prints a compact human
summary by default and the full machine-readable result with `--json`. `validate` stays offline and only
compiles rules.

Scope selection itself — the matcher, applicability filters, and context contract — is a
deterministic, network-free core, and the [golden tests](#checks) exercise it without any model call.
The rule schema, plugins, matching semantics,
[limitations](docs/rulekeeper-design.md#limitations), and
[decision boundary](docs/rulekeeper-design.md#the-decision-boundary) are documented in
[docs/rulekeeper-design.md](docs/rulekeeper-design.md).

The ast-grep plugin supports all **31 officially published languages**, with case-insensitive names
and common aliases such as `py`, `rs`, and `c++`. See the
[language catalog and custom-grammar setup](docs/rulekeeper-design.md#builtin-plugins).

## Architecture

The sources are a hexagonal layout: one pure application core, adapters that drive and serve it, and a
single composition root wiring them.

- **Application core** — [src/app/](src/app/) holds the use cases: [check](src/app/check.ts),
  [validate](src/app/validate.ts), rule [loading](src/app/load-rules.ts) and
  [compilation](src/app/rule/compile.ts), [context collection](src/app/collect-contexts.ts),
  [grouping](src/app/decision/group.ts), and the thresholding [decision service](src/app/decision/service.ts).
  They depend only on the ports they declare: [rule files](src/app/ports/rules.ts),
  [sources](src/app/ports/sources.ts), [diagnostics](src/app/ports/diagnostics.ts), the
  [decision backend](src/app/decision/port.ts), and the [scope plugin](src/app/scope/types.ts) contract.
  The core is pure policy — no process, filesystem, Git, or network access, and no timers — with I/O
  concurrency bounded in [src/app/concurrency.ts](src/app/concurrency.ts).
- **Adapters** — [src/adapter/](src/adapter/) implements those ports: the
  [Commander program](src/adapter/cli/program.ts) and its [check](src/adapter/cli/check.ts) /
  [validate](src/adapter/cli/validate.ts) verbs with [reporting](src/adapter/cli/check-report.ts),
  [diagnostics](src/adapter/console/diagnostics.ts), [rule files](src/adapter/filesystem/rule-files.ts)
  and [source reads](src/adapter/filesystem/sources.ts), [Git diffs](src/adapter/git/diff.ts), rule
  [YAML decoding](src/adapter/rule/yaml.ts), the [scope plugins](src/adapter/scope/) (yaml, protobuf,
  ast-grep), and the [Jev HTTP backend](src/adapter/decision/jev.ts).
- **Infrastructure** — [src/infra/](src/infra/) is configuration and composition only:
  [runtime.ts](src/infra/runtime.ts) loads `.env` and injects adapters into the use cases,
  [decision.ts](src/infra/decision.ts) resolves the backend and provider environment,
  [plugins.ts](src/infra/plugins.ts) builds the builtin plugin registry, and
  [rules.ts](src/infra/rules.ts) binds decoding to compilation. [index.ts](index.ts) is only the
  bootstrap that calls `runCli()`.

Dependencies point inward: the application core imports its own modules and pure library functions
(`node:path`, `node:util`, `jsonpath-plus`); adapters depend on application contracts and use cases, never
infrastructure; infrastructure composes both. Adding a plugin or backend does not require a core change:
a plugin declares a `format` and returns a `select`, is registered through [createPluginRegistry](src/infra/plugins.ts), and is then named
by `format` in a rule; a backend implements [`DecisionBackend.decide`](src/app/decision/port.ts), is
wrapped by `DecisionService` for thresholding, and is wired in [src/infra/decision.ts](src/infra/decision.ts)
beside the `RK_BACKEND` check.

## Requirements

- **Node.js 24 or later** — the sources are typed TypeScript executed directly (no compile step).
- **Git 2.45 or later** — only for a `--diff-only` run that has scope-mode rules; older Git rejects the
  `--no-lazy-fetch` option.
- **A decision provider** — an HTTP endpoint and API key for `check`; both come from the environment
  (see [Configuration](#configuration)) and `validate` needs neither.

Private package: install the pinned dependencies once with `npm ci`; there is no build output, no
published package, and no globally installable binary.

## Quickstart

`check` decides each selected scope with TypeSafe's Jev provider by default, so set a key before
running it. Set `TYPESAFE_API_KEY`:

```sh
export TYPESAFE_API_KEY=...
node index.ts check              # select scopes, decide each one, and print a human summary
```

Change the endpoint and model with `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` if
you do not want the defaults. The base URL is the provider origin; the adapter appends the
`v1/systemone` endpoint path to it. Only a run with at least one selected scope needs a key:
`validate`, and a `check` that selects nothing, never read the provider configuration.

## Configuration

At startup the CLI loads `.env` from the **current working directory**, using Node's built-in loader.
Existing shell variables take precedence. A missing file is allowed; other file errors fail startup.
The local `.env` is gitignored: uncomment its API-key entry and fill in your key before checking code.

`check` builds its decision service from the environment **at call time**, not at import, so the
process that only compiles rules never needs a provider:

Provider credentials, origin, and model use [TypeSafe's SDK environment names](https://github.com/typesafe-ai/typesafe-sdk-js/blob/HEAD/src/env.ts).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — (required) | Bearer key sent to the provider. |
| `RK_BACKEND` | `jev` | Backend to use; `jev` is the only supported value. |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Model name sent with every question. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Provider origin; the adapter appends the `v1/systemone` endpoint path to it. |
| `RK_THRESHOLD` | `0.4` | Local probability threshold used to classify verifications. |

A used environment setting that is blank fails the run instead of silently taking a default, and surrounding
whitespace is trimmed. The base URL must be an absolute `http`/`https` URL with no query, fragment, or
embedded credentials. A missing key fails only when there is a context to decide.

`check --threshold <number>` overrides `RK_THRESHOLD`; when neither is supplied, the threshold is `0.4`.
Both accept plain decimal values from `0` to `1` inclusive, without signs, exponents, or hexadecimal
notation. A valid flag overrides even an invalid environment setting. The threshold changes local
classification only; it is not sent to the provider. `--debug` reports the effective value and whether
it came from the flag, environment, or default.


## CLI

```sh
node index.ts check                       # check the current folder
node index.ts check src                   # check a file or folder
node index.ts check --diff-only          # committed branch changes vs the default branch
node index.ts check --diff-only --base origin/my-branch
node index.ts check --rules rules.yaml    # use one rule
node index.ts check --rules ./my-rules    # use all rules in a folder
node index.ts check --concurrency 16      # at most 16 decisions in flight (default 8)
node index.ts check --threshold 0.7       # override RK_THRESHOLD for this run
node index.ts check --json               # print the machine-readable result instead of the summary
node index.ts check --debug              # serial execution plus important troubleshooting logs
node index.ts check --verbose            # detailed logs without changing concurrency
node index.ts validate                   # validate discovered rule definitions
node index.ts validate ./my-rules        # validate an explicit rule file or folder
```

`check [path]` defaults to `.`. Rule globs and context filepaths are relative to the **working
directory**; a target such as `src` narrows the scan without changing that base. Only files selected
by a rule's `files.included` / `files.excluded` are read. Selected scopes then pass through the rule's
applicability filter. Without `--diff-only`, sources come from the working tree. A rule whose
`decision.group_by` is `file`, `folder` or `project` always reads the current working tree — even under
`--diff-only` — and judges one group of its selected scopes at a time; see
[decision grouping](docs/rulekeeper-design.md#decision-grouping).

Recursive source scans skip `.git`, `node_modules`, `.rulekeeper`, symlinks, and the loaded rule
files themselves. An explicitly selected source symlink is rejected. `.gitignore` is not consulted.

### Branch diffs

`--diff-only` requires Git 2.45 or later and compares the **merge base of the base branch and
`HEAD`** to committed `HEAD`, like a pull request. It reviews new/changed scopes with complete
context, not just added lines. Unchanged sibling scopes are excluded, even with
`scope.changed: false`. This applies to scope-mode rules; a rule grouped by `file`, `folder` or
`project` ignores the diff and reads the current working tree instead, so a `--diff-only` run whose
rules are all grouped needs no Git and leaves `--base` unused.

The default base is `origin/HEAD`, falling back to `origin/main`, `origin/master`, `main`, then
`master`. `--base <ref>` overrides it and requires `--diff-only`. References must exist locally;
the command never fetches. Every Git call carries `--no-lazy-fetch` with `GIT_TERMINAL_PROMPT=0`, so
a partial clone whose objects are missing fails the read instead of contacting the promisor remote,
and Git older than 2.45 fails loudly on the unsupported option. That no-network guarantee covers
**Git operations only**: `check` still contacts the decision provider over HTTP for every selected scope
or group.

For a scope-mode rule, staged, unstaged, and untracked source changes are **not** included; a rule
grouped by `file`, `folder` or `project` reviews the current working tree, dirty or not, and needs no
repository — a `--diff-only` run whose rules are all grouped touches no Git at all, while a mixed run
still reads the repository for its scope-mode rules. Rule definitions still come from the current working
tree and home directory. `[path]` and `--rules` work in both modes; for a scope-mode diff the `[path]`
must lie inside the repository but need not exist on disk (so committed changes stay checkable after a
local deletion), whereas a grouped rule scans the current filesystem and its target must exist there.


### Rule discovery

Without `--rules`, `check` loads root-level and nested `.yaml` / `.yml` files from:

1. `./.rulekeeper` in the current working directory.
2. `~/.rulekeeper` in your home directory.

Extensions are case-insensitive. Both folders contribute; project rules come first and paths are
sorted lexically within each root. Matching names do not override each other. Roots are deduplicated
by physical directory, so one root reached under two spellings is scanned once, under the first
spelling. Parent folders and symlinked roots/entries are not searched.

`--rules <path>` replaces discovery with a single rule file or a recursively scanned rule folder; an
explicitly named rule path may itself be a symlink, while nested symlink entries are skipped as in
discovery. `validate [rule-path]` uses the same loading behavior, but only compiles the rule
definitions. Missing default roots are fine; finding no rules, an unreadable path, or an invalid rule
fails the command.

### Output and execution

By default `check` writes human progress to `stderr` and a compact final summary to `stdout`. On a real
terminal — `stderr` is a TTY, `TERM` is not `dumb`, `CI` is unset, and diagnostics are off — it shows live activity: a spinner
while rules load and scopes are discovered, then a bounded progress bar for source reads and for
decisions, annotated with the total rule count, the matching-rule count once known, and the selected
scope count. On a non-TTY — a pipe, a redirected file, or a CI job — it prints no spinner, no ANSI
escape, and no animation: just the plain final summary. Progress never reaches `stdout`, so the summary
is the only thing written there.

The summary opens with `🚀 N rules checked`, then the number of verifications run with passed and
violating counts. One verification means one selected scope, or one group for a grouped rule. It
also reports selected scopes, unique selected files, and elapsed time. Each violation starts with
the rule name and optional title on one line, the `filepath:line-range` on the next, then the matched
source with absolute file line numbers. Internal scope IDs stay in `--json`, not the human report.
Group violations show every member file and source block. Passing scopes are not printed.
The list is capped at 10 decisions with an explicit remaining count; each displayed source block is
complete. A scope can start partway through a source line, so the block contains the selected text,
not necessarily the entire first line. Host plugins without line metadata still show their source,
without invented line numbers.

An optional rule `title` supplies a short human-readable explanation beside each violation:

```yaml
title: Memory limit must not exceed 1.5 times the memory request.
```

`title` must be a non-blank string when present. It is static rule text, not a model-generated reason,
and is not sent to the decision provider. Violations are highlighted red, passing counts green, and
warnings yellow; source code stays uncolored. Colors follow the output stream's terminal support and
respect `NO_COLOR` and `FORCE_COLOR`. Rule names, paths, titles, and source blocks have terminal
control sequences removed before printing.

Unknown rule properties and builtin scope options emit `WARN` messages on `stderr` and are ignored.
Invalid values for known fields, malformed filters, and invalid selectors remain errors. Warnings
also appear with `--json`, without contaminating its `stdout`. When no scope matches, the summary
states `0 verifications ran (no matching scopes)` instead of implying compliance.

`check --json` opts into the machine-readable form instead: it prints exactly the JSON array below to
`stdout` and creates no spinner, no progress, and no summary. A piped or scripted caller that wants
parseable result must pass `--json`, since the default human output is not machine-readable. `--json`
changes neither the array's shape or ordering nor the exit codes.

The array is `[{ ruleFile, name, title?, rule, examples, contexts, decisions }]`, one entry per loaded
rule, including rules with no contexts. `title` is omitted when not defined. `ruleFile` is the absolute
rule path, while each context's `filepath` is relative to the working directory. Contexts aggregate
across files in lexical filepath order; diff-only contexts also include the per-file `diff`. Builtin
scopes include `lines: { start, end }`, an absolute, 1-based, inclusive range in the reviewed source
(the committed head for diff checks). Line metadata is not sent to the decision provider.

`decisions` holds one entry per scope-mode context, in the same order — `{ filepath, scopeId, follows,
probability, model }` — or, for a grouped rule, one entry per group — `{ group: { type, path },
members: [{ filepath, scopeId }], follows, probability, model }`. `follows` is `true` exactly when
`probability > threshold`, using the effective [configured threshold](#configuration). Equality does
not pass. The backend's `probability` and `model` are preserved unchanged; changing the threshold
only changes `follows`.

`check` does all of its preflight before the first request: every rule loads and compiles, every
selected source is read and matched, and every group is built, so a parse or read failure has no
external side effect. It then sends each question — the rule text, its normalized examples, and one
context: for a scope, its structured `data` when the plugin exposes one (with `captures` when present)
or else its matched `source`, beside its `filepath` and, in `--diff-only` mode, the per-file `diff`;
for a group, its descriptor and member files and scopes — to the configured provider.
`--concurrency <number>` (default `8`) is the run's global limit on concurrent work: rule loads, source
reads, Git snapshot reads, and HTTP decisions all draw on the same bound, applied to each phase, so it
is one limit for the whole run rather than one per rule. The value must parse as a positive integer, and
an invalid value is rejected before any rule or source is read — only the working-directory `.env` is
loaded earlier. `1` makes each phase serial. The bound covers work that waits on the filesystem, Git, or
the network, while matching and parsing are synchronous and stay on the single JavaScript thread: I/O
concurrency, not CPU parallelism.

Results land in rule order and then context (or group) order however the replies interleave, and one
group is one request, never split into smaller calls. After the first failure no new job starts, while
work already in flight — including requests already sent — is awaited to completion and cannot be rolled
back. Requests time out after 30 seconds, are never followed across redirects, and are never retried on
a server error; there is no offline or mocked fallback. The final `stdout` write — the JSON array under
`--json`, the human summary otherwise — is atomic and happens only after every decision succeeds, so a
failed run leaves `stdout` empty: no partial JSON and no summary.

A successful run exits `0` **even when every decision is `false`** — `check` reports the answers, it
does not assert compliance and does not fail a build on a failing scope. Setup, parse, and provider
errors exit nonzero with a stderr message and no result on `stdout` — no JSON and no summary; the exit
codes are the same with and without `--json`. `validate` still never calls the provider and prints each
rule's identity only after all definitions compile.

`check` transmits the selected context — or group — to the configured provider. Choose the endpoint and
key deliberately before reviewing a repository whose contents must not leave the machine.

Run `node /absolute/path/to/rulekeeper/index.ts check` from the project you want to review.
`npm start -- check` also works from this repository; use `npm run --silent start -- check --json` when
`stdout` must contain only the JSON array rather than the human summary. [index.ts](index.ts) is only the
bootstrap: the Commander declarations live in
[src/adapter/cli/program.ts](src/adapter/cli/program.ts), with the verb implementations in
[src/adapter/cli/check.ts](src/adapter/cli/check.ts) and
[src/adapter/cli/validate.ts](src/adapter/cli/validate.ts) and the runtime wiring in
[src/infra/runtime.ts](src/infra/runtime.ts).

### Troubleshooting

`check --debug` forces concurrency to `1` across rule loading, source reads, Git snapshots, and
verifications. It overrides a valid `--concurrency` value; invalid values are still rejected. Important
`[debug]` events show effective run settings, phase counts and timings, the backend host/path/model,
verification outcomes, and safe HTTP status or error codes.

`check --verbose` includes those events plus `[verbose]` details: rule identities, selected or skipped
files and skip reasons, reads, eligible contexts per file/rule, group members, and HTTP request metadata.
It keeps normal concurrency, including an explicit `--concurrency`. A selected source can still
produce zero contexts after scope selection and filtering; the logs report that result, not source
values or individual predicate evaluations.

Combine the flags for serial execution with full detail:

```sh
node index.ts check tests/manual --rules .rulekeeper/memory.yaml --debug --verbose
node index.ts check --debug --verbose --json
```

Diagnostics go only to `stderr`, even with `--json`; the normal summary or JSON on `stdout` is unchanged.
A blank line separates the diagnostic logs from the final report.
Live progress is disabled while diagnostics are on, so spinner frames do not interrupt logs. A
zero-verification run still logs discovery and matching, without constructing a backend or requiring
an API key.

Logs exclude API keys, authorization headers, source/policy/example text, request/response bodies,
and stack traces. Filepaths, rule names, backend addresses, and model names remain visible; review
them before sharing logs. These flags belong to `check`, not `validate`.


## Checks

```sh
npm run typecheck
npm run test:golden
npm test
```

The 39 matcher fixtures under `tests/golden/` are deterministic and never call a decision provider, so
they run without a key or network access; they are what `npm run test:golden` runs. Grouped decisions
are covered separately by 11 hand-authored cases in `tests/decision-golden.json`, alongside
end-to-end grouped CLI runs against a local loopback HTTP backend — never a live provider. The
application use cases are also exercised directly, with in-memory ports and a stub backend, in
[src/check-use-case.test.ts](src/check-use-case.test.ts). Both are
part of `npm test`, which discovers `src/*.test.ts`, and are not part of `npm run test:golden`.
