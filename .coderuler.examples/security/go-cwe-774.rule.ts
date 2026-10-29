import { dirname, resolve } from 'node:path';
import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

// CWE-774 is broader than this Go policy, which targets unbounded concurrent allocation of OS file descriptors and connection handles.
// Configuration and call context are limited to the selected package; this rule cannot prove a service-wide cap configured only in another package.
// Sources: https://cwe.mitre.org/data/definitions/774.html
export default class GoCwe774 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/774/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [
        { kind: 'function_declaration' },
        { kind: 'method_declaration' },
        {
          all: [
            { kind: 'func_literal' },
            {
              not: {
                inside: {
                  any: [
                    { kind: 'function_declaration' },
                    { kind: 'method_declaration' },
                    { kind: 'func_literal' },
                  ],
                  stopBy: 'end',
                },
              },
            },
          ],
        },
      ],
    },
  });

  check = ai({
    instruction: 'For Go code that opens OS file descriptors or accepts connection handles on behalf of untrusted or unbounded work, require a finite process/service-wide cap shared by every concurrent invocation drawing on the same handle budget. Acquire capacity before opening or accepting a handle and keep it charged until that handle is actually closed or released; release a reservation if opening fails. A per-request, per-call, or per-worker semaphore is not an aggregate cap because concurrent invocations multiply it. However, do not require a process-wide cap when the shown execution is demonstrably serial (no overlapping invocations) and closes each handle before opening the next, so its maximum live handle count is bounded by the code. Sequential opens within one invocation are not bounded if invocations can overlap. A shared package-level semaphore or pool used by all concurrent callers is an aggregate cap when acquisition happens before opening and the reservation is released only after close. A cap configured only outside the supplied package cannot be established by this rule, so do not claim complete service-wide coverage from its absence here.',
    input: async (subject, context) => {
      const scope = subject as ScopeSubject;
      const scopeFile = resolve(context.project.root, scope.filepath);
      const packageDirectory = dirname(scopeFile);
      const goFiles = await context.project.glob('**/*.go');
      const packageFiles = goFiles.filter(
        filepath =>
          !filepath.endsWith('_test.go') &&
          dirname(resolve(context.project.root, filepath)) === packageDirectory,
      );
      return {
        selected: scope.source,
        packageSources: await Promise.all(
          packageFiles.map(async filepath => ({
            filepath,
            source: await context.project.readText(filepath),
          })),
        ),
      };
    },
    violationMessage: 'Require a process/service-wide cap shared across concurrent allocations and retain each reservation until its handle is released.',
    examples: {
      good: [`var processFileSlots = make(chan struct{}, 8)

func readFiles(paths []string) error {
    for _, path := range paths {
        processFileSlots <- struct{}{}
        f, err := os.Open(path)
        if err != nil {
            <-processFileSlots
            return err
        }
        consume(f)
        err = f.Close()
        <-processFileSlots
        if err != nil {
            return err
        }
    }
    return nil
}`],
      bad: [`func readFiles(paths []string) {
    for _, path := range paths {
        go func(path string) {
            f, err := os.Open(path)
            if err != nil {
                return
            }
            defer f.Close()
            consume(f)
        }(path)
    }
}`],
    },
  });
}

export const aiTests = [
  test('unbounded input launches concurrent file opens').withFiles({
    'benchmarks/vulntune-go/per-cwe/774/files.go': `package example

import "os"

func readFiles(paths []string) {
    for _, path := range paths {
        go func(path string) {
            f, err := os.Open(path)
            if err != nil {
                return
            }
            defer f.Close()
            consume(f)
        }(path)
    }
}`,
  }).violates(),
  test('a package-level HTTP handler literal with unbounded file opens violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/774/handler.go': `package example

import (
    "net/http"
    "os"
)

var handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    f, err := os.Open(r.URL.Query().Get("path"))
    if err != nil {
        http.Error(w, "open failed", http.StatusInternalServerError)
        return
    }
    defer f.Close()
    serveContents(w, f)
})`,
  }).violates(),
  test('a per-invocation semaphore does not bound aggregate file handles').withFiles({
    'benchmarks/vulntune-go/per-cwe/774/files.go': `package example

import (
    "os"
    "sync"
)

func readFiles(paths []string) {
    const maxOpen = 8
    permits := make(chan struct{}, maxOpen)
    var wg sync.WaitGroup
    for _, path := range paths {
        permits <- struct{}{}
        wg.Add(1)
        go func(path string) {
            defer wg.Done()
            defer func() { <-permits }()
            f, err := os.Open(path)
            if err != nil {
                return
            }
            defer f.Close()
            consume(f)
        }(path)
    }
    wg.Wait()
}`,
  }).violates(),
  test('a single serial execution closes each handle before opening the next').withFiles({
    'benchmarks/vulntune-go/per-cwe/774/files.go': `package example

import "os"

func readFiles(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err
        }
        consume(f)
        if err := f.Close(); err != nil {
            return err
        }
    }
    return nil
}
func main() {
    _ = readFiles([]string{"file"})
}`,
  }).passes(),
  test('request-local limit allows aggregate file handles to grow across concurrent requests').withFiles({
    'benchmarks/vulntune-go/per-cwe/774/handler.go': `package example

import (
    "net/http"
    "os"
)

func serveFile(w http.ResponseWriter, r *http.Request) {
    requestSlots := make(chan struct{}, 1)
    requestSlots <- struct{}{}
    f, err := os.Open(r.URL.Query().Get("path"))
    if err != nil {
        <-requestSlots
        http.Error(w, "open failed", http.StatusInternalServerError)
        return
    }
    defer f.Close()
    defer func() { <-requestSlots }()
    serveContents(w, f)
}`,
  }).violates(),
  test('shared limit bounds aggregate file handles across concurrent requests').withFiles({
    'benchmarks/vulntune-go/per-cwe/774/handler.go': `package example

import (
    "net/http"
    "os"
)

func serveFile(w http.ResponseWriter, r *http.Request) {
    processFileSlots <- struct{}{}
    f, err := os.Open(r.URL.Query().Get("path"))
    if err != nil {
        <-processFileSlots
        http.Error(w, "open failed", http.StatusInternalServerError)
        return
    }
    defer func() {
        _ = f.Close()
        <-processFileSlots
    }()
    serveContents(w, f)
}
`,
    'benchmarks/vulntune-go/per-cwe/774/limits.go': `package example

var processFileSlots = make(chan struct{}, 32)
`,
  }).passes(),
] as const;
