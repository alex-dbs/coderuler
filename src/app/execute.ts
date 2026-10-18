import { matchesGlob } from 'node:path';

import type {
  AiUsage,
  CheckContext,
  CheckResult,
  Grouping,
  JsonValue,
  PredicateResult,
  ProjectContext,
  Rule,
  ScopeMatch,
  ScopeSubject,
  Selection,
  SelectionContext,
  Subject,
} from './rule.js';
import type {
  DecisionObserver,
  DecisionRuntime,
  LoadedRule,
  RuleEvaluation,
  RuleLoader,
  RuleReport,
  RuleSelection,
  RunContext,
  RunEvent,
} from './ports.js';
import { mapConcurrent } from './concurrency.js';
import { evaluateAi } from './evaluators.js';
import { wholeFileScope } from './selection.js';
import { addUsage } from './usage.js';
import {
  validateCheckResult,
  validatePredicateResult,
  validateScopeMatch,
  validateScopeSubjects,
} from './validate.js';

function isEligibleRelativePath(filepath: string): boolean {
  if (filepath === '' || filepath.startsWith('/')) return false;
  const segments = filepath.split('/');
  const last = segments.length - 1;
  for (let index = 0; index < last; index += 1) {
    const segment = segments[index]!;
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  const name = segments[last];
  return name !== undefined && name !== '' && name !== '.' && name !== '..';
}

function folderPath(filepath: string, level: number): string {
  const segments = filepath.split('/');
  segments.pop();
  const keep = segments.length + level;
  if (keep <= 0) return '.';
  return segments.slice(0, keep).join('/');
}

interface Plan {
  readonly name: string;
  readonly ruleFile: string;
  readonly rule: Rule<JsonValue>;
  subjects: readonly ScopeSubject<JsonValue>[];
  evaluationSubjects: readonly Subject<JsonValue>[];
  evaluations: RuleEvaluation[];
  skipped: string | undefined;
  runtime: DecisionRuntime | undefined;
  durationMs: number;
  evaluationStartedAt: number | undefined;
  evaluationFinishedAt: number;
}

export async function validateRules(
  loader: RuleLoader,
  selection: RuleSelection,
): Promise<readonly LoadedRule[]> {
  return loader.load(selection);
}

export async function executeRules(
  rules: readonly LoadedRule[],
  context: RunContext,
): Promise<readonly RuleReport[]> {
  let completedSelections = 0;
  let completedEvaluations = 0;
  const emit = (event: RunEvent): void => {
    context.emit?.(event);
  };
  const changedFiles = context.changedFiles;
  const changedPaths = changedFiles === undefined
    ? undefined
    : [...changedFiles].filter(filepath => isEligibleRelativePath(filepath) && context.isTarget(filepath));

  const traceFor =
    (name: string, evaluationId?: number) =>
    (message: string, details?: JsonValue): void => {
      emit({
        type: 'trace',
        name,
        message,
        ...(evaluationId === undefined ? {} : { evaluationId }),
        ...(details === undefined ? {} : { details }),
      });
    };

  const projectContextFor = (name: string): ProjectContext => ({
    project: context.project,
    trace: traceFor(name),
  });

  const fail = (name: string | undefined, stage: string, error: unknown, evaluationId?: number): Error => {
    const message = error instanceof Error ? error.message : String(error);
    emit({
      type: 'error',
      stage,
      message,
      ...(name === undefined ? {} : { name }),
      ...(evaluationId === undefined ? {} : { evaluationId }),
    });
    return error instanceof Error ? error : new Error(message);
  };

  const statCache = new Map<string, Promise<{ readonly kind: 'file' | 'directory' } | undefined>>();

  const assertEligible = async (
    name: string,
    subjects: readonly ScopeSubject<JsonValue>[],
  ): Promise<void> => {
    for (const subject of subjects) {
      const { filepath } = subject;
      if (!isEligibleRelativePath(filepath)) {
        throw new Error(`Rule "${name}" selected an ineligible filepath "${filepath}"`);
      }
      if (!context.isTarget(filepath)) {
        throw new Error(`Rule "${name}" selected "${filepath}" outside the CLI target`);
      }
      let pending = statCache.get(filepath);
      if (pending === undefined) {
        pending = context.project.stat(filepath);
        statCache.set(filepath, pending);
      }
      const info = await pending;
      if (info?.kind !== 'file') {
        throw new Error(`Rule "${name}" selected a path that is not a regular file: "${filepath}"`);
      }
    }
  };

  const selectFromRule = async <T>(
    name: string,
    selection: Selection<T>,
    evaluationId?: number,
    changedOnly = false,
  ): Promise<readonly ScopeSubject<T>[]> => {
    const exclude = selection.exclude ?? [];
    const candidates = await context.project.glob(selection.files);
    const chosen: string[] = [];
    for (const filepath of candidates) {
      const excluded = exclude.some(pattern => matchesGlob(filepath, pattern));
      const targeted = context.isTarget(filepath);
      const changed = !changedOnly || changedFiles === undefined || changedFiles.has(filepath);
      const selected = !excluded && targeted && changed;
      const reason = excluded ? 'excluded' : !targeted ? 'outside target' : changed ? undefined : 'unchanged';
      emit({
        type: 'file',
        name,
        filepath,
        selected,
        ...(evaluationId === undefined ? {} : { evaluationId }),
        ...(reason === undefined ? {} : { reason }),
      });
      if (selected) chosen.push(filepath);
    }

    const scope = selection.scope;
    const collected = await mapConcurrent(chosen, context.concurrency, async filepath => {
      const source = await context.project.readText(filepath);
      const matches: readonly ScopeMatch<JsonValue>[] =
        scope === undefined
          ? wholeFileScope({ filepath, source })
          : ((await scope({ filepath, source })) as readonly ScopeMatch<JsonValue>[]);
      if (!Array.isArray(matches)) {
        throw new Error(`Rule "${name}" scope selector must return an array of scopes`);
      }
      const subjects: ScopeSubject<T>[] = [];
      for (let index = 0; index < matches.length; index += 1) {
        const label = `Rule "${name}" scope ${filepath}[${index}]`;
        if (!Object.hasOwn(matches, index)) throw new Error(`${label}: missing scope entry`);
        const valid = validateScopeMatch(matches[index], label);
        subjects.push({ kind: 'scope', filepath, ...valid } as unknown as ScopeSubject<T>);
      }
      return subjects;
    });

    return collected.flat();
  };

  const selectionContextFor = (name: string, changedOnly: boolean): SelectionContext => ({
    project: context.project,
    trace: traceFor(name),
    select: selection => selectFromRule(name, selection, undefined, changedOnly),
  });

  const runtimeOf = (plan: Plan): DecisionRuntime => {
    let runtime = plan.runtime;
    if (runtime === undefined) {
      runtime = context.resolveDecision(plan.rule.settings);
      plan.runtime = runtime;
    }
    return runtime;
  };

  const evaluateSubject = async (
    plan: Plan,
    subject: Subject<JsonValue>,
    evaluationId: number,
    reportFailure: (error: unknown) => void,
  ): Promise<CheckResult> => {
    plan.evaluationStartedAt ??= performance.now();
    const { name, rule } = plan;
    emit({ type: 'evaluation', evaluationId, name, subject });
    const trace = traceFor(name, evaluationId);
    let trackedUsage: AiUsage | undefined;
    let pendingAi: Set<Promise<CheckResult>> | undefined;
    let accountingFailure: { readonly error: Error } | undefined;
    const retainAccountingFailure = (error: unknown): void => {
      if (accountingFailure !== undefined) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      accountingFailure = { error: failure };
      reportFailure(failure);
    };
    const throwIfAccountingFailed = (): void => {
      if (accountingFailure !== undefined) throw accountingFailure.error;
    };
    const observer: DecisionObserver = exchange => {
      if (exchange.type === 'request') {
        emit({ type: 'request', evaluationId, name, subject, body: exchange.body });
      } else if (exchange.type === 'response') {
        emit({ type: 'response', evaluationId, name, subject, status: exchange.status, body: exchange.body });
      } else {
        const next = exchange.usage;
        try {
          trackedUsage = addUsage(trackedUsage, next);
        } catch (error) {
          retainAccountingFailure(error);
        }
        // Individual usage remains valid even when its aggregate cannot be represented.
        try {
          emit({ type: 'usage', evaluationId, name, subject, usage: next });
        } catch (error) {
          retainAccountingFailure(error);
        }
        throwIfAccountingFailed();
      }
    };
    const checkContext: CheckContext<JsonValue> = {
      project: context.project,
      ruleName: name,
      trace,
      select: selection => selectFromRule(name, selection, evaluationId),
      ai: options => {
        const call = evaluateAi(
          subject, options, { project: context.project, ruleName: name, trace }, runtimeOf(plan), observer,
        );
        const pending = pendingAi ??= new Set<Promise<CheckResult>>();
        pending.add(call);
        // Observe both outcomes immediately; the check still receives the original promise.
        void call.then(
          () => { pending.delete(call); },
          () => { pending.delete(call); },
        );
        return call;
      },
    };

    let result: CheckResult;
    try {
      try {
        const raw = await rule.check.call(rule, subject, checkContext);
        throwIfAccountingFailed();
        const valid = validateCheckResult(raw, `Rule "${name}" check result`);
        const { status, message, model, probability, threshold, usage } = valid;
        // Snapshot declared fields before draining: custom checks still own their returned objects.
        // Validate the snapshot too, since accessors may change values between reads.
        result = validateCheckResult({
          status,
          ...(message === undefined ? {} : { message }),
          ...(probability === undefined ? {} : { probability }),
          ...(threshold === undefined ? {} : { threshold }),
          ...(model === undefined ? {} : { model }),
          ...(usage === undefined ? {} : { usage: {
            calls: usage.calls,
            unreportedCalls: usage.unreportedCalls,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            inputCost: usage.inputCost,
            outputCost: usage.outputCost,
          } }),
        }, `Rule "${name}" check result`);
      } catch (error) {
        const cause = accountingFailure === undefined ? error : accountingFailure.error;
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        reportFailure(failure);
        throw failure;
      } finally {
        // Promise.all may reject while sibling calls are still producing usage events.
        while (pendingAi !== undefined && pendingAi.size > 0) {
          await Promise.allSettled(pendingAi);
        }
      }
      // A custom check may catch context.ai failures, but cannot discard accounting failures.
      throwIfAccountingFailed();
    } catch (error) {
      throw fail(name, 'check', error, evaluationId);
    }

    const normalized: CheckResult = trackedUsage === undefined ? result : { ...result, usage: trackedUsage };
    emit({ type: 'result', evaluationId, name, subject, result: normalized });
    context.emit?.({
      type: 'progress', phase: 'evaluation', completed: ++completedEvaluations, total: tasks.length,
    });
    plan.evaluationFinishedAt = performance.now();
    return normalized;
  };

  const plans: Plan[] = [];
  context.emit?.({ type: 'progress', phase: 'selection', completed: 0, total: rules.length });

  for (const entry of rules) {
    const selectionStartedAt = performance.now();
    const rule = entry.rule as Rule<JsonValue>;
    const { name, ruleFile } = entry;
    emit({ type: 'rule', name, ruleFile });

    const plan: Plan = {
      name,
      ruleFile,
      rule,
      subjects: [],
      evaluationSubjects: [],
      evaluations: [],
      skipped: undefined,
      runtime: undefined,
      durationMs: 0,
      evaluationStartedAt: undefined,
      evaluationFinishedAt: 0,
    };
    plans.push(plan);

    if (!rule.enabled) {
      emit({ type: 'gate', name, enabled: false, applies: false, reason: 'disabled' });
      plan.skipped = 'disabled';
      context.emit?.({
        type: 'progress', phase: 'selection', completed: ++completedSelections, total: rules.length,
      });
      plan.durationMs = performance.now() - selectionStartedAt;
      continue;
    }

    let gate: PredicateResult;
    try {
      gate = validatePredicateResult(await rule.when.call(rule, projectContextFor(name)), `Rule "${name}" when`);
    } catch (error) {
      throw fail(name, 'when', error);
    }
    const applies = typeof gate === 'boolean' ? gate : gate.applies;
    const gateReason = typeof gate === 'boolean' ? undefined : gate.reason;
    if (!applies) {
      emit({
        type: 'gate',
        name,
        enabled: true,
        applies: false,
        ...(gateReason === undefined ? {} : { reason: gateReason }),
      });
      plan.skipped = gateReason ?? 'when returned false';
      context.emit?.({
        type: 'progress', phase: 'selection', completed: ++completedSelections, total: rules.length,
      });
      plan.durationMs = performance.now() - selectionStartedAt;
      continue;
    }
    emit({
      type: 'gate',
      name,
      enabled: true,
      applies: true,
      ...(gateReason === undefined ? {} : { reason: gateReason }),
    });

    const changedOnly = rule.group === 'scope' || rule.group === 'file';
    let selected: readonly ScopeSubject<JsonValue>[];
    try {
      const raw = await rule.select.call(rule, selectionContextFor(name, changedOnly));
      const subjects = validateScopeSubjects(raw, `Rule "${name}" selection`);
      selected = changedOnly && changedFiles !== undefined
        ? subjects.filter(subject => changedFiles.has(subject.filepath))
        : subjects;
      await assertEligible(name, selected);
    } catch (error) {
      throw fail(name, 'select', error);
    }

    const kept: ScopeSubject<JsonValue>[] = [];
    try {
      for (const subject of selected) {
        const predicate = validatePredicateResult(
          await rule.filter.call(rule, subject, projectContextFor(name)),
          `Rule "${name}" filter`,
        );
        const accepted = typeof predicate === 'boolean' ? predicate : predicate.applies;
        const reason = typeof predicate === 'boolean' ? undefined : predicate.reason;
        emit(
          reason === undefined
            ? { type: 'scope', name, subject, accepted }
            : { type: 'scope', name, subject, accepted, reason },
        );
        if (accepted) kept.push(subject);
      }
    } catch (error) {
      throw fail(name, 'filter', error);
    }

    plan.subjects = kept;
    if (kept.length === 0) plan.skipped = 'no matching subjects';
    context.emit?.({
      type: 'progress', phase: 'selection', completed: ++completedSelections, total: rules.length,
    });
    plan.durationMs = performance.now() - selectionStartedAt;
  }

  for (const plan of plans) {
    if (plan.skipped !== undefined) continue;
    const groupingStartedAt = performance.now();
    const grouping: Grouping = plan.rule.group;
    try {
      const subjects = groupSubjects(plan.subjects, grouping);
      plan.evaluationSubjects = changedPaths === undefined || grouping === 'scope' || grouping === 'file'
        ? subjects
        : subjects.filter(subject => subject.kind === 'group' && changedPaths.some(filepath =>
            subject.group.path === '.' || filepath.startsWith(`${subject.group.path}/`)));
      for (const subject of plan.evaluationSubjects) {
        if (subject.kind === 'group') emit({ type: 'group', name: plan.name, subject });
      }
      if (plan.evaluationSubjects.length === 0) plan.skipped = 'no changed subjects';
    } catch (error) {
      throw fail(plan.name, 'group', error);
    }
    plan.durationMs += performance.now() - groupingStartedAt;
  }

  const tasks: { plan: Plan; subject: Subject<JsonValue>; evaluationId: number }[] = [];
  for (const plan of plans) {
    for (const subject of plan.evaluationSubjects) {
      tasks.push({ plan, subject, evaluationId: tasks.length + 1 });
    }
  }
  context.emit?.({ type: 'progress', phase: 'evaluation', completed: 0, total: tasks.length });

  const results = await mapConcurrent(tasks, context.concurrency, (task, _index, reportFailure) =>
    evaluateSubject(task.plan, task.subject, task.evaluationId, reportFailure),
  );
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    task.plan.evaluations.push({ subject: task.subject, result: results[index]! });
  }

  return plans.map(plan => {
    const durationMs = plan.durationMs + (plan.evaluationStartedAt === undefined
      ? 0
      : plan.evaluationFinishedAt - plan.evaluationStartedAt);
    if (plan.skipped !== undefined) {
      return {
        name: plan.name,
        ruleFile: plan.ruleFile,
        status: 'skipped',
        durationMs,
        reason: plan.skipped,
        evaluations: [],
      };
    }
    const status = plan.evaluations.some(evaluation => evaluation.result.status === 'violation')
      ? 'violation'
      : 'pass';
    return { name: plan.name, ruleFile: plan.ruleFile, status, durationMs, evaluations: plan.evaluations };
  });
}

function groupSubjects(
  subjects: readonly ScopeSubject<JsonValue>[],
  grouping: Grouping,
): readonly Subject<JsonValue>[] {
  if (grouping === 'scope') return [...subjects];

  const descriptors: { type: 'file' | 'folder' | 'project'; path: string }[] = [];
  const buckets = new Map<string, ScopeSubject<JsonValue>[]>();

  for (const subject of subjects) {
    const descriptor =
      grouping === 'file'
        ? ({ type: 'file', path: subject.filepath } as const)
        : grouping === 'project'
          ? ({ type: 'project', path: '.' } as const)
          : ({
              type: 'folder',
              path: folderPath(subject.filepath, grouping === 'folder' ? 0 : grouping.level),
            } as const);
    const key = `${descriptor.type}\u0000${descriptor.path}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(key, bucket);
      descriptors.push(descriptor);
    }
    bucket.push(subject);
  }

  return descriptors.map(descriptor => {
    const members = buckets.get(`${descriptor.type}\u0000${descriptor.path}`)!;
    return { kind: 'group', group: descriptor, members };
  });
}
