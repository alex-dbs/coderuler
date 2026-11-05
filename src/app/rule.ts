import type {
  DocumentSymbol,
  Hover,
  Location,
  SymbolInformation,
  WorkspaceSymbol,
} from 'vscode-languageserver-protocol';
import type { Project } from './ports.js';

export type {
  DocumentSymbol,
  Hover,
  Location,
  SymbolInformation,
  WorkspaceSymbol,
} from 'vscode-languageserver-protocol';

export type Awaitable<T> = T | Promise<T>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PredicateResult = boolean | { readonly applies: boolean; readonly reason?: string };

export interface SourceFile {
  readonly filepath: string;
  readonly source: string;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface LspTarget {
  readonly filepath: string;
  readonly line: number;
  readonly column?: number;
}

export interface LspOptions {
  readonly includeDependencies?: boolean;
}

export interface LspReferenceOptions extends LspOptions {
  readonly includeDeclaration?: boolean;
}

export interface LspCallOptions extends LspOptions {
  readonly depth: number;
}

export interface LspCall {
  readonly name: string;
  readonly filepath: string;
  readonly source: string;
  readonly lines: LineRange;
  readonly depth: number;
}

export interface LspTools {
  definitions(target: LspTarget, options?: LspOptions): Promise<readonly Location[]>;
  declarations(target: LspTarget, options?: LspOptions): Promise<readonly Location[]>;
  typeDefinitions(target: LspTarget, options?: LspOptions): Promise<readonly Location[]>;
  implementations(target: LspTarget, options?: LspOptions): Promise<readonly Location[]>;
  references(target: LspTarget, options?: LspReferenceOptions): Promise<readonly Location[]>;
  hover(target: LspTarget, options?: LspOptions): Promise<Hover | null>;
  documentSymbols(filepath: string, options?: LspOptions): Promise<readonly DocumentSymbol[] | readonly SymbolInformation[]>;
  workspaceSymbols(query: string, options?: LspOptions): Promise<readonly (SymbolInformation | WorkspaceSymbol)[]>;
  callers(target: LspTarget, options: LspCallOptions): Promise<readonly LspCall[]>;
  callees(target: LspTarget, options: LspCallOptions): Promise<readonly LspCall[]>;
}

export interface ScopeMatch<T = JsonValue> {
  readonly id: string;
  readonly source: string;
  readonly data?: T;
  readonly captures?: Readonly<Record<string, string | readonly string[]>>;
  readonly lines?: LineRange;
}

export interface ScopeSubject<T = JsonValue> extends ScopeMatch<T> {
  readonly kind: 'scope';
  readonly filepath: string;
}

export interface GroupSubject<T = JsonValue> {
  readonly kind: 'group';
  readonly group: { readonly type: 'file' | 'folder' | 'project'; readonly path: string };
  readonly members: readonly ScopeSubject<T>[];
}

export type Subject<T = JsonValue> = ScopeSubject<T> | GroupSubject<T>;

export type ScopeSelector<T = JsonValue> = {
  bivarianceHack(file: SourceFile, context?: ProjectContext): Awaitable<readonly ScopeMatch<T>[]>;
}['bivarianceHack'];

export type Grouping =
  | 'scope'
  | 'file'
  | 'folder'
  | 'project'
  | { readonly by: 'folder'; readonly level: number };

export interface RuleSettings {
  readonly backend?: 'jev' | 'openai';
  readonly model?: string;
  readonly threshold?: number;
  readonly inputCostPerMillion?: number;
  readonly outputCostPerMillion?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface TokenPricing {
  readonly inputCostPerMillion: number;
  readonly outputCostPerMillion: number;
}

export interface AiUsage extends TokenUsage {
  readonly calls: number;
  readonly unreportedCalls: number;
  readonly inputCost: number;
  readonly outputCost: number;
}

export interface ViolationLocation {
  readonly filepath: string;
  readonly scopeId?: string;
  readonly lines?: LineRange;
}

export interface CheckResult {
  readonly status: 'pass' | 'violation';
  readonly message?: string;
  readonly locations?: readonly ViolationLocation[];
  readonly probability?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly usage?: AiUsage;
}

export interface AiExamples {
  readonly good?: readonly string[];
  readonly bad?: readonly string[];
}

export type AiOptions<T = JsonValue> = {
  readonly examples?: AiExamples;
  readonly violationMessage?: string;
  readonly input?: (subject: Subject<T>, context: ProjectContext) => Awaitable<JsonValue>;
} & (
  | {
      /** @deprecated Use `instruction` instead. */
      readonly rule: string;
      readonly instruction?: never;
    }
  | { readonly instruction: string; readonly rule?: never }
);

export type Evaluator<T = JsonValue> = (
  subject: Subject<T>,
  context: CheckContext<T>,
) => Awaitable<CheckResult>;

export interface ProjectContext {
  readonly project: Project;
  readonly goLsp: LspTools;
  readonly changedFiles?: ReadonlySet<string>;
  readonly changedLines?: ReadonlyMap<string, readonly LineRange[]>;
  trace(message: string, details?: JsonValue): void;
}

export interface Selection<T = JsonValue> {
  readonly files: readonly string[];
  readonly exclude?: readonly string[];
  readonly scope?: ScopeSelector<T>;
}

export interface SelectionContext extends ProjectContext {
  select<T>(selection: Selection<T>): Promise<readonly ScopeSubject<T>[]>;
}

export interface CheckContext<T = JsonValue> extends SelectionContext {
  readonly ruleName: string;
  ai(options: AiOptions<T>): Promise<CheckResult>;
}

export function isDiffMode(context: ProjectContext): boolean {
  return context.changedFiles !== undefined || context.changedLines !== undefined;
}

export function isInDiff(subject: ScopeSubject<unknown>, context: ProjectContext): boolean {
  const lines = subject.lines;
  const ranges = context.changedLines?.get(subject.filepath);
  if (lines === undefined || ranges === undefined) return false;
  for (const range of ranges) {
    if (range.start <= lines.end && lines.start <= range.end) return true;
  }
  return false;
}


export const RULE_BRAND: symbol = Symbol.for('coderuler.Rule');

export abstract class Rule<T = JsonValue> {
  enabled: boolean = true;
  files: readonly string[] = ['**/*'];
  exclude: readonly string[] = [];
  tags?: readonly string[];
  scope?: ScopeSelector<T>;
  settings: RuleSettings = {};
  group: Grouping = 'scope';
  comment?: string;

  when(_context: ProjectContext): Awaitable<PredicateResult> {
    return true;
  }

  filter(_subject: ScopeSubject<T>, _context: ProjectContext): Awaitable<PredicateResult> {
    return true;
  }

  select(context: SelectionContext): Awaitable<readonly ScopeSubject<T>[]> {
    const { files, exclude, scope } = this;
    return scope === undefined
      ? context.select<T>({ files, exclude })
      : context.select<T>({ files, exclude, scope });
  }

  abstract check: Evaluator<T>;
}

Object.defineProperty(Rule.prototype, RULE_BRAND, { value: true, enumerable: false });
