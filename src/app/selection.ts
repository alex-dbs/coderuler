import type { ScopeMatch, SourceFile } from './rule.js';

function lineCount(source: string): number {
  let count = 1;
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 10) {
      count += 1;
    } else if (code === 13) {
      count += 1;
      if (source.charCodeAt(index + 1) === 10) index += 1;
    }
    index += 1;
  }
  const last = source.charCodeAt(source.length - 1);
  if (source.length > 0 && (last === 10 || last === 13)) count -= 1;
  return count;
}

export function wholeFileScope(file: SourceFile): readonly ScopeMatch<never>[] {
  return [{ id: '$', source: file.source, lines: { start: 1, end: lineCount(file.source) } }];
}
