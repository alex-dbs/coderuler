import type { Check } from '../../app/check.ts';
import { DEFAULT_CONCURRENCY } from '../../app/concurrency.ts';
import { failureReason } from '../../app/decide-contexts.ts';
import { validateThreshold } from '../../app/decision/threshold.ts';
import type { Diagnostics } from '../../app/ports/diagnostics.ts';
import { createDiagnostics, type DiagnosticOptions } from '../console/diagnostics.ts';
import { createCheckReporter } from './check-report.ts';

export interface CheckCommandOptions extends DiagnosticOptions {
  readonly rules?: string | undefined;
  readonly diffOnly?: boolean | undefined;
  readonly base?: string | undefined;
  readonly json?: boolean | undefined;
  readonly concurrency?: number | undefined;
  readonly threshold?: number | undefined;
}

function concurrencyOf(value: number | undefined, diagnostics: Diagnostics | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value <= 0) {
    diagnostics?.important('run.invalid', { option: 'concurrency', value: String(value) });
    throw new Error(`--concurrency must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function thresholdOf(value: number | undefined, diagnostics: Diagnostics | undefined): number | undefined {
  if (value === undefined) return undefined;
  try {
    return validateThreshold(value);
  } catch (error) {
    diagnostics?.important('run.invalid', { option: 'threshold', value: String(value) });
    throw error;
  }
}

export async function checkCommand(
  application: Check,
  target: string,
  options: CheckCommandOptions,
): Promise<void> {
  const diagnostics = createDiagnostics(options);
  const requestedConcurrency = concurrencyOf(options.concurrency, diagnostics);
  const threshold = thresholdOf(options.threshold, diagnostics);
  if (options.base !== undefined && options.diffOnly !== true) {
    diagnostics?.important('run.invalid', { option: 'base', reason: 'requires diff-only' });
    throw new Error('--base requires --diff-only');
  }

  const concurrency = options.debug === true ? 1 : requestedConcurrency;
  diagnostics?.important('run.start', {
    target,
    mode: options.json === true ? 'json' : 'human',
    diff_only: options.diffOnly === true,
    base: options.base ?? 'default',
    requested: requestedConcurrency,
    concurrency,
  });
  if (options.debug === true && requestedConcurrency !== 1) {
    diagnostics?.important('concurrency.forced', { effective: 1, requested: requestedConcurrency, reason: 'debug' });
  }

  const reporter = options.json === true ? undefined : createCheckReporter({ activity: diagnostics === undefined });
  // The application owns its own failures; the CLI only names the phases it runs itself.
  let phase: 'decisions' | 'report' | undefined;
  try {
    const results = await application(
      target,
      { rules: options.rules, diffOnly: options.diffOnly === true, base: options.base, concurrency, threshold },
      reporter,
      diagnostics,
    );
    phase = 'decisions';
    if (diagnostics !== undefined) process.stderr.write('\n');
    phase = 'report';
    if (reporter === undefined) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    } else {
      reporter.finish(results);
    }
  } catch (error) {
    if (phase !== undefined) diagnostics?.important('run.failed', { phase, reason: failureReason(error) });
    throw error;
  } finally {
    reporter?.stop();
  }
}
