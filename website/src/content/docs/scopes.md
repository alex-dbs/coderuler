---
title: Scopes and selectors
description: Select whole files, structured values, syntax nodes, or custom source regions.
section: Build rules
order: 5
---

# Scopes and selectors

A selector turns one source file into zero or more scopes. A scope has a stable ID, source text, optional parsed data, and optional source lines.

Import `scopes` from `@alex-dbs/rulekeeper`. Assign a selector to the rule's `scope` property. The signatures below show accepted options. Type parameters describe expected data, not runtime validation.

## Whole files

```ts
scope = scopes.file();
```

`scopes.file()` accepts no options. It selects one data-free scope with ID `$` per file. An empty file still has a scope with lines `1–1`. Omitting `scope` also selects whole files.

## JSON

```ts
scope = scopes.json<{ id: string }>({ path: '$.items[*]', key: '$.id' });
```

Signature: `scopes.json<T>({ path?: string, key?: string }?)`.

`path` defaults to `$`, the document root. Each matched value becomes `data`. Without `key`, IDs use RFC 6901 JSON pointers. A JSON pointer identifies a value by its document path. The root ID is `$`. `key` runs against each selected value and must yield exactly one string or finite number.

JSON parsing rejects comments, trailing commas, empty input, duplicate keys, and nonfinite numbers. A selector generic does not make malformed data valid. Use a filter to establish the shape needed by the check.

## YAML

```ts
scope = scopes.yaml<{ replicas: number }>({ path: '$.spec' });
```

Signature: `scopes.yaml<T>({ path?: string, key?: string }?)`.

YAML uses the same path and key options as JSON. It selects each nonempty document in source order. IDs use `<doc-index>:<pointer-or-key>`. Empty or comment-only documents are omitted without renumbering the remaining document indices.

Aliases and merge keys resolve with a bounded alias count. A file can produce several scopes from several documents.

## CSV

```ts
scope = scopes.csv({ headers: true, delimiter: ',', key: 'id' });
```

Signature: `scopes.csv({ headers?: boolean, delimiter?: string, key?: string }?)`.

Defaults are `headers: true` and `delimiter: ','`. Header mode returns string records. With `headers: false`, each row is a string array.

The default ID is `row:<n>`, where `n` is the 1-based data-record number. `key` uses a column value instead. It requires headers, an existing column, and nonblank unique values.

The parser supports quoted values, multiline records, BOM, and line-ending variants. Record widths must agree. A delimiter is one Unicode code point other than a carriage return, a line feed, or a quote. Each scope preserves its exact record source text.

## Protobuf

```ts
scope = scopes.protobuf({ path: '$.rpcs[*].http.bindings[*].url' });
```

Signature: `scopes.protobuf<T>({ path?: string }?)`.

The default path is `$.rpcs[*]`. An RPC record has this shape:

```ts
{
  id,
  package,
  service,
  name,
  http: { bindings: [{ method, url }] }
}
```

Paths can select RPC records or their `http`, `bindings`, `method`, and `url` subtrees. Selecting an existing node outside these subtrees fails. Paths with no matches return no scopes. An RPC-free file does not prove that the path selects a supported subtree.

## Code syntax with ast-grep

An abstract syntax tree, or AST, represents code structure. `astGrep` selects syntax nodes rather than lines that resemble code.

```ts
scope = scopes.astGrep({
  language: 'typescript',
  rule: { pattern: 'console.log($$$ARGS)' },
});
```

Signature: `scopes.astGrep({ language, rule, constraints?, utils?, tsx? })`.

`language` is required. `rule` is a native ast-grep query. `constraints` restrict metavariable matches, and `utils` supplies reusable query definitions. Queries validate when the selector is constructed.

Results contain source, captures, and line spans, not parsed `data`. `$NAME` captures one node. `$$$ARGS` captures zero or more nodes. Empty captures are omitted, so `ARGS` is absent for `console.log()`.

For TypeScript selection, `.tsx` files use TSX and other matching files use TypeScript. The `'ts'` alias also works. Explicit `'tsx'` always uses TSX. A `tsx` option replaces the entire query for TSX:

```ts
scope = scopes.astGrep({
  language: 'typescript',
  rule: { any: [{ kind: 'as_expression' }, { kind: 'type_assertion' }] },
  tsx: { rule: { kind: 'as_expression' } },
});
```

`tsx` is valid only with TypeScript selection. Its shape is `{ rule, constraints?, utils? }`. Repeat needed constraints and utilities because the override does not merge them.

Use the official [query reference](https://ast-grep.github.io/reference/rule) and [playground](https://ast-grep.github.io/playground.html) for node kinds and patterns. Relational queries use immediate neighbors by default. Add `stopBy: 'end'` when a search must reach deeper nodes.

## Structured path rules

JSON, YAML, and Protobuf paths use nonempty, `$`-rooted JSONPath. Executable expressions are rejected. Evaluation errors propagate instead of becoming empty results.

Omitted or `undefined` options keep defaults. Explicit `null` is invalid for structured paths and CSV headers or delimiters.

## Custom selectors

Use a custom selector when the built-in factories cannot select the required region:

```ts
import type { ScopeSelector } from '@alex-dbs/rulekeeper';

const owners: ScopeSelector<string> = ({ source }) =>
  source.split('\n').flatMap((line, index) => {
    const owner = /^# owner: (\S+)\s*$/.exec(line)?.[1];
    return owner === undefined ? [] : [{
      id: `owner:${index + 1}`,
      source: line,
      data: owner,
      lines: { start: index + 1, end: index + 1 },
    }];
  });
```

The public signature is:

```ts
type ScopeSelector<T> =
  (file: SourceFile) => Awaitable<readonly ScopeMatch<T>[]>;

interface SourceFile {
  readonly filepath: string;
  readonly source: string;
}

interface ScopeMatch<T> {
  readonly id: string;
  readonly source: string;
  readonly data?: T;
  readonly captures?: Readonly<Record<string, string | readonly string[]>>;
  readonly lines?: { readonly start: number; readonly end: number };
}
```

Return a dense array. `[]` means no matches. IDs must be nonempty and unique per filepath within the rule. Use actual source text and 1-based inclusive line spans. Data must be finite, acyclic, and JSON-compatible. `null`, `false`, `0`, and an empty string are valid data.

## Custom file selection

Override `select(context)` to combine selections. It returns `ScopeSubject<T>[]`, not grouped subjects:

```ts
async select(context: SelectionContext): Promise<readonly ScopeSubject<string>[]> {
  const source = await context.select({
    files: this.files, exclude: this.exclude, scope: this.scope,
  });
  const docs = await context.select({ files: ['docs/**/*.md'], scope: this.scope });
  return [...source, ...docs];
}
```

This method belongs in a `Rule<string>` subclass with an owner selector assigned to `scope`. Import `SelectionContext` and `ScopeSubject` as types. Avoid overlapping matches unless you preserve unique `(filepath, id)` pairs. Preserve fields when transforming built-in subjects.

Custom selection still respects the CLI target and reserved-path boundaries. Traversal excludes symlinks and directories named `.git`, `node_modules`, `.rulekeeper`, or `old`. It also excludes root-level `dist` and `coverage`. Explicit targets inside these directories fail. Nested `dist` and `coverage` directories remain eligible.

Read [grouping and defaults](/docs/configuration/) before comparing scopes. The full contracts live in the [author reference](https://github.com/alex-dbs/rulekeeper/blob/main/skills/rulekeeper-new-rule/reference.md#built-in-selectors).
