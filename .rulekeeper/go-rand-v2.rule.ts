import { Rule, scopes, test, violation, type ProjectContext, type ScopeSubject } from 'rulekeeper';
import { goVersionAtLeast } from './go-version.ts';

export default class GoRandV2 extends Rule {
  files = ['**/*.go'];

  scope = scopes.astGrep({
    language: 'go',
    rule: {
      kind: 'import_spec',
      has: { field: 'path', regex: '^(?:"math/rand"|`math/rand`)$' },
    },
  });

  filter(subject: ScopeSubject, context: ProjectContext): Promise<boolean> {
    return goVersionAtLeast(subject.filepath, context, 1, 22);
  }

  check = () => violation('Consider math/rand/v2, available since Go 1.22. Review API changes and stable-sequence compatibility before migrating: seeded output is not interchangeable with math/rand. Neither package is cryptographically secure.');
}

export const tests = [
  test('Go 1.22 flags the legacy random import').withFiles({
    'go.mod': 'module example\ngo 1.22\n',
    'main.go': 'package example\nimport "math/rand"\n',
  }).violates(),
  test('an aliased raw import is flagged').withFiles({
    'go.mod': 'module example\ngo 1.22\n',
    'main.go': 'package example\nimport random `math/rand`\n',
  }).violates(),
  test('a grouped dot import is flagged').withFiles({
    'go.mod': 'module example\ngo 1.22\n',
    'main.go': 'package example\nimport (\n "fmt"\n . "math/rand"\n)\n',
  }).violates(),
  test('a nested source file finds a patch-version ancestor module').withFiles({
    'go.mod': 'module example\ngo 1.22.0 // minimum version\n',
    'internal/worker/main.go': 'package worker\nimport "math/rand"\n',
  }).violates(),
  test('a modern nested module overrides an older root module').withFiles({
    'go.mod': 'module example\ngo 1.21\n',
    'nested/go.mod': 'module nested\ngo 1.22\n',
    'nested/internal/main.go': 'package internal\nimport "math/rand"\n',
  }).violates(),
] as const;
