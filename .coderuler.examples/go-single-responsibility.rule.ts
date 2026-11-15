import {
  Rule,
  ai,
  isDiffMode,
  scopes,
  type ProjectContext,
  type ScopeMatch,
  type ScopeSubject,
  type SelectionContext,
  type SourceFile,
} from '@alex-dbs/coderuler';

const goMethodSignatures = scopes.astGrep({
  language: 'go',
  rule: {
    any: [
      { pattern: 'func ($RECEIVER) $NAME($$$PARAMS) $RESULT { $$$BODY }' },
      { pattern: 'func ($RECEIVER) $NAME($$$PARAMS) { $$$BODY }' },
    ],
  },
});

const goStructs = scopes.astGrep({
  language: 'go',
  rule: { kind: 'type_spec', has: { kind: 'struct_type' } },
});

const goPackageClauses = scopes.astGrep({
  language: 'go',
  rule: { kind: 'package_clause' },
});

function captureText(capture: string | readonly string[] | undefined): string {
  return typeof capture === 'string' ? capture : capture?.filter(part => part !== ',').join(', ') ?? '';
}

function methodSignature(method: ScopeMatch): string {
  const captures = method.captures!;
  const result = captureText(captures.RESULT);
  return `func (${captureText(captures.RECEIVER)}) ${captureText(captures.NAME)}(${captureText(captures.PARAMS)})${result === '' ? '' : ` ${result}`}`;
}

function methodReceiverType(method: ScopeMatch): string | undefined {
  const prefix = 'method_declaration:';
  if (!method.id.startsWith(prefix)) return undefined;
  const separator = method.id.indexOf('.', prefix.length);
  return separator === -1 ? undefined : method.id.slice(prefix.length, separator);
}

function goPackageName(file: SourceFile): string | undefined {
  return goPackageClauses(file)[0]?.source.match(/^package\s+([^\s]+)/)?.[1];
}

function packageNameFromData(data: ScopeMatch['data']): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const packageName = data['packageName'];
  return typeof packageName === 'string' ? packageName : undefined;
}

function goDirectory(filepath: string): string {
  const separator = filepath.lastIndexOf('/');
  return separator === -1 ? '.' : filepath.slice(0, separator);
}

export default class GoSingleResponsibility extends Rule {
  files = ['**/*.go'];
  exclude = ['**/*_test.go'];
  scope = goStructs;

  async select(context: SelectionContext): Promise<readonly ScopeSubject[]> {
    if (!isDiffMode(context)) return super.select(context);

    const packageStructs = new Map<string, Promise<ReadonlyMap<string, ScopeMatch>>>();
    const affectedStructScopes = async (
      file: SourceFile,
      selectionContext?: ProjectContext,
    ): Promise<readonly ScopeMatch[]> => {
      const ranges = selectionContext?.changedLines?.get(file.filepath);
      if (selectionContext === undefined || ranges === undefined || ranges.length === 0) return [];

      const affectedMethods = goMethodSignatures(file).filter(method => {
        const lines = method.lines;
        return lines !== undefined && ranges.some(range =>
          range.start <= lines.end && lines.start <= range.end);
      });
      if (affectedMethods.length === 0) return [];

      const packageName = goPackageName(file);
      if (packageName === undefined) return [];
      const directory = goDirectory(file.filepath);
      const key = `${directory}\0${packageName}`;
      let structs = packageStructs.get(key);
      if (structs === undefined) {
        const project = selectionContext.project;
        structs = (async () => {
          const pattern = directory === '.' ? '*.go' : `${directory}/*.go`;
          const files = (await project.glob(pattern))
            .filter(filepath => !filepath.endsWith('_test.go'));
          const sources = await Promise.all(files.map(async filepath => ({
            filepath,
            source: filepath === file.filepath ? file.source : await project.readText(filepath),
          })));
          const found = new Map<string, ScopeMatch>();
          for (const source of sources) {
            if (goPackageName(source) !== packageName) continue;
            for (const structure of goStructs(source)) {
              if (!structure.id.startsWith('type_spec:')) continue;
              found.set(structure.id.slice('type_spec:'.length), structure);
            }
          }
          return found;
        })();
        packageStructs.set(key, structs);
      }

      const structsByName = await structs;
      const matches = new Map<string, ScopeMatch>();
      for (const method of affectedMethods) {
        const typeName = methodReceiverType(method);
        const structure = typeName === undefined ? undefined : structsByName.get(typeName);
        const lines = method.lines;
        if (typeName === undefined || structure === undefined || lines === undefined || matches.has(typeName)) continue;
        matches.set(typeName, {
          ...structure,
          data: { packageName },
          lines,
        });
      }
      return [...matches.values()];
    };

    const selected = await context.select({
      files: this.files,
      exclude: this.exclude,
      scope: affectedStructScopes,
    });
    const unique = new Map<string, ScopeSubject>();
    for (const subject of selected) {
      const key = `${goDirectory(subject.filepath)}\0${packageNameFromData(subject.data) ?? ''}\0${subject.id}`;
      if (!unique.has(key)) unique.set(key, subject);
    }
    return [...unique.values()];
  }

  check = ai({
    instruction: 'Single Responsibility Principle: A class shouldnt try to do everything. Instead, it should serve a single stakeholder or "actor" whose requirements drive changes to that specific feature.',
    input: async (subject, { project }) => {
      const scope = subject as ScopeSubject;
      const typeName = scope.id.slice('type_spec:'.length);
      const packageName = packageNameFromData(scope.data);
      const directory = goDirectory(scope.filepath);
      const files = await project.glob(directory === '.' ? '*.go' : `${directory}/*.go`);
      const methodsByFile = await Promise.all(
        files
          .filter(filepath => !filepath.endsWith('_test.go'))
          .map(async filepath => {
            const source = await project.readText(filepath);
            const sourcePackageName = packageName === undefined ? undefined : goPackageName({ filepath, source });
            if (packageName !== undefined && sourcePackageName !== packageName) return [];
            return goMethodSignatures({ filepath, source })
              .filter(method => methodReceiverType(method) === typeName)
              .map(methodSignature);
          }),
      );
      return { struct: `type ${scope.source}`, methods: methodsByFile.flat() };
    },
    violationMessage: 'The struct has more than 1 single responsability, it should be split.',
    examples: {
      good: [
        `type UserService struct { users UserStore }
func (s UserService) GetUser(id string) (User, error)
func (s UserService) CreateUser(name string) (User, error)
func (s UserService) DeleteUser(id string) error`,
      ],
      bad: [
        `type TOTO struct { users UserStore; mailer EmailSender }
func (t TOTO) GetUser(id string) (User, error)
func (t TOTO) SendEmail(to, subject, body string) error`,
      ],
    },
  });
}
