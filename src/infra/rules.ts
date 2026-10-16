import { compileRule as compileDefinition } from '../app/rule/compile.ts';
import type { CompiledRule } from '../app/rule/types.ts';
import type { PluginRegistry } from '../app/scope/registry.ts';
import { warnUnknownField } from '../adapter/console/warnings.ts';
import { decodeRule } from '../adapter/rule/yaml.ts';
import { createPluginRegistry } from './plugins.ts';

export type { CompiledRule };

let builtinRegistry: PluginRegistry | undefined;

export function compileRule(definition: unknown, filepath: string, registry?: PluginRegistry): CompiledRule {
  const scopes = registry ?? (builtinRegistry ??= createPluginRegistry());
  return compileDefinition(definition, filepath, { registry: scopes, warnUnknownField });
}

export function parseRule(source: string, filepath: string, registry?: PluginRegistry): CompiledRule {
  return compileRule(decodeRule(source), filepath, registry);
}
