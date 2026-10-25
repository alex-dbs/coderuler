const REDACTED = '[REDACTED]';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export type TextWriter = (text: string) => void;
export type TextRedactor = (text: string) => string;

export function escapeText(text: string): string {
  return text.replace(
    CONTROL_CHARACTERS,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function createRedactor(values: readonly (string | undefined)[]): TextRedactor {
  const needles = new Set<string>();
  for (const value of values) {
    if (value === undefined || value.trim() === '') continue;
    for (const candidate of [value, value.trim()]) {
      needles.add(candidate);
      needles.add(escapeText(candidate));
      needles.add(JSON.stringify(candidate).slice(1, -1));
    }
  }
  const replacements = [...needles]
    .filter(needle => needle !== '')
    .sort((left, right) => right.length - left.length)
    .map(needle => [needle, needle.replace(/[^\r\n]+/g, REDACTED)] as const);
  if (replacements.length === 0) return text => text;
  return text => {
    let redacted = text;
    for (const [needle, replacement] of replacements) {
      redacted = redacted.replaceAll(needle, replacement);
    }
    return redacted;
  };
}

export function escapeDiagnostic(text: string): string {
  return text
    .split('\n')
    .map(segment => escapeText(segment))
    .join('\n');
}
