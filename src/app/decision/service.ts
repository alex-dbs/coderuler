import type { RuleExamples } from '../rule/types.ts';
import type { ScopeMatch } from '../scope/types.ts';
import type { DecisionContext } from './group.ts';
import type { DecisionBackend, DecisionInstructions, DecisionObserver, DecisionScope, DecisionScopeState, DecisionState } from './port.ts';
import { DEFAULT_THRESHOLD, validateThreshold } from './threshold.ts';

export interface Decision {
  readonly follows: boolean;
  readonly probability: number;
  readonly model: string;
}

export interface DecisionInput {
  readonly context: DecisionContext;
  readonly rule: string;
  readonly examples: RuleExamples;
}

const QUESTION = 'Is the rule respected?';

function projectScope(scope: ScopeMatch): DecisionScope {
  const { id, data, source, captures } = scope;
  if (data === undefined) {
    return captures === undefined ? { id, source } : { id, source, captures };
  }
  return captures === undefined ? { id, data } : { id, data, captures };
}

function projectState(context: DecisionContext): DecisionState {
  if ('group' in context) {
    return { files: context.files.map((file) => ({ filepath: file.filepath, scopes: file.scopes.map(projectScope) })) };
  }
  const scope: DecisionScopeState = { filepath: context.filepath, scope: projectScope(context.scope) };
  return context.diff === undefined ? scope : { ...scope, diff: context.diff };
}

export class DecisionService {
  readonly #backend: DecisionBackend;
  readonly #threshold: number;

  constructor(backend: DecisionBackend, threshold: number = DEFAULT_THRESHOLD) {
    this.#backend = backend;
    this.#threshold = validateThreshold(threshold);
  }

  async decide(input: DecisionInput, observer?: DecisionObserver): Promise<Decision> {
    const hasExamples = input.examples.good.length > 0 || input.examples.bad.length > 0;
    const instructions: DecisionInstructions = hasExamples
      ? { rule: input.rule, examples: input.examples, question: QUESTION }
      : { rule: input.rule, question: QUESTION };
    const { probability, model } = await this.#backend.decide({ context: projectState(input.context), instructions }, observer);
    return { follows: probability > this.#threshold, probability, model };
  }
}
