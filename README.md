# rulekeeper

**One YAML file = one rule.** rulekeeper selects complete *scopes*, filters their applicability, and
builds each scope's review context. `check` then sends the rule, its examples, and every selected
context to the configured HTTP decision provider and reports, per scope, the probability and model
it answered with. `validate` stays offline and only compiles rules.

Scope selection itself — the matcher, applicability filters, and context contract — is a
deterministic, network-free core, and the [golden tests](#checks) exercise it without any model call.
The rule schema, plugins, matching semantics,
[limitations](docs/rulekeeper-design.md#limitations), and
[decision boundary](docs/rulekeeper-design.md#the-decision-boundary) are documented in
[docs/rulekeeper-design.md](docs/rulekeeper-design.md); the design decisions, bug fixes, and accepted
trade-offs behind the current code are recorded in [docs/retrospective.md](docs/retrospective.md).

The ast-grep plugin supports all **31 officially published languages**, with case-insensitive names
and common aliases such as `py`, `rs`, and `c++`. See the
[language catalog and custom-grammar setup](docs/rulekeeper-design.md#builtin-plugins).

## Requirements

- **Node.js 24 or later** — the sources are typed TypeScript executed directly (no compile step).
- **Git 2.45 or later** — only for `--diff-only`; older Git rejects the `--no-lazy-fetch` option.
- **A decision provider** — an HTTP endpoint and API key for `check`; both come from the environment
  (see [Configuration](#configuration)) and `validate` needs neither.

Private package: install the pinned dependencies once with `npm ci`; there is no build output, no
published package, and no globally installable binary.

## Quickstart

`check` decides each selected scope with TypeSafe's Jev provider by default, so set a key before
running it. The canonical variable is `RULEKEEPER_DECISION_API_KEY`; the official `TYPESAFE_API_KEY`
is used as a fallback when that is unset.

```sh
export TYPESAFE_API_KEY=...      # or: export RULEKEEPER_DECISION_API_KEY=...
node index.ts check              # select scopes in the current folder, then decide each one
```

Change the endpoint and model with `RULEKEEPER_DECISION_BASE_URL` and `RULEKEEPER_DECISION_MODEL` if
you do not want the defaults. The base URL is the provider origin; the adapter appends the
`v1/systemone` endpoint path to it. Only a run with at least one selected scope needs a key:
`validate`, and a `check` that selects nothing, never read the configuration.

## Configuration

At startup the CLI loads `.env` from the **current working directory**, using Node's built-in loader.
Existing shell variables take precedence. A missing file is allowed; other file errors fail startup.
The local `.env` is gitignored: uncomment its API-key entry and fill in your key before checking code.

`check` builds its decision service from the environment **at call time**, not at import, so the
process that only compiles rules never needs a provider:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RULEKEEPER_DECISION_API_KEY` | — (required) | Bearer key sent to the provider. The official `TYPESAFE_API_KEY` is used when this is unset. |
| `RULEKEEPER_DECISION_BACKEND` | `jev` | Backend to use; `jev` is the only supported value. |
| `RULEKEEPER_DECISION_MODEL` | `jev-latest` | Model name sent with every question. |
| `RULEKEEPER_DECISION_BASE_URL` | `https://api.typesafe.ai` | Provider origin; the adapter appends the `v1/systemone` endpoint path to it. |

A variable that is set but blank fails the run instead of silently taking a default, and surrounding
whitespace is trimmed. The base URL must be an absolute `http`/`https` URL with no query, fragment, or
embedded credentials. A missing key fails only when there is a context to decide.

## CLI

```sh
node index.ts check                       # check the current folder
node index.ts check src                   # check a file or folder
node index.ts check --diff-only          # committed branch changes vs the default branch
node index.ts check --diff-only --base origin/my-branch
node index.ts check --rules rules.yaml    # use one rule
node index.ts check --rules ./my-rules    # use all rules in a folder
node index.ts validate                   # validate discovered rule definitions
node index.ts validate ./my-rules        # validate an explicit rule file or folder
```

`check [path]` defaults to `.`. Rule globs and context filepaths are relative to the **working
directory**; a target such as `src` narrows the scan without changing that base. Only files selected
by a rule's `files.included` / `files.excluded` are read. Selected scopes then pass through the rule's
applicability filter. Without `--diff-only`, sources come from the working tree.

Recursive source scans skip `.git`, `node_modules`, `.rulekeeper`, symlinks, and the loaded rule
files themselves. An explicitly selected source symlink is rejected. `.gitignore` is not consulted.

### Branch diffs

`--diff-only` requires Git 2.45 or later and compares the **merge base of the base branch and
`HEAD`** to committed `HEAD`, like a pull request. It reviews new/changed scopes with complete
context, not just added lines. Unchanged sibling scopes are excluded, even with
`scope.changed: false`.

The default base is `origin/HEAD`, falling back to `origin/main`, `origin/master`, `main`, then
`master`. `--base <ref>` overrides it and requires `--diff-only`. References must exist locally;
the command never fetches. Every Git call carries `--no-lazy-fetch` with `GIT_TERMINAL_PROMPT=0`, so
a partial clone whose objects are missing fails the read instead of contacting the promisor remote,
and Git older than 2.45 fails loudly on the unsupported option. That no-network guarantee covers
**Git operations only**: `check` still contacts the decision provider over HTTP for whatever scopes the
diff selects.

Staged, unstaged, and untracked source changes are **not** included. Rule definitions still come
from the current working tree and home directory. `[path]` and `--rules` work in both modes, and a
`[path]` must lie inside the repository (it need not exist on disk, so committed changes stay
checkable after a local deletion).


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

`check` prints a JSON array of `{ ruleFile, name, rule, examples, contexts, decisions }`, one entry
per loaded rule, including rules with no contexts. `ruleFile` is the absolute rule path, while each
context's `filepath` is relative to the working directory. Contexts aggregate across files in lexical
filepath order; diff-only contexts also include the per-file `diff`.

`decisions` holds one entry per context, in the same order — `{ filepath, scopeId, follows,
probability, model }`. `follows` is `true` exactly when `probability > 0.5` (a tie at `0.5` is not a
following decision), and the backend's `probability` and `model` are preserved unchanged, so a
borderline answer reads the same here as the provider reported it.

`check` writes nothing before all rules compile and all of its contexts are collected, so a parse or
read failure has no external side effect. It then sends, one awaited question per context in
rule and context order, the rule text, its normalized examples, and the context — the scope's
`source`, `data`, and `captures`, its `filepath`, and, in `--diff-only` mode, the per-file `diff` —
to the configured provider. Requests time out after 30 seconds, are never followed across redirects,
and are never retried on a server error; there is no offline or mocked fallback. Only after every
decision succeeds is the array written in a single atomic `stdout` write, so a failure never leaves
partial JSON.

A successful run exits `0` **even when every decision is `false`** — `check` reports the answers, it
does not assert compliance and does not fail a build on a failing scope. Setup, parse, and provider
errors exit nonzero with a stderr message and no JSON. `validate` still never calls the provider and
prints each rule's identity only after all definitions compile.

`check` transmits the selected context to the configured provider. Choose the endpoint and key
deliberately before reviewing a repository whose contents must not leave the machine.

Run `node /absolute/path/to/rulekeeper/index.ts check` from the project you want to review.
`npm start -- check` also works from this repository; use `npm run --silent start -- check` when
stdout must contain only JSON. All Commander declarations live in [index.ts](index.ts), with
implementations in [command/](command/).

## Checks

```sh
npm run typecheck
npm run test:golden
npm test
```

The 39 golden fixtures are deterministic and never call a decision provider, so they run without a
key or network access.
