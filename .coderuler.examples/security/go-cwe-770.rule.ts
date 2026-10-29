import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

// CWE-770 is broader than this Go policy: it focuses on request/job-triggered goroutine fan-out,
// input-driven memory growth, streamed file writes, and database connection use.
// Sources: https://cwe.mitre.org/data/definitions/770.html
// Go guidance: https://go.dev/doc/database/manage-connections and https://pkg.go.dev/net/http#MaxBytesReader
export default class GoCwe770 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/770/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [
        { kind: 'function_declaration', has: { kind: 'go_statement', stopBy: 'end' } },
        { kind: 'method_declaration', has: { kind: 'go_statement', stopBy: 'end' } },
        {
          any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
          has: {
            kind: 'call_expression',
            stopBy: 'end',
            any: [
              { has: { kind: 'identifier', regex: '^(make|append)$' } },
              {
                has: {
                  kind: 'selector_expression',
                  stopBy: 'end',
                  has: {
                    field: 'field',
                    regex:
                      '^(ReadAll|Copy|CopyBuffer|QueryContext)$',
                  },
                },
              },
            ],
          },
        },
      ],
    },
  });

  check = ai({
    instruction: 'In Go HTTP handlers and job entry points, flag goroutines only when externally triggered requests or jobs can spawn unbounded concurrent work; fixed worker pools and startup/service goroutines are outside this policy. For request-body reads and streamed file writes, require per-operation byte limits and shared aggregate count/byte limits when operations can overlap or accumulate. Retained objects/files need bounded count and total bytes; a finite item-size cap plus finite shared count can establish the total-byte bound. For database/sql QueryContext calls on a shared pool used by concurrent HTTP requests, require a finite aggregate connection cap such as SetMaxOpenConns (or an equivalent cap). Report a violation only when supplied same-package source establishes that the shared pool is not capped; a request-scoped db parameter alone is insufficient evidence. This Go-specific policy does not cover every CWE-770 case.',
    examples: {
      good: [
        `var requestSlots = make(chan struct{}, 16)

func handler(w http.ResponseWriter, r *http.Request) {
    requestSlots <- struct{}{}
    defer func() { <-requestSlots }()
    r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
    body, _ := io.ReadAll(r.Body)
    _ = body
}`,
        `const maxRecords = 128
const maxRecordBytes = 4096
const maxRetainedBytes = 512 << 10

var records [][]byte
var retainedBytes int
var recordsMu sync.Mutex

func retain(recordSize int) {
    recordsMu.Lock()
    defer recordsMu.Unlock()
    if len(records) >= maxRecords || recordSize > maxRecordBytes || retainedBytes+recordSize > maxRetainedBytes {
        return
    }
    record := make([]byte, recordSize)
    records = append(records, record)
    retainedBytes += recordSize
}`,
        `func lookup(db *sql.DB, ctx context.Context) {
    db.SetMaxOpenConns(8)
    rows, err := db.QueryContext(ctx, "SELECT id FROM items")
    if err != nil {
        return
    }
    defer rows.Close()
}`,
      ],
      bad: [
        `func handler(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    _ = body
}`,
        `func serve(r *http.Request) {
    go process(r)
}`,
        `var records [][]byte

func handler(w http.ResponseWriter, r *http.Request) {
    record := make([]byte, 4096)
    records = append(records, record)
}`,
        `func handler(w http.ResponseWriter, r *http.Request) {
    file, err := os.CreateTemp("/var/data", "upload-*")
    if err != nil {
        return
    }
    defer file.Close()
    _, _ = io.Copy(file, r.Body)
}`,
      ],
    },
    // Same-package source exposes shared quotas and callers; configuration outside that package remains out of scope.
    input: async (subject, { project }) => {
      const scope = subject as ScopeSubject;
      const file = await project.readText(scope.filepath);
      const packageName = /^[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m.exec(file)?.[1];
      if (!packageName) return { function: scope.source, file, packageContext: [] };

      const directoryEnd = scope.filepath.lastIndexOf('/');
      const directory = directoryEnd < 0 ? '' : scope.filepath.slice(0, directoryEnd);
      const packageFiles = await project.glob(`${directory ? `${directory}/` : ''}*.go`);
      const packageContext: { filepath: string; source: string }[] = [];
      for (const filepath of packageFiles) {
        if (filepath === scope.filepath) continue;
        const source = await project.readText(filepath);
        const siblingPackage = /^[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m.exec(source)?.[1];
        if (siblingPackage === packageName) packageContext.push({ filepath, source });
      }
      return { function: scope.source, file, packageContext };
    },
    violationMessage: 'Bound per-operation size and the shared aggregate count and byte use of externally triggered resources.',
  });
}

export const aiTests = [
  test('an unbounded request body read can exhaust memory').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import (
    "io"
    "net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(r.Body)
    if err != nil {
        return
    }
    _ = body
}`,
  }).violates(),
  test('a request body read has a finite aggregate memory bound').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import (
    "io"
    "net/http"
)

var requestSlots = make(chan struct{}, 16)

func handler(w http.ResponseWriter, r *http.Request) {
    requestSlots <- struct{}{}
    defer func() { <-requestSlots }()
    r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
    body, err := io.ReadAll(r.Body)
    if err != nil {
        return
    }
    _ = body
}`,
  }).passes(),
  test('request-triggered work starts an unbounded goroutine').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/server.go': `package example

import "net/http"

func serve(w http.ResponseWriter, r *http.Request) {
    go process(r)
}`,
  }).violates(),
  test('request-triggered work waits for a fixed-capacity semaphore').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/server.go': `package example

import "net/http"

var slots = make(chan struct{}, 16)

func serve(w http.ResponseWriter, r *http.Request) {
    slots <- struct{}{}
    go func() {
        defer func() { <-slots }()
        process(r)
    }()
}`,
  }).passes(),
  test('individually bounded request records accumulate without an aggregate quota').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import (
    "net/http"
)

var records [][]byte

func handler(w http.ResponseWriter, r *http.Request) {
    record := make([]byte, 4096)
    records = append(records, record)
}`,
  }).violates(),
  test('retained request records have bounded aggregate count and size').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import (
    "net/http"
    "sync"
)

var records [][]byte
var retainedBytes int
var recordsMu sync.Mutex
const maxRecords = 128
const maxRecordBytes = 4096
const maxRetainedBytes = 512 << 10

func handler(w http.ResponseWriter, r *http.Request) {
    recordsMu.Lock()
    defer recordsMu.Unlock()
    recordSize := 4096
    if len(records) >= maxRecords || recordSize > maxRecordBytes || retainedBytes+recordSize > maxRetainedBytes {
        http.Error(w, "capacity reached", http.StatusServiceUnavailable)
        return
    }
    record := make([]byte, recordSize)
    records = append(records, record)
    retainedBytes += recordSize
}`,
  }).passes(),
  test('an unbounded request stream can fill a file without an allocation call').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import (
    "io"
    "net/http"
    "os"
)

func handler(w http.ResponseWriter, r *http.Request) {
    file, err := os.CreateTemp("/var/data", "upload-*")
    if err != nil {
        http.Error(w, "storage unavailable", http.StatusInternalServerError)
        return
    }
    defer file.Close()
    if _, err := io.Copy(file, r.Body); err != nil {
        http.Error(w, "upload failed", http.StatusInternalServerError)
    }
}`,
  }).violates(),
  test('a request handler query without a shared connection limit can allocate connections').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import (
    "database/sql"
    "net/http"
)

var database, _ = sql.Open("driver", "")

func handler(w http.ResponseWriter, r *http.Request) {
    rows, err := database.QueryContext(r.Context(), "SELECT id FROM items")
    if err != nil {
        return
    }
    defer rows.Close()
}`,
  }).violates(),
  test('a query uses a connection limit configured elsewhere in its package').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import "net/http"

func handler(w http.ResponseWriter, r *http.Request) {
    rows, err := database.QueryContext(r.Context(), "SELECT id FROM items")
    if err != nil {
        return
    }
    defer rows.Close()
}`,
    'benchmarks/vulntune-go/per-cwe/770/database.go': `package example

import "database/sql"

var database, _ = sql.Open("driver", "")

func init() {
    database.SetMaxOpenConns(8)
}`,
  }).passes(),
  test('individually buffered request streams can fill disk without a byte quota').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import (
    "io"
    "net/http"
    "os"
)

func handler(w http.ResponseWriter, r *http.Request) {
    file, err := os.Create("/var/data/upload")
    if err != nil {
        http.Error(w, "storage unavailable", http.StatusInternalServerError)
        return
    }
    defer file.Close()
    buffer := make([]byte, 32*1024)
    if _, err := io.CopyBuffer(file, r.Body, buffer); err != nil {
        http.Error(w, "upload failed", http.StatusInternalServerError)
    }
}`,
  }).violates(),
  test('request streams to one file have a finite aggregate byte bound').withFiles({
    'benchmarks/vulntune-go/per-cwe/770/handler.go': `package example

import (
    "io"
    "net/http"
    "os"
)

var uploadSlot = make(chan struct{}, 1)

func handler(w http.ResponseWriter, r *http.Request) {
    uploadSlot <- struct{}{}
    defer func() { <-uploadSlot }()
    file, err := os.Create("/var/data/upload")
    if err != nil {
        http.Error(w, "storage unavailable", http.StatusInternalServerError)
        return
    }
    defer file.Close()
    limited := http.MaxBytesReader(w, r.Body, 8<<20)
    buffer := make([]byte, 32*1024)
    if _, err := io.CopyBuffer(file, limited, buffer); err != nil {
        http.Error(w, "upload failed", http.StatusInternalServerError)
    }
}`,
  }).passes(),
] as const;

