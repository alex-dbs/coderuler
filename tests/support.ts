import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { textLineSpan } from '../src/plugins/lines.ts';

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
    if (name.startsWith('RK_')) continue;
    if (name.startsWith('TYPESAFE_')) continue;
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

export interface CliPresentationOptions {
  readonly json?: boolean;
}

function withDefaultJson(args: readonly string[], presentation: CliPresentationOptions): readonly string[] {
  if (args[0] !== 'check') return args;
  if (presentation.json === false) return args;
  if (args.includes('--json')) return args;
  return [...args, '--json'];
}

export function runCli(
  args: readonly string[],
  sandbox: Sandbox,
  overrides: NodeJS.ProcessEnv = {},
  presentation: CliPresentationOptions = {},
): Promise<CliResult> {
  const command = withDefaultJson(args, presentation);
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const env: NodeJS.ProcessEnv = { ...sandbox.env, ...overrides };
  for (const name of Object.keys(overrides)) {
    if (overrides[name] === undefined) delete env[name];
  }
  const child = spawn(process.execPath, [CLI, ...command], {
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
  return { filepath, scope: { id: '0:', source, data: parse(source), lines: textLineSpan(1, source) } };
}

export interface RuleFiles {
  readonly included: readonly string[];
  readonly excluded?: readonly string[];
}

export function yamlRule(name: string, rule: string, files: RuleFiles, filter?: readonly string[]): string {
  const lines = ["version: 'v1'", `name: '${name}'`, 'files:', '  included:'];
  for (const glob of files.included) lines.push(`    - '${glob}'`);
  if (files.excluded !== undefined) {
    lines.push('  excluded:');
    for (const glob of files.excluded) lines.push(`    - '${glob}'`);
  }
  lines.push('scope:', '  format: yaml', "  path: '$'");
  if (filter !== undefined) lines.push('filter:', ...filter);
  lines.push(`rule: '${rule}'`, '');
  return lines.join('\n');
}

const FIXTURE_PROBABILITY = 0.9;

const FIXTURE_MODEL = 'testmodel';

const FIXTURE_API_KEY = 'fixture-key';

function decisionPayload(probability: number): unknown {
  return {
    model: FIXTURE_MODEL,
    answers: { follows_instructions: { type: 'noul', noul: probability } },
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  };
}

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
      const payload = failed ? { error: 'fixture backend failure' } : decisionPayload(probability);
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
        TYPESAFE_BASE_URL: `http://127.0.0.1:${address.port}`,
        TYPESAFE_API_KEY: FIXTURE_API_KEY,
        TYPESAFE_DEFAULT_MODEL: FIXTURE_MODEL,
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

const SCHEDULING_QUIET_MS = 250;

const SCHEDULING_POLL_MS = 10;

const SCHEDULING_TIMEOUT_MS = 30_000;

export interface SchedulingRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly key: string;
}

export interface SchedulingAnswer {
  readonly probability?: number;
  readonly status?: number;
}

export interface SchedulingFixture {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requests: SchedulingRequest[];
  readonly active: number;
  readonly peak: number;
  readonly violations: number;
  limit: number | undefined;
  answer: (request: SchedulingRequest, index: number) => SchedulingAnswer;
  heldKeys(): string[];
  waitForRequests(count: number): Promise<void>;
  waitForSilence(): Promise<void>;
  release(key: string): void;
  releaseAll(): void;
  reset(): void;
  close(): Promise<void>;
}

interface HeldRequest {
  readonly request: SchedulingRequest;
  readonly response: ServerResponse;
}

function decisionKey(body: unknown): string {
  if (!isMapping(body)) return 'unidentified';
  const state = body.state;
  if (!isMapping(state)) return 'unidentified';
  const group = state.group;
  if (isMapping(group)) {
    const { type, path } = group;
    return typeof type === 'string' && typeof path === 'string' ? `group:${type}:${path}` : 'unidentified';
  }
  return typeof state.filepath === 'string' ? state.filepath : 'unidentified';
}

export function startSchedulingFixture(): Promise<SchedulingFixture> {
  const { promise, resolve, reject } = Promise.withResolvers<SchedulingFixture>();
  const requests: SchedulingRequest[] = [];
  const held: HeldRequest[] = [];
  const watchers = new Set<() => void>();
  let active = 0;
  let peak = 0;
  let violations = 0;
  let limit: number | undefined;
  let lastArrival = 0;
  let answerFn: SchedulingFixture['answer'] = () => ({ probability: FIXTURE_PROBABILITY });

  const respond = (entry: HeldRequest): void => {
    const { request, response } = entry;
    active -= 1;
    let answer: SchedulingAnswer;
    try {
      answer = answerFn(request, requests.indexOf(request));
    } catch {
      answer = { status: 502 };
    }
    const status = answer.status ?? 200;
    const payload = status >= 400 ? { error: 'fixture backend failure' } : decisionPayload(answer.probability ?? FIXTURE_PROBABILITY);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  const waitForRequests = (count: number): Promise<void> => {
    const { promise: waiting, resolve: settle, reject: fail } = Promise.withResolvers<void>();
    const deadline = Date.now() + SCHEDULING_TIMEOUT_MS;
    const stop = (): void => {
      clearInterval(poll);
      watchers.delete(check);
    };
    const check = (): void => {
      if (requests.length >= count && Date.now() - lastArrival >= SCHEDULING_QUIET_MS) {
        stop();
        settle();
        return;
      }
      if (Date.now() >= deadline) {
        stop();
        fail(new Error(`the run asked for ${requests.length} of ${count} expected decisions, then stopped`));
      }
    };
    const poll = setInterval(check, SCHEDULING_POLL_MS);
    watchers.add(check);
    check();
    return waiting;
  };

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
      const recorded: SchedulingRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
        key: decisionKey(body),
      };
      requests.push(recorded);
      held.push({ request: recorded, response });
      active += 1;
      peak = Math.max(peak, active);
      if (limit !== undefined && active > limit) violations += 1;
      lastArrival = Date.now();
      for (const check of [...watchers]) check();
    });
  });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('the scheduling fixture did not bind a loopback port'));
      return;
    }
    const fixture: SchedulingFixture = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: FIXTURE_API_KEY,
      model: FIXTURE_MODEL,
      env: {
        TYPESAFE_BASE_URL: `http://127.0.0.1:${address.port}`,
        TYPESAFE_API_KEY: FIXTURE_API_KEY,
        TYPESAFE_DEFAULT_MODEL: FIXTURE_MODEL,
      },
      requests,
      get active(): number {
        return active;
      },
      get peak(): number {
        return peak;
      },
      get violations(): number {
        return violations;
      },
      get limit(): number | undefined {
        return limit;
      },
      set limit(value: number | undefined) {
        limit = value;
      },
      get answer(): SchedulingFixture['answer'] {
        return answerFn;
      },
      set answer(value: SchedulingFixture['answer']) {
        answerFn = value;
      },
      heldKeys: () => held.map(entry => entry.request.key),
      waitForRequests,
      waitForSilence: () => waitForRequests(requests.length),
      release: (key) => {
        const index = held.findIndex(entry => entry.request.key === key);
        if (index < 0) {
          const waiting = held.map(entry => entry.request.key).join(', ');
          throw new Error(`no decision for ${key} is waiting; waiting on ${waiting}`);
        }
        respond(held.splice(index, 1)[0]!);
      },
      releaseAll: () => {
        for (const entry of held.splice(0, held.length)) respond(entry);
      },
      reset(): void {
        requests.length = 0;
        held.length = 0;
        active = 0;
        peak = 0;
        violations = 0;
        limit = undefined;
        answerFn = () => ({ probability: FIXTURE_PROBABILITY });
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
    };
    resolve(fixture);
  });
  return promise;
}
