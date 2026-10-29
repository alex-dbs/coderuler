import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';
import type { ScopeSubject, Subject } from '@alex-dbs/coderuler';

// CWE-119 is a class; this rule covers unsafe/native-memory bounds and unchecked Go buffer indexes or slice bounds, not every CWE-119 case.
// Invalid built-in slice bounds panic in Go even though the runtime prevents access outside the allocation.
// Only same-file context is supplied, so external caller/allocation contracts are not fully analyzed.
// Sources: https://cwe.mitre.org/data/definitions/119.html
// https://securego.io/docs/rules/g103
export default class GoCwe119 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/119/*.go'];
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [
        { kind: 'function_declaration' },
        { kind: 'method_declaration' },
        {
          kind: 'var_declaration',
          inside: { kind: 'source_file' },
          has: {
            any: [
              { pattern: 'unsafe.Slice($PTR, $LEN)' },
              { pattern: 'unsafe.String($PTR, $LEN)' },
            ],
            stopBy: 'end',
          },
        },
      ],
    },
  });

  check = ai({
    instruction: `Keep Go buffer accesses within their valid bounds and keep unsafe/native backing storage alive for every access. Validate caller-controlled or computed indexes and slice bounds against the target buffer's length or capacity before use; an invalid bound can panic even though Go prevents an out-of-bounds memory access. A count returned by io.Reader.Read is within the supplied slice's length by contract, so slicing that same buffer directly with the returned count is safe. For unsafe/native views, judge bounds against the view's intended buffer or field subobject, not only its enclosing allocation. Flag access after release only when the selected code or same-file context shows that lifetime violation. Missing external caller or helper contracts alone are unknown, not proof of a violation.`,
    examples: {
      good: [
        `func view(buf []byte, n int) []byte {
    if n < 0 || n > len(buf) {
        return nil
    }
    if n == 0 {
        return []byte{}
    }
    return unsafe.Slice(&buf[0], n)
}`,
        `type record struct {
    payload [4]byte
    secret  [4]byte
}

func payloadView(r *record) []byte {
    return unsafe.Slice(&r.payload[0], len(r.payload))
}`,
        `/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func readLiveBuffer() byte {
    ptr := C.malloc(C.size_t(1))
    if ptr == nil {
        return 0
    }
    view := unsafe.Slice((*byte)(ptr), 1)
    value := view[0]
    C.free(ptr)
    return value
}`,
        `import "io"

func readPrefix(r io.Reader, buffer []byte) []byte {
    n, _ := r.Read(buffer)
    return buffer[:n]
}`,
      ],
      bad: [
        `type record struct {
    payload [4]byte
    secret  [4]byte
}

func payloadView(r *record) []byte {
    return unsafe.Slice(&r.payload[0], len(r.payload)+len(r.secret))
}`,
        `/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func readReleasedBuffer() byte {
    ptr := C.malloc(C.size_t(1))
    if ptr == nil {
        return 0
    }
    view := unsafe.Slice((*byte)(ptr), 1)
    C.free(ptr)
    return view[0]
}`,
        `import (
    "net/http"
    "strconv"
)

func respond(w http.ResponseWriter, r *http.Request, buffer []byte) {
    length, _ := strconv.Atoi(r.URL.Query().Get("length"))
    _, _ = w.Write(buffer[:length])
}`,
      ],
    },
    input: async (subject: Subject, { project }) => {
      const selected = subject as ScopeSubject;
      return {
        scope: selected.source,
        file: await project.readText(selected.filepath),
      };
    },
    violationMessage: 'Validate caller-controlled buffer bounds; keep unsafe ranges in-bounds and backing storage alive.',
  });
}

export const aiTests = [
  test('an unsafe view exceeding its backing slice violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/view.go': `package example

import "unsafe"

func view(buf []byte) []byte {
    if len(buf) == 0 {
        return nil
    }
    return unsafe.Slice(&buf[0], len(buf)+1)
}`,
  }).violates(),
  test('a slice length is validated against its backing buffer').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/view.go': `package example

import "unsafe"

func view(buf []byte, n int) []byte {
    if n < 0 || n > len(buf) {
        return nil
    }
    if n == 0 {
        return []byte{}
    }
    return unsafe.Slice(&buf[0], n)
}`,
  }).passes(),
  test('ordinary Go slice access uses built-in bounds checks').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/read.go': `package example

func read(buf []byte, i int) (byte, bool) {
    if i < 0 || i >= len(buf) {
        return 0, false
    }
    return buf[i], true
}`,
  }).passes(),
  test('an unchecked request-controlled slice bound can panic').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/query.go': `package example

import (
    "net/http"
    "strconv"
)

func respond(w http.ResponseWriter, r *http.Request, buffer []byte) {
    length, _ := strconv.Atoi(r.URL.Query().Get("length"))
    _, _ = w.Write(buffer[:length])
}`,
  }).violates(),
  test('a read count stays within its destination slice').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/reader.go': `package example

import "io"

func readPrefix(r io.Reader) []byte {
    buffer := make([]byte, 32)
    n, _ := r.Read(buffer)
    return buffer[:n]
}`,
  }).passes(),
  test('an unsafe view must not cross a field subobject boundary').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/record.go': `package example

import "unsafe"

type record struct {
    payload [4]byte
    secret  [4]byte
}

func payloadView(r *record) []byte {
    return unsafe.Slice(&r.payload[0], len(r.payload)+len(r.secret))
}`,
  }).violates(),
  test('an unsafe view confined to its field subobject is allowed').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/record.go': `package example

import "unsafe"

type record struct {
    payload [4]byte
    secret  [4]byte
}

func payloadView(r *record) []byte {
    return unsafe.Slice(&r.payload[0], len(r.payload))
}`,
  }).passes(),
  test('a native-backed view must not be accessed after its storage is released').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/buffer.go': `package example

/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func readReleasedBuffer() byte {
    ptr := C.malloc(C.size_t(1))
    if ptr == nil {
        return 0
    }
    view := unsafe.Slice((*byte)(ptr), 1)
    C.free(ptr)
    return view[0]
}`,
  }).violates(),
  test('a native-backed view may be accessed before its storage is released').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/buffer.go': `package example

/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func readLiveBuffer() byte {
    ptr := C.malloc(C.size_t(1))
    if ptr == nil {
        return 0
    }
    view := unsafe.Slice((*byte)(ptr), 1)
    value := view[0]
    C.free(ptr)
    return value
}`,
  }).passes(),
  test('a pointer-length wrapper with an explicit caller contract passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/view.go': `package example

import "unsafe"

func borrowView(ptr unsafe.Pointer, n int) []byte {
    // Preconditions: n is nonnegative, ptr addresses n accessible bytes, and callers keep them live through every access to the returned view.
    return unsafe.Slice((*byte)(ptr), n)
}`,
  }).passes(),
  test('a package-level unsafe view crossing a field boundary violates').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/record.go': `package example

import "unsafe"

type record struct {
    payload [4]byte
    secret  [4]byte
}

var globalRecord = record{}
var globalPayload = unsafe.Slice(&globalRecord.payload[0], len(globalRecord.payload)+len(globalRecord.secret))
`,
  }).violates(),
  test('a package-level unsafe view confined to its field passes').withFiles({
    'benchmarks/vulntune-go/per-cwe/119/record.go': `package example

import "unsafe"

type record struct {
    payload [4]byte
    secret  [4]byte
}

var globalRecord = record{}
var globalPayload = unsafe.Slice(&globalRecord.payload[0], len(globalRecord.payload))
`,
  }).passes(),
] as const;
