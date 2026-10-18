import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createSandbox, runCli, writeFile } from './support.ts';

const sandbox = createSandbox('rulekeeper-test-timeout-');
after(() => sandbox.cleanup());

test('test stops synchronous and asynchronous hangs, cleans their projects, and runs later cases', { timeout: 15_000 }, async context => {
  const target = sandbox.isolated('timeouts');
  const roots = join(target.root, 'case-roots.jsonl');
  writeFile(join(target.cwd, '.rulekeeper/deadline.rule.ts'), `import { appendFileSync } from 'node:fs';
import { Rule, pass, test } from '@alex-dbs/rulekeeper';
export default class Deadline extends Rule {
  files = ['inputs/*.txt'];
  runs = 0;
  when({ project }) {
    appendFileSync(${JSON.stringify(roots)}, JSON.stringify(project.root) + '\\n');
    return true;
  }
  check = async subject => {
    if (++this.runs !== 1) throw new Error('rule state leaked between cases');
    // Keep a real worker handle alive: CLI exit must require termination, not natural drain.
    setInterval(() => {}, 60_000);
    if (subject.source === 'SYNC') {
      while (true) {}
    }
    if (subject.source === 'ASYNC') await Promise.withResolvers().promise;
    return pass();
  };
}
export const tests = [
  test('runs before either timeout').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('synchronous deadline').withFiles({ 'inputs/one.txt': 'SYNC' }).passes(),
  test('runs between timeouts').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
  test('asynchronous deadline').withFiles({ 'inputs/one.txt': 'ASYNC' }).passes(),
  test('runs after both timeouts').withFiles({ 'inputs/one.txt': 'GOOD' }).passes(),
];`);
  const pending = runCli(['test', '--timeout', '1s', '--concurrency', '1'], target);
  context.signal.addEventListener('abort', () => pending.terminate(), { once: true });
  const result = await pending;
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const cases = result.stdout.match(/^[├└]─ .+$/gm) ?? [];
  assert.equal(cases.length, 5, result.stdout);
  assert.match(cases[0]!, /^├─ PASS runs before either timeout \(\d+\.\d{2}(?:ms|s|min|h|d)\)$/);
  assert.match(cases[1]!, /^├─ FAIL synchronous deadline .*timeout.*\(\d+\.\d{2}(?:ms|s|min|h|d)\)$/);
  assert.match(cases[2]!, /^├─ PASS runs between timeouts \(\d+\.\d{2}(?:ms|s|min|h|d)\)$/);
  assert.match(cases[3]!, /^├─ FAIL asynchronous deadline .*timeout.*\(\d+\.\d{2}(?:ms|s|min|h|d)\)$/);
  assert.match(cases[4]!, /^└─ PASS runs after both timeouts \(\d+\.\d{2}(?:ms|s|min|h|d)\)$/);
  assert.match(result.stdout, /Time: \d+\.\d{2}(?:ms|s|min|h|d)/);
  const caseRoots = readFileSync(roots, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string);
  assert.equal(caseRoots.length, 5);
  assert.equal(new Set(caseRoots).size, 5);
  for (const root of caseRoots) assert.equal(existsSync(root), false, root);
});
