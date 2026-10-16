# The `ast-grep` selector

Use `format: ast-grep` when the decision unit is a syntactic node and the rule needs a real parse tree,
not text. The plugin runs the actual `@ast-grep/napi`, so a pattern that cannot compile fails before any
file is read.

## Options

| Option | Required | Meaning |
| --- | --- | --- |
| `language` | yes | The target language, case-insensitive, with aliases. |
| `rule` | yes | The native ast-grep structural selector — the query that picks nodes. |
| `constraints` | no | Native ast-grep constraints (a mapping). |
| `utils` | no | Native ast-grep utils (a mapping). |

`scope.rule` is **not** the policy. The check's `rule` is the natural-language statement; `scope.rule`
is the structural query. Confusing the two is the single most common authoring mistake.

## Languages

31 official languages are bundled, no host setup required. Names are lowercase and case-insensitive;
`cpp`, `csharp`, `glimmer-javascript`, and `glimmer-typescript` use those exact names. Conventional
aliases also work: `cc`/`c++`/`cxx`, `cs`, `ex`, `golang`, `hs`, `kt`, `md`, `py`, `rb`, `rs`, `yml`,
`js`/`jsx`, and `ts`. Not bundled: HCL, Nix, Solidity, and Zig — a host must register a native grammar
for those before the first dynamic rule compiles, and YAML cannot load arbitrary packages.

## Scopes, captures, and identity

- `source` is the exact text of each matched node.
- `data` is omitted — a syntax node has no JSON view. Filter on `source` and `captures` instead, and a
  `kind: regex` check tests `source`, since the scope carries no scalar `data`.
- `captures` holds the pattern's named metavariables without the `$` (a `$$$` capture is an array).
  Anonymous `$_`/`$$$` and captures the match does not bind are omitted; a match with no captures gets
  `captures: {}`.
- `lines` is the absolute 1-based inclusive node range.
- Identity is the kind plus enclosing named declarations plus the node's own name — a Go method also
  includes its receiver, so same-named methods on different types stay distinct. Source positions
  never contribute, so inserting lines above a declaration does not re-identify it. A legal overload
  repeats an identity, so the repeat takes a `#N` suffix in document order (`add`, `add#1`).

## The native DSL

`scope.rule` accepts the ast-grep rule object: composite operators `all`, `any`, `not`, and relational
operators such as `has`, `inside`, `precedes`, `follows`, each with `stopBy` (`neighbor`, `end`,
`rule`) where it helps. Atomic matchers include `kind`, `pattern`, `regex`, and `nthChild`;
`matches` references a named rule in `scope.utils`. Use `field` inside a `has` or `inside` relation
to constrain its child field. Put metavariable constraints in the sibling `scope.constraints`,
not inside `scope.rule`. Patterns use `$NAME` for one node and `$$$NAME` for a list; the native
compiler validates the selector.

Keep the selector as narrow as the policy allows, but remember it only *finds candidates*: the model
judges whether a candidate complies. Do not try to encode the whole verdict in the selector.

## The filter root

There is no `data`, so a filter addresses the wrapper's `source` and `captures`:

```yaml
filter:
  all:
    - non_empty: $.captures.ARGS
    - non_empty: $.captures.SLICE
```

## Complete example

Select Go functions or methods that call `append` inside a loop, and require a slice whose output
count is known to be built at its final length and filled by index or copy, rather than grown with
`append` (the file here would be `go-slice-append.yaml`).

```yaml
version: 'v1'
files:
  included:
    - '**/*.go'
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
        pattern: 'append($SLICE,$$$ARGS)'
        stopBy: end
check:
  rule: A slice freshly allocated for a loop whose final element count is exactly known must be allocated at that final length and filled by index or with copy; growing it with append is a violation even when capacity was preallocated with make([]T, 0, n) and even when it was first created with make([]T, n) and then reset to length zero. Append in a loop is valid only when the final count is not known before the loop, such as elements appended under a condition so the count varies within an upper bound that capacity merely reserves, or when the slice already holds a deliberately assigned prefix written before the loop. Appending after a length that was allocated but never assigned, or assigning elements by index and also appending them, is a violation.
  examples:
    good:
      - |
        func copyItems(values []string) []string {
            out := make([]string, len(values))
            for i := range values {
                out[i] = values[i]
            }
            return out
        }
      - |
        func filterScores(scores []int) []int {
            out := make([]int, 0, len(scores))
            for _, score := range scores {
                if score > 0 {
                    out = append(out, score)
                }
            }
            return out
        }
      - |
        func withHeader(header string, values []string) []string {
            out := make([]string, 1)
            out[0] = header
            for _, value := range values {
                out = append(out, value)
            }
            return out
        }
    bad:
      - |
        func growScores(scores []int) []int {
            out := make([]int, 0, len(scores))
            for _, score := range scores {
                out = append(out, score)
            }
            return out
        }
      - |
        func addTags(tags []string) []string {
            out := make([]string, len(tags))
            for _, tag := range tags {
                out = append(out, tag)
            }
            return out
        }
      - |
        func mergeScores(scores []int) []int {
            out := make([]int, len(scores))
            for i, score := range scores {
                out[i] = score
                out = append(out, score)
            }
            return out
        }
      - |
        func reuseBuffer(values []string) []string {
            out := make([]string, len(values))
            out = out[:0]
            for _, value := range values {
                out = append(out, value)
            }
            return out
        }
  violation-message: A slice built inside a loop with a known element count must be allocated at its final length and filled by index or with copy, not grown with append.
```

The verdict turns on the output cardinality, not merely on the starting length. `copyItems` sets the
final length up front and fills it by index (`append` is not even needed); `filterScores` appends into
a zero-length slice whose final count is not known before the loop, so the reserved capacity is an
upper bound, not the exact size; `withHeader` deliberately populates an intentional prefix before
appending. `growScores` is the exact negative — one result per input, yet rebuilt by `append` into a
zero-length slice — so it is a violation even though `make([]int, 0, len(scores))` reserves the
capacity. `addTags` leaves the `len(tags)` zero strings in place and appends after them; `mergeScores`
assigns by index and also appends, duplicating values; `reuseBuffer` resets a fresh `make(len)` to
`[:0]` and then appends, which is the same known-size rebuild as `growScores`. The policy states these
distinctions so the reviewer does not guess, and the selector stays deliberately broad (`any` function
with an `append` in a loop) because correctness is the policy's job, not the selector's.

## Notes

- Native patterns are validated by probing the parser at compile time, so a bad pattern or an ast-grep
  `regex` matcher inside `scope.rule` throws before matching rather than silently selecting nothing.
  That matcher is unrelated to a `check.kind: regex` check.
- The ast-grep rule object is per-scope, not per-file; one scope is one matched node.
- A rule that needs the *whole file* as one unit should select a single file-level node (for example
  the source-file root) or use a different selector, since one ast-grep scope is one node.
