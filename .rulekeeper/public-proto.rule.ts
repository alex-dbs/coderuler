import { Rule, regex, scopes, type RegexOptions } from 'rulekeeper';

export const publicProtoCheck: RegexOptions = {
  pattern: /^\/v\d+\/[a-z][a-z0-9_]*s(?:\/.*)?$/,
  violationMessage: 'Public endpoints must start with a version /vX/ followed by a resource in plural form.',
};

export default class PublicProto extends Rule {
  files = ['tests/manual/proto/public/*.proto'];

  scope = scopes.protobuf({ path: '$.rpcs[*].http.bindings[*].url' });

  check = regex(publicProtoCheck);
}
