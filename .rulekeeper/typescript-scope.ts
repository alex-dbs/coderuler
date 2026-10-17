import { scopes, type ScopeSelector } from 'rulekeeper';

type Options = Omit<Parameters<typeof scopes.astGrep>[0], 'language'>;

export function typescriptScope(options: Options, tsxOptions: Options = options): ScopeSelector {
  const ts = scopes.astGrep({ ...options, language: 'typescript' });
  const tsx = scopes.astGrep({ ...tsxOptions, language: 'tsx' });
  return file => (file.filepath.endsWith('.tsx') ? tsx : ts)(file);
}
