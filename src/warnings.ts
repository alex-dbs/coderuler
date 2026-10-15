import { stripVTControlCharacters, styleText } from 'node:util';

export function warnUnknownField(path: string): void {
  const safePath = stripVTControlCharacters(path).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const message = `WARN Unknown field: ${safePath} (ignored)`;
  process.stderr.write(`${styleText('yellow', message, { stream: process.stderr })}\n`);
}
