---
title: Configuration
description: Rule locations, member defaults, grouping, and file selection boundaries.
section: Reference
order: 9
---

# Configuration

Configure each rule through its class members. Select rule files through the CLI. AI defaults also accept [environment variables](/docs/ai-checks/).

## Rule locations and names

Discovery searches the project's `.rulekeeper/` first, then `~/.rulekeeper/`. Rules can live directly in either directory or in subfolders. Supported suffixes are `.rule.ts`, `.rule.mts`, `.rule.js`, and `.rule.mjs`.

The filename supplies the name. For example, `policies/internal-url.rule.ts` is named `internal-url`. Names must be unique across selected files and discovery roots.

Discovery does not follow symlinks. It skips `old`, `node_modules`, and RuleKeeper's temporary installation directories. Ordinary hidden rule folders are not excluded merely because their names start with a dot.

Use `validate <rule-path>`, `test <rule-path>`, or `check --rules <path>` to replace discovery with an explicit module or directory. `inspect` takes one module path or exact discovered name, not a rule directory.

## Rule members

| Member | Default | Purpose |
| --- | --- | --- |
| `enabled: boolean` | `true` | Disable evaluation without bypassing structural validation |
| `files: readonly string[]` | `['**/*']` | Nonempty root-relative glob list |
| `exclude: readonly string[]` | `[]` | Remove matching paths, even if included by `files` |
| `tags?: readonly string[]` | Absent | Labels used by `check --tags` and `--exclude-tags` |
| `scope?: ScopeSelector<T>` | Absent | Select parts of a file instead of its whole source |
| `settings: RuleSettings` | `{}` | AI backend, model, threshold, and token prices |
| `group: Grouping` | `'scope'` | Decide which scopes a check sees together |
| `comment?: string` | Absent | Nonblank Markdown override for GitHub finding bodies |
| `when(context)` | Returns `true` | Whole-rule applicability before file selection |
| `select(context)` | Built-in selection | Return selected scope subjects |
| `filter(subject, context)` | Returns `true` | Per-scope applicability before grouping |
| `check: Evaluator<T>` | Required | Decide pass or violation |

Hooks and checks receive the rule instance as `this`. Additional class fields and methods are allowed. `check` must be a function-valued property rather than a method.

`when` and `filter` return `boolean` or `{ applies: boolean, reason?: string }`, directly or through a promise. A false result skips the rule or scope. Invalid results and thrown errors fail execution.

`files` and `exclude` must be dense arrays of nonempty strings, including on disabled rules. `tags`, when present, must be a dense array of nonempty strings. An empty `tags` array is valid.
Use class field syntax such as `tags = ['go', 'security'];`.

## File boundaries

Paths and globs are relative to the project root, with `/` separators. Globs use Node.js `path.matchesGlob` semantics. `exclude` always wins.

Target traversal excludes symbolic links and directories named `.git`, `node_modules`, `.rulekeeper`, or `old`. Root-level `dist` and `coverage` are also excluded. Nested `dist` and `coverage` directories and regular files with reserved directory names remain eligible.

An explicit target inside an excluded directory fails. Custom selectors and project readers cannot use parent escapes or symlink traversal to bypass these boundaries. Loaded rule modules are excluded from check targets.

For `check` and `validate`, run the command from the intended project root. A `check` target narrows files without redefining that root. For `inspect`, the resolved folder argument becomes the inspected root.

## Grouping

```ts
import type { Grouping } from '@alex-dbs/rulekeeper';

// Inside a Rule subclass:
group: Grouping = 'project';
```

| Value | One check receives |
| --- | --- |
| `'scope'` | One selected scope |
| `'file'` | All surviving scopes from one filepath |
| `'folder'` | All surviving scopes in the same containing folder |
| `{ by: 'folder', level: 0 }` | Same as `'folder'` |
| `{ by: 'folder', level: -1 }` | Scopes grouped one containing-folder level higher |
| `'project'` | All surviving scopes, with group path `.` |

Folder levels must be nonpositive integers. Negative levels climb toward the root and stop at `.`. Member order is preserved. Empty groups never reach the check.

Choose the smallest group with all evidence needed for the decision. A project-wide uniqueness policy needs a project group. A rule about one value needs only a scope.

Group checks receive `subject.kind === 'group'` and `subject.members`. One group produces one decision. Return explicit offending-member locations when you need precise findings.

## AI settings and GitHub comments

`RuleSettings` supports `backend: 'jev'`, `model`, `threshold`, `inputCostPerMillion`, and `outputCostPerMillion`. See [AI checks](/docs/ai-checks/) for defaults and precedence.

`comment` replaces the generated finding body during `check --diff --auto-comment` or `check --pr ... --auto-comment`. It does not change decisions or inline locations. Omit it to keep generated text. RuleKeeper strips terminal controls and redacts credentials from overrides.

The class contracts are defined in [rule.ts](https://github.com/alex-dbs/rulekeeper/blob/main/src/app/rule.ts). The [CLI reference](/docs/cli/) lists command-level options.
