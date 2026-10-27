import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

export default class GoDereferenceGuard extends Rule {
  files = ['**/*.go'];

  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        kind: 'unary_expression',
        stopBy: 'end',
        has: {
          field: 'operator',
          regex: '^\\*$',
        },
      },
    },
  });

  check = ai({
    instruction: `Check each Go pointer for nil before dereferencing it. For nested fields, check every pointer in the field path.`,
    examples: {
      good: [
        `func configName(config *Config) string {
    if config != nil {
        return (*config).Name
    }
    return ""
}`,
        `func (config *Config) name() string {
    if config == nil {
        return ""
    }
    return (*config).Name
}`,
        `func nestedValue(config *Config) int {
    if config == nil || config.Child == nil || config.Child.Value == nil {
        return 0
    }
    return *config.Child.Value
}`,
      ],
      bad: [
        `func configName(config *Config) string {
    return (*config).Name
}`,
        `func configName(config *Config) string {
    if config == nil {
        logMissingConfig()
    }
    return (*config).Name
}`,
        `type Config struct { Child *Child }
type Child struct { Value *int }

func nestedValue(config *Config) int {
    if config == nil {
        return 0
    }
    return *config.Child.Value
}`,
      ],
    },
    input: async (subject, { project }) => {
      const scope = subject as ScopeSubject;
      return {
        function: scope.source,
        file: await project.readText(scope.filepath),
      };
    },
    violationMessage: 'Check each pointer for nil before using *.',
  });
}


export const aiTests = [
  test('a non-nil branch guards the matching pointer dereference').withFiles({
    'config.go': `package example

type Config struct { Name string }

func configName(config *Config) string {
    if config != nil {
        return (*config).Name
    }
    return ""
}`,
  }).passes(),
  test('a nil early return guards the later dereference').withFiles({
    'config.go': `package example

type Config struct { Name string }

type Reader struct{}

func (reader *Reader) configName(config *Config) string {
    if config == nil {
        return ""
    }
    return (*config).Name
}`,
  }).passes(),
  test('nested pointer fields each have nil checks').withFiles({
    'config.go': `package example

type Config struct { Child *Child }
type Child struct { Value *int }

func nestedValue(config *Config) int {
    if config == nil || config.Child == nil || config.Child.Value == nil {
        return 0
    }
    return *config.Child.Value
}`,
  }).passes(),
  test('an unguarded pointer dereference is reported').withFiles({
    'config.go': `package example

type Config struct { Name string }

func configName(config *Config) string {
    return (*config).Name
}`,
  }).violates(),
  test('a nil check for another pointer does not guard this dereference').withFiles({
    'config.go': `package example

type Config struct { Name string }

func configName(config, fallback *Config) string {
    if fallback == nil {
        return "missing fallback"
    }
    return (*config).Name
}`,
  }).violates(),
  test('a root nil check does not guard a nested pointer field').withFiles({
    'config.go': `package example

type Config struct { Child *Child }
type Child struct { Value *int }

func nestedValue(config *Config) int {
    if config == nil {
        return 0
    }
    return *config.Child.Value
}`,
  }).violates(),
  test('a nil branch that continues still permits a nil dereference').withFiles({
    'config.go': `package example

type Config struct { Name string }

func configName(config *Config) string {
    if config == nil {
        logMissingConfig()
    }
    return (*config).Name
}

func logMissingConfig() {}`,
  }).violates(),
] as const;
