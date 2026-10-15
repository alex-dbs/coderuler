/** A JSON-compatible value: what a scope's `data` payload may contain. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * One selected unit of a source file. `id` names the scope within its revision; `source` is the
 * exact matched text; `data` is the structured payload a plugin exposes for comparison; `captures`
 * holds named metavariables when the underlying matcher has them.
 */
export interface ScopeMatch {
  readonly id: string;
  readonly source: string;
  readonly data?: JsonValue;
  readonly captures?: Readonly<Record<string, string | readonly string[]>>;
}

/** One revision's text handed to a compiled scope. */
export interface ScopeInput {
  readonly filepath: string;
  readonly source: string;
}

/** A plugin compiled against its rule options: selects scopes from a single revision. */
export interface CompiledScope {
  select(input: ScopeInput): readonly ScopeMatch[];
}

/** A trusted scope format, explicitly injected by the host rather than named by rule YAML. */
export interface ScopePlugin {
  readonly format: string;
  compile(options: Readonly<Record<string, unknown>>): CompiledScope;
}
