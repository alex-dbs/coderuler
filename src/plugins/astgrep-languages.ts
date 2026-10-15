/**
 * The ast-grep language catalog: every grammar a rule may name, and how each name becomes a parser.
 *
 * `@ast-grep/napi` bundles five grammars (JavaScript, TypeScript, TSX, CSS, HTML) that `parse`
 * accepts with no setup, and those never load a dynamic library. The other 26 catalog languages
 * ship as `@ast-grep/lang-*` packages whose default export already is the registration record the
 * native API wants, so no library path, extension list or language symbol is restated here.
 *
 * `registerDynamicLanguage` accepts one call per process and silently ignores a second, so the
 * bundled grammars are handed over together — all 26 at once, the first time a rule actually names
 * one — because a partial registration could never be completed later. Builtin-only matching never
 * loads a grammar package at all. A host that needs grammars of its own must merge them into that
 * same single call:
 *
 *     registerDynamicLanguage({ ...createAstGrepLanguageRegistrations(), mojo: mojoRegistration });
 *
 * A rule's `language` folds case-insensitively onto its canonical catalog spelling, accepts the
 * conventional aliases (`py`, `golang`, `c++`, `md`, ...), and is otherwise passed to the native
 * parser exactly as written, so a name a host registered itself keeps working. `resolveAstGrepLanguage`
 * reports which single call to make when the requested language still cannot be parsed afterwards,
 * instead of leaving the native missing-parser failure to explain it.
 */
import { parse, registerDynamicLanguage, type DynamicLangRegistrations } from '@ast-grep/napi';
import { createRequire } from 'node:module';

/** The language argument accepted by the native parser (a built-in name or a registered name). */
type NativeLanguage = Parameters<typeof parse>[0];

/** One grammar package's registration record, in the shape the native API consumes. */
type LanguageRegistration = DynamicLangRegistrations[string];

/**
 * The languages `@ast-grep/napi` already bundles: `parse` takes these names with no registration, so
 * they are never given a dynamic library.
 */
const BUILTIN_LANGUAGES: Readonly<Record<string, true>> = {
  css: true,
  html: true,
  javascript: true,
  tsx: true,
  typescript: true,
};

/**
 * Every language that ships as its own `@ast-grep/lang-<name>` package, in registration order. The
 * package name, the registration key and the name `parse` accepts are all this canonical spelling,
 * so the keys below are the whole catalog of dynamically loaded grammars.
 */
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

/**
 * Conventional short spellings a rule may use instead of the canonical name, folded to lowercase
 * before lookup. They match the aliases editors and the ast-grep CLI already use.
 */
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

/** Whether the bundled grammars have already been handed to the one-shot native call. */
let bundledRegistrationAttempted = false;
/** Whether that call took effect, so every dynamic catalog name is known to resolve. */
let bundledGrammarsActive = false;
/** Why that call failed, when it did, so a later request reports the real cause. */
let bundledRegistrationError: Error | null = null;

/** True when the native parser can already parse the language, i.e. its grammar is registered. */
function isParseable(language: NativeLanguage): boolean {
  try {
    parse(language, '');
    return true;
  } catch {
    return false;
  }
}

/** Fold a requested spelling onto its canonical catalog name; unknown names stay verbatim. */
function canonicalLanguage(language: string): string {
  const folded = language.toLowerCase();
  // Own keys only: a name such as `toString` must not pick up an inherited object property here.
  const alias = Object.hasOwn(LANGUAGE_ALIASES, folded) ? LANGUAGE_ALIASES[folded] : undefined;
  if (alias !== undefined) return alias;
  const known = BUILTIN_LANGUAGES[folded] === true || DYNAMIC_LANGUAGES[folded] === true;
  return known ? folded : language;
}

/** Register every bundled grammar in the single native call the process allows, on first need. */
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

/**
 * The registration records for the whole catalog, for a host that registers grammars of its own:
 * spread this into that one `registerDynamicLanguage` call. Loading a package stays lazy — its
 * `libraryPath` is a getter the native call resolves — and a package that is absent fails loudly
 * here rather than becoming a language that silently never matches.
 */
export function createAstGrepLanguageRegistrations(): DynamicLangRegistrations {
  const registrations: DynamicLangRegistrations = {};
  for (const language of Object.keys(DYNAMIC_LANGUAGES)) {
    // The package export is the registration record the native API wants: `@ast-grep/lang-<name>`
    // loads lazily (its `libraryPath` is a getter the native call resolves) and restates nothing.
    registrations[language] = loadCommonJs(`@ast-grep/lang-${language}`) as LanguageRegistration;
  }
  return registrations;
}

/**
 * Resolve a rule's `language` to the name the native parser takes: the canonical catalog spelling
 * for a known name — registering the bundled grammars the first time one is needed — and the
 * spelling as written for anything else, which is a language the host registered itself. The native
 * query is compiled and validated right after this, so a successful resolve is probed at most once.
 */
export function resolveAstGrepLanguage(language: string): NativeLanguage {
  const canonical = canonicalLanguage(language);
  if (BUILTIN_LANGUAGES[canonical] === true) return canonical;
  if (DYNAMIC_LANGUAGES[canonical] !== true) return canonical;
  // Every dynamic catalog name resolves once the bundled grammars are in place.
  if (bundledGrammarsActive) return canonical;
  // A host may have registered this grammar itself; then the one native call is already spent.
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
