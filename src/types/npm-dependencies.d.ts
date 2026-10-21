declare module 'npm-package-arg' {
  interface Result {
    readonly name?: string;
    readonly type: string;
    readonly registry: boolean;
    readonly rawSpec: string;
    readonly fetchSpec: string | null;
  }
  interface Parse {
    (specifier: string): Result;
    resolve(name: string, specifier: string): Result;
  }
  const parse: Parse;
  export default parse;
}

declare module '@npmcli/arborist' {
  export interface Edge {
    readonly name: string;
    readonly optional: boolean;
    readonly peer: boolean;
    readonly valid: boolean;
    readonly to: Node | null;
  }
  export interface Node {
    readonly location: string;
    readonly version: string;
    readonly inert: boolean;
    package: Record<string, unknown>;
    readonly edgesOut: Map<string, Edge>;
    readonly inventory: {
      get(location: string): Node | undefined;
      values(): IterableIterator<Node>;
    };
    readonly meta: {
      add(node: Node): void;
      toString(): string;
    };
  }
  export default class Arborist {
    constructor(options: Record<string, unknown>);
    buildIdealTree(options?: { readonly add?: readonly string[]; readonly rm?: readonly string[] }): Promise<Node>;
    reify(options?: { readonly save?: boolean }): Promise<Node>;
  }
}

declare module 'pacote' {
  const pacote: {
    extract(specifier: string, destination: string, options: Record<string, unknown>): Promise<unknown>;
  };
  export default pacote;
}

declare module 'ssri' {
  interface Integrity {
    readonly sha512?: readonly { readonly digest: string }[];
    toString(): string;
  }
  export function parse(value: string, options?: { readonly strict?: boolean }): Integrity | null;
}

declare module 'npm-install-checks' {
  export const currentEnv: { libc(platform: string): string | null | undefined };
}

declare module '@npmcli/package-json' {
  export default class PackageJson {
    static readonly normalizeSteps: readonly string[];
    readonly content: Record<string, unknown>;
    fromContent(content: Record<string, unknown>): this;
    normalize(options?: { readonly steps?: readonly string[] }): Promise<this>;
  }
}
