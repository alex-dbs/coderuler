import type {
  AiOptions,
  Awaitable,
  CheckContext,
  CheckResult,
  Evaluator,
  JsonValue,
  ProjectContext,
  ScopeSubject,
  Subject,
} from './rule.js';
import type { DecisionInstructions, DecisionObserver, DecisionRuntime } from './ports.js';
import { isRecord, validateJsonValue } from './validate.js';

const QUESTION = 'Is the rule respected?';

function fail(detail: string): never {
  throw new Error(detail);
}

export function pass(): CheckResult {
  return { status: 'pass' };
}

export function violation(message: string): CheckResult {
  return { status: 'violation', message };
}

function assertExampleList(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) fail(`${label} must be an array of non-empty strings`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label} must be an array of non-empty strings`);
    const entry: unknown = value[index];
    if (typeof entry !== 'string' || entry === '') fail(`${label} must be an array of non-empty strings`);
  }
}

function assertAiOptions<T>(options: AiOptions<T>): void {
  if (typeof options.rule !== 'string' || options.rule === '') {
    fail('ai rule must be a non-empty string');
  }

  const examples = options.examples;
  if (examples !== undefined) {
    if (!isRecord(examples)) fail('ai examples must be an object');
    assertExampleList(examples['good'], 'ai examples.good');
    assertExampleList(examples['bad'], 'ai examples.bad');
  }

  const message = options.violationMessage;
  if (message !== undefined && (typeof message !== 'string' || message === '')) {
    fail('ai violationMessage must be a non-empty string');
  }

  const input = options.input;
  if (input !== undefined && typeof input !== 'function') fail('ai input must be a function');
}

export function ai<T = JsonValue>(options: AiOptions<T>): Evaluator<T> {
  assertAiOptions(options);
  return (_subject: Subject<T>, context: CheckContext<T>) => context.ai(options);
}

function projectScope<T>(scope: ScopeSubject<T>): JsonValue {
  const captures = scope.captures;
  if (scope.data === undefined) {
    return captures === undefined
      ? { id: scope.id, source: scope.source }
      : { id: scope.id, source: scope.source, captures };
  }
  const data = scope.data as unknown as JsonValue;
  return captures === undefined
    ? { id: scope.id, data }
    : { id: scope.id, data, captures };
}

function projectState<T>(subject: Subject<T>): JsonValue {
  if (subject.kind === 'group') {
    const files: { filepath: string; scopes: JsonValue[] }[] = [];
    const byFilepath = new Map<string, { filepath: string; scopes: JsonValue[] }>();
    for (const member of subject.members) {
      let file = byFilepath.get(member.filepath);
      if (file === undefined) {
        file = { filepath: member.filepath, scopes: [] };
        byFilepath.set(member.filepath, file);
        files.push(file);
      }
      file.scopes.push(projectScope(member));
    }
    return { files };
  }
  return { filepath: subject.filepath, scope: projectScope(subject) };
}

function instructionsOf<T>(options: AiOptions<T>): DecisionInstructions {
  const good = options.examples?.good ?? [];
  const bad = options.examples?.bad ?? [];
  if (good.length === 0 && bad.length === 0) return { rule: options.rule, question: QUESTION };
  return { rule: options.rule, question: QUESTION, examples: { good, bad } };
}

export async function evaluateAi<T = JsonValue>(
  subject: Subject<T>,
  options: AiOptions<T>,
  context: ProjectContext & { readonly ruleName: string },
  runtime: DecisionRuntime,
  observer?: DecisionObserver,
): Promise<CheckResult> {
  assertAiOptions(options);

  const state =
    options.input === undefined
      ? projectState(subject)
      : validateJsonValue(await options.input(subject, context), 'ai input');

  const decision = await runtime.backend.decide({ state, instructions: instructionsOf(options) }, observer);

  if (decision.probability > runtime.threshold) {
    return { status: 'pass', probability: decision.probability, model: decision.model };
  }
  return {
    status: 'violation',
    message: options.violationMessage ?? `Rule "${context.ruleName}" was violated`,
    probability: decision.probability,
    model: decision.model,
  };
}

export interface RegexOptions<T = JsonValue> {
  readonly pattern: RegExp;
  readonly violationMessage?: string;
  readonly input?: (subject: ScopeSubject<T>, context: ProjectContext) => Awaitable<string>;
}

type RegexEvaluation = {
  readonly filepath: string;
  readonly scopeId: string;
  readonly input: string;
  readonly matched: boolean;
};

function regexValue(scope: { readonly data?: unknown; readonly source: string }): string {
  const { data, source } = scope;
  if (data === undefined || (typeof data === 'object' && data !== null)) return source;
  return String(data);
}

export function regex<T = JsonValue>(options: RegexOptions<T>): Evaluator<T> {
  const { pattern: callerPattern, violationMessage, input } = options;
  if (!(callerPattern instanceof RegExp)) fail('regex pattern must be a RegExp');
  if (violationMessage !== undefined && (typeof violationMessage !== 'string' || violationMessage === '')) {
    fail('regex violationMessage must be a non-empty string');
  }
  if (input !== undefined && typeof input !== 'function') fail('regex input must be a function');

  const pattern = new RegExp(callerPattern.source, callerPattern.flags);

  return async (subject, context) => {
    const members = subject.kind === 'group' ? subject.members : [subject];
    const evaluations: RegexEvaluation[] = [];
    for (const member of members) {
      const value = input === undefined ? regexValue(member) : await input(member, context);
      pattern.lastIndex = 0;
      evaluations.push({
        filepath: member.filepath,
        scopeId: member.id,
        input: value,
        matched: pattern.test(value),
      });
    }

    context.trace('regex', { pattern: pattern.source, flags: pattern.flags, evaluations });

    return evaluations.every(evaluation => evaluation.matched)
      ? pass()
      : violation(violationMessage ?? `Rule "${context.ruleName}" was violated`);
  };
}
