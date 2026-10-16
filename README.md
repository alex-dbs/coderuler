# rulekeeper

**One YAML file = one rule.** rulekeeper selects complete *scopes*, filters their applicability, and
builds each scope's review context. `check` then sends the rule, its examples, and every selected
context to the configured HTTP decision provider and reports the probability and model it answered with,
per scope — or per group, when a rule sets `decision.group_by` to `file`, `folder` or `project` and
judges one group at a time from the current working tree rather than a diff. A check can also
[decide locally](#authoring-rules): a `regex` kind tests the scope against a pattern with no provider,
key, or network at all. `check` prints a compact human summary by default and the full
machine-readable result with `--json`. `validate` stays offline and only compiles rules, while
[`inspect`](#inspect) walks one rule through that same selection, filtering, and
grouping and prints the exact request and raw answer of every verification it triggers.

Scope selection itself — the matcher, applicability filters, and context contract — is a
deterministic, network-free core, and the [golden tests](#checks) exercise it without any model call.
The rule schema, plugins, matching semantics,
[limitations](docs/rulekeeper-design.md#limitations), and
[decision boundary](docs/rulekeeper-design.md#the-decision-boundary) are documented in
[docs/rulekeeper-design.md](docs/rulekeeper-design.md). To write a rule, start from the
[authoring schema](#authoring-rules) the editor uses and the
[`create-rule` skill](skills/create-rule/SKILL.md).

The ast-grep plugin supports all **31 officially published languages**, with case-insensitive names
and common aliases such as `py`, `rs`, and `c++`. See the
[language catalog and custom-grammar setup](docs/rulekeeper-design.md#builtin-plugins).

## Architecture

The sources are a hexagonal layout: one pure application core, adapters that drive and serve it, and a
single composition root wiring them.

- **Application core** — [src/app/](src/app/) holds the use cases: [check](src/app/check.ts),
  [validate](src/app/validate.ts), [inspect](src/app/inspect.ts), rule [loading](src/app/load-rules.ts) and
  [compilation](src/app/rule/compile.ts), [context collection](src/app/collect-contexts.ts),
  [grouping](src/app/decision/group.ts), and the thresholding [decision service](src/app/decision/service.ts).
  They depend only on the ports they declare: [rule files](src/app/ports/rules.ts),
  [sources](src/app/ports/sources.ts), [diagnostics](src/app/ports/diagnostics.ts),
  [statistics](src/app/ports/statistics.ts), the [decision backend](src/app/decision/port.ts), and the
  [scope plugin](src/app/scope/types.ts) contract.
  The core is pure policy — no process, filesystem, Git, or network access, and no timers — with I/O
  concurrency bounded in [src/app/concurrency.ts](src/app/concurrency.ts).
- **Adapters** — [src/adapter/](src/adapter/) implements those ports: the
  [Commander program](src/adapter/cli/program.ts) and its [check](src/adapter/cli/check.ts) /
  [validate](src/adapter/cli/validate.ts) / [inspect](src/adapter/cli/inspect.ts) verbs with their
  [check report](src/adapter/cli/check-report.ts) and
  [inspect walkthrough](src/adapter/cli/inspect-report.ts),
  [diagnostics](src/adapter/console/diagnostics.ts), [rule files](src/adapter/filesystem/rule-files.ts)
  and [source reads](src/adapter/filesystem/sources.ts), [Git diffs](src/adapter/git/diff.ts), rule
  [YAML decoding](src/adapter/rule/yaml.ts), the [scope plugins](src/adapter/scope/) (yaml, protobuf,
  ast-grep), the [Jev HTTP backend](src/adapter/decision/jev.ts), and the
  [SQLite statistics store](src/adapter/sqlite/statistics.ts).
- **Infrastructure** — [src/infra/](src/infra/) is configuration and composition only:
  [runtime.ts](src/infra/runtime.ts) loads `.env` and injects adapters into the use cases,
  [decision.ts](src/infra/decision.ts) builds one rule's decision service from that rule's `settings`
  layered over the provider environment,
  [inspect.ts](src/infra/inspect.ts) composes the inspect walkthrough,
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
- **A decision provider** — an HTTP endpoint and API key for a `check` or `inspect` run that decides with
  the default `AI` kind; credentials and the endpoint come from the environment only (see
  [Configuration](#configuration)), and `validate` needs neither. A rule may override the model, backend,
  and local threshold for its own verifications with
  [`settings`](#per-rule-settings-and-enabled), never a key or an origin. An `inspect` run that finds no
  verification, and any rule that is disabled, matches nothing, is fully filtered by its applicability
  filter, or decides with a local [`regex` check](#authoring-rules), never reads the provider
  configuration either.

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
`v1/systemone` endpoint path to it. Only a run that actually decides something needs a key:
`validate`, a `check` that selects nothing, decides locally with `check.kind: regex`, or whose rules are
all disabled, and an `inspect` with no verification never read the provider configuration.

## Configuration

At startup the CLI loads `.env` from the **current working directory**, using Node's built-in loader.
Existing shell variables take precedence. A missing file is allowed; other file errors fail startup.
The local `.env` is gitignored: uncomment its API-key entry and fill in your key before checking code.

`check` and `inspect` resolve each rule's decision service **lazily, when that rule first has a
verification to decide** — never at import, and never as one shared instance for the whole run; a rule
that checks with `regex` decides locally and resolves none at all. The service layers that rule's
[`settings`](#per-rule-settings-and-enabled) over the environment below, which is why the process that
only compiles rules never needs a provider:

Provider credentials, origin, and model use [TypeSafe's SDK environment names](https://github.com/typesafe-ai/typesafe-sdk-js/blob/HEAD/src/env.ts).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — (required) | Bearer key sent to the provider. |
| `RK_BACKEND` | `jev` | Backend to use; `jev` is the only supported value. |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Model name sent with every request. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Provider origin; the adapter appends the `v1/systemone` endpoint path to it. |
| `RK_THRESHOLD` | `0.4` | Local probability threshold used to classify verifications. |

A used environment setting that is blank fails the run instead of silently taking a default, and surrounding
whitespace is trimmed. The base URL must be an absolute `http`/`https` URL with no query, fragment, or
embedded credentials. A missing key fails only when there is a context to decide.

`check --threshold <number>` overrides a rule's `settings.threshold`, which overrides `RK_THRESHOLD`;
when none of the three is supplied, the threshold is `0.4`. Environment and flag thresholds accept
plain decimal values from `0` to `1` inclusive, without signs, exponents, or hexadecimal notation;
`settings.threshold` must be a finite number in that range. A valid flag or rule threshold bypasses
an invalid or blank `RK_THRESHOLD`. Rule settings are always validated during compilation, even when
the flag overrides them. The threshold changes local classification only; it is not sent to the provider.
`--debug` reports the effective value
and whether it came from the flag, the rule, the environment, or the default.

### Per-rule settings and `enabled`

A rule may override the model, the backend, and the threshold for its own verifications, and may switch
itself off. A minimal but complete rule using all three additions:

```yaml
version: 'v1'
files:
  included:
    - tests/manual/*.yml
scope:
  format: yaml
  path: $.*.container
check:
  rule: Memory limit must be less than or equal to memory request * 1.5. Compare both values in the same units.
  violation-message: Memory limit must not exceed 1.5 times the memory request.
settings:
  model: jev-latest
  threshold: 0.6
  backend: jev
enabled: true
```

The rule needs no `name`: its identity is the filename stem.

`settings` is an optional mapping whose recognized keys are:

- `threshold` — a finite number from `0` to `1` inclusive. A numeric string such as `'0.6'` is rejected.
- `model` — a non-blank model name; surrounding whitespace is trimmed like an environment value.
- `backend` — `jev` is the only supported value. Any other name fails the run offline instead of being
  silently ignored, because there is no second backend to fall back to.
- An unknown `settings` key warns like any other unknown rule property, and is ignored.
- **Credentials stay in the environment.** No API key and no base URL belong in a rule; those come only
  from `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL`.

Threshold precedence, highest first: explicit `check --threshold` > `settings.threshold` >
`RK_THRESHOLD` > default `0.4`. Model and backend: `settings.model` / `settings.backend` >
`TYPESAFE_DEFAULT_MODEL` / `RK_BACKEND` > default. A valid higher-priority setting means a lower-priority
invalid environment value is never even evaluated, so an invalid `RK_THRESHOLD` cannot fail a run whose
rule sets a threshold.

`enabled` defaults to `true`, and its value must be a real boolean — `false`, not `"false"`, `0`, or
`null`. A rule with `enabled: false` still loads, compiles, and validates, so `validate` reports it and
every other field must still be valid; `check` simply skips it before file selection. It is absent from
the results, from the `🚀 N rules checked` count, from the scope and verification counts, and from
`--json`, and it is still excluded from being reviewed as source. When every loaded rule is disabled, the
run completes with zero counts and reads no source, no Git, and no provider. [Inspect](#inspect) on a
disabled rule prints `Status: DISABLED`, scans no file, and runs no verification rather than implying
compliance.


## CLI

```sh
node index.ts check                       # check the current folder
node index.ts check src                   # check a file or folder
node index.ts check --diff-only          # committed branch changes vs the default branch
node index.ts check --diff-only --base origin/my-branch
node index.ts check --rules rules.yaml    # use one rule
node index.ts check --rules ./my-rules    # use all rules in a folder
node index.ts check --concurrency 16      # at most 16 decisions in flight (default 8)
node index.ts check --threshold 0.7       # override the rule and environment threshold for this run
node index.ts check --json               # print the machine-readable result instead of the summary
node index.ts check --debug              # serial execution plus important troubleshooting logs
node index.ts check --verbose            # detailed logs without changing concurrency
node index.ts validate                   # validate discovered rule definitions
node index.ts validate ./my-rules        # validate an explicit rule file or folder
node index.ts inspect duplicated-env     # walk one rule by filename stem through every decision
node index.ts inspect .rulekeeper/duplicated-env.yaml   # inspect one rule by filepath
node index.ts stats                       # cumulative global and per-project statistics
node index.ts stats --json                # machine-readable totals, elapsed time in milliseconds
node index.ts stats reset                 # erase statistics for ALL projects
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

### Statistics

Completed `check` and `inspect` evaluations automatically accumulate in
`~/.rulekeeper/stats.sqlite`. `stats` displays runs, rules evaluated, verifications, violations, and
summed evaluation time, globally and for every project. A project is its canonical absolute working
folder: `check src` belongs to the invocation folder, while `inspect rule path/to/project` belongs to
the resolved inspection folder. This is not Git-root discovery.

- Enabled rules count even when they select no scopes; disabled rules do not count.
- Each decision is one verification, including a decision over a whole group.
- A completed run with no verifications still counts as a run.
- Failed evaluations, `validate`, and statistics commands do not count.
- Time is monotonic elapsed evaluation time, excluding statistics persistence and final report
  rendering. For `inspect`, it includes the streamed walkthrough.

Storage contains **one cumulative row per project**, not individual runs or verifications. No dates,
source contents, rule names, requests, or responses are stored; global totals are calculated from the
project rows. Reading missing statistics does not create a database. Storage errors are reported
rather than silently discarding statistics.

`stats reset` clears **all projects**, not just the current folder. It leaves an empty database and
does not remove any rules or other files from `~/.rulekeeper`.

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
or group of an `AI` check; a local `regex` check needs no network at all.

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
sorted lexically within each root. Two files that share a filename stem — and therefore a derived rule
name — both load and do not override each other. Roots are deduplicated by physical directory, so one
root reached under two spellings is scanned once, under the first spelling. Parent folders and symlinked
roots/entries are not searched.

`--rules <path>` replaces discovery with a single rule file or a recursively scanned rule folder; an
explicitly named rule path may itself be a symlink, while nested symlink entries are skipped as in
discovery. `validate [rule-path]` uses the same loading behavior, but only compiles the rule
definitions. Missing default roots are fine; finding no rules, an unreadable path, or an invalid rule
fails the command.

`inspect` resolves a rule *name* — a filename stem, never a YAML field — through those same two discovery
roots, taken from the folder it is given instead of the invocation directory; see [Inspect](#inspect).

### Authoring rules

**One YAML file = one rule.** The required top-level keys are `version` (exactly `'v1'`, quoted so YAML
does not read it as a number), `files`, `scope`, and `check`; `filter`, `decision`, `settings`, and
`enabled` are optional, and the example under
[per-rule settings](#per-rule-settings-and-enabled) shows them together. There is no `name` field and no
alias for one: a rule is identified by its **filename stem**, the basename without the `.yaml` or `.yml`
extension. That derived name is what `validate` prints, what the human report and each violation line
show, what `--json` carries, and what [`inspect <name>`](#inspect) resolves against.

`check` is the mapping that judges every matched scope:

- `rule` — required and non-blank. Under the default `kind: AI` it is the declarative policy statement a
  matched context is expected to satisfy, carried verbatim to the decision provider; it stays the
  check-level rule, a different field from the nested `scope.rule`, which is the native ast-grep
  structural selector. Under `kind: regex` it is the **raw JavaScript regular-expression source**, written
  without `/…/` delimiters and with no separate flags field; the runtime compiles it during compilation,
  so an invalid pattern fails before any file is read.
- `examples` — optional `good` / `bad` lists of non-blank strings, carried verbatim to the provider
  and never executed, scored, or used to filter. When either list is non-empty they travel inside
  `instructions.examples` as the `good` and `bad` arrays, keeping the empty counterpart; a rule with
  no examples omits `instructions.examples` entirely. Under `kind: regex` they are not evaluated: the
  pattern alone decides.
- `violation-message` — optional non-blank reporting text printed beside each violation; see
  [Output and execution](#output-and-execution).
- `kind` — which evaluator runs, spelled exactly `AI` (the default) or `regex`. The casing is exact:
  `ai`, `Regex`, and `regexp` are unknown values and fail compilation.

A `regex` check is decided **locally and entirely offline**: no decision provider call, no API key, no
`TYPESAFE_*` environment, and no backend. The pattern is tested against the scope's scalar string data —
`String()` of a string, number, or boolean data value — or else against the selected scope `source` when
the scope carries no `data` (ast-grep scopes) or its `data` is structured (an object or array). A **match
follows the rule and passes; a mismatch is a violation**, and a grouped regex check tests every member
scope independently, so its group passes only when every member matches.

Unknown top-level or `check` properties warn on `stderr` and are ignored; there are no aliases, so a
leftover top-level `rule:`, `examples:`, `violation-message:`, `title:`, or `name:` is simply an unknown
property.

[rule.schema.json](rule.schema.json) is a JSON Schema (draft 2020-12) for that shape, so an editor can
complete keys and flag typos while you write. [.vscode/settings.json](.vscode/settings.json) already
associates it with `.rulekeeper/**/*.yaml`, `.rulekeeper/**/*.yml`, `docs/rules/**/*.yaml`, and
`docs/rules/**/*.yml`, so rules in those folders are checked by any YAML language server that reads
`yaml.schemas`. A rule file stored elsewhere can point at the schema itself with a first-line directive
whose path is resolved relative to the rule file:

```yaml
# yaml-language-server: $schema=../rule.schema.json
```

The schema is an authoring aid, not a second implementation: it cannot express what the runtime checks
semantically — the non-executable `jsonpath-plus` subset, the native ast-grep rule DSL, glob grammar,
duplicate YAML keys, or whether a `regex` kind's `rule` is a syntactically valid JavaScript pattern — so
a file that satisfies the schema can still fail to compile, and the compiler stays the source of truth.
It is deliberately stricter than the runtime about unknown properties: the editor reports `title:`,
`name:`, a top-level `rule:`, or another unknown key as an error so a typo is visible immediately, while
`check` warns about the same key on `stderr` and ignores it.

[skills/create-rule/SKILL.md](skills/create-rule/SKILL.md) is an agent skill for authoring and repairing
rules, with references for the
[yaml](skills/create-rule/references/yaml.md), [protobuf](skills/create-rule/references/protobuf.md), and
[ast-grep](skills/create-rule/references/ast-grep.md) selectors and for
[grouping, metadata, and settings](skills/create-rule/references/grouping-and-settings.md).

### Output and execution

By default `check` writes human progress to `stderr` and a compact final summary to `stdout`. On a real
terminal — `stderr` is a TTY, `TERM` is not `dumb`, `CI` is unset, and diagnostics are off — it shows live activity: a spinner
while rules load and scopes are discovered, then a bounded progress bar for source reads and for
decisions, annotated with the total rule count, the matching-rule count once known, and the selected
scope count. On a non-TTY — a pipe, a redirected file, or a CI job — it prints no spinner, no ANSI
escape, and no animation: just the plain final summary. Progress never reaches `stdout`, so the summary
is the only thing written there.

The summary opens with `🚀 N rules checked`, where `N` counts the enabled rules that took part — a
disabled rule is not counted — then the number of verifications run with passed and
violating counts. One verification means one selected scope, or one group for a grouped rule. It
also reports selected scopes, unique selected files, and elapsed time. Each violation starts with
the rule name and optional violation message on one line, the `filepath:line-range` on the next, then
the matched source excerpt with absolute file line numbers. Internal scope IDs stay in `--json`, not the human report.
Group violations show every member file and its source excerpt. Passing scopes are not printed.
The list is capped at 10 decisions with an explicit remaining count; every member file of a displayed
group is still listed. Each scope excerpt shows at most its first five source lines, followed by a
separate indented `…` line when more remain. This limit applies independently to each scope, not to
the group's total output. The `filepath:line-range` label still names the full matched scope, and `--json` plus the
request sent to the decision provider keep complete contexts. A scope can start partway through a
source line, so an excerpt contains the selected text, not necessarily the entire first line. Host
plugins without line metadata still show their source, without invented line numbers.

The optional `check.violation-message` supplies a short human-readable explanation beside each violation:

```yaml
check:
  violation-message: Memory limit must not exceed 1.5 times the memory request.
```

The key was renamed from `title`, and in a later breaking change moved inside `check`: an existing rule
must rename its `title:` line — and move a top-level `violation-message:` block — to
`check.violation-message`, because neither `title:` nor a top-level `violation-message:` is recognized any
more. A leftover `title:` warns as an unknown property and prints nothing beside the violation.
`check.violation-message` must be a non-blank string when present, and its content is preserved verbatim.
It is static rule text, not a model-generated reason, and is not sent to the decision provider.
Violations are highlighted red, passing counts green, and
warnings yellow; source code stays uncolored. Colors follow the output stream's terminal support and
respect `NO_COLOR` and `FORCE_COLOR`. Rule names, paths, violation messages, and source excerpts have
terminal control sequences removed before printing.

Unknown rule properties and builtin scope options emit `WARN` messages on `stderr` and are ignored.
The [authoring schema](#authoring-rules) is deliberately stricter: an editor flags the same unknown
property as an error, so a typo is visible while writing the rule, while the runtime keeps its warning.
Invalid values for known fields, malformed filters, and invalid selectors remain errors. Warnings
also appear with `--json`, without contaminating its `stdout`. When no scope matches, the summary
states `0 verifications ran (no matching scopes)` instead of implying compliance.

`check --json` opts into the machine-readable form instead: it prints exactly the JSON array below to
`stdout` and creates no spinner, no progress, and no summary. A piped or scripted caller that wants
parseable result must pass `--json`, since the default human output is not machine-readable. `--json`
changes neither the array's shape or ordering nor the exit codes.

The array is `[{ ruleFile, name, rule, examples, contexts, decisions, violationMessage? }]`, one entry
per executed rule, including rules with no contexts; a rule with `enabled: false` produces no entry.
`name` is the rule's derived name — the filename stem — and `rule` and `examples` carry the check-level
`check.rule` and `check.examples`. `violationMessage` carries the rule's `check.violation-message` — the
YAML key keeps its hyphen and the JSON key is camelCase, which is another breaking rename for a caller
that read the old `title` field — and is omitted when the rule does not define one. `ruleFile` is the
absolute rule path, while each context's `filepath` is relative to the working directory. Contexts
aggregate across files in lexical filepath order; diff-only contexts also include the per-file `diff`.
Builtin scopes include `lines: { start, end }`, an absolute, 1-based, inclusive range in the reviewed
source (the committed head for diff checks). Line metadata is not sent to the decision provider.

`decisions` holds one entry per scope-mode context, in the same order — `{ filepath, scopeId, follows,
probability, model }` — or, for a grouped rule, one entry per group — `{ group: { type, path },
members: [{ filepath, scopeId }], follows, probability, model }`. `follows` is `true` exactly when
`probability > threshold`, using the effective [configured threshold](#configuration). Equality does
not pass. The backend's `probability` and `model` are preserved unchanged; changing the threshold
only changes `follows`.

`check` does all of its preflight before the first request: every rule loads and compiles — a disabled
rule included, before it is dropped from the run — every selected source of an enabled rule is read and
matched, and every group is built, so a parse or read failure has no
external side effect. It then sends each question — for a `kind: AI` rule the same
`follows_instructions` `noul` question for every scope and group it builds: `instructions` carries the
rule text under `rule`, the fixed `Is the rule respected?` under `question`, and its `good` and `bad`
examples under `examples` only when the rule defines at least one — a rule with no examples omits the
`examples` object entirely — with one context: for a
scope, its structured `data` when the plugin exposes one (with `captures` when present) or else its
matched `source`, beside its `filepath` and, in `--diff-only` mode, the per-file `diff`; for a group,
its member files with their scopes, and no group descriptor, which stays internal to grouping, `--json`
and the human report — to the configured provider. A rule whose `check.kind` is `regex` is the
exception: it sends no question, its examples are not evaluated, and its pattern alone decides each
scope. One serialized scope-mode decision looks like this (the key-bearing headers and the surrounding
run are omitted): the rule text, its examples, and the question all sit inside `instructions`, which
adds no per-member condition of its own:

```json
{
  "model": "jev-latest",
  "state": {
    "filepath": "src/routes.ts",
    "scope": { "data": "/public/v1/invoices/{invoice_id}" }
  },
  "questions": {
    "follows_instructions": {
      "type": "noul",
      "instructions": {
        "rule": "URL must STRICTLY start with `/vX/`, where X is a digit.",
        "examples": {
          "good": ["/v1/transactions", "/v2/billings"],
          "bad": ["/firstparty/v1/transactions"]
        },
        "question": "Is the rule respected?"
      }
    }
  }
}
```

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
rule's derived name only after all definitions compile; it compiles a rule with `enabled: false` like any
other, so a disabled rule's fields are still checked and it still appears in the output.

`check` and `inspect` transmit the selected context — or group — to the configured provider. Choose the
endpoint and key deliberately before reviewing a repository whose contents must not leave the machine. A
`regex` check is decided locally, so nothing leaves the machine for it.

Run `node /absolute/path/to/rulekeeper/index.ts check` from the project you want to review.
`npm start -- check` also works from this repository; use `npm run --silent start -- check --json` when
`stdout` must contain only the JSON array rather than the human summary. [index.ts](index.ts) is only the
bootstrap: the Commander declarations live in
[src/adapter/cli/program.ts](src/adapter/cli/program.ts), with the verb implementations in
[src/adapter/cli/check.ts](src/adapter/cli/check.ts) and
[src/adapter/cli/validate.ts](src/adapter/cli/validate.ts) and the runtime wiring in
[src/infra/runtime.ts](src/infra/runtime.ts).

### Inspect

`inspect <rule> [folder]` is the diagnostic counterpart to `check`, for **one** rule at a time. `<rule>`
is either a rule filepath or a rule name — the filename stem of a discovered rule, since a rule file
declares no name of its own. It walks that rule through file selection, scope filtering, and grouping,
then shows the exact request sent to the decision provider and the raw answer received for **every**
verification — the passing ones included; a `regex` check sends no request, since it decides locally. It
always reads the current working tree; it has no diff, JSON-output, or concurrency flags.

```sh
node index.ts inspect duplicated-env                                  # one discovered rule, by derived name
node index.ts inspect .rulekeeper/duplicated-env.yaml                 # the same rule, by filepath
node index.ts inspect duplicated-env /path/to/project                # discover the rule in another working root
```

The optional `folder` is the **working root** and defaults to `.`. It is resolved from the invocation
directory and must be a real directory, so a symlink is rejected. It anchors the rule's
`files.included` / `files.excluded` globs, the filepaths and group paths the run reports, and
rule-name discovery in `<folder>/.rulekeeper` and `~/.rulekeeper`. An explicit rule filepath is
resolved from the **invocation directory** instead, so a rule file may sit outside the folder it is
inspected against, and an existing file wins over name lookup. Names are exact and case-sensitive,
including stems that look like paths. A missing name or file fails; a name matching several rules
fails while listing the candidates. A directory or symlink argument is rejected, since inspect
takes exactly one rule; name lookup itself ignores descriptors it cannot decode, so an unrelated broken
rule file does not block the name you asked for, while the selected rule still has to compile. `.env`
loads from the invocation directory, not from the folder.

Because the folder anchors those globs, a rule listing `tests/manual/*.yml` matches its files only
while the folder is the repository root; inspected from `tests/manual`, that rule needs a
folder-relative glob such as `*.yml`. The root is scanned with the same rules as `check`: `.git`,
`node_modules`, `.rulekeeper`, symlinks, and the rule files themselves are skipped, and only files
matching the rule's globs are read.

Output is a four-step walkthrough, streamed to `stdout` as each stage finishes:

1. **Rule** — the resolved rule file, its derived name (the filename stem), the rule's
   `check.violation-message` as a `Message` field when it defines one, a `Status: DISABLED` line when
   the rule is disabled, `decision.group_by` mode, rule text, and the folder in use.
2. **Files** — how many files were eligible, how many of them had scopes, and the scope totals:
   selected, kept, and filtered. Every eligible file is listed with each surviving scope and each
   scope the applicability filter removed, with their scope IDs and locations. Each file carries one
   whole-file status — `no scope matches`, `all scopes kept`, `fully filtered`, or
   `partially filtered` — so filtering is per scope and a file that kept its other scopes is never
   reported as an excluded file.
3. **Verifications** — numbered `Verification N of M`, one per scope, or one per group when the rule
   sets `decision.group_by` to `file`, `folder` or `project`, with every group member file and scope
   listed. Each verification shows the full JSON body sent to the provider, then the response body
   with its HTTP status, then the resulting `PASS` or `VIOLATION` with probability and model; a `regex`
   check sends no body and decides locally. Nothing is truncated or clipped, and verifications run one
   at a time so every request stays paired with its answer.
4. **Summary** — the verdict, pass and violation counts, the rule identity, file and scope counts, and
   elapsed time. Regex checks add `Evaluator: regex, matched locally`. A run with no verification says
   so instead of implying compliance.

A rule with `enabled: false` is inspected as a disabled rule rather than an empty one: step 1 still names
the rule and adds `Status: DISABLED`, the file step reports that no source file was scanned, and the
summary ends with `Verdict: DISABLED` and `no verification ran`. No source, Git, or provider access
happens, and the output never suggests the rule passed.

Unlike `check`, which writes its result only after every decision succeeded, `inspect` keeps what it
already printed when the provider fails: the failure is reported at that verification, the error also
reaches `stderr` with a nonzero exit status, and no response is invented for a connection that never
answered. An HTTP error or a malformed success body is shown before the failure is reported. A
`VIOLATION` never fails the run, and a rule that selects nothing sends no request, reads no backend
configuration, and needs no API key.

Requests and responses carry the selected source, the rule text, and provider data; the configured API
key is redacted wherever it appears in a serialized body and HTTP headers are never printed, but
nothing else is scrubbed — review the output before sharing it. Colors, `NO_COLOR`, and redirected
output behave as they do for `check`. For a machine-readable result of a whole run, use
[`check --json`](#output-and-execution).

The walkthrough is implemented by [src/app/inspect.ts](src/app/inspect.ts), rendered by
[src/adapter/cli/inspect-report.ts](src/adapter/cli/inspect-report.ts), invoked by
[src/adapter/cli/inspect.ts](src/adapter/cli/inspect.ts), and composed in
[src/infra/inspect.ts](src/infra/inspect.ts).

### Troubleshooting

`check --debug` forces concurrency to `1` across rule loading, source reads, Git snapshots, and
verifications. It overrides a valid `--concurrency` value; invalid values are still rejected. Important
`[debug]` events show effective run settings, phase counts and timings, the backend host/path/model,
verification outcomes, and safe HTTP status or error codes.

`check --verbose` includes those events plus `[verbose]` details: rule identities, selected or skipped
files and skip reasons, reads, eligible contexts per file/rule, group members, and HTTP request metadata.
Verbose HTTP detail deliberately carries payloads: the `http.request` event includes `body`, the
serialized outbound JSON, and a separate `http.response.body` event carries the `id`, `status`, and
body of **every** HTTP response — including non-2xx replies and 2xx replies that fail validation —
logged as received before the decision response is validated, so a non-JSON reply appears as its raw
string. It keeps normal concurrency, including an explicit `--concurrency`. A
selected source can still produce zero contexts after scope selection and filtering; matching
diagnostics report counts rather than source values or individual predicate evaluations.

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

Verbose logging prints those bodies deliberately, so the selected source, policy text, examples, and
raw provider output appear in the logs and may contain arbitrary secrets or stack-trace text. The
configured API key is replaced with `[REDACTED]` wherever it appears in a serialized body, including
a provider echoing it, but nothing else is scrubbed — review verbose logs before sharing them.
Authorization, request, and response headers are never dumped, and the debug-only events stay
body-free. Filepaths, rule names, backend addresses, and model names remain visible. These flags
belong to `check`, not `validate` or [`inspect`](#inspect), which takes only a rule and an optional
folder and prints its walkthrough unconditionally.


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

### Benchmark

`npm run benchmark` runs the tool once over the whole corpus — every rule in `./.rulekeeper` against
`tests/manual` — and records each verification's actual returned probability and reported verdict in a
Markdown report. Every decision is recorded, passing or violating, so the report is a full picture of
what each rule decided rather than a list of violations. It drives `check --json`, so the report carries
the local `0`/`1` score of a `regex` rule and the live provider probability and model of each AI rule. A
grouped rule contributes **one** scored verification for the whole group, not one per member. The manual
corpus deliberately spans both outcomes: the `memory` rule and the `public-proto` regex each see passing
and violating scopes, and the env rule resolves one folder group. AI rules need a real Jev backend and
read the same `.env`, model, and threshold as any `check`; the verdict is taken from the decision the CLI
returned, never recomputed from a threshold, so a rule's threshold or regex override is honored. Pin the
model to keep columns comparable (see [Configuration](#configuration)). The report holds only identities,
scores, and verdicts — no source, request, or credential text.

The report defaults to `benchmarks/manual.md`; pass a path to write elsewhere:

```sh
npm run benchmark                    # update benchmarks/manual.md
npm run benchmark -- path/report.md  # write to another file
```

The first run writes a baseline table with a single score column. Each later run keeps the previous
column and appends a new one stamped with the run's UTC time, so the file shows the last two runs side
by side, and the report states its own command and cell definition. A cell is the unrounded probability,
the model that returned it, and the verdict the decision reported, e.g. `0.812345678 (jev-latest) PASS`,
`0.812345678 (jev-latest) VIOLATION`, or `0 (regex) VIOLATION`. Cells recorded by an earlier version of
the script carry only the score; they are kept verbatim, and a new run never back-fills a verdict into
them. Rows are keyed by rule identity plus scope filepath/identity (or a group's type and path), never
by position, so ordering is irrelevant. A verification missing from the current run keeps its row with an
em dash (`—`) in the new column; a newly appearing one gets a row with an em dash under the previous
column; rows absent from both runs are dropped.

The report is written only after `check` succeeds. A setup or provider failure — a missing key, an
unreachable endpoint, or unusable output — exits nonzero and leaves the existing report unchanged, so an
interrupted benchmark never destroys recorded history. The script lives in
[scripts/benchmark.ts](scripts/benchmark.ts).
