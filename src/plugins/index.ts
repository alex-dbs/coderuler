import { PluginRegistry } from './registry.ts';
import { astGrepPlugin } from './astgrep.ts';
import { protobufPlugin } from './protobuf.ts';
import { yamlPlugin } from './yaml.ts';
import type { ScopePlugin } from './types.ts';

export { PluginRegistry } from './registry.ts';
export { astGrepPlugin } from './astgrep.ts';
export { createAstGrepLanguageRegistrations } from './astgrep-languages.ts';
export { protobufPlugin } from './protobuf.ts';
export { yamlPlugin } from './yaml.ts';
export type { CompiledScope, JsonValue, ScopeInput, ScopeMatch, ScopePlugin } from './types.ts';

/**
 * The three builtin scope formats plus any host-supplied formats. A fresh registry is returned on
 * every call, so extras never leak into the shared defaults or another caller.
 */
export function createPluginRegistry(additional: readonly ScopePlugin[] = []): PluginRegistry {
  return new PluginRegistry([yamlPlugin, protobufPlugin, astGrepPlugin, ...additional]);
}
