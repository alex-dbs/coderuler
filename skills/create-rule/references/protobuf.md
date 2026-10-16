# The `protobuf` selector

Use `format: protobuf` when the decision unit is an RPC declaration in a `.proto` file, or one field
of its HTTP annotation. The selector is a small token-based structural reader — source extraction, not
`protoc` validation — so it does not need imports or a compiled schema to run.

## Options

| Option | Required | Meaning |
| --- | --- | --- |
| `path` | yes | A non-executable JSONPath over the normalized root `{ rpcs: [...] }`. Select an RPC record (`$.rpcs[*]`) or an HTTP subtree below it (`…http`, `…http.bindings`, `…http.bindings[N]`, `…/method`, `…/url`). A path resolving to anything else is an error. |

## Selection levels

Two families of path are supported. The first selects whole RPC records; the second selects one part
of an RPC's `google.api.http` annotation:

| `path` | `data` is exactly | `source` is exactly |
| --- | --- | --- |
| `$.rpcs[*]` | the full record below | the `rpc …` statement or block |
| `$.rpcs[*].http` | `{ bindings: [ … ] }` | the merged `google.api.http` option statement(s), or the whole RPC when unannotated |
| `$.rpcs[*].http.bindings` | the bindings array | the same span as `…http` |
| `$.rpcs[*].http.bindings[N]` | one `{ method, url }` binding | the verb token through its URL literal, or the custom-binding declaration(s) |
| `$.rpcs[*].http.bindings[N].method` | the verb string | the verb token (`get`), or the `kind` string literal for a custom binding |
| `$.rpcs[*].http.bindings[N].url` | the URL string | the raw URL string literal(s) |

`data` is never a wrapper: a URL leaf's `data` is the bare URL string, so it carries no `method` and
no enclosing record. Selecting an existing node outside the supported shapes — `$`, `$.rpcs`
itself, or `$.rpcs[*].package` — throws at match time. A path matching nothing, including a missing
field or an out-of-range binding index, produces no scopes. Property-name projections (`~`) are
unsupported and throw rather than selecting the corresponding value.

## Record shape and IDs

Each RPC record's `data` is exactly:

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

`http.bindings` lists the primary `google.api.http` verb plus every nested `additional_bindings` and
custom `{ kind, path }` in source order; a custom kind keeps its declared spelling and lands in
`method`, its path in `url` (so a custom binding is `{ method: HEAD, url: /v1/billing/invoices }`).

A record's `id` is that `id` field. A subtree's `id` is the record id, a literal `:`, and the
RPC-relative JSON pointer of the selected node — for example
`acme.billing.v1.InvoiceService.GetInvoice:/http/bindings/1/url`. The RPC's own index is **not** part
of an id, so inserting an RPC above another does not renumber its ids; a binding index **is** its
flattened order, so inserting a binding ahead of another shifts the later leaves' ids.

## Change detection

Scope identity is the id; change detection pairs base and head scopes by id and deep-compares
`source`, `data`, and `captures`, so a subtree path changes review granularity as well as selection.

- A `…/url` leaf compares URL text alone. Swapping the verb on an unchanged URL is not a URL change
  and yields no review — select `…http.bindings[N]` (the binding object) when the rule also cares about
  the verb or kind.
- A package, service, or method rename changes the record id, so every leaf below it is a new id and
  is reviewed even where the URL text is untouched.
- Inserting or reordering a binding shifts later indices, which renumbers and re-reviews those leaves.
- An empty URL (`get: ""`) is still selected; a leaf path needs no `non_empty` filter.

## The filter root

Filter on the selected scope's `data`, and gate on the annotation the rule needs. An unannotated RPC
has an empty bindings list, but where it sits depends on the path: `$.rpcs[*]` exposes it at
`$.data.http.bindings`, while `$.rpcs[*].http` exposes it at `$.data.bindings`. The matching filter
drops those RPCs and keeps only bound methods:

```yaml
# for path: $.rpcs[*]
filter:
  non_empty: $.data.http.bindings
```

As with every selector, the filter decides relevance, not compliance — a bound URL that violates the
policy still reaches the provider. A `…http.bindings[*].url` leaf needs no filter at all.

## Complete example

Require plural resource segments in HTTP URLs, one scope per URL leaf; allow version segments, the
service prefix, and path parameters. The `good`/`bad` examples are raw URLs matching the scope's
`data`; `source` remains the quoted literal. The examples differ only in the resource segment.

```yaml
version: 'v1'
files:
  included:
    - proto/billing/**/*.proto
  excluded:
    - proto/billing/generated/**
scope:
  format: protobuf
  path: $.rpcs[*].http.bindings[*].url
check:
  rule: HTTP URL resource segments must use plural nouns, not operation names such as getInvoice or createPayment. Version segments, service prefixes such as billing, and path parameters such as {invoice_id} are allowed.
  examples:
    good:
      - /v1/billing/invoices/{invoice_id}
      - /v1/billing/invoices
      - /v1/billing/invoices/{invoice_id}/items
    bad:
      - /v1/billing/getInvoice/{invoice_id}
      - /v1/billing/createPayment
      - /v1/billing/invoice/{invoice_id}
  violation-message: HTTP URL resource segments must use plural nouns.
```

No `filter` is needed: an unannotated RPC contributes no URL leaf, so the leaf path selects only
actual URLs. Each surviving scope is `{ id, source, data, lines }` where `data` is the URL string,
`source` is its quoted literal, and `id` ends in `:/http/bindings/N/url`. When one RPC is one verdict
and the policy reads the whole annotation, select `$.rpcs[*]` instead and keep the
`non_empty: $.data.http.bindings` filter, as
[docs/rules/billing-http-url.yaml](../../../docs/rules/billing-http-url.yaml) does.

## Scope and limits

- The reader never resolves imports, types, or custom options; unknown declarations are tolerated.
- A leading UTF-8 BOM is whitespace, not a swallowed declaration; octal/hex string escapes are decoded
  as UTF-8 bytes, so `source` stays byte-faithful while `data` carries the decoded text. Adjacent
  string literals concatenate: the leaf's `source` covers the whole literal run and `data` is the
  joined, decoded value.
- The same annotation written as one option aggregate or spread across dotted statements
  (`option (google.api.http).get = …`) produces identical bindings.
- Malformed or truncated RPCs and unterminated strings or comments are errors.
- A rule about a `.proto` file's non-RPC and non-`http` structure (imports, message shapes, service
  options) is not expressible here: this plugin exposes only `{ rpcs }`, and every scope must be an RPC
  record or a node of its `http` annotation.
