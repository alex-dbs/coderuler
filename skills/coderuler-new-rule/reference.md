# Rule API reference

Read the branch needed for the rule; use [SKILL.md](SKILL.md) for the authoring, test, and inspection workflow. All imports below use the public `@alex-dbs/coderuler` SDK.

## Rule members and lifecycle

Default-export a constructible class extending `Rule<T>` (`T = JsonValue`). Extra class fields/methods are allowed; hooks and checks receive the rule instance as `this`.


| Member / signature                                                                      | Default    | Contract                                                                                                     |
| --------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `enabled: boolean`                                                                      | `true`     | `false` skips with reason `disabled`; structural validation still runs.                                      |
| `files: readonly string[]`                                                              | `['**/*']` | Nonempty root-relative glob list.                                                                            |
| `exclude: readonly string[]`                                                            | `[]`       | Root-relative globs; exclusion wins.                                                                         |
| `tags?: readonly string[]`                                                              | Absent     | Labels for `check --tags` and `--exclude-tags`.                                                              |
| `scope?: ScopeSelector<T>`                                                              | Absent     | One whole-file scope per eligible file unless supplied.                                                      |
| `settings: RuleSettings` | `{}` | Optional backend, model, threshold, and input/output USD-per-million token prices; see AI below. |
| `group: Grouping`                                                                       | `'scope'`  | Groups surviving scopes before evaluation.                                                                   |
| `comment?: string` | Absent | Nonblank Markdown override for each GitHub finding body with `--auto-comment`; see below. |
| `when(context: ProjectContext): Awaitable<PredicateResult>`                             | `true`     | Whole-rule applicability, once per enabled rule before parsing target sources.                               |
| `select(context: SelectionContext): Awaitable<readonly ScopeSubject<T>[]>`              | Delegates  | Calls `context.select({ files, exclude, scope })`; override for custom selection.                            |
| `filter(subject: ScopeSubject<T>, context: ProjectContext): Awaitable<PredicateResult>` | `true`     | Per-scope applicability before grouping.                                                                     |
| `check: Evaluator<T>`                                                                   | Required   | Function-valued property, such as `check = regex(...)` or `check: Evaluator<T> = ...`, rather than a method. |


Execution: load and validate all rules → apply `check` tag filters → enabled → `when` → select → validate subjects → filter → group → check → report. `Awaitable<T>` means `T | Promise<T>`.

`files` and `exclude` must be dense arrays of nonempty strings, including on disabled rules. `tags`, when present, must be dense arrays of nonempty strings.

Good: explain an out-of-domain scope with a filter reason. Bad: return `pass()` from a check because required data is missing, or filter out a genuine violation. Keep instance/module state independent of evaluation ordering: checks can run concurrently, and test workers reuse imported modules.

## Built-in selectors

`scopes` exposes these factories. Each result is a `ScopeSelector<T>` except `file()` (`ScopeSelector<never>`) and `csv()` (`ScopeSelector<CsvRow>`).


| Factory                                                          | Options and behavior                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopes.file()`                                                  | No options. One data-free `$` scope per file, including empty files (lines 1–1).                                                                                                                                                                                                                                                                                      |
| `scopes.json<T>({ path?, key? }?)`                               | Both options are strings; `path` defaults to `$`. Strict JSON: comments, trailing commas, empty input, duplicate keys, and nonfinite numbers error. ID is an RFC 6901 pointer (`$` at root), or the selected key.                                                                                                                                                     |
| `scopes.yaml<T>({ path?, key? }?)`                               | Same options/default as JSON. Selects every nonempty document in order; aliases/merge keys resolve with a bounded alias count. ID is `<doc-index>:<pointer-or-key>`. Empty/comment-only documents are omitted without renumbering.                                                                                                                                    |
| `scopes.csv({ headers?, delimiter?, key? }?)`                    | `headers: boolean = true`, `delimiter: string = ','`, `key?: string`. Header mode yields string records; otherwise string arrays. IDs are `row:<n>` (1-based data record) or the nonblank, unique key-column value. `key` requires headers and an existing column. Quoting, multiline records, BOM, and line-ending variants are supported; record widths are strict. |
| `scopes.astGrep({ language, rule, constraints?, utils?, tsx? })` | Required language string and native ast-grep query; optional metavariable constraints and reusable query utilities. Returns source/captures/line spans, not parsed `data`; queries validate at factory construction.                                                                                                                                                  |
| `scopes.protobuf<T>({ path? }?)`                                 | String `path` defaults to `$.rpcs[*]`. Reads declarations and their options from one file; see [Protobuf data](#protobuf-data).                                                                                                                                                                                                                                         |


JSON/YAML `path` addresses the document; `key` is a JSONPath evaluated against each selected value and must produce exactly one string or finite number. All structured paths are nonempty `$`-rooted JSONPath; executable expressions are rejected and evaluation errors propagate. Protobuf paths may select any node of the protobuf document.

Omitted/`undefined` options retain defaults; explicit `null` is invalid for structured paths and CSV headers/delimiters. A CSV delimiter is one Unicode code point other than CR, LF, or a quote; CSV scopes preserve exact record source slices with multibyte delimiters too.

### ast-grep queries

Use `scopes.astGrep` to select code by syntax. The [official ast-grep documentation](https://ast-grep.github.io/) is authoritative for query syntax and behavior. This reference covers the CodeRuler integration.

- For patterns and captures, read [pattern syntax](https://ast-grep.github.io/guide/pattern-syntax). `$NAME` matches one node, and `$$$ARGS` matches zero or more nodes.
- For node kinds, relations, and logical composition, read the [rule object reference](https://ast-grep.github.io/reference/rule).
- For unfamiliar syntax, use the [playground](https://ast-grep.github.io/playground.html) to inspect node kinds and try the query against realistic code.
- For custom node traversal beyond built-in selection, read the [JavaScript API](https://ast-grep.github.io/guide/api-usage/js-api).

Choose the source language, then start with a `pattern` or `kind`. Add `has`/`inside` for structural context and `all`/`any`/`not` for composition. Relational searches default to immediate neighbors. Use `stopBy: 'end'` when the search must reach deeper descendants or ancestors.

Pass the query object as `rule`, with `constraints` and `utils` beside it when needed. CodeRuler supplies file selection and reporting, so omit ast-grep YAML fields such as `id`, `message`, and `severity`.

```ts
scope = scopes.astGrep({
  language: 'typescript',
  rule: { pattern: 'console.log($$$ARGS)' },
});
```

This selects calls with any number of arguments. Read `subject.source` and `subject.captures.ARGS` in the check. CodeRuler omits empty captures, so `ARGS` is absent for `console.log()`. Use `coderuler inspect` to confirm matches on project files, then test the policy through the workflow in [SKILL.md](SKILL.md).

### AST and TypeScript/TSX

Choose a language matching the source; common JavaScript/TypeScript, markup, and bundled language grammars are supported, with case-insensitive names/aliases and lazy bundled registration. Use the installed release's language documentation when selecting a less common grammar.

`language: 'typescript'` (alias `'ts'`) uses TSX for `.tsx`, TypeScript otherwise (including `.ts`, `.mts`, `.cts`). Explicit `'tsx'` always uses TSX. Both TypeScript query variants validate eagerly; a TypeScript-only kind needs a TSX-compatible replacement:

```ts
import { scopes } from '@alex-dbs/coderuler';

const assertions = scopes.astGrep({
  language: 'typescript',
  rule: { any: [{ kind: 'as_expression' }, { kind: 'type_assertion' }] },
  tsx: { rule: { kind: 'as_expression' } },
});
```

`tsx: { rule, constraints?, utils? }` is valid only with TypeScript selection and replaces the **complete** query; repeat any needed constraints/utilities. Captures follow the selected query: metavariables provide strings or string arrays, and supported named declarations/Go receivers provide identity captures. Good: query syntax with AST structure. Bad: infer code semantics from line-oriented regular expressions or assume `tsx` merges options.

### Protobuf data

`scopes.protobuf` parses one file without resolving imports or checking types. Its document has this shape:

```ts
type ProtoDeclaration = {
  readonly id: string;
  readonly name: string;
  readonly parent: string | null;
  readonly options: { readonly [key: string]: JsonValue };
};

type ProtoDocument = {
  readonly options: { readonly [key: string]: JsonValue };
  readonly services: readonly ProtoDeclaration[];
  readonly rpcs: readonly ProtoDeclaration[];
  readonly messages: readonly ProtoDeclaration[];
  readonly fields: readonly ProtoDeclaration[];
  readonly oneofs: readonly ProtoDeclaration[];
  readonly enums: readonly ProtoDeclaration[];
  readonly enumValues: readonly ProtoDeclaration[];
  readonly extensions: readonly ProtoDeclaration[];
};
```

Each declaration has a fully qualified `id`, its source `name`, its enclosing declaration ID as `parent` (or `null` at file level), and an `options` object. Each list follows source order.

IDs follow these rules:

- Services use `Service`; RPCs use `Service.Rpc`.
- Top-level messages and enums use `Name`; nested messages and enums use `<enclosing message>.Name`.
- Fields and oneofs use `<message>.name`. A oneof member field has the message as its parent.
- Enum values use `<enum>.VALUE`.
- Extensions use `<enclosing message>.name`, or `name` at file level.
- A group creates a message with its written name and a lowercase field in the same scope. Fields in its body use the group message as parent.
- The package prefixes all IDs, regardless of where its statement appears.

Options include built-in and custom options. Custom names omit parentheses: `(corp.http.route)` becomes the key `corp.http.route`. Use bracket notation for dotted names, such as `$.rpcs[*].options['corp.http.route']`. Dotted assignments create nested objects. Extension keys such as `[acme.ext.note]` and `Any` keys such as `[type.googleapis.com/acme.Thing]` lose their brackets.

Adjacent string literals concatenate. Booleans stay booleans. Safe integers and finite decimal or exponent numbers become numbers; other number spellings, including hex, octal, suffixed, unsafe, and nonfinite values, remain source-text strings. Enum names become strings. Message literals become objects and lists become arrays. A key with multiple occurrences or any list occurrence becomes an array in source order; one list occurrence contributes its elements, including an empty list. A single non-list occurrence remains a plain value. Dotted paths cannot place a field inside a scalar or repeated value. Use JSONPath `..` to reach fields whether their containing option is a single object or an array. JSONPath unions return matches in union order.

Common paths:

| Data | Path |
| --- | --- |
| HTTP URLs | `$.rpcs[*].options['google.api.http']..['get','put','post','delete','patch']` |
| Custom HTTP path | `$.rpcs[*].options['google.api.http']..custom.path` |
| Field validation | `$.fields[*].options['validate.rules']` |
| Deprecated RPCs | `$.rpcs[*].options.deprecated` |
| File Go package | `$.options.go_package` |

IDs select declarations directly; selecting a nested node adds `:/<pointer suffix>` to its declaration ID. Other nodes use their JSONPath pointer as the ID, and the root ID is `$`. Source spans cover the whole file at the root; declarations run from their first token through `;` or `}`, with RPC semicolons included. Name spans cover the name token. Option spans cover their entries; scalar spans cover their tokens, message and list spans include their delimiters, and combined or repeated values span all contributing entries. A node without its own span uses the nearest ancestor span. Line spans are 1-based and inclusive. Malformed syntax fails selection with an error.

Use a protobuf option to enforce a route version:

```ts
import { Rule, regex, scopes, test } from '@alex-dbs/coderuler';

export default class ProtoRouteVersion extends Rule {
  files = ['proto/**/*.proto'];
  scope = scopes.protobuf({ path: "$.rpcs[*].options['corp.http.route'].*" });
  check = regex({ pattern: /^\/v\d+\//, violationMessage: 'Start the route with /v<N>/' });
}

const service = (route: string) => `syntax = "proto3";
package acme.v3;
service Accounts {
  rpc Close(Request) returns (Response) {
    option (corp.http.route) = {post: "${route}"};
  }
}`;

export const tests = [
  test('a versioned route passes').withFiles({ 'proto/accounts.proto': service('/v3/accounts/:id/close') }).passes(),
  test('an unversioned route violates').withFiles({ 'proto/accounts.proto': service('/accounts/:id/close') }).violates(),
];
```

The rule name is `proto-route-version`, saved as `.coderuler/proto-route-version.rule.ts`.

## Custom scope, selection, and filters

The public shapes are:

```ts
import type { Awaitable, JsonValue, SourceFile, ScopeMatch } from '@alex-dbs/coderuler';

type ScopeSelector<T = JsonValue> =
  (file: SourceFile) => Awaitable<readonly ScopeMatch<T>[]>;
// SourceFile: { readonly filepath: string; readonly source: string }
// ScopeMatch<T>: { readonly id: string; readonly source: string;
//   readonly data?: T;
//   readonly captures?: Readonly<Record<string, string | readonly string[]>>;
//   readonly lines?: { readonly start: number; readonly end: number } }
```

Return a dense array; `[]` means no matches. Use stable nonempty IDs and actual source text; line spans are 1-based inclusive. `data` must be finite, acyclic, JSON-compatible (including `null`, `false`, `0`, and `''`); captures contain only strings/string arrays.

`Selection<T>` is `{ readonly files: readonly string[]; readonly exclude?: readonly string[]; readonly scope?: ScopeSelector<T> }`. `context.select<T>(selection)` returns `Promise<readonly ScopeSubject<T>[]>`. A scope subject adds `kind: 'scope'` and `filepath` to its match. Custom `select` returns flattened scope subjects, not group subjects.

This complete example selects owner annotations from two disjoint trees, gates asynchronously, and explains applicability. Adapt the policy and datasets together:

```ts
import { Rule, pass, test, violation } from '@alex-dbs/coderuler';
import type {
  Evaluator, PredicateResult, ProjectContext, ScopeSelector,
  ScopeSubject, SelectionContext,
} from '@alex-dbs/coderuler';

const owners: ScopeSelector<string> = ({ source }) =>
  source.split('\n').flatMap((line, index) => {
    const owner = /^# owner: (\S+)\s*$/.exec(line)?.[1];
    return owner === undefined ? [] : [{
      id: `owner:${index + 1}`, source: line, data: owner,
      lines: { start: index + 1, end: index + 1 },
    }];
  });

export default class AssignedOwner extends Rule<string> {
  files = ['src/**/*.txt'];
  scope = owners;

  async when({ project }: ProjectContext): Promise<PredicateResult> {
    return { applies: await project.hasFiles('package.json'), reason: 'Package projects only' };
  }

  async select(context: SelectionContext): Promise<readonly ScopeSubject<string>[]> {
    const source = await context.select({ files: this.files, exclude: this.exclude, scope: this.scope });
    const docs = await context.select({ files: ['docs/**/*.md'], scope: this.scope });
    return [...source, ...docs];
  }

  filter({ data }: ScopeSubject<string>): PredicateResult {
    return { applies: typeof data === 'string' && data !== 'generated', reason: 'Human-owned annotations only' };
  }

  check: Evaluator<string> = subject => {
    const owner = (subject as ScopeSubject<string>).data!;
    return owner === 'unassigned' ? violation('Assign a responsible team') : pass();
  };
}

export const tests = [
  test('an unassigned annotation violates').withFiles({
    'package.json': {}, 'src/job.txt': '# owner: unassigned',
  }).violates(),
  test('a named docs owner passes').withFiles({
    'package.json': {}, 'docs/job.md': '# owner: platform',
  }).passes(),
];
```

The cast trusts this rule's default scope grouping and filter; revisit it when changing either. Preserve identity when transforming built-in subjects (`{ ...subject, ...changes }`). Every returned `(filepath, id)` must be unique within the rule; overlapping selections need an explicit identity strategy. Attribute synthetic scopes to a real eligible root-relative filepath. Custom selection still respects CLI target and reserved-path boundaries; use grouping for multi-file decisions rather than invented paths, hidden subjects, or fallback passes.

Selection excludes symlinks and directories named `.git`, `node_modules`, `.coderuler`, or `old`, plus root-only `dist`/`coverage`; explicit targets inside them error. Nested generated directories and regular files bearing reserved directory names remain eligible.

## Grouping and custom checks

`Grouping = 'scope' | 'file' | 'folder' | 'project' | { readonly by: 'folder'; readonly level: number }`.

- `'scope'`: one scope per invocation; `'file'`: one group per filepath.
- `'folder'`: containing folder (level 0); `{ by: 'folder', level }` requires a nonpositive integer; negative levels climb, clamping at `.`.
- `'project'`: one group at root `.`. Empty groups are never evaluated; member order is preserved.

Declare `group: Grouping = 'folder'` with `import type { Grouping } from '@alex-dbs/coderuler'` to retain the union type. One group produces exactly one decision; choose the smallest group containing the comparison's evidence.

Grouping helps you to evaluate scopes together. For instance, grouping per folder means that ALL scopes selected for that folder will be evaluated together. A grouping per project means that ALL scopes will be evaluated together ONCE for the project. An example could be to check that `id` in all JSON files of the project, are UNIQUE on the project.

`Subject<T> = ScopeSubject<T> | GroupSubject<T>`. Narrow with `subject.kind`; this evaluator enforces unique selected IDs across group files:

```ts
import { pass, violation } from '@alex-dbs/coderuler';
import type { Evaluator } from '@alex-dbs/coderuler';
// GroupSubject<T>: { readonly kind: 'group';
//   readonly group: { readonly type: 'file' | 'folder' | 'project'; readonly path: string };
//   readonly members: readonly ScopeSubject<T>[] }
// Evaluator<T>: (subject: Subject<T>, context: CheckContext<T>) => Awaitable<CheckResult>

const uniqueIds: Evaluator = subject => {
  const members = subject.kind === 'group' ? subject.members : [subject];
  const ids = new Set<string>();
  for (const { id, filepath } of members) {
    if (ids.has(id)) {
      return violation(`Duplicate scope ID: ${id}`, [{ filepath, scopeId: id }]);
    }
    ids.add(id);
  }
  return pass();
};
```

Custom checks return `CheckResult`; `pass(): CheckResult` and `violation(message: string, locations?: readonly ViolationLocation[]): CheckResult` are convenience helpers.

```ts
interface ViolationLocation {
  readonly filepath: string;
  readonly scopeId?: string;
  readonly lines?: { readonly start: number; readonly end: number };
}

interface CheckResult {
  readonly status: 'pass' | 'violation';
  readonly message?: string;
  readonly locations?: readonly ViolationLocation[];
  readonly probability?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly usage?: AiUsage;
}
```

`locations` is allowed only for violations. Attribute only offending evaluated scopes or group members: use their `filepath` and `id` as `scopeId`, as above, rather than naming unrelated files. Each location requires a nonempty filepath and either a nonempty `scopeId`, `lines`, or both. A scope ID resolves that member's source lines when available.

Explicit `lines` are absolute file coordinates: positive safe integers with inclusive `start <= end`. Use a narrower subrange within the member's known lines; file-only locations must fit a member's range for that file. When the selected member has no line information, explicit lines may supply it.

With `locations` omitted, a scope violation uses its own source lines; a group violation does **not** automatically blame all members. Explicit `locations: []` disables automatic scope attribution. Without usable source lines (or a matching current PR diff anchor), `--auto-comment` reports the finding in an ordinary PR comment instead of guessing an inline location.

Set `comment` on the rule to replace each generated GitHub finding body with your Markdown. Omit it to keep the generated body. CodeRuler strips terminal controls and redacts credentials from overrides. Inline locations and check results stay unchanged. The fallback comment keeps its shared `CodeRuler violations` heading.

Scalar AI classification supplies no offending-member attribution: scope AI can use its subject's lines, but grouped AI needs explicit locations from a custom check wrapping `context.ai(...)`; otherwise it uses the fallback comment.

Results validate; supplied messages survive reporting. Violations without a message report rule/location without generated text. Return real probability/model/threshold metadata only; supplied probability/threshold must be finite in `[0, 1]`. Throw for execution errors. External libraries/providers may be called directly; no backend registry is required.

### Context helpers


| Context                                                | Available members                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `ProjectContext`                                       | `readonly project: Project`; `trace(message: string, details?: JsonValue): void`. |
| `SelectionContext extends ProjectContext`              | `select<T>(selection: Selection<T>): Promise<readonly ScopeSubject<T>[]>`.        |
| `CheckContext<T = JsonValue> extends SelectionContext` | `readonly ruleName: string`; `ai(options: AiOptions<T>): Promise<CheckResult>`.   |


Use `trace` for decision evidence visible during inspection; keep normal execution free of ad-hoc console output. AI/regex projection callbacks receive only `ProjectContext`, not the full check context.

## Regex: matching means passing

`regex<T = JsonValue>(options: RegexOptions<T>): Evaluator<T>` takes `{ readonly pattern: RegExp; readonly violationMessage?: string; readonly input?: (subject: ScopeSubject<T>, context: ProjectContext) => Awaitable<string> }`.

```ts
import { Rule, regex, test } from '@alex-dbs/coderuler';

export default class InternalUrl extends Rule {
  files = ['config/*.txt'];
  check = regex({ pattern: /^\/internal\//, violationMessage: 'Use an /internal/ URL' });
}
export const tests = [
  test('internal URL passes').withFiles({ 'config/url.txt': '/internal/jobs' }).passes(),
  test('public URL violates').withFiles({ 'config/url.txt': '/public/jobs' }).violates(),
];
```

Default input is `String(data)` for scalar/null data, otherwise source text. `input` replaces this **per scope member**, even for groups; every member must match for the group to pass. Regex automatically returns locations for the failing members only, using each member's filepath and scope ID. The pattern is cloned and `lastIndex` reset for deterministic `/g`/`/y` behavior. Good: express the allowed pattern. Bad: use a forbidden-pattern regex expecting matches to violate. Regex needs no provider/key and adds no AI metadata.

## AI options, examples, and settings

`ai<T = JsonValue>(options: AiOptions<T>): Evaluator<T>` accepts:

- `rule: string`: nonempty semantic policy; include exceptions and what visible evidence permits a violation.
- `examples?: { readonly good?: readonly string[]; readonly bad?: readonly string[] }`: conditioning examples, dense arrays of nonempty strings; omitted/empty lists are valid.
- `violationMessage?: string`: nonempty reporting-only message, not sent as instructions.
- `input?: (subject: Subject<T>, context: ProjectContext) => Awaitable<JsonValue>`: replace the default projection; output validates as JSON-compatible.

```ts
import { Rule, ai, test } from '@alex-dbs/coderuler';
import type { RuleSettings } from '@alex-dbs/coderuler';

export default class ActionableInstructions extends Rule {
  files = ['guides/**/*.md'];
  settings: RuleSettings = { model: 'jev-latest', threshold: 0.5 };
  check = ai({
    rule: 'Instructions name a concrete action and its observable completion condition.',
    examples: { good: ['Run the migration until it exits successfully.'], bad: ['Handle the migration.'] },
    violationMessage: 'Name the action and how to recognize completion',
  });
}
export const aiTests = [
  test('an independent concrete instruction passes').withFiles({
    'guides/cache.md': 'Delete the cache directory; finish when it no longer exists.',
  }).passes(),
];
```

`examples` condition the model; `aiTests` assert outcomes on independent datasets. Ordinary `tests` are offline; live `aiTests` require explicit AI opt-in as described in [SKILL.md](SKILL.md). Keep deterministic applicability out of the prompt.

Default AI input is `{ filepath, scope: { id, data, captures? } }` when data exists, or `{ filepath, scope: { id, source, captures? } }` otherwise. Data presence includes `null`, `false`, `0`, and `''`. Groups become `{ files: [{ filepath, scopes: [...] }] }`. Good: select enough context to judge meaning, or project a deliberate JSON input. Bad: expect source text alongside structured data without providing it via `input`.

Inside a custom check, `return context.ai({ rule: '...' })` evaluates its current subject with effective settings and preserves AI result metadata. Replacing that result requires intentionally preserving probability/model/threshold metadata; token accounting is automatic across all `context.ai` calls, even when returning a different result. `ai(...)` validates options when constructed but performs no loading-time network I/O.

`RuleSettings` supports backend `'jev'`, model (default `'jev-latest'`), finite threshold in `[0, 1]` (default `0.4`), and finite nonnegative `inputCostPerMillion` / `outputCostPerMillion` prices (USD per million tokens; defaults `0.042` / `0`). Threshold precedence is CLI override → rule setting → `RK_THRESHOLD` → default; backend/model use rule setting → environment (`RK_BACKEND` / `TYPESAFE_DEFAULT_MODEL`) → default. AI passes only when probability is **strictly greater** than threshold; equality violates. Results include the effective threshold. Provider environment/key resolution is lazy at the first AI call; deterministic/skipped/filtered paths need no key. Live calls require `TYPESAFE_API_KEY`; use release configuration guidance for transport setup.

Inspection reports per-verification `usage: AiUsage` and a final recap: `calls`, `unreportedCalls`, `inputTokens`, `outputTokens`, `inputCost`, and `outputCost` (USD). Counts come from provider responses; missing counts remain unreported and totals cover reported calls only. Configure prices through rule settings or `RK_INPUT_COST_PER_MILLION` / `RK_OUTPUT_COST_PER_MILLION`; inspect flags `--input-cost-per-million` / `--output-cost-per-million` override both. Prices change estimates, not decisions.

AI rules, under the hood, are using TypeSafe Jev model and `noul` question (yes/no probabilistc answer). The rule must clearly explain what is checked. A global/generic rule won't match. A dedicated rule will perform better. The example bellow will check a particular usage of go slice `append` function.

```
import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';

export default class GoAppendSlice extends Rule {
  files = ['**/*.go'];

  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        kind: 'for_statement',
        stopBy: 'end',
        has: {
          pattern: 'append($SLICE,$$$ARGS)',
          stopBy: 'end',
        },
      },
    },
  });

  check = ai({
    rule: `A slice freshly allocated for a loop whose final element count is exactly known must be allocated at that final length and filled by index or with copy;
growing it with append is a violation even when capacity was preallocated with make([]T, 0, n)
and even when it was first created with make([]T, n) and then reset to length zero.

Append in a loop is valid only when the final count is not known before the loop,
such as elements appended under a condition so the count varies within an upper bound that capacity merely reserves,
or when the slice already holds a deliberately assigned prefix written before the loop.

Appending after a length that was allocated but never assigned,
or assigning elements by index and also appending them, is a violation.`,
    examples: {
      good: [/* Some examples, not shown here to keep it short*/],
      bad: [/* Some examples, not shown here to keep it short*/],
    },
  });
}
```

## Project readers

Public signatures (import `Project`, `CsvOptions`, `CsvRow`, and `JsonValue` as types from `@alex-dbs/coderuler`):

```ts
interface Project {
  readonly root: string;
  glob(patterns: string | readonly string[]): Promise<readonly string[]>;
  hasFiles(patterns: string | readonly string[]): Promise<boolean>;
  stat(path: string): Promise<{ readonly kind: 'file' | 'directory' } | undefined>;
  readText(path: string): Promise<string>;
  readJson(path: string): Promise<JsonValue>;
  readYaml(path: string): Promise<readonly JsonValue[]>;
  readCsv(path: string, options?: CsvOptions): Promise<readonly CsvRow[]>;
}
// CsvOptions: { readonly headers?: boolean; readonly delimiter?: string; readonly key?: string }
// CsvRow: Readonly<Record<string, string>> | readonly string[]
```

Use `glob` for existing eligible files in lexical order (`[]` when none), `hasFiles` for existence by glob, and `stat` for a file/directory distinction (`undefined` only for ENOENT). Globs use `node:path.matchesGlob` semantics; exclusion wins. `readText` decodes strict UTF-8; structured readers use the selectors' strict parsing, with YAML returning one value per nonempty document and CSV returning records/arrays according to `headers`. CSV reader `key` shares option validation but does not add IDs or enforce key-column uniqueness; that is selector behavior.

The project root is invocation cwd for `check`/`validate`, and resolved `[folder]` for `inspect`; an absolute/sibling inspected folder is its own root. Reader paths are root-relative with `/` separators; absolute paths, `..` escapes, and symlink traversal are rejected. Reads require real files and throw on missing/unreadable/invalid input. Good: gate optional projects with `hasFiles`/`stat`. Bad: catch a read/parse error and treat it as empty input or a pass. Source text is cached per run; parsed values are per-use, so mutating one parse cannot alter another rule's view.