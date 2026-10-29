import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

// MITRE: https://cwe.mitre.org/data/definitions/601.html. This rule covers only locally assessable Go server-side redirects within one function, not all of CWE-601.
export default class GoCwe601 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/601/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        any: [
          {
            kind: 'call_expression',
            has: {
              kind: 'selector_expression',
              has: { field: 'field', regex: '^Redirect$' },
            },
          },
          { pattern: '$HEADERS.Set("Location", $$$ARGS)' },
          { pattern: '$HEADERS.Add("Location", $$$ARGS)' },
          { pattern: '$HEADERS["Location"] = $$$VALUE' },
        ],
        stopBy: 'end',
      },
    },
  });

  check = ai({
    instruction: 'Assess only redirect behavior visible within this selected Go function: `http.Redirect` or a framework `Redirect` call, or a `Location` header paired with a 3xx response. When request-controlled data reaches the destination, require either an explicit allowlist or a browser-safe local reference: parse it, reject any scheme or host, require a root-relative path, and reject authority-like `//` paths and any backslash before redirecting. A slash-prefix check alone is unsafe because browsers can interpret `/\\attacker.example` as external. A deliberately public external-navigation flow may accept arbitrary destinations only when it first displays a clear departure warning naming the exact destination and requires a separate explicit user confirmation, such as a user-submitted form; a hidden flag or query parameter alone is not confirmation. Fixed destinations and request values not used as redirect destinations are outside scope. Because only this function is supplied, do not infer a helper or validator is unsafe merely because its implementation is outside the selected source; report only unsafe flows directly visible here.',
    examples: {
      good: [
        `func finishLogin(w http.ResponseWriter, r *http.Request) {
    target := r.URL.Query().Get("next")
    parsed, err := url.Parse(target)
    if err != nil || parsed.IsAbs() || parsed.Host != "" ||
        !strings.HasPrefix(parsed.Path, "/") || strings.HasPrefix(parsed.Path, "//") ||
        strings.Contains(target, "\\\\") {
        target = "/home"
    }
    http.Redirect(w, r, target, http.StatusSeeOther)
}`,
        `func finishLogin(w http.ResponseWriter, r *http.Request) {
    target := r.URL.Query().Get("next")
    if target != "https://app.example.com/account" && target != "https://app.example.com/home" {
        target = "/home"
    }
    http.Redirect(w, r, target, http.StatusSeeOther)
}`,
        `func leaveSite(w http.ResponseWriter, r *http.Request) {
    target := r.FormValue("to")
    if r.Method != http.MethodPost {
        warning := template.Must(template.New("leave").Parse(\`<p>You are leaving this site for {{.}}</p><form method="post"><input type="hidden" name="to" value="{{.}}"><button type="submit">Continue</button></form>\`))
        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        _ = warning.Execute(w, target)
        return
    }
    http.Redirect(w, r, target, http.StatusSeeOther)
}`,
      ],
      bad: [
        `func finishLogin(w http.ResponseWriter, r *http.Request) {
    http.Redirect(w, r, r.URL.Query().Get("next"), http.StatusSeeOther)
}`,
        `func finishLogin(w http.ResponseWriter, r *http.Request) {
    target := r.URL.Query().Get("next")
    if strings.Contains(target, "app.example.com") {
        http.Redirect(w, r, target, http.StatusSeeOther)
    }
}`,
        `func finishLogin(w http.ResponseWriter, r *http.Request) {
    target := r.URL.Query().Get("next")
    w.Header().Set("Location", target)
    w.WriteHeader(http.StatusFound)
}`,
      ],
    },
    input: subject => (subject as ScopeSubject).source,
    violationMessage: 'Constrain locally visible request-controlled redirect destinations to browser-safe local paths or explicitly approved navigation.',
  });
}

export const aiTests = [
  test('a request parameter is redirected without validation').withFiles({
    'benchmarks/vulntune-go/per-cwe/601/redirect.go': `package example

import "net/http"

func finishLogin(w http.ResponseWriter, r *http.Request) {
    http.Redirect(w, r, r.URL.Query().Get("next"), http.StatusSeeOther)
}`,
  }).violates(),
  test('an aliased redirect method is selected').withFiles({
    'benchmarks/vulntune-go/per-cwe/601/redirect.go': `package example

import web "net/http"

func finishLogin(w web.ResponseWriter, r *web.Request) {
    web.Redirect(w, r, r.URL.Query().Get("next"), web.StatusSeeOther)
}`,
  }).violates(),
  test('a request-controlled Location header with a redirect status is selected').withFiles({
    'benchmarks/vulntune-go/per-cwe/601/redirect.go': `package example

import "net/http"

func finishLogin(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Location", r.URL.Query().Get("next"))
    w.WriteHeader(http.StatusFound)
}`,
  }).violates(),
  test('an external destination follows a displayed warning and explicit confirmation').withFiles({
    'benchmarks/vulntune-go/per-cwe/601/redirect.go': `package example

import (
    "html/template"
    "net/http"
)

func leaveSite(w http.ResponseWriter, r *http.Request) {
    target := r.FormValue("to")
    if r.Method != http.MethodPost {
        warning := template.Must(template.New("leave").Parse(\`<p>You are leaving this site for {{.}}</p><form method="post"><input type="hidden" name="to" value="{{.}}"><button type="submit">Continue</button></form>\`))
        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        _ = warning.Execute(w, target)
        return
    }
    http.Redirect(w, r, target, http.StatusSeeOther)
}`,
  }).passes(),
  test('a browser-safe root-relative path is accepted and external forms fall back').withFiles({
    'benchmarks/vulntune-go/per-cwe/601/redirect.go': `package example

import (
    "net/http"
    "net/url"
    "strings"
)

func finishLogin(w http.ResponseWriter, r *http.Request) {
    target := r.URL.Query().Get("next")
    parsed, err := url.Parse(target)
    if err != nil || parsed.IsAbs() || parsed.Host != "" ||
        !strings.HasPrefix(parsed.Path, "/") || strings.HasPrefix(parsed.Path, "//") ||
        strings.Contains(target, "\\\\") {
        target = "/home"
    }
    http.Redirect(w, r, target, http.StatusSeeOther)
}`,
  }).passes(),
  test('a fixed redirect does not depend on request-controlled destination').withFiles({
    'benchmarks/vulntune-go/per-cwe/601/redirect.go': `package example

import "net/http"

func finishLogin(w http.ResponseWriter, r *http.Request) {
    http.Redirect(w, r, "/home", http.StatusSeeOther)
}`,
  }).passes(),
  test('slash-backslash destination bypasses a weak local path check').withFiles({
    'benchmarks/vulntune-go/per-cwe/601/redirect.go': `package example

import (
    "net/http"
    "strings"
)

func finishLogin(w http.ResponseWriter, r *http.Request) {
    target := r.URL.Query().Get("next")
    if !strings.HasPrefix(target, "/") || strings.HasPrefix(target, "//") {
        target = "/home"
    }
    // The accepted value "/\\attacker.example/path" is treated as external by browsers.
    http.Redirect(w, r, target, http.StatusSeeOther)
}`,
  }).violates(),
  test('request redirect is restricted to an allowlisted local path').withFiles({
    'benchmarks/vulntune-go/per-cwe/601/redirect.go': `package example

import "net/http"

func finishLogin(w http.ResponseWriter, r *http.Request) {
    target := r.URL.Query().Get("next")
    if target != "/account" && target != "/home" {
        target = "/home"
    }
    http.Redirect(w, r, target, http.StatusSeeOther)
}`,
  }).passes(),
] as const;
