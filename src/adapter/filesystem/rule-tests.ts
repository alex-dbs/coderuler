import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { LoadedRule } from '../../app/ports.js';
import type { RuleTestCase, RuleTestResult } from '../../app/rule-tests.js';
import { isRecord, validateJsonValue } from '../../app/validate.js';
import type { RuleTestWorkerMessage, RuleTestWorkerRequest } from './rule-test-worker.js';

// A JavaScript entry lets inherited tsx hooks resolve the source worker's .js import.
const WORKER_MODULE = new URL('./rule-test-worker.js', import.meta.url);
const WORKER_ENTRY = new URL(`data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(WORKER_MODULE.href)};`)}`);

function validateCase(value: unknown, label: string): RuleTestCase {
  if (!isRecord(value)) throw new Error(`${label}: expected a test case object`);
  if (typeof value['name'] !== 'string' || value['name'].trim() === '') {
    throw new Error(`${label}: name must be a non-blank string`);
  }
  const at = `${label} "${value['name']}"`;
  if (!isRecord(value['files'])) throw new Error(`${at}: files must be a fixture path map`);
  validateJsonValue(value['files'], `${at} files`);
  const expected = value['expected'];
  if (expected !== 'pass' && expected !== 'violation' && expected !== 'skipped') {
    throw new Error(`${at}: expected must be "pass", "violation", or "skipped"`);
  }
  return value as unknown as RuleTestCase;
}

type TestActual = RuleTestResult['actual'];

class RuleTestWorkerSession {
  private readonly worker = new Worker(WORKER_ENTRY);
  private nextId = 0;
  private failure: Error | undefined;
  private rejectPending: ((error: Error) => void) | undefined;
  private terminating = false;
  private termination: Promise<number> | undefined;

  private readonly onError = (error: Error) => {
    this.failure ??= error;
    this.rejectPending?.(error);
  };

  private readonly onExit = (code: number) => {
    if (!this.terminating) {
      this.onError(new Error(`Rule test worker exited before reporting a result (code ${code})`));
    }
  };

  constructor() {
    this.worker.on('error', this.onError);
    this.worker.on('exit', this.onExit);
  }

  assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  async run(request: Omit<RuleTestWorkerRequest, 'id'>, deadline: number): Promise<TestActual> {
    this.assertHealthy();
    const id = this.nextId++;
    const result = Promise.withResolvers<TestActual>();
    let timer: NodeJS.Timeout | undefined;
    const expire = () => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) result.resolve('timeout');
      else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    const onMessage = (message: RuleTestWorkerMessage) => {
      if (message.id !== id) return;
      if (performance.now() >= deadline) result.resolve('timeout');
      else if ('error' in message) result.reject(new Error(message.error));
      else result.resolve(message.actual);
    };
    this.rejectPending = error => {
      if (performance.now() >= deadline) result.resolve('timeout');
      else result.reject(error);
    };
    this.worker.on('message', onMessage);
    try {
      expire();
      if (performance.now() < deadline) {
        this.worker.postMessage({ ...request, id } satisfies RuleTestWorkerRequest);
      }
      return await result.promise;
    } finally {
      clearTimeout(timer);
      this.worker.off('message', onMessage);
      this.rejectPending = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.termination === undefined) {
      this.terminating = true;
      this.termination = this.worker.terminate();
    }
    await this.termination;
    this.worker.off('error', this.onError);
    this.worker.off('exit', this.onExit);
  }
}

interface RuleTestSession {
  current: RuleTestWorkerSession | undefined;
}

async function stopSession(session: RuleTestSession): Promise<void> {
  const current = session.current;
  session.current = undefined;
  await current?.stop();
}

async function runCase(
  entry: LoadedRule,
  example: RuleTestCase,
  timeoutMs: number,
  session: RuleTestSession,
  lastInRule: boolean,
): Promise<RuleTestResult> {
  const started = performance.now();
  const deadline = started + timeoutMs;
  try {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'rulekeeper-test-'));
    let actual: TestActual | undefined;
    let active: RuleTestWorkerSession | undefined;
    try {
      if (performance.now() >= deadline) actual = 'timeout';
      else {
        active = session.current ??= new RuleTestWorkerSession();
        actual = await active.run({ root, ruleFile: entry.ruleFile, files: example.files }, deadline);
      }
    } finally {
      try {
        if (actual === undefined || actual === 'timeout' || lastInRule) await stopSession(session);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    if (actual !== 'timeout') active?.assertHealthy();
    return {
      ruleName: entry.name,
      name: example.name,
      expected: example.expected,
      actual,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    await stopSession(session);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Rule "${entry.name}" test "${example.name}" failed: ${detail}`, { cause: error });
  }
}

export async function runRuleTests(
  rules: readonly LoadedRule[],
  onResult?: (result: RuleTestResult, lastInRule: boolean) => void,
  timeoutMs = 10_000,
): Promise<readonly RuleTestResult[]> {
  const results: RuleTestResult[] = [];
  for (const rule of rules) {
    const session: RuleTestSession = { current: undefined };
    try {
      // Discovery selects the rule module path at runtime.
      const { tests } = await import(pathToFileURL(rule.ruleFile).href) as { readonly tests?: unknown };
      if (tests === undefined) continue;
      const label = `Rule "${rule.name}" tests`;
      if (!Array.isArray(tests)) throw new Error(`${label}: expected an array of test cases`);
      for (let index = 0; index < tests.length; index += 1) {
        const example = validateCase(tests[index], `${label}[${index}]`);
        const lastInRule = index === tests.length - 1;
        const result = await runCase(rule, example, timeoutMs, session, lastInRule);
        results.push(result);
        onResult?.(result, lastInRule);
      }
    } finally {
      await stopSession(session);
    }
  }
  if (results.length === 0) throw new Error('No rule test cases found in the selected rules');
  return results;
}
