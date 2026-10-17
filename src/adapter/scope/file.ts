import type { ScopeSelector } from '../../app/rule.js';
import { wholeFileScope } from '../../app/selection.js';

export function file(): ScopeSelector<never> {
  return wholeFileScope;
}
