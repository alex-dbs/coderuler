/**
 * Golden tests for the real rule pipeline from rule YAML to the Jev boundary.
 *
 * Each group holds one real `rule.yaml` plus hand-authored cases under `cases/`: real per-file inputs
 * and the contexts the rule must select, or the pipeline stage that must throw. An input is either a
 * revision (`filepath`, `diff`, optional `head` and `base`) or a file-only source (`filepath`,
 * `source`); the two shapes never mix, and file contexts omit `diff` as real file output does. The
 * rule text and examples live once, in the group rule. Nothing is mocked or generated: `parseRule`
 * compiles the group rule per case and `CompiledRule.match` runs every input, so the assertions
 * compare real output with the fixture's own data. Fixture validation runs before the pipeline and
 * outside its error handling, so a malformed fixture fails instead of masquerading as a rule error.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { parseRule, type CompiledRule, type Context } from './rule.ts';

const GOLDEN_ROOT = fileURLToPath(new URL('../tests/golden/', import.meta.url));
const RULE_FILE = 'rule.yaml';
const CASES_DIR = 'cases';
const CASE_FILE = /\.ya?ml$/;
const CASE_KEYS: readonly string[] = ['inputs', 'expected'];
const INPUT_KEYS: readonly string[] = ['filepath', 'diff', 'head', 'base', 'source'];
const REVISION_KEYS: readonly string[] = ['diff', 'head', 'base'];
const CONTEXT_KEYS: readonly string[] = ['filepath', 'diff', 'scope'];
const SCOPE_KEYS: readonly string[] = ['id', 'source', 'data', 'captures'];

/** Which end of the real pipeline failed: compiling the rule or matching one input. */
type Stage = 'compile' | 'match';

/** One revision input; `head`/`base` stay optional so a fixture can show file selection. */
interface RevisionInput {
  readonly filepath: string;
  readonly diff: string;
  readonly head?: string;
  readonly base?: string;
}

/** One fixture input: a revision pair or a file-only source. */
type FixtureInput = RevisionInput | { readonly filepath: string; readonly source: string };

/** The real `match` input type, lifted from the API so the boundary cast cannot drift from it. */
type MatchInput = Parameters<CompiledRule['match']>[0];

/** One case as written in YAML; its contexts stay as parsed, only shape-checked, for comparison. */
interface GoldenCase {
  readonly inputs: readonly FixtureInput[];
  readonly expected:
    | { readonly kind: 'match'; readonly contexts: readonly unknown[] }
    | { readonly kind: 'error'; readonly stage: Stage };
}

/** One hand-authored case plus the real rule it runs, both resolved during discovery. */
interface GoldenTarget {
  /** `<group>/<case>`: the test name and the failure label. */
  readonly label: string;
  readonly rulePath: string;
  readonly casePath: string;
}

/** The real match output, or the stage that threw. */
type PipelineOutcome =
  | { readonly ok: true; readonly contexts: readonly Context[] }
  | { readonly ok: false; readonly stage: Stage };

/** Deterministically ordered directory listing (sorted by name). */
function readEntries(dir: string): readonly Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

/** Narrow to a parsed YAML mapping (not an array or scalar). */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fixture readers: each names the field it rejects and hands the parsed value back unchanged, and
 * `requireMapping` rejects any own key outside `keys`, so a mistyped field fails before the pipeline
 * instead of looking like an expected rule error.
 */
function requireMapping(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isMapping(value)) {
    throw new Error(`${where} must be a mapping, not ${Array.isArray(value) ? 'a sequence' : typeof value}`);
  }
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${where} has unknown key(s) ${unknown.join(', ')} (allowed: ${keys.join(', ')})`);
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  return value;
}

/**
 * Reject data a context could never carry: a non-JSON leaf, or a number YAML can spell but JSON
 * cannot. Nothing is copied, and `seen` stops the walk looping on self-referencing YAML anchors.
 */
function assertJson(value: unknown, where: string, seen = new WeakSet<object>()): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where} must be a finite number`);
  } else if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    value.forEach((entry, index) => assertJson(entry, `${where}[${index}]`, seen));
  } else if (isMapping(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) assertJson(entry, `${where}.${key}`, seen);
  } else if (value !== null && typeof value !== 'boolean' && typeof value !== 'string') {
    throw new Error(`${where} must be JSON-compatible (null, boolean, finite number, string, sequence, or mapping)`);
  }
}

/** Fixture reader: the expected contexts, as parsed; a file-only context carries no `diff`. */
function requireContexts(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  value.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    const context = requireMapping(entry, CONTEXT_KEYS, at);
    requireString(context.filepath, `${at}.filepath`);
    if (Object.hasOwn(context, 'diff')) requireString(context.diff, `${at}.diff`);

    const scope = requireMapping(context.scope, SCOPE_KEYS, `${at}.scope`);
    requireString(scope.id, `${at}.scope.id`);
    requireString(scope.source, `${at}.scope.source`);
    if (Object.hasOwn(scope, 'data')) assertJson(scope.data, `${at}.scope.data`);
    if (Object.hasOwn(scope, 'captures')) assertJson(scope.captures, `${at}.scope.captures`);
  });
  return value;
}

/** Fixture reader: a file-only input, or a revision one; `source` beside a revision field is bad. */
function requireInputs(value: unknown, where: string): FixtureInput[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  if (value.length === 0) throw new Error(`${where} must not be empty`);
  return value.map((entry, index) => {
    const at = `${where}[${index}]`;
    const fields = requireMapping(entry, INPUT_KEYS, at);
    const filepath = requireString(fields.filepath, `${at}.filepath`);

    if (Object.hasOwn(fields, 'source')) {
      const revision = REVISION_KEYS.filter(key => Object.hasOwn(fields, key));
      if (revision.length > 0) throw new Error(`${at} is a file input ("source"), so it must not also set ${revision.join(', ')}`);
      return { filepath, source: requireString(fields.source, `${at}.source`) };
    }

    const input: { filepath: string; diff: string; head?: string; base?: string } = {
      filepath,
      diff: requireString(fields.diff, `${at}.diff`),
    };
    if (Object.hasOwn(fields, 'head')) input.head = requireString(fields.head, `${at}.head`);
    if (Object.hasOwn(fields, 'base')) input.base = requireString(fields.base, `${at}.base`);
    return input;
  });
}

/** Fixture reader: contexts, or the failing stage — exactly one, and never the error's message. */
function requireExpectation(value: unknown, where: string): GoldenCase['expected'] {
  const failed = isMapping(value) && Object.hasOwn(value, 'error');
  const fields = requireMapping(value, failed ? ['error'] : ['contexts'], where);
  if (failed) {
    const error = requireMapping(fields.error, ['stage'], `${where}.error`);
    const stage = requireString(error.stage, `${where}.error.stage`);
    if (stage !== 'compile' && stage !== 'match') throw new Error(`${where}.error.stage must be "compile" or "match"`);
    return { kind: 'error', stage };
  }

  if (!Object.hasOwn(fields, 'contexts')) throw new Error(`${where}.contexts is required unless the case expects an error`);
  return { kind: 'match', contexts: requireContexts(fields.contexts, `${where}.contexts`) };
}

/** Parse one case file; every problem here is a fixture problem, never an expected rule error. */
function parseCase(source: string, where: string): GoldenCase {
  const fields = requireMapping(parse(source, { uniqueKeys: true }), CASE_KEYS, where);
  if (!Object.hasOwn(fields, 'inputs')) throw new Error(`${where}.inputs is required`);
  if (!Object.hasOwn(fields, 'expected')) throw new Error(`${where}.expected is required`);
  return {
    inputs: requireInputs(fields.inputs, `${where}.inputs`),
    expected: requireExpectation(fields.expected, `${where}.expected`),
  };
}

/**
 * Compile and match, flattening contexts in input order. Only production `Error`s are reported,
 * tagged with the stage that threw; any other throw propagates. The cast bridges the fixture's
 * optional sources to the runtime type a selected file needs.
 */
function runPipeline(ruleSource: string, inputs: readonly FixtureInput[]): PipelineOutcome {
  let rule: CompiledRule;
  try {
    rule = parseRule(ruleSource);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, stage: 'compile' };
  }

  try {
    const contexts: Context[] = [];
    for (const input of inputs) contexts.push(...rule.match(input as MatchInput));
    return { ok: true, contexts };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, stage: 'match' };
  }
}

/** Compare one case's hand-authored expectation with the real pipeline output for its group rule. */
function checkCase(target: GoldenTarget): void {
  const { label } = target;
  const golden = parseCase(readFileSync(target.casePath, 'utf8'), label);
  const outcome = runPipeline(readFileSync(target.rulePath, 'utf8'), golden.inputs);
  const expected = golden.expected;

  if (expected.kind === 'error') {
    if (!outcome.ok) {
      assert.strictEqual(outcome.stage, expected.stage, `${label}: expected the ${expected.stage} stage to throw, but the ${outcome.stage} stage threw`);
      return;
    }
    assert.fail(`${label}: expected the ${expected.stage} stage to throw, but the rule matched ${outcome.contexts.length} context(s)`);
    return;
  }

  if (!outcome.ok) {
    assert.fail(`${label}: expected a match, but the ${outcome.stage} stage threw`);
    return;
  }

  assert.deepStrictEqual(outcome.contexts, expected.contexts, `${label}: contexts differ from the expected contexts`);
}

/** Resolve every group rule and its ordered case files; an absent or unreadable fixture throws. */
function discoverTargets(): GoldenTarget[] {
  const groups = readEntries(GOLDEN_ROOT).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  if (groups.length === 0) {
    throw new Error(`No golden fixture groups in ${GOLDEN_ROOT}; expected <group>/${RULE_FILE} with <group>/${CASES_DIR}/*.yaml`);
  }

  return groups.flatMap(group => {
    const dir = join(GOLDEN_ROOT, group.name);
    const rulePath = join(dir, RULE_FILE);
    if (!existsSync(rulePath)) throw new Error(`${group.name} must contain exactly one ${RULE_FILE}`);
    const casesDir = join(dir, CASES_DIR);
    const caseFiles = readEntries(casesDir).filter(entry => (entry.isFile() || entry.isSymbolicLink()) && CASE_FILE.test(entry.name));
    if (caseFiles.length === 0) throw new Error(`${group.name}/${CASES_DIR} must contain at least one case YAML`);
    return caseFiles.map(file => ({ label: `${group.name}/${file.name.replace(CASE_FILE, '')}`, rulePath, casePath: join(casesDir, file.name) }));
  });
}

try {
  for (const target of discoverTargets()) test(target.label, () => checkCase(target));
} catch (error) {
  test('golden fixtures', () => {
    throw error;
  });
}
