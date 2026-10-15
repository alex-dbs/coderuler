/**
 * Fixtures shared by the end-to-end suites. Every case gets one isolated project under a run-unique
 * temporary root, with `HOME`/`USERPROFILE` and every on-disk Git config file redirected inside it
 * and no inherited `GIT_*`, decision-backend or backend-key variable surviving into a child, and
 * drives the real `index.ts` and the real Git binary as child processes — nothing here is mocked:
 * the decision backend is a real HTTP server this process runs, so a case never reaches the
 * developer's checkout, home, credentials or network. Only the parsers and the assertion helpers the
 * suites share live here, not a schema framework: each payload is read once into the shape the
 * assertions actually use.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** Repository root: every suite resolves its fixtures and the CLI entry point from here. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The real CLI entry point, spawned as a child process by the end-to-end suites. */
export const CLI = join(ROOT, 'index.ts');

/** Trusted golden fixtures: one group per rule, holding its `rule.yaml` and its reviewed cases. */
export const GOLDEN_ROOT = join(ROOT, 'tests', 'golden');

/** One child process outcome: exit status plus both decoded streams. */
export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One printed `check` entry: the rule's identity and examples plus the contexts it gathered. */
export interface CheckEntry {
  readonly ruleFile: string;
  readonly name: string;
  readonly rule: string;
  /** Compared against a fixture value, so it stays untyped here. */
  readonly examples: unknown;
  /** Parsed per case by the suite that asserts on them, so they stay untyped here. */
  readonly contexts: readonly unknown[];
  /** The decision each context received, in the same order as {@link contexts}. */
  readonly decisions: readonly CheckDecision[];
}

/** One decision of one reviewed scope: what the backend answered, and for which scope. */
export interface CheckDecision {
  /** The logical filepath of the reviewed context. */
  readonly filepath: string;
  /** The reviewed scope's id inside that file, as the scope plugin reported it. */
  readonly scopeId: string;
  /** Whether the scope is judged to follow the rule; a bare `probability > 0.5`. */
  readonly follows: boolean;
  /** The backend's probability that the scope follows the rule, carried through unchanged. */
  readonly probability: number;
  /** The backend's own model name, carried through unchanged. */
  readonly model: string;
}

/** One isolated project: its working directory, its home, an out-of-tree rules directory and env. */
export interface Sandbox {
  readonly cwd: string;
  /** `HOME`/`USERPROFILE` of every child: no case may read or write the developer's own home. */
  readonly home: string;
  /** A rules directory outside the scanned tree, so a rule is never mistaken for a source. */
  readonly rules: string;
  /** The isolated child environment, its own backend fixture included, shared by every child run. */
  readonly env: NodeJS.ProcessEnv;
}

/** One run-unique temporary root, holding the isolated projects of one suite's cases. */
export interface SandboxRoot {
  /** Canonicalized root of the run; a suite may create repositories directly beneath it. */
  readonly root: string;
  /** Create one isolated project directory, home and out-of-tree rules directory. */
  isolated(label: string): Sandbox;
  /** Remove the whole root; call this from the suite's `after` hook. */
  cleanup(): void;
}

/**
 * Copy one ambient environment, dropping every variable that would steer a child outside its
 * sandbox. A developer's shell, an editor, a Git hook or a wrapping test runner may export `GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_GLOBAL` or another override; a fixture child that
 * inherited one of them would read or write outside its sandbox even though the suite passed its own
 * working directory and home. The ambient decision-backend settings and the official backend key are
 * dropped for the same reason: a suite points its children at its own local backend, so a run must
 * never reach the developer's endpoint, model or credential. An ambient proxy is dropped too, so a
 * loopback request cannot be carried off this machine. Every other variable, `PATH` included, is kept
 * verbatim.
 */
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

/**
 * The environment every child runs with. `HOME` and `USERPROFILE` point inside the sandbox and every
 * on-disk Git config file is redirected there with the system config disabled, so neither rule
 * discovery nor a Git read can see the developer's files or settings, git is never asked for a
 * credential and no prompt is raised; the fixture identity and `LC_ALL=C` keep Git's own output
 * stable. The ambient `GIT_*`, `RULEKEEPER_DECISION_*`, `TYPESAFE_API_KEY` and proxy variables are
 * dropped before the fixture's own ones are set, so an exported location, backend setting or
 * credential cannot point a fixture command outside the sandbox or reach a real backend, and no
 * local request can be proxied away from this machine.
 */
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

/**
 * Create one run-unique temporary sandbox root; `prefix` names it for debugging a leftover run.
 * `overrides` are merged over {@link isolatedEnv} of every project the root hands out, so a suite
 * points each of its children at its own local backend without repeating the settings per case.
 */
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

/**
 * Run the real CLI in one sandbox and resolve with both decoded streams once it has exited.
 *
 * The run is awaited rather than blocked on, so this process keeps serving the suite's own backend
 * while the child asks it for a decision; a synchronous spawn would deadlock that exchange. The
 * child's environment is the sandbox's with `overrides` applied for this run alone; an override set
 * to `undefined` removes the variable instead, which is how a case withholds a setting the sandbox
 * otherwise provides.
 */
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

/** Write one real file, creating its parent directories, and return its absolute path. */
export function writeFile(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

/**
 * Run one Git command in one directory with the given environment and require it to succeed.
 * `-c commit.gpgsign=false` keeps a signing configuration from reaching a fixture commit even when
 * the environment does not; Git's own stdout is returned verbatim.
 */
export function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

/** Narrow to a parsed JSON mapping (not an array or scalar). */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one field that must hold a string. */
export function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  return value;
}

/** Parse one decision into the shape the assertions read, rejecting an unexpected payload. */
function toDecision(value: unknown, where: string): CheckDecision {
  if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
  const follows = value.follows;
  if (typeof follows !== 'boolean') throw new Error(`${where}.follows must be a boolean`);
  const probability = value.probability;
  if (typeof probability !== 'number') throw new Error(`${where}.probability must be a number`);
  return {
    filepath: requireString(value.filepath, `${where}.filepath`),
    scopeId: requireString(value.scopeId, `${where}.scopeId`),
    follows,
    probability,
    model: requireString(value.model, `${where}.model`),
  };
}

/** Parse one `check` entry into the shape the assertions read, rejecting an unexpected payload. */
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

/** Parse a successful `check` payload and return its entries after checking the top-level shape. */
export function entries(result: CliResult, label: string): CheckEntry[] {
  assert.strictEqual(result.status, 0, `${label}: expected success (stderr: ${result.stderr})`);
  const payload: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload), `${label}: expected the check output to be a JSON array`);
  return payload.map((entry: unknown, index: number) => toCheckEntry(entry, `${label}[${index}]`));
}

/** The single entry of a one-rule check, after checking that exactly one entry was printed. */
export function soleEntry(result: CliResult, label: string): CheckEntry {
  const list = entries(result, label);
  assert.strictEqual(list.length, 1, `${label}: expected exactly one rule entry`);
  return list[0]!;
}

/** A failure must exit with a real nonzero status, emit no stdout, and say something on stderr. */
export function assertFailed(result: CliResult, label: string): void {
  assert.ok(result.status !== null && result.status > 0, `${label}: expected a nonzero exit status`);
  assert.strictEqual(result.stdout, '', `${label}: expected no partial output on stdout`);
  assert.notStrictEqual(result.stderr.trim(), '', `${label}: expected an actionable message on stderr`);
}

/** One selected root scope in file mode: the logical filepath and the parsed document, no diff. */
export function fileContext(filepath: string, source: string): unknown {
  return { filepath, scope: { id: '0:', source, data: parse(source) } };
}

/** The probability an ordinary fixture answer carries: above the boundary, so the scope follows. */
const FIXTURE_PROBABILITY = 0.9;

/** The model name the fixture backend reports; a decision carries it through unchanged. */
const FIXTURE_MODEL = 'testmodel';

/** The key the fixture expects, so a run that reaches a backend is one this process answered. */
const FIXTURE_API_KEY = 'fixture-key';

/** One request the fixture backend received, kept for the assertions that read what the CLI sent. */
export interface DecisionFixtureRequest {
  readonly method: string;
  /** The request path verbatim, so the adapter's own versioned endpoint path stays observable. */
  readonly path: string;
  /** The `Authorization` header verbatim, when the CLI sent one. */
  readonly authorization: string | undefined;
  /** The decoded JSON body, or `undefined` when the body was not a JSON document. */
  readonly body: unknown;
}

/**
 * A local stand-in for the real decision backend: a real HTTP server on a loopback port that this
 * process serves, so the CLI's own HTTP call is exercised end to end — no mock, no stub, and no
 * request leaving the machine. It answers the documented `noul` shape, records what it was asked,
 * and can flip the probability or fail on demand, which is how the suites pin the boundary between
 * the CLI and the backend.
 */
export interface DecisionFixture {
  /** The base URL a run must be pointed at; it is a bare origin, with no version prefix of its own. */
  readonly baseUrl: string;
  /** The key the fixture expects in `Authorization`; no production key is ever set. */
  readonly apiKey: string;
  /** The model name every answer reports. */
  readonly model: string;
  /** The aliases that point a child at this fixture; merged into a sandbox's own environment. */
  readonly env: NodeJS.ProcessEnv;
  /** Every request received so far, in arrival order; {@link reset} forgets them. */
  readonly requests: DecisionFixtureRequest[];
  /** The probability the next answer carries, defaulting to {@link FIXTURE_PROBABILITY}. */
  probability: number;
  /** The 0-based request from which the fixture answers HTTP 500; `undefined` answers every one. */
  failFromRequest: number | undefined;
  /** Forget the recorded requests and restore the default answer. */
  reset(): void;
  /** Stop listening and release the port. */
  close(): Promise<void>;
}

/**
 * Start one local decision backend on an ephemeral loopback port and resolve once it is listening.
 * The URL is a bare origin, so a run pointed at it proves the adapter owns the `/v1/systemone`
 * operation path rather than the configured base URL carrying the version. Every answer is the same
 * shape the real backend returns: a model name, one `noul` probability for `follows_instructions`,
 * and usage counters.
 */
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
