import type { ScopePlugin } from './types.ts';

/**
 * Trusted set of scope formats available to a rule. Plugins are injected by the host; rule YAML
 * only names a format, so a rule can never load code of its own.
 */
export class PluginRegistry {
  readonly #plugins = new Map<string, ScopePlugin>();

  constructor(plugins: readonly ScopePlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  /** Add a plugin, rejecting an empty format or a format already taken. */
  register(plugin: ScopePlugin): this {
    const format = plugin?.format;
    if (typeof format !== 'string' || format === '') {
      throw new Error('A scope plugin must declare a non-empty string format');
    }
    if (this.#plugins.has(format)) {
      throw new Error(`A scope plugin is already registered for format "${format}"`);
    }
    this.#plugins.set(format, plugin);
    return this;
  }

  /** Resolve a registered plugin by format. */
  get(format: string): ScopePlugin {
    const plugin = this.#plugins.get(format);
    if (plugin === undefined) throw new Error(`No scope plugin is registered for format "${format}"`);
    return plugin;
  }
}
