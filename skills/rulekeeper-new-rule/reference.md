# Rule API reference

Read the branch needed for the rule; use [SKILL.md](SKILL.md) for the authoring, test, and inspection workflow. All imports below use the public `rulekeeper` SDK.

## Rule members and lifecycle

Default-export a constructible class extending `Rule<T>` (`T = JsonValue`). Extra class fields/methods are allowed; hooks and checks receive the rule instance as `this`.


| Member / signature                                                                      | Default    | Contract                                                                                                     |
| --------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `enabled: boolean`                                                                      | `true`     | `false` skips with reason `disabled`; structural validation still runs.                                      |
| `files: readonly string[]`                                                              | `['**/*']` | Nonempty root-relative glob list.                                                                            |
| `exclude: readonly string[]`                                                            | `[]`       | Root-relative globs; exclusion wins.                                                                         |
| `scope?: ScopeSelector<T>`                                                              | Absent     | One whole-file scope per eligible file unless supplied.                                                      |
| `settings: RuleSettings` | `{}` | Optional backend, model, threshold, and input/output USD-per-million token prices; see AI below. |
| `group: Grouping`                                                                       | `'scope'`  | Groups surviving scopes before evaluation.                                                                   |
| `when(context: ProjectContext): Awaitable<PredicateResult>`                             | `true`     | Whole-rule applicability, once per enabled rule before parsing target sources.                               |
| `select(context: SelectionContext): Awaitable<readonly ScopeSubject<T>[]>`              | Delegates  | Calls `context.select({ files, exclude, scope })`; override for custom selection.                            |
| `filter(subject: ScopeSubject<T>, context: ProjectContext): Awaitable<PredicateResult>` | `true`     | Per-scope applicability before grouping.                                                                     |
| `check: Evaluator<T>`                                                                   | Required   | Function-valued property, such as `check = regex(...)` or `check: Evaluator<T> = ...`, rather than a method. |


Execution: validate all rules → enabled → when → select → validate subjects → filter → group → check → report. `Awaitable<T>` means `T | Promise<T>`. `files`/`exclude` must be dense arrays of nonempty strings, including on disabled rules.

`PredicateResult = boolean | { readonly applies: boolean; readonly reason?: string }`. Return `false` or `{ applies: false, reason }` only for inapplicable input; it is a skip, not a pass. Invalid returns and thrown errors are runtime errors. Put required-data validation and applicability in filters; let checks decide policy on those established preconditions. Generic selector types describe expected data; they do not validate the parsed shape.

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
| `scopes.protobuf<T>({ path? }?)`                                 | String `path` defaults to `$.rpcs[*]`. RPC data is `{ id, package, service, name, http: { bindings: [{ method, url }] } }`; paths may instead select its HTTP subtrees.                                                                                                                                                                                               |


JSON/YAML `path` addresses the document; `key` is a JSONPath evaluated against each selected value and must produce exactly one string or finite number. All structured paths are nonempty `$`-rooted JSONPath; executable expressions are rejected and evaluation errors propagate. Protobuf paths may select RPC records or their `http`/`bindings`/`method`/`url` subtrees only; forbidden selections error even without RPCs.

Omitted/`undefined` options retain defaults; explicit `null` is invalid for structured paths and CSV headers/delimiters. A CSV delimiter is one Unicode code point other than CR, LF, or a quote; CSV scopes preserve exact record source slices with multibyte delimiters too.

### AST and TypeScript/TSX

Choose a language matching the source; common JavaScript/TypeScript, markup, and bundled language grammars are supported, with case-insensitive names/aliases and lazy bundled registration. Use the installed release's language documentation when selecting a less common grammar.

`language: 'typescript'` (alias `'ts'`) uses TSX for `.tsx`, TypeScript otherwise (including `.ts`, `.mts`, `.cts`). Explicit `'tsx'` always uses TSX. Both TypeScript query variants validate eagerly; a TypeScript-only kind needs a TSX-compatible replacement:

```ts
import { scopes } from 'rulekeeper';

const assertions = scopes.astGrep({
  language: 'typescript',
  rule: { any: [{ kind: 'as_expression' }, { kind: 'type_assertion' }] },
  tsx: { rule: { kind: 'as_expression' } },
});
```

`tsx: { rule, constraints?, utils? }` is valid only with TypeScript selection and replaces the **complete** query; repeat any needed constraints/utilities. Captures follow the selected query: metavariables provide strings or string arrays, and supported named declarations/Go receivers provide identity captures. Good: query syntax with AST structure. Bad: infer code semantics from line-oriented regular expressions or assume `tsx` merges options.

## Custom scope, selection, and filters

The public shapes are:

```ts
import type { Awaitable, JsonValue, SourceFile, ScopeMatch } from 'rulekeeper';

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
import { Rule, pass, test, violation } from 'rulekeeper';
import type {
  Evaluator, PredicateResult, ProjectContext, ScopeSelector,
  ScopeSubject, SelectionContext,
} from 'rulekeeper';

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

Selection excludes symlinks and directories named `.git`, `node_modules`, `.rulekeeper`, or `old`, plus root-only `dist`/`coverage`; explicit targets inside them error. Nested generated directories and regular files bearing reserved directory names remain eligible.

## Grouping and custom checks

`Grouping = 'scope' | 'file' | 'folder' | 'project' | { readonly by: 'folder'; readonly level: number }`.

- `'scope'`: one scope per invocation; `'file'`: one group per filepath.
- `'folder'`: containing folder (level 0); `{ by: 'folder', level }` requires a nonpositive integer; negative levels climb, clamping at `.`.
- `'project'`: one group at root `.`. Empty groups are never evaluated; member order is preserved.

Declare `group: Grouping = 'folder'` with `import type { Grouping } from 'rulekeeper'` to retain the union type. One group produces exactly one decision; choose the smallest group containing the comparison's evidence.

Grouping helps you to evaluate scopes together. For instance, grouping per folder means that ALL scopes selected for that folder will be evaluated together. A grouping per project means that ALL scopes will be evaluated together ONCE for the project. An example could be to check that `id` in all JSON files of the project, are UNIQUE on the project.

`Subject<T> = ScopeSubject<T> | GroupSubject<T>`. Narrow with `subject.kind`; this evaluator enforces unique selected IDs across group files:

```ts
import { pass, violation } from 'rulekeeper';
import type { Evaluator } from 'rulekeeper';
// GroupSubject<T>: { readonly kind: 'group';
//   readonly group: { readonly type: 'file' | 'folder' | 'project'; readonly path: string };
//   readonly members: readonly ScopeSubject<T>[] }
// Evaluator<T>: (subject: Subject<T>, context: CheckContext<T>) => Awaitable<CheckResult>

const uniqueIds: Evaluator = subject => {
  const members = subject.kind === 'group' ? subject.members : [subject];
  const ids = new Set<string>();
  for (const { id } of members) {
    if (ids.has(id)) return violation(`Duplicate scope ID: ${id}`);
    ids.add(id);
  }
  return pass();
};
```

A custom result is `{ status: 'pass' | 'violation', message?: string, probability?: number, threshold?: number, model?: string, usage?: AiUsage }`; `pass(): CheckResult` and `violation(message: string): CheckResult` are convenience helpers. Results validate; supplied messages survive reporting. Violations without a message report rule/location without generated text. Return real probability/model/threshold metadata only; supplied probability/threshold must be finite in `[0, 1]`. Throw for execution errors. External libraries/providers may be called directly; no backend registry is required.

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
import { Rule, regex, test } from 'rulekeeper';

export default class InternalUrl extends Rule {
  files = ['config/*.txt'];
  check = regex({ pattern: /^\/internal\//, violationMessage: 'Use an /internal/ URL' });
}
export const tests = [
  test('internal URL passes').withFiles({ 'config/url.txt': '/internal/jobs' }).passes(),
  test('public URL violates').withFiles({ 'config/url.txt': '/public/jobs' }).violates(),
];
```

Default input is `String(data)` for scalar/null data, otherwise source text. `input` replaces this **per scope member**, even for groups; every member must match for the group to pass. The pattern is cloned and `lastIndex` reset for deterministic `/g`/`/y` behavior. Good: express the allowed pattern. Bad: use a forbidden-pattern regex expecting matches to violate. Regex needs no provider/key and adds no AI metadata.

## AI options, examples, and settings

`ai<T = JsonValue>(options: AiOptions<T>): Evaluator<T>` accepts:

- `rule: string`: nonempty semantic policy; include exceptions and what visible evidence permits a violation.
- `examples?: { readonly good?: readonly string[]; readonly bad?: readonly string[] }`: conditioning examples, dense arrays of nonempty strings; omitted/empty lists are valid.
- `violationMessage?: string`: nonempty reporting-only message, not sent as instructions.
- `input?: (subject: Subject<T>, context: ProjectContext) => Awaitable<JsonValue>`: replace the default projection; output validates as JSON-compatible.

```ts
import { Rule, ai, test } from 'rulekeeper';
import type { RuleSettings } from 'rulekeeper';

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
import { Rule, ai, scopes, test } from 'rulekeeper';

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

Public signatures (import `Project`, `CsvOptions`, `CsvRow`, and `JsonValue` as types from `rulekeeper`):

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