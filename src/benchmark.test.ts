import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  collectVerifications,
  parseReport,
  updateReport,
  type ReportTable,
  type Verification,
} from '../scripts/benchmark.ts';
import { isolatedEnv, ROOT, startDecisionFixture, type DecisionFixture } from '../tests/support.ts';

const NOW = '2026-10-16T12:00:00.000Z';

const LATER = '2026-10-16T13:30:00.000Z';

const THIRD = '2026-10-16T15:05:00.000Z';

const PUBLIC_PROTO = '.rulekeeper/public-proto.yaml';

const MEMORY = '.rulekeeper/memory.yaml';

const DUPLICATED_ENV = '.rulekeeper/duplicated-env.yaml';

const SERVICE = 'tests/manual/proto/public/service.proto';

const PRODUCTION = 'tests/manual/production.yml';

const COMPLIANT = 'tests/manual/compliant.yml';

const MEMORY_SCOPE = `scope ${PRODUCTION} 0:/app/container/resources`;

const COMPLIANT_SCOPE = `scope ${COMPLIANT} 0:/app/container/resources`;

const DUPLICATED_ENV_GROUP = 'group folder tests/manual';

const PROJECT_FIXTURE: readonly (readonly [path: string, contents: string])[] = [
  ['.rulekeeper/duplicated-env.yaml', `version: 'v1'
files:
  included:
    - tests/manual/*.yml
scope:
  format: yaml
  path: $.*.env.text
filter:
  all:
    - non_empty: $.data.*
decision:
  group_by: folder
check:
  rule: No env override may redundantly repeat a default value. Defaults are the variable-name/value entries of every scope in default.yml. Every scope in every other file is an override. An override violates the rule when it has a variable with the SAME NAME and SAME VALUE as a default. One such override anywhere makes the whole group noncompliant, regardless of other variables, scopes or files. New variable names and changed values are allowed. Do not compare defaults with themselves.
  examples:
    good:
      - "default.yml {A:one,B:two}; production.yml {A:changed}; staging.yml {B:changed} => compliant: no override repeats a default."
      - "default.yml {A:one,B:two}; production.yml scopes [{A:changed},{B:changed}] => compliant."
    bad:
      - "default.yml {A:one,B:two}; production.yml {A:changed}; staging.yml {B:two} => violation: staging.yml repeats B=two."
      - "default.yml {A:one,B:two}; production.yml scopes [{A:changed},{B:two}] => violation: the second scope repeats B=two."
  violation-message: Env var is overriden with the default value, so we can remove it.
`],
  ['.rulekeeper/memory.yaml', `version: 'v1'
files:
  included:
    - tests/manual/*.yml
scope:
  format: yaml
  path: $.*.container.resources
filter:
  all:
    - non_empty: $.data.requests.memory
    - non_empty: $.data.limits.memory
check:
  rule: Memory limit must be less than or equal to memory request * 1.5. Compare both values in the same units.
  examples:
    good:
      - |
        # limit equals request, so the ratio is 1.0 and stays below 1.5x
          requests:
            memory: 512Mi
          limits:
            memory: 512Mi
      - |
        # limit is exactly 1.5x request, so the boundary is compliant
          requests:
            memory: 512Mi
          limits:
            memory: 768Mi
      - |
        # mixed units: 1536Mi is exactly 1.5x the 1Gi request
          requests:
            memory: 1Gi
          limits:
            memory: 1536Mi
    bad:
      - |
        # limit is 2x request, which exceeds 1.5x
          requests:
            memory: 512Mi
          limits:
            memory: 1Gi
  violation-message: Memory limit must not exceed 1.5 times the memory request.
`],
  ['.rulekeeper/public-proto.yaml', `version: 'v1'
files:
  included:
    - tests/manual/proto/public/*.proto
scope:
  format: protobuf
  path: $.rpcs[*].http.bindings[*].url
check:
  kind: regex
  rule: '^/v\\d+/[a-z][a-z0-9_]*s(?:/.*)?$'
  examples:
    good:
      - /v1/transactions
      - /v3/invoices
      - /v1/invoices/{invoice_id}
    bad:
      - /firstparty/v1/transactions
      - /api/v2/bank_accounts
      - /v1/invoice
      - transactions
  violation-message: Public endpoints must start with a version /vX/ followed by a resource in plural form.
`],
  ['tests/manual/default.yml', `global:
  env:
    text:
      LOG_LEVEL: info
      DB_NAME: my-app

app:
  container:
    tenv:
      text:
        LOG_LEVEL: debug
        DB_NAME: my-app
`],
  ['tests/manual/production.yml', `global:
  env:
    text:
      LOG_LEVEL: error

app:
  container:
    resources:
      requests:
        cpu: 100m
        memory: 64Mi
      limits:
        memory: 1Gi
`],
  ['tests/manual/compliant.yml', `app:
  container:
    resources:
      requests:
        memory: 128Mi
      limits:
        memory: 128Mi
`],
  ['tests/manual/proto/public/service.proto', `syntax = "proto3";

package acme.billing.v1;

service BillingService {
  rpc GetInvoice(GetInvoiceRequest) returns (GetInvoiceResponse) {
    option (google.api.http) = {
      get: "/v1/invoices/{invoice_id}"
    };
  }

  rpc StreamInvoices(StreamInvoicesRequest) returns (StreamInvoicesResponse);

  rpc CreateInvoice(CreateInvoiceRequest) returns (CreateInvoiceResponse) {
    option (google.api.http) = {
      post: "/v1/invoices"
      additional_bindings {
        get: "/public/v1/invoices/{invoice_id}/items"
      }
    };
  }
}`],
];

function scopeDecision(
  filepath: string,
  scopeId: string,
  probability: number,
  model: string,
  follows: boolean,
): unknown {
  return { filepath, scopeId, follows, probability, model };
}

function groupDecision(
  type: string,
  path: string,
  members: readonly { readonly filepath: string; readonly scopeId: string }[],
  probability: number,
  model: string,
  follows: boolean,
): unknown {
  return { group: { type, path }, members, follows, probability, model };
}

function ruleEntry(ruleFile: string, decisions: readonly unknown[]): unknown {
  return {
    ruleFile: join(ROOT, ruleFile),
    name: basename(ruleFile, '.yaml'),
    rule: 'rule text',
    examples: { good: [], bad: [] },
    contexts: [],
    decisions,
  };
}

function verify(...entries: readonly unknown[]): Verification[] {
  return collectVerifications(entries, ROOT);
}

function tableLines(report: string): string[] {
  return report.split('\n').filter(line => line.startsWith('|'));
}

function cellsByRow(table: ReportTable): Record<string, readonly string[]> {
  const cells: Record<string, readonly string[]> = {};
  for (const row of table.rows) cells[`${row.rule} :: ${row.verification}`] = row.cells;
  return cells;
}

test('collects every decision as its raw probability, model and reported verdict', () => {
  const verifications = verify(
    ruleEntry(PUBLIC_PROTO, [
      scopeDecision(SERVICE, '0:/rpcs/0/http/bindings/0/url', 1, 'regex', true),
      scopeDecision(SERVICE, '0:/rpcs/2/http/bindings/1/url', 0, 'regex', false),
    ]),
    ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.3865123456789, 'jev-1.13', true)]),
    ruleEntry(DUPLICATED_ENV, [
      groupDecision(
        'folder',
        'tests/manual',
        [
          { filepath: 'tests/manual/default.yml', scopeId: '0:/global/env/text' },
          { filepath: 'tests/manual/production.yml', scopeId: '0:/global/env/text' },
        ],
        0.4881,
        'jev-latest',
        true,
      ),
    ]),
  );

  assert.deepEqual(verifications, [
    { rule: PUBLIC_PROTO, verification: `scope ${SERVICE} 0:/rpcs/0/http/bindings/0/url`, score: '1 (regex) PASS' },
    { rule: PUBLIC_PROTO, verification: `scope ${SERVICE} 0:/rpcs/2/http/bindings/1/url`, score: '0 (regex) VIOLATION' },
    { rule: MEMORY, verification: MEMORY_SCOPE, score: '0.3865123456789 (jev-1.13) PASS' },
    { rule: DUPLICATED_ENV, verification: DUPLICATED_ENV_GROUP, score: '0.4881 (jev-latest) PASS' },
  ]);
});

test('labels rules by repository-relative path so equal stems stay distinct', () => {
  const verifications = verify(
    ruleEntry('.rulekeeper/regex.yaml', [scopeDecision('tests/manual/default.yml', '0:/global/env/text', 1, 'regex', true)]),
    ruleEntry('tests/rules/regex.yaml', [scopeDecision('tests/manual/default.yml', '0:/global/env/text', 1, 'regex', true)]),
  );

  assert.deepEqual(
    verifications.map(verification => verification.rule),
    ['.rulekeeper/regex.yaml', 'tests/rules/regex.yaml'],
  );
});

test('reports the verdict the decision carried instead of re-deriving one from the probability', () => {
  const verifications = verify(
    ruleEntry(PUBLIC_PROTO, [
      scopeDecision(SERVICE, '0:/rpcs/0/http/bindings/0/url', 1, 'regex', true),
      scopeDecision(SERVICE, '0:/rpcs/2/http/bindings/1/url', 0, 'regex', false),
    ]),
    ruleEntry(MEMORY, [
      scopeDecision(PRODUCTION, '0:/app/container/resources', 0.2, 'jev-1.13', true),
      scopeDecision(COMPLIANT, '0:/app/container/resources', 0.9, 'jev-1.13', false),
    ]),
  );

  assert.deepEqual(
    verifications.map(verification => verification.score),
    ['1 (regex) PASS', '0 (regex) VIOLATION', '0.2 (jev-1.13) PASS', '0.9 (jev-1.13) VIOLATION'],
  );
});

test('refuses a decision whose verdict is not a boolean instead of guessing one', () => {
  const decisions: readonly unknown[] = [
    { filepath: PRODUCTION, scopeId: '0:/app/container/resources', probability: 0.9, model: 'jev-latest' },
    { filepath: PRODUCTION, scopeId: '0:/app/container/resources', probability: 0.9, model: 'jev-latest', follows: 'true' },
    { filepath: PRODUCTION, scopeId: '0:/app/container/resources', probability: 0.9, model: 'jev-latest', follows: 1 },
    { filepath: PRODUCTION, scopeId: '0:/app/container/resources', probability: 0.9, model: 'jev-latest', follows: null },
    { group: { type: 'folder', path: 'tests/manual' }, members: [], probability: 0.9, model: 'jev-latest' },
  ];

  for (const decision of decisions) {
    assert.throws(() => verify(ruleEntry(MEMORY, [decision])), /follows is not a boolean/, JSON.stringify(decision));
  }
});

test('writes one timestamped column for the first run', () => {
  const report = updateReport(
    undefined,
    verify(
      ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.3865123456789, 'jev-1.13', true)]),
      ruleEntry(PUBLIC_PROTO, [
        scopeDecision(SERVICE, 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url', 1, 'regex', true),
        scopeDecision(SERVICE, 'acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/url', 0, 'regex', false),
      ]),
    ),
    NOW,
  );

  assert.deepEqual(tableLines(report), [
    `| Rule | Verification | ${NOW} |`,
    '| --- | --- | --- |',
    `| ${MEMORY} | ${MEMORY_SCOPE} | 0.3865123456789 (jev-1.13) PASS |`,
    `| ${PUBLIC_PROTO} | scope ${SERVICE} acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/url | 0 (regex) VIOLATION |`,
    `| ${PUBLIC_PROTO} | scope ${SERVICE} acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url | 1 (regex) PASS |`,
  ]);
});

test('documents the command, the score, the missing marker and the rolling columns', () => {
  const report = updateReport(undefined, [], NOW);

  assert.ok(report.startsWith('# Rulekeeper benchmark\n'));
  assert.ok(report.includes('- Command: `node index.ts check tests/manual --rules .rulekeeper --json`'));
  assert.ok(report.includes('unrounded probability'));
  assert.ok(report.includes('`0.4881 (jev-latest) PASS`'));
  assert.ok(report.includes('`0 (regex) VIOLATION`'));
  assert.ok(report.includes('`—`'));
  assert.ok(report.includes('previous run'));
  assert.ok(report.includes('current run'));
  assert.ok(report.endsWith('| --- | --- | --- |\n'));
});

test('treats an empty report as no history', () => {
  const verifications = verify(
    ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.5, 'jev-latest', true)]),
  );

  assert.equal(updateReport('', verifications, NOW), updateReport(undefined, verifications, NOW));
  assert.equal(updateReport('  \n\n', verifications, NOW), updateReport(undefined, verifications, NOW));
});

test('keeps the previous column verbatim and appends the current run', () => {
  const first = updateReport(
    undefined,
    verify(
      ruleEntry(PUBLIC_PROTO, [scopeDecision(SERVICE, 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url', 1, 'regex', true)]),
      ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.3865, 'jev-latest', true)]),
    ),
    NOW,
  );
  const second = updateReport(
    first,
    verify(ruleEntry(PUBLIC_PROTO, [])),
    LATER,
  );

  assert.deepEqual(tableLines(second), [
    `| Rule | Verification | ${NOW} | ${LATER} |`,
    '| --- | --- | --- | --- |',
    `| ${MEMORY} | ${MEMORY_SCOPE} | 0.3865 (jev-latest) PASS | — |`,
    `| ${PUBLIC_PROTO} | scope ${SERVICE} acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url | 1 (regex) PASS | — |`,
  ]);
});

test('keeps a verdict-free historical cell verbatim and adds the verdict only to the new column', () => {
  const historical = [
    '# Rulekeeper benchmark',
    '',
    `| Rule | Verification | ${NOW} |`,
    '| --- | --- | --- |',
    `| ${MEMORY} | ${MEMORY_SCOPE} | 0.3865 (jev-latest) |`,
    '',
  ].join('\n');
  const rolled = updateReport(
    historical,
    verify(ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.7, 'jev-latest', false)])),
    LATER,
  );

  assert.deepEqual(tableLines(rolled), [
    `| Rule | Verification | ${NOW} | ${LATER} |`,
    '| --- | --- | --- | --- |',
    `| ${MEMORY} | ${MEMORY_SCOPE} | 0.3865 (jev-latest) | 0.7 (jev-latest) VIOLATION |`,
  ]);
});

test('marks a verification the previous run never reported', () => {
  const first = updateReport(
    undefined,
    verify(ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.5, 'jev-latest', true)])),
    NOW,
  );
  const second = updateReport(
    first,
    verify(
      ruleEntry(PUBLIC_PROTO, [scopeDecision(SERVICE, 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url', 1, 'regex', true)]),
      ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.5, 'jev-latest', true)]),
    ),
    LATER,
  );

  assert.deepEqual(tableLines(second), [
    `| Rule | Verification | ${NOW} | ${LATER} |`,
    '| --- | --- | --- | --- |',
    `| ${MEMORY} | ${MEMORY_SCOPE} | 0.5 (jev-latest) PASS | 0.5 (jev-latest) PASS |`,
    `| ${PUBLIC_PROTO} | scope ${SERVICE} acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url | — | 1 (regex) PASS |`,
  ]);
});

test('rolls to two columns and drops a row no recent run reported', () => {
  const first = updateReport(
    undefined,
    verify(
      ruleEntry(PUBLIC_PROTO, [scopeDecision(SERVICE, 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url', 1, 'regex', true)]),
      ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.5, 'jev-latest', true)]),
    ),
    NOW,
  );
  const second = updateReport(
    first,
    verify(ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.6, 'jev-latest', true)])),
    LATER,
  );
  const third = updateReport(
    second,
    verify(ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.7, 'jev-latest', true)])),
    THIRD,
  );

  assert.deepEqual(tableLines(third), [
    `| Rule | Verification | ${LATER} | ${THIRD} |`,
    '| --- | --- | --- | --- |',
    `| ${MEMORY} | ${MEMORY_SCOPE} | 0.6 (jev-latest) PASS | 0.7 (jev-latest) PASS |`,
  ]);
  assert.ok(!third.includes(NOW));
});

test('keys rows by rule and verification, not by report order', () => {
  const publicProto = ruleEntry(PUBLIC_PROTO, [
    scopeDecision(SERVICE, 'acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url', 1, 'regex', true),
  ]);
  const memory = ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.5, 'jev-latest', true)]);
  const reordered = updateReport(updateReport(undefined, verify(memory, publicProto), NOW), verify(publicProto, memory), LATER);

  assert.deepEqual(tableLines(reordered), [
    `| Rule | Verification | ${NOW} | ${LATER} |`,
    '| --- | --- | --- | --- |',
    `| ${MEMORY} | ${MEMORY_SCOPE} | 0.5 (jev-latest) PASS | 0.5 (jev-latest) PASS |`,
    `| ${PUBLIC_PROTO} | scope ${SERVICE} acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url | 1 (regex) PASS | 1 (regex) PASS |`,
  ]);
});

test('keeps a grouped verification distinct from a scope verification', () => {
  const report = updateReport(
    undefined,
    verify(
      ruleEntry(DUPLICATED_ENV, [
        groupDecision('folder', 'tests/manual', [], 0.4, 'jev-latest', false),
        scopeDecision('tests/manual', 'folder', 0.6, 'jev-latest', true),
      ]),
    ),
    NOW,
  );

  assert.deepEqual(tableLines(report).slice(2), [
    `| ${DUPLICATED_ENV} | group folder tests/manual | 0.4 (jev-latest) VIOLATION |`,
    `| ${DUPLICATED_ENV} | scope tests/manual folder | 0.6 (jev-latest) PASS |`,
  ]);
});

test('escapes table breaks and round-trips them through a rerun', () => {
  const scopeId = '0:/a<&b>`c`\nd';
  const verifications = verify(
    ruleEntry('.rulekeeper/odd|name.yaml', [
      scopeDecision('tests/manual/pipe|file.yml', scopeId, 0.25, 'jev|latest', true),
    ]),
  );
  const first = updateReport(undefined, verifications, NOW);

  assert.deepEqual(tableLines(first), [
    `| Rule | Verification | ${NOW} |`,
    '| --- | --- | --- |',
    '| .rulekeeper/odd\\|name.yaml | scope tests/manual/pipe\\|file.yml "0:/a&lt;&amp;b&gt;\\`c\\`\\\\nd" | 0.25 (jev\\|latest) PASS |',
  ]);

  const parsed = parseReport(first);
  assert.deepEqual(parsed.columns, [NOW]);
  assert.deepEqual(parsed.rows.map(row => ({ rule: row.rule, verification: row.verification })), [
    {
      rule: '.rulekeeper/odd|name.yaml',
      verification: `scope tests/manual/pipe|file.yml ${JSON.stringify(scopeId)}`,
    },
  ]);
  assert.deepEqual(parsed.rows[0]?.cells, ['0.25 (jev|latest) PASS']);

  const second = updateReport(first, verifications, LATER);
  assert.deepEqual(tableLines(second), [
    `| Rule | Verification | ${NOW} | ${LATER} |`,
    '| --- | --- | --- | --- |',
    '| .rulekeeper/odd\\|name.yaml | scope tests/manual/pipe\\|file.yml "0:/a&lt;&amp;b&gt;\\`c\\`\\\\nd" | 0.25 (jev\\|latest) PASS | 0.25 (jev\\|latest) PASS |',
  ]);
});

test('keeps identities apart that a bare concatenation would merge', () => {
  const report = updateReport(
    undefined,
    verify(
      ruleEntry(MEMORY, [
        scopeDecision('tests/manual/a b.yml', 'c', 0.11, 'jev-latest', true),
        scopeDecision('tests/manual/a', 'b.yml c', 0.22, 'jev-latest', true),
      ]),
    ),
    NOW,
  );

  assert.deepEqual(tableLines(report).slice(2), [
    `| ${MEMORY} | scope "tests/manual/a b.yml" c | 0.11 (jev-latest) PASS |`,
    `| ${MEMORY} | scope tests/manual/a "b.yml c" | 0.22 (jev-latest) PASS |`,
  ]);
});

test('keeps a pipe inside a cell when backslashes precede it', () => {
  const filepath = 'tests/manual/odd\\|even\\\\|pipe.yml';
  const verifications = verify(ruleEntry(MEMORY, [scopeDecision(filepath, '0:/plain', 0.5, 'jev-latest', true)]));
  const first = updateReport(undefined, verifications, NOW);
  const table = parseReport(first);

  assert.deepEqual(table.rows.map(row => row.verification), [`scope ${JSON.stringify(filepath)} 0:/plain`]);
  assert.deepEqual(table.rows.map(row => row.cells), [['0.5 (jev-latest) PASS']]);

  const second = updateReport(first, verifications, LATER);
  assert.deepEqual(parseReport(second).rows.map(row => row.cells), [['0.5 (jev-latest) PASS', '0.5 (jev-latest) PASS']]);
});

test('refuses to keep a report it cannot read', () => {
  const reports = [
    '# Rulekeeper benchmark\n\n| Rule | Verification | 2026-10-16T12:00:00.000Z |\n| --- | --- | --- |\n| a.yaml | scope b c | 1 (regex) | extra |\n',
    '# Rulekeeper benchmark\n\n| Rule | Verification | 2026-10-16T12:00:00.000Z |\n| --- | --- | --- |\n| a.yaml | scope b \\q | 1 (regex) |\n',
    '# Rulekeeper benchmark\n\n| Rule | Verification | 2026-10-16T12:00:00.000Z |\n| --- | --- | --- |\n| a.yaml | | 1 (regex) |\n',
    '# Some other document\n\n| Rule | Verification | 2026-10-16T12:00:00.000Z |\n| --- | --- | --- |\n| a.yaml | scope b c | 1 (regex) |\n',
    '# Rulekeeper benchmark\n\nno table here\n',
    '# Rulekeeper benchmark\n\n| Rule | Verification |\n| --- | --- |\n| a.yaml | scope b c |\n',
    '# Rulekeeper benchmark\n\n| Rule | Verification | 2026-10-16T12:00:00.000Z |\n| --- | --- |\n| a.yaml | scope b c | 1 (regex) |\n',
  ];

  for (const report of reports) {
    assert.throws(() => updateReport(report, [], NOW), Error, report);
  }
});

interface BenchmarkRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runBenchmark(reportPath: string, env: NodeJS.ProcessEnv): Promise<BenchmarkRun> {
  const { promise, resolve, reject } = Promise.withResolvers<BenchmarkRun>();
  const child = spawn(process.execPath, [join(workspace, 'scripts', 'benchmark.ts'), reportPath], {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', reject);
  child.on('close', (status: number | null) => {
    resolve({ status, stdout, stderr });
  });
  return promise;
}

let workspace!: string;

let fixture!: DecisionFixture;

function seedProject(root: string): void {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'benchmark.ts'), join(root, 'scripts', 'benchmark.ts'));
  symlinkSync(join(ROOT, 'index.ts'), join(root, 'index.ts'));
  for (const [path, contents] of PROJECT_FIXTURE) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
}

before(async () => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'rulekeeper-benchmark-')));
  mkdirSync(join(workspace, 'home'), { recursive: true });
  seedProject(workspace);
  fixture = await startDecisionFixture();
});

after(async () => {
  await fixture.close();
  rmSync(workspace, { recursive: true, force: true });
});

function benchmarkEnv(): NodeJS.ProcessEnv {
  return { ...isolatedEnv(join(workspace, 'home')), ...fixture.env };
}

test('captures the manual corpus from the CLI and rolls one column per run', async () => {
  const reportPath = join(workspace, 'benchmarks', 'manual.md');
  fixture.reset();
  fixture.probability = 0.123456789;

  const first = await runBenchmark(reportPath, benchmarkEnv());
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');

  const table = parseReport(readFileSync(reportPath, 'utf8'));
  assert.equal(table.columns.length, 1);
  assert.deepEqual(cellsByRow(table), {
    [`${DUPLICATED_ENV} :: ${DUPLICATED_ENV_GROUP}`]: ['0.123456789 (testmodel) VIOLATION'],
    [`${MEMORY} :: ${MEMORY_SCOPE}`]: ['0.123456789 (testmodel) VIOLATION'],
    [`${MEMORY} :: ${COMPLIANT_SCOPE}`]: ['0.123456789 (testmodel) VIOLATION'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.CreateInvoice:/http/bindings/0/url`]: ['1 (regex) PASS'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/url`]: ['0 (regex) VIOLATION'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url`]: ['1 (regex) PASS'],
  });
  assert.equal(fixture.requests.length, 3);

  fixture.probability = 0.5;
  const second = await runBenchmark(reportPath, benchmarkEnv());
  assert.equal(second.status, 0, second.stderr);

  const rolled = parseReport(readFileSync(reportPath, 'utf8'));
  assert.equal(rolled.columns.length, 2);
  assert.equal(rolled.columns[0], table.columns[0]);
  assert.notEqual(rolled.columns[1], table.columns[0]);
  assert.deepEqual(cellsByRow(rolled), {
    [`${DUPLICATED_ENV} :: ${DUPLICATED_ENV_GROUP}`]: ['0.123456789 (testmodel) VIOLATION', '0.5 (testmodel) PASS'],
    [`${MEMORY} :: ${MEMORY_SCOPE}`]: ['0.123456789 (testmodel) VIOLATION', '0.5 (testmodel) PASS'],
    [`${MEMORY} :: ${COMPLIANT_SCOPE}`]: ['0.123456789 (testmodel) VIOLATION', '0.5 (testmodel) PASS'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.CreateInvoice:/http/bindings/0/url`]: ['1 (regex) PASS', '1 (regex) PASS'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/url`]: ['0 (regex) VIOLATION', '0 (regex) VIOLATION'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url`]: ['1 (regex) PASS', '1 (regex) PASS'],
  });
});

test('reports the verdict the CLI returned for another threshold instead of re-deriving one', async () => {
  const reportPath = join(workspace, 'threshold', 'manual.md');
  fixture.reset();
  fixture.probability = 0.5;

  const first = await runBenchmark(reportPath, benchmarkEnv());
  assert.equal(first.status, 0, first.stderr);
  const second = await runBenchmark(reportPath, { ...benchmarkEnv(), RK_THRESHOLD: '0.9' });
  assert.equal(second.status, 0, second.stderr);

  const table = parseReport(readFileSync(reportPath, 'utf8'));
  assert.equal(table.columns.length, 2);
  assert.deepEqual(cellsByRow(table), {
    [`${DUPLICATED_ENV} :: ${DUPLICATED_ENV_GROUP}`]: ['0.5 (testmodel) PASS', '0.5 (testmodel) VIOLATION'],
    [`${MEMORY} :: ${MEMORY_SCOPE}`]: ['0.5 (testmodel) PASS', '0.5 (testmodel) VIOLATION'],
    [`${MEMORY} :: ${COMPLIANT_SCOPE}`]: ['0.5 (testmodel) PASS', '0.5 (testmodel) VIOLATION'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.CreateInvoice:/http/bindings/0/url`]: ['1 (regex) PASS', '1 (regex) PASS'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.CreateInvoice:/http/bindings/1/url`]: ['0 (regex) VIOLATION', '0 (regex) VIOLATION'],
    [`${PUBLIC_PROTO} :: scope ${SERVICE} acme.billing.v1.BillingService.GetInvoice:/http/bindings/0/url`]: ['1 (regex) PASS', '1 (regex) PASS'],
  });
});

test('leaves the report untouched when the check fails', async () => {
  const reportPath = join(workspace, 'failed', 'manual.md');
  const seeded = updateReport(
    undefined,
    verify(ruleEntry(MEMORY, [scopeDecision(PRODUCTION, '0:/app/container/resources', 0.42, 'jev-latest', true)])),
    NOW,
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, seeded, 'utf8');

  fixture.reset();
  fixture.failFromRequest = 0;
  try {
    const failed = await runBenchmark(reportPath, benchmarkEnv());
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(reportPath, 'utf8'), seeded);
    assert.ok(failed.stderr.includes('benchmark:'), failed.stderr);
    assert.ok(failed.stderr.includes(reportPath), failed.stderr);
  } finally {
    fixture.failFromRequest = undefined;
  }
});
