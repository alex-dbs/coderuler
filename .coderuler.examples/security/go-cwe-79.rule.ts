import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';
import type { ScopeSubject } from '@alex-dbs/coderuler';

// CWE-79 spans more than this policy: this rule assesses Go server-rendered HTML, not browser-only DOM flows.
// Sources: https://cwe.mitre.org/data/definitions/79.html
// https://go.dev/src/html/template/doc.go
// https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/06-Client-side_Testing/README
// https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
// Its context includes the selected file, not external templates or cross-file data flows.
export default class GoCrossSiteScripting extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/79/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }, { kind: 'func_literal' }] },
  });

  check = ai({
    instruction: 'For Go-generated server-rendered HTML, neutralize untrusted values for their specific output context: use html/template contextual escaping for template data, sanitize user-authored markup with an allowlist only when retaining markup, and validate or restrict URL schemes or avoid inserting data into executable contexts. Do not rely on text/template, fmt interpolation, HTML escaping alone for executable or unsafe URL contexts, or template.HTML around unsanitized data. Fixed HTML and suitably sanitized rich text are safe. This rule assesses server-rendered output only, not browser-only DOM XSS.',
    input: async (subject, context) => {
      const scope = subject as ScopeSubject;
      return {
        source: scope.source,
        fileContext: await context.project.readText(scope.filepath),
      };
    },
    violationMessage: 'Neutralize untrusted values for the server-rendered HTML output context, or sanitize markup that must remain HTML.',
    examples: {
      good: [
        `import "html/template"
func welcome(w http.ResponseWriter, r *http.Request) {
    tmpl := template.Must(template.New("welcome").Parse("<p>Hello, {{.}}</p>"))
    tmpl.Execute(w, r.URL.Query().Get("name"))
}`,
        `import ("html/template"; "github.com/microcosm-cc/bluemonday")
func comment(w http.ResponseWriter, r *http.Request) {
    safe := bluemonday.UGCPolicy().Sanitize(r.FormValue("comment"))
    tmpl := template.Must(template.New("comment").Parse("<article>{{.}}</article>"))
    tmpl.Execute(w, template.HTML(safe))
}`,
      ],
      bad: [
        `import ("fmt"; "net/http")
func welcome(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "<p>Hello, %s</p>", r.URL.Query().Get("name"))
}`,
      ],
    },
  });
}

export const aiTests = [
  test('a request parameter is interpolated into raw server-rendered HTML').withFiles({
    'benchmarks/vulntune-go/per-cwe/79/handler.go': `package web
import ("fmt"; "net/http")
func welcome(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "<p>Hello, %s</p>", r.URL.Query().Get("name"))
}`,
  }).violates(),
  test('html/template contextually escapes a request parameter').withFiles({
    'benchmarks/vulntune-go/per-cwe/79/handler.go': `package web
import ("html/template"; "net/http")
func welcome(w http.ResponseWriter, r *http.Request) {
    tmpl := template.Must(template.New("welcome").Parse("<p>Hello, {{.}}</p>"))
    tmpl.Execute(w, r.URL.Query().Get("name"))
}`,
  }).passes(),
  test('a fixed HTML response has no untrusted interpolation').withFiles({
    'benchmarks/vulntune-go/per-cwe/79/handler.go': `package web
import "net/http"
func welcome(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("<p>Hello</p>"))
}`,
  }).passes(),
  test('a package-level anonymous handler writes unescaped request data').withFiles({
    'benchmarks/vulntune-go/per-cwe/79/handler.go': `package web
import ("fmt"; "net/http")
var welcome = func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "<p>Hello, %s</p>", r.URL.Query().Get("name"))
}`,
  }).violates(),
  test('text/template does not safely escape server-rendered HTML').withFiles({
    'benchmarks/vulntune-go/per-cwe/79/handler.go': `package web
import ("net/http"; "text/template")
func welcome(w http.ResponseWriter, r *http.Request) {
    tmpl := template.Must(template.New("welcome").Parse("<p>Hello, {{.}}</p>"))
    tmpl.Execute(w, r.URL.Query().Get("name"))
}`,
  }).violates(),
  test('allowlisted user-authored HTML may retain safe markup').withFiles({
    'benchmarks/vulntune-go/per-cwe/79/handler.go': `package web
import (
    "html/template"
    "net/http"
    "github.com/microcosm-cc/bluemonday"
)
func comment(w http.ResponseWriter, r *http.Request) {
    safe := bluemonday.UGCPolicy().Sanitize(r.FormValue("comment"))
    tmpl := template.Must(template.New("comment").Parse("<article>{{.}}</article>"))
    tmpl.Execute(w, template.HTML(safe))
}`,
  }).passes(),
] as const;
