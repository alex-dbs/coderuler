import { parse } from 'yaml';

export function decodeRule(source: string): unknown {
  if (typeof source !== 'string') throw new Error('Rule source must be a string');
  try {
    return parse(source, { uniqueKeys: true });
  } catch (error) {
    throw new Error(`Rule YAML could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
