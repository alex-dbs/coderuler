import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CLI = join(ROOT, 'index.ts');

export const GOLDEN_ROOT = join(ROOT, 'tests', 'golden');

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CheckEntry {
  readonly ruleFile: string;
  readonly name: string;
  readonly rule: string;
  readonly examples: unknown;
  readonly contexts: readonly unknown[];
  readonly decisions: readonly CheckDecision[];
}

export interface CheckGroupMember {
  readonly filepath: string;
  readonly scopeId: string;
}

export interface CheckScopeDecision extends CheckGroupMember {
  readonly follows: boolean;
  readonly probability: number;
  readonly model: string;
}

export interface CheckGroupDecision {
  readonly group: { readonly type: 'file' | 'folder' | 'project'; readonly path: string };
  readonly members: readonly CheckGroupMember[];
  readonly follows: boolean;
  readonly probability: number;
  readonly model: string;
}

export type CheckDecision = CheckScopeDecision | CheckGroupDecision;

const GROUP_TYPES: Record<string, true> = { file: true, folder: true, project: true };

export interface Sandbox {
  readonly cwd: string;
  readonly home: string;
  readonly rules: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface SandboxRoot {
  readonly root: string;
  isolated(label: string): Sandbox;
  cleanup(): void;
}

function withoutInheritedOverrides(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(source)) {
    if (name.startsWith('GIT_')) continue;
    if (name.startsWith('RULEKEEPER_DECISION_')) continue;
    if (name === 'TYPESAFE_API_KEY') continue;
    if (name.toLowerCase().endsWith('proxy')) continue;
    env[name] = source[name];
  }
  return env;
}

export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...withoutInheritedOverrides(process.env),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: join(home, '.gitconfig-system'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Rulekeeper Test',
    GIT_AUTHOR_EMAIL: 'rulekeeper@example.invalid',
    GIT_COMMITTER_NAME: 'Rulekeeper Test',
    GIT_COMMITTER_EMAIL: 'rulekeeper@example.invalid',
    LC_ALL: 'C',
  };
}

export function createSandbox(prefix: string, overrides: NodeJS.ProcessEnv = {}): SandboxRoot {
  // Canonicalize the root: on macOS the temporary directory is reached through a symlink
  // (`/var` → `/private/var`), and the children report resolved paths, so an expectation built from
  // the un-resolved path would name a different directory than the one a child actually sees.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  let sequence = 0;
  return {
    root,
    isolated(label: string): Sandbox {
      const base = join(root, `${label}-${sequence++}`);
      const cwd = join(base, 'project');
      const home = join(base, 'home');
      const rules = join(base, 'rules');
      for (const path of [cwd, home, rules]) mkdirSync(path, { recursive: true });
      return { cwd, home, rules, env: { ...isolatedEnv(home), ...overrides } };
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function runCli(args: readonly string[], sandbox: Sandbox, overrides: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const env: NodeJS.ProcessEnv = { ...sandbox.env, ...overrides };
  for (const name of Object.keys(overrides)) {
    if (overrides[name] === undefined) delete env[name];
  }
  const child = spawn(process.execPath, [CLI, ...args], {
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

export function writeFile(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

export function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  return value;
}

function toGroupMember(value: unknown, where: string): CheckGroupMember {
  if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
  return {
    filepath: requireString(value.filepath, `${where}.filepath`),
    scopeId: requireString(value.scopeId, `${where}.scopeId`),
  };
}

function toGroup(value: unknown, where: string): CheckGroupDecision['group'] {
  if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
  const type = requireString(value.type, `${where}.type`);
  if (GROUP_TYPES[type] !== true) throw new Error(`${where}.type must be file, folder or project`);
  return { type: type as CheckGroupDecision['group']['type'], path: requireString(value.path, `${where}.path`) };
}

function toDecision(value: unknown, where: string): CheckDecision {
  if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
  const follows = value.follows;
  if (typeof follows !== 'boolean') throw new Error(`${where}.follows must be a boolean`);
  const probability = value.probability;
  if (typeof probability !== 'number') throw new Error(`${where}.probability must be a number`);
  const model = requireString(value.model, `${where}.model`);

  if (value.group !== undefined || value.members !== undefined) {
    if (value.filepath !== undefined || value.scopeId !== undefined) {
      throw new Error(`${where} must not mix a group decision with a scope decision`);
    }
    const members = value.members;
    if (!Array.isArray(members)) throw new Error(`${where}.members must be an array`);
    return {
      group: toGroup(value.group, `${where}.group`),
      members: members.map((member: unknown, index: number) => toGroupMember(member, `${where}.members[${index}]`)),
      follows,
      probability,
      model,
    };
  }

  return {
    filepath: requireString(value.filepath, `${where}.filepath`),
    scopeId: requireString(value.scopeId, `${where}.scopeId`),
    follows,
    probability,
    model,
  };
}

export function toCheckEntry(value: unknown, where: string): CheckEntry {
  if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
  const contexts = value.contexts;
  if (!Array.isArray(contexts)) throw new Error(`${where}.contexts must be an array`);
  const decisions = value.decisions;
  if (!Array.isArray(decisions)) throw new Error(`${where}.decisions must be an array`);
  return {
    ruleFile: requireString(value.ruleFile, `${where}.ruleFile`),
    name: requireString(value.name, `${where}.name`),
    rule: requireString(value.rule, `${where}.rule`),
    examples: value.examples,
    contexts,
    decisions: decisions.map((decision: unknown, index: number) => toDecision(decision, `${where}.decisions[${index}]`)),
  };
}

export function entries(result: CliResult, label: string): CheckEntry[] {
  assert.strictEqual(result.status, 0, `${label}: expected success (stderr: ${result.stderr})`);
  const payload: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload), `${label}: expected the check output to be a JSON array`);
  return payload.map((entry: unknown, index: number) => toCheckEntry(entry, `${label}[${index}]`));
}

export function soleEntry(result: CliResult, label: string): CheckEntry {
  const list = entries(result, label);
  assert.strictEqual(list.length, 1, `${label}: expected exactly one rule entry`);
  return list[0]!;
}

export function assertFailed(result: CliResult, label: string): void {
  assert.ok(result.status !== null && result.status > 0, `${label}: expected a nonzero exit status`);
  assert.strictEqual(result.stdout, '', `${label}: expected no partial output on stdout`);
  assert.notStrictEqual(result.stderr.trim(), '', `${label}: expected an actionable message on stderr`);
}

export function fileContext(filepath: string, source: string): unknown {
  return { filepath, scope: { id: '0:', source, data: parse(source) } };
}

const FIXTURE_PROBABILITY = 0.9;

const FIXTURE_MODEL = 'testmodel';

const FIXTURE_API_KEY = 'fixture-key';

export interface DecisionFixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface DecisionFixture {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requests: DecisionFixtureRequest[];
  probability: number;
  failFromRequest: number | undefined;
  reset(): void;
  close(): Promise<void>;
}

export function startDecisionFixture(): Promise<DecisionFixture> {
  const { promise, resolve, reject } = Promise.withResolvers<DecisionFixture>();
  const requests: DecisionFixtureRequest[] = [];
  let probability = FIXTURE_PROBABILITY;
  let failFromRequest: number | undefined;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });
      const failed = failFromRequest !== undefined && requests.length - 1 >= failFromRequest;
      const payload = failed
        ? { error: 'fixture backend failure' }
        : {
            model: FIXTURE_MODEL,
            answers: { follows_instructions: { type: 'noul', noul: probability } },
            usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
          };
      response.writeHead(failed ? 500 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('the decision fixture did not bind a loopback port'));
      return;
    }
    resolve({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: FIXTURE_API_KEY,
      model: FIXTURE_MODEL,
      env: {
        RULEKEEPER_DECISION_BASE_URL: `http://127.0.0.1:${address.port}`,
        RULEKEEPER_DECISION_API_KEY: FIXTURE_API_KEY,
        RULEKEEPER_DECISION_MODEL: FIXTURE_MODEL,
      },
      requests,
      get probability(): number {
        return probability;
      },
      set probability(value: number) {
        probability = value;
      },
      get failFromRequest(): number | undefined {
        return failFromRequest;
      },
      set failFromRequest(value: number | undefined) {
        failFromRequest = value;
      },
      reset(): void {
        requests.length = 0;
        probability = FIXTURE_PROBABILITY;
        failFromRequest = undefined;
      },
      close(): Promise<void> {
        const stopped = Promise.withResolvers<void>();
        server.close(error => {
          if (error === undefined) stopped.resolve();
          else stopped.reject(error);
        });
        // A child that was killed mid-request can leave its socket open; closing it unblocks close().
        server.closeAllConnections();
        return stopped.promise;
      },
    });
  });
  return promise;
}
