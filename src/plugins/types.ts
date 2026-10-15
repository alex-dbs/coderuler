export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface LineSpan {
  readonly start: number;
  readonly end: number;
}

export interface ScopeMatch {
  readonly id: string;
  readonly source: string;
  readonly data?: JsonValue;
  readonly captures?: Readonly<Record<string, string | readonly string[]>>;
  readonly lines?: LineSpan;
}

export interface ScopeInput {
  readonly filepath: string;
  readonly source: string;
}

export interface CompiledScope {
  select(input: ScopeInput): readonly ScopeMatch[];
}

export interface ScopePlugin {
  readonly format: string;
  compile(options: Readonly<Record<string, unknown>>): CompiledScope;
}
