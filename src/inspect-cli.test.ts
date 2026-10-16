import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  CLI,
  assertFailed,
  createSandbox,
  isMapping,
  runCli,
  startDecisionFixture,
  writeFile,
  yamlRule,
  type CliResult,
  type DecisionFixture,
  type Sandbox,
  type SandboxRoot,
} from '../tests/support.ts';

const SCRIPT = '/usr/bin/script';

const PTY_AVAILABLE = process.platform === 'darwin' && existsSync(SCRIPT);

const COLORABLE_TERMINAL: NodeJS.ProcessEnv = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  CI: undefined,
  NO_COLOR: undefined,
  NODE_DISABLE_COLORS: undefined,
  FORCE_COLOR: undefined,
};

function assertPlain(result: CliResult, label: string): void {
  assert.doesNotMatch(result.stdout, /\u001b/, `${label}: stdout must stay free of terminal control`);
  assert.doesNotMatch(result.stderr, /\u001b/, `${label}: stderr must stay free of terminal control`);
}

function assertSafeText(result: CliResult, label: string): void {
  assert.doesNotMatch(
    result.stdout,
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/,
    `${label}: stdout must not carry raw control characters`,
  );
  assert.doesNotMatch(result.stdout, /[\u{1F000}-\u{1FAFF}]/u, `${label}: the walkthrough must not print emoji`);
}

function verificationBlocks(stdout: string): readonly string[] {
  const starts = [...stdout.matchAll(/^[ ]+Verification \d+ of \d+$/gm)].map(match => match.index ?? 0);
  return starts.map((start, position) => stdout.slice(start, starts[position + 1] ?? stdout.length));
}

function jsonSection(block: string, from: string, to: string): unknown {
  const start = block.indexOf(from);
  const end = block.indexOf(to, start + from.length);
  assert.ok(start >= 0, `a verification block must print ${from}`);
  assert.ok(end > start, `a verification block must print ${to} after ${from}`);
  return JSON.parse(block.slice(block.indexOf('\n', start) + 1, block.lastIndexOf('\n', end)));
}

function requestFilepath(body: unknown): string {
  if (!isMapping(body)) throw new Error('the printed request body must be an object');
  const state = body.state;
  if (!isMapping(state)) throw new Error('the printed request body must carry a state');
  const filepath = state.filepath;
  if (typeof filepath !== 'string') throw new Error('the printed request body must carry a string state.filepath');
  return filepath;
}

function requestScope(body: unknown): string {
  if (!isMapping(body)) throw new Error('the printed request body must be an object');
  const state = body.state;
  if (!isMapping(state)) throw new Error('the printed request body must carry a state');
  const scope = state.scope;
  if (!isMapping(scope)) throw new Error('the printed request body must carry a state.scope');
  const id = scope.id;
  if (typeof id !== 'string') throw new Error('the printed request body must carry a string state.scope.id');
  return id;
}

function groupMemberIds(body: unknown): readonly string[] {
  if (!isMapping(body)) throw new Error('the printed group request must be an object');
  const state = body.state;
  if (!isMapping(state)) throw new Error('the printed group request must carry a state');
  const files = state.files;
  if (!Array.isArray(files) || files.length !== 1) throw new Error('a file group must carry exactly its own file');
  const file = files[0];
  if (!isMapping(file) || !Array.isArray(file.scopes)) throw new Error('a file group must carry its member scopes');
  return file.scopes.map(scope => {
    if (!isMapping(scope) || typeof scope.id !== 'string') throw new Error('a member scope must carry a string id');
    return scope.id;
  });
}

function answeredModel(body: unknown): unknown {
  return isMapping(body) ? body.model : undefined;
}

function answeredProbability(body: unknown): unknown {
  if (!isMapping(body)) throw new Error('the printed answer must be an object');
  const answers = body.answers;
  if (!isMapping(answers)) throw new Error('the printed answer must carry answers');
  const answer = answers.follows_instructions;
  if (!isMapping(answer)) throw new Error('the printed answer must carry the follows_instructions answer');
  return answer.noul;
}

interface RuleOptions {
  readonly included: readonly string[];
  readonly path: string;
  readonly key?: string;
  readonly filter?: readonly string[];
  readonly grouping?: string;
}

function ruleText(options: RuleOptions): string {
  const lines = ["version: 'v1'", 'files:', '  included:'];
  for (const glob of options.included) lines.push(`    - '${glob}'`);
  lines.push('scope:', '  format: yaml', `  path: '${options.path}'`);
  if (options.key !== undefined) lines.push(`  key: '${options.key}'`);
  if (options.filter !== undefined) lines.push('filter:', ...options.filter);
  if (options.grouping !== undefined) lines.push('decision:', `  group_by: ${options.grouping}`);
  lines.push('check:', "  rule: 'Review the selected scopes.'", '');
  return lines.join('\n');
}

interface RawReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

interface RawBackend {
  readonly env: NodeJS.ProcessEnv;
  readonly requests: string[];
  answer(reply: RawReply): void;
  close(): Promise<void>;
}

function startRawBackend(): Promise<RawBackend> {
  const requests: string[] = [];
  let reply: RawReply = { status: 200, contentType: 'application/json', body: '' };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(reply.status, { 'content-type': reply.contentType });
      response.end(reply.body);
    });
  });
  const started = Promise.withResolvers<RawBackend>();
  server.on('error', started.reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      started.reject(new Error('the raw decision backend did not bind a loopback port'));
      return;
    }
    started.resolve({
      env: {
        TYPESAFE_BASE_URL: `http://127.0.0.1:${address.port}`,
        TYPESAFE_API_KEY: 'raw-key',
        TYPESAFE_DEFAULT_MODEL: 'rawmodel',
      },
      requests,
      answer(next: RawReply): void {
        reply = next;
      },
      close(): Promise<void> {
        const stopped = Promise.withResolvers<void>();
        server.close(error => {
          if (error === undefined) stopped.resolve();
          else stopped.reject(error);
        });
        server.closeAllConnections();
        return stopped.promise;
      },
    });
  });
  return started.promise;
}

function runCliOnPty(args: readonly string[], sandbox: Sandbox, overrides: NodeJS.ProcessEnv): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...sandbox.env, ...overrides };
  for (const name of Object.keys(overrides)) {
    if (overrides[name] === undefined) delete env[name];
  }
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const child = spawn(SCRIPT, ['-q', '/dev/null', process.execPath, CLI, ...args], {
    cwd: sandbox.cwd,
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

let backend!: DecisionFixture;
let sandbox!: SandboxRoot;

before(async () => {
  backend = await startDecisionFixture();
  sandbox = createSandbox('rulekeeper-inspect-cli-', backend.env);
});

after(async () => {
  sandbox.cleanup();
  await backend.close();
});

test('inspect walks a rule filepath and pairs every printed request with its answer', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-path');
  const rulePath = writeFile(
    join(project.rules, 'review.yaml'),
    yamlRule('Review every service block.', { included: ['src/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'service: {name: alpha}\n');
  writeFile(join(project.cwd, 'src/b.yaml'), 'service: {name: beta}\n');

  const result = await runCli(['inspect', rulePath], project);

  assert.strictEqual(result.status, 0, `inspect expected success (stderr: ${result.stderr})`);
  assertPlain(result, 'inspect walkthrough');
  assertSafeText(result, 'inspect walkthrough');
  assert.ok(result.stdout.includes(rulePath), 'the walkthrough must name the resolved rule file');
  assert.match(result.stdout, /1\. Rule\n/);
  assert.match(result.stdout, /2\. Files\n/);
  assert.match(result.stdout, /3\. Verifications\n/);
  assert.match(result.stdout, /4\. Summary\n/);
  assert.match(result.stdout, /all scopes kept/);
  assert.match(result.stdout, /scope id 0:/, 'each kept scope must be listed with its scope id');
  assert.match(result.stdout, /Verdict\s+PASS/);
  assert.doesNotMatch(result.stdout, /\u2026/, 'the walkthrough must never truncate');

  const blocks = verificationBlocks(result.stdout);
  assert.strictEqual(blocks.length, 2, 'one verification block per selected scope');
  assert.deepStrictEqual(
    blocks.map(block => jsonSection(block, 'Request', 'Response')),
    backend.requests.map(entry => entry.body),
    'each block must print the exact request the backend received, in order',
  );
  const files = blocks.map(block => requestFilepath(jsonSection(block, 'Request', 'Response'))).sort();
  assert.deepStrictEqual(files, ['src/a.yaml', 'src/b.yaml'], 'requests must carry paths logical to the working folder');

  for (const block of blocks) {
    assert.match(block, /HTTP 200, raw body as received/);
    const answer = jsonSection(block, 'Response', 'Result');
    assert.strictEqual(answeredModel(answer), backend.model);
    assert.strictEqual(answeredProbability(answer), backend.probability);
    assert.match(block, /Result\s+PASS {2}probability 0\.9 {2}model testmodel/);
  }
  assert.strictEqual(backend.requests.length, 2, 'each selected scope must be decided once');
  backend.reset();
});

test('inspect resolves a rule name inside the working folder and roots paths there', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-name');
  const nested = join(project.cwd, 'sub');
  const rulePath = writeFile(
    join(nested, '.rulekeeper/inner.yaml'),
    ruleText({ included: ['src/**/*.yaml'], path: '$' }),
  );
  writeFile(
    join(project.cwd, '.rulekeeper/outer.yaml'),
    ruleText({ included: ['src/**/*.yaml'], path: '$' }),
  );
  writeFile(join(nested, 'src/a.yaml'), 'service: {name: alpha}\n');

  const result = await runCli(['inspect', 'inner', 'sub'], project);

  assert.strictEqual(result.status, 0, `named rule expected success (stderr: ${result.stderr})`);
  assert.ok(result.stdout.includes(rulePath), 'the walkthrough must name the discovered rule file');
  assert.ok(!result.stdout.includes('outer.yaml'), 'a rule outside the working folder must not be inspected');
  assert.ok(result.stdout.includes('src/a.yaml'), 'logical paths must be relative to the working folder');
  assert.strictEqual(backend.requests.length, 1, 'one selected scope means one request');
  const blocks = verificationBlocks(result.stdout);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(requestFilepath(jsonSection(blocks[0]!, 'Request', 'Response')), 'src/a.yaml');
  backend.reset();
});

test('inspect separates kept scopes from partially and fully filtered files', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-filter');
  const rulePath = writeFile(
    join(project.rules, 'items.yaml'),
    ruleText({
      included: ['src/**/*.yaml'],
      path: '$.items[*]',
      key: '$.id',
      filter: ["  non_empty: '$.data.name'"],
    }),
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'items:\n  - {id: a, name: alpha}\n  - {id: b}\n');
  writeFile(join(project.cwd, 'src/c.yaml'), 'items:\n  - {id: c}\n');

  const result = await runCli(['inspect', rulePath], project);

  assert.strictEqual(result.status, 0, `filtered walkthrough expected success (stderr: ${result.stderr})`);
  assertPlain(result, 'filtered walkthrough');
  assert.match(result.stdout, /src\/a\.yaml {2}partially filtered {2}\(2 scopes: 1 kept, 1 filtered\)/);
  assert.match(result.stdout, /src\/c\.yaml {2}fully filtered {2}\(1 scope: 0 kept, 1 filtered\)/);
  assert.doesNotMatch(result.stdout, /all scopes kept/, 'a filtered file must never look like a kept file');
  assert.match(result.stdout, /kept\s+src\/a\.yaml:\d+-\d+\s+scope id 0:a/);
  assert.match(result.stdout, /filtered\s+src\/a\.yaml:\d+-\d+\s+scope id 0:b/);
  assert.match(result.stdout, /filtered\s+src\/c\.yaml:\d+-\d+\s+scope id 0:c/);
  assert.match(result.stdout, /filtered scopes are removed after scope selection and never decided/);
  assert.match(result.stdout, /Scopes\s+3 selected, 1 kept, 2 filtered/);
  assert.match(result.stdout, /Verifications\s+1 ran: 1 PASS/);
  assert.match(result.stdout, /Verdict\s+PASS/);

  const blocks = verificationBlocks(result.stdout);
  assert.strictEqual(blocks.length, 1, 'only the kept scope may be decided');
  assert.strictEqual(requestScope(jsonSection(blocks[0]!, 'Request', 'Response')), '0:a');
  assert.strictEqual(backend.requests.length, 1, 'a filtered scope must never reach the backend');
  backend.reset();
});

test('inspect sends one request per group with every member scope and one per scope otherwise', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-group');
  const grouped = writeFile(
    join(project.rules, 'grouped.yaml'),
    ruleText({ included: ['src/**/*.yaml'], path: '$.items[*]', key: '$.id', grouping: 'file' }),
  );
  const perScope = writeFile(
    join(project.rules, 'per-scope.yaml'),
    ruleText({ included: ['src/**/*.yaml'], path: '$.items[*]', key: '$.id' }),
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'items:\n  - {id: a}\n  - {id: b}\n');
  writeFile(join(project.cwd, 'src/c.yaml'), 'items:\n  - {id: c}\n  - {id: d}\n');

  const groupedResult = await runCli(['inspect', grouped], project);

  assert.strictEqual(groupedResult.status, 0, `grouped walkthrough expected success (stderr: ${groupedResult.stderr})`);
  const groupedBlocks = verificationBlocks(groupedResult.stdout);
  assert.strictEqual(groupedBlocks.length, 2, 'a grouped rule sends one request per group');
  for (const [index, block] of groupedBlocks.entries()) {
    assert.match(block, /Context\s+group per file src\/[ac]\.yaml/);
    assert.match(block, /Members\s+2 scopes in 1 file/);
    for (const id of index === 0 ? ['0:a', '0:b'] : ['0:c', '0:d']) {
      assert.ok(block.includes(`scope id ${id}`), `the group must list member ${id}`);
    }
  }
  assert.deepStrictEqual(
    groupedBlocks.map(block => jsonSection(block, 'Request', 'Response')),
    backend.requests.map(entry => entry.body),
    'each grouped block must print its own group request',
  );
  const members = backend.requests.map(entry => {
    const ids = groupMemberIds(entry.body);
    assert.strictEqual(ids.length, 2, 'every member scope of the group must be sent');
    return [...ids].sort().join(',');
  });
  assert.deepStrictEqual([...members].sort(), ['0:a,0:b', '0:c,0:d']);

  backend.reset();
  const scopeResult = await runCli(['inspect', perScope], project);

  assert.strictEqual(scopeResult.status, 0, `ungrouped walkthrough expected success (stderr: ${scopeResult.stderr})`);
  assert.strictEqual(verificationBlocks(scopeResult.stdout).length, 4, 'an ungrouped rule sends one request per scope');
  assert.strictEqual(backend.requests.length, 4, 'each scope must be decided on its own');
  assert.match(scopeResult.stdout, /Verification 4 of 4/);
  backend.reset();
});

test('inspect explains a rule with nothing to verify and needs no backend key', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-nothing');
  writeFile(join(project.cwd, 'src/a.yaml'), 'service: {name: alpha}\n');
  const noFiles = writeFile(
    join(project.rules, 'no-files.yaml'),
    yamlRule('Review nothing.', { included: ['absent/**/*.yaml'] }),
  );
  const noScopes = writeFile(
    join(project.rules, 'no-scopes.yaml'),
    ruleText({ included: ['src/**/*.yaml'], path: '$.items[*]' }),
  );
  const keyless: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: undefined };

  const filesResult = await runCli(['inspect', noFiles], project, keyless);

  assert.strictEqual(filesResult.status, 0, `no eligible file must not need a key (stderr: ${filesResult.stderr})`);
  assert.match(filesResult.stdout, /no file under the working root matched the rule's files\.included patterns/);
  assert.match(filesResult.stdout, /NO VERIFICATION RAN/);
  assert.match(filesResult.stdout, /3\. Verifications/);
  assert.match(filesResult.stdout, /no request was sent to the decision backend/);

  const scopesResult = await runCli(['inspect', noScopes], project, keyless);

  assert.strictEqual(scopesResult.status, 0, `no selected scope must not need a key (stderr: ${scopesResult.stderr})`);
  assert.match(scopesResult.stdout, /src\/a\.yaml {2}no scope matches/);
  assert.match(scopesResult.stdout, /none of the 1 eligible file matched a scope/);
  assert.match(scopesResult.stdout, /NO VERIFICATION RAN/);
  assert.doesNotMatch(scopesResult.stdout, /Verification 1 of/);
  assert.strictEqual(backend.requests.length, 0, 'nothing to verify must never reach the backend');
});

test('inspect identifies disabled rules without scanning or requesting a decision in plain and terminal output', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-disabled');
  const rulePath = writeFile(
    join(project.rules, 'disabled.yaml'),
    `${yamlRule('Review the service.', { included: ['src/**/*.yaml'] })}enabled: false\n`,
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'broken: [\n');
  const unusedConfiguration: NodeJS.ProcessEnv = {
    TYPESAFE_API_KEY: undefined,
    TYPESAFE_BASE_URL: 'not a URL',
    RK_THRESHOLD: 'invalid',
  };

  const plain = await runCli(['inspect', rulePath], project, { ...unusedConfiguration, NO_COLOR: '1' });
  const reports = [plain];
  assertPlain(plain, 'disabled walkthrough');
  if (PTY_AVAILABLE) {
    reports.push(await runCliOnPty(['inspect', rulePath], project, { ...COLORABLE_TERMINAL, ...unusedConfiguration }));
  }

  for (const result of reports) {
    assert.strictEqual(result.status, 0, `disabled walkthrough expected success (stderr: ${result.stderr})`);
    assert.match(result.stdout, /DISABLED/);
    assert.match(result.stdout, /no source file was scanned/);
    assert.match(result.stdout, /no verification ran/);
    assert.doesNotMatch(result.stdout, /PASS|compliant|no scope matches|no file under the working root matched/);
    assert.doesNotMatch(result.stdout, /Verification 1 of|Request\s+serialized body/);
  }
  assert.strictEqual(backend.requests.length, 0, 'a disabled rule must never reach the backend');
});

test('inspect prints an HTTP error answer without inventing a decision', async () => {
  backend.reset();
  backend.failFromRequest = 0;
  const project = sandbox.isolated('inspect-failure');
  const rulePath = writeFile(
    join(project.rules, 'review.yaml'),
    yamlRule('Review the service.', { included: ['src/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'service: {name: alpha}\n');

  const result = await runCli(['inspect', rulePath], project);

  assert.ok(result.status !== null && result.status > 0, 'a backend failure must exit nonzero');
  assert.notStrictEqual(result.stderr.trim(), '', 'the failure must be reported on stderr');
  assert.match(result.stdout, /HTTP 500, raw body as received/);
  assert.match(result.stdout, /"fixture backend failure"/);
  assert.match(result.stdout, /Result\s+ERROR/);
  assert.doesNotMatch(result.stdout, /PASS/, 'a failed verification must never look like a verdict');
  assert.doesNotMatch(result.stdout, /4\. Summary/, 'a failed walkthrough must not claim a summary');
  assertPlain(result, 'failed walkthrough');
  assert.strictEqual(backend.requests.length, 1);
  backend.reset();

  const refused = await runCli(['inspect', rulePath], project, { TYPESAFE_BASE_URL: 'http://127.0.0.1:1' });

  assert.ok(refused.status !== null && refused.status > 0, 'a refused connection must exit nonzero');
  assert.notStrictEqual(refused.stderr.trim(), '', 'a refused connection must be reported on stderr');
  assert.match(refused.stdout, /Request\s+serialized body sent to the backend/);
  assert.doesNotMatch(refused.stdout, /Response\s+HTTP/, 'a transport failure must never print a response');
  assert.match(refused.stdout, /no HTTP response was received for this request/);
  assert.match(refused.stdout, /Result\s+ERROR/);
});

test('inspect escapes non-JSON answers and prints no credential or control byte', async () => {
  const raw = await startRawBackend();
  try {
    const project = sandbox.isolated('inspect-raw');
    const rulePath = writeFile(
      join(project.rules, 'review.yaml'),
      yamlRule('Review the service.', { included: ['src/**/*.yaml'] }),
    );
    writeFile(join(project.cwd, 'src/a.yaml'), 'service: {name: alpha}\n');

    raw.answer({ status: 401, contentType: 'text/plain', body: 'raw-key denied \u001b[31mred\u001b[39m' });
    const unauthorized = await runCli(['inspect', rulePath], project, raw.env);

    assert.ok(unauthorized.status !== null && unauthorized.status > 0, 'a 401 must exit nonzero');
    assert.match(unauthorized.stdout, /HTTP 401, raw body as received/);
    assert.match(unauthorized.stdout, /"\[REDACTED\] denied \\u001b\[31mred\\u001b\[39m"/);
    assert.match(unauthorized.stdout, /Result\s+ERROR/);
    assertPlain(unauthorized, 'non-JSON answer');
    assert.doesNotMatch(unauthorized.stdout, /raw-key/, 'the configured key must never be printed');
    assert.strictEqual(raw.requests.length, 1);

    raw.answer({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        model: 'ok\u009fmodel',
        note: 'before\u009b31mafter',
        answers: { follows_instructions: { type: 'noul', noul: 0.9 } },
      }),
    });
    const accepted = await runCli(['inspect', rulePath], project, raw.env);

    assert.strictEqual(accepted.status, 0, `raw JSON answer expected success (stderr: ${accepted.stderr})`);
    assertSafeText(accepted, 'raw JSON answer');
    assert.match(accepted.stdout, /\\u009f/);
    assert.doesNotMatch(accepted.stdout, /\u009f/, 'a raw C1 byte must be escaped, never printed');
    const shown = jsonSection(verificationBlocks(accepted.stdout)[0]!, 'Response', 'Result');
    assert.ok(isMapping(shown));
    assert.strictEqual(shown.note, 'before\u009b31mafter', 'escaping must preserve the response value');
    assert.match(accepted.stdout, /Result\s+PASS {2}probability 0\.9 {2}model okmodel/);

    raw.answer({ status: 200, contentType: 'application/json', body: '' });
    const empty = await runCli(['inspect', rulePath], project, raw.env);

    assert.ok(empty.status !== null && empty.status > 0, 'a decision response with no body must fail');
    assert.match(empty.stdout, /HTTP 200, raw body as received/);
    assert.match(empty.stdout, /(""|\(empty body\))/);
    assert.match(empty.stdout, /Result\s+ERROR/);
  } finally {
    await raw.close();
  }
});

test('inspect keeps paths and JSON intact when the terminal is narrow or output is redirected', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-narrow');
  const rulePath = writeFile(
    join(project.rules, 'review.yaml'),
    yamlRule('Review the service.', { included: ['src/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'service: {name: alpha}\n');

  const result = await runCli(['inspect', rulePath], project, { COLUMNS: '20', LINES: '10' });

  assert.strictEqual(result.status, 0, `narrow walkthrough expected success (stderr: ${result.stderr})`);
  assertPlain(result, 'narrow walkthrough');
  assert.ok(result.stdout.includes(rulePath), 'the rule path must not be clipped at a narrow width');
  const blocks = verificationBlocks(result.stdout);
  assert.strictEqual(blocks.length, 1);
  const request = jsonSection(blocks[0]!, 'Request', 'Response');
  assert.strictEqual(requestFilepath(request), 'src/a.yaml');
  assert.deepStrictEqual(request, backend.requests[0]?.body, 'the whole request body must survive a narrow width');
  assert.doesNotMatch(result.stdout, /\u2026/, 'nothing may be truncated');
  backend.reset();
});

test('inspect colors statuses only on a color-capable terminal', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-color');
  const rulePath = writeFile(
    join(project.rules, 'review.yaml'),
    yamlRule('Review the service.', { included: ['src/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'service: {name: alpha}\n');

  const forced = await runCli(['inspect', rulePath], project, { NO_COLOR: undefined, FORCE_COLOR: '1' });

  assert.strictEqual(forced.status, 0, `forced color expected success (stderr: ${forced.stderr})`);
  assert.match(forced.stdout, /\u001b\[/, 'a color-capable terminal must get styled statuses');
  assert.match(forced.stdout, /Rulekeeper inspect/);
  assert.match(forced.stdout, /PASS/);

  const disabled = await runCli(['inspect', rulePath], project, { FORCE_COLOR: undefined, NO_COLOR: '1' });

  assert.strictEqual(disabled.status, 0, `NO_COLOR expected success (stderr: ${disabled.stderr})`);
  assertPlain(disabled, 'NO_COLOR');
  assert.match(disabled.stdout, /PASS/);

  if (PTY_AVAILABLE) {
    const terminal = await runCliOnPty(['inspect', rulePath], project, COLORABLE_TERMINAL);

    assert.strictEqual(terminal.status, 0, `terminal walkthrough expected success (stderr: ${terminal.stderr})`);
    assert.match(terminal.stdout, /\u001b\[/, 'a real terminal must get styled statuses');
    assert.match(terminal.stdout, /Rulekeeper inspect/);

    const muted = await runCliOnPty(['inspect', rulePath], project, { ...COLORABLE_TERMINAL, NO_COLOR: '1' });

    assert.strictEqual(muted.status, 0, `NO_COLOR terminal walkthrough expected success (stderr: ${muted.stderr})`);
    assertPlain(muted, 'NO_COLOR terminal');
    assert.match(muted.stdout, /Rulekeeper inspect/);
    assert.match(muted.stdout, /PASS/);
  }
  backend.reset();
});

test('inspect rejects a duplicate name, an unknown name, a directory and a missing path', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-invalid');
  writeFile(join(project.cwd, '.rulekeeper/one.yaml'), yamlRule('First review.', { included: ['src/**/*.yaml'] }));
  writeFile(
    join(project.cwd, '.rulekeeper/nested/one.yaml'),
    yamlRule('Second review.', { included: ['src/**/*.yaml'] }),
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'service: {name: alpha}\n');

  const duplicate = await runCli(['inspect', 'one'], project);

  assertFailed(duplicate, 'duplicate rule name');
  const duplicateOutput = `${duplicate.stdout}${duplicate.stderr}`;
  assert.ok(
    duplicateOutput.includes(join(project.cwd, '.rulekeeper/nested/one.yaml')),
    'the duplicate error must list the first candidate path',
  );
  assert.ok(
    duplicateOutput.includes(join(project.cwd, '.rulekeeper/one.yaml')),
    'the duplicate error must list the second candidate path',
  );

  const unknown = await runCli(['inspect', 'No such rule'], project);

  assertFailed(unknown, 'unknown rule name');
  assert.ok(`${unknown.stdout}${unknown.stderr}`.includes('No such rule'));

  const directory = await runCli(['inspect', project.rules], project);

  assertFailed(directory, 'directory rule argument');
  assert.ok(`${directory.stdout}${directory.stderr}`.includes(project.rules));

  const missing = await runCli(['inspect', join(project.cwd, 'absent.yaml')], project);

  assertFailed(missing, 'missing rule path');

  const noArgument = await runCli(['inspect'], project);

  assertFailed(noArgument, 'missing rule argument');
  assert.strictEqual(backend.requests.length, 0, 'an invalid invocation must never reach the backend');
});

test('inspect strips control characters out of rule names and violation messages', async () => {
  backend.reset();
  const project = sandbox.isolated('inspect-control');
  const rulePath = writeFile(
    join(project.rules, 'Esc \u001b[31mreview.yaml'),
    `${yamlRule('Review the service.', { included: ['src/**/*.yaml'] })}  violation-message: "Tab\\tand\\u009fbreak"\n`,
  );
  writeFile(join(project.cwd, 'src/a.yaml'), 'service: {name: alpha}\n');

  const result = await runCli(['inspect', rulePath], project);

  assert.strictEqual(result.status, 0, `control walkthrough expected success (stderr: ${result.stderr})`);
  assertPlain(result, 'control walkthrough');
  assertSafeText(result, 'control walkthrough');
  assert.match(result.stdout, /Name\s+Esc review/);
  assert.ok(result.stdout.includes('Esc review.yaml'), 'the rule file path must be sanitized the same way');
  assert.match(result.stdout, /Message\s+Tabandbreak/);
  assert.strictEqual(backend.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(backend.requests[0]?.body), /Tab|violationMessage|violation-message/);
  backend.reset();
});
