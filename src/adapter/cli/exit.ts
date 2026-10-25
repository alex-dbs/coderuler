export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_FAILURE = 2;

export class CliExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`rulekeeper exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}
