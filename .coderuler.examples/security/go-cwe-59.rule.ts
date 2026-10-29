import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

// CWE-59 is broader than this rule. This specialization checks Go operations on
// attacker-influenced file names for symlink escape or unintended hard-link
// targets; hard links matter only when filesystem permissions let an attacker
// create or replace entries on the same filesystem.
// Sources: https://cwe.mitre.org/data/definitions/59.html
// https://go.dev/blog/osroot
export default class GoCwe59 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/59/*.go'];
  // File-level context includes local callers and comments that may establish
  // whether paths, destination entries, and the filesystem namespace are trusted.
  scope = scopes.file();

  check = ai({
    instruction: `Evaluate Go file operations using attacker-influenced names when the code promises a directory boundary or a particular target. Violate when link resolution can select an unintended file: a symlink may escape the promised root, and a hard link in an attacker-writable directory may make a write or truncate change another inode while the path stays inside the root. A directory-scoped API such as os.Root addresses traversal, not hard-link target identity; require effective protection for the operation, not a particular API (for example, exclusive creation for new files or a trusted target and namespace for updates). Lexical checks suffice only when the relevant filesystem namespace is trusted and cannot be changed or raced by the attacker. Hard links matter only where filesystem permissions allow an attacker to link to the target on the same filesystem; do not assume that threat without source evidence. Do not flag caller-selected destinations without a promise to confine or protect them. This is a focused Go path/link rule, not complete CWE-59 coverage.`,
    input: (subject: ScopeSubject) => subject.source,
    violationMessage: 'Prevent attacker-influenced Go paths from resolving to unintended filesystem targets, including through symlink escape or hard-link aliases.',
    examples: {
      good: [
        `func readAsset(name string) ([]byte, error) {
    // assets and its ancestors are application-owned, not writable by untrusted users.
    root, err := os.OpenRoot("assets")
    if err != nil { return nil, err }
    defer root.Close()
    file, err := root.Open(name)
    if err != nil { return nil, err }
    defer file.Close()
    return io.ReadAll(file)
}`,
        `func createExtractedFile(rootDir, name string, data []byte) error {
    if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
        return os.ErrInvalid
    }
    root, err := os.OpenRoot(rootDir)
    if err != nil { return err }
    defer root.Close()
    file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
    if err != nil { return err }
    defer file.Close()
    _, err = file.Write(data)
    return err
}`,
        `func createPrivateFile(dir, name string, data []byte) error {
    // dir and its ancestors are application-owned and cannot be changed by untrusted users.
    if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
        return os.ErrInvalid
    }
    file, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
    if err != nil { return err }
    defer file.Close()
    _, err = file.Write(data)
    return err
}`,
        `func saveUpload(rootDir, name string, data []byte) error {
    return os.WriteFile(filepath.Join(rootDir, name), data, 0600) // Caller-selected destination; no confinement or protected-target promise.
}`,
      ],
      bad: [
        `func readAsset(name string) ([]byte, error) {
    // name is request-controlled and must resolve only beneath assets.
    return os.ReadFile(filepath.Join("assets", name))
}`,
        `func extractFile(rootDir, name string, data []byte) error {
    if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
        return os.ErrInvalid
    }
    // An attacker can create hard links in rootDir to sensitive files on this filesystem.
    return os.WriteFile(filepath.Join(rootDir, name), data, 0600)
}`,
      ],
    },
  });
}

export const aiTests = [
  test('opening an untrusted name beneath a root resists symlink escape').withFiles({
    'benchmarks/vulntune-go/per-cwe/59/assets.go': `package example
import ("io"; "os")
func readAsset(name string) ([]byte, error) {
    // assets and its ancestors are application-owned, not writable by untrusted users.
    root, err := os.OpenRoot("assets")
    if err != nil { return nil, err }
    defer root.Close()
    file, err := root.Open(name)
    if err != nil { return nil, err }
    defer file.Close()
    return io.ReadAll(file)
}`,
  }).passes(),
  test('joining an untrusted name before reading can follow an escape symlink').withFiles({
    'benchmarks/vulntune-go/per-cwe/59/assets.go': `package example
import ("os"; "path/filepath")
func readAsset(name string) ([]byte, error) {
    // name is request-controlled and must resolve only beneath assets.
    return os.ReadFile(filepath.Join("assets", name))
}`,
  }).violates(),
  test('a user-selected output location need not be confined').withFiles({
    'benchmarks/vulntune-go/per-cwe/59/save.go': `package example
import ("os"; "path/filepath")
func saveAtChosenLocation(dir, name string, data []byte) error {
    // The caller explicitly chooses the output directory; this is not a directory sandbox.
    return os.WriteFile(filepath.Join(dir, name), data, 0600)
}`,
  }).passes(),
  test('writing through an existing hard link can modify an unintended file inside the root').withFiles({
    'benchmarks/vulntune-go/per-cwe/59/extract.go': `package example
import ("os"; "path/filepath")
func extractFile(rootDir, name string, data []byte) error {
    if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
        return os.ErrInvalid
    }
    // An attacker can create hard links in rootDir to sensitive files on this filesystem.
    // The extractor must not overwrite that unintended inode.
    return os.WriteFile(filepath.Join(rootDir, name), data, 0600)
}`,
  }).violates(),
  test('exclusive creation refuses an attacker-planted hard link inside the root').withFiles({
    'benchmarks/vulntune-go/per-cwe/59/extract.go': `package example
import ("os"; "path/filepath")
func extractFile(rootDir, name string, data []byte) error {
    if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
        return os.ErrInvalid
    }
    // An attacker can create hard links in rootDir to sensitive files on this filesystem.
    root, err := os.OpenRoot(rootDir)
    if err != nil { return err }
    defer root.Close()
    file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
    if err != nil { return err }
    defer file.Close()
    _, err = file.Write(data)
    return err
}`,
  }).passes(),
  test('exclusive leaf creation in a trusted private directory protects the target without os.Root').withFiles({
    'benchmarks/vulntune-go/per-cwe/59/save.go': `package example
import ("os"; "path/filepath")
func createFreshFile(dir, name string, data []byte) error {
    // dir and its ancestors are application-owned and cannot be changed by untrusted users.
    if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
        return os.ErrInvalid
    }
    file, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
    if err != nil { return err }
    defer file.Close()
    _, err = file.Write(data)
    return err
}`,
  }).passes(),
] as const;
