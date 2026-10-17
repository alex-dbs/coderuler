import type { Project } from './ports.js';

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

export interface ScopeMatch<T = JsonValue> {
  readonly id: string;
  readonly source: string;
  readonly data?: T;
  readonly captures?: Readonly<Record<string, string | readonly string[]>>;
  readonly lines?: { readonly start: number; readonly end: number };
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

export type ScopeSelector<T = JsonValue> = (file: SourceFile) => Awaitable<readonly ScopeMatch<T>[]>;

export type Grouping =
  | 'scope'
  | 'file'
  | 'folder'
  | 'project'
  | { readonly by: 'folder'; readonly level: number };

export interface RuleSettings {
  readonly backend?: 'jev';
  readonly model?: string;
  readonly threshold?: number;
}

export interface CheckResult {
  readonly status: 'pass' | 'violation';
  readonly message?: string;
  readonly probability?: number;
  readonly model?: string;
}

export interface AiExamples {
  readonly good?: readonly string[];
  readonly bad?: readonly string[];
}

export interface AiOptions<T = JsonValue> {
  readonly rule: string;
  readonly examples?: AiExamples;
  readonly violationMessage?: string;
  readonly input?: (subject: Subject<T>, context: ProjectContext) => Awaitable<JsonValue>;
}

export type Evaluator<T = JsonValue> = (
  subject: Subject<T>,
  context: CheckContext<T>,
) => Awaitable<CheckResult>;

export interface ProjectContext {
  readonly project: Project;
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

export const RULE_BRAND: symbol = Symbol.for('rulekeeper.Rule');

export abstract class Rule<T = JsonValue> {
  enabled: boolean = true;
  files: readonly string[] = ['**/*'];
  exclude: readonly string[] = [];
  scope?: ScopeSelector<T>;
  settings: RuleSettings = {};
  group: Grouping = 'scope';

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
