# Retrospective: a maintainability pass over all 78 files

Scope: the 78 project files present at the start of the pass — `README.md`,
`docs/rulekeeper-design.md`, the example rule, the test suites (`src/*.test.ts`, `tests/golden/**`),
the library (`src/**`, `src/plugins/**`), the CLI (`index.ts`, `command/**`), and configuration;
installed dependencies were out of scope. The goal was less code and sharper docs at unchanged
reliability: the v1 YAML contract, the 31-language ast-grep surface, and the pre-Jev boundary held.

## Architecture decisions

- **Small interfaces, not a class hierarchy.** Plugins implement `ScopePlugin`/`CompiledScope`;
  compiled rules capture configuration once and expose `match`/`matchesFile`. Classes remain where
  they organize parser, registry, or adapter state. No base-class hierarchy or dependency-injection
  framework is needed.
- **A private registry, not dynamic loading.** `parseRule`/`compileRule` default to a registry with
  the three builtins; a host adds plugins through `createPluginRegistry([...])`. Rule YAML never names
  a module to import, so a rule file can never pull in code.
- **One non-executable JSONPath helper.** `src/jsonpath.ts` owns the `[?(...)]`/`[(...)]` rejection
  for every selector the tool compiles, instead of each caller re-deriving it.
- **`async`/`await`, never promise chains.** Async code reads as straight-line `await` in
  `try`/`catch`; independent work uses `Promise.all` (a file's base blob, head blob, and patch are
  read concurrently); a bare promise appears only at a callback boundary — the single `spawn` wrapper.

## What changed, and why

- **Docs were split by audience.** `README.md` stays a short orientation; `docs/rulekeeper-design.md`
  carries the schema, plugin, matcher, and CLI reference, and its drifted inline copy of the billing
  rule was replaced by a link to the canonical `docs/rules/billing-http-url.yaml`.
- **Golden fixtures stopped restating the rule.** Cases carried a static `rule` + `examples` copy in
  every expectation; `expected` is now `{ contexts }` or `{ error: { stage } }` only, with the rule
  text and examples living once per group. This removed roughly 1.4k lines of duplicated YAML and
  repeated static-metadata assertions. Core tests cover normalization, CLI tests cover the output
  boundary, and all 39 behavioral golden scenarios remain.
- **Real bugs fixed, each pinned by a case.** Repeated AST declarations (overloads, redefinitions)
  collided on the duplicate-ID error; a repeat now takes a `#N` suffix in document order. The protobuf
  reader skips a leading UTF-8 BOM instead of swallowing the first declaration, accepts dotted
  `option (google.api.http).get = …` statements, and decodes octal/hex escapes as UTF-8 bytes. YAML
  mapping keys that are non-finite numbers (`.inf`, `.nan`) stringify as the YAML package does instead
  of failing the scope. Rule discovery deduplicates roots by physical directory, so `~/.rulekeeper`
  reached under two spellings no longer yields duplicates. Branch diffs run Git with
  `--no-lazy-fetch`, so a partial clone with missing blobs fails instead of silently fetching.
- **A rule descriptor cannot be reviewed as its own source.** With `--rules alias.yaml` pointing at a
  symlink, the real rule file could still be selected by a broad glob and handed to itself. Descriptor
  exclusion now compares canonical paths in both modes, while reported paths stay logical and diff
  sources keep coming from Git blobs, not the working tree.
- **Preventive checks over prose.** `tsconfig.json` enables `noUnusedLocals`/`noUnusedParameters` and
  includes `tests/**/*.ts`; `.gitignore` went from 149 lines of unrelated template/framework rules to
  the 14 that matter, keeping the `.env` and secret ignores.

### Corrections from the second review

Late review reproduced four more defects, corrected in the same pass: dotted `additional_bindings`
and `custom` paths interleaved with a primary option aggregate; a hand-written UTF-8 decoder that
could drop ASCII after a malformed prefix, replaced with the platform decoder; an unknown
angle-bracket option that should be skipped by token balancing rather than erroring; and fixtures
inheriting an ambient `GIT_INDEX_FILE` — the fixture environment now drops inherited `GIT_*`.

## Findings challenged or retracted

- "YAML `null` selections are broken" — false; an empty scalar already extracts as `source: ''` and
  `data: null`, so there was no extraction bug. Only `non_empty` rejected the empty value, as designed.
- "Alias expansion is a denial-of-service gap" — false; `maxAliasCount` (100) already bounds it.
- Lexical diff targets, renames leaving a selected target, and cwd-relative glob semantics were
  challenged but retained: changing them would alter the documented selection contract.
- "pbkit cannot read `additional_bindings` lists" — disproved by direct experiment (below).
- "The golden suite must repeat the rule in every case" — removed; the runner compiles the real rule.

## Protobuf library evaluation

The in-house reader exists because the requirement is *exact source text plus a tolerant,
non-compiling parse*, and the mainstream libraries offer one or the other:

- [protobufjs](https://github.com/protobufjs/protobuf.js) keeps no source offsets or ranges in its
  type tree, so it cannot recover the exact `rpc …` block text.
- Buf's [protobuf-es](https://github.com/bufbuild/protobuf-es) and its
  [protoplugin package](https://github.com/bufbuild/protobuf-es/tree/main/packages/protoplugin) are
  descriptor-based (`FileDescriptorProto`); source ranges are not preserved.
- [pbkit](https://github.com/pbkit/pbkit) 0.0.72 *does* keep source ranges, so it was exercised in an
  isolated runtime: an ordinary aggregate and an `additional_bindings` list parsed, but the
  whole-angle aggregate form, a Unicode escape, and a one-digit hex escape failed. Adopting it would
  mean forking or running a second parser to keep the exact-source and tolerant forms the fixtures
  pin, so it was declined.
- [tree-sitter-proto](https://github.com/treywood/tree-sitter-proto) — the grammar the
  nvim-treesitter registry points at — needs a tree-sitter engine and its own WASM/native grammar,
  which `@ast-grep/napi` does not provide, so it is not a drop-in.

No runtime dependency was added or removed. Direct dependencies remain `@ast-grep/napi`, the 26
`@ast-grep/lang-*` grammar packages, `jsonpath-plus`, `yaml`, and `commander`; JSONPath is always
invoked with `eval: false`.

## Testing strategy

- **Real pipeline, hand-authored data.** Goldens call the real `parseRule` and `match` and compare
  exact contexts; nothing is mocked, generated, or blessed.
- **One rule per group,** so a new scenario cannot fork a second copy of the rule.
- **Fixture validation is separate from pipeline errors,** so a mistyped case fails as a fixture.
- **Unit tests per module plus CLI tests** over real temporary Git repositories for the diff path.
- **A fix earns a case.** The set is a regression net, not a coverage target; no coverage percentage.

## Accepted limitations and cost

- **Approximate identity, no dataflow.** AST identity is kind + enclosing declarations + name
  (`kind#occurrence` for anonymous nodes, positional `#N` for repeats); benign candidates
  (capacity-only appends, in-convention URLs) still reach the reviewer.
- **Selection is a subset.** Mapping keys may be any scalar, stringified as YAML does (including
  `.inf`/`.nan`), but a sequence or mapping key is rejected; the optional `key` option must resolve to
  exactly one string or finite number. Every selector uses the non-executable JSONPath dialect:
  predicate and script forms are rejected, not evaluated.
- **The filter is a trusted DAG.** YAML filters get cycle, unknown-operator, and non-empty-group
  checks at compile time; the programmatic host API can still build any acyclic filter.
- **The protobuf reader is not a compiler.** No imports, type resolution, or descriptor validation;
  unknown declarations are tolerated, while malformed selected RPCs error.
- **The docs and fixtures are the specification.** There is no schema file; the design doc's field
  list and the golden rules define v1.

Every fix and correction above rides the same gate: `npm run typecheck` (with the unused-code flags),
`npm test`, and the CLI run against real repositories for the discovery, default-base, `--base`
override, dirty/ignored-tree, symlinked-rule-alias, and atomic-error paths. No counts are frozen here.
