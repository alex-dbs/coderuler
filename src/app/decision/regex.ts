import type { ScopeMatch } from '../scope/types.ts';
import type { DecisionContext } from './group.ts';
import type { Decision } from './service.ts';

export const REGEX_MODEL = 'regex';

export interface RegexTarget {
  readonly filepath: string;
  readonly scopeId: string;
  readonly value: string;
  readonly matched: boolean;
}

export interface RegexVerdict {
  readonly matched: boolean;
  readonly targets: readonly RegexTarget[];
  readonly decision: Decision;
}

export function regexValue(scope: ScopeMatch): string {
  const { data, source } = scope;
  if (data === undefined || (typeof data === 'object' && data !== null)) return source;
  return String(data);
}

export class RegexEvaluator {
  readonly #pattern: RegExp;

  constructor(source: string) {
    this.#pattern = new RegExp(source);
  }

  evaluate(context: DecisionContext): RegexVerdict {
    const members = 'group' in context
      ? context.files.flatMap(file => file.scopes.map(scope => ({ filepath: file.filepath, scope })))
      : [{ filepath: context.filepath, scope: context.scope }];
    const targets = members.map(({ filepath, scope }) => {
      const value = regexValue(scope);
      return { filepath, scopeId: scope.id, value, matched: this.#pattern.test(value) };
    });
    const matched = targets.every(target => target.matched);
    return {
      matched,
      targets,
      decision: { follows: matched, probability: matched ? 1 : 0, model: REGEX_MODEL },
    };
  }
}
