import { parse, registerDynamicLanguage, type DynamicLangRegistrations } from '@ast-grep/napi';
import { createRequire } from 'node:module';

type NativeLanguage = Parameters<typeof parse>[0];

type LanguageRegistration = DynamicLangRegistrations[string];

const BUILTIN_LANGUAGES: Readonly<Record<string, true>> = {
  css: true,
  html: true,
  javascript: true,
  tsx: true,
  typescript: true,
};

const DYNAMIC_LANGUAGES: Readonly<Record<string, true>> = {
  angular: true,
  bash: true,
  bicep: true,
  c: true,
  cpp: true,
  csharp: true,
  dart: true,
  elixir: true,
  'glimmer-javascript': true,
  'glimmer-typescript': true,
  go: true,
  haskell: true,
  java: true,
  json: true,
  kotlin: true,
  lua: true,
  markdown: true,
  php: true,
  python: true,
  ruby: true,
  rust: true,
  scala: true,
  sql: true,
  swift: true,
  toml: true,
  yaml: true,
};

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  cc: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  ex: 'elixir',
  golang: 'go',
  hs: 'haskell',
  kt: 'kotlin',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
};

const loadCommonJs = createRequire(import.meta.url);

let bundledRegistrationAttempted = false;
let bundledGrammarsActive = false;
let bundledRegistrationError: Error | null = null;

function isParseable(language: NativeLanguage): boolean {
  try {
    parse(language, '');
    return true;
  } catch {
    return false;
  }
}

function canonicalLanguage(language: string): string {
  const folded = language.toLowerCase();
  const alias = Object.hasOwn(LANGUAGE_ALIASES, folded) ? LANGUAGE_ALIASES[folded] : undefined;
  if (alias !== undefined) return alias;
  const known = BUILTIN_LANGUAGES[folded] === true || DYNAMIC_LANGUAGES[folded] === true;
  return known ? folded : language;
}

function registerBundledGrammars(): void {
  if (bundledRegistrationAttempted) return;
  bundledRegistrationAttempted = true;
  try {
    registerDynamicLanguage(createAstGrepLanguageRegistrations());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`ast-grep could not register its bundled grammars: ${message}`, { cause });
    bundledRegistrationError = error;
    throw error;
  }
}

export function createAstGrepLanguageRegistrations(): DynamicLangRegistrations {
  const registrations: DynamicLangRegistrations = {};
  for (const language of Object.keys(DYNAMIC_LANGUAGES)) {
    registrations[language] = loadCommonJs(`@ast-grep/lang-${language}`) as LanguageRegistration;
  }
  return registrations;
}

export function resolveAstGrepLanguage(language: string): NativeLanguage {
  const canonical = canonicalLanguage(language);
  if (BUILTIN_LANGUAGES[canonical] === true) return canonical;
  if (DYNAMIC_LANGUAGES[canonical] !== true) return canonical;
  if (bundledGrammarsActive) return canonical;
  if (isParseable(canonical)) return canonical;
  registerBundledGrammars();
  if (isParseable(canonical)) {
    bundledGrammarsActive = true;
    return canonical;
  }
  if (bundledRegistrationError !== null) throw bundledRegistrationError;
  throw new Error(
    `ast-grep language '${canonical}' is not registered: registerDynamicLanguage had already been called ` +
      `earlier in this process (by the host or another library), and ast-grep honours only the first such ` +
      `call, so the bundled grammars could not be added. Call registerDynamicLanguage exactly once yourself, ` +
      `merging createAstGrepLanguageRegistrations() with your own grammars, and include '${canonical}'.`,
  );
}
