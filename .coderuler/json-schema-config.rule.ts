import Ajv from 'ajv';
import { Rule, pass, scopes, test, violation } from '@alex-dbs/coderuler';
import type { Evaluator, ScopeSubject } from '@alex-dbs/coderuler';

const validateConfig = new Ajv().compile({
  type: 'object',
  properties: { port: { type: 'integer', minimum: 1, maximum: 65535 } },
  required: ['port'],
});

export default class JsonSchemaConfig extends Rule {
  files = ['config/**/*.json'];
  scope = scopes.json();

  check: Evaluator = subject => {
    const { data } = subject as ScopeSubject;
    if (validateConfig(data)) return pass();
    const error = validateConfig.errors?.[0];
    const path = error?.instancePath || '/';
    const message = error?.message ?? 'invalid value';
    return violation(`${path}: ${message}`);
  };
}

export const tests = [
  test('an integer port passes').withFiles({
    'config/app.json': { port: 8080 },
  }).passes(),
  test('the largest valid port passes').withFiles({
    'config/app.json': { port: 65535 },
  }).passes(),
  test('a string port violates').withFiles({
    'config/app.json': { port: '8080' },
  }).violates(),
  test('a missing port violates').withFiles({
    'config/app.json': {},
  }).violates(),
  test('a port above the valid range violates').withFiles({
    'config/app.json': { port: 65536 },
  }).violates(),
] as const;
