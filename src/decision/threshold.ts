export const DEFAULT_THRESHOLD = 0.4;

const MESSAGE = 'must be a number between 0 and 1';

const DECIMAL = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;

export function validateThreshold(value: number, label = '--threshold'): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} ${MESSAGE}, got ${String(value)}`);
  }
  return value;
}

export function parseThreshold(value: string, label = '--threshold'): number {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) throw new RangeError(`${label} ${MESSAGE}, got ${JSON.stringify(value)}`);
  return validateThreshold(Number(trimmed), label);
}
