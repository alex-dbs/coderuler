# rulekeeper

**One rule = one TypeScript/JS class.** rulekeeper selects *scopes* (named, source-located slices of
files), filters their applicability, groups them if needed, and evaluates each subject — with a remote
AI decision (Jev), with a deterministic local check, or with any code you write. It runs against the
**current working tree**: no Git, no revisions, no diffs.

A rule is a normal ES module that default-exports a class extending `Rule`. The framework provides the
shared mechanics (file selection, scope extraction, filtering, grouping, concurrency, reporting);
authors supply policy through ordinary methods and evaluators. Rules are **trusted code** with full
Node access — this is an authoring framework, not a sandbox.

| Command | Purpose |
|---|---|
| `rulekeeper validate [rule-path]` | Load and structurally validate rules offline. |
| `rulekeeper check [path]` | Run every selected rule and report violations (exit 1 when any). |
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

| Member | Default | Role |
|---|---|---|
| `enabled` | `true` | `false` skips the rule (reported with reason `disabled`). |
| `files` | `['**/*']` | Root-relative globs; **non-empty**. |
| `exclude` | `[]` | Root-relative globs; exclusion wins over `files`. |
| `scope` | absent | `ScopeSelector`; absent selects one whole-file scope per file. |
| `settings` | `{}` | `{ backend?: 'jev'; model?: string; threshold?: number }` overrides for this rule. |
| `group` | `'scope'` | `'scope' \| 'file' \| 'folder' \| 'project' \| { by: 'folder', level }`. |
| `when(context)` | `true` | Whole-rule gate; `boolean` or `{ applies, reason? }`. |
| `select(context)` | delegates | Override to build subjects yourself (default uses `files`/`exclude`/`scope`). |
| `filter(subject, context)` | `true` | Per-scope applicability; `boolean` or `{ applies, reason? }`. |
| `check` | *(abstract)* | Required `Evaluator`, assigned as a **function-valued property**: `check = ai({...})`, `check = regex({...})`, or `check = async (subject, context) => ...`. It is read as a function value, not overridden as a method. |

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

| Factory | Options | Selection |
|---|---|---|
| `scopes.file()` | — | One data-free `$` scope per eligible file, including empty files (`lines` 1–1). |
| `scopes.json<T>({ path?, key? })` | `path` default `$` | Strict JSON only (no comments, trailing commas, or empty input); duplicate keys and non-finite numbers are rejected. `id` is the RFC 6901 pointer (`$` at root) or the `key` value. |
| `scopes.yaml<T>({ path?, key? })` | `path` default `$` | Every nonempty YAML document, in order, with aliases/merge keys resolved and a bounded alias count. `id` is `<doc-index>:<pointer-or-key>`; empty/comment-only documents are skipped without renumbering. |
| `scopes.csv({ headers?, delimiter?, key? })` | `headers` default `true`, `delimiter` default `,` | One scope per data record; ids are `row:<n>` (1-based) or a `key` column value. Handles quoting, multiline fields, BOM, LF/CRLF/CR, and blank lines; strict record widths. |
| `scopes.astGrep({ language, rule, constraints?, utils? })` | — | Native ast-grep matches with captures (pattern metavariables plus named-declaration/Go-receiver identities) and line spans. The native query is compiled and validated at factory construction. |
| `scopes.protobuf<T>({ path? })` | `path` default `$.rpcs[*]` | RPC records or their `google.api.http` subtrees. Data is `{ id, package, service, name, http: { bindings: [{ method, url }] } }`. |

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

## Evaluators

```ts
import { ai, regex, pass, violation } from 'rulekeeper';
```

- **`ai(options): Evaluator`** — the recommended remote check. `options` is `{ rule, examples?,
  violationMessage?, input? }`. The framework builds the default input from the subject (no manual
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
  probability/model.

- **`pass()` / `violation(message)`** — helpers for custom checks.

A **custom check** is any `Evaluator`-shaped value (`(subject, context) => Awaitable<CheckResult>`)
assigned to the function-valued `check` property, for example
`check = async (subject, context) => { ... }`. `subject` is a `Subject<T>`, so `subject.kind === 'scope'`
narrows it to `ScopeSubject<T>` (with `id`, `source`, `data`, `captures`, and `filepath`). The check
returns `{ status: 'pass' | 'violation', message?, probability?, model? }` or throws; the result is
validated and a violation without a message is normalized to `Rule "<name>" was violated`. A violation
may use any external library/provider directly — there is no backend-registration framework.

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

| Setting | Environment | Default | Precedence |
|---|---|---|---|
| threshold | `RK_THRESHOLD` | `0.4` | `--threshold` > `rule.settings.threshold` > `RK_THRESHOLD` > default |
| backend | `RK_BACKEND` | `jev` | rule setting > env > default |
| model | `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | rule setting > env > default |
| base URL | `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | env only |
| API key | `TYPESAFE_API_KEY` | — | env only (required for AI calls) |

Settings resolution is **lazy**: no provider-specific environment is read or validated until a rule's
first actual AI call. A skipped, filtered, regex-only, or otherwise deterministic run needs no key and
works even with unused invalid AI environment values. A *set-but-blank* used value is an error; values
shadowed by a higher-precedence setting are not consulted. Rule and flag values validate eagerly.

The CLI loads `.env` from the invocation cwd via `process.loadEnvFile()` **without overriding exported
shell variables**; a missing `.env` is ignored. There is no other configuration system and no statistics
directory or database.

### The Jev transport

AI calls `POST v1/systemone` with `Authorization: Bearer <key>` and a body of
`{ model, state, questions: { follows_instructions: { type: 'noul', instructions: { rule, question: 'Is
the rule respected?', examples? } } } }`. `examples` is omitted entirely when both good and bad are
empty; `violationMessage` is reporting-only and never sent. The call passes iff the returned probability
is **strictly greater** than the threshold (equality violates). The client uses a 30-second timeout, no
redirects, no retries, and validates the model/answers/type and a finite probability in `[0, 1]`;
timeout/network/HTTP/malformed/unsafe-URL errors are sanitized. Debug metadata never contains bodies or
credentials, while `inspect`/`--verbose` show the actual serialized request and parsed response after
redacting the key (including on failures); the same redaction covers the streamed source excerpts and
`trace` details, so the key never reaches a diagnostic, while `--json` keeps complete subject data.
Headers and `Authorization` are never logged.

AI `examples.good` and `examples.bad` must be dense arrays of non-empty strings. Sparse arrays and
inherited-only entries fail during evaluator construction and runtime `context.ai` validation, before
a decision request. Empty or omitted lists remain valid; dense example order is preserved on the wire.

> AI-backed rules require `TYPESAFE_API_KEY`. Without it, `validate`, deterministic and regex rules, and
> all skipped/no-subject rules run fully offline. This document describes behavior only; it does not
> assert that a live provider was contacted.

## Commands

### `validate [rule-path]`

Loads and structurally validates all selected rules (discovery, or the explicit file/directory, resolved
relative to the invocation cwd). Prints `Valid rule: <name>` per rule. It does **not** run gates, read
target sources, contact Jev, or act as a type checker — use `tsc` for semantic checking. Exit `0`, or `2`
on error.

### `check [path]`

Target defaults to `.`. Selects rules from `.rulekeeper` in the working root and home (or `--rules`), then
evaluates them.

| Flag | Meaning |
|---|---|
| `--rules <path>` | Explicit rule file or recursive directory instead of discovery. |
| `--json` | Full machine-readable report on stdout (a 2-space-indented array with complete subject data). |
| `--debug` | Stream framework metadata (no bodies) and force concurrency 1. |
| `--verbose` | Stream the walkthrough (request/response bodies, source excerpts) at the configured concurrency. |
| `--concurrency <number>` | Bounded in-flight selection/evaluation tasks; default 8; must be a positive safe integer. |
| `--threshold <number>` | Decision threshold override; finite decimal in `0–1`; no implicit default. |

`--debug` and `--verbose` combine: the verbose walkthrough is preserved and concurrency stays 1.

`[path]` may be relative or absolute within the working root. On a case-insensitive filesystem,
alternate-case root and target spellings resolve to their actual filesystem names before selection
and reserved-directory checks; reported paths remain root-relative. This does not relax symlink
boundaries or the relative-only contract of project readers.

`[path]` **narrows selection only** — gates and project readers still see the full working root. Human
output shows counts for rules/skips/verifications/violations, file/line and message per violation, and
an explicit "no verifications" message rather than claiming compliance. A grouped violation lists its
members with file/line and source excerpts. It lists at most 10 violations, with at most 5 members and
5 source lines each, followed by a truncation count and a pointer to `--json` for full data. Every
diagnostic redacts the configured `TYPESAFE_API_KEY` in its literal, trimmed and JSON-escaped forms, so
walkthrough source excerpts and custom `trace` details never carry it; `--json` still prints complete
subject data. The `rulekeeper:` prefix is fixed and is never redacted, even for a very short key. Exit `0`
(clean or skipped), `1` when evaluation completes with a violation (the full result prints first), `2` on
usage/config/runtime error. Runtime failures write nothing to stdout; diagnostics go to stderr prefixed
`rulekeeper:`.

### `inspect <rule> [folder]`

`[folder]` defaults to `.`, and the same engine runs with concurrency 1 and an event renderer: it shows
the rule and settings, its gate, selected/excluded files, accepted/filtered scopes and groups, then the
exact AI request/response or the deterministic check input/result. File decisions stream as they are
made — there is no trailing full-project inventory — and a disabled rule, a false gate, or a selection
with no matching subjects is explained without contacting Jev. Preserves its already-streamed walkthrough
on error (exit `2`) and returns `1` on a completed violation.

`[folder]` may be an absolute path or a sibling directory outside the invocation cwd, in which case it
becomes an independent project root (the rule may live beside it). A `[folder]` inside the invocation cwd
still obeys the reserved-source boundary: `old/`, `node_modules/`, `.rulekeeper/`, `.git/`, and a root
`dist/`/`coverage/` are rejected as targets. The folder must exist as a directory.

`help`, `help <command>`, and `--help` exit `0`; an unknown help target, unknown commands/options,
and argument errors exit `2` (Commander `exitOverride`).
Removed surfaces are **unknown, not ignored**: `stats`, `stats reset`, `--diff-only`, and `--base` all
exit `2`. Color uses standard Node support only; piped output is deterministic and control characters in
untrusted paths/source/messages are escaped.

## Boundaries and isolation

- **Current tree only.** There is no Git integration or revision/diff abstraction; no snapshot ports, and
  no `.gitignore` inference.
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

## Release notes

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
  `model`); accessor-backed values are materialized, and adding the fallback violation message never
  drops `probability` or `model`.
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
