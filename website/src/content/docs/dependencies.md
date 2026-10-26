---
title: Rule dependencies
description: Add public npm packages to rules without changing application dependencies.
section: Build rules
order: 8
---

# Rule dependencies

Rules can use ordinary JavaScript or TypeScript imports. The `deps` commands manage public npm packages separately from application dependencies.

The default package directory is `.coderuler/` in the current project. Use `--global` for `~/.coderuler/`, or `--directory <path>` for another rule directory. These two options are mutually exclusive.

## Add or update a package

```sh
coderuler deps add bignumber.js@11.1.5
coderuler deps add bignumber.js@latest
```

`deps add` accepts package names, exact versions, ranges, and tags. It resolves the request, saves an exact direct version, and records the complete dependency graph in `coderuler.lock`.

To update a dependency, run `deps add` with the new version, range, or tag. A confirmation describes that command's committed versions, even if another command changes the lock before output appears.

Import the declared package in a rule as usual:

```ts
import BigNumber from 'bignumber.js';
```

## Remove or restore packages

```sh
coderuler deps remove bignumber.js
coderuler deps sync
```

`deps remove` accepts unversioned names of direct dependencies. `deps sync` applies the committed graph and refreshes SDK and dependency editor links. It does not choose newer versions.

If the lock is empty, sync removes packages owned by the managed installation. It does not leave the current managed packages unchanged. Commit the lock and run sync after checkout or after a dependency change.

## Files on disk

```text
.coderuler/
  .gitignore
  rules/
  coderuler.lock
  node_modules/
```

`coderuler.lock` contains exact direct versions and the resolved npm lockfile graph. `node_modules/` contains installed packages, not links to a shared package tree. The generated `.gitignore` keeps that directory out of Git.

The managed installation also supplies SDK/editor resolution. The loader prefers a project-local CodeRuler SDK when available, including SDK aliases in package imports. A global CLI installation does not require an application-local SDK dependency.

Do not edit the installed package tree or hand-replace graph entries. Use the `deps` commands and commit their lockfile changes. A graph or integrity mismatch is an error, not a request to accept whatever is installed.

For CI installation, see [CI and GitHub](/docs/ci/). For implementation details, read [dependencies.ts](https://github.com/alex-dbs/coderuler/blob/main/src/adapter/filesystem/dependencies.ts) and [rule resolution](https://github.com/alex-dbs/coderuler/blob/main/src/adapter/filesystem/rule-resolution.ts).
