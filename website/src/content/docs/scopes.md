---
title: Scopes and selectors
description: Select whole files, structured values, syntax nodes, or custom source regions.
section: Build rules
order: 5
---

# Scopes and selectors

A selector turns one source file into zero or more scopes. A scope has a stable ID, source text, optional parsed data, and optional source lines.

Import `scopes` from `@alex-dbs/coderuler`. Assign a selector to the rule's `scope` property. The signatures below show accepted options. Type parameters describe expected data, not runtime validation.

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
scope = scopes.protobuf({ path: "$.rpcs[*].options['corp.http.route'].*" });
```

Signature: `scopes.protobuf<T>({ path?: string }?)`. The default path is `$.rpcs[*]`.

The selector reads one file. It does not resolve imports or check types.

The document contains file `options` and these declaration lists:

```ts
type ProtoDeclaration = { id: string; name: string; parent: string | null; options: object };
type ProtoDocument = {
  options: object;
  services: ProtoDeclaration[]; rpcs: ProtoDeclaration[]; messages: ProtoDeclaration[];
  fields: ProtoDeclaration[]; oneofs: ProtoDeclaration[]; enums: ProtoDeclaration[];
  enumValues: ProtoDeclaration[]; extensions: ProtoDeclaration[];
};
```

Each declaration has `{ id, name, parent, options }`. `id` is fully qualified, `parent` is the enclosing declaration ID or `null`, and each list follows source order.

### Options

Options include built-in and custom values. Custom option names omit parentheses, so use bracket notation for dotted names:

```proto
rpc Close(Request) returns (Response) {
  option (corp.http.route) = {post: "/v3/accounts/:id/close"};
}
```

Select the `post` value with `$.rpcs[*].options['corp.http.route'].post`.

| Protobuf value | Data |
| --- | --- |
| `"a" "b"` | Concatenated string, `"ab"` |
| `true` | Boolean |
| `42`, `-1.5`, `1e3` | Number |
| `0x1F`, `017`, `9223372036854775807`, `inf` | Source text string |
| `ENUM_VALUE` | String |
| `{ ... }` | Object |
| `[ ... ]` | Array |

A field that occurs more than once becomes an array in source order; a single occurrence stays a plain value. Use `..` to reach both forms. Dotted names build nested objects. Extension and `Any` keys omit their brackets. JSONPath unions return matches in union order.

### Common paths

| Data | Path |
| --- | --- |
| HTTP URLs | `$.rpcs[*].options['google.api.http']..['get','put','post','delete','patch']` |
| Custom HTTP path | `$.rpcs[*].options['google.api.http']..custom.path` |
| Field validation | `$.fields[*].options['validate.rules']` |
| Deprecated RPCs | `$.rpcs[*].options.deprecated` |
| File Go package | `$.options.go_package` |

### IDs and source lines

Declaration IDs use these rules:

- A service is `Service`; an RPC is `Service.Rpc`.
- A top-level message or enum is `Name`; a nested one is `<enclosing message>.Name`.
- A field or oneof is `<message>.name`. Oneof fields use the message as their parent.
- An enum value is `<enum>.VALUE`.
- An extension is `<enclosing message>.name`, or `name` at file level.
- A group creates a message named as written and a lowercase field with the same parent.
- The package prefixes every ID, wherever the package statement appears.

Selected declarations use their `id`; a nested node uses `<id>:/<pointer suffix>`. Other nodes use their JSONPath pointer, and the root ID is `$`.

Source spans follow these rules:

- The root spans the whole file. A declaration starts at its first token and ends at `;` or `}`; an RPC includes a semicolon directly after its closing brace. A group message and field share the group statement span.
- A declaration name spans its name token. A group field's `name` span uses the written group name, though its data name is lowercase.
- An `options` span covers all its entries. A standalone entry runs from `option` through `;`; an inline entry runs from its first name through its value.
- A scalar spans its tokens, including a sign and all adjacent string tokens. A message node spans its literal delimiters and entries that touch it. Repeated values span their occurrence value spans; list occurrences include their brackets.
- A node without its own span uses the nearest ancestor span.

Malformed syntax fails selection with an error.

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
import type { ScopeSelector } from '@alex-dbs/coderuler';

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

Custom selection still respects the CLI target and reserved-path boundaries. Traversal excludes symlinks and directories named `.git`, `node_modules`, `.coderuler`, or `old`. It also excludes root-level `dist` and `coverage`. Explicit targets inside these directories fail. Nested `dist` and `coverage` directories remain eligible.

Read [grouping and defaults](/docs/configuration/) before comparing scopes. The full contracts live in the [author reference](https://github.com/alex-dbs/coderuler/blob/main/skills/coderuler-new-rule/reference.md#built-in-selectors).
