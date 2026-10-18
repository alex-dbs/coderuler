import { Rule, pass } from '@alex-dbs/rulekeeper';

export default class EngineBaseline extends Rule {
  files = ['tests/manual/*.yml'];

  check = () => pass();
}
