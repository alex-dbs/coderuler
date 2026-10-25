import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { RuleReport } from '../../../app/ports.js';
import { createInspectJsonRenderer } from '../inspect-json.js';
import { CliExit, EXIT_VIOLATION } from '../exit.js';
import {
  countViolations,
  createInspectRenderer,
  createRuleHeadings,
  type InspectRenderer,
} from '../reports.js';
import type { CliContext, InspectOptions, InspectServices } from '../services.js';
import { escapeText } from '../text.js';
import { planWalk } from './rules.js';

async function runInspect(
  rule: string,
  folder: string,
  options: InspectOptions,
  context: CliContext,
  services: InspectServices,
): Promise<void> {
  let inspect: InspectRenderer | undefined = options.json === true || options.jsonl === true
    ? createInspectJsonRenderer({
      write: context.write,
      redact: context.redact,
      format: options.json === true ? 'json' : 'jsonl',
    })
    : undefined;
  try {
    const resolved = await services.resolveRuleSelector(rule, context.cwd);
    const folderPath = resolve(context.cwd, folder);
    const relativeFolder = relative(context.cwd, folderPath);
    const insideInvocationRoot =
      relativeFolder !== '..' &&
      !relativeFolder.startsWith(`..${sep}`) &&
      !isAbsolute(relativeFolder);
    const area = await services.resolveTarget(
      insideInvocationRoot ? context.cwd : folderPath,
      insideInvocationRoot ? (relativeFolder === '' ? '.' : relativeFolder) : '.',
    );
    if (area.kind !== 'directory') {
      throw new Error(`Inspect folder ${escapeText(folder)} is not a directory`);
    }
    const prepared = await planWalk(
      context.cwd,
      services,
      join(area.root, area.path),
      () => true,
      resolved,
    );
    inspect ??= createInspectRenderer({
      write: context.write,
      headings: createRuleHeadings(prepared.rules),
      redact: context.redact,
      color: options.raw !== true && context.terminal?.color === true,
      columns: () => context.terminal?.stdoutColumns ?? context.terminal?.columns ?? 80,
      raw: options.raw === true,
    });
    const reports: readonly RuleReport[] = await services.runRules(prepared.rules, {
      project: prepared.project,
      isTarget: prepared.isTarget,
      concurrency: 1,
      resolveDecision: services.decisionResolver(undefined, {
        ...(options.inputCostPerMillion === undefined ? {} : { inputCostPerMillion: options.inputCostPerMillion }),
        ...(options.outputCostPerMillion === undefined ? {} : { outputCostPerMillion: options.outputCostPerMillion }),
      }),
      emit: inspect.emit,
    });
    inspect.finish(reports);
    if (countViolations(reports) > 0) throw new CliExit(EXIT_VIOLATION);
  } catch (error) {
    if (!(error instanceof CliExit)) {
      inspect?.finish([], error instanceof Error ? error.message : String(error));
    }
    throw error;
  } finally {
    inspect?.finish([]);
  }
}

export { runInspect };
