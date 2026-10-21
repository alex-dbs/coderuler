import { readFileSync } from 'node:fs';
import { installDependencyRegistry, type RegistryArtifact } from './dependency-support.ts';

const configuration = process.env.RK_DEPENDENCY_FIXTURE;
if (configuration !== undefined) {
  const artifacts = JSON.parse(readFileSync(configuration, 'utf8')) as RegistryArtifact[];
  const mode = process.env.RK_DEPENDENCY_FIXTURE_MODE ?? 'all';
  if (mode !== 'all' && mode !== 'tarballs' && mode !== 'offline') throw new Error(`Invalid dependency fixture mode: ${mode}`);
  const requestLog = process.env.RK_DEPENDENCY_REQUEST_LOG;
  installDependencyRegistry({ artifacts }, { mode, ...(requestLog === undefined ? {} : { requestLog }) });
}
