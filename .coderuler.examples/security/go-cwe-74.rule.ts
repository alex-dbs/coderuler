import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';
import type { ScopeSubject } from '@alex-dbs/coderuler';

// CWE-74 is an abstract class; this Go rule specializes it to SQL and shell
// interpreter-syntax injection at database/sql and os/exec command sinks.
// Same-file context is provided for helper dataflow; cross-file flows are outside
// this rule's local analysis boundary. Sources:
// https://cwe.mitre.org/data/definitions/74.html
// https://go.dev/doc/database/sql-injection
// https://pkg.go.dev/os/exec
export default class GoCwe74 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/74/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        kind: 'call_expression',
        stopBy: 'end',
        has: {
          any: [
            { kind: 'selector_expression', regex: '^.*\\.(Query|QueryContext|QueryRow|QueryRowContext|Exec|ExecContext|Prepare|PrepareContext)$' },
            { kind: 'selector_expression', regex: '^.*\\.(Command|CommandContext)$' },
          ],
          stopBy: 'end',
        },
      },
    },
  });
  check = ai({
    instruction: 'Check only SQL statements sent to database/sql query, execution, or prepare methods and command strings passed to an explicitly invoked shell (such as sh -c, bash -c, or cmd /C). Flag data only when externally influenced or dynamically constructed values can change that interpreter syntax: bind SQL values as separate parameters and allow-list dynamic identifiers or clauses; do not concatenate data into shell command text. A normal exec.Command call with a fixed executable and data passed as separate arguments is not shell injection, and constant query or command composition is compliant. Use the selected function and declarations in the same file to trace values; do not assume behavior of callers or helpers outside the provided file.',
    input: async (subject, { project }) => {
      const scope = subject as ScopeSubject;
      return {
        function: scope.source,
        file: await project.readText(scope.filepath),
      };
    },
    violationMessage: 'Keep untrusted values out of SQL and shell syntax: bind SQL values and pass command data as separate arguments instead of building shell text.',
    examples: {
      good: [
        `func findUser(db *sql.DB, id string) error {
    _, err := db.Query("SELECT name FROM users WHERE id = ?", id)
    return err
}`,
        `func query(table string) string {
    return "SELECT name " + "FROM users WHERE active = true"
}`,
        `func search(pattern string) error {
    return exec.Command("grep", "-F", "--", pattern, "/var/log/app.log").Run()
}`,
      ],
      bad: [
        `func findUser(db *sql.DB, id string) error {
    query := fmt.Sprintf("SELECT name FROM users WHERE id = %s", id)
    _, err := db.ExecContext(ctx, query)
    return err
}`,
        `func run(value string) error {
    command := fmt.Sprintf("echo %s", value)
    return exec.Command("sh", "-c", command).Run()
}`,
      ],
    },
  });
}

export const aiTests = [
  test('query values are supplied separately from SQL syntax').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import "database/sql"
func findUser(db *sql.DB, id string) error {
    _, err := db.Query("SELECT name FROM users WHERE id = ?", id)
    return err
}`,
  }).passes(),
  test('untrusted value is interpolated into SQL syntax').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import (
    "database/sql"
    "fmt"
)
func findUser(db *sql.DB, id string) error {
    query := fmt.Sprintf("SELECT name FROM users WHERE id = %s", id)
    _, err := db.Query(query)
    return err
}`,
  }).violates(),
  test('constant query composition does not inject external data').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import "database/sql"
func listUsers(db *sql.DB) error {
    query := "SELECT name " + "FROM users"
    _, err := db.Query(query)
    return err
}`,
  }).passes(),
  test('untrusted value interpolated into QueryRowContext SQL is unsafe').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import (
    "context"
    "database/sql"
    "fmt"
)
func findUser(ctx context.Context, db *sql.DB, id string) error {
    query := fmt.Sprintf("SELECT name FROM users WHERE id = %s", id)
    row := db.QueryRowContext(ctx, query)
    var name string
    return row.Scan(&name)
}`,
  }).violates(),
  test('QueryRowContext keeps untrusted values separate from SQL syntax').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import (
    "context"
    "database/sql"
)
func findUser(ctx context.Context, db *sql.DB, id string) error {
    row := db.QueryRowContext(ctx, "SELECT name FROM users WHERE id = ?", id)
    var name string
    return row.Scan(&name)
}`,
  }).passes(),
  test('directly interpolated QueryRowContext SQL is unsafe').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import (
    "context"
    "database/sql"
)
func findUser(ctx context.Context, db *sql.DB, id string) error {
    query := "SELECT name FROM users WHERE id = " + id
    row := db.QueryRowContext(ctx, query)
    var name string
    return row.Scan(&name)
}`,
  }).violates(),
  test('untrusted SQL is interpolated into ExecContext').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import (
    "context"
    "database/sql"
)
func deleteUser(ctx context.Context, db *sql.DB, id string) error {
    query := "DELETE FROM users WHERE id = '" + id + "'"
    _, err := db.ExecContext(ctx, query)
    return err
}`,
  }).violates(),
  test('ExecContext binds SQL values separately').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import (
    "context"
    "database/sql"
)
func deleteUser(ctx context.Context, db *sql.DB, id string) error {
    _, err := db.ExecContext(ctx, "DELETE FROM users WHERE id = ?", id)
    return err
}`,
  }).passes(),
  test('same-file helper interpolation reaches a SQL sink').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/users.go': `package users
import (
    "context"
    "database/sql"
)
func findUser(ctx context.Context, db *sql.DB, id string) error {
    row := db.QueryRowContext(ctx, userQuery(id))
    var name string
    return row.Scan(&name)
}
func userQuery(id string) string {
    return "SELECT name FROM users WHERE id = " + id
}`,
  }).violates(),
  test('untrusted data is interpolated into shell command syntax').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/command.go': `package command
import (
    "fmt"
    "os/exec"
)
func run(value string) error {
    command := fmt.Sprintf("echo %s", value)
    return exec.Command("sh", "-c", command).Run()
}`,
  }).violates(),
  test('exec passes untrusted command data as a separate argument').withFiles({
    'benchmarks/vulntune-go/per-cwe/74/command.go': `package command
import "os/exec"
func search(pattern string) error {
    return exec.Command("grep", "-F", "--", pattern, "/var/log/app.log").Run()
}`,
  }).passes(),
] as const;
