import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep, win32 } from 'node:path';
import { parentPort } from 'node:worker_threads';

import { executeRules } from '../../app/execute.js';
import type { RuleTestCase } from '../../app/rule-tests.js';
import { createDecisionResolver } from '../../infra/settings.js';
import { createProject } from './project.js';
import { createRuleLoader } from './rules.js';

export interface RuleTestWorkerRequest {
  readonly id: number;
  readonly root: string;
  readonly ruleFile: string;
  readonly files: RuleTestCase['files'];
  readonly ai: boolean;
}

export type RuleTestWorkerMessage =
  | { readonly id: number; readonly actual: RuleTestCase['expected'] }
  | { readonly id: number; readonly error: string };

function fixturePath(root: string, filepath: string): string {
  const target = resolve(root, filepath);
  if (isAbsolute(filepath) || win32.isAbsolute(filepath) || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Fixture path "${filepath}" must be relative and stay inside the test project`);
  }
  return target;
}

async function runCase({ root, ruleFile, files, ai }: RuleTestWorkerRequest): Promise<RuleTestCase['expected']> {
  for (const [filepath, source] of Object.entries(files)) {
    const target = fixturePath(root, filepath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof source === 'string' ? source : JSON.stringify(source, null, 2), 'utf8');
  }
  const rules = await createRuleLoader().load({ root, explicit: ruleFile, invocationCwd: root });
  if (rules.length !== 1) throw new Error('Expected exactly one freshly loaded rule');
  const reports = await executeRules(rules, {
    project: createProject(root, { excludeFiles: [ruleFile] }),
    isTarget: () => true,
    concurrency: 1,
    resolveDecision: ai ? createDecisionResolver(process.env) : () => {
      throw new Error('Inline rule tests must not call the decision backend');
    },
  });
  const report = reports[0];
  if (reports.length !== 1 || report === undefined) throw new Error('Expected exactly one rule report');
  return report.status;
}

const port = parentPort;
if (port === null) throw new Error('Rule test cases must run in a worker');
port.start();
port.ref();
port.on('message', (request: RuleTestWorkerRequest) => {
  void runCase(request).then(
    actual => port.postMessage({ id: request.id, actual } satisfies RuleTestWorkerMessage),
    error => port.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies RuleTestWorkerMessage),
  );
});
