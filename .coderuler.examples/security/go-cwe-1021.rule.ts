import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';
import type { ScopeSubject } from '@alex-dbs/coderuler';

// Scope: Go HTTP framing protection only. CWE-1021 also includes UI-redress attacks outside HTTP framing;
// this rule does not claim to detect those cases.
// Sources: https://cwe.mitre.org/data/definitions/1021.html
// https://github.com/labstack/echo/blob/master/middleware/secure.go
export default class GoCwe1021 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/1021/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }, { kind: 'func_literal' }],
    },
  });
  check = ai({
    instruction: 'Assess Go function declarations, methods, and function literals that serve browser-renderable HTTP pages or participate in the route or middleware that serves them. Determine effective framing protection from the selected source: an enforcing Content-Security-Policy frame-ancestors directive or X-Frame-Options protects the response, including when middleware actually applied to that route sets the header. A missing header in the page handler is not a violation when its route applies such protection. Permit only explicitly intended framing origins; report-only CSP and unrelated security headers do not count. If the provided Go code shows a page route registered without framing protection or protective middleware, report it; if the selected handler’s effective route or middleware is not established by the provided code, do not infer a violation from absent local headers alone. This rule checks Go HTTP framing only and does not cover all CWE-1021 UI-redress attacks.',
    examples: {
      good: [
        `func page(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Security-Policy", "frame-ancestors 'self'")
    io.WriteString(w, "<html><body>Account</body></html>")
}`,
        `func routes() http.Handler {
    protectFrames := func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("X-Frame-Options", "DENY")
            next.ServeHTTP(w, r)
        })
    }
    page := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        io.WriteString(w, "<html><body>Account</body></html>")
    })
    mux := http.NewServeMux()
    mux.Handle("/", protectFrames(page))
    return mux
}`,
      ],
      bad: [
        `func routes() http.Handler {
    page := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        io.WriteString(w, "<html><body>Account</body></html>")
    })
    mux := http.NewServeMux()
    mux.Handle("/", page)
    return mux
}`,
      ],
    },
    input: async (subject, context) => {
      const scope = subject as ScopeSubject;
      return {
        selectedSource: scope.source,
        fileSource: await context.project.readText(scope.filepath),
      };
    },
    violationMessage: 'Browser-renderable HTTP response lacks effective framing protection from an enforcing frame-ancestors policy or X-Frame-Options.',
  });
}

export const aiTests = [
  test('browser page response has no framing protection').withFiles({
    'benchmarks/vulntune-go/per-cwe/1021/handler.go': `package example

import (
    "io"
    "net/http"
)

func accountRoutes() http.Handler {
    accountPage := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        io.WriteString(w, "<html><body>Account</body></html>")
    })
    mux := http.NewServeMux()
    mux.Handle("/", accountPage)
    return mux
}`,
  }).violates(),
  test('browser page response restricts framing to its own site').withFiles({
    'benchmarks/vulntune-go/per-cwe/1021/handler.go': `package example

import (
    "io"
    "net/http"
)

func accountPage(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'")
    io.WriteString(w, "<html><body>Account</body></html>")
}`,
  }).passes(),
  test('intentionally embedded page permits only its trusted parent').withFiles({
    'benchmarks/vulntune-go/per-cwe/1021/handler.go': `package example

import (
    "io"
    "net/http"
)

func partnerWidget(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Security-Policy", "frame-ancestors https://portal.partner.example")
    io.WriteString(w, "<html><body>Widget</body></html>")
}`,
  }).passes(),
  test('handler protected by route middleware is not flagged').withFiles({
    'benchmarks/vulntune-go/per-cwe/1021/handler.go': `package example

import (
    "io"
    "net/http"
)

func accountRoutes() http.Handler {
    protectFrames := func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("X-Frame-Options", "DENY")
            next.ServeHTTP(w, r)
        })
    }
    accountPage := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        io.WriteString(w, "<html><body>Account</body></html>")
    })
    mux := http.NewServeMux()
    mux.Handle("/", protectFrames(accountPage))
    return mux
}`,
  }).passes(),
  test('unprotected package-level handler literal is registered').withFiles({
    'benchmarks/vulntune-go/per-cwe/1021/handler.go': `package example

import (
    "io"
    "net/http"
)

var accountPage = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    io.WriteString(w, "<html><body>Account</body></html>")
})

func init() {
    http.Handle("/", accountPage)
}`,
  }).violates(),
] as const;
