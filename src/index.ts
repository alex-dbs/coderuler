export { Rule } from './app/rule.js';
export { test } from './app/rule-tests.js';
export type { RuleTestCase } from './app/rule-tests.js';
export type {
  AiExamples,
  AiOptions,
  Awaitable,
  CheckContext,
  CheckResult,
  Evaluator,
  Grouping,
  GroupSubject,
  JsonValue,
  PredicateResult,
  ProjectContext,
  RuleSettings,
  ScopeMatch,
  ScopeSelector,
  ScopeSubject,
  Selection,
  SelectionContext,
  SourceFile,
  Subject,
} from './app/rule.js';

export { ai, pass, regex, violation } from './app/evaluators.js';
export type { RegexOptions } from './app/evaluators.js';

export type {
  CsvOptions,
  CsvRow,
  DecisionBackend,
  DecisionExchange,
  DecisionInstructions,
  DecisionObserver,
  DecisionOutcome,
  DecisionRequest,
  DecisionRuntime,
  LoadedRule,
  Project,
  RuleEvaluation,
  RuleLoader,
  RuleReport,
  RuleSelection,
  RunContext,
  RunEvent,
} from './app/ports.js';

import { astGrep } from './adapter/scope/astgrep.js';
import { csv } from './adapter/scope/csv.js';
import { file } from './adapter/scope/file.js';
import { json } from './adapter/scope/json.js';
import { protobuf } from './adapter/scope/protobuf.js';
import { yaml } from './adapter/scope/yaml.js';

export { createAstGrepLanguageRegistrations } from './adapter/scope/astgrep-languages.js';

export const scopes = { file, json, yaml, csv, astGrep, protobuf };
