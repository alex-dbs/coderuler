import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { DecisionRequest, LineRange } from '../dist/index.js';
import { executeRules } from '../dist/app/execute.js';
import { createProject } from '../dist/adapter/filesystem/project.js';
import { createRuleLoader } from '../dist/adapter/filesystem/rules.js';
import { createSandbox, writeFile } from './support.ts';

const sandbox = createSandbox('coderuler-srp-diff-');
const ruleFile = fileURLToPath(new URL('../.coderuler.examples/go-single-responsibility.rule.ts', import.meta.url));
after(() => sandbox.cleanup());

async function check(changedLines?: ReadonlyMap<string, readonly LineRange[]>) {
  const { cwd } = sandbox.isolated('project');
  writeFile(join(cwd, 'model.go'), `package user

type UserService struct{}
type ReportService struct{}
`);
  writeFile(join(cwd, 'methods.go'), `package user

func (s UserService) GetUser() {}
func (s ReportService) Report() {}

func (s *UserService) SendEmail() {}

func helper() {}
`);
  const rules = await createRuleLoader({ home: join(cwd, 'absent-home') }).load({
    root: cwd, explicit: ruleFile, invocationCwd: cwd,
  });
  const requests: DecisionRequest[] = [];
  await executeRules(rules, {
    project: createProject(cwd),
    isTarget: () => true,
    concurrency: 1,
    ...(changedLines === undefined ? {} : {
      changedFiles: new Set(changedLines.keys()),
      changedLines,
    }),
    resolveDecision: () => ({
      backend: { decide: async request => {
        requests.push(request);
        return { probability: 1, model: 'test' };
      } },
      threshold: 0.4,
      pricing: { inputCostPerMillion: 0, outputCostPerMillion: 0 },
    }),
  });
  return requests.map(request => request.state);
}

test('diff checks only structs whose methods changed, including methods in another file', async () => {
  const states = await check(new Map([['methods.go', [{ start: 6, end: 6 }]]]));
  assert.deepEqual(states, [{
    struct: 'type UserService struct{}',
    methods: ['func (s UserService) GetUser()', 'func (s *UserService) SendEmail()'],
  }]);
});

test('diff checks one struct only once when several of its methods change', async () => {
  const states = await check(new Map([['methods.go', [{ start: 3, end: 3 }, { start: 6, end: 6 }]]]));
  assert.deepEqual(states, [{
    struct: 'type UserService struct{}',
    methods: ['func (s UserService) GetUser()', 'func (s *UserService) SendEmail()'],
  }]);
});

test('diff ignores changes outside receiver methods', async () => {
  assert.deepEqual(await check(new Map([['methods.go', [{ start: 8, end: 8 }]]])), []);
});

test('a normal scan checks all structs', async () => {
  const states = await check();
  assert.deepEqual(states, [
    { struct: 'type UserService struct{}', methods: ['func (s UserService) GetUser()', 'func (s *UserService) SendEmail()'] },
    { struct: 'type ReportService struct{}', methods: ['func (s ReportService) Report()'] },
  ]);
});
