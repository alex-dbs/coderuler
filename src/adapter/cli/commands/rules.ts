import type { LoadedRule, Project, RuleSelection } from '../../../app/ports.js';
import type { ExecutionServices, RuleSelectorResolution } from '../services.js';

interface ExecutionPlan {
  readonly rules: readonly LoadedRule[];
  readonly project: Project;
  readonly isTarget: (filepath: string) => boolean;
}

function ruleSelection(cwd: string, choice: RuleSelectorResolution, root: string): RuleSelection {
  if (choice.explicit !== undefined) {
    return { root, explicit: choice.explicit, invocationCwd: cwd };
  }
  if (choice.name !== undefined) {
    return { root, name: choice.name, invocationCwd: cwd };
  }
  return { root, invocationCwd: cwd };
}

async function planWalk(
  cwd: string,
  services: ExecutionServices,
  root: string,
  isTarget: (filepath: string) => boolean,
  choice: RuleSelectorResolution,
  rulesRoot: string = root,
): Promise<ExecutionPlan> {
  const rules = await services.loadRules(ruleSelection(cwd, choice, rulesRoot));
  const project = services.createProject(root, {
    excludeFiles: rules.map(entry => entry.ruleFile),
  });
  return { rules, project, isTarget };
}

export { planWalk, ruleSelection };
