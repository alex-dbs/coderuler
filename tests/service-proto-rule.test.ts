import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ServiceProto from '../.rulekeeper/service-proto.rule.ts';
import type { LoadedRule, Rule } from '../dist/index.js';
import { createProject } from '../dist/adapter/filesystem/project.js';
import { executeRules } from '../dist/app/execute.js';

const message = 'Service endpoints must start with a /service/vX/ followed by a resource in plural form.';

async function runServiceRule(fixture: string) {
  const loaded: LoadedRule = {
    name: 'service-proto',
    ruleFile: fileURLToPath(new URL('../.rulekeeper/service-proto.rule.ts', import.meta.url)),
    rule: new ServiceProto() as unknown as Rule<unknown>,
  };
  return executeRules([loaded], {
    project: createProject(fileURLToPath(new URL(`./fixtures/features/service-proto/${fixture}/`, import.meta.url))),
    isTarget: () => true,
    concurrency: 2,
    resolveDecision: () => {
      throw new Error('ServiceProto must not call the decision backend');
    },
  });
}

test('golden: real service rule checks the first resource with an offline regex', async () => {
  const reports = await runServiceRule('urls');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.status, 'violation');
  const expected = [
    ['/service/v1/transactions', 'pass'],
    ['/service/v3/invoices', 'pass'],
    ['/service/v2/accounts/invoices', 'pass'],
    ['/service/v3/devices/users', 'pass'],
    ['/service/v12/bank_accounts/{account_id}', 'pass'],
    ['/api/v2/bank_accounts', 'violation'],
    ['/internal/v1/invoices', 'violation'],
    ['/service/v2/accounting/invoices', 'violation'],
    ['/service/v3/device/users', 'violation'],
    ['/service/v1/billing/invoices/{invoice_id}', 'violation'],
    ['/service/v/invoices', 'violation'],
    ['/service/vX/invoices', 'violation'],
    ['/service/v1x/invoices', 'violation'],
    ['/service/v1/invoices_extra', 'violation'],
    ['/service/v1/invoices?active=true', 'violation'],
    ['/service/v1/', 'violation'],
    ['/service/v1/Invoices', 'violation'],
    ['/service/v1/status', 'pass'],
  ] as const;
  assert.deepEqual(
    reports[0]!.evaluations.map(({ subject, result }) => {
      assert.equal(subject.kind, 'scope');
      if (subject.kind !== 'scope') throw new Error('Expected a URL scope');
      return { filepath: subject.filepath, url: subject.data, result };
    }),
    expected.map(([url, status]) => ({
      filepath: 'tests/manual/proto/internal/service.proto',
      url,
      result: status === 'pass' ? { status } : { status, message },
    })),
  );
});

test('golden: real service rule skips RPCs without HTTP bindings', async () => {
  const reports = await runServiceRule('unannotated');
  assert.equal(reports.length, 1);
  assert.deepEqual(
    reports.map(({ status, reason, evaluations }) => ({ status, reason, evaluations })),
    [{ status: 'skipped', reason: 'no matching subjects', evaluations: [] }],
  );
});
