import { Rule, regex, scopes } from 'rulekeeper';

export default class ServiceProto extends Rule {
  files = ['tests/manual/proto/internal/*.proto'];

  scope = scopes.protobuf({ path: '$.rpcs[*].http.bindings[*].url' });

  check = regex({
    pattern: /^\/service\/v\d+\/[a-z][a-z0-9_]*s(?:\/.*)?$/,
    violationMessage: 'Service endpoints must start with a /service/vX/ .',
  });
}
