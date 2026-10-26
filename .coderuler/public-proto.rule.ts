import { Rule, regex, scopes, test } from '@alex-dbs/coderuler';

export default class PublicProto extends Rule {
  files = ['tests/manual/proto/public/*.proto'];

  scope = scopes.protobuf({ path: "$.rpcs[*].options['google.api.http']..['get','put','post','delete','patch','path']" });

  check = regex({
    pattern: /^\/v\d+\/[a-z][a-z0-9_]*s(?:\/.*)?$/,
    violationMessage: 'Public endpoints must start with a version /vX/ .',
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
  test('versioned lowercase plural resources and subpaths pass').withFiles({
    'tests/manual/proto/public/service.proto': proto('/v1/invoices', '/v12/bank_accounts/{account_id}/transactions'),
  }).passes(),
  ...([
    ['public prefix', '/public/v1/invoices'],
    ['internal service prefix', '/service/v1/invoices'],
    ['missing version', '/invoices'],
    ['invalid version', '/vX/invoices'],
    ['singular resource', '/v1/invoice'],
    ['uppercase resource', '/v1/Invoices'],
  ] as const).map(([name, url]) =>
    test(`${name} violates`).withFiles({
      'tests/manual/proto/public/service.proto': proto(url),
    }).violates(),
  ),
  test('a later invalid additional binding violates after valid bindings').withFiles({
    'tests/manual/proto/public/service.proto': proto('/v1/invoices', '/v2/accounts/{account_id}', '/public/v1/invoices'),
  }).violates(),
  test('a custom binding path is checked').withFiles({
    'tests/manual/proto/public/service.proto': `syntax = "proto3";
service BillingService {
  rpc ListInvoices(Request) returns (Response) {
    option (google.api.http) = { custom { kind: "HEAD" path: "/public/v1/invoices" } };
  }
}`,
  }).violates(),
] as const;
