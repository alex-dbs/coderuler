import { matchesGlob } from 'node:path';

import type {
  CheckContext,
  CheckResult,
  Grouping,
  GroupSubject,
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
  const emit = (event: RunEvent): void => {
    context.emit?.(event);
  };

  const traceFor =
    (name: string) =>
    (message: string, details?: JsonValue): void => {
      emit(details === undefined ? { type: 'trace', name, message } : { type: 'trace', name, message, details });
    };

  const projectContextFor = (name: string): ProjectContext => ({
    project: context.project,
    trace: traceFor(name),
  });

  const fail = (name: string | undefined, stage: string, error: unknown): Error => {
    const message = error instanceof Error ? error.message : String(error);
    emit(name === undefined ? { type: 'error', stage, message } : { type: 'error', name, stage, message });
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
  ): Promise<readonly ScopeSubject<T>[]> => {
    const exclude = selection.exclude ?? [];
    const candidates = await context.project.glob(selection.files);
    const chosen: string[] = [];
    for (const filepath of candidates) {
      const excluded = exclude.some(pattern => matchesGlob(filepath, pattern));
      const targeted = context.isTarget(filepath);
      const selected = !excluded && targeted;
      const reason = excluded ? 'excluded' : targeted ? undefined : 'outside target';
      emit(
        reason === undefined
          ? { type: 'file', name, filepath, selected }
          : { type: 'file', name, filepath, selected, reason },
      );
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

  const selectionContextFor = (name: string): SelectionContext => ({
    project: context.project,
    trace: traceFor(name),
    select: selection => selectFromRule(name, selection),
  });

  const runtimeOf = (plan: Plan): DecisionRuntime => {
    let runtime = plan.runtime;
    if (runtime === undefined) {
      runtime = context.resolveDecision(plan.rule.settings);
      plan.runtime = runtime;
    }
    return runtime;
  };

  const evaluateSubject = async (plan: Plan, subject: Subject<JsonValue>): Promise<CheckResult> => {
    const { name, rule } = plan;
    const trace = traceFor(name);
    const observer: DecisionObserver = exchange => {
      if (exchange.type === 'request') {
        emit({ type: 'request', name, subject, body: exchange.body });
      } else {
        emit({ type: 'response', name, subject, status: exchange.status, body: exchange.body });
      }
    };
    const checkContext: CheckContext<JsonValue> = {
      project: context.project,
      ruleName: name,
      trace,
      select: selection => selectFromRule(name, selection),
      ai: options =>
        evaluateAi(subject, options, { project: context.project, ruleName: name, trace }, runtimeOf(plan), observer),
    };

    let raw: unknown;
    try {
      raw = await rule.check.call(rule, subject, checkContext);
    } catch (error) {
      throw fail(name, 'check', error);
    }

    let result: CheckResult;
    try {
      result = validateCheckResult(raw, `Rule "${name}" check result`);
    } catch (error) {
      throw fail(name, 'check', error);
    }

    const { status, model, probability } = result;
    const message = result.message ?? (status === 'violation' ? `Rule "${name}" was violated` : undefined);
    const normalized: CheckResult = {
      status,
      ...(message === undefined ? {} : { message }),
      ...(probability === undefined ? {} : { probability }),
      ...(model === undefined ? {} : { model }),
    };
    emit({ type: 'result', name, subject, result: normalized });
    return normalized;
  };

  const plans: Plan[] = [];

  for (const entry of rules) {
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
    };
    plans.push(plan);

    if (!rule.enabled) {
      emit({ type: 'gate', name, enabled: false, applies: false, reason: 'disabled' });
      plan.skipped = 'disabled';
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
      continue;
    }
    emit({
      type: 'gate',
      name,
      enabled: true,
      applies: true,
      ...(gateReason === undefined ? {} : { reason: gateReason }),
    });

    let selected: readonly ScopeSubject<JsonValue>[];
    try {
      const raw = await rule.select.call(rule, selectionContextFor(name));
      selected = validateScopeSubjects(raw, `Rule "${name}" selection`);
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
  }

  for (const plan of plans) {
    if (plan.skipped !== undefined) continue;
    const grouping: Grouping = plan.rule.group;
    try {
      plan.evaluationSubjects = groupSubjects(
        plan.subjects,
        grouping,
        subject => emit({ type: 'group', name: plan.name, subject }),
      );
    } catch (error) {
      throw fail(plan.name, 'group', error);
    }
  }

  const tasks: { plan: Plan; subject: Subject<JsonValue> }[] = [];
  for (const plan of plans) {
    for (const subject of plan.evaluationSubjects) tasks.push({ plan, subject });
  }

  const results = await mapConcurrent(tasks, context.concurrency, task =>
    evaluateSubject(task.plan, task.subject),
  );
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    task.plan.evaluations.push({ subject: task.subject, result: results[index]! });
  }

  return plans.map(plan => {
    if (plan.skipped !== undefined) {
      return {
        name: plan.name,
        ruleFile: plan.ruleFile,
        status: 'skipped',
        reason: plan.skipped,
        evaluations: [],
      };
    }
    const status = plan.evaluations.some(evaluation => evaluation.result.status === 'violation')
      ? 'violation'
      : 'pass';
    return { name: plan.name, ruleFile: plan.ruleFile, status, evaluations: plan.evaluations };
  });
}

function groupSubjects(
  subjects: readonly ScopeSubject<JsonValue>[],
  grouping: Grouping,
  emitGroup: (subject: GroupSubject<JsonValue>) => void,
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
    const subject: GroupSubject<JsonValue> = { kind: 'group', group: descriptor, members };
    emitGroup(subject);
    return subject;
  });
}
