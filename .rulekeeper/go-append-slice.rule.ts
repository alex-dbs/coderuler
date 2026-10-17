import { Rule, ai, scopes, test } from 'rulekeeper';

export default class GoAppendSlice extends Rule {
  files = ['**/*.go'];

  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        kind: 'for_statement',
        stopBy: 'end',
        has: {
          pattern: 'append($SLICE,$$$ARGS)',
          stopBy: 'end',
        },
      },
    },
  });

  check = ai({
    rule: `A slice freshly allocated for a loop whose final element count is exactly known must be allocated at that final length and filled by index or with copy;
growing it with append is a violation even when capacity was preallocated with make([]T, 0, n)
and even when it was first created with make([]T, n) and then reset to length zero.

Append in a loop is valid only when the final count is not known before the loop,
such as elements appended under a condition so the count varies within an upper bound that capacity merely reserves,
or when the slice already holds a deliberately assigned prefix written before the loop.

Appending after a length that was allocated but never assigned,
or assigning elements by index and also appending them, is a violation.`,
    examples: {
      good: [
        `func copyItems(values []string) []string {
    out := make([]string, len(values))
    for i := range values {
        out[i] = values[i]
    }
    return out
}`,
        `func filterScores(scores []int) []int {
    out := make([]int, 0, len(scores))
    for _, score := range scores {
        if score > 0 {
            out = append(out, score)
        }
    }
    return out
}`,
        `func withHeader(header string, values []string) []string {
    out := make([]string, 1)
    out[0] = header
    for _, value := range values {
        out = append(out, value)
    }
    return out
}`,
      ],
      bad: [
        `func growScores(scores []int) []int {
    out := make([]int, 0, len(scores))
    for _, score := range scores {
        out = append(out, score)
    }
    return out
}`,
        `func addTags(tags []string) []string {
    out := make([]string, len(tags))
    for _, tag := range tags {
        out = append(out, tag)
    }
    return out
}`,
        `func mergeScores(scores []int) []int {
    out := make([]int, len(scores))
    for i, score := range scores {
        out[i] = score
        out = append(out, score)
    }
    return out
}`,
        `func reuseBuffer(values []string) []string {
    out := make([]string, len(values))
    out = out[:0]
    for _, value := range values {
        out = append(out, value)
    }
    return out
}`,
      ],
    },
  });
}

export const tests = [
  test('indexed filling without append selects no scope').withFiles({
    'copy.go': `package example

func copyItems(values []string) []string {
    out := make([]string, len(values))
    for i := range values {
        out[i] = values[i]
    }
    return out
}`,
  }).skips(),
  test('append after a loop selects no scope').withFiles({
    'footer.go': `package example

func withFooter(values []string, footer string) []string {
    out := make([]string, len(values))
    for i := range values {
        out[i] = values[i]
    }
    return append(out, footer)
}`,
  }).skips(),
  test('a method looping without append selects no scope').withFiles({
    'scores.go': `package example

type Scores []int

func (scores Scores) Total() int {
    total := 0
    for _, score := range scores {
        total += score
    }
    return total
}`,
  }).skips(),
  test('append in a loop outside Go files is skipped').withFiles({
    'example.txt': `package example

func copyItems(values []string) []string {
    out := make([]string, 0, len(values))
    for _, value := range values {
        out = append(out, value)
    }
    return out
}`,
  }).skips(),
] as const;
