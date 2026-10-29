import { ai, Rule, scopes, test, type Subject } from '@alex-dbs/coderuler';

// Policy references: https://cwe.mitre.org/data/definitions/476.html
// https://staticcheck.dev/docs/checks/#SA5011
// Coverage is limited to nil risks demonstrable in the selected function/method source; this is not complete CWE-476 coverage.
export default class GoCwe476 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/476/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        any: [
          {
            kind: 'unary_expression',
            has: { field: 'operator', regex: '^\\*$' },
          },
          { kind: 'selector_expression' },
          { kind: 'index_expression' },
          { kind: 'slice_expression' },
        ],
        stopBy: 'end',
      },
    },
  });

  check = ai({
    instruction: 'Within the supplied Go function or method source, flag a possibly nil pointer that is dereferenced, indexed or sliced through a pointer-to-array, or used for a method call that requires a non-nil receiver, unless available control flow or a nil-safe implementation makes the use safe. A nil interface cannot invoke a method or evaluate its method value, so prove the interface is non-nil before either operation. A non-nil interface may still hold a typed-nil pointer; an interface nil check excludes only the nil-interface case. Assess typed-nil receiver risk from a visible concrete pointer-receiver method: flag receiver dereferences unless that method handles nil first. Do not infer that an unavailable method implementation is either nil-safe or unsafe, and do not flag a nil receiver when its supplied implementation handles nil safely or never dereferences it. Judge only risks and safety shown in the supplied function/method source; do not infer external helper guarantees or synchronization.',
    violationMessage: 'Prove the pointer or interface is safe before dereferencing, indexing, slicing, invoking a method, or evaluating its method value.',
    examples: {
      good: [
        `func value(p *int) int {
    if p == nil {
        return 0
    }
    return *p
}`,
        `func body(client *http.Client, req *http.Request) (io.ReadCloser, error) {
    if client == nil || req == nil {
        return nil, errors.New("missing input")
    }
    response, err := client.Do(req)
    if err != nil {
        return nil, err
    }
    if response == nil {
        return nil, errors.New("missing response")
    }
    return response.Body, nil
}`,
        `type Reader interface { Read() int }
type counter struct { value int }
func (c *counter) Read() int {
    if c == nil {
        return 0
    }
    return c.value
}
func read() int {
    var concrete *counter
    var reader Reader = concrete
    if reader == nil {
        return 0
    }
    return reader.Read()
}`,
        `func tail(values *[4]int) []int {
    if values == nil {
        return nil
    }
    return values[1:]
}`,
      ],
      bad: [
        `func value(p *int) int {
    if p == nil {
        log.Println("missing value")
    }
    return *p
}`,
        `func body(client *http.Client, req *http.Request) error {
    response, err := client.Do(req)
    defer response.Body.Close()
    if err != nil {
        return err
    }
    return nil
}`,
        `type Reader interface { Read() int }
type counter struct { value int }
func (c *counter) Read() int { return c.value }
func read() int {
    var concrete *counter
    var reader Reader = concrete
    if reader == nil {
        return 0
    }
    return reader.Read()
}`,
        `func tail(values *[4]int) []int {
    return values[1:]
}`,
      ],
    },
    input: (subject: Subject) => subject.kind === 'scope' ? subject.source : subject.members.map(member => member.source).join('\n'),
  });
}

export const aiTests = [
  test('a nil guard exits before pointer dereference').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/value.go': `package example
func value(p *int) int {
    if p == nil { return 0 }
    return *p
}`,
  }).passes(),
  test('logging a nil pointer does not guard its dereference').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/value.go': `package example
func value(p *int) int {
    if p == nil { log.Println("missing") }
    return *p
}`,
  }).violates(),
  test('check an error before evaluating a deferred pointer use').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/request.go': `package example
func handle(client *http.Client, req *http.Request) error {
    response, err := client.Do(req)
    defer response.Body.Close()
    if err != nil { return err }
    return nil
}`,
  }).violates(),
  test('calling a method on a nil interface violates the nil-use policy').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/reader.go': `package example
type Reader interface { Read() }
func consume(reader Reader) {
    reader.Read()
}`,
  }).violates(),
  test('a nil guard makes an interface method call safe').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/reader.go': `package example
type Reader interface { Read() }
func consume(reader Reader) {
    if reader == nil { return }
    reader.Read()
}`,
  }).passes(),
  test('indexing a nil pointer to an array is an unchecked implicit dereference').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/array.go': `package example
func first(values *[2]int) int {
    return values[0]
}`,
  }).violates(),
  test('a nil guard makes pointer-to-array indexing safe').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/array.go': `package example
func first(values *[2]int) int {
    if values == nil { return 0 }
    return values[0]
}`,
  }).passes(),
  test('slicing a nil pointer to an array is an unchecked implicit dereference').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/array.go': `package example
func tail(values *[4]int) []int {
    return values[1:]
}`,
  }).violates(),
  test('a nil guard makes pointer-to-array slicing safe').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/array.go': `package example
func tail(values *[4]int) []int {
    if values == nil { return nil }
    return values[1:]
}`,
  }).passes(),
  test('slicing a nil slice is safe').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/slice.go': `package example
func clone(values []int) []int {
    return values[:]
}`,
  }).passes(),
  test('a typed-nil receiver is unsafe when its method dereferences it').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/reader.go': `package example
type counter struct { value int }
func (c *counter) Read() int { return c.value }
`,
  }).violates(),
  test('a typed-nil receiver is safe when its method handles nil').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/reader.go': `package example
type counter struct { value int }
func (c *counter) Read() int {
    if c == nil { return 0 }
    return c.value
}
`,
  }).passes(),
  test('evaluating a method value on a nil interface violates the nil-use policy').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/reader.go': `package example
type Reader interface { Read() }
func callback() func() {
    var reader Reader
    return reader.Read
}`,
  }).violates(),
  test('calling a method on a nil interface violates the nil-use policy').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/reader.go': `package example
type Reader interface { Read() }
func call(reader Reader) {
    reader.Read()
}`,
  }).violates(),
  test('a nil guard makes interface method-value evaluation safe').withFiles({
    'benchmarks/vulntune-go/per-cwe/476/reader.go': `package example
type Reader interface { Read() }
func callback(reader Reader) func() {
    if reader == nil { return nil }
    return reader.Read
}`,
  }).passes(),
] as const;
