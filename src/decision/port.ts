import type { Context, RuleExamples } from '../rule.ts';

/**
 * The review instruction one decision is judged by: the rule text, the illustrative snippets a
 * reviewer reads alongside it, and the single question the backend is asked. The service builds it
 * once per decision and the backend reads it verbatim.
 */
export interface DecisionInstructions {
  readonly rule: string;
  readonly examples: RuleExamples;
  /** The yes/no question the backend answers, phrased against the state it is given. */
  readonly question: string;
}

/** One decision request: the selected context to judge, with the instruction judging it. */
export interface DecisionRequest {
  readonly context: Context;
  readonly instructions: DecisionInstructions;
}

/** One backend answer: the probability the question holds, and the model that answered it. */
export interface BackendDecision {
  readonly probability: number;
  readonly model: string;
}

/**
 * The decision backend one request is evaluated against. An implementation answers exactly the
 * request it is handed; retrying, reporting and aggregating belong to the caller, and no wire
 * format of a particular backend is part of this contract.
 */
export interface DecisionBackend {
  decide(request: DecisionRequest): Promise<BackendDecision>;
}
