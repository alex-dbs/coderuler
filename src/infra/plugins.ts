import { PluginRegistry } from '../app/scope/registry.ts';
import type { ScopePlugin } from '../app/scope/types.ts';
import { astGrepPlugin } from '../adapter/scope/astgrep.ts';
import { protobufPlugin } from '../adapter/scope/protobuf.ts';
import { yamlPlugin } from '../adapter/scope/yaml.ts';

export function createPluginRegistry(additional: readonly ScopePlugin[] = []): PluginRegistry {
  return new PluginRegistry([yamlPlugin, protobufPlugin, astGrepPlugin, ...additional]);
}
