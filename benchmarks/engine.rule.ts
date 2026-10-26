import { Rule, pass } from '@alex-dbs/coderuler';

export default class EngineBaseline extends Rule {
  files = ['tests/manual/*.yml'];

  check = () => pass();
}
