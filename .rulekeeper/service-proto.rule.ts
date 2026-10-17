import { Rule, regex, scopes, test } from 'rulekeeper';

export default class ServiceProto extends Rule {
  files = ['tests/manual/proto/internal/*.proto'];

  scope = scopes.protobuf({ path: '$.rpcs[*].http.bindings[*].url' });

  check = regex({
    pattern: /^\/service\/v\d+\/[a-z][a-z0-9_]*s(?:\/.*)?$/,
    violationMessage: 'Service endpoints must start with a /service/vX/ .',
  });
}

function proto(url: string, ...additionalUrls: string[]) {
  return `syntax = "proto3";
import "google/api/annotations.proto";
package acme.billing.v1;
message Request {}
message Response {}
service BillingService {
  rpc ListInvoices(Request) returns (Response) {
    option (google.api.http) = {
      get: "${url}"
      ${additionalUrls.map(binding => `additional_bindings { get: "${binding}" }`).join('\n      ')}
    };
  }
}`;
}

export const tests = [
  test('service versions, lowercase plural resources, and subpaths pass').withFiles({
    'tests/manual/proto/internal/service.proto': proto(
      '/service/v1/invoices',
      '/service/v12/bank_accounts/{account_id}/transactions',
    ),
  }).passes(),
  ...([
    ['public endpoint', '/v1/invoices'],
    ['wrong internal prefix', '/internal/v1/invoices'],
    ['missing version', '/service/invoices'],
    ['invalid version', '/service/vX/invoices'],
    ['singular resource', '/service/v1/invoice'],
    ['uppercase resource', '/service/v1/Invoices'],
  ] as const).map(([name, url]) =>
    test(`${name} violates`).withFiles({
      'tests/manual/proto/internal/service.proto': proto(url),
    }).violates(),
  ),
  test('a later invalid additional binding violates after valid bindings').withFiles({
    'tests/manual/proto/internal/service.proto': proto(
      '/service/v1/invoices',
      '/service/v2/accounts/{account_id}',
      '/v1/invoices',
    ),
  }).violates(),
] as const;
