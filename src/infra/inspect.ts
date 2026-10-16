import { realpath } from 'node:fs/promises';
import { createRuleSelector, resolveInspectionFolder } from '../adapter/filesystem/rule-selector.ts';
import { createSourceRepository } from '../adapter/filesystem/sources.ts';
import { createInspect, type InspectCommand } from '../app/inspect.ts';
import { createDecisionService } from './decision.ts';
import type { StatisticsStore } from '../app/ports/statistics.ts';
import { trackInspect } from '../app/statistics.ts';
import { parseRule } from './rules.ts';

export function createInspectCommand(statistics: StatisticsStore): InspectCommand {
  return async function inspectCommand(selector, folder, observer) {
    const invocationCwd = process.cwd();
    const root = await resolveInspectionFolder(folder, invocationCwd);
    const inspect = createInspect({
      rules: createRuleSelector({ cwd: root, invocationCwd }),
      compile: parseRule,
      sources: createSourceRepository({ cwd: root }),
      createDecisionService: (settings) => createDecisionService(undefined, undefined, undefined, settings),
      cwd: root,
    });
    const application = trackInspect(inspect, await realpath(root), statistics, () => performance.now());
    return await application(selector, observer);
  };
}
