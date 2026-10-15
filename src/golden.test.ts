import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { parseRule, type CompiledRule } from './infra/rules.ts';
import type { Context } from './app/rule/types.ts';

const GOLDEN_ROOT = fileURLToPath(new URL('../tests/golden/', import.meta.url));
const RULE_FILE = 'rule.yaml';
const CASES_DIR = 'cases';
const CASE_FILE = /\.ya?ml$/;
const CASE_KEYS: readonly string[] = ['inputs', 'expected'];
const INPUT_KEYS: readonly string[] = ['filepath', 'diff', 'head', 'base', 'source'];
const REVISION_KEYS: readonly string[] = ['diff', 'head', 'base'];
const CONTEXT_KEYS: readonly string[] = ['filepath', 'diff', 'scope'];
const SCOPE_KEYS: readonly string[] = ['id', 'source', 'data', 'captures', 'lines'];
const LINE_KEYS: readonly string[] = ['start', 'end'];

type Stage = 'compile' | 'match';

interface RevisionInput {
  readonly filepath: string;
  readonly diff: string;
  readonly head?: string;
  readonly base?: string;
}

type FixtureInput = RevisionInput | { readonly filepath: string; readonly source: string };

type MatchInput = Parameters<CompiledRule['match']>[0];

interface GoldenCase {
  readonly inputs: readonly FixtureInput[];
  readonly expected:
    | { readonly kind: 'match'; readonly contexts: readonly unknown[] }
    | { readonly kind: 'error'; readonly stage: Stage };
}

interface GoldenTarget {
  readonly label: string;
  readonly rulePath: string;
  readonly casePath: string;
}

type PipelineOutcome =
  | { readonly ok: true; readonly contexts: readonly Context[] }
  | { readonly ok: false; readonly stage: Stage };

function readEntries(dir: string): readonly Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireMapping(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isMapping(value)) {
    throw new Error(`${where} must be a mapping, not ${Array.isArray(value) ? 'a sequence' : typeof value}`);
  }
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${where} has unknown key(s) ${unknown.join(', ')} (allowed: ${keys.join(', ')})`);
  return value;
}

function requireLineNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${where} must be a positive integer line number`);
  }
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  return value;
}

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
    if (Object.hasOwn(scope, 'lines')) {
      const span = requireMapping(scope.lines, LINE_KEYS, `${at}.scope.lines`);
      const start = requireLineNumber(span.start, `${at}.scope.lines.start`);
      const end = requireLineNumber(span.end, `${at}.scope.lines.end`);
      if (end < start) throw new Error(`${at}.scope.lines.end (${end}) must not precede .start (${start})`);
    }
  });
  return value;
}

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

function parseCase(source: string, where: string): GoldenCase {
  const fields = requireMapping(parse(source, { uniqueKeys: true }), CASE_KEYS, where);
  if (!Object.hasOwn(fields, 'inputs')) throw new Error(`${where}.inputs is required`);
  if (!Object.hasOwn(fields, 'expected')) throw new Error(`${where}.expected is required`);
  return {
    inputs: requireInputs(fields.inputs, `${where}.inputs`),
    expected: requireExpectation(fields.expected, `${where}.expected`),
  };
}

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
