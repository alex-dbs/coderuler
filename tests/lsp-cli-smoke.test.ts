import assert from 'node:assert/strict';
import { cpSync, readFileSync, readdirSync } from 'node:fs';
import { after, test } from 'node:test';
import { join } from 'node:path';

import { createRubyLspFixture } from './ruby-lsp-support.ts';
import { createTypescriptLspFixture } from './typescript-lsp-support.ts';
import { createSandbox, ROOT, runCli, writeFile } from './support.ts';

const sandbox = createSandbox('coderuler-lsp-cli-');

after(() => sandbox.cleanup());

function fixture(label: string) {
  const target = sandbox.isolated(label);
  const source = join(ROOT, 'tests', 'fixtures', 'lsp');
  const project = join(source, 'project');
  for (const entry of readdirSync(project)) {
    cpSync(join(project, entry), join(target.cwd, entry), { recursive: true });
  }
  cpSync(join(source, 'project-dependency'), join(target.root, 'project-dependency'), { recursive: true });
  return target;
}

test('check uses the default Ruby LSP backend to resolve the Ruby fixture', async () => {
  const target = await createRubyLspFixture(sandbox.isolated('ruby-check'));
  const result = await runCli([
    'check', '.', '--rules', '.coderuler/ruby-definition.rule.ts', '--json', '--output-all',
  ], target);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"status":\s*"pass"/);
  assert.match(result.stdout, /Widget\.build/);
});

test('inspect uses the default Ruby LSP backend to resolve the Ruby fixture', async () => {
  const target = await createRubyLspFixture(sandbox.isolated('ruby-inspect'));
  const result = await runCli([
    'inspect', '.coderuler/ruby-definition.rule.ts', '.', '--json',
  ], target);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /"status":\s*"pass"/);
  assert.match(result.stdout, /Widget\.build/);
});

test('check reports the Ruby fixture violation for an unresolved widget', async () => {
  const target = await createRubyLspFixture(sandbox.isolated('ruby-check-violation'));
  const usagePath = join(target.cwd, 'lib', 'usage.rb');
  const usage = readFileSync(usagePath, 'utf8');
  assert.ok(usage.includes('Widget.build'), usage);
  writeFile(usagePath, usage.replace('Widget.build', 'UnknownWidget.build'));
  const result = await runCli([
    'check', '.', '--rules', '.coderuler/ruby-definition.rule.ts', '--json', '--output-all',
  ], target);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Widget must resolve to lib\/widget\.rb/);
});

test('test runs both Ruby fixture examples with their declared outcomes', async () => {
  const target = await createRubyLspFixture(sandbox.isolated('ruby-test'));
  const result = await runCli([
    'test', '.coderuler/ruby-definition.rule.ts', '--timeout', '60s',
  ], target);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.match(/^.*PASS.*$/gm)?.length, 2, result.stdout);
});

test('TypeScript LSP check uses the default backend to resolve the TypeScript fixture', async () => {
  const target = await createTypescriptLspFixture(sandbox.isolated('typescript-check'));
  const result = await runCli([
    'check', '.', '--rules', '.coderuler/typescript-definition.rule.ts', '--json', '--output-all',
  ], target);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"status":\s*"pass"/);
});

test('TypeScript LSP inspect uses the default backend to resolve the TypeScript fixture', async () => {
  const target = await createTypescriptLspFixture(sandbox.isolated('typescript-inspect'));
  const result = await runCli([
    'inspect', '.coderuler/typescript-definition.rule.ts', '.', '--json',
  ], target);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /"status":\s*"pass"/);
});

test('TypeScript LSP check reports the exact violation for an unresolved widget', async () => {
  const target = await createTypescriptLspFixture(sandbox.isolated('typescript-check-violation'));
  const usagePath = join(target.cwd, 'src', 'usage.ts');
  const usage = readFileSync(usagePath, 'utf8');
  assert.ok(usage.includes('new Widget()'), usage);
  writeFile(usagePath, usage.replace('new Widget()', 'new UnknownWidget()'));
  const result = await runCli([
    'check', '.', '--rules', '.coderuler/typescript-definition.rule.ts', '--json', '--output-all',
  ], target);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes('Widget must resolve to src/widget.ts'), result.stdout);
});

test('TypeScript LSP test reports both inline outcomes as passing cases', async () => {
  const target = await createTypescriptLspFixture(sandbox.isolated('typescript-test'));
  const result = await runCli([
    'test', '.coderuler/typescript-definition.rule.ts', '--timeout', '60s',
  ], target);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.match(/^.*PASS.*$/gm)?.length, 2, result.stdout);
  assert.ok(result.stdout.includes('Widget resolves to its definition'), result.stdout);
  assert.ok(result.stdout.includes('an unknown widget does not resolve'), result.stdout);
});

const offlineGo = {
  GOPROXY: 'off',
  GOWORK: 'off',
  GOTOOLCHAIN: 'local',
  GOTELEMETRY: 'off',
};

function assertTrace(output: string): void {
  assert.match(output, /Go LSP call graph/);
  assert.match(output, /Grandcaller:2/);
  assert.match(output, /Caller:1/);
  assert.match(output, /First:1/);
  assert.match(output, /Second:1/);
  assert.match(output, /Leaf:2/);
  assert.match(output, /Seed/);
}

test('check uses the default gopls backend and evaluates the Go fixture call graph', async () => {
  const target = fixture('check');
  const result = await runCli([
    'check', '.', '--rules', '.coderuler/lsp-context.rule.ts', '--json', '--output-all', '--debug',
  ], target, offlineGo);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /Go LSP call graph/);
  assert.match(result.stdout, /"status":\s*"pass"/);
});

test('inspect uses the default gopls backend and reports the same evaluated call graph', async () => {
  const target = fixture('inspect');
  const result = await runCli(['inspect', '.coderuler/lsp-context.rule.ts', '.', '--json'], target, offlineGo);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assertTrace(result.stdout);
  assert.match(result.stdout, /"status":\s*"pass"/);
});

test('check resolves Go definitions from a local dependency through context.goLsp', async () => {
  const target = fixture('definitions');
  const result = await runCli([
    'check', '.', '--rules', '.coderuler/go-external-definition.rule.ts', '--json', '--output-all', '--debug',
  ], target, offlineGo);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /Go dependency definition/);
  assert.match(result.stdout, /"status":\s*"pass"/);
});

test('criticalSave only allows CriticalServiceSave from service.go', async () => {
  const args = ['check', '.', '--rules', '.coderuler/go-critical-save-callers.rule.ts', '--json', '--output-all'];
  const allowed = await runCli(args, fixture('critical-save-allowed'), offlineGo);
  assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
  assert.match(allowed.stdout, /"status":\s*"pass"/);

  const target = fixture('critical-save-disallowed');
  writeFile(join(target.cwd, 'unexpected.go'), `package lspfixture

func Other() {
	criticalSave()
}
`);
  const disallowed = await runCli(args, target, offlineGo);
  assert.equal(disallowed.status, 1, disallowed.stderr || disallowed.stdout);
  assert.match(disallowed.stdout, /"status":\s*"violation"/);
  assert.match(disallowed.stdout, /unexpected\.go:Other/);
});
