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
    instruction: `Reject CR and LF in untrusted values before inserting them into HTTP response headers or status lines.
Check only construction or writing visible in the supplied function, including constructed status lines passed to output helpers. A helper call alone does not establish unsafe construction.
Treat serialization arguments and statusMessage as potentially untrusted. Fixed values and values checked for both CR and LF meet this requirement. Keep fixed HTTP delimiters.`,
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
