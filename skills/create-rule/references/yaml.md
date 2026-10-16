# The `yaml` selector

Use `format: yaml` when the decision unit is a node in a YAML, Kubernetes, CI, or config document.

## Options

| Option | Required | Meaning |
| --- | --- | --- |
| `path` | yes | A non-executable JSONPath selecting the scope nodes. `$` selects the whole document root. |
| `key` | no | A JSONPath **relative to each selected node** that resolves to exactly one string or finite number; that value becomes the scope's identity. |

Each selected node becomes one scope:

- `data` is the fully resolved node (aliases and `<<` merges resolved), with fields missing or present
  exactly as in the source — not just the fields that changed.
- `source` is the exact matched text, unformatted. An alias keeps its alias spelling as `source` while
  `data` carries the target, so an anchor change still registers as a change.
- `id` is `${documentIndex}:${keyValue}` with `key`, otherwise `${documentIndex}:${jsonPointer}`.
  Positions never contribute to identity, so moving lines does not create a new scope.

Multiple documents are supported and every document is parsed; a parse error in any document fails the
match. An empty source selects nothing.

## Path depth — `$.*` vs `$..`

JSONPath depth is the difference between "the containers" and "every `env` in the file":

- `$.containers[*]` — the `containers` entries of the root mapping only.
- `$..env` — the descendant selector: **every** `env` mapping at any depth (`global.env`, each
  container's `env`, and any deeper one).
- `$.*.env.text` — one level of keys under the root, then `env`, then `text`.

Spelling is exact: a path segment `tenv` does not match a key named `env`, and a missing path selects
nothing rather than erroring. Reach for `$..name` when the field can appear at several depths; use an
explicit chain when position is part of the rule.

## `key` and identity

`key` names a scope by a stable field instead of by position. Use it when the same logical object can
move within the file:

```yaml
scope:
  format: yaml
  path: $.containers[*]
  key: $.name
```

`key` may select a string or a finite number; it must resolve to exactly one value per selected node.
Duplicate ids within one revision are an error, so a `key` that is not unique in a file fails rather
than silently collapsing scopes.

## The filter root

`filter` operates on the **scope wrapper** `{ id, source, data?, captures?, lines? }`, never on the raw
file. Address values through `$.data`:

- `$.data.tags` tests the array node itself; `$.data.tags[*]` tests its elements.
- A path that resolves to nothing makes `non_empty` false.
- `0`, `false`, and `" "` count as present; `null`, `""`, `[]`, and `{}` do not.

Operators are `non_empty`, `all`, `any`, `not`, with exactly one operator per mapping. `non_empty`
requires a path starting with `$`. Groups must be nonempty and may nest. Script and predicate
expressions (`?(`, `(`) are rejected at compile time, not evaluated.

Keep the opposite side visible when one field alone is not the decision — the filter's job is
relevance, so an `any` keeps a scope that is missing its counterpart and lets the reviewer notice:

```yaml
filter:
  any:
    - non_empty: $.data.resources.requests.memory
    - non_empty: $.data.resources.limits.memory
```

## Complete example

Review every Kubernetes-style container; keep a scope if either memory setting is present; require the
limit to stay within 1.5× the request.

```yaml
version: 'v1'
files:
  included:
    - charts/**/*.yaml
scope:
  format: yaml
  path: $.containers[*]
  key: $.name
filter:
  any:
    - non_empty: $.data.resources.requests.memory
    - non_empty: $.data.resources.limits.memory
check:
  rule: Memory limit must be less than or equal to memory request * 1.5; both memory request and memory limit must be specified. Compare both values in the same units.
  examples:
    good:
      - |
        resources:
          requests:
            memory: 512Mi
          limits:
            memory: 512Mi
      - |
        resources:
          requests:
            memory: 512Mi
          limits:
            memory: 768Mi
    bad:
      - |
        resources:
          requests:
            memory: 512Mi
          limits:
            memory: 1Gi
      - |
        resources:
          limits:
            memory: 1Gi
  violation-message: Memory limit must not exceed 1.5 times the memory request.
```

The `good`/`bad` pairs differ only in the ratio or in a missing field, which is exactly what decides
the verdict. The policy states the bound, the unit rule, and the completeness requirement; it does not
describe how to compute anything. The filename — `memory-ratio.yaml` — is the rule's name.

## Whole-file variant

To judge a document as one unit — the file here would be `service-owners.yaml` — select the root and
state a policy about the document as a whole:

```yaml
version: 'v1'
files:
  included:
    - config/**/*.yaml
  excluded:
    - config/vendor/**
scope:
  format: yaml
  path: '$'
  changed: false
check:
  rule: Every entry under services must declare a non-blank owner string.
  examples:
    good:
      - |
        services:
          billing:
            owner: platform
    bad:
      - |
        services:
          billing:
            owner: ""
```

Both snippets differ only in the `owner` value, which is the decisive fact. `changed` only matters for
revision inputs: `true` (the default) compares base against head, while `false` takes the supplied head
as-is and needs no base. It is inert for whole-file inputs, and it does not itself choose tree-versus-diff
mode — `check --diff-only` still compares the committed base and `HEAD` for a scope-mode rule, forcing
changed-only comparison even when the rule sets `changed: false`. A rule grouped by `file`, `folder`,
or `project` reads the current tree regardless.
