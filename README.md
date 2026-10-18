# rulekeeper

**One rule = one TypeScript/JS class.** rulekeeper selects *scopes* (named, source-located slices of
files), filters their applicability, groups them if needed, and evaluates each subject — with a remote
AI decision (Jev), with a deterministic local check, or with any code you write. It runs against the
**current working tree**, optionally selecting only files changed from a Git reference.

A rule is a normal ES module that default-exports a class extending `Rule`. The framework provides the
shared mechanics (file selection, scope extraction, filtering, grouping, concurrency, reporting);
authors supply policy through ordinary methods and evaluators. Rules are **trusted code** with full
Node access — this is an authoring framework, not a sandbox.


| Command                              | Purpose                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `rulekeeper validate [rule-path]`    | Load and structurally validate rules offline.                                                           |
| `rulekeeper test [rule-path]`        | Run inline rule datasets and check their declared outcomes.                                             |
| `rulekeeper check [path]`            | Run every selected rule and report violations (exit 1 when any).                                        |
| `rulekeeper inspect <rule> [folder]` | Walk one rule through selection/filter/group/evaluate, printing each step and the exact request/result. |


## Requirements and build

- **Node.js 24 or later** (ESM, `node:path.matchesGlob`, and native TypeScript type stripping).
- No Git, and no revision/diff integration of any kind.

Install and build the package:

```sh
npm ci           # install pinned dependencies
npm run build    # tsc -p tsconfig.build.json -> dist/ (JS + .d.ts)
npm run typecheck
npm test         # build, then run the test suite
```

Run the CLI from the build output or through the package binary:

```sh
node dist/cli.js --help
npm start -- validate .rulekeeper
# once installed in a consumer project: node_modules/.bin/rulekeeper check .
```

## Using the SDK in another project

The package builds to JavaScript plus declarations (`dist/`), so consumers never strip TypeScript from
`node_modules`. Install it into your own dependency graph and import the **bare package name**:

```ts
import { Rule, ai, regex, pass, violation, scopes, createAstGrepLanguageRegistrations } from 'rulekeeper';
import type { CheckContext, CheckResult, Project, ProjectContext, ScopeSelector, Subject } from 'rulekeeper';
```

Rules are ES modules. Node ≥24 executes your `.rule.ts` / `.rule.mts` directly (type stripping), so
authoring needs no build step; `.rule.js` / `.rule.mjs` rules are plain JavaScript. Helper imports must
name the helper's **actual file and extension**, because Node resolves them at runtime and nothing
rewrites specifiers: a TypeScript rule imports a TypeScript helper as
`import { helper } from './helpers/limits.ts'` (or `.mts`), while a `.rule.js` / `.rule.mjs` rule — or a
TypeScript rule importing a JavaScript helper — uses `import { helper } from './helpers/limits.js'` (or
`.mjs`). The `.js`-for-a-`.ts`-file convention (`import './limits.js'` resolving to `limits.ts`) belongs
to **compiled** NodeNext builds, which is how this package's own `src/` is written; it does not apply to
rules Node executes straight from source, and no build step makes it apply.

Rules import the SDK normally; the framework never rewrites imports or manipulates module resolution, and
a missing dependency reports its normal module-load error with the rule's path (no auto-install).

The published package ships only `dist/`, with `types`/`exports` resolving to `dist/index.d.ts` and
`dist/index.js`; the `rulekeeper` binary is `dist/cli.js`.

## Writing a rule

Create a module whose **basename** uses a rule suffix — `.rule.ts`, `.rule.mts`, `.rule.js`, or
`.rule.mjs` — and default-export a class extending `Rule`. The rule name is the basename with the
suffix stripped (`infra-placement.rule.ts` → `infra-placement`).

```ts
import { Rule, ai, scopes, type ProjectContext } from 'rulekeeper';

export default class InfraPlacement extends Rule {
  files = ['internal/infra/**/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }] },
  });

  async when({ project }: ProjectContext) {
    return (await project.stat('internal/adapter'))?.kind === 'directory';
  }

  check = ai({
    rule: 'Infrastructure functions implement technical concerns, not business policy or application orchestration.',
    violationMessage: 'This function belongs outside infrastructure',
  });
}
```

### `Rule` contract


| Member                     | Default      | Role                                                                                                                                                                                                                     |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                  | `true`       | `false` skips the rule (reported with reason `disabled`).                                                                                                                                                                |
| `files`                    | `['**/*']`   | Root-relative globs; **non-empty**.                                                                                                                                                                                      |
| `exclude`                  | `[]`         | Root-relative globs; exclusion wins over `files`.                                                                                                                                                                        |
| `scope`                    | absent       | `ScopeSelector`; absent selects one whole-file scope per file.                                                                                                                                                           |
| `settings`                 | `{}`         | `{ backend?: 'jev'; model?: string; threshold?: number }` overrides for this rule.                                                                                                                                       |
| `group`                    | `'scope'`    | `'scope' | 'file' | 'folder' | 'project' | { by: 'folder', level }`.                                                                                                                                                     |
| `when(context)`            | `true`       | Whole-rule gate; `boolean` or `{ applies, reason? }`.                                                                                                                                                                    |
| `select(context)`          | delegates    | Override to build subjects yourself (default uses `files`/`exclude`/`scope`).                                                                                                                                            |
| `filter(subject, context)` | `true`       | Per-scope applicability; `boolean` or `{ applies, reason? }`.                                                                                                                                                            |
| `check`                    | *(abstract)* | Required `Evaluator`, assigned as a **function-valued property**: `check = ai({...})`, `check = regex({...})`, or `check = async (subject, context) => ...`. It is read as a function value, not overridden as a method. |


All hooks and `check` are invoked with `this` bound to the rule instance, so extra fields and methods
on your class are available and allowed. `Rule.prototype` carries a non-enumerable
`Symbol.for('rulekeeper.Rule')` brand; the loader accepts any default-exported constructible class with
that brand plus a valid structural contract (not `instanceof` against its own copy of `Rule`), so a rule
may extend a separately installed copy of the SDK. `construct(this)` still runs — imports and
constructors are trusted code.

`files` and `exclude` must be dense arrays of non-empty strings: missing or inherited-only entries are
invalid, including on disabled rules. Structural validation runs before any hook.

### Discovery and selection

- Standard discovery reads `<working-root>/.rulekeeper` and then `~/.rulekeeper`, recursively and
lexically, importing only `*.rule.{ts,mts,js,mjs}`. Helper `.ts`/`.js` files are imported by rules but
never auto-discovered.
- Symlinked roots/entries and any `old/` subdirectory are skipped; physical rule paths are deduplicated.
Only missing roots are tolerated — permission/type errors propagate, and finding no rules is an error.
- `--rules <path>` (and `validate [rule-path]`) replaces discovery with one explicit file or a
recursively scanned directory, resolved relative to the **invocation cwd**. An explicit file must use a
rule suffix and must not be a symlink; pointing at `old/` is rejected. Duplicate rule names across the
selected roots are errors listing every path.
- `inspect <rule>` resolves its selector relative to the invocation cwd first: an existing file is used
as given, while an existing **directory** is rejected, because inspecting needs one rule module or an
exact name. Anything else counts as an exact rule name, looked up under the **selected `[folder]`
root** and then home — so an inspected rule can live outside the inspected folder.

Each load constructs a **fresh** rule instance. Modules are imported once per process (the CLI is
one-shot); there is no cache-busting or hot reload.

### Inline rule tests

Export named `tests` alongside the default rule class. Import `test` from the SDK, supply editable
file data, and finish each case with `.passes()`, `.violates()`, or `.skips()`:

```ts
import { test } from 'rulekeeper';

export const tests = [
  test('repeating a default value')
    .withFiles({
      'tests/manual/default.yml': env({ LOG_LEVEL: 'info' }),
      'tests/manual/production.yml': env({ LOG_LEVEL: 'info' }),
    })
    .violates(),

  test('changing a default value')
    .withFiles({
      'tests/manual/default.yml': env({ LOG_LEVEL: 'info' }),
      'tests/manual/production.yml': env({ LOG_LEVEL: 'debug' }),
    })
    .passes(),
];
```

`env(...)` is a small helper local to `.rulekeeper/duplicated-env.rule.ts`, not an SDK function:
each argument is an environment-variable map wrapped in the config shape the selector reads.
Multiple arguments create multiple scopes. File values can be plain objects, arrays, numbers,
booleans, or `null`; they are serialized as JSON, which is also valid YAML. Strings remain literal
source text for code or hand-written fixtures.

Paths are project-root-relative and must match the rule's selection. Each case runs the real
selection, filters, grouping, and check with its own temporary project and fresh rule instance.
Cases within a rule can run concurrently on a reusable worker pool; rule suites run in discovery order.
Each worker caches imported modules across cases and rules, so do not rely on module-level state
being isolated or ordered between cases. Await all asynchronous work before returning from a check.
The working tree is not modified. Ordinary `tests` run offline; AI calls fail rather than contact a provider.

These chains only declare cases. Ordinary `check` and `validate` do not execute them. Use the
[`test` command](#test-rule-path) to run them; the repository's `npm test` also runs its inline cases.

Run `npm start -- test .rulekeeper` to test the repository's local rules. Cases cover environment
duplicates, memory-ratio boundaries, and public/internal protobuf URLs. The Go append rule has only
offline scope-selection cases; its AI policy is not evaluated.

For live AI outcome assertions, export `aiTests` using the same `test(...)` builder and
`.passes()` / `.violates()` declarations. These are separate from the examples conditioning
`ai(...)`: they exercise the actual rule against independent datasets. The
[AI-backed TypeScript rules](#ai-backed-typescript-policies) contain complete examples.
`test --ai` opts into these cases; ordinary `test` and `npm test` remain offline.

### Execution order and concurrency

`load/validate all` → `enabled` → `when` → `select` → validate scopes → `filter` → `group` → evaluate →
report.

- Gates run **once per enabled rule, before parsing its target sources**. A `false`/non-applying gate
becomes a *skipped* rule with its reason — not a pass.
- Filters run once per selected scope, before grouping, and may return a structured reason.
- Only an explicit `false` (or `{ applies: false }`) skips. A malformed return value or thrown error is
a runtime error, not a skip.
- Selection tasks and evaluations are bounded by `--concurrency` (default 8), one rule's selection at a
time, then all surviving rules' evaluations in one ordered bounded map. Rule hooks that read project
files or call helpers cannot deadlock the limiter. Shared rule instances must not depend on
per-subject mutation ordering; use `--concurrency 1` when a rule needs serial checks.

### Custom selectors

Adding `scope`, overriding `select`, or using `context.select` lets you produce your own subjects. A
custom `select` returns flattened scope subjects and still respects the CLI target and reserved-path
boundary; it may call `context.select(...)` to reuse built-in selection and transform the result.
Synthetic subjects must be attributed to a real eligible filepath (use grouping for multi-file
decisions). Validation enforces correct strings/ranges, JSON-compatible data, valid captures, a
root-relative eligible `filepath`, and unique `(filepath, id)` per rule, with no hidden subjects,
fallback passes, or silent dedup.

## Selectors

Every selector is a `ScopeSelector<T> = (file: { filepath, source }) => Awaitable<readonly ScopeMatch<T>[]>`
and is re-exported as `scopes.*`. A `ScopeMatch` is `{ id, source, data?, captures?, lines? }`, where
`lines` is a 1-based inclusive range and `data` must be finite, acyclic, JSON-compatible data.
Selector results must be dense arrays with an own scope at every index; holes are errors, not empty
selections. A genuine `[]` remains a valid no-match result, and dense results retain their order.


| Factory                                                    | Options                                           | Selection                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopes.file()`                                            | —                                                 | One data-free `$` scope per eligible file, including empty files (`lines` 1–1).                                                                                                                           |
| `scopes.json<T>({ path?, key? })`                          | `path` default `$`                                | Strict JSON only (no comments, trailing commas, or empty input); duplicate keys and non-finite numbers are rejected. `id` is the RFC 6901 pointer (`$` at root) or the `key` value.                       |
| `scopes.yaml<T>({ path?, key? })`                          | `path` default `$`                                | Every nonempty YAML document, in order, with aliases/merge keys resolved and a bounded alias count. `id` is `<doc-index>:<pointer-or-key>`; empty/comment-only documents are skipped without renumbering. |
| `scopes.csv({ headers?, delimiter?, key? })`               | `headers` default `true`, `delimiter` default `,` | One scope per data record; ids are `row:<n>` (1-based) or a `key` column value. Handles quoting, multiline fields, BOM, LF/CRLF/CR, and blank lines; strict record widths.                                |
| `scopes.astGrep({ language, rule, constraints?, utils?, tsx? })` | —                                              | Native ast-grep matches with captures (pattern metavariables plus named-declaration/Go-receiver identities) and line spans. Queries are validated at factory construction. TypeScript selects its grammar by filepath. |
| `scopes.protobuf<T>({ path? })`                            | `path` default `$.rpcs[*]`                        | RPC records or their `google.api.http` subtrees. Data is `{ id, package, service, name, http: { bindings: [{ method, url }] } }`.                                                                         |


JSONPath-derived selectors (`json`, `yaml`, `protobuf`, and custom paths) require a non-empty `$`-rooted
string, reject executable expressions, and surface library-reported evaluation errors. Protobuf may
select RPC records or their `http`/`bindings`/`method`/`url` subtrees only; a matched forbidden pointer
errors even when the file has no RPCs. `key` selectors must resolve to exactly one string or finite
number.

Omitted or `undefined` options retain their defaults; explicit `null` is invalid for structured selector
`path` and CSV `headers`/`delimiter`. CSV delimiters must be exactly one Unicode code point (including
supplementary characters such as `😀`), other than CR, LF, or a quote. `scopes.csv` and `project.readCsv`
apply the same option rules and preserve exact source slices for multibyte delimiters.

**ast-grep languages.** Built-in: `css`, `html`, `javascript`, `tsx`, `typescript`. Bundled grammars:
`angular`, `bash`, `bicep`, `c`, `cpp`, `csharp`, `dart`, `elixir`, `glimmer-javascript`,
`glimmer-typescript`, `go`, `haskell`, `java`, `json`, `kotlin`, `lua`, `markdown`, `php`, `python`,
`ruby`, `rust`, `scala`, `sql`, `swift`, `toml`, `yaml`. Aliases include `js`/`jsx`/`ts`/`py`/`rb`/`rs`/
`cs`/`kt`/`md`/`yml`/`golang`/`hs`/`ex`/`cc`/`c++`/`cxx`. Names are case-insensitive; bundled grammars
register lazily on first use, and a host composing custom grammars can merge
`createAstGrepLanguageRegistrations()` into its own single `registerDynamicLanguage` call.

With `language: 'typescript'` (or alias `ts`), `astGrep` uses the TSX grammar for `.tsx` files and
the TypeScript grammar otherwise, including `.ts`, `.mts`, and `.cts`. Other explicitly selected
languages remain fixed; `language: 'tsx'` always uses TSX regardless of filepath.

Both TypeScript grammar variants validate eagerly. Queries using TypeScript-only kinds, such as
angle-bracket `type_assertion`, need a `tsx` replacement query:

```ts
scopes.astGrep({
  language: 'typescript',
  rule: { any: [{ kind: 'as_expression' }, { kind: 'type_assertion' }] },
  tsx: { rule: { kind: 'as_expression' } },
});
```

`tsx` accepts `{ rule, constraints?, utils? }` and replaces the complete query rather than merging
it: omitted constraints and utilities are not inherited. Captures come from the selected query.
The option is only valid with a TypeScript language selection.

### Grouping

`group` collects the surviving scopes into subjects:

- `'scope'` — one subject per scope (default).
- `'file'` — one group per filepath.
- `'folder'` — one group per containing folder at level 0.
- `'project'` — one group for the whole `.` root.
- `{ by: 'folder', level }` — negative levels climb the folder tree and clamp at `.`.

Member order is preserved, empty groups are never evaluated, and one group is exactly one `check`
invocation. Declare an override with the `Grouping` type (`group: Grouping = 'folder'`, as the dogfood
rules do) rather than leaving a bare string literal to inference.

## Project readers

Hooks and checks receive a `Project` rooted at the working root:

```ts
import type { Project } from 'rulekeeper';

async function readProject(project: Project) {
  const files = await project.glob(['config/**/*.json']);  // existing eligible files, lexical order, [] when none
  const hasGo = await project.hasFiles('**/*.go');         // boolean convenience over glob
  const adapter = await project.stat('internal/adapter');  // { kind: 'file' | 'directory' } | undefined (ENOENT only)
  const text = await project.readText('README.md');        // strict UTF-8 text
  const json = await project.readJson('config/app.json');  // strict JSON (same parser as scopes.json)
  const docs = await project.readYaml('config/app.yaml');  // one value per nonempty YAML document
  const rows = await project.readCsv('env/main.csv');      // header records or string arrays
  return { files, hasGo, adapter, text, json, docs, rows };
}
```

Paths are root-relative with `/` separators; absolute paths, `..` escapes, and symlink traversal are
rejected. `glob`/`hasFiles` use `node:path.matchesGlob` semantics with exclusion winning. The root is
the invocation cwd for `check`/`validate` and the resolved `[folder]` for `inspect` — an absolute or
sibling folder is its own root. Reads require real files, decode UTF-8 strictly, and error on
missing/unreadable/invalid input — a read error never masquerades as a missing value or empty selection.
Source text is cached once per run; parsed values are per-use so one rule cannot mutate another's view.
Globs avoid unrelated trees when a simple literal directory prefix identifies the search root.
Directory listings are cached when visited rather than taking a whole-project snapshot.

## Evaluators

```ts
import { ai, regex, pass, violation } from 'rulekeeper';
```

- **`ai(options): Evaluator`** — the recommended remote check. `options` is `{ rule, examples?, violationMessage?, input? }`. The framework builds the default input from the subject (no manual
subject passing):
  ```jsonc
  // single scope with data
  { "filepath": "...", "scope": { "id": "...", "data": ..., "captures": ... } }
  // single scope without data
  { "filepath": "...", "scope": { "id": "...", "source": "...", "captures": ... } }
  // group
  { "files": [ { "filepath": "...", "scopes": [ ... ] } ] }
  ```

  Presence is not truthiness: `null`, `false`, `0`, and `""` data are real inputs. An `input` callback
  replaces the projection and its returned value is validated. `ai({...})` only validates its options at
  construction — no network I/O while loading.
- **`context.ai(options)`** — the same implementation, available inside a custom `check` for
conditional or multi-step logic, already bound to the current subject and rule settings.
- **`regex({ pattern, violationMessage?, input? }): Evaluator`** — deterministic, no provider, no key,
no network. The default input is `String(data)` for scalar/null data and the scope source text
otherwise; an `input` callback (`(subject, context) => Awaitable<string>`) replaces it per member. A
group passes only when **all** members match. The pattern is cloned at construction and `lastIndex` is
reset before each test, so `/g` and `/y` flags stay deterministic. The result carries no fake
probability/model/threshold.
- **`pass()` / `violation(message)`** — helpers for custom checks.

A **custom check** is any `Evaluator`-shaped value (`(subject, context) => Awaitable<CheckResult>`)
assigned to the function-valued `check` property, for example
`check = async (subject, context) => { ... }`. `subject` is a `Subject<T>`, so `subject.kind === 'scope'`
narrows it to `ScopeSubject<T>` (with `id`, `source`, `data`, `captures`, and `filepath`). The check
returns `{ status: 'pass' | 'violation', message?, probability?, threshold?, model? }` or throws; the result is
validated and supplied messages are preserved. A violation without a message is reported by rule name
and location, without generated message text. Checks may use any external library/provider directly —
there is no backend-registration framework.

AI results include the actual effective `threshold` used for the decision. Returning `context.ai(...)`
preserves that metadata; a custom check that replaces the AI result does not inherit it automatically.
Deterministic checks do not gain an invented threshold. When supplied, threshold metadata must be a
finite number in `[0, 1]`.

## Settings and environment

Rule `settings` override environment defaults per rule:

```ts
import { Rule, ai, type RuleSettings } from 'rulekeeper';

export default class StrictLimits extends Rule {
  files = ['docs/**/*.md'];
  settings: RuleSettings = { model: 'jev-latest', threshold: 0.5 }; // backend is always 'jev'
  check = ai({ rule: 'The document states explicit resource limits.' });
}
```


| Setting   | Environment              | Default                   | Precedence                                                                    |
| --------- | ------------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| threshold | `RK_THRESHOLD`           | `0.4`                     | `--threshold` &gt; `rule.settings.threshold` &gt; `RK_THRESHOLD` &gt; default |
| backend   | `RK_BACKEND`             | `jev`                     | rule setting &gt; env &gt; default                                            |
| model     | `TYPESAFE_DEFAULT_MODEL` | `jev-latest`              | rule setting &gt; env &gt; default                                            |
| base URL  | `TYPESAFE_BASE_URL`      | `https://api.typesafe.ai` | env only                                                                      |
| API key   | `TYPESAFE_API_KEY`       | —                         | env only (required for AI calls)                                              |


Settings resolution is **lazy**: no provider-specific environment is read or validated until a rule's
first actual AI call. A skipped, filtered, regex-only, or otherwise deterministic run needs no key and
works even with unused invalid AI environment values. A *set-but-blank* used value is an error; values
shadowed by a higher-precedence setting are not consulted. Rule and flag values validate eagerly.

Copy `.env.example` to `.env` and set `TYPESAFE_API_KEY` for AI-backed rules. Other values show defaults.

The CLI loads `.env` from the invocation cwd via `process.loadEnvFile()` **without overriding exported
shell variables**; a missing `.env` is ignored. There is no other configuration system and no statistics
directory or database.

### The Jev transport

AI calls `POST v1/systemone` with `Authorization: Bearer <key>` and a body of
`{ model, state, questions: { follows_instructions: { type: 'noul', instructions: { rule, question: 'Is the rule respected?', examples? } } } }`. `examples` is omitted entirely when both good and bad are
empty; `violationMessage` is reporting-only and never sent. The call passes iff the returned probability
is **strictly greater** than the threshold (equality violates). The effective threshold is reported
with the result, not sent in the upstream instructions. The client uses a 30-second timeout, no
redirects, no retries, and validates the model/answers/type and a finite probability in `[0, 1]`;
timeout/network/HTTP/malformed/unsafe-URL errors are sanitized. Debug metadata never contains bodies or
credentials, while `inspect`/`--verbose` show the actual serialized request and parsed response after
redacting the key (including on failures); the same redaction covers the streamed source excerpts and
`trace` details, so the key never reaches a diagnostic. Machine reports retain complete subject data for
included verifications; use `--output-all` to include passing verifications and skipped rules too.
Headers and `Authorization` are never logged.

AI `examples.good` and `examples.bad` must be dense arrays of non-empty strings. Sparse arrays and
inherited-only entries fail during evaluator construction and runtime `context.ai` validation, before
a decision request. Empty or omitted lists remain valid; dense example order is preserved on the wire.

> AI-backed rules require `TYPESAFE_API_KEY`. Without it, `validate`, deterministic and regex rules, and
> all skipped/no-subject rules run fully offline. This document describes behavior only; it does not
> assert that a live provider was contacted.

The repository's `.rulekeeper/memory.rule.ts` example supports decimal memory quantities with
`k`, `M`, or `G` suffixes (such as `512M` or `.5G`). It converts them to bytes with `bignumber.js`
and checks that the limit is at most 1.5 times the request, exactly and without AI credentials.

`service-proto.rule.ts` uses the same regex convention as `public-proto`: the first resource segment
after `/service/vN/` must end in `s`. This is a naming convention, not linguistic plural detection.
`duplicated-env.rule.ts` compares each override's variable names and JSON values against every
`default.yml` scope in the same folder. Both rules run offline without AI credentials.

## Commands

### `validate [rule-path]`

Loads and structurally validates all selected rules (discovery, or the explicit file/directory, resolved
relative to the invocation cwd). Prints `Valid rule: <name>` per rule. It does **not** run gates, read
target sources, contact Jev, or act as a type checker — use `tsc` for semantic checking. Exit `0`, or `2`
on error.

### `test [rule-path]`

Run the named `tests` exports from selected rules. Add `--ai` to include their `aiTests` exports
after ordinary cases in each rule. With no path, discovery reads the working root's `.rulekeeper`
and home rules; an explicit file or directory replaces discovery and resolves relative to the
invocation cwd.

```sh
node dist/cli.js test
node dist/cli.js test .rulekeeper/duplicated-env.rule.ts
node dist/cli.js test --timeout 30s
node dist/cli.js test --concurrency 4
node dist/cli.js test .rulekeeper --ai --timeout 45s --failures-only
```

`--ai` authorizes provider calls only for `aiTests`; ordinary `tests` remain offline even in that
mode and in reused workers. Live cases use the same rule settings and environment configuration
as `check`, including `TYPESAFE_API_KEY`, and may incur provider charges. Outcomes are
probabilistic. No model responses are mocked or substituted by the runner.
Selecting an AI-only rule without `--ai` reports how to enable its cases.

Use a suitable per-case deadline for live evaluation; `45s` allows more time than the default
`10s`, but does not override the provider adapter's own request timeout. Provider failures are
reported as errors, not passing or skipped assertions.

Streams results in declaration order as a tree under each rule heading, followed by passed/failed
totals. Later cases can finish first, but their results wait for earlier cases before printing.
Each row shows its elapsed time; the summary's `Time` is the sum of those case durations, not command
wall-clock time. Timing includes fixture setup, execution, and temporary-project cleanup, but not
time waiting for a worker. A worker's first case includes startup; successful pool shutdown, initial
rule discovery, and output rendering are excluded. Durations use the same two-decimal `ms`, `s`,
`min`, `h`, and `d` scaling as evaluations.

Passing labels are green and failing labels red; assertion mismatches show expected and actual
statuses and do not prevent later cases from running.

`--failures-only` hides passing rows and headings for rules with no failures, while retaining the
full summary and runtime diagnostics. All selected cases still run, including AI calls; counts,
total case time, provider usage, and exit status are unchanged. Filtered rows are emitted when
their rule completes, or flushed if it aborts. On an error, the filtered summary counts completed
cases only, not the interrupted case.

`--concurrency <number>` sets the maximum number of reusable workers, defaulting to `1`. It must be a
positive safe integer. Workers start lazily and remain available across rule files. Increase the
limit for parallel execution; lightweight suites may run faster serially because startup has a cost.

`--timeout <duration>` limits each case independently, defaulting to `10s`. Use a positive duration
with an `ms`, `s`, or `m` suffix, such as `500ms`, `30s`, or `2m`; the maximum is `2147483647ms`.
Timed-out workers are terminated, their temporary projects are removed, and later cases continue
with a replacement worker. Both synchronous hangs and never-resolving async checks are bounded.

Interactive terminals show a spinner on stderr while rules load and tests run. It clears before each
result and stops before the summary or an error. Redirected output has no animation; colors honor
`NO_COLOR`, `FORCE_COLOR`, and `TERM=dumb`, with the same precedence as `check`.

Rules with no cases are ignored; selecting no cases is an error. A `.skips()` case passes when the
rule is skipped, including when filtering or file selection leaves no subjects.

Exit `0` when all assertions match, `1` for assertion mismatches or timeouts, or `2` for invalid
declarations, loading/runtime errors, unsafe fixture paths, AI calls from ordinary `tests`, or no test
cases. Runtime errors identify the rule and case and abort the run; already printed results remain
visible, and temporary projects are removed even on failure.

### `check [path]`

Target defaults to `.`. Selects rules from `.rulekeeper` in the working root and home (or `--rules`), then
evaluates them.


| Flag                     | Meaning                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--rules <path>`         | Explicit rule file or recursive directory instead of discovery.                                                                    |
| `--diff-only`            | Evaluate changed files only; folder/project groups retain full contents but run only when affected.                                |
| `--base <ref>`           | Git reference to compare directly with the working tree; default `HEAD`; requires `--diff-only`.                                   |
| `--json`                 | JSON object on stdout: `{ "durationMs": number, "reports": [...] }`; violations only by default.                                   |
| `--jsonl`                | Compact `{ "type": "rule", ...report }` records with each rule's `durationMs`; violations only by default, with no summary record. |
| `--output-all`           | Include every verification and skipped rule in human, JSON, or JSONL output.                                                       |
| `--debug`                | Stream framework metadata (no bodies) and force concurrency 1.                                                                     |
| `--verbose`              | Stream the walkthrough (request/response bodies, source excerpts) at the configured concurrency.                                   |
| `--concurrency <number>` | Bounded in-flight selection/evaluation tasks; default 8; must be a positive safe integer.                                          |
| `--threshold <number>`   | Decision threshold override; finite decimal in `0–1`; no implicit default.                                                         |


`--debug` and `--verbose` combine: the verbose walkthrough is preserved and concurrency stays 1.

```sh
node dist/cli.js check --diff-only
node dist/cli.js check src --diff-only --base origin/main
```

Diff-only includes tracked changes relative to the base (committed, staged, unstaged, deleted, and
renamed paths) and nonignored untracked files. It compares **directly with the base tree**, not a merge
base, and evaluates current contents rather than historical snapshots or individual changed lines.
Staged edits reverted in the working tree are unchanged if their current contents match the base.
Git is required only in this mode; a missing repository or invalid reference exits `2`.
Changed paths use the physical spelling of existing files and directories, so edits after case-only
renames still match selected files on case-insensitive filesystems. Deleted paths use the spelling of
any surviving ancestors; missing suffixes retain Git's spelling.

Scope/file rules evaluate all selected scopes in changed files. Folder/project groups keep every
normally selected, filter-accepted member, including unchanged files, and run if any eligible changed
path falls within their folder/project and the positional target. Folder levels still apply. Deleted
paths and both sides of a rename can trigger surviving groups; wholly removed groups are not
synthesized. Unaffected groups and an empty diff are skipped. Traversal exclusions and loaded rule-file
exclusions still apply. Gates, project readers, and check-time `context.select` retain normal access.

`--json` and `--jsonl` are mutually exclusive. By default they omit passing/skipped rules and passing
evaluations inside mixed-result rules. `--output-all` preserves every report and evaluation. Included
reports retain their complete subject data; neither format adds colors or automatic progress animation.
JSONL contains only rule records and emits nothing when no rules are included. These formats are
emitted only after execution completes; they never contain a partial report after a runtime error.

Human output shows the total elapsed rule-execution time using two decimal places and scaled units:
`23.49ms`, `23.49s`, `1.25min`, `1.25h`, or `1.25d`. JSON retains the total as the envelope's numeric
`durationMs`. This monotonic total includes selection, gates, filtering, and awaited checks across all
rules, regardless of output filtering; it excludes target/rule loading and final report rendering.

Every `RuleReport`, including skipped rules, also has its own numeric `durationMs` in milliseconds.
JSON report items and JSONL rule records preserve this value. It measures that rule's active selection,
grouping, and evaluation phases, excluding unrelated rules' selection and waiting before its first
evaluation starts. Concurrent subjects use the interval from the first start to the last completion,
not the sum of their individual times. Rule durations can overlap and must not be added to obtain the
total. JSONL has no separate total-duration item.

**Engine + I/O baseline (repository):**

```sh
npx tsx src/cli.ts check --rules benchmarks/engine.rule.ts --jsonl --output-all
```

This explicit-only rule lives outside default `.rulekeeper` discovery. It selects the three existing
`tests/manual/*.yml` files as whole-file scopes and always passes: no YAML parsing, policy, or AI.
Its `durationMs` measures filesystem selection/read/stat plus engine validation, grouping, and
evaluation—not pure CPU or CLI startup/import time. Use fresh invocations when comparing results;
filesystem cache state can still affect timings.

`[path]` may be relative or absolute within the working root. On a case-insensitive filesystem,
alternate-case root and target spellings resolve to their actual filesystem names before selection
and reserved-directory checks; reported paths remain root-relative. This does not relax symlink
boundaries or the relative-only contract of project readers.

`[path]` **narrows selection only** — gates and project readers still see the full working root. Human
output always counts the full run's rules/skips/verifications/violations, but defaults to violation
details only. The section title is `🚓 Violations:`; individual violations have a bold red rule name,
file/line, and any supplied message, without a police-car prefix. `--output-all` lists every verification,
with a green ✓ and bold green rule name for passing checks, plus skipped-rule reasons. It reports
explicitly when no verifications ran rather than
claiming compliance. Source excerpts preserve Unicode and expand tabs to four-column stops. Grouped
results list their members with file/line and source excerpts.

Default human output lists at most 10 violations; `--output-all` does not limit verification entries.
Both views show at most 5 group members and 5 source lines each, with truncation notices. Use `--json`
or `--jsonl` for complete included subject data, adding `--output-all` for all verifications.

Interactive human checks show an animated progress bar on stderr: loading rules, scanning rules, then
evaluating subjects with completed/total counts. The progress line clears on success or failure. It is
disabled for redirected output, `--json`, `--jsonl`, `--debug`, and `--verbose`. Colors are automatic on
capable terminals; `NO_COLOR` or `TERM=dumb` disables automatic colors. `FORCE_COLOR` overrides detection
(`0` or `false` disables colors) but never forces animation.

Every diagnostic redacts the configured `TYPESAFE_API_KEY` in its literal, trimmed and JSON-escaped
forms, so walkthrough source excerpts and custom `trace` details never carry it; machine reports retain
complete, unredacted subject data for included verifications. The `rulekeeper:` prefix is fixed and is
never redacted, even for a very short key. Exit `0` (clean or skipped), `1` when evaluation completes with
a violation (the selected result prints first), `2` on usage/config/runtime error. Output filtering never
changes the exit code. Runtime failures write nothing to stdout; diagnostics go to stderr prefixed
`rulekeeper:`.

### `inspect <rule> [folder]`

Cards are the default. These output options are mutually exclusive:


| Flag      | Output                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json`  | One JSON document: `{ "events": [...], "reports": [...], "error"?: string }`.                                                                       |
| `--jsonl` | Streamed `{ "type": "event", "event": ... }` records, followed by `{ "type": "report", "report": ... }` records on completion.                      |
| `--raw`   | Plain labels, indentation, source excerpts, and serialized payload text without cards, colors, dividers, terminal wrapping, or JSON prettification. |


Inspect machine output includes the complete diagnostic walk and all final evaluations, including
passes and skipped rules. Request/response bodies remain strings; `evaluationId` correlates events.
`--json` buffers events until completion and includes collected events, empty reports, and `error` on
preparation/evaluation failure. `--jsonl` streams events immediately and ends failures with a
`{ "type": "error", "message": ... }` record instead of completion reports. There is no generic summary
record. Exit codes remain `0` for clean/skipped, `1` for completed violations, and `2` for errors;
usage errors keep standard CLI diagnostics rather than producing a machine document.

Every inspect format redacts configured credentials, including JSON event data and reports. This
differs from `check --json`/`check --jsonl`, which retain unredacted subject data as documented above.
`--raw` overrides forced colors but still masks credentials and escapes unsafe terminal controls;
basic source gutters and tab expansion remain.

`[folder]` defaults to `.`, and the same engine runs with concurrency 1. Rule settings, gates, candidate
file decisions, and filtered scopes appear outside evaluation cards. Each evaluation gets one bordered
card with its rule, file/range, and scope metadata shown once in the header. Source excerpts (or grouped
member sources), traces, requests, responses, and the result stay together inside that card. Accepted
scope and group details move into their evaluation card rather than being repeated during selection.

Inspect streams the card as evaluation proceeds. Errors close the card and preserve its already-written
content; unfinished evaluations are marked incomplete rather than reported as passing or violating.
Disabled rules, false gates, and selections with no subjects are explained without contacting Jev.
Inspect exits `1` on a completed violation and `2` on error.

Cards use the available terminal width, wrapping long paths and payload lines without truncating data.
Section titles extend into muted horizontal dividers. Request and Response body labels and payloads
are grey; source and result styling remain unchanged. AI results show `threshold` beside `probability`.
Bold information headings, green successful states, red violations/errors, and yellow skipped/filtered
states follow the color settings above. Card output without colors keeps the dividers, borders, and
layout. Source line numbers, original Unicode, and credential redaction are preserved; JSON
formatting retains original keys and numeric literals.

`check --verbose` uses the same cards without enabling colors by default and preserves its configured
concurrency. Concurrent evaluations are buffered separately by evaluation ID, then each completed card
is emitted together so exchanges cannot interleave. Setup/file decisions still stream immediately;
unfinished cards are flushed on failure. `--debug` remains compact event metadata.

`[folder]` may be an absolute path or a sibling directory outside the invocation cwd, in which case it
becomes an independent project root (the rule may live beside it). A `[folder]` inside the invocation cwd
still obeys the reserved-source boundary: `old/`, `node_modules/`, `.rulekeeper/`, `.git/`, and a root
`dist/`/`coverage/` are rejected as targets. The folder must exist as a directory.

`help`, `help <command>`, and `--help` exit `0`; an unknown help target, unknown commands/options,
and argument errors exit `2` (Commander `exitOverride`).
Removed commands are **unknown, not ignored**: `stats` and `stats reset` exit `2`. Piped output is plain
unless color is explicitly forced; unsafe control characters in untrusted paths/source/messages are
escaped.

## Boundaries and isolation

- **Current contents.** Git is used only by `check --diff-only` to identify changed paths; checks always
read the working tree. Normal selection does not infer `.gitignore`; diff-only excludes ignored
untracked files, while tracked files remain eligible.
- **Traversal exclusions.** Selection and the file inventory skip symlinks and the directories `.git`,
`node_modules`, `.rulekeeper`, and `old`, plus a root-level `dist/` and `coverage/`. Explicit source
targets inside an excluded directory are errors, not overrides.
Exclusions use actual directory spelling and identity, not the caller's casing: on a case-insensitive
filesystem `OLD/...` cannot bypass an actual `old/`, while an actual uppercase `OLD/` remains eligible
even through a lowercase reader/custom-selector alias. Regular files with reserved directory names
remain eligible; glob matching itself remains case-sensitive.
Literal glob prefixes use physical descendant depth: leading `./` cannot bypass root `dist/` or
`coverage/` checks, and the project root itself is not classified by its own basename. Glob patterns
are not rewritten: `./`-prefixed patterns retain their existing matching behavior, while nested
generated directories remain eligible.
- **Path boundary.** Helper paths must be root-relative and stay within the physical root; absolute
paths, `..` escapes, and symlink traversal are rejected. This is API consistency, not a security
boundary — trusted rule code can use `node:fs` itself.
- **Archived implementation.** The previous YAML-rule implementation and its tests, Git/statistics code,
schema, benchmark tooling, and docs live under `old/`. Nothing in the active build, package, tests,
rule discovery, or default source traversal imports or enters it, and `old/` rules are rejected.
- **Not rebuilt.** Statistics storage, Git/diff behavior, the `stats` command, and a benchmark CLI are
intentionally absent; benchmarking is not a command.

## More examples

**JSON scope with a key id, plus a custom check that reads a neighboring Project file:**

```ts
import {
  Rule,
  pass,
  violation,
  scopes,
  type CheckResult,
  type ProjectContext,
  type Subject,
} from 'rulekeeper';

type Endpoint = { host: string; port: number };

export default class EndpointInventory extends Rule<Endpoint> {
  files = ['config/**/*.json'];
  scope = scopes.json<Endpoint>({ path: '$.services[*]', key: '$.name' });

  check = async (
    subject: Subject<Endpoint>,
    { project }: ProjectContext,
  ): Promise<CheckResult> => {
    if (subject.kind !== 'scope') return pass();
    const allowed = await project.readYaml('config/allow.yaml');
    return allowed.includes(subject.id)
      ? pass()
      : violation(`Unknown service "${subject.id}" at ${subject.filepath}`);
  };
}
```

**CSV source, folder grouping, and a conditional AI call inside a custom check:**

```ts
import {
  Rule,
  pass,
  scopes,
  type CheckContext,
  type CheckResult,
  type Grouping,
  type Subject,
} from 'rulekeeper';

export default class EnvMatrix extends Rule {
  files = ['env/*.csv'];
  scope = scopes.csv({ key: 'name' });
  group: Grouping = 'folder';

  check = async (subject: Subject, context: CheckContext): Promise<CheckResult> => {
    // Contacts the provider only when this folder has an override file; otherwise stays offline.
    if (!(await context.project.hasFiles('env/overrides.yaml'))) return pass();
    const overrides = await context.project.readYaml('env/overrides.yaml');
    const members = subject.kind === 'group' ? subject.members : [subject];
    return context.ai({
      rule: 'Every service in the matrix is documented in overrides.yaml.',
      input: () => ({ overrides, services: members.map(member => member.id) }),
      violationMessage: 'Undocumented service in the environment matrix',
    });
  };
}
```

The second example supplies its own `AiOptions.input`: the parsed override documents (`readYaml` yields one
value per document) and the collected service names both travel with the request, so editing
`overrides.yaml` changes what the provider sees. Without an explicit input the framework projects the
grouped scopes alone, and the documented services are never sent. The first example is a deterministic
check and never contacts the provider.

### AI-backed TypeScript policies

These local examples use ASTs to select candidate-bearing files, then ask AI to assess intent.
Each selected file is evaluated once, with its complete source and filepath so local uses,
comments, and exports remain visible. Candidate presence alone is not a violation.

| Rule | Review focus |
|---|---|
| [ts-no-deprecated-leftovers](.rulekeeper/ts-no-deprecated-leftovers.rule.ts) | Obsolete internal deprecated aliases/wrappers, preserving supported public migrations and compatibility tests. |
| [ts-no-tiny-functions](.rulekeeper/ts-no-tiny-functions.rule.ts) | Unnecessary named expression/single-return wrappers, preserving domain concepts, contracts, type guards, identity, and useful reuse. |
| [ts-no-local-is-record](.rulekeeper/ts-no-local-is-record.rule.ts) | Redundant local guards or object checks misused as domain validation, preserving canonical guards and sound staged narrowing. |
| [ts-no-dynamic-import](.rulekeeper/ts-no-dynamic-import.rule.ts) | Directly awaited literal imports with no loading purpose, preserving intentional laziness, optional/platform dependencies, initialization constraints, and module-boundary tests. |
| [ts-set-map](.rulekeeper/ts-set-map.rule.ts) | Small fixed string-keyed value lookups initialized from literal arrays, preserving membership, mutation, iteration, identity, non-string keys, and unknown consumers. |

All five support `.ts`, `.tsx`, `.mts`, and `.cts`, and exclude declaration files.
The dynamic-import selector ignores computed specifiers and non-awaited imports; the collection
selector ignores constructors without literal-array initializers. `ts-no-test-timers` is not included.

These checks see only the selected file, not arbitrary callers or migration documents elsewhere.
Their policies require visible evidence and preserve legitimate exceptions rather than invent
missing context. AI judgments remain probabilistic. Full file contents are sent to the configured
decision provider; use `exclude` for generated or otherwise unsuitable paths.

The five rules export 23 live `aiTests`, covering expected violations and legitimate exceptions.
These include regression cases preserving public primitive adapters and conditional runtime
loading after a type-only import. Each fixture contains an AST candidate, so a passing assertion
requires an actual AI decision rather than no selection. Run them with
[`test --ai`](#test-rule-path). Their deterministic candidate-selection goldens remain offline:

```sh
npm run build
node --test tests/typescript-ai-rules.test.ts
```

To exercise an actual judgment with configured AI credentials:

```sh
node dist/cli.js inspect .rulekeeper/ts-no-dynamic-import.rule.ts path/to/project
```

### Example boundaries and usage

- The TypeScript examples support `.ts`, `.tsx`, `.mts`, and `.cts` through `scopes.astGrep`'s
built-in grammar dispatch. The import policy excludes `.d.ts`, `.d.mts`, and `.d.cts`.
Generated code is not automatically detected; configure `exclude` for project-owned generated paths.
- AST parsing is not full TypeScript type checking. In particular, the bundled grammar loses type
context for some valid inline-import forms, including `keyof import("x").T` and
`[...import("x").T[]]`. The import rule does not guess from parser error text.
- The cast rule targets direct object-type assertions, not named/generic/intersection assertions or
access through an intervening operation. Allowing a named assertion does not establish its safety.
- Go imports are matched structurally with ordinary quoted or raw import paths, including aliases
and grouped imports. Version gates read the nearest ancestor `go.mod` within the project;
nested modules override parents. Missing modules/directives skip, and `toolchain` is not the
module's language target. Import rules flag a chosen migration policy, not semantic equivalence.
- Deterministic selectors identify violations; compliant files select no scopes and report `skipped`.
AI selectors identify review candidates, which may pass after evaluation. Offline selection tests
do not establish the correctness of model judgments.

For example, after building:

```sh
node dist/cli.js test .rulekeeper
node dist/cli.js check src --rules .rulekeeper/ts-no-any.rule.ts
```

## Release notes

- Clarified the tiny-helper and dynamic-import AI policies without changing thresholds or existing
expectations; added contrastive public-adapter and type-only/runtime-import exception regressions.
- Added `test --failures-only` to filter case output without changing execution, complete totals,
or exit codes; filtered failures and completed totals remain visible on runtime errors.
- Added independent live outcome datasets for the five AI TypeScript rules and `test --ai` support
for opt-in `aiTests`; ordinary tests and `npm test` remain offline.
- Moved TypeScript/TSX grammar dispatch into `scopes.astGrep`, with an optional complete `tsx` query
replacement; local rules now call the SDK directly without a TypeScript wrapper.
- Added five AST-gated AI TypeScript policies with full-file context, legitimate-exception examples,
and offline candidate-selection goldens; test-timer policy remains excluded.
- Added six deterministic AST-based local TypeScript/Go rules with inline datasets, nearest-module
Go-version gates, and a documented assessment of all 26 upstream policies and their limitations.
- Rules can declare fluent inline datasets with `test(name).withFiles(files).passes()`, `.violates()`,
or `.skips()`. The new `test [rule-path]` command runs them in isolated temporary projects.
- Test output streams colored per-rule trees with an interactive spinner, preserving completed
results when a later case fails at runtime.
- Test output redacts secrets before applying ANSI styling, preserving colors even for short
numeric credentials.
- Test rows show elapsed time and summaries show summed case time using the evaluation duration
scales. `test --timeout <duration>` enforces a per-case deadline (default `10s`) in isolated workers.
- Rule tests reuse a bounded worker pool across rule files. `test --concurrency <number>` defaults to
`1`, with ordered output, fresh rule instances, separate projects, and worker replacement on timeout.
- Scope-selector results and rule `files`/`exclude` lists reject missing or inherited-only array
entries; an empty scope result still skips normally, and disabled rules still validate fully.
- Project readers, stat, literal glob prefixes, targets, and custom selection enforce reserved-directory
identity using actual filesystem spelling without rejecting aliases of eligible uppercase entries.
- Literal-prefix validation ignores the project root itself and uses physical directory depth, so
leading `./` cannot bypass root-generated exclusions or reject an independent root by its basename.
Glob matching remains unchanged.
- AI good/bad example arrays reject missing or inherited-only entries eagerly and at runtime before
requesting a decision; empty and omitted lists remain valid.
- Structured selector paths and CSV headers/delimiters reject explicit `null` instead of silently
defaulting. CSV delimiters accept one Unicode code point, including supplementary characters, with
exact keyed/multiline UTF-8 source locations.
- Successful implicit help commands now exit `0`, matching `--help`; invalid help targets remain errors.
- `check` identifies alternate-case root spellings by filesystem identity and canonicalizes target
spelling before selection and reserved-directory checks. Root-ancestor aliases are allowed only
when traversal reaches the project root; aliases jumping into a subdirectory and in-root symlinks
remain rejected. Actual uppercase entry names are preserved rather than lowercased.
- Valid wildcard and recursive JSON/YAML queries retain exact RFC 6901 pointer IDs and source text
for data keys such as `~`, `^`, and `@name()` (`/~0`, `/^`, and `/@name()`; YAML prefixes the document
index). Distinct YAML alias occurrences keep distinct paths, including recursive scalar queries
such as `$..v`. This does not change JSONPath operator syntax.
- Scope data arrays and capture arrays must be dense: holes are rejected instead of becoming `null`
entries in reports, including holes nested inside scope data.
- Every `CheckResult` is projected to its plain declared fields (`status`, `message`, `probability`,
`threshold`, `model`); accessor-backed values are materialized, and message-free violations retain
their probability, threshold, and model without adding generated message text.
- Custom `select` subjects are projected to validated declared fields; `captures` become a plain object
of strings or string arrays, and `lines` are materialized. Extra fields returned by a scope selector
cannot overwrite framework-owned `kind` or `filepath`.
- Protobuf scope parsing skips prototype-named unknown fields (for example `constructor`) instead of
matching an inherited standard verb.
- Diagnostics redact the configured `TYPESAFE_API_KEY` in its literal, trimmed, and JSON-escaped forms.
Short keys over-redact dynamic text on purpose; the `rulekeeper:` prefix itself is never redacted.
- JSON values must be finite and plain: a value carrying a `toJSON` serialization hook is rejected
instead of being silently serialized.
- Source fidelity: CSV fields are located by byte offset, so multibyte text keeps its exact `source`, and
a YAML document whose root is a tagged scalar is preserved rather than treated as empty.
- Rule discovery and explicit rule paths reject anything under an archived `old/` directory.