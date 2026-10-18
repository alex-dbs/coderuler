export interface ViolationComment {
  readonly body: string;
  readonly locations: readonly {
    readonly filepath: string;
    readonly lines: {
      readonly start: number;
      readonly end: number;
    };
  }[];
}
