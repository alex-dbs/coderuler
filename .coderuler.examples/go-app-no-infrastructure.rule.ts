import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

export default class GoAppNoInfrastructure extends Rule {
  enabled = false;
  files = ['internal/app/**/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }] },
  });

  check = ai({
    instruction: 'Keep each Go function in internal/app focused on application logic. Do not perform I/O with external systems through concrete clients in these functions; keep that work in adapters. A function may request external work through an injected interface (a port). Judge only the selected function.',
    examples: {
      good: [
        `func (s Service) Find(ctx context.Context, id string) (Account, error) {
    return s.accounts.Find(ctx, id)
}`,
      ],
      bad: [
        `func Find(ctx context.Context, db *sql.DB, id string) (Account, error) {
    var account Account
    err := db.QueryRowContext(ctx, "SELECT id FROM accounts WHERE id = ?", id).Scan(&account.ID)
    return account, err
}`,
        `func Fetch(ctx context.Context, client *http.Client, endpoint string) error {
    request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
    if err != nil {
        return err
    }
    _, err = client.Do(request)
    return err
}`,
        `func ReadSession(ctx context.Context, client *redis.Client, key string) (string, error) {
    return client.Get(ctx, key).Result()
}`,
        `func Publish(ctx context.Context, writer *kafka.Writer, message kafka.Message) error {
    return writer.WriteMessages(ctx, message)
}`,
      ],
    },
    input: async (subject, { project }) => {
      const scope = subject as ScopeSubject;
      return {
        function: scope.source,
        file: await project.readText(scope.filepath),
      };
    },
    violationMessage: 'Move infrastructure I/O out of the domain and call an injected port instead.',
  });
}

export const aiTests = [
  test('an application service calls an injected repository port').withFiles({
    'internal/app/account/service.go': `package app

import "context"

type Account struct { ID string }
type AccountRepository interface {
    Find(context.Context, string) (Account, error)
}
type Service struct { accounts AccountRepository }

func (s Service) Find(ctx context.Context, id string) (Account, error) {
    return s.accounts.Find(ctx, id)
}`,
  }).passes(),
  test('a pure application function transforms domain data').withFiles({
    'internal/app/order/label.go': `package app

type Order struct { Total int }

func Label(order Order) string {
    if order.Total >= 1000 {
        return "priority"
    }
    return "normal"
}`,
  }).passes(),
  test('a function queries SQL directly').withFiles({
    'internal/app/account/query.go': `package app

import (
    "context"
    "database/sql"
)

type Account struct { ID string }

func Find(ctx context.Context, db *sql.DB, id string) (Account, error) {
    var account Account
    err := db.QueryRowContext(ctx, "SELECT id FROM accounts WHERE id = ?", id).Scan(&account.ID)
    return account, err
}`,
  }).violates(),
  test('a function sends an HTTP request directly').withFiles({
    'internal/app/catalog/client.go': `package app

import (
    "context"
    "net/http"
)

func Fetch(ctx context.Context, client *http.Client, endpoint string) (*http.Response, error) {
    request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
    if err != nil {
        return nil, err
    }
    return client.Do(request)
}`,
  }).violates(),
  test('a function reads Redis directly').withFiles({
    'internal/app/session/cache.go': `package app

import (
    "context"
    "github.com/redis/go-redis/v9"
)

func ReadSession(ctx context.Context, client *redis.Client, key string) (string, error) {
    return client.Get(ctx, key).Result()
}`,
  }).violates(),
  test('a function publishes to Kafka directly').withFiles({
    'internal/app/events/publisher.go': `package app

import (
    "context"
    "github.com/segmentio/kafka-go"
)

func Publish(ctx context.Context, writer *kafka.Writer, key, value []byte) error {
    return writer.WriteMessages(ctx, kafka.Message{Key: key, Value: value})
}`,
  }).violates(),
] as const;
