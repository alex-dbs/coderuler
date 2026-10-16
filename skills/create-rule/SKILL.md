---
name: create-rule
description: Author, review, or repair rulekeeper rule YAML — one file, one rule, named by its filename stem. Use when writing or editing a rule under .rulekeeper/, choosing a scope selector (yaml, protobuf, ast-grep), writing applicability filters, choosing the check kind (AI or regex), phrasing the policy and its good/bad examples, configuring decision grouping (scope/file/folder/project), or setting violation-message, enabled, and settings metadata.
---

# Create a rule

**One YAML file = one rule, named by its filename stem.** A rule selects complete *scopes* from the
files it matches, optionally removes irrelevant scopes, and judges each surviving scope — or each
group. A `kind: AI` check hands them to the decision provider together with the policy and its
examples; a `kind: regex` check tests them locally against its pattern. Rule YAML never loads
executable code, imports modules, or runs a script; every selector is declarative JSONPath or a native
ast-grep rule.

## When to use

- Write a new rule, in `.rulekeeper/` or a `--rules` path.
- Fix a rule that selects too much, too little, or the wrong thing.
- Choose a selector kind, a check kind, a filter, a grouping, or a metadata field.
- Diagnose `0 verifications ran` or a rule that decides a scope without the evidence it needs.

## Rule file anatomy

Required top-level keys: `version` (exactly `'v1'`), `files` (`included`, optional `excluded`),
`scope`, `check`. Optional: `filter`, `decision`, `settings`, `enabled`.

A rule's **identity is its filename stem** — the basename without `.yaml`/`.yml`. There is no `name`
field: the file declares the name. The stem is what `validate` prints, what the human report header
shows, what `--json` carries as `name`, and what `inspect <name>` resolves (exact and case-sensitive;
duplicate stems across loaded files remain an ambiguity error).

- `scope` — `{ format, changed?, …plugin options }`. `format` picks one of `yaml`, `protobuf`,
  `ast-grep` (or a host-registered plugin). `changed` defaults to `true` for revision inputs and is
  inert for whole-file inputs.
- `check` — how a matched scope is judged, with `rule` required:
  - `kind` — the evaluator: `AI` (the default) or `regex`. Spelling is exact, so `ai`, `Regex`, or
    `regexp` is an unknown value and fails compilation.
  - `rule` — one declarative policy statement under `AI`, sent to the provider as the requirement a
    matched context is expected to satisfy. Under `kind: regex` it is the **raw JavaScript
    regular-expression source**, written without `/…/` delimiters and with no separate flags field,
    and the runtime compiles it during compilation, so an invalid pattern fails before any file is
    read. Either way this is the check-level rule, a different field from the nested `scope.rule`,
    which is ast-grep's structural selector.
  - `examples` — `good`/`bad` snippet lists; sent to the provider inside `instructions.examples` only
    when at least one list is non-empty (the empty counterpart is kept); with none, the request omits
    `instructions.examples` entirely. Never executed.
    Under `kind: regex` the pattern alone decides and they are not evaluated.
  - `violation-message` — short static human text shown beside violations; report-only, never sent to
    the provider.
- `filter` — sibling of `scope`; decides which selected scopes are *relevant*. Not a compliance test.
- `decision` — how scopes are grouped into review calls.
- `settings` / `enabled` — per-rule provider overrides and an execution switch.

Under `kind: AI`, what the provider actually receives is one `noul` question — `instructions.rule`
carrying the `check.rule` policy text, the fixed `instructions.question` `Is the rule respected?`, and
`instructions.examples` carrying the `good` and `bad` examples only when the rule has any — and one
scope — or, for a grouped rule, the group's member files and their scopes. Scope-mode `check --diff-only`
also sends the file-level patch as `state.diff`; it may include changes outside the selected scope and
removed values. Scope selection is not a privacy boundary. The group descriptor `{ type, path }`,
`check.violation-message`, and local threshold stay out of that payload.

A `kind: regex` check calls no provider: it is decided locally and offline, with no API key, no
`TYPESAFE_*` environment, and no backend, so no model is consulted and no request leaves the machine.
The pattern is tested against the scope's scalar **string data** (`String(data)` for a string, number,
or boolean); when the scope carries no `data` (ast-grep scopes) or its `data` is structured (an object
or array), the selected scope's `source` is used instead. A match follows the rule (passes) and a
mismatch is a violation. In a grouped rule every member scope is tested independently and the group
passes only when every member matches.

Unknown keys in the rule, `check`, `decision`, and builtin scope options are **ignored with a `WARN`**;
invalid values for known keys, malformed filters, and bad selectors are **compile errors**.
There are no aliases: a stale `name:`, `title:`, or top-level `rule:`/`examples:`/`violation-message:`
warns as an unknown property and is ignored. `check.violation-message` replaced the former `title`.

## Workflow

1. **Pick the files.** Globs are relative to the working root (the `check` cwd or the `inspect`
   folder), POSIX-normalized, matched with Node's `path.matchesGlob`, include-then-exclude.
2. **Pick the smallest selector that isolates the decision.** One unit of judgment per scope: an RPC,
   a container, a function, a whole file. See the selector references below.
3. **Filter only when some selected scopes are irrelevant.** A filter cannot compute compliance.
4. **State the policy in `check.rule` as one requirement**, with its baseline, bound, and any exception.
   When the fact is a pure string shape, prefer `kind: regex` and write the raw pattern instead.
5. **Write contrastive examples** in `check.examples` where good and bad differ only in the fact that
   decides the verdict.
6. **Add metadata** — `check.violation-message`, `enabled`, `settings` — only as needed.
7. **Group only when one scope cannot see the evidence.** `file`, `folder`, and `project` judge
   several scopes together and read the whole current tree.
8. **Validate offline, then prove it with deterministic evidence** (see *Verify* below).

## Files and selection

```yaml
files:
  included:
    - charts/**/*.yaml
    - '**/*.yml'
  excluded:
    - charts/vendor/**
```

- `included` needs at least one glob; `excluded` is optional. Include first, then subtract exclusions.
- `**/` matches zero or more directories, so `**/*.yaml` covers root-level and nested files.
- A separator-less glob (`*.yaml`) matches only entries at the current level — there is no basename
  matching. Wildcards do not match a dot-prefixed segment.
- A glob is anchored at the working root, not the target path, so a rule run from `charts` needs
  root-relative globs. `check <path>` narrows the scan; it does not change the glob base.
- Recursive scans skip `.git`, `node_modules`, `.rulekeeper`, symlinks, and loaded rule files.
  `.gitignore` is not consulted.

## DO / DON'T

| DO | DON'T |
| --- | --- |
| State one declarative requirement: *Memory limit must be ≤ 1.5× the memory request.* | Write an evaluator workflow or a command sequence ("first parse…, then compare…, then report"). |
| Name the baseline and a hard bound: *≤ 1.5×*, *must be plural*, *must not redeclare*. | Use vague quantifiers ("reasonable", "too large") that a reviewer must guess at. |
| Include every scope the decision needs, grouping when one scope cannot see its counterpart. | Write a scope-mode rule whose verdict needs another file or the whole repo — the provider only sees the scopes you send. |
| Make `good` and `bad` differ only in the decisive fact. | Write examples that contradict each other or the policy, or that hide extra differences. |
| Keep the policy and its cumulative exceptions complete: *Version segments and {id} parameters are allowed.* | Push a compliance test into `filter` — filters decide relevance, not whether a scope complies. |
| Use `check.violation-message` for a static human summary. | Use `title` or a top-level `violation-message` (both removed), or expect any message text to reach the provider. |
| Put the selector in `scope.rule` (ast-grep) and the policy in `check.rule`. | Confuse `scope.rule` with `check.rule`, or rely on the selector to prove the policy. |
| Reach for `kind: regex` when the fact is a pure string shape on the scope's data. | Approximate a semantic policy with a regex, or expect `check.examples` to be scored under `kind: regex`. |
| Choose the smallest scope that still contains the evidence. | Select a whole file when one node is the unit, or one node when the verdict needs the file. |

## References

- [YAML](references/yaml.md) — the `yaml` selector, JSONPath depth (`$.*` vs `$..`), `key`, the filter root,
  and a complete YAML rule.
- [Protobuf](references/protobuf.md) — the `protobuf` selector, its record shape, and a complete protobuf rule.
- [ast-grep](references/ast-grep.md) — the native ast-grep selector, captures, and a complete ast-grep rule.
- [Grouping and settings](references/grouping-and-settings.md) — `check.kind` (`AI` vs `regex`),
  `decision` grouping (`scope`/`file`/`folder`/`project`, folder `level`), `check.violation-message`,
  `enabled`, and `settings` precedence and limits.

## Verify

1. **Validate offline first.** `node index.ts validate <rule-file>` compiles the rule and reads no
   network and no provider key; it prints `Valid rule: <derived-name> (v1)`, where the name is the
   rule file's stem.
2. **Prove selection deterministically.** Confirm relevant compliant and violating samples both yield
   the expected scopes, while irrelevant inputs do not. Spelling and depth matter (`tenv` is not
   `env`). A compliant sample still matching is expected: selection is not the verdict.
3. **Inspect the real request.** `node index.ts inspect <rule>` takes a rule file path or a rule name —
   the filename stem — and prints the exact outbound body and the raw response for each verification;
   review it before sharing, since it carries selected source. `inspect` sends the context to the
   configured provider — that is the privacy of your run, so point it at the endpoint and key you
   intend. A `kind: regex` rule needs neither endpoint nor key: nothing is sent.
4. **Check both verdicts.** Confirm a compliant sample and a violating sample score as expected; for a
   `kind: regex` rule the verdict comes from the local pattern alone.

Never claim a provider check you did not run, and never wire a live provider round-trip into the
deterministic suite — those tests run offline and assert selection, filtering, and grouping only.
