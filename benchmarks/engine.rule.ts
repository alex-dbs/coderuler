import { Rule, pass } from 'rulekeeper';

export default class EngineBaseline extends Rule {
  files = ['tests/manual/*.yml'];

  check = () => pass();
}
