import type { Subject } from '@alex-dbs/coderuler';

import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';

// Sources: https://cwe.mitre.org/data/definitions/415.html
// https://github.com/golang/go/issues/78803
// This rule checks same-file Go/cgo double-release patterns, not all of CWE-415.
export default class GoCwe415 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/415/*.go'];
  group = 'file';
  // Select deallocator calls and common Go release/destructor wrappers; input includes same-file ownership context.
  scope = scopes.astGrep({
    language: 'go',
    rule: {
      any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }],
      has: {
        kind: 'call_expression',
        stopBy: 'end',
        has: {
          any: [
            { kind: 'identifier', regex: '(?i)(free|release|destroy|dealloc|dispose|delete|drop|close|cleanup|finalize|unref)' },
            { kind: 'selector_expression', regex: '(?i)(free|release|destroy|dealloc|dispose|delete|drop|close|cleanup|finalize|unref)' },
          ],
        },
      },
    },
  });
  check = ai({
    instruction: 'Check Go/cgo code for repeated release of the same C/native allocation. Along each execution path, count actual native deallocators and ownership-consuming destructors, including C.free and wrappers around native deallocation, plus deferred or finalizer cleanup shown in the supplied file. Do not treat an arbitrary repeated call or a non-owning Close as a deallocation. Treat pointer parameters, aliases, and differently named variables as possibly referring to the same allocation unless the source establishes distinct allocations or ownership, or proves releases mutually exclusive; names alone do not establish distinctness. Use the selected functions to identify candidate releases. Flag only a second release of the same allocation; separately allocated values and mutually exclusive cleanup are safe. This is a same-file check: code in other files and external native ownership state are outside its evidence, so do not claim complete CWE-415 coverage or infer safety from their absence.',
    examples: {
      good: [
        `func release(buf *C.char) {
    C.free(unsafe.Pointer(buf))
}`,
        `func releaseSeparate() {
    first := C.CString("first")
    second := C.CString("second")
    C.free(unsafe.Pointer(first))
    C.free(unsafe.Pointer(second))
}`,
      ],
      bad: [
        `func releaseBoth(first, second *C.char) {
    C.free(unsafe.Pointer(first))
    C.free(unsafe.Pointer(second))
}`,
        `func releaseTwice(buf *C.char) {
    C.free(unsafe.Pointer(buf))
    C.release_native(unsafe.Pointer(buf))
}`,
        `func releaseOnError(buf *C.char, err error) {
    defer C.free(unsafe.Pointer(buf))
    if err != nil {
        C.free(unsafe.Pointer(buf))
        return
    }
}`,
      ],
    },
    input: (subject: Subject) => {
      const scopes = subject.kind === 'scope' ? [subject] : subject.members;
      const filepaths = [...new Set(scopes.map(scope => scope.filepath))];
      return Promise.all(filepaths.map(async filepath => ({
        filepath,
        functions: scopes
          .filter(scope => scope.filepath === filepath)
          .map(scope => scope.source),
      })));
    },
    violationMessage: 'Ensure each C/native allocation is released at most once on every execution path.',
  });
}

export const aiTests = [
  test('a deferred cleanup and error cleanup free the same C allocation twice').withFiles({
    'benchmarks/vulntune-go/per-cwe/415/cleanup.go': `package example

/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func releaseOnError(buf *C.char, err error) {
    defer C.free(unsafe.Pointer(buf))
    if err != nil {
        C.free(unsafe.Pointer(buf))
        return
    }
}`,
  }).violates(),
  test('one cleanup frees a C allocation once').withFiles({
    'benchmarks/vulntune-go/per-cwe/415/cleanup.go': `package example

/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func release(buf *C.char) {
    C.free(unsafe.Pointer(buf))
}`,
  }).passes(),
  test('separate C allocations may each be freed once').withFiles({
    'benchmarks/vulntune-go/per-cwe/415/cleanup.go': `package example

/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func releaseBoth() {
    first := C.malloc(1)
    second := C.malloc(1)
    C.free(first)
    C.free(second)
}`,
  }).passes(),
  test('a C free alias releases the same allocation after C.free').withFiles({
    'benchmarks/vulntune-go/per-cwe/415/cleanup.go': `package example

/*
#include <stdlib.h>
static void release_native(void *p) { free(p); }
*/
import "C"
import "unsafe"

func releaseTwice(buf *C.char) {
    C.free(unsafe.Pointer(buf))
    C.release_native(unsafe.Pointer(buf))
}`,
  }).violates(),
  test('two pointer parameters may alias the same allocation').withFiles({
    'benchmarks/vulntune-go/per-cwe/415/cleanup.go': `package example

/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func releaseBoth(first, second *C.char) {
    C.free(unsafe.Pointer(first))
    C.free(unsafe.Pointer(second))
}`,
  }).violates(),
  test('separately allocated C pointers may each be freed once').withFiles({
    'benchmarks/vulntune-go/per-cwe/415/cleanup.go': `package example

/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

func releaseSeparate() {
    first := C.CString("first")
    second := C.CString("second")
    C.free(unsafe.Pointer(first))
    C.free(unsafe.Pointer(second))
}`,
  }).passes(),
  test('repeated Go wrapper calls can release the same native allocation twice').withFiles({
    'benchmarks/vulntune-go/per-cwe/415/cleanup.go': `package example

/*
#include <stdlib.h>
static void release_native(void *p) { free(p); }
*/
import "C"
import "unsafe"

func releaseNative(buf *C.char) {
    C.release_native(unsafe.Pointer(buf))
}

func releaseTwice(buf *C.char) {
    releaseNative(buf)
    releaseNative(buf)
}`,
  }).violates(),
] as const;
