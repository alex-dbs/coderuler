import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

// Focus: locally evidenced filesystem access through Go permission APIs. CWE-732 also covers
// other resource types and cross-function authorization that this rule cannot fully assess.
// Sources: https://cwe.mitre.org/data/definitions/732.html
// https://github.com/securego/gosec/blob/master/RULES.md
export default class GoCwe732 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/732/*.go'];
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
          regex: '^[A-Za-z_][A-Za-z0-9_]*\\.(WriteFile|OpenFile|Create|Mkdir|MkdirAll|Chmod)$',
        },
      },
    },
  });
  check = ai({
    instruction: 'For Go filesystem creation or permission changes through os.WriteFile, os.OpenFile, os.Create, os.Mkdir/os.MkdirAll, os.Chmod, or a file descriptor’s Chmod, report when the supplied function/file context establishes both (1) an unintended actor has effective group or world read/write permission and (2) the resource contains sensitive data or is integrity-critical (such as an executable, security-sensitive configuration, or another security-critical resource). Evaluate permission bits explicitly: in an octal mode, the middle digit grants group permissions and the final digit grants world permissions; 4 grants read, 2 grants write, and 1 grants execute. Thus 0644 grants world-read, 0660 grants group-read/write, and 0775 grants group-write/execute. For creation calls, account for a documented umask when stated; do not assume an undocumented umask. Treat group and world access separately: explicit evidence that a group is untrusted or unauthorized makes its granted access a violation, while an explicitly authorized group is compliant; world access to a sensitive or security-critical resource is unauthorized unless explicitly authorized. Explicitly public, non-sensitive, read-only content and explicitly authorized sharing are compliant. Use context such as the data being written, resource description, and comments to establish sensitivity/criticality and who is authorized; do not infer either from a mode or path alone. Do not report if the context does not establish a sensitive/integrity-critical resource, an effective permission grant, and an unauthorized actor. This is a focused local-filesystem policy, not complete CWE-732 coverage.',
    input: async (subject, context) => {
      const scope = subject as ScopeSubject;
      return {
        function: scope.source,
        fileContext: await context.project.readText(scope.filepath),
      };
    },
    violationMessage: 'Restrict filesystem read or modification permissions to actors explicitly authorized for the resource.',
    examples: {
      good: [
        `func writeCredentials(path string, data []byte) error {
    return os.WriteFile(path, data, 0o600)
}`,
        `func shareCredentialsWithWorkerGroup(path string) error {
    // The deployment policy authorizes the worker group to read this token.
    return os.Chmod(path, 0o640)
}`,
        `func secureConfig(path string) error {
    return os.Chmod(path, 0o600)
}`,
        `func writePublicReport(path string, data []byte) error {
    return os.WriteFile(path, data, 0o644)
}`,
      ],
      bad: [
        `func saveSigningKey(path string, key []byte) error {
    // The process umask is 0o000; group access is not authorized for this private key.
    f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o666)
    if err != nil { return err }
    defer f.Close()
    _, err = f.Write(key)
    return err
}`,
        `func exposePrivateKey(path string) error {
    return os.Chmod(path, 0o666)
}`,
        `func makeInstalledCommandWritable(file *os.File) error {
    // This descriptor refers to the installed updater executable.
    return file.Chmod(0o777)
}`,
        `func createKeyStore(path string) error {
    // The process umask is 0o000; this directory contains private signing keys.
    return os.MkdirAll(path, 0o777)
}`,
      ],
    },
  });
}

export const aiTests = [
  test('credential file creation is owner-only').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/credentials.go': `package secure

import "os"

func saveCredentials(path string, data []byte) error {
    return os.WriteFile(path, data, 0o600)
}`,
  }).passes(),
  test('credential file created readable by everyone violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/credentials.go': `package insecure

import "os"

func saveCredentials(path string, data []byte) error {
    return os.WriteFile(path, data, 0o644)
}`,
  }).violates(),
  test('public report intentionally readable by everyone is outside the policy').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/report.go': `package reports

import "os"

func writePublicReport(path string, data []byte) error {
    return os.WriteFile(path, data, 0o644)
}`,
  }).passes(),
  test('world-writable executable exposes integrity without sensitive data').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/install.go': `package installer

import "os"

func makeInstalledCommandWritable(path string) error {
    // This path names the installed updater executable; its contents are public.
    return os.Chmod(path, 0o777)
}`,
  }).violates(),
  test('authorized service group can read shared credentials').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/credentials.go': `package service

import "os"

func shareCredentialsWithWorkerGroup(path string) error {
    // The deployment policy authorizes the worker group to read this token.
    return os.Chmod(path, 0o640)
}`,
  }).passes(),
  test('unauthorized group cannot read credentials').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/credentials.go': `package service

import "os"

func exposeCredentialsToUntrustedGroup(path string) error {
    // The group on this host includes users who are not authorized for the token.
    return os.Chmod(path, 0o640)
}`,
  }).violates(),
  test('os.Create leaves a private token readable under the configured umask').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/credentials.go': `package service

import "os"

func savePrivateToken(path string, token []byte) error {
    // The process umask is 0o022, so os.Create leaves this token world-readable.
    f, err := os.Create(path)
    if err != nil { return err }
    defer f.Close()
    _, err = f.Write(token)
    return err
}`,
  }).violates(),
  test('os.OpenFile exposes a signing key to an unauthorized group').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/keys.go': `package service

import "os"

func saveSigningKey(path string, key []byte) error {
    // The process umask is 0o000; only the owner is authorized to read this key.
    f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o660)
    if err != nil { return err }
    defer f.Close()
    _, err = f.Write(key)
    return err
}`,
  }).violates(),
  test('descriptor chmod lets an unauthorized group replace an executable').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/install.go': `package installer

import "os"

func makeInstalledCommandWritable(file *os.File) error {
    // The runtime group is not authorized to replace this updater executable.
    return file.Chmod(0o775)
}`,
  }).violates(),
  test('world-accessible signing-key directory violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/732/keys.go': `package service

import "os"

func createSigningKeyDirectory(path string) error {
    // The process umask is 0o000; this directory contains private signing keys.
    return os.MkdirAll(path, 0o777)
}`,
  }).violates(),
] as const;
