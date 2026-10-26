import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';
import type { ScopeSubject } from '@alex-dbs/coderuler';

export default class HttpResponseSplitting extends Rule {
  enabled = false;
  files = ['tests/manual/vulnerable_code.js'];
  scope = scopes.astGrep({
    language: 'javascript',
    rule: {
      any: [
        { kind: 'function_declaration' },
        { kind: 'function_expression' },
        { kind: 'arrow_function' },
        { kind: 'method_definition' },
      ],
    },
  });

  check = ai({
    rule: `HTTP response splitting (CWE-113) must be prevented: attacker-controlled data must not inject carriage returns (CR) or newlines (LF) into HTTP response headers or the status line, including through writeHead()'s reason phrase or statusMessage, without validation that rejects those characters.
Assess only the supplied function scope. Treat HTTP serialization entry-point arguments and statusMessage as potentially untrusted, even when their callers are not shown. Report a violation only when this scope visibly constructs or writes a response header or status line using such data without rejecting both CR and LF first. Constructing an unsafe status line and passing it to a storage or output helper is a visible unsafe path; do not assume unseen callers or helpers validate it. A call to a serialization helper alone, without visible unsafe construction, is not sufficient evidence. Fixed values and paths that reject both CR and LF before use comply. This local check is not a whole-program proof; do not invent behavior outside the supplied scope or assume protections in other versions of HTTP libraries.`,
    input: subject => (subject as ScopeSubject).source,
    violationMessage: 'Reject CR and LF in attacker-controlled response headers and status messages before writing them.',
  });
}

export const aiTests = [
  test('a public prototype writeHead accepts an unvalidated reason phrase').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`ServerResponse.prototype.writeHead = function(statusCode, reason, obj) {
  if (typeof reason === 'string') {
    this.statusMessage = reason;
  } else {
    this.statusMessage = this.statusMessage || STATUS_CODES[statusCode] || 'unknown';
    obj = reason;
  }
  statusCode |= 0;
  if (statusCode < 100 || statusCode > 999)
    throw new RangeError('Invalid status code');
  var statusLine = 'HTTP/1.1 ' + statusCode.toString() + ' ' + this.statusMessage + '\r\n';
  this._storeHeader(statusLine, obj);
};`,
  }).violates(),
  test('a public prototype writeHead validates the selected status message').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`ServerResponse.prototype.writeHead = function(statusCode, reason, obj) {
  if (typeof reason === 'string') {
    this.statusMessage = reason;
  } else {
    this.statusMessage = this.statusMessage || STATUS_CODES[statusCode] || 'unknown';
    obj = reason;
  }
  if (/[\r\n]/.test(this.statusMessage)) throw new Error('Invalid status message');
  statusCode |= 0;
  if (statusCode < 100 || statusCode > 999)
    throw new RangeError('Invalid status code');
  var statusLine = 'HTTP/1.1 ' + statusCode.toString() + ' ' + this.statusMessage + '\r\n';
  this._storeHeader(statusLine, obj);
};`,
  }).passes(),
  test('an unvalidated statusMessage reaches the status line').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`function writeHead(statusCode) {
  this.socket.write('HTTP/1.1 ' + statusCode + ' ' + this.statusMessage + '\r\n\r\n');
}`,
  }).violates(),
  test('an unvalidated request value reaches a response header').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`export function respond(request, socket) {
  const name = new URL(request.url, 'http://localhost').searchParams.get('name');
  socket.write('HTTP/1.1 200 OK\r\nX-Name: ' + name + '\r\n\r\n');
}`,
  }).violates(),
  test('rejecting only LF still permits CR injection').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`export function respond(request, socket) {
  const name = new URL(request.url, 'http://localhost').searchParams.get('name') || '';
  if (name.includes('\n')) throw new Error('Invalid header');
  socket.write('HTTP/1.1 200 OK\r\nX-Name: ' + name + '\r\n\r\n');
}`,
  }).violates(),
  test('rejecting CR and LF protects both the status line and a header').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`export function respond(request, socket) {
  const text = new URL(request.url, 'http://localhost').searchParams.get('text') || '';
  if (/[\r\n]/.test(text)) throw new Error('Invalid response text');
  socket.write('HTTP/1.1 200 ' + text + '\r\nX-Text: ' + text + '\r\n\r\n');
}`,
  }).passes(),
  test('fixed response values need no input validation').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`export function respond(request, socket) {
  socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHello');
}`,
  }).passes(),
  test('an arrow function constructs an unvalidated response header').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`const respond = (request, socket) => {
  const name = new URL(request.url, 'http://localhost').searchParams.get('name');
  socket.write('HTTP/1.1 200 OK\r\nX-Name: ' + name + '\r\n\r\n');
};`,
  }).violates(),
  test('a method rejects CR and LF before constructing a response header').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`class Responder {
  respond(request, socket) {
    const name = new URL(request.url, 'http://localhost').searchParams.get('name') || '';
    if (/[\r\n]/.test(name)) throw new Error('Invalid header');
    socket.write('HTTP/1.1 200 OK\r\nX-Name: ' + name + '\r\n\r\n');
  }
}`,
  }).passes(),
  test('a safe function does not hide another vulnerable function').withFiles({
    'tests/manual/vulnerable_code.js': String.raw`function safeRespond(request, socket) {
  const name = new URL(request.url, 'http://localhost').searchParams.get('name') || '';
  if (/[\r\n]/.test(name)) throw new Error('Invalid header');
  socket.write('HTTP/1.1 200 OK\r\nX-Name: ' + name + '\r\n\r\n');
}
function unsafeRespond(request, socket) {
  const name = new URL(request.url, 'http://localhost').searchParams.get('name') || '';
  socket.write('HTTP/1.1 200 OK\r\nX-Name: ' + name + '\r\n\r\n');
}`,
  }).violates(),
] as const;
