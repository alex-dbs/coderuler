import type { DependencyOptions, DependencyServices } from '../services.js';

async function runDeps(
  operation: 'add' | 'remove' | 'sync',
  packages: readonly string[],
  options: DependencyOptions,
  services: DependencyServices,
): Promise<void> {
  await services.manageDependencies(operation, packages, options);
}

export { runDeps };
