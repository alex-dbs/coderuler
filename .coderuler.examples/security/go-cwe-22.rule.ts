import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';
import type { ScopeSubject, Subject } from '@alex-dbs/coderuler';

// CWE-22 specialization: confining externally controlled paths at Go filesystem operations.
// https://cwe.mitre.org/data/definitions/22.html
// https://go.dev/blog/osroot
export default class GoCwe22 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/22/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        kind: 'call_expression',
        stopBy: 'end',
        has: {
          kind: 'selector_expression',
          stopBy: 'end',
          regex: '^.*\\.(ReadFile|Open|OpenFile|OpenRoot|Stat|Lstat|Remove|RemoveAll|Rename|Mkdir|MkdirAll|MkdirTemp|WriteFile|Create|CreateTemp|ReadDir|DirFS|WalkDir|Sub|Join|Clean|Abs|Rel|EvalSymlinks)$',
        },
      },
    },
  });

  check = ai({
    instruction: `This rule specializes CWE-22 to externally controlled path components used by Go filesystem operations that must remain within a designated directory; it does not claim complete CWE-22 coverage or cover unrelated path-based sinks. Check filesystem reads, writes, directory enumeration, creation, rename, and deletion, including calls through import aliases and fs.FS abstractions such as os.DirFS or fs.Sub. Require confinement at the actual filesystem operation, including absolute paths and symlink traversal; cleaning, prefix checks, or an unrooted filesystem abstraction do not suffice unless they enforce the boundary. A traversal-resistant rooted filesystem API such as os.Root, or equivalent enforcement, can satisfy the policy. A designated root is a security boundary only if its selection and parentage are trusted. Assess symlink and check/use race risks against the stated threat model; path validation can be sufficient when untrusted parties cannot modify the filesystem tree. Fixed paths unrelated to a restricted directory are outside this specialization. Treat an unvalidated path parameter as potentially externally controlled rather than assuming it is trusted.`,
    examples: {
      good: [
        `func readEntry(base, name string) ([]byte, error) {
    root, err := os.OpenRoot(base)
    if err != nil {
        return nil, err
    }
    defer root.Close()
    return root.ReadFile(name)
}`,
        `func renameEntry(base, name, archive string) error {
    root, err := os.OpenRoot(base)
    if err != nil {
        return err
    }
    defer root.Close()
    return root.Rename(name, archive)
}`,
      ],
      bad: [
        `func readEntry(base, name string) ([]byte, error) {
    return os.ReadFile(filepath.Join(base, name))
}`,
        `func renameEntry(base, name string) error {
    return filesystem.Rename(paths.Join(base, name), paths.Join(base, "archive"))
}`,
      ],
    },
    input: async (subject: Subject, context) => {
      const scopedSubject = subject as ScopeSubject;
      return {
        candidate: scopedSubject.source,
        file: await context.project.readText(scopedSubject.filepath),
      };
    },
    violationMessage: 'Confine externally controlled paths to their designated directory at every filesystem operation.',
  });
}

export const aiTests = [
  test('a rooted file operation keeps an external name within the directory').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/reader.go': `package files

import "os"

func readEntry(base, name string) ([]byte, error) {
    root, err := os.OpenRoot(base)
    if err != nil {
        return nil, err
    }
    defer root.Close()
    return root.ReadFile(name)
}`,
  }).passes(),
  test('joining an external name before an unrooted read permits traversal').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/reader.go': `package files

import (
    "os"
    "path/filepath"
)

func readEntry(base, name string) ([]byte, error) {
    return os.ReadFile(filepath.Join(base, name))
}`,
  }).violates(),
  test('a fixed file access unrelated to a restricted directory is outside this policy').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/reader.go': `package files

import "os"

func readVersion() ([]byte, error) {
    return os.ReadFile("/etc/service/version")
}`,
  }).passes(),
  test('joining an external directory name before recursive deletion permits traversal').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/cleanup.go': `package files

import (
    "os"
    "path/filepath"
)

func removeEntry(base, name string) error {
    return os.RemoveAll(filepath.Join(base, name))
}`,
  }).violates(),
  test('a rooted recursive deletion keeps an external directory name within the root').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/cleanup.go': `package files

import (
    "os"
    "path/filepath"
)

func removeEntry(base, name string) error {
    root, err := os.OpenRoot(base)
    if err != nil {
        return err
    }
    defer root.Close()
    relative := filepath.Join(".", name)
    return root.RemoveAll(relative)
}`,
  }).passes(),
  test('an aliased filesystem package can rename a path outside the directory').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/rename.go': `package files

import (
    filesystem "os"
    paths "path/filepath"
)

func renameEntry(base, name string) error {
    return filesystem.Rename(paths.Join(base, name), paths.Join(base, "archive"))
}`,
  }).violates(),
  test('creating nested directories with an external name can escape the root').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/mkdir.go': `package files

import (
    "os"
    "path/filepath"
)

func createEntry(base, name string) error {
    return os.MkdirAll(filepath.Join(base, name), 0755)
}`,
  }).violates(),
  test('reading a directory with an external name can escape the root').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/list.go': `package files

import (
    "os"
    "path/filepath"
)

func listEntry(base, name string) ([]os.DirEntry, error) {
    return os.ReadDir(filepath.Join(base, name))
}`,
  }).violates(),
  test('an fs read through DirFS follows a symlink outside the root').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/reader.go': `package files

import (
    "io/fs"
    "os"
    "path/filepath"
)

func readEntry(base, outside string) ([]byte, error) {
    if err := os.Symlink(outside, filepath.Join(base, "link")); err != nil {
        return nil, err
    }
    return fs.ReadFile(os.DirFS(base), "link/secret")
}`,
  }).violates(),
  test('a rooted rename keeps both external names within the designated directory').withFiles({
    'benchmarks/vulntune-go/per-cwe/22/rename.go': `package files

import "os"

func renameEntry(base, name, archive string) error {
    root, err := os.OpenRoot(base)
    if err != nil {
        return err
    }
    defer root.Close()
    return root.Rename(name, archive)
}`,
  }).passes(),
] as const;
