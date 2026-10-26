import { Rule, ai, scopes, type ProjectContext } from '@alex-dbs/coderuler';

export default class InfraPlacement extends Rule {
  files = ['internal/infra/**/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }] },
  });

  async when({ project }: ProjectContext) {
    return (await project.stat('internal/adapter'))?.kind === 'directory';
  }

  check = ai({
    rule: 'Infrastructure functions implement technical concerns, not business policy or application orchestration.',
    violationMessage: 'This function belongs outside infrastructure',
  });
}
