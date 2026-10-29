import { Rule, scopes, test, violation, type ProjectContext, type ScopeSubject } from '@alex-dbs/coderuler';
import { goVersionAtLeast } from './go-version.ts';

export default class GoExpPromoted extends Rule {
  enabled = false;
  files = ['**/*.go'];

  scope = scopes.astGrep({
    language: 'go',
    rule: {
      kind: 'import_spec',
      has: {
        field: 'path',
        regex: '^(?:"golang\\.org/x/exp/(?:slices|maps)"|`golang\\.org/x/exp/(?:slices|maps)`)$',
      },
    },
  });

  filter(subject: ScopeSubject, context: ProjectContext): Promise<boolean> {
    return goVersionAtLeast(subject.filepath, context, 1, 21);
  }

  check = () => violation('Consider migrating experimental slices/maps imports to the standard packages available since Go 1.21. Review usage and the module Go version: APIs are not interchangeable, some helpers have no equivalent, and maps.Keys/Values use iterators starting in Go 1.23.');
}

export const tests = [
  test('Go 1.21 flags experimental slices').withFiles({
    'go.mod': 'module example\ngo 1.21\n',
    'main.go': 'package example\nimport "golang.org/x/exp/slices"\n',
  }).violates(),
  test('Go 1.21 flags experimental maps').withFiles({
    'go.mod': 'module example\ngo 1.21\n',
    'main.go': 'package example\nimport "golang.org/x/exp/maps"\n',
  }).violates(),
  test('an aliased raw slices import is flagged').withFiles({
    'go.mod': 'module example\ngo 1.21\n',
    'main.go': 'package example\nimport legacy `golang.org/x/exp/slices`\n',
  }).violates(),
  test('a grouped dot raw maps import is flagged').withFiles({
    'go.mod': 'module example\ngo 1.21\n',
    'main.go': 'package example\nimport (\n "fmt"\n . `golang.org/x/exp/maps`\n)\n',
  }).violates(),
  test('a nested source file finds a patch-version ancestor module').withFiles({
    'go.mod': 'module example\ngo 1.21.0 // minimum version\n',
    'internal/worker/main.go': 'package worker\nimport "golang.org/x/exp/maps"\n',
  }).violates(),
  test('a modern nested module overrides an older root module').withFiles({
    'go.mod': 'module example\ngo 1.20\n',
    'nested/go.mod': 'module nested\ngo 1.21\n',
    'nested/internal/main.go': 'package internal\nimport "golang.org/x/exp/maps"\n',
  }).violates(),
] as const;
