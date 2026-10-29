import { Rule, ai, scopes, test, type Subject } from '@alex-dbs/coderuler';

// CWE-200 is an abstract class; this rule covers direct sensitive-data exposure in Go application logs,
// a focused logging policy more specifically associated with CWE-532, not other CWE-200 disclosure paths.
// Sources: https://cwe.mitre.org/data/definitions/200.html
// https://cwe.mitre.org/data/definitions/532.html
// https://github.com/grpc/grpc-go/security/advisories/GHSA-xr7q-jx4m-x55m
export default class GoCwe200 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/200/*.go'];
  // Select the whole file so import aliases and same-file redaction helpers remain available to the check.
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      kind: 'source_file',
      has: {
        kind: 'call_expression',
        stopBy: 'end',
        has: {
          kind: 'selector_expression',
          stopBy: 'end',
          regex: '\\.(?:Print(?:f|ln)?|Fatal(?:f|ln)?|Panic(?:f|ln)?|Output|Trace(?:f|w)?|Debug(?:f|ln|w|S|Context)?|Info(?:f|ln|w|S|Context)?|Warn(?:f|ln|w|S|Context)?|Warning(?:f|ln|w|S)?|Error(?:f|ln|w|S|Context)?|DPanic(?:f|w)?|Log(?:Attrs|f)?|Msg(?:f|Func)?|Send)$',
        },
      },
    },
  });

  check = ai({
    instruction: 'Protect sensitive information from direct exposure in Go application logs. For each actual logging sink in the file, flag cleartext credentials, authentication tokens, private keys, directly identifying personal data (such as government IDs), private contact details, exact locations, medical or financial data, confidential communications, proprietary business or customer data, and nonpublic security or system configuration/state. Require redaction, omission, or safe aggregation before logging. Do not flag a value merely because its name sounds sensitive or because a call is selected. Recognize standard log APIs and common logger methods, including import aliases, slog (including context methods), and structured loggers, but do not treat an ordinary method such as Error as logging without evidence from its receiver or call. Allow non-sensitive diagnostics such as opaque request or account/user IDs, status codes, error categories, and timing. If the logging sink or sensitive value cannot be established from the available file, do not infer a violation. This rule covers direct log disclosure only, not other CWE-200 disclosure paths.',
    input: (subject: Subject) => subject.kind === 'scope'
      ? subject.source
      : subject.members.map(member => member.source).join('\n'),
    violationMessage: 'Redact or omit sensitive values before writing them to application logs.',
    examples: {
      good: [
        `func reportFailure(requestID string, status int) {
    log.Printf("request failed: request_id=%s status=%d", requestID, status)
}`,
        `func reportVisit(diagnosis string) {
    log.Printf("patient diagnosis: %s", redact(diagnosis))
}`,
      ],
      bad: [
        `func reportVisit(diagnosis string) {
    log.Printf("patient diagnosis: %s", diagnosis)
}`,
        `func reportAuth(headers http.Header) {
    log.Printf("request headers: %v", headers)
}`,
      ],
    },
  });
}

export const aiTests = [
  test('logging an authentication token violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/auth.go': `package example
import "log"
func reportFailure(token string) {
    log.Printf("authentication failed: token=%s", token)
}`,
  }).violates(),
  test('logging a redacted token passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/auth.go': `package example
import "log"
func reportFailure() {
    log.Printf("authentication failed: token=%s", "[redacted]")
}`,
  }).passes(),
  test('logging a non-sensitive user identifier passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/audit.go': `package example
import "log"
func reportFailure(userID string) {
    log.Printf("authentication failed for user %s", userID)
}`,
  }).passes(),
  test('logging a patient diagnosis violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/health.go': `package example
import "log"
func reportVisit(patientID, diagnosis string) {
    log.Printf("visit failed for patient %s", patientID)
    log.Printf("patient diagnosis: %s", diagnosis)
}`,
  }).violates(),
  test('logging a credential through slog violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/auth.go': `package example
import "log/slog"
func reportFailure(token string) {
    slog.Error("authentication failed", "token", token)
}`,
  }).violates(),
  test('logging a credential through a slog context method violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/auth.go': `package example
import (
    "context"
    "log/slog"
)
func reportFailure(ctx context.Context, token string) {
    slog.ErrorContext(ctx, "authentication failed", "token", token)
}`,
  }).violates(),
  test('logging through an aliased standard logger violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/auth.go': `package example
import appLog "log"
func reportFailure(token string) {
    appLog.Fatalf("authentication failed: token=%s", token)
}`,
  }).violates(),
  test('logging through a named standard logger violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/health.go': `package example
import (
    "log"
    "os"
)
func reportVisit(diagnosis string) {
    audit := log.New(os.Stderr, "audit: ", 0)
    audit.Printf("patient diagnosis: %s", diagnosis)
}`,
  }).violates(),
  test('logging sensitive data through a structured logger violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/billing.go': `package example
import "go.uber.org/zap"
func reportCharge(logger *zap.SugaredLogger, cardNumber string) {
    logger.Infow("charge failed", "card_number", cardNumber)
}`,
  }).violates(),
  test('logging routine diagnostics through slog passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/request.go': `package example
import "log/slog"
func reportFailure(requestID string, status int) {
    slog.Info("request failed", "request_id", requestID, "status", status)
}`,
  }).passes(),
  test('logging sensitive data after visible redaction passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/200/health.go': `package example
import "log"
func redact(value string) string { return "[redacted]" }
func reportVisit(diagnosis string) {
    log.Printf("patient diagnosis: %s", redact(diagnosis))
}`,
  }).passes(),
] as const;
