import { Rule, scopes, test, violation, type ProjectContext, type ScopeSubject } from '@alex-dbs/rulekeeper';
import { goVersionAtLeast } from './go-version.ts';

export default class GoIoutil extends Rule {
  files = ['**/*.go'];

  scope = scopes.astGrep({
    language: 'go',
    rule: {
      kind: 'import_spec',
      has: { field: 'path', regex: '^(?:"io/ioutil"|`io/ioutil`)$' },
    },
  });

  filter(subject: ScopeSubject, context: ProjectContext): Promise<boolean> {
    return goVersionAtLeast(subject.filepath, context, 1, 16);
  }

  check = () => violation('io/ioutil is deprecated since Go 1.16. Migrate to io or os; review callers because os.ReadDir returns []os.DirEntry rather than []os.FileInfo.');
}

export const tests = [
  test('Go 1.16 flags the deprecated import').withFiles({
    'go.mod': 'module example\n\ngo 1.16\n',
    'main.go': 'package example\nimport "io/ioutil"\n',
  }).violates(),
  test('a newer major version supports the replacement').withFiles({
    'go.mod': 'module example\ngo 2.0\n',
    'main.go': 'package example\nimport "io/ioutil"\n',
  }).violates(),
  test('an aliased raw import is flagged').withFiles({
    'go.mod': 'module example\ngo 1.16\n',
    'main.go': 'package example\nimport legacy `io/ioutil`\n',
  }).violates(),
  test('a grouped dot import is flagged').withFiles({
    'go.mod': 'module example\ngo 1.16\n',
    'main.go': 'package example\nimport (\n "fmt"\n . "io/ioutil"\n)\n',
  }).violates(),
  test('a nested source file finds its ancestor module').withFiles({
    'go.mod': 'module example\ngo 1.16.0 // minimum version\n',
    'internal/worker/main.go': 'package worker\nimport "io/ioutil"\n',
  }).violates(),
  test('a modern nested module overrides an older root module').withFiles({
    'go.mod': 'module example\ngo 1.15\n',
    'nested/go.mod': 'module nested\ngo 1.16\n',
    'nested/internal/main.go': 'package internal\nimport "io/ioutil"\n',
  }).violates(),
] as const;
