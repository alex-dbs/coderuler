import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import MemoryRatio from '../.rulekeeper/memory.rule.ts';
import type { LoadedRule, Rule } from '../dist/index.js';
import { createProject } from '../dist/adapter/filesystem/project.js';
import { executeRules } from '../dist/app/execute.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/memory-rule/', import.meta.url));
const message = 'Memory limit must not exceed 1.5 times the memory request.';

async function runMemoryRule(file: string) {
  const rule = new MemoryRatio();
  rule.files = [file];
  const loaded: LoadedRule = {
    name: 'memory',
    ruleFile: fileURLToPath(new URL('../.rulekeeper/memory.rule.ts', import.meta.url)),
    rule: rule as unknown as Rule<unknown>,
  };
  return executeRules([loaded], {
    project: createProject(fixtureRoot),
    isTarget: () => true,
    concurrency: 2,
    resolveDecision: () => {
      throw new Error('MemoryRatio must not call the decision backend');
    },
  });
}

test('golden: real memory rule compares quantities exactly and skips absent values', async () => {
  const reports = await runMemoryRule('quantities.yml');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.status, 'violation');
  const expected = [
    ['equal', 'pass'],
    ['boundary', 'pass'],
    ['mixedBoundary', 'pass'],
    ['overLimit', 'violation'],
    ['fractionalBoundary', 'pass'],
    ['kiloBoundary', 'pass'],
    ['decimalOverflow', 'violation'],
    ['largeBoundary', 'pass'],
    ['largeOverflow', 'violation'],
    ['zeroBoundary', 'pass'],
    ['zeroOverflow', 'violation'],
  ] as const;
  assert.deepEqual(
    reports[0]!.evaluations.map(({ subject, result }) => {
      assert.equal(subject.kind, 'scope');
      if (subject.kind !== 'scope') throw new Error('Expected a resource scope');
      return { filepath: subject.filepath, id: subject.id, result };
    }),
    expected.map(([name, status]) => ({
      filepath: 'quantities.yml',
      id: `0:/${name}/container/resources`,
      result: status === 'pass' ? { status } : { status, message },
    })),
  );
});

test('golden: real memory rule rejects a malformed present quantity instead of passing', async () => {
  await assert.rejects(runMemoryRule('invalid.yml'), /Invalid.*quantity/);
});
