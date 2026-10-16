import type { InspectCommand } from '../../app/inspect.ts';
import { createInspectionReporter } from './inspect-report.ts';

export async function inspectCommand(application: InspectCommand, rule: string, folder: string): Promise<void> {
  const reporter = createInspectionReporter();
  try {
    await application(rule, folder, reporter);
  } catch (error) {
    reporter.failed(error);
    throw error;
  }
}
