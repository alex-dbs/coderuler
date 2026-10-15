export type DiagnosticFields = Readonly<Record<string, string | number | boolean | undefined>>;

type DiagnosticWriter = (event: string, fields?: DiagnosticFields) => void;

export interface Diagnostics {
  readonly important: DiagnosticWriter;
  readonly verbose?: DiagnosticWriter;
}
