import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { LoadedRule } from '../../app/ports.js';
import type { RuleTestCase, RuleTestResult } from '../../app/rule-tests.js';
import { isRecord, validateJsonValue } from '../../app/validate.js';
import type { RuleTestWorkerMessage, RuleTestWorkerRequest } from './rule-test-worker.js';
import { getRuleDependencies } from './rule-resolution.js';

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
  private onFailure: ((error: Error) => void) | undefined;
  private terminating = false;
  private termination: Promise<number> | undefined;

  private readonly onError = (error: Error) => {
    if (this.terminating) return;
    this.failure ??= error;
    if (this.rejectPending !== undefined) this.rejectPending(error);
    else this.onFailure?.(error);
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

  async run(
    request: Omit<RuleTestWorkerRequest, 'id'>,
    deadline: number,
    onFailure: (error: Error) => void,
  ): Promise<TestActual> {
    this.onFailure = onFailure;
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
      this.rejectPending?.(new Error('Rule test worker stopped'));
      this.termination = this.worker.terminate();
    }
    await this.termination;
    this.worker.off('error', this.onError);
    this.worker.off('exit', this.onExit);
  }
}

interface RuleTestSession {
  current: RuleTestWorkerSession | undefined;
  cancelled: boolean;
}

async function stopSession(session: RuleTestSession): Promise<void> {
  const current = session.current;
  await current?.stop();
  if (session.current === current) session.current = undefined;
}

async function runCase(
  entry: LoadedRule,
  example: RuleTestCase,
  ai: boolean,
  timeoutMs: number,
  session: RuleTestSession,
  onFailure: (error: unknown) => void,
): Promise<RuleTestResult> {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let failure: Error | undefined;
  const failCase = (error: unknown): Error => {
    if (failure !== undefined) return failure;
    const detail = error instanceof Error ? error.message : String(error);
    failure = new Error(`Rule "${entry.name}" test "${example.name}" failed: ${detail}`, { cause: error });
    onFailure(failure);
    return failure;
  };
  try {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'coderuler-test-'));
    let actual: TestActual | undefined;
    let active: RuleTestWorkerSession | undefined;
    try {
      if (session.cancelled) throw new Error('Rule test run cancelled');
      if (performance.now() >= deadline) actual = 'timeout';
      else {
        active = session.current ??= new RuleTestWorkerSession();
        const dependencies = getRuleDependencies(entry.ruleFile);
        actual = await active.run({
          root, ruleFile: entry.ruleFile, files: example.files, ai,
          ...(dependencies === undefined ? {} : { dependencies }),
        }, deadline, failCase);
      }
    } catch (error) {
      throw failCase(error);
    } finally {
      try {
        if (actual === undefined || actual === 'timeout') await stopSession(session);
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
    const cause = failCase(error);
    await stopSession(session);
    throw cause;
  }
}

export async function runRuleTests(
  rules: readonly LoadedRule[],
  onResult?: (result: RuleTestResult, lastInRule: boolean) => void,
  timeoutMs = 10_000,
  concurrency = 1,
  includeAI = false,
): Promise<readonly RuleTestResult[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`--concurrency must be a positive safe integer, received ${String(concurrency)}`);
  }
  const results: RuleTestResult[] = [];
  const sessions: RuleTestSession[] = [];
  let failureObserved = false;
  let hasExcludedAITests = false;
  let failure: unknown;
  let cancellation: Promise<unknown> | undefined;
  const fail = (error: unknown): void => {
    if (failureObserved) return;
    failureObserved = true;
    failure = error;
    cancellation = Promise.allSettled(sessions.map(session => {
      session.cancelled = true;
      return stopSession(session);
    }));
  };

  try {
    for (const rule of rules) {
      if (failureObserved) throw failure;
      if (!rule.rule.enabled) continue;
      // Discovery selects the rule module path at runtime.
      const { tests, aiTests } = await import(pathToFileURL(rule.ruleFile).href) as {
        readonly tests?: unknown;
        readonly aiTests?: unknown;
      };
      if (failureObserved) throw failure;
      if (!includeAI && aiTests !== undefined) hasExcludedAITests = true;
      const selectedAI = includeAI ? aiTests : undefined;
      const label = `Rule "${rule.name}"`;
      if (tests !== undefined && !Array.isArray(tests)) {
        throw new Error(`${label} tests: expected an array of test cases`);
      }
      if (selectedAI !== undefined && !Array.isArray(selectedAI)) {
        throw new Error(`${label} aiTests: expected an array of test cases`);
      }
      const regularCount = tests?.length ?? 0;
      const count = regularCount + (selectedAI?.length ?? 0);
      const completed = new Array<RuleTestResult | undefined>(count);
      let nextIndex = 0;
      let nextResult = 0;
      const runWorker = async (session: RuleTestSession): Promise<void> => {
        while (!failureObserved) {
          const index = nextIndex++;
          if (index >= count) return;
          try {
            const ai = index >= regularCount;
            const caseIndex = ai ? index - regularCount : index;
            const value = ai ? selectedAI![caseIndex] : tests![caseIndex];
            const example = validateCase(value, `${label} ${ai ? 'aiTests' : 'tests'}[${caseIndex}]`);
            completed[index] = await runCase(rule, example, ai, timeoutMs, session, fail);
            if (failureObserved) return;
            while (completed[nextResult] !== undefined) {
              const result = completed[nextResult]!;
              results.push(result);
              nextResult += 1;
              onResult?.(result, nextResult === count);
            }
          } catch (error) {
            fail(error);
          }
        }
      };
      const workers: Promise<void>[] = [];
      const workerCount = Math.min(concurrency, count);
      for (let index = 0; index < workerCount && !failureObserved; index += 1) {
        const session = sessions[index] ??= { current: undefined, cancelled: false };
        workers.push(runWorker(session));
      }
      await Promise.all(workers);
      if (failureObserved) throw failure;
    }
    if (results.length === 0) {
      throw new Error(hasExcludedAITests
        ? 'No ordinary rule test cases found in the selected rules; run with --ai to include aiTests'
        : 'No rule test cases found in the selected rules');
    }
    return results;
  } finally {
    await cancellation;
    await Promise.all(sessions.map(stopSession));
  }
}
