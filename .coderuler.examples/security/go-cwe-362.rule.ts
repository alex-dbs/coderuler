import { Rule, ai, scopes, test, type ScopeSubject } from '@alex-dbs/coderuler';

// CWE-362 covers many race families; this Go policy focuses on concurrent access to
// shared in-memory state and atomicity of complete check/update sequences.
// It does not claim coverage of cross-process or filesystem TOCTOU races.
// Sources: https://cwe.mitre.org/data/definitions/362.html
// https://go.dev/doc/articles/race_detector
export default class GoCwe362 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/362/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
    },
  });

  check = ai({
    instruction: `Protect Go shared in-memory state against unsafe concurrent access and interleaving that breaks a shared-state invariant.

A function or method must still be safe when callers may invoke it concurrently.

Coordination must cover the complete check-and-update sequence, not just each memory access. Separate atomic Load and Store calls do not make a check-then-update exclusive. A single atomic read-modify-write, such as CompareAndSwap, or exclusive channel ownership is sufficient only when it protects the whole invariant.

An unsynchronized access is unsafe when concurrent accesses can include a write or interleaving can break a shared-state invariant. Function-local state, read-only sharing, or an update whose full invariant is protected is safe.`,
    // Include package siblings so shared declarations and concurrent callers are visible.
    input: async (subject, { project }) => {
      const scope = subject as ScopeSubject;
      const lastSlash = scope.filepath.lastIndexOf('/');
      const directory = lastSlash < 0 ? '' : scope.filepath.slice(0, lastSlash);
      const files = await project.glob(directory ? `${directory}/*.go` : '*.go');
      return {
        function: scope.source,
        packageFiles: await Promise.all(files.map(async filepath => ({
          filepath,
          source: await project.readText(filepath),
        }))),
      };
    },
    violationMessage: 'Protect shared Go state and make invariant-preserving updates atomic.',
    examples: {
      bad: [
        `var counts = map[string]int{}
func add(key string) {
    counts[key]++
}
func start() {
    go add("same")
    go add("same")
}`,
        `var used atomic.Bool
var grants atomic.Int64
func grantOnce() {
    if !used.Load() {
        used.Store(true)
        grants.Add(1)
    }
}
func start() {
    go grantOnce()
    go grantOnce()
}`,
      ],
      good: [
        `var (
    counts = map[string]int{}
    countsMu sync.Mutex
)
func add(key string) {
    countsMu.Lock()
    defer countsMu.Unlock()
    counts[key]++
}
func start() {
    go add("same")
    go add("same")
}`,
        `var used atomic.Bool
var grants atomic.Int64
func grantOnce() {
    if used.CompareAndSwap(false, true) {
        grants.Add(1)
    }
}
func start() {
    go grantOnce()
    go grantOnce()
}`,
      ],
    },
  });
}

export const aiTests = [
  test('concurrent map writes without synchronization violate').withFiles({
    'benchmarks/vulntune-go/per-cwe/362/counter.go': `package example

var counts = map[string]int{}

func add(key string) {
    go func() { counts[key]++ }()
}`,
  }).violates(),
  test('mutex protects concurrent map updates').withFiles({
    'benchmarks/vulntune-go/per-cwe/362/counter.go': `package example

import "sync"

var (
    counts = map[string]int{}
    countsMu sync.Mutex
)

func add(key string) {
    go func() {
        countsMu.Lock()
        defer countsMu.Unlock()
        counts[key]++
    }()
}`,
  }).passes(),
  test('channel handoff coordinates ownership of state').withFiles({
    'benchmarks/vulntune-go/per-cwe/362/worker.go': `package example

func update(ch chan<- int, value int) {
    go func() { ch <- value }()
}`,
  }).passes(),
  test('atomic load and store do not make a check-then-grant sequence exclusive').withFiles({
    'benchmarks/vulntune-go/per-cwe/362/claim.go': `package example

import "sync/atomic"

var used atomic.Bool
var grants atomic.Int64

func grantOnce() {
    for i := 0; i < 2; i++ {
        go func() {
            if !used.Load() {
                used.Store(true)
                grants.Add(1)
            }
        }()
    }
}`,
  }).violates(),
  test('compare-and-swap makes a single-use grant exclusive').withFiles({
    'benchmarks/vulntune-go/per-cwe/362/claim.go': `package example

import "sync/atomic"

var used atomic.Bool
var grants atomic.Int64

func grantOnce() {
    for i := 0; i < 2; i++ {
        go func() {
            if used.CompareAndSwap(false, true) {
                grants.Add(1)
            }
        }()
    }
}`,
  }).passes(),
  test('an unsynchronized shared map update can race without a local go statement').withFiles({
    'benchmarks/vulntune-go/per-cwe/362/counter.go': `package example

var counts = map[string]int{}

func add(key string) {
    counts[key]++
}

func startWorkers() {
    go add("same")
    go add("same")
}`,
  }).violates(),
] as const;
