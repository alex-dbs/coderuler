import { Rule, ai, scopes, test, type ScopeSubject, type Subject } from '@alex-dbs/coderuler';

// Local Go SQL-text injection policy; it does not cover every CWE-89 path.
export default class GoSqlInjection extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/89/*.go'];
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
          regex: '^.*\\.(?:Query|QueryContext|QueryRow|QueryRowContext|Exec|ExecContext|Prepare|PrepareContext|Where|First|Find)$',
        },
      },
    },
  });
  check = ai({
    instruction: 'Build Go SQL queries so untrusted text cannot change SQL grammar. Bind data values with driver-supported placeholders and query arguments; do not interpolate arbitrary strings into SQL. Formatting a Go integer as decimal digits in a numeric literal is safe for SQL grammar. For non-bindable SQL structure, such as identifiers or sort directions, compose only exact fragments selected from fixed, application-owned allowlists. This does not establish safety of cross-file helpers or dynamic SQL inside stored procedures.',
    input: async (subject: Subject, { project }) => {
      const scope = subject as ScopeSubject;
      return { function: scope.source, file: await project.readText(scope.filepath) };
    },
    violationMessage: 'Prevent untrusted text from changing SQL grammar; bind values and allowlist non-bindable SQL structure.',
    examples: {
      good: [
        `func loadUser(db *sql.DB, name string) (*sql.Rows, error) {
    return db.Query("SELECT id FROM users WHERE name = ?", name)
}`,
        `func list(db *sql.DB, requestedColumn, requestedDirection string) error {
    columns := map[string]string{"name": "name", "created": "created_at"}
    directions := map[string]string{"asc": "ASC", "desc": "DESC"}
    column, columnOK := columns[requestedColumn]
    direction, directionOK := directions[requestedDirection]
    if !columnOK || !directionOK { return errors.New("unsupported sort") }
    _, err := db.Query("SELECT id FROM users ORDER BY " + column + " " + direction)
    return err
}`,
        `func loadByID(db *sql.DB, userID int) (*sql.Rows, error) {
    query := fmt.Sprintf("SELECT id FROM users WHERE id = %d", userID)
    return db.Query(query)
}`,
      ],
      bad: [
        `func loadUser(db *sql.DB, name string) (*sql.Rows, error) {
    query := fmt.Sprintf("SELECT id FROM users WHERE name = '%s'", name)
    return db.Query(query)
}`,
        `func list(db *sql.DB, direction string) error {
    _, err := db.Query("SELECT id FROM users ORDER BY created_at " + direction)
    return err
}`,
      ],
    },
  });
}

export const aiTests = [
  test('interpolating request data into a query violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

import (
    "database/sql"
    "fmt"
)

func findUser(db *sql.DB, name string) (*sql.Rows, error) {
    query := fmt.Sprintf("SELECT id FROM users WHERE name = '%s'", name)
    return db.Query(query)
}`,
  }).violates(),
  test('binding request data as a query parameter passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

import "database/sql"

func findUser(db *sql.DB, name string) (*sql.Rows, error) {
    return db.Query("SELECT id FROM users WHERE name = ?", name)
}`,
  }).passes(),
  test('interpolating an integer into a numeric predicate passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

import (
    "database/sql"
    "fmt"
)

func findUser(db *sql.DB, userID int) (*sql.Rows, error) {
    query := fmt.Sprintf("SELECT id FROM users WHERE id = %d", userID)
    return db.Query(query)
}`,
  }).passes(),
  test('interpolating request text into QueryContext violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

import (
    "context"
    "database/sql"
    "fmt"
)

func findUser(ctx context.Context, db *sql.DB, name string) (*sql.Rows, error) {
    query := fmt.Sprintf("SELECT id FROM users WHERE name = '%s'", name)
    return db.QueryContext(ctx, query)
}`,
  }).violates(),
  test('GORM Where text interpolation violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

type User struct { Name string }
type DB struct {}
func (db *DB) Where(query string, args ...any) *DB { return db }
func (db *DB) First(value any) *DB { return db }
func (db *DB) Find(value any) *DB { return db }

func findUser(db *DB, name string) error {
    var user User
    return db.Where("name = '" + name + "'").First(&user).Error
}`,
  }).violates(),
  test('GORM First raw condition interpolation violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

type User struct { Name string }
type DB struct {}
func (db *DB) First(value any, conditions ...any) *DB { return db }

func findUser(db *DB, name string) error {
    var user User
    return db.First(&user, "name = '" + name + "'").Error
}`,
  }).violates(),
  test('GORM Find raw condition interpolation violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

type User struct { Name string }
type DB struct {}
func (db *DB) Find(value any, conditions ...any) *DB { return db }

func findUsers(db *DB, name string) error {
    var users []User
    return db.Find(&users, "name = '" + name + "'").Error
}`,
  }).violates(),
  test('GORM bound query value passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

type User struct { Name string }
type DB struct {}
func (db *DB) Where(query string, args ...any) *DB { return db }
func (db *DB) First(value any) *DB { return db }

func findUser(db *DB, name string) error {
    var user User
    return db.Where("name = ?", name).First(&user).Error
}`,
  }).passes(),
  test('fixed SQL structure allowlists pass').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

import ("database/sql"; "errors")

func list(db *sql.DB, requestedColumn, requestedDirection string) error {
    columns := map[string]string{"name": "name", "created": "created_at"}
    directions := map[string]string{"asc": "ASC", "desc": "DESC"}
    column, columnOK := columns[requestedColumn]
    direction, directionOK := directions[requestedDirection]
    if !columnOK || !directionOK { return errors.New("unsupported sort") }
    _, err := db.Query("SELECT id FROM users ORDER BY " + column + " " + direction)
    return err
}`,
  }).passes(),
  test('untrusted sort direction interpolation violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

import "database/sql"

func list(db *sql.DB, direction string) error {
    _, err := db.Query("SELECT id FROM users ORDER BY created_at " + direction)
    return err
}`,
  }).violates(),
  test('same-file query helper interpolation violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/89/users.go': `package store

import ("database/sql"; "fmt")

func queryForName(name string) string {
    return fmt.Sprintf("SELECT id FROM users WHERE name = '%s'", name)
}

func findUser(db *sql.DB, name string) (*sql.Rows, error) {
    return db.Query(queryForName(name))
}`,
  }).violates(),
  ] as const;
