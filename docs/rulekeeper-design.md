# Rulekeeper: scopes, plugins, and the decision boundary

**One YAML file = one rule.** A rule selects complete *scopes* from a source file and optionally filters
their applicability. Run it on a whole file, or use base/head revision selection before filtering.
The resulting pre-decision context contains the policy, illustrative examples, and surviving scopes;
the [decision boundary](#the-decision-boundary) — wired up by the `check` CLI — decides each context on
its own, or each [group](#decision-grouping) a grouped rule builds.
See [src/rule.ts](../src/rule.ts) for the API and
[docs/rules/billing-http-url.yaml](rules/billing-http-url.yaml) for the complete example rule — a
protobuf RPC rule whose fields the list below follows.

## Rule shape (`version: 'v1'`)

`examples`, `filter` and `decision` are optional; the other five top-level fields are required.

- `version`: required, exactly the string `v1`. A missing value, numeric `1`, `v2`, or any older key fails to compile.
- `name`: the rule's name.
- `files.included` / `files.excluded`: include matching filepaths, then subtract exclusions. `included` must contain at least one glob; `excluded` is optional. An excluded file short-circuits extraction and needs no sources.
- `scope`: required. `format` names a registered plugin; `changed` defaults to `true` for revision inputs and is ignored for file inputs; every other key is a plugin option.
- `rule`: required, non-blank. A declarative policy statement — the requirement that a matched context is expected to satisfy — not an evaluator workflow and not a command sequence. State the requirement directly, as in `Memory limit must be less than or equal to memory request * 1.5`. It is the rule-level statement only, carried verbatim to the Jev boundary, and is a different field from the nested `scope.rule`, which is the native ast-grep structural selector (see below).
- `examples`: optional. When present, a mapping whose only allowed keys are `good` and `bad`, each an optional sequence of non-blank strings. Each entry is a representative snippet that satisfies (`good`) or violates (`bad`) the policy, and comments in the YAML can note why. Snippet content, indentation, and newlines are preserved exactly. Omitted examples normalize to `{ good: [], bad: [] }`; an omitted category becomes `[]`. Nulls, incorrect types, blank entries, and unknown keys are rejected. Examples are illustrative: they are not executed, scored, or used to filter scopes.
- `filter`: optional applicability predicate over a selected scope, independent of execution mode. Omitted, every selected scope is eligible. See below.
- `decision`: optional. How the selected scopes are grouped into review calls. Omitted, every scope is decided on its own (`group_by: scope`); `file`, `folder` and `project` judge one group at a time and read the current tree instead of a diff. See [decision grouping](#decision-grouping).

There are no `variables`, `when`, `from`, `watch`, `context`, `condition`, `extract`, or `where` fields;
unknown keys are rejected with no aliases. The only top-level fields are the eight above.

`scope.format` and `scope.changed` are stripped before the plugin sees the rest, so a plugin compiles
only its own options and validates them itself.

## Applicability filters

`filter` is a sibling of `scope`, not a plugin option. Each mapping has exactly one operator:

- `non_empty: <JSONPath>`: true if **any** selected value is present, non-null, and not an empty
  string, array, or object. `0`, `false`, and whitespace strings count as present.
- `all: [<filter>, …]`: every child must pass.
- `any: [<filter>, …]`: at least one child must pass.
- `not: <filter>`: negate one child.

Groups must be nonempty, can nest, and are fully validated at compile time. Cyclic aliases and
unknown operators are rejected. JSONPaths start with `$` and use non-executable selection only:
script expressions and JSONPath predicate expressions are rejected, not evaluated.

One shared helper, [src/jsonpath.ts](../src/jsonpath.ts), rejects executable forms for every JSONPath
selector this tool compiles — the filter, the YAML scope's `path` and `key`, and the protobuf scope's
`path` — so the rule is stated once instead of per caller. Rejection runs on the library's own
normalized tokens, because quoting hides nothing: `['(0)']` normalizes to the same token as `[(0)]`.

Paths address the **scope wrapper** `{ id, source, data?, captures? }`, not the file, diff, or
context. `$.data.tags` tests the array itself; `$.data.tags[*]` tests its elements. Thus `['']`
passes the former but not the latter. A path with no results fails `non_empty`.

Memory applicability keeps either setting so the reviewer can consider a missing counterpart; containers with
neither setting are skipped:

```yaml
filter:
  any:
    - non_empty: $.data.resources.requests.memory
    - non_empty: $.data.resources.limits.memory
```

The protobuf rule uses `non_empty: $.data.http.bindings` to skip unannotated RPCs. The Go rule's
AST selector already selects functions with append inside a loop, so it needs no separate filter.
Filters decide relevance, **not compliance**: valid configurations still reach the decision boundary.

Filtering does not hide parser errors or duplicate scope IDs. Applicability remains independent of
diff selection: an image-only edit inside a selected container with memory settings still changes
that scope and remains eligible. There is no field-specific memory-change filter.

## Whole-file inputs

Call `rule.match({ filepath, source })` to review a file without a diff, head, or base. File selection
and duplicate-ID checks are unchanged, and the applicability filter still applies; only `scope.changed`
is inert. Contexts are `{ filepath, scope }`, omitting `diff` entirely. Do not combine `source` with
revision fields.

## Changed semantics (`base` / `head`)

`rule.match(input)` takes one file's revisions: `{ filepath, diff, head, base? }`.

- `changed: true`: `base` is required. An empty `base` string means a new file; `head: ''` means a deleted file.
- `changed: false`: `head` and `diff` are required, but no `base`; all head scopes pass through the applicability filter.

`rule.match(input, { changedOnly: true })` forces base/head comparison even when the rule sets
`scope.changed: false`. It requires revision inputs and a base, and is the execution override used
by `check --diff-only`. With no override, the rule's existing `changed` behavior is unchanged.


The core extracts scopes from both revisions with the same plugin, pairs them by `id`, and deep-compares
`source`, `data`, and `captures`. New or differing head scopes then pass through the applicability filter, in head order.
- A scope present only in the base is a deletion: it alone emits nothing, because reviewing a scope that no longer exists was not requested.
- A scope that is unchanged emits nothing, even if its line number moved; position is not part of identity.
- A selection that loses its match in head yields no head scope.
- Duplicate scope IDs within one revision snapshot are an error.
- For `changed: true`, a package-only edit still triggers when it changes a record's `data` or `id`.
- Parser and plugin errors propagate; they are never swallowed as an empty result.

`diff` is caller-provided per-file review evidence. It is carried to the decision boundary and never
parsed as the source of truth.

## The pre-decision context contract

`match(input)` returns `Context[]`, each `{ filepath, scope }` for file inputs or
`{ filepath, diff, scope }` for revision inputs, where `scope` is `{ id, source, data?, captures? }`:

```ts
interface ScopeMatch {
  readonly id: string;
  readonly source: string;
  readonly data?: JsonValue;
  readonly captures?: Readonly<Record<string, string | readonly string[]>>;
}
```

`source` is the exact matched text. `data` is the plugin's JSON-compatible view of the scope, or
omitted for syntactic nodes. `captures` holds named metavariables, or is omitted when a plugin has none.

The pre-decision boundary is exactly
`{ rule: rule.rule, examples: rule.examples, contexts: rule.match(input) }` — the static policy
statement, the illustrative examples (always normalized to `{ good, bad }` string arrays), and each
context. There are no flattened variables. This core makes no model calls, no network requests, and
no reporting; deciding a context is the separate [decision boundary](#the-decision-boundary).

## Decision grouping

`rule.decision` chooses what one review call judges. Omitted, `group_by: scope` decides every selected
scope on its own. `group_by: file` judges one file's selected scopes together, `folder` one directory's,
and `project` the whole selected tree. `level` is valid for `folder` alone: it defaults to `0` (the
file's own directory), `-1` selects the parent, and so on, and any ancestor beyond the root clamps to
`'.'`. `group_by` must name one of the four values, `level` must be a non-positive safe integer, and
unknown keys are rejected — a typo cannot silently change the grouping.

A grouped rule **ignores the diff entirely**. `file`, `folder` and `project` read the selected current
working tree — unchanged, untracked and dirty files alike — so `check --diff-only` collects such a rule
exactly as a plain run does, needs no Git lookup, and leaves `--base` unused. The grouping does not
reach beyond the explicit target: it only ever regroups what the target already selected. A `project`
group is the whole selected tree — every file for `check .`, but only `charts` for `check charts` — and
a `folder` group holds the selected files that resolve into that directory and none outside it. When a
`--diff-only` run loads rules of both kinds, both are kept: scope-mode rules take the committed change
between `--base` and `HEAD`, grouped rules take the current tree, and every context is collected and
every group built before the first request. `--base` without `--diff-only` stays an error.

`match` never compares revisions for a grouped rule: it needs no base and ignores `changedOnly`, so the
rule's own `scope.changed` and the caller override have nothing to force. A file source is matched
as-is; a revision input uses its `head` alone (`head: ''` is a deleted file and yields `[]` without
reading a base), and the returned contexts carry no `diff`. The filter still decides which selected
scopes a group reviews.

Grouping happens in [src/decision/group.ts](../src/decision/group.ts) and preserves encounter order:
groups in the order their first scope was met, files in first-met order within a group, scopes in source
order. Folder and project groups first make each filepath relative to the project root
(`process.cwd()`), which is also the project group's `'.'`; a filepath resolving outside that root is
rejected rather than mislabeled as a member of a directory it is not in. `file` grouping keeps the
scanned filepath unchanged, including a relative `../` that the file scan itself allows. There is no
cross-rule grouping and no chunking: zero contexts yield zero groups.

Grouping reaches the decision payload as well as the matcher. One group is one request: the service
([below](#the-decision-boundary)) sends the group descriptor and its member files and scopes, and the
backend answers once for the whole group, so a group is never split into per-scope calls and no member
is decided twice. What is atomic is the report, not the provider's state: `stdout` gets the whole array
in one write, and only after every request has succeeded, so a provider failure leaves it empty instead
of half-answered — but the requests that already succeeded are not rolled back, and the run aborts
naming the failed decision on `stderr`. Grouped output stays a union with scope output: a scope-mode
rule reports one `{ filepath, scopeId, follows, probability, model }` per context as before, while a
grouped rule reports one `{ group: { type, path }, members: [{ filepath, scopeId }], follows,
probability, model }` per group, its members ordered as the request listed them.

A complete rule judges each YAML file's `env` mappings together, so a container redeclaring a global
name is visible in one review:

```yaml
version: 'v1'
name: Container environment redeclarations
files:
  included:
    - '**/*.yaml'
    - '**/*.yml'
scope:
  format: yaml
  path: $..env
filter:
  non_empty: $.data.text
rule: A container's env.text must not redeclare any name that global.env.text declares, even with an identical value; the same name may appear in more than one container as long as global.env.text does not declare it.
decision:
  group_by: file
```

`$..env` is a descendant selector, so it selects every `env` mapping in the file — `global.env` and each
container's `env` — and the filter keeps the ones that declare a `text` mapping; each file's surviving
env scopes are then judged as one group. The grouping is what makes the policy decidable: a container
scope on its own cannot see what `global.env.text` declares, while one group carries both, each scope's
id naming its location (`0:/global/env`, `0:/app/container/env`). A name shared by two containers is fine,
and so is the declared value being identical — only a container redeclaring a name `global.env.text`
already declares is a violation, which is the case in the sample [docs/test.yml](test.yml) for
`DB_NAME`. `group_by: folder` (with `level: -1` for the parent directory) judges the selected files of
one directory as a group instead, and `group_by: project` judges the whole target as a single group;
both apply the same policy across every selected file, so a container in one file redeclaring a global
declared in another selected file is caught too.

## Builtin plugins

The three builtins live in [src/plugins/](../src/plugins/). `parseRule`/`compileRule` default to a private
registry containing them.

### `format: yaml` — options `{ path, key? }`

Parses each YAML document and evaluates the JSONPath `path` with `jsonpath-plus` (`eval: false`).
Executable JSONPath script/filter forms are rejected at compile time; no `Function`/`eval` is used.
Each selected node becomes one scope.

- `data` is the full resolved node, including fields whether or not they changed; absent fields stay absent.
- `source` is the exact matched node text (no pretty-printing). An alias keeps its alias spelling as `source` while `data` resolves the target, so an anchor change still shows up in the comparison.
- `id` is `${documentIndex}:${keyValue}` when `key` is given (a JSONPath relative to the selected data resolving to exactly one string or number), otherwise `${documentIndex}:${pointer}` with the JSON Pointer from the selector; the root pointer is the empty string.
- Empty source yields `[]`. Multiple documents are supported; every document in the source is parsed and a document that fails to parse is an error.

```yaml
scope:
  format: yaml
  path: $.containers[*]
  key: $.name
```

### `format: protobuf` — options `{ path }`

A small token-based structural reader (not a brace regex), source extraction rather than protoc
validation. It exposes a normalized root `{ rpcs: [records] }` and selects records with a
non-executable JSONPath; `$.rpcs[*]` is the expected path.

Each record's `data` is exactly:

```yaml
id: acme.billing.v1.InvoiceService.GetInvoice   # [package, service, name].filter(Boolean).join('.'); package may be empty
package: acme.billing.v1
service: InvoiceService
name: GetInvoice
http:
  bindings:
    - method: GET                                # standard HTTP verb uppercased
      url: /v1/billing/invoices
```

`source` is the exact `rpc …` statement or block text. `http.bindings` lists the primary
`google.api.http` verb plus every nested `additional_bindings` and custom `{ kind, path }` (custom
kinds keep their declared spelling). An unannotated RPC has empty `bindings`; it is selected by the
plugin but rejected by the example rule's filter.

The same annotation may be written as one option aggregate or as dotted field paths spread over
several statements (`option (google.api.http).get = …`), and both forms produce the same bindings. A
leading UTF-8 BOM is treated as whitespace rather than swallowing the first declaration, and octal/hex
string escapes are decoded as UTF-8 bytes — a truncated sequence becomes U+FFFD — so `source` stays
byte-faithful while `data` carries the decoded text. No import or type resolution happens; unknown
declarations are tolerated, while malformed/truncated RPCs or unterminated strings/comments error.

### `format: ast-grep` — options `{ language, rule, constraints?, utils? }`

Uses the real `@ast-grep/napi`, with **31 languages** available without host setup:

- **Bundled by napi:** CSS, HTML, JavaScript (including JSX), TSX, TypeScript.
- **Packaged grammars:** Angular, Bash, Bicep, C, C++, C#, Dart, Elixir, Glimmer JavaScript,
  Glimmer TypeScript, Go, Haskell, Java, JSON, Kotlin, Lua, Markdown, PHP, Python, Ruby, Rust,
  Scala, SQL, Swift, TOML, YAML.

Set `scope.language` to the lowercase name (`cpp`, `csharp`, `glimmer-javascript`,
`glimmer-typescript` for those names); catalog names are case-insensitive. Conventional aliases
also work: `cc`/`c++`/`cxx`, `cs`, `ex`, `golang`, `hs`, `kt`, `md`, `py`, `rb`, `rs`,
`yml`, `js`/`jsx`, and `ts`.

Builtin-only rules load no dynamic grammar. The first packaged-language rule registers **all 26**
dynamic grammars together, allowing rules in different languages to coexist in one process.
Dependencies are pinned; no grammar is downloaded at review time. The native query is validated
when the plugin compiles, before matching.

For a host-owned grammar, register it **before the first dynamic rule compiles**, using the single
native call that ast-grep permits:

```ts
import { registerDynamicLanguage } from '@ast-grep/napi';
import { createAstGrepLanguageRegistrations } from './src/plugins/index.ts';

export function registerReviewLanguages(custom: Parameters<typeof registerDynamicLanguage>[0]) {
  registerDynamicLanguage({ ...createAstGrepLanguageRegistrations(), ...custom });
}
```

Custom names outside the catalog retain their exact spelling. A prior partial registration cannot
be extended: an unavailable catalog language fails with instructions to merge the registrations.
Rule YAML cannot load arbitrary packages.

Coverage follows the [official published grammar packages](https://github.com/ast-grep/langs),
not every [ast-grep CLI language](https://ast-grep.github.io/reference/languages.html).
**HCL, Nix, Solidity, and Zig** have no official npm grammar package and are not bundled;
hosts can register their own native grammars for them.

Packaged grammars provide prebuilds for macOS x64/arm64, Linux x64/arm64, and Windows x64.
Other targets need a compatible source-built grammar and toolchain; npm installation alone is
not proof that a parser is available. Linux prebuilds are not musl-specific. Dynamic registration
loads the whole catalog, so every packaged parser must be loadable on the target platform.

- `source` is the exact text of each matched node from the supplied file or revision.
- `captures` contains the named metavariables referenced by the pattern (without `$`; `$$$` captures are arrays). Anonymous `$$$` and captures the match does not bind are omitted; no captures yields `captures: {}`.
- `data` is omitted.
- Identity for a named declaration is its kind plus enclosing named declarations plus its own name (a Go method also includes its receiver, so same-named methods on different types stay distinct). Source positions are never part of it, so inserting lines above a declaration does not change its id. A legal overload or redefinition repeats an identity, so the repeat takes a `#N` suffix in document order (`add`, `add#1`): the first keeps the plain id and no two ids of a revision are equal, so a file of overloads extracts instead of aborting on the duplicate the core rejects. Unnamed nodes fall back to `kind#occurrence`, a deterministic approximation.

```yaml
scope:
  format: ast-grep
  language: go
  rule:
    any:
      - kind: function_declaration
      - kind: method_declaration
    has:
      kind: for_statement
      stopBy: end
      has:
        pattern: append($SLICE, $$$ARGS)
        stopBy: end
```

That `scope.rule` is the native ast-grep structural selector — the query that picks nodes. It is a
different field from the top-level `rule`, the natural-language policy statement; do
not confuse the two.

## Adding a custom plugin

Plugins are trusted code the host injects; a rule's YAML never names a module to import, and nothing is
loaded dynamically or installed from rule data. Implement `ScopePlugin` and pass it to
`createPluginRegistry`, then to `parseRule` or `compileRule`:

```ts
import { createPluginRegistry, type ScopePlugin } from './src/plugins/index.ts';
import { parseRule } from './src/rule.ts';

// Takes no options: one scope per file, identified by its filepath, whose source is the whole file.
const wholeFilePlugin: ScopePlugin = {
  format: 'whole-file',
  compile(options) {
    if (Object.keys(options).length > 0) throw new Error('whole-file scope takes no options');
    return {
      select: ({ filepath, source }) => (source === '' ? [] : [{ id: filepath, source }]),
    };
  },
};

const registry = createPluginRegistry([wholeFilePlugin]);
const rule = parseRule(
  `version: 'v1'
name: Whole-file review
files:
  included:
    - src/**/*.ts
scope:
  format: whole-file
  changed: false
rule: Files must not contain unreachable or unused code.`,
  registry,
);

const contexts = rule.match({ filepath: 'src/ui/app.ts', diff: '', head: 'export const answer = 42;\n' });
```

That rule omits `examples`, which is optional; the compiled rule still exposes `examples` as
`{ good: [], bad: [] }`.

`createPluginRegistry(additional = [])` returns a `PluginRegistry` containing the three builtins plus
the extras; `new PluginRegistry()` starts empty, while `new PluginRegistry([plugin, ...])` seeds it with
exactly the plugins passed. `register` rejects an empty or duplicate format and `get` throws for an
unknown one, so a rule naming an unregistered format fails at compile. `parseRule(source, registry?)`
and `compileRule(definition, registry?)` reuse a registry across rules.

## Use the core

Requires Node.js 24 or later; there is no build step. Run `npm ci`, then execute this as an ES module
from the repository root:

```js
import { readFile } from 'node:fs/promises';
import { parseRule } from './src/rule.ts';

const rule = parseRule(await readFile('docs/rules/billing-http-url.yaml', 'utf8'));
const contexts = rule.match({
  filepath: 'proto/billing/v1/invoice.proto',
  diff: '+    get: "/v1/billing/invoices"\n',
  base: 'package acme.billing.v1;\nservice InvoiceService {\n  rpc GetInvoice(GetInvoiceRequest) returns (Invoice) {}\n}\n',
  head: 'package acme.billing.v1;\nservice InvoiceService {\n  rpc GetInvoice(GetInvoiceRequest) returns (Invoice) {\n    option (google.api.http) = { get: "/v1/billing/invoices" };\n  }\n}\n',
});
console.log({ rule: rule.rule, examples: rule.examples, contexts });
```

Each context is `{ filepath, diff, scope }`; the scope's `data.id` is
`acme.billing.v1.InvoiceService.GetInvoice` and `data.http.bindings` is
`[{ method: 'GET', url: '/v1/billing/invoices' }]`.

`rule.version` is `'v1'`. Reuse the returned rule across files: the rule YAML is parsed, the plugin
options validated, and `examples` normalized to `{ good, bad }` string arrays once, when the rule
compiles. Matching itself still runs per call — the ast-grep plugin re-runs its native query on every
`select`, for instance — and nothing carries over between files.

## The decision boundary

The matcher ends at the context contract; deciding a context lives in [src/decision/](../src/decision/),
three small pieces behind one interface:

- [src/decision/port.ts](../src/decision/port.ts) — `DecisionBackend`, whose single method
  `decide(request: DecisionRequest): Promise<BackendDecision>` answers one `context` against one
  `instructions` (the rule text, the normalized examples, and the question). `context` is the projected
  request state — one scope, or one group of files — and no particular provider's wire format is part of
  this contract.
- [src/decision/service.ts](../src/decision/service.ts) — `DecisionService`, the facade. Its
  `decide({ context, rule, examples })` takes a [DecisionContext](#decision-grouping) — one scope or one
  group — projects it into the request state, builds the question once, and reads the answer into
  `{ follows, probability, model }`, where `follows` is exactly `probability > 0.5` (a tie is not a
  following decision) and the backend's `probability` and `model` are preserved unchanged. A scope whose
  plugin exposes structured `data` travels as that payload, beside its `captures` when it has any, so
  `null`, `false` and `0` stay payloads rather than reading as absent; only a scope with no payload falls
  back to its matched `source`. The request therefore never carries the same selection twice, and a group
  travels as its descriptor plus the member files and scopes.
- [src/decision/jev.ts](../src/decision/jev.ts) — `JevAdapter`, the only backend today. It posts to
  the `v1/systemone` endpoint path relative to the configured base URL and validates the response
  field by field before returning anything.

Use `new DecisionService(backend)` with any implementation of `DecisionBackend`, including an adapter
written later. The implementation owns its transport and validates its response before returning a
finite `probability` between 0 and 1 and the model identifier. The caller still uses the same
`service.decide({ context, rule, examples })` API. Each call is one decision, whether it carries one
scope or a whole group: the service sends the projected state unchanged and the backend answers once, so
a group is never split into per-scope calls and a provider failure leaves the whole group undecided
rather than partly answered.

[src/decision/config.ts](../src/decision/config.ts) is the CLI's factory: `createDecisionService(env)`
reads the environment at call time and selects a backend **by name**, with one `if` arm per backend
rather than a registry or plugin framework — adding a backend means adding its arm here, not
extending the port. The settings are `RULEKEEPER_DECISION_BACKEND` (default `jev`, the only supported
value), `RULEKEEPER_DECISION_MODEL` (default `jev-latest`), `RULEKEEPER_DECISION_BASE_URL` (default
`https://api.typesafe.ai`, the provider origin that the adapter appends its `v1/systemone` path to),
and `RULEKEEPER_DECISION_API_KEY`, falling back to the official `TYPESAFE_API_KEY`. A variable set to
blanks is a configuration error instead of a silent default, and the base URL must be an absolute
`http`/`https` URL with no query, fragment, or embedded credentials. A missing key fails only when a
context must actually be decided.

The CLI first loads an optional `.env` from its current working directory with Node's built-in
loader; existing process variables win. A missing file is ignored, but other read errors fail
startup. The library factory itself reads only its supplied environment and never loads files.

The adapter follows TypeSafe's published contract
([API reference](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models)): it `POST`s
`{ model, state, questions: { follows_instructions: { type: 'noul', instructions } } }` and reads
`{ model, answers: { follows_instructions: { type: 'noul', noul } }, usage }`, keeping only the
probability and model; `state` is the projected request state the service built, sent verbatim. One
request per decision, a 30-second timeout, no redirects, and no retries on
a server error; a failure surfaces as a message naming the HTTP status or failure category, never the
key, the request body, or the raw axios error, and there is no fake fallback.

## The wrapper CLI

The Commander declarations live in [index.ts](../index.ts); implementations live in
[command/check.ts](../command/check.ts) and [command/validate.ts](../command/validate.ts).
Handlers import no Commander. [src/rule-loader.ts](../src/rule-loader.ts) handles rule loading.
The root entry point owns the single error boundary: failures exit nonzero with a concise stderr
message and no partial stdout.

### Checking files

```sh
node index.ts check
node index.ts check src
node index.ts check charts/values.yaml --rules rules/memory.yaml
node index.ts check --rules ./rules
node index.ts check --diff-only
node index.ts check --diff-only --base origin/my-branch
```

`check [path]` defaults to the current working directory and recursively checks real files.
The optional target narrows the scan; it does not change rule discovery or rebase rule globs.
Logical paths are relative to `process.cwd()` and normalized to `/`. Run from the reviewed project
using `node /absolute/path/to/rulekeeper/index.ts check` when the tool lives elsewhere.
`npm start -- check` runs the same entry point from this repository; use
`npm run --silent start -- check` to suppress npm's banner for machine-readable stdout.

Directory scans skip `.git`, `node_modules`, `.rulekeeper`, all symlink entries, and loaded rule
descriptor files. An explicit symlink source target errors instead of following the link. This
does not implement `.gitignore`. Branch comparison is opt-in with `--diff-only`.

`CompiledRule.matchesFile(filepath)` exposes the same compiled include/exclude predicate used by
`match`. Only sources selected by at least one rule are read, once per file and shared across
selecting rules. In normal mode, each rule receives `match({ filepath, source })`, so
`scope.changed` is ignored; filters still determine scope applicability. A rule whose
`decision.group_by` is `file`, `folder` or `project` reads that current tree in both modes, so a
`--diff-only` run made only of such rules needs neither a repository nor Git — just a target that exists
on disk. Parser errors name the rule and source file.

Output is always an array of `{ ruleFile, name, rule, examples, contexts, decisions }`, even for one
explicit rule. `ruleFile` is absolute. Contexts aggregate across selected files in lexical filepath
order, and entries retain rule-loading order. `decisions` holds one entry per scope-mode context —
`{ filepath, scopeId, follows, probability, model }` — or, for a grouped rule, one entry per group —
`{ group: { type, path }, members: [{ filepath, scopeId }], follows, probability, model }` — each in
request order, with a group's members in the order the group listed them. Every loaded rule has an
entry, including those with no contexts. All compilation, reads, and matches finish, and every group is
built, before any decision is requested, so a parse failure, a missing target or a member outside the
project root has no external side effect; the whole array is written in one atomic `stdout` write only
after every decision succeeds.

`check` replaces the former `match` command; the library's revision matching API remains available.

### Branch-only checks

`check --diff-only [--base <ref>]` uses the Git checkout containing the working directory to compare its
scope-mode rules. The comparison is **merge-base(base, HEAD) → HEAD**, not base-tip → HEAD: changes made
only on the base branch after the fork do not trigger review. Both commit IDs are frozen before reading
changed files and snapshots. A grouped rule is never part of this comparison — it reads the current tree
instead — so a `--diff-only` run whose rules are all grouped performs no Git work at all: no ref is
resolved (an unused `--base` is not even looked up), and running outside a repository, or without Git
installed, is not an error.

Without `--base`, resolve the symbolic `origin/HEAD` target, then try `origin/main`,
`origin/master`, local `main`, and local `master`, in that order. If none resolves to a commit,
fail with instructions to supply `--base`. An explicit base can be any locally available commit
ref, including `origin/my-branch`. No Git ref is fetched: every invocation carries
`--no-lazy-fetch` (with `GIT_NO_LAZY_FETCH=1` and `GIT_TERMINAL_PROMPT=0`), so a partial clone whose
blobs are missing fails the read instead of contacting the promisor remote. That option requires
**Git 2.45 or later** — older Git rejects it and the diff fails loudly rather than silently reaching
the network. For a run that does have scope-mode rules to compare, an unavailable ref, unborn HEAD,
missing Git executable, non-repository directory, or lack of a common ancestor is an error. `--base`
without `--diff-only` is rejected before I/O.

[src/git-diff.ts](../src/git-diff.ts) runs Git without a shell. NUL-delimited raw metadata preserves
spaces, tabs, and newlines in filenames; literal pathspecs prevent filename glob expansion.
Snapshots come from recorded blob IDs, never from source files on disk. Patches disable external
diff tools and text conversion.

For a scope-mode rule, only committed source changes count: staged, unstaged, untracked, and locally
deleted/replaced working-tree sources cannot alter its result. A rule grouped by `file`, `folder` or
`project` is not read from the diff at all — it reviews the current working tree, dirty or not, and
ignores `--base` — so a `--diff-only` run whose rules are all grouped touches no repository. Those
grouped rules are still collected from the tree, though, so that pass needs the target to exist on disk:
the diff pass tolerates a deleted target, and a mixed run's grouped rules do not. Rule definitions and
discovery still use the working tree and home directory, including `--rules`.

The optional `[path]` narrows the diff pass only. For the scope-mode rules it lexically narrows repository
changes without rebasing globs and must be inside the repository; it need not exist on disk there, which
permits checking committed changes even after a local deletion, and a path with no matching changes yields
empty contexts. A grouped rule reads that target from the working tree instead, so a `--diff-only` run
that loads any grouped rule needs the target present on disk, and — when grouping by `folder` or
`project` — every selected file inside the working directory, because a group is named relative to that
root and a filepath resolving outside it is rejected before any request. Excluded files, loaded
descriptors, `.git`/`node_modules`/`.rulekeeper` paths, head symlinks, and submodules are skipped before
reading source blobs.

Each selected file's full base/head snapshots and per-file patch are shared across the selecting
scope-mode rules. Their matcher receives `{ changedOnly: true }`: it pairs scopes by ID and emits only
new or changed head scopes, regardless of `scope.changed: false`, then applies the normal applicability
filter. A one-line limit edit therefore keeps the corresponding request value but omits untouched sibling
containers. The scope is the unit of review, not an individual added line; normalized data changes
(such as a protobuf package edit) also count.

Added files use an empty base. Removed scopes/files emit no surviving contexts. Rename detection
pairs old/new blobs: a pure rename already selected by the same rule emits none, while moving a
file into a rule's selection is treated as an addition for that rule. A rename plus a content edit
compares corresponding old/new scopes.

The output keeps the same one-entry-per-rule array: a scope-mode context gains a `diff`, a grouped rule
still contributes its own current-tree groups, and each context or group gets one decision. Parser and
duplicate-ID errors still propagate; comparison and matching must fully succeed before any decision is
requested or any JSON is written.


### Rule discovery and loading

Without `--rules`, check loads all root-level and nested `.yaml` / `.yml` rules (case-insensitive)
from `process.cwd()/.rulekeeper`, followed by `homedir()/.rulekeeper`. Paths sort lexically within
each root. There is no name-based or relative-path-based override; both rules apply even when
names match. Roots are deduplicated by physical directory, so one root reached under two spellings — a
home that is the working directory, or a root under a link — contributes its files once, under the
first spelling. No ancestor search happens.
Symlink entries and symlinked default roots are skipped. Missing default roots are ignored;
other filesystem errors propagate. Finding no rules fails with an actionable error.

`--rules <path>` bypasses both default roots and selects a single rule file or all YAML rules
recursively under an explicit rule directory. Empty explicit directories fail. Explicitly named
rule paths may themselves be symlinks, but nested symlink entries are still skipped.

`discoverRuleFiles({ cwd?, home? })` returns absolute paths; optional roots are useful for embedded
callers. `loadRules(rulePath?)` returns `{ filepath, rule: CompiledRule }[]`. Every file must read
and compile successfully before loading returns; invalid rules are never silently skipped.
Read/compile errors identify the rule path.

### Validation and verdicts

`validate [rule-path]` uses the same loader: an optional file/directory bypasses discovery, and no
argument uses the two default roots. It compiles every selected definition before printing one
`Valid rule: <name> (v1)` line per rule. It never reads reviewed source files.

`check`, unlike `validate`, crosses the decision boundary: it decides every context and group it
collected against the configured backend (see [the decision boundary](#the-decision-boundary)) and prints
one decision per context or group beside the contexts. Choosing the endpoint and the key is the user's
call — the tool ships defaults for TypeSafe's Jev but never decides for you whether reviewed source may
leave the machine. It reports answers, not a policy verdict: empty contexts and exit `0` do not prove
the policy holds, and a run where every decision is `false` still exits `0`. A nonzero exit means a
setup, parse, or provider failure, not a failing scope.

## Limitations

- **YAML** parses YAML, so a raw Helm template with `{{ … }}` is not valid YAML and errors — there is no template rendering or interpolation. Every document in the source is parsed, not only the selected node's own document, so a parse error anywhere in the file fails the match even when the selector never reaches that document. Its `path` and `key` selectors use the non-executable JSONPath subset only, and `key` must resolve to exactly one string or number; composite keys are not a selection target.
- **Protobuf** is a structural source reader, not a compiler: no imports, type resolution, or descriptor validation, and comments or URL braces must not corrupt boundaries. Unknown declarations are tolerated, but truncated/malformed selected RPCs error.
- **ast-grep** matching is syntactic, with no type or dataflow verification. Unnamed or reordered matches can trigger extra review, and unnamed identity is a kind-plus-occurrence approximation; a repeated declaration's `#N` suffix is positional too, so inserting an overload ahead of another renumbers the later ids. Broad candidates intentionally keep correct code (for example capacity-only appends) rather than filtering it out.
- **Examples** are representative snippets, not executable checks: this core only carries them verbatim to the boundary, never parsing, executing, or scoring them, and they never filter the contexts.
- The core matcher makes no model, network, or CLI calls and has no reporter. The [wrapper CLI](#the-wrapper-cli) loads rules/files, optionally reads local Git objects for branch diffs, and — for `check` — sends each selected context or group to the configured decision provider over HTTP. Git refs are never fetched remotely. Neither command produces a policy verdict.

## Golden tests

Run `npm run test:golden` for the matcher fixtures, or `npm test` for all tests. The matcher runner
exercises only the matcher, so it needs no provider key, makes no network call, and never decides a
context.

Each group in [tests/golden/](../tests/golden/) has one `rule.yaml` and small `cases/*.yaml` files.
A case supplies file inputs and a hand-written expected result. Inputs are either `{ filepath, source }`
for a whole file, or `{ filepath, diff, head, base? }` for revisions, never both. `expected` is either
`{ contexts: [...] }` — the surviving pre-decision contexts, compared for exact equality in input order — or
`{ error: { stage: compile | match } }` for a case that must throw. The rule text and its examples live
once, in the group rule, and the runner compiles that real rule per case, so a case never restates the
policy or the examples and cannot drift from them. The fixture reader validates case shape
independently of the rule, so a malformed fixture fails on its own rather than masquerading as an
expected rule error. File-only expected contexts omit `diff`, and fixture validation rejects mixed
file/revision inputs.

The protobuf group's own `rule.yaml` carries a fuller example set than the canonical
[docs/rules/billing-http-url.yaml](rules/billing-http-url.yaml) it is named after; each file is the
single source for its own consumers, and neither is copied into a case.

Each group is the machine-checked twin of a conversation use case, so extend it by adding a case
rather than restating a snapshot here:

- [memory-ratio/rule.yaml](../tests/golden/memory-ratio/rule.yaml) — nested `resources` request/limit
  review across `charts/**/*.yaml` containers: separate limit-only and request-only diff lines, both
  changed together, an unchanged sibling container, missing request or limit, a whole new file,
  no-relevant-change, an irrelevant trailing change, and a unit-boundary ratio. Representative case:
  [01-limit-only.yaml](../tests/golden/memory-ratio/cases/01-limit-only.yaml).
  File-only cases cover mixed containers (both settings, either setting, neither) and empty/null values.
- [go-slice-append/rule.yaml](../tests/golden/go-slice-append/rule.yaml) — ast-grep over functions that
  append inside a loop: an actual length-before-append change, the retained capacity-only,
  slice-reset, and intentional-prefix candidates, an untouched function, a method receiver, a newly
  added loop, and indexed or `append`-free non-candidates. Representative case:
  [initialization-change.yaml](../tests/golden/go-slice-append/cases/initialization-change.yaml).
  File-only cases retain length- and capacity-initialized append candidates while excluding indexed-fill/no-loop functions.
- [billing-http-url/rule.yaml](../tests/golden/billing-http-url/rule.yaml) — protobuf RPC HTTP
  bindings: an operation-style URL, an annotation-only change, a package-only change, additional
  bindings only, a full multi-binding edit, a removed binding, an untouched RPC, and an excluded
  file. Representative case:
  [08-operation-style-url.yaml](../tests/golden/billing-http-url/cases/08-operation-style-url.yaml).
  File-only cases cover annotated/unannotated RPCs, additional bindings, and file exclusions; removing all bindings also skips review in revision mode.

The generic file-scope and rule-version groups follow the same layout. Every group asserts the exact
pre-decision contexts — never a semantic model verdict — so deliberately benign candidates (such as
capacity-only appends or in-convention URLs) stay in the expected contexts rather than being filtered
out. The case set is a hand-authored regression net, not a coverage metric: add the case that pins the
behavior you just fixed.

The runner uses the real `parseRule` and `match` APIs: it compiles the group rule once per case and
runs every input through `match`, then compares the surviving contexts in input order. Use
`contexts: []` for no matches. For an expected rule error, use `expected: { error: { stage: compile } }`
or `stage: match`; messages and stack traces are not golden data, and a malformed fixture fails
independently of an expected rule error. Add a case file to test another scenario; discovery is
automatic. Expectations are authored and reviewed manually — there is no snapshot/bless mode.

### Grouped-decision fixtures

The matcher goldens above are unchanged (the same 39 fixtures). Grouped decisions are pinned separately
by [src/decision-grouping.test.ts](../src/decision-grouping.test.ts), which runs
[tests/decision-golden.json](../tests/decision-golden.json) — 11 hand-authored cases that compose a real
rule from a shared scope fragment plus the case's own files, filter and `decision` lines, run it through
the real pipeline, and compare the groups it produced. The grouped goldens therefore live in that JSON
file, not in the `tests/golden/` case layout. The same test file also holds the end-to-end grouped CLI
cases, which run the real CLI against a real loopback HTTP backend and never a live provider. Both run
under `npm test`, which discovers `src/*.test.ts`; they are **not** part of `npm run test:golden`, which
runs `src/golden.test.ts` alone.

## Checks

- `npm run typecheck`
- `npm run test:golden`
- `npm test`
- `npm start -- validate docs/rules/billing-http-url.yaml` — the wrapper CLI compiles the example rule
- `npm start -- check` with `RULEKEEPER_DECISION_API_KEY` (or `TYPESAFE_API_KEY`) set — the wrapper CLI
  decides every selected scope, or every group a grouped rule built, against the configured provider
- [docs/retrospective.md](retrospective.md) — the maintainability pass behind this design: decisions,
  fixes, and accepted trade-offs
