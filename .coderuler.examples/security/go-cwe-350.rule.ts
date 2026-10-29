import { Rule, ai, scopes, test } from '@alex-dbs/coderuler';

// CWE-350 is broader than this Go rule, which examines peer-hostname access decisions using LookupAddr in one source file.
// It checks visible IP-hostname association and identity evidence; it cannot follow callers or trust checks outside that file.
// Sources: https://cwe.mitre.org/data/definitions/350.html
// https://go.dev/pkg/net/?m=old#LookupAddr
// https://www.rfc-editor.org/rfc/rfc8501.html
export default class GoCwe350 extends Rule {
  files = ['benchmarks/vulntune-go/per-cwe/350/*.go'];
  scope = scopes.file();
  check = ai({
    instruction: 'Within the selected Go source file, assess reverse-DNS names obtained by net.LookupAddr, net.Resolver.LookupAddr, or an alias. Do not flag reverse DNS merely because it participates in a host-based access policy: such a policy may use a PTR hostname when code verifies that a forward lookup for the hostname includes the same peer IP and checks the hostname against an explicit trusted-name policy. Flag a security decision that relies on an unconfirmed PTR name, such as trusting its suffix alone, or treats a DNS name as an authenticated principal without separate trusted credentials or a verified certificate. Forward confirmation verifies the IP-hostname association, not universally a cryptographic identity. Pass PTR names used only as metadata or returned without a security decision visible in this file. Judge only evidence in this file; do not assume decisions or checks in other files or callers, and do not claim coverage of other DNS APIs or application-wide identity.',
    input: subject => subject.source,
    violationMessage: 'Verify a PTR hostname maps forward to the peer IP before relying on it for host authorization; use verified credentials for principal authentication.',
    examples: {
      good: [
        `func trustedPeer(ip net.IP) bool {
    names, err := net.LookupAddr(ip.String())
    if err != nil || len(names) == 0 {
        return false
    }
    name := strings.TrimSuffix(names[0], ".")
    addresses, err := net.LookupIP(name)
    if err != nil {
        return false
    }
    for _, address := range addresses {
        if address.Equal(ip) {
            return strings.HasSuffix(name, ".trusted.example")
        }
    }
    return false
}`,
        `func allowed(conn *tls.Conn) bool {
    if err := conn.Handshake(); err != nil {
        return false
    }
    return len(conn.ConnectionState().VerifiedChains) > 0
}`,
        `func logPeer(ip net.IP) {
    names, _ := net.LookupAddr(ip.String())
    log.Printf("peer ip=%s ptr=%v", ip, names)
}`,
      ],
      bad: [
        `func trustedPeer(ip net.IP) bool {
    names, err := net.LookupAddr(ip.String())
    if err != nil {
        return false
    }
    return len(names) > 0 && strings.HasSuffix(names[0], ".trusted.example")
}`,
        `func trustedPeer(ip net.IP) bool {
    names, err := net.DefaultResolver.LookupAddr(context.Background(), ip.String())
    return err == nil && len(names) > 0 && names[0] == "admin.example."
}`,
        `func trustedPeer(ip net.IP) bool {
    lookup := net.LookupAddr
    names, err := lookup(ip.String())
    return err == nil && len(names) > 0 && strings.HasSuffix(names[0], ".trusted.example")
}`,
      ],
    },
  });
}

export const aiTests = [
  test('PTR hostname controls access to a protected endpoint').withFiles({
    'benchmarks/vulntune-go/per-cwe/350/server.go': `package server

import (
    "net"
    "strings"
)

func trustedPeer(ip net.IP) bool {
    names, err := net.LookupAddr(ip.String())
    if err != nil {
        return false
    }
    return len(names) > 0 && strings.HasSuffix(names[0], ".trusted.example")
}`,
  }).violates(),
  test('verified TLS identity controls access, not a PTR result').withFiles({
    'benchmarks/vulntune-go/per-cwe/350/server.go': `package server

import (
    "crypto/tls"
    "log"
    "net"
)

func trustedPeer(conn *tls.Conn) bool {
    names, _ := net.LookupAddr("127.0.0.1")
    log.Printf("peer PTR metadata: %v", names)
    if err := conn.Handshake(); err != nil {
        return false
    }
    state := conn.ConnectionState()
    return len(state.VerifiedChains) > 0
}`
  }).passes(),
  test('PTR result is used only for logging').withFiles({
    'benchmarks/vulntune-go/per-cwe/350/server.go': `package server

import (
    "log"
    "net"
)

func logPeer(ip net.IP) {
    names, _ := net.LookupAddr(ip.String())
    log.Printf("peer ip=%s ptr=%v", ip, names)
}`,
  }).passes(),
  test('forward-confirmed reverse-DNS hostname controls access').withFiles({
    'benchmarks/vulntune-go/per-cwe/350/server.go': `package server

import (
    "net"
    "strings"
)

func trustedPeer(ip net.IP) bool {
    names, err := net.LookupAddr(ip.String())
    if err != nil || len(names) == 0 {
        return false
    }
    name := strings.TrimSuffix(names[0], ".")
    addresses, err := net.LookupIP(name)
    if err != nil {
        return false
    }
    confirmed := false
    for _, address := range addresses {
        if address.Equal(ip) {
            confirmed = true
            break
        }
    }
    return confirmed && strings.HasSuffix(name, ".trusted.example")
}`,
  }).passes(),
  test('PTR suffix authorizes without forward confirmation').withFiles({
    'benchmarks/vulntune-go/per-cwe/350/server.go': `package server

import (
    "net"
    "strings"
)

func trustedPeer(ip net.IP) bool {
    names, err := net.LookupAddr(ip.String())
    if err != nil || len(names) == 0 {
        return false
    }
    return strings.HasSuffix(names[0], ".trusted.example")
}`,
  }).violates(),
  test('same-file caller authorization using a Resolver method alias is visible').withFiles({
    'benchmarks/vulntune-go/per-cwe/350/server.go': `package server

import (
    "context"
    "net"
    "strings"
)

func peerHostname(ip net.IP) (string, bool) {
    resolver := net.DefaultResolver
    lookup := resolver.LookupAddr
    names, err := lookup(context.Background(), ip.String())
    if err != nil || len(names) == 0 {
        return "", false
    }
    return names[0], true
}

func trustedPeer(ip net.IP) bool {
    name, ok := peerHostname(ip)
    return ok && strings.HasSuffix(name, ".trusted.example")
}`,
  }).violates(),
] as const;
