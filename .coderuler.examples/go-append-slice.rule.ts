import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';

export default class GoAppendSlice extends Rule {
  enabled = false;
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
    instruction: `For a fresh slice allocated for a loop with a known output count, allocate its final length and fill it by index or copy.
Keep append when the final count is unknown before the loop or when the slice has a deliberately assigned prefix.
Do not allocate elements that the loop then appends instead of filling them.`,
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

export const aiTests = [
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
