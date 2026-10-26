import {
  Rule,
  pass,
  violation,
  scopes,
  type CheckResult,
  type JsonValue,
  type PredicateResult,
  type ProjectContext,
  type ScopeSubject,
  type Subject,
} from '@alex-dbs/coderuler';

const BUSINESS = /:Business/;

export default class WhenGated extends Rule {
  files = ['internal/infra/**/*.go'];

  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
    },
  });

  async when({ project }: ProjectContext): Promise<PredicateResult> {
    const adapter = await project.stat('internal/adapter');
    return {
      applies: adapter?.kind === 'directory',
      reason: 'infrastructure rules need internal/adapter',
    };
  }

  filter(subject: ScopeSubject<JsonValue>): PredicateResult {
    return BUSINESS.test(subject.id)
      ? { applies: false, reason: 'business functions belong outside infrastructure' }
      : { applies: true };
  }

  check = (subject: Subject<JsonValue>): CheckResult =>
    subject.kind === 'scope' && subject.source.includes('panic(')
      ? violation('infrastructure returns errors instead of panicking')
      : pass();
}
