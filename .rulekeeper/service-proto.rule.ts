import { Rule, ai, scopes, type AiOptions } from 'rulekeeper';

export const serviceProtoPolicy: AiOptions = {
  rule: `The URL must begin with \`/service/vX/\`, where X is a number. The one path segment immediately after this prefix must itself be a plural resource noun. A singular noun or an uncountable activity name in that position violates the rule. Do not skip to a later plural word. Further path segments are allowed only after this valid prefix.

Contrastive examples:
- /service/v2/accounts/invoices is valid: accounts is plural.
- /service/v2/accounting/invoices is invalid: accounting is not plural; later invoices does not fix it.
- /service/v3/devices/users is valid: devices is plural.
- /service/v3/device/users is invalid: device is singular; later users does not fix it.
- /service/v1/transactions is valid.
- /service/v3/invoices is valid.
- /api/v2/bank_accounts and /internal/v1/invoices are invalid: wrong prefix.
`,
  violationMessage: 'Service endpoints must start with a /service/vX/ followed by a resource in plural form.',
};

export default class ServiceProto extends Rule {
  files = ['tests/manual/proto/internal/*.proto'];

  scope = scopes.protobuf({ path: '$.rpcs[*].http.bindings[*].url' });

  check = ai(serviceProtoPolicy);
}
