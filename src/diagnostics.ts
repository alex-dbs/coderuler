import { stripVTControlCharacters } from 'node:util';

export interface DiagnosticOptions {
  readonly debug?: boolean;
  readonly verbose?: boolean;
}

export type DiagnosticFields = Readonly<Record<string, string | number | boolean | undefined>>;

type DiagnosticWriter = (event: string, fields?: DiagnosticFields) => void;

export interface Diagnostics {
  readonly important: DiagnosticWriter;
  readonly verbose?: DiagnosticWriter;
}

function safeText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function writer(level: 'debug' | 'verbose'): DiagnosticWriter {
  return (event, fields) => {
    let line = `[${level}] ${safeText(event)}`;
    if (fields !== undefined) {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const safeValue = typeof value === 'string' ? safeText(value) : value;
        line += ` ${safeText(key)}=${JSON.stringify(safeValue)}`;
      }
    }
    process.stderr.write(`${line}\n`);
  };
}

export function createDiagnostics(options: DiagnosticOptions): Diagnostics | undefined {
  if (options.debug !== true && options.verbose !== true) return undefined;
  return {
    important: writer('debug'),
    ...(options.verbose === true ? { verbose: writer('verbose') } : {}),
  };
}
