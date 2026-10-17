export interface LineSpan {
  readonly start: number;
  readonly end: number;
}

const TRAILING_LINE_BREAKS = /(?:\r\n|\r|\n)$/;
const LINE_BREAKS = /\r\n|[\r\n]/g;

export function textLineSpan(startLine: number, text: string): LineSpan {
  const breaks = text.replace(TRAILING_LINE_BREAKS, '').match(LINE_BREAKS);
  return { start: startLine, end: startLine + (breaks === null ? 0 : breaks.length) };
}

export class SourceLines {
  readonly #starts: readonly number[];

  constructor(source: string) {
    const starts = [0];
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (code === 10) starts.push(index + 1);
      else if (code === 13) {
        if (source.charCodeAt(index + 1) === 10) index += 1;
        starts.push(index + 1);
      }
    }
    this.#starts = starts;
  }

  span(start: number, end: number): LineSpan {
    const first = this.#lineAt(start);
    if (end <= start) return { start: first, end: first };
    return { start: first, end: this.#lineAt(end - 1) };
  }

  #lineAt(offset: number): number {
    const starts = this.#starts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }
}
