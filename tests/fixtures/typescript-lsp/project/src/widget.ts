export interface Builder {
  build(): string;
}

export class Widget implements Builder {
  build(): string {
    return leaf();
  }
}

export function leaf(): string {
  return 'widget';
}

export function label(): string {
  return 'view';
}
