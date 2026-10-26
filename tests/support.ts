import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CheckServices,
  CliContext,
  CliServices,
  DependencyServices,
  InspectServices,
  SkillServices,
  TestServices,
  UpdateServices,
  ValidateServices,
} from '../dist/adapter/cli/services.js';
import type { AiUsage } from '../dist/index.js';

export type CliLoadOverrides = {
  readonly check?: Partial<CheckServices>;
  readonly inspect?: Partial<InspectServices>;
  readonly test?: Partial<TestServices>;
  readonly validate?: Partial<ValidateServices>;
  readonly update?: Partial<UpdateServices>;
  readonly skill?: Partial<SkillServices>;
  readonly deps?: Partial<DependencyServices>;
};

export function withLoadOverrides(services: CliServices, overrides: CliLoadOverrides): CliServices {
  return {
    ...services,
    load: {
      check: async (context: CliContext) => ({ ...await services.load.check(context), ...overrides.check }),
      inspect: async (context: CliContext) => ({ ...await services.load.inspect(context), ...overrides.inspect }),
      test: async (context: CliContext) => ({ ...await services.load.test(context), ...overrides.test }),
      validate: async (context: CliContext) => ({ ...await services.load.validate(context), ...overrides.validate }),
      update: async (context: CliContext) => ({ ...await services.load.update(context), ...overrides.update }),
      skill: async (context: CliContext) => ({ ...await services.load.skill(context), ...overrides.skill }),
      deps: async (context: CliContext) => ({ ...await services.load.deps(context), ...overrides.deps }),
    },
  };
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CLI = join(ROOT, 'dist', 'cli.js');
export const UNREPORTED_AI_USAGE: AiUsage = {
  calls: 1, unreportedCalls: 1, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0,
};

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliRun extends Promise<CliResult> {
  terminate(): void;
}

export interface Sandbox {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface SandboxRoot {
  readonly root: string;
  isolated(label: string, overrides?: NodeJS.ProcessEnv): Sandbox;
  cleanup(): void;
}

const SANDBOX_PACKAGE = `${JSON.stringify({ name: 'sandbox-project', private: true, type: 'module' }, null, 2)}\n`;

function withoutInheritedOverrides(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('RK_') || name.startsWith('TYPESAFE_')) continue;
    if (name.toLowerCase().endsWith('proxy')) continue;
    env[name] = value;
  }
  return env;
}

export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...withoutInheritedOverrides(process.env),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    LC_ALL: 'C',
    NO_COLOR: '1',
  };
}

function linkSdk(base: string): void {
  const link = join(base, 'node_modules', '@alex-dbs/coderuler');
  mkdirSync(dirname(link), { recursive: true });
  if (!existsSync(link)) symlinkSync(ROOT, link, 'dir');
}

function linkHomeSdk(sandbox: Sandbox): void {
  if (!existsSync(join(sandbox.home, '.coderuler'))) return;
  linkSdk(sandbox.home);
}

export function createSandbox(prefix: string, overrides: NodeJS.ProcessEnv = {}): SandboxRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  let sequence = 0;
  return {
    root,
    isolated(label: string, extra: NodeJS.ProcessEnv = {}): Sandbox {
      const base = join(root, `${label}-${sequence++}`);
      const cwd = join(base, 'project');
      const home = join(base, 'home');
      for (const path of [cwd, home]) mkdirSync(path, { recursive: true });
      writeFileSync(join(cwd, 'package.json'), SANDBOX_PACKAGE, 'utf8');
      linkSdk(cwd);
      return { root: base, cwd, home, env: { ...isolatedEnv(home), ...overrides, ...extra } };
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function runCli(
  args: readonly string[],
  sandbox: Sandbox,
  overrides: NodeJS.ProcessEnv = {},
): CliRun {
  const { promise, resolve: settle, reject } = Promise.withResolvers<CliResult>();
  const env: NodeJS.ProcessEnv = { ...sandbox.env, ...overrides };
  for (const name of Object.keys(overrides)) {
    if (overrides[name] === undefined) delete env[name];
  }
  linkHomeSdk(sandbox);
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
    settle({ status, stdout, stderr });
  });
  return Object.assign(promise, {
    terminate(): void {
      child.kill('SIGKILL');
    },
  });
}

export function writeFile(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

export function makeDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function makeSymlink(path: string, target: string): string {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return path;
}

export function listTree(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      entries.push(relative(root, path).split(sep).join('/'));
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return entries;
}

export function asMapping(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  return value;
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number') throw new Error(`${where} must be a number`);
  return value;
}

interface ViolationLocationShape {
  readonly filepath: string;
  readonly scopeId?: string;
  readonly lines?: { readonly start: number; readonly end: number };
}

export interface CheckResultShape {
  readonly status: 'pass' | 'violation';
  readonly message?: string;
  readonly probability?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly usage?: AiUsage;
  readonly locations?: readonly ViolationLocationShape[];
}

export interface ScopeSubjectShape {
  readonly kind: 'scope';
  readonly filepath: string;
  readonly id: string;
  readonly source: string;
  readonly data?: unknown;
  readonly captures?: unknown;
  readonly lines?: { readonly start: number; readonly end: number };
}

export interface GroupSubjectShape {
  readonly kind: 'group';
  readonly group: { readonly type: 'file' | 'folder' | 'project'; readonly path: string };
  readonly members: readonly ScopeSubjectShape[];
}

export type SubjectShape = ScopeSubjectShape | GroupSubjectShape;

export interface CheckEvaluationShape {
  readonly subject: SubjectShape;
  readonly result: CheckResultShape;
}

export interface CheckReportShape {
  readonly name: string;
  readonly ruleFile: string;
  readonly status: 'pass' | 'violation' | 'skipped';
  readonly durationMs: number;
  readonly reason?: string;
  readonly evaluations: readonly CheckEvaluationShape[];
}

function toViolationLocation(value: unknown, where: string): ViolationLocationShape {
  const mapping = asMapping(value, where);
  const filepath = asString(mapping['filepath'], `${where}.filepath`);
  if (filepath.length === 0) throw new Error(`${where}.filepath must not be empty`);
  const location: { filepath: string; scopeId?: string; lines?: { start: number; end: number } } = { filepath };
  if (mapping['scopeId'] !== undefined) {
    const scopeId = asString(mapping['scopeId'], `${where}.scopeId`);
    if (scopeId.length === 0) throw new Error(`${where}.scopeId must not be empty`);
    location.scopeId = scopeId;
  }
  if (mapping['lines'] !== undefined) {
    const range = asMapping(mapping['lines'], `${where}.lines`);
    const start = asNumber(range['start'], `${where}.lines.start`);
    const end = asNumber(range['end'], `${where}.lines.end`);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error(`${where}.lines must be a positive inclusive range of safe integers`);
    }
    location.lines = { start, end };
  }
  if (location.scopeId === undefined && location.lines === undefined) {
    throw new Error(`${where} must include scopeId or lines`);
  }
  return location;
}

function toCheckResult(value: unknown, where: string): CheckResultShape {
  const mapping = asMapping(value, where);
  const status = mapping['status'];
  if (status !== 'pass' && status !== 'violation') throw new Error(`${where}.status must be pass or violation`);
  const result: {
    status: 'pass' | 'violation'; message?: string; probability?: number; threshold?: number; model?: string; usage?: AiUsage;
    locations?: readonly ViolationLocationShape[];
  } = { status };
  const message = mapping['message'];
  if (message !== undefined) result.message = asString(message, `${where}.message`);
  const locations = mapping['locations'];
  if (locations !== undefined) {
    if (status !== 'violation') throw new Error(`${where}.locations are only valid for violations`);
    if (!Array.isArray(locations)) throw new Error(`${where}.locations must be an array`);
    result.locations = locations.map((location: unknown, index: number) =>
      toViolationLocation(location, `${where}.locations[${index}]`),
    );
  }
  const probability = mapping['probability'];
  if (probability !== undefined) result.probability = asNumber(probability, `${where}.probability`);
  const threshold = mapping['threshold'];
  if (threshold !== undefined) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error(`${where}.threshold must be a finite number between 0 and 1`);
    }
    result.threshold = threshold;
  }
  const model = mapping['model'];
  if (model !== undefined) result.model = asString(model, `${where}.model`);
  if (mapping['usage'] !== undefined) {
    const usage = asMapping(mapping['usage'], `${where}.usage`);
    result.usage = {
      calls: asNumber(usage['calls'], `${where}.usage.calls`),
      unreportedCalls: asNumber(usage['unreportedCalls'], `${where}.usage.unreportedCalls`),
      inputTokens: asNumber(usage['inputTokens'], `${where}.usage.inputTokens`),
      outputTokens: asNumber(usage['outputTokens'], `${where}.usage.outputTokens`),
      inputCost: asNumber(usage['inputCost'], `${where}.usage.inputCost`),
      outputCost: asNumber(usage['outputCost'], `${where}.usage.outputCost`),
    };
  }
  return result;
}

function toScopeSubject(value: unknown, where: string): ScopeSubjectShape {
  const mapping = asMapping(value, where);
  if (mapping['kind'] !== 'scope') throw new Error(`${where}.kind must be "scope"`);
  const subject: {
    kind: 'scope';
    filepath: string;
    id: string;
    source: string;
    data?: unknown;
    captures?: unknown;
    lines?: { start: number; end: number };
  } = {
    kind: 'scope',
    filepath: asString(mapping['filepath'], `${where}.filepath`),
    id: asString(mapping['id'], `${where}.id`),
    source: asString(mapping['source'], `${where}.source`),
  };
  if (mapping['data'] !== undefined) subject.data = mapping['data'];
  if (mapping['captures'] !== undefined) subject.captures = mapping['captures'];
  const lines = mapping['lines'];
  if (lines !== undefined) {
    const range = asMapping(lines, `${where}.lines`);
    subject.lines = {
      start: asNumber(range['start'], `${where}.lines.start`),
      end: asNumber(range['end'], `${where}.lines.end`),
    };
  }
  return subject;
}

function toSubject(value: unknown, where: string): SubjectShape {
  const mapping = asMapping(value, where);
  if (mapping['kind'] === 'scope') return toScopeSubject(value, where);
  if (mapping['kind'] !== 'group') throw new Error(`${where}.kind must be "scope" or "group"`);
  const group = asMapping(mapping['group'], `${where}.group`);
  const type = group['type'];
  if (type !== 'file' && type !== 'folder' && type !== 'project') {
    throw new Error(`${where}.group.type must be file, folder or project`);
  }
  const members = mapping['members'];
  if (!Array.isArray(members)) throw new Error(`${where}.members must be an array`);
  return {
    kind: 'group',
    group: { type, path: asString(group['path'], `${where}.group.path`) },
    members: members.map((member: unknown, index: number) => toScopeSubject(member, `${where}.members[${index}]`)),
  };
}

function toEvaluation(value: unknown, where: string): CheckEvaluationShape {
  const mapping = asMapping(value, where);
  return {
    subject: toSubject(mapping['subject'], `${where}.subject`),
    result: toCheckResult(mapping['result'], `${where}.result`),
  };
}

export function parseCheckOutput(result: CliResult, label: string, mode: '--json' | '--jsonl' = '--json'): readonly CheckReportShape[] {
  assert.ok(
    result.status === 0 || result.status === 1,
    `${label}: expected a completed evaluation, got status ${String(result.status)} (stderr: ${result.stderr})`,
  );
  let reports: unknown[];
  if (mode === '--json') {
    const payload = asMapping(JSON.parse(result.stdout), `${label} output`);
    const durationMs = payload['durationMs'];
    assert.ok(
      typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0,
      `${label}: durationMs must be a finite nonnegative number`,
    );
    assert.ok(Array.isArray(payload['reports']), `${label}: reports must be a JSON array`);
    reports = payload['reports'];
  } else {
    reports = result.stdout === '' ? [] : result.stdout.trimEnd().split('\n').map((line, index) => {
      const record = asMapping(JSON.parse(line), `${label} record ${index}`);
      assert.equal(record['type'], 'rule', `${label}: JSONL records must be rules`);
      const { type: _type, ...report } = record;
      return report;
    });
  }
  return reports.map((entry: unknown, index: number): CheckReportShape => {
    const where = `${label}.reports[${index}]`;
    const mapping = asMapping(entry, where);
    const status = mapping['status'];
    if (status !== 'pass' && status !== 'violation' && status !== 'skipped') {
      throw new Error(`${where}.status must be pass, violation or skipped`);
    }
    const ruleFile = asString(mapping['ruleFile'], `${where}.ruleFile`);
    if (!isAbsolute(ruleFile)) throw new Error(`${where}.ruleFile must be absolute`);
    const durationMs = mapping['durationMs'];
    assert.ok(
      typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0,
      `${where}.durationMs must be a finite nonnegative number`,
    );
    const evaluations = mapping['evaluations'];
    if (!Array.isArray(evaluations)) throw new Error(`${where}.evaluations must be an array`);
    const report: {
      name: string;
      ruleFile: string;
      status: 'pass' | 'violation' | 'skipped';
      durationMs: number;
      reason?: string;
      evaluations: readonly CheckEvaluationShape[];
    } = {
      name: asString(mapping['name'], `${where}.name`),
      ruleFile,
      status,
      durationMs,
      evaluations: evaluations.map((evaluation: unknown, position: number) =>
        toEvaluation(evaluation, `${where}.evaluations[${position}]`),
      ),
    };
    const reason = mapping['reason'];
    if (reason !== undefined) report.reason = asString(reason, `${where}.reason`);
    return report;
  });
}

export function reportNamed(
  reports: readonly CheckReportShape[],
  name: string,
  label: string,
): CheckReportShape {
  const matches = reports.filter(report => report.name === name);
  assert.equal(matches.length, 1, `${label}: expected exactly one report named '${name}'`);
  return matches[0]!;
}

export function scopeSubjects(report: CheckReportShape, label: string): readonly ScopeSubjectShape[] {
  return report.evaluations.map((evaluation, index) => {
    assert.equal(evaluation.subject.kind, 'scope', `${label}[${index}]: expected a scope subject`);
    return evaluation.subject as ScopeSubjectShape;
  });
}

export function expectFailure(result: CliResult, label: string): void {
  assert.equal(result.status, 2, `${label}: expected exit 2 (stdout: ${result.stdout} stderr: ${result.stderr})`);
  assert.equal(result.stdout, '', `${label}: expected no partial report on stdout`);
  assert.ok(result.stderr.trimStart().startsWith('coderuler:'), `${label}: stderr must be prefixed (${result.stderr})`);
}

export function expectStreamingFailure(result: CliResult, label: string): void {
  assert.equal(result.status, 2, `${label}: expected exit 2 (stdout: ${result.stdout} stderr: ${result.stderr})`);
  assert.ok(result.stderr.trimStart().startsWith('coderuler:'), `${label}: stderr must be prefixed (${result.stderr})`);
}

export interface DecisionRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
  readonly raw: string;
}

export interface DecisionReply {
  readonly status?: number;
  readonly body?: string;
  readonly probability?: number;
  readonly model?: string;
}

export interface DecisionFixtureOptions {
  readonly hold?: boolean;
  readonly probability?: number;
  readonly model?: string;
  readonly apiKey?: string;
}

export interface DecisionFixture {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requests: DecisionRequestRecord[];
  probability: number;
  model: string;
  answer: (request: DecisionRequestRecord, index: number) => DecisionReply;
  readonly active: number;
  readonly peak: number;
  heldKeys(): readonly string[];
  waitForRequests(count: number): Promise<void>;
  release(key: string): void;
  releaseAll(): void;
  resume(): void;
  reset(): void;
  close(): Promise<void>;
}

const FIXTURE_PROBABILITY = 0.9;
const FIXTURE_MODEL = 'testmodel';
const FIXTURE_API_KEY = 'fixture-key';
const WAIT_TIMEOUT_MS = 20_000;
const DRAIN_TIMEOUT_MS = 20_000;

export function decisionPayload(probability: number, model: string): unknown {
  return {
    model,
    answers: { follows_instructions: { type: 'noul', noul: probability } },
    usage: { input_tokens: 11, output_tokens: 1 },
  };
}

export function decisionKey(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('state' in body)) return 'unidentified';
  const state = body.state;
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return 'unidentified';
  if ('files' in state && Array.isArray(state.files)) {
    const filepaths: string[] = [];
    for (const file of state.files) {
      if (typeof file !== 'object' || file === null || !('filepath' in file) || typeof file.filepath !== 'string') {
        return 'unidentified';
      }
      filepaths.push(file.filepath);
    }
    return `files:${JSON.stringify(filepaths)}`;
  }
  if ('filepath' in state && typeof state.filepath === 'string') return state.filepath;
  return 'unidentified';
}

export function requestState(record: DecisionRequestRecord): Record<string, unknown> {
  const body = asMapping(record.body, 'decision request body');
  return asMapping(body['state'], 'decision request state');
}

export function requestInstructions(record: DecisionRequestRecord): Record<string, unknown> {
  const body = asMapping(record.body, 'decision request body');
  const questions = asMapping(body['questions'], 'decision request questions');
  const question = asMapping(questions['follows_instructions'], 'decision request follows_instructions');
  return asMapping(question['instructions'], 'decision request instructions');
}

export function requestQuestion(record: DecisionRequestRecord): Record<string, unknown> {
  const body = asMapping(record.body, 'decision request body');
  const questions = asMapping(body['questions'], 'decision request questions');
  return asMapping(questions['follows_instructions'], 'decision request follows_instructions');
}

export function startDecisionFixture(options: DecisionFixtureOptions = {}): Promise<DecisionFixture> {
  let hold = options.hold ?? false;
  const apiKey = options.apiKey ?? FIXTURE_API_KEY;
  const requests: DecisionRequestRecord[] = [];
  const held: { readonly request: DecisionRequestRecord; readonly response: ServerResponse }[] = [];
  const watchers = new Set<(error?: Error) => void>();
  let probability = options.probability ?? FIXTURE_PROBABILITY;
  let model = options.model ?? FIXTURE_MODEL;
  let active = 0;
  let peak = 0;
  let origin = '';
  let answerFn: DecisionFixture['answer'] = () => ({});

  const deliver = (request: DecisionRequestRecord, response: ServerResponse): void => {
    let reply: DecisionReply;
    try {
      reply = answerFn(request, requests.indexOf(request));
    } catch {
      reply = { status: 502 };
    }
    if (reply.body !== undefined) {
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(reply.body);
      return;
    }
    const status = reply.status ?? 200;
    const payload =
      status >= 400 ? { error: 'fixture backend failure' } : decisionPayload(reply.probability ?? probability, reply.model ?? model);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  const respond = (entry: { readonly request: DecisionRequestRecord; readonly response: ServerResponse }): void => {
    active -= 1;
    deliver(entry.request, entry.response);
  };
  const releaseAll = (): void => {
    for (const entry of held.splice(0, held.length)) respond(entry);
  };

  const { promise, resolve: settle, reject } = Promise.withResolvers<DecisionFixture>();

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
      const record: DecisionRequestRecord = {
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        headers: request.headers,
        body,
        raw,
      };
      requests.push(record);
      if (hold) {
        held.push({ request: record, response });
        active += 1;
        peak = Math.max(peak, active);
      } else {
        deliver(record, response);
      }
      for (const watcher of [...watchers]) watcher();
    });
  });

  const waitForRequests = (count: number): Promise<void> => {
    if (requests.length >= count) return Promise.resolve();
    const { promise, resolve: settle, reject: fail } = Promise.withResolvers<void>();
    let timeout: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      watchers.delete(onArrival);
      if (error === undefined) settle();
      else fail(error);
    };
    const onArrival = (error?: Error): void => {
      if (error !== undefined) {
        finish(error);
        return;
      }
      if (requests.length >= count) finish();
    };
    timeout = setTimeout(
      () => finish(new Error(`expected ${count} decisions, saw ${requests.length}`)),
      WAIT_TIMEOUT_MS,
    );
    watchers.add(onArrival);
    onArrival();
    return promise;
  };

  server.on('error', (error: Error) => {
    for (const watcher of [...watchers]) watcher(error);
    reject(error);
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('the decision fixture did not bind a loopback port'));
      return;
    }
    origin = `http://127.0.0.1:${address.port}`;
    settle({
      get baseUrl(): string {
        return origin;
      },
      apiKey,
      get env(): NodeJS.ProcessEnv {
        return { TYPESAFE_BASE_URL: origin, TYPESAFE_API_KEY: apiKey, TYPESAFE_DEFAULT_MODEL: model };
      },
      requests,
      get probability(): number {
        return probability;
      },
      set probability(value: number) {
        probability = value;
      },
      get model(): string {
        return model;
      },
      set model(value: string) {
        model = value;
      },
      get answer(): DecisionFixture['answer'] {
        return answerFn;
      },
      set answer(value: DecisionFixture['answer']) {
        answerFn = value;
      },
      get active(): number {
        return active;
      },
      get peak(): number {
        return peak;
      },
      heldKeys: () => held.map(entry => decisionKey(entry.request.body)),
      waitForRequests,
      release: (key: string) => {
        const index = held.findIndex(entry => decisionKey(entry.request.body) === key);
        if (index < 0) {
          const waiting = held.map(entry => decisionKey(entry.request.body)).join(', ');
          throw new Error(`no decision for ${key} is waiting; waiting on ${waiting}`);
        }
        respond(held.splice(index, 1)[0]!);
      },
      releaseAll,
      resume(): void {
        hold = false;
        releaseAll();
      },
      reset(): void {
        requests.length = 0;
        active = 0;
        peak = 0;
        probability = FIXTURE_PROBABILITY;
        answerFn = () => ({});
      },
      close(): Promise<void> {
        const error = new Error('decision fixture closed before requested decisions arrived');
        for (const watcher of [...watchers]) watcher(error);
        const stopped = Promise.withResolvers<void>();
        server.close(closeError => {
          if (closeError === undefined) stopped.resolve();
          else stopped.reject(closeError);
        });
        server.closeAllConnections();
        return stopped.promise;
      },
    });
  });
  return promise;
}

export async function releaseUntilDone(
  fixture: DecisionFixture,
  run: CliRun,
): Promise<CliResult> {
  fixture.resume();
  let timeout: NodeJS.Timeout | undefined;
  let requestCountAtTimeout = 0;
  const { promise: timedOut, resolve: expire } = Promise.withResolvers<void>();
  timeout = setTimeout(() => {
    requestCountAtTimeout = fixture.requests.length;
    expire();
  }, DRAIN_TIMEOUT_MS);
  try {
    const result = await Promise.race([run, timedOut]);
    if (result !== undefined) return result;
    run.terminate();
    try {
      await run;
    } catch {
    }
    throw new Error(
      `the check did not finish within ${DRAIN_TIMEOUT_MS}ms after ${requestCountAtTimeout} decisions; the child was terminated`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
