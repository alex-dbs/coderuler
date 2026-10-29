import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';
import type { ScopeSubject, Subject } from '@alex-dbs/coderuler';

// CWE-20 is broad; this rule covers only request input checked in selected Go HTTP handlers, not the full weakness.
// Sources: https://cwe.mitre.org/data/definitions/20.html
// https://devguide.owasp.org/en/05-implementation/01-documentation/02-go-scp/
export default class GoCwe20 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/20/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }, { kind: 'func_literal' }] },
  });

  check = ai({
    instruction: 'For the selected Go HTTP handler/function, assess only externally controlled HTTP request values. Validate the canonical value actually consumed: decode, unescape, normalize, or combine request data first, then validate that resulting value against its syntax, type, and evidenced application constraints before use. For request bodies, enforce a raw-byte size limit before buffering or parsing (for example, wrap r.Body with http.MaxBytesReader before json.Decoder.Decode or io.ReadAll); checks on parsed fields do not replace this limit. Reject parse failures and values outside evidenced required ranges, allowlists, or relationships; parsing alone is not validation. Do not invent unstated business rules or treat an unseen caller, middleware, helper, or schema as proof that validation or limits are present or missing. Functions that use only compile-time constants and no externally controlled request data do not require validation. This is a focused HTTP request-input policy, not complete CWE-20 coverage.',
    examples: {
      good: [`func handler(w http.ResponseWriter, r *http.Request) {
    path, err := url.PathUnescape(r.URL.Query().Get("path"))
    if err != nil || strings.Contains(path, "..") {
        http.Error(w, "invalid path", http.StatusBadRequest)
        return
    }
    serveFile(path)
}`,
      `func handler(w http.ResponseWriter, r *http.Request) {
    r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
    var input createRequest
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }
    if input.Name == "" {
        http.Error(w, "name required", http.StatusBadRequest)
        return
    }
    create(input)
}`],
      bad: [`func handler(w http.ResponseWriter, r *http.Request) {
    rawPath := r.URL.Query().Get("path")
    if strings.Contains(rawPath, "..") {
        http.Error(w, "invalid path", http.StatusBadRequest)
        return
    }
    path, _ := url.PathUnescape(rawPath)
    serveFile(path)
}`,
      `func handler(w http.ResponseWriter, r *http.Request) {
    var input createRequest
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }
    if input.Name == "" {
        http.Error(w, "name required", http.StatusBadRequest)
        return
    }
    create(input)
}`],
    },
    input: async (subject) => {
      const scope = subject as ScopeSubject;
      return scope.source;
    },
    violationMessage: 'Validate the canonical request value before use and limit raw request bodies before parsing.',
  });
}

export const aiTests = [
  test('unchecked parsed request quantity violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/20/handler.go': `package example

import (
    "net/http"
    "strconv"
)

func handler(r *http.Request) int {
    quantity, _ := strconv.Atoi(r.URL.Query().Get("quantity"))
    return quantity
}`,
  }).violates(),
  test('request quantity is parsed and range-checked before use').withFiles({
    'benchmarks/vulntune-go/per-cwe/20/handler.go': `package example

import (
    "errors"
    "net/http"
    "strconv"
)

func handler(r *http.Request) (int, error) {
    quantity, err := strconv.Atoi(r.URL.Query().Get("quantity"))
    if err != nil || quantity < 1 || quantity > 100 {
        return 0, errors.New("invalid quantity")
    }
    return quantity, nil
}`,
  }).passes(),
  test('trusted constant does not require input validation').withFiles({
    'benchmarks/vulntune-go/per-cwe/20/price.go': `package example

func total() int {
    const unitPrice = 12
    const defaultQuantity = 2
    return unitPrice * defaultQuantity
}`
  }).passes(),

  test('path is validated before decoding and then used decoded').withFiles({
    'benchmarks/vulntune-go/per-cwe/20/handler.go': `package example

import (
    "net/http"
    "net/url"
    "strings"
)

func handler(w http.ResponseWriter, r *http.Request) {
    rawPath := r.URL.Query().Get("path")
    if strings.Contains(rawPath, "..") {
        http.Error(w, "invalid path", http.StatusBadRequest)
        return
    }
    path, err := url.PathUnescape(rawPath)
    if err != nil {
        http.Error(w, "invalid path", http.StatusBadRequest)
        return
    }
    serveFile(path)
}`,
  }).violates(),
  test('path is decoded before traversal validation and use').withFiles({
    'benchmarks/vulntune-go/per-cwe/20/handler.go': `package example

import (
    "net/http"
    "net/url"
    "strings"
)

func handler(w http.ResponseWriter, r *http.Request) {
    path, err := url.PathUnescape(r.URL.Query().Get("path"))
    if err != nil || strings.Contains(path, "..") {
        http.Error(w, "invalid path", http.StatusBadRequest)
        return
    }
    serveFile(path)
}`,
  }).passes(),
  test('request body is parsed without a raw size limit').withFiles({
    'benchmarks/vulntune-go/per-cwe/20/handler.go': `package example

import (
    "encoding/json"
    "net/http"
)

type createRequest struct {
    Name string \`json:"name"\`
}

func handler(w http.ResponseWriter, r *http.Request) {
    var input createRequest
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }
    if input.Name == "" {
        http.Error(w, "name required", http.StatusBadRequest)
        return
    }
    create(input)
}`,
  }).violates(),
  test('request body has a raw size limit before decoding').withFiles({
    'benchmarks/vulntune-go/per-cwe/20/handler.go': `package example

import (
    "encoding/json"
    "net/http"
)

type createRequest struct {
    Name string \`json:"name"\`
}

func handler(w http.ResponseWriter, r *http.Request) {
    r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
    var input createRequest
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }
    if input.Name == "" {
        http.Error(w, "name required", http.StatusBadRequest)
        return
    }
    create(input)
}`,
  }).passes(),
  test('anonymous HTTP handler validates request quantity').withFiles({
    'benchmarks/vulntune-go/per-cwe/20/handler.go': `package example

import (
    "net/http"
    "strconv"
)

var handler http.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
    quantity, err := strconv.Atoi(r.URL.Query().Get("quantity"))
    if err != nil || quantity < 1 || quantity > 100 {
        http.Error(w, "invalid quantity", http.StatusBadRequest)
        return
    }
    create(quantity)
}`,
  }).passes(),
] as const;
