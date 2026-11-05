import { Rule, pass, test, violation, type ProjectContext, type Subject } from '@alex-dbs/coderuler';

const widget = `# A reusable widget.
class Widget
  def self.build
    new
  end
end
`;
const usage = `require_relative "widget"
require "support_widget"

Widget.build
SupportWidget.new
`;

export default class RubyDefinition extends Rule {
  files = ['lib/usage.rb'];

  check = async (subject: Subject, context: ProjectContext) => {
    if (subject.kind === 'group') return pass();

    const definitions = await context.rubyLsp.definitions({
      filepath: subject.filepath,
      line: 4,
      column: 1,
    });
    return definitions.some(definition => definition.uri.endsWith('/lib/widget.rb'))
      ? pass()
      : violation('Widget must resolve to lib/widget.rb');
  };
}

export const tests = [
  test('Widget resolves to its definition').withFiles({
    'lib/widget.rb': widget,
    'lib/usage.rb': usage,
  }).passes(),
  test('an unknown widget does not resolve').withFiles({
    'lib/widget.rb': widget,
    'lib/usage.rb': usage.replace('Widget.build', 'UnknownWidget.build'),
  }).violates(),
] as const;
