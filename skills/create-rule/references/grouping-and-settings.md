# Grouping, metadata, and settings

## Decision grouping

`decision.group_by` chooses what one review call judges:

| `group_by` | One review per | Extra keys | Reads |
| --- | --- | --- | --- |
| `scope` (default) | selected scope | — | the diff, or the whole file for whole-file inputs |
| `file` | file's surviving scopes | — | current working tree only |
| `folder` | directory of selected files | `level` | current working tree only |
| `project` | the whole selected tree | — | current working tree only |

Omitted, every scope is decided on its own.

A grouped rule **ignores the diff entirely** and reads the current working tree — unchanged, untracked,
and dirty files alike. Under `check --diff-only` it is collected exactly as a plain run, needs no Git
lookup, and leaves `--base` unused. Grouping only ever regroups what the target already selected: a
`project` group is the whole selected tree (every file for `check .`, but only `charts` for
`check charts`), and a `folder` group holds the selected files that resolve into that directory and
none outside it.

`folder` accepts `level`, a non-positive safe integer: it defaults to `0` (the file's own directory),
`-1` selects the parent, and any ancestor beyond the root clamps to `'.'`. `level` on a non-`folder`
grouping is ignored with a warning.

Two facts stay internal (both describe `kind: AI`; a `kind: regex` check sends nothing):

- The **group descriptor** `{ type, path }` names the group for the human report and `--json`. The
  outbound request carries the member files and their scopes — `{ files: [{ filepath, scopes }] }` —
  never the descriptor.
- The question sent to the provider is one `follows_instructions` `noul` question, identical for scope
  and group decisions: `instructions.rule` carries the `check.rule` policy text, `instructions.question`
  is the fixed `Is the rule respected?`, and `instructions.examples` carries the `good` and `bad`
  examples only when the rule defines at least one — a rule with none omits `instructions.examples`.
  The instructions add no per-member condition of their own, so a grouped rule is
  judged by the policy it wrote, not by an extra per-member test. The `check.rule` text and its examples
  are never executed.

### Choose the smallest sufficient group

Group only when one scope cannot see the evidence a correct verdict needs. A scope-mode rule that
depends on another file's contents is undecidable: the provider sees that scope alone.

DO group when a redeclaration must be compared across a file or folders:

```yaml
version: 'v1'
files:
  included:
    - '**/*.yaml'
    - '**/*.yml'
scope:
  format: yaml
  path: $..env
filter:
  non_empty: $.data.text
check:
  rule: A container's env.text must not redeclare any name that global.env.text declares, even with an identical value; the same name may appear in more than one container as long as global.env.text does not declare it.
  examples:
    good:
      - |
        global:
          env:
            text:
              DB_HOST: db
        app:
          env:
            text:
              APP_MODE: prod
    bad:
      - |
        global:
          env:
            text:
              DB_HOST: db
        app:
          env:
            text:
              DB_HOST: db
  violation-message: A container env must not redeclare a global env name.
decision:
  group_by: file
```

`$..env` selects `global.env` and each container's `env` in one file; `group_by: file` judges them
together, so the container scope can see what `global.env.text` declares. A single scope could not.

DON'T group when the scope already carries everything the verdict needs — it costs one request per
group and, for `file`/`folder`/`project`, discards the diff. DON'T assume a grouped rule reads a
broader tree than the target: `check charts` with `group_by: project` sees only `charts`.

Folder and project variants of the same policy:

```yaml
decision:
  group_by: folder
  level: -1
```

```yaml
decision:
  group_by: project
```

## `check.kind`

`kind` selects the evaluator and is required to be spelled exactly `AI` (the default) or `regex`. Any
other casing or spelling — `ai`, `Regex`, `regexp` — is an unknown value and fails compilation, like
any other invalid value for a known key.

`kind: AI` sends `check.rule` as `instructions.rule`, the fixed `instructions.question`, and — only
when `check.examples` holds at least one entry — its `good`/`bad` examples as `instructions.examples`,
in the question described above. A rule with no examples omits `instructions.examples`.

`kind: regex` treats `check.rule` as **raw JavaScript regular-expression source**: written without
`/…/` delimiters and with no separate flags field. The runtime compiles it with `new RegExp(…)` during
compilation, so an invalid pattern fails compile before any file is read. Evaluation is entirely
**local and offline** — no decision provider call, no API key, no `TYPESAFE_*` environment, no backend,
so nothing leaves the machine:

- The pattern is tested against the scope's scalar **string data** (`String(data)` for a string, number,
  or boolean `data` value).
- When the scope carries no `data` at all (ast-grep scopes) or its `data` is structured (an object or
  array), the selected scope's `source` is used instead.
- A **match follows the rule (passes)**; a **mismatch is a violation**.
- In a grouped rule every member scope is tested independently and the group passes only when **every**
  member scope matches.
- `check.examples` are not evaluated: the pattern alone decides, so a regex rule needs no model, no
  threshold, and no backend.

Because no provider is consulted, a regex rule reads no provider configuration and can be validated
and checked with no key present.

```yaml
scope:
  format: yaml
  path: $.containers[*].image
check:
  kind: regex
  rule: '^ghcr\.io/acme/'
```

The quotes are YAML's, not the pattern's: single-quoted scalars keep the backslash, so the raw source
`^ghcr\.io/acme/` is exactly what `new RegExp(…)` receives. Under `kind: regex` the `settings`
threshold, model, and backend below are all inert, and no provider key is read.

## `check.violation-message`

A short, static, human-readable description printed beside violations (and carried in `--json` as
`violationMessage`, and labelled in `inspect`). When present it must be a non-blank string; content is
preserved. It is **report-only**: it is not a model-generated reason and is never sent to the provider.
The policy that reaches the provider is `check.rule`, not this message, and the pattern that decides a
regex check is `check.rule` too. The former `title` key is gone; a stale `title:` now warns as an
unknown field. An unknown key inside `check` warns the same way and is ignored.

## `enabled`

Defaults to `true`. Set `enabled: false` to keep a rule in the file set but out of the run:

- It still compiles and validates — `validate` reports it, and every field must be valid.
- `check` does not execute it: it is absent from results, counts, and `--json`, and its descriptor is
  still excluded from being reviewed as source. When every loaded rule is disabled, the run completes
  with zero counts and reads no sources, Git, or provider.
- `inspect` on a disabled rule reports it as `DISABLED`, scans no files, and runs no verification; it
  never claims compliance.

The value must be an actual boolean (`false`), not `"false"`, `0`, or `null`.

## `settings`

Optional per-rule provider overrides:

```yaml
settings:
  model: jev-latest
  threshold: 0.6
  backend: jev
```

- `threshold` — a finite number in `[0, 1]`, inclusive. No numeric strings.
- `model` — a non-blank model name. Set it only to deliberately pin a model; otherwise inherit
  `TYPESAFE_DEFAULT_MODEL`.
- `backend` — `jev` is the only supported value. Any other name is rejected offline rather than
  silently ignored.

Unknown `settings` keys warn and are ignored, like other unknown rule keys.

**Precedence**

- Threshold: `check --threshold` > `settings.threshold` > `RK_THRESHOLD` > `0.4`. A higher-priority
  valid value means a lower-priority invalid environment value is never evaluated.
- Model / backend: `settings.model` / `settings.backend` > `TYPESAFE_DEFAULT_MODEL` /
  `RK_BACKEND` > default.

**Threshold semantics.** The threshold is a local compliance cutoff: a decision counts as compliant
only when its probability is strictly greater than the threshold, so raising it requires more
confidence before a scope is called compliant and turns more borderline scopes into violations, not
fewer. It is not sent to the provider, the provider's probability and model are preserved unchanged,
and `check` never fails a build on a violation — it exits `0` even when every decision is false. There
is no blocking guarantee and no accuracy gain from the number itself, so tune it against the scores you
observe for known good and bad samples rather than assuming a higher value is safer.

**Credentials stay in the environment.** `settings` carries no API key and no base URL — those come
only from `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL`. A rule file must never hold a secret.

A per-rule decision service is created lazily, only when that rule has actual verifications, so a
disabled rule, a rule that selects nothing, and a fully filtered rule all read no provider
configuration and need no key. A `kind: regex` rule never creates one at all.

## Complete example

A fully specified rule (the file is `duplicated-env.yaml`) that sets a threshold, carries a report
message, and is grouped by folder:

```yaml
version: 'v1'
files:
  included:
    - tests/manual/*.yml
scope:
  format: yaml
  path: $..env.text
filter:
  all:
    - non_empty: $.data.*
check:
  rule: No env override may redundantly repeat a default value. Defaults are the variable-name/value entries of every scope in default.yml; every scope in every other file is an override. An override violates the rule when it has a variable with the same name and the same value as a default. One such override anywhere makes the whole group noncompliant, regardless of other variables, scopes, or files. New variable names and changed values are allowed.
  examples:
    good:
      - "default.yml {A:one,B:two}; production.yml {A:changed}; staging.yml {B:changed}"
    bad:
      - "default.yml {A:one,B:two}; production.yml {A:changed}; staging.yml {B:two}"
  violation-message: An env var is overridden with the default value, so it can be removed.
decision:
  group_by: folder
settings:
  threshold: 0.6
```

`$..env.text` selects the `env.text` mapping at every depth, so each override location in a group is
judged, not only a shallow one. The `good`/`bad` pairs differ only in whether an override repeats a
default value; the policy states the comparison baseline (every default in `default.yml`), the
quantifier (one override anywhere fails the group), and the allowance (new names and changed values).
`group_by: folder` puts every selected file of the directory under one verdict, so the defaults from
`default.yml` and the overrides in the other files are reviewed together.
