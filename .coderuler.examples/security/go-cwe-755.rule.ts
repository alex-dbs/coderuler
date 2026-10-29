import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

// CWE-755 is a broad, discouraged mapping; this rule covers only HTTP error-information
// disclosure, a Go-applicable CWE-209-style specialization, not all error handling.
// Sources: https://cwe.mitre.org/data/definitions/755.html
// https://cwe.mitre.org/data/definitions/209.html
export default class GoCwe755 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/755/*.go'];
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
          regex: '^.*\\.(Error|Fprint|Fprintf|Fprintln|Write|WriteString|Encode|Execute|ExecuteTemplate)$',
        },
      },
    },
  });

  check = ai({
    instruction: 'In the selected Go function or method, report only when an internal operation error’s raw text is written to an HTTP response (for example, passed as an http.Error message, formatted or printed to the response writer, or encoded as response data). Require a generic client-safe response instead. Do not flag static or generic responses, errors only logged or returned internally, or unrelated failure handling and cleanup. Use only evidence visible in the selected source; do not infer the behavior of unseen helpers or custom error types.',
    input: subject => ({
      source: (subject as ScopeSubject).source,
      context: 'This is one function or method; judge only directly visible HTTP response content and do not infer behavior of unseen helpers or custom error types.',
    }),
    violationMessage: 'Replace raw internal error details in the HTTP response with a generic client-safe message.',
    examples: {
      good: [
        `func handler(w http.ResponseWriter, r *http.Request) {
    _, err := store.Load(r.Context())
    if err != nil {
        log.Printf("load failed: %v", err)
        http.Error(w, "Unable to complete request", http.StatusInternalServerError)
        return
    }
}`,
        `func handler(w http.ResponseWriter, r *http.Request) {
    _, err := store.Load(r.Context())
    if err != nil {
        fmt.Fprint(w, "Unable to complete request")
        return
    }
}`,
      ],
      bad: [
        `func handler(w http.ResponseWriter, r *http.Request) {
    _, err := store.Load(r.Context())
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
}`,
        `func handler(w http.ResponseWriter, r *http.Request) {
    _, err := store.Load(r.Context())
    if err != nil {
        _ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
        return
    }
}`,
      ],
    },
  });
}

export const aiTests = [
  test('an internal error is returned as a generic HTTP message').withFiles({
    'benchmarks/vulntune-go/per-cwe/755/handler.go': `package api

import (
    "log"
    "net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
    _, err := store.Load(r.Context())
    if err != nil {
        log.Printf("load failed: %v", err)
        http.Error(w, "Unable to complete request", http.StatusInternalServerError)
        return
    }
}`,
  }).passes(),
  test('raw internal error details are sent to the HTTP client').withFiles({
    'benchmarks/vulntune-go/per-cwe/755/handler.go': `package api

import "net/http"

func handler(w http.ResponseWriter, r *http.Request) {
    _, err := store.Load(r.Context())
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
}`,
  }).violates(),
  test('a static not-found response does not expose an internal error').withFiles({
    'benchmarks/vulntune-go/per-cwe/755/handler.go': `package api

import "net/http"

func handler(w http.ResponseWriter, r *http.Request) {
    if _, err := store.Load(r.Context()); err != nil {
        http.Error(w, "Resource unavailable", http.StatusNotFound)
        return
    }
}`,
  }).passes(),
  test('raw internal error details sent with fmt.Fprintf are disclosed').withFiles({
    'benchmarks/vulntune-go/per-cwe/755/handler.go': `package api

import (
    "fmt"
    "net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
    if _, err := store.Load(r.Context()); err != nil {
        fmt.Fprintf(w, "load failed: %v", err)
        return
    }
}`,
  }).violates(),
  test('a generic fmt.Fprintf error response does not disclose details').withFiles({
    'benchmarks/vulntune-go/per-cwe/755/handler.go': `package api

import (
    "fmt"
    "net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
    if _, err := store.Load(r.Context()); err != nil {
        fmt.Fprint(w, "Unable to complete request")
        return
    }
}`,
  }).passes(),
  test('raw error details encoded as JSON are disclosed').withFiles({
    'benchmarks/vulntune-go/per-cwe/755/handler.go': `package api

import (
    "encoding/json"
    "net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
    if _, err := store.Load(r.Context()); err != nil {
        _ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
        return
    }
}`,
  }).violates(),
  test('a generic JSON error response does not disclose details').withFiles({
    'benchmarks/vulntune-go/per-cwe/755/handler.go': `package api

import (
    "encoding/json"
    "net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
    if _, err := store.Load(r.Context()); err != nil {
        _ = json.NewEncoder(w).Encode(map[string]string{"error": "Unable to complete request"})
        return
    }
}`,
  }).passes(),
  test('an aliased HTTP error helper is selected for disclosure checks').withFiles({
    'benchmarks/vulntune-go/per-cwe/755/handler.go': `package api

import web "net/http"

func handler(w web.ResponseWriter, r *web.Request) {
    if _, err := store.Load(r.Context()); err != nil {
        web.Error(w, err.Error(), web.StatusInternalServerError)
        return
    }
}`,
  }).violates(),
] as const;
