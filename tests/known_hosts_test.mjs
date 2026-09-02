// Unit tests for ~/.ssh/known_hosts parsing and host-key verification (audit finding C1).
//
// SftpClient previously called ssh2's connect() with no hostVerifier, and ssh2 accepts ANY host key
// when none is supplied — so every remote source was MITM-able and handed the user's password to
// whatever answered the port. These fixtures are real `ssh-keygen` output (including a genuine
// `ssh-keygen -H` hashed line, the default on Debian/Ubuntu) so the parser is tested against the
// format OpenSSH actually writes rather than one invented here.
import assert from 'node:assert/strict'
import { parseKnownHosts, verifyHostKey } from '@brainana/core-server/knownHosts.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAICU4KsDB6UZW3B2ubZNh8vgbaOoUccjhzYVJuLv5fqjw'
const OTHER_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const TYPE = 'ssh-ed25519'

const PLAIN = `example.com ${TYPE} ${KEY}`
const HASHED = `|1|bKK7LokT510In7pr0Wr9wdWFTps=|dEv7Fuw+YVs/Yj0XMjiwUKKntjo= ${TYPE} ${KEY}`
const PORTED = `[example.com]:2222 ${TYPE} ${KEY}`

// --- parsing ---
const entries = parseKnownHosts(`# a comment\n\n${PLAIN}\n${PORTED}\n`)
assert.equal(entries.length, 2, 'comments and blank lines are skipped')
assert.equal(entries[0].keyType, TYPE)
assert.equal(entries[0].keyBase64, KEY)
ok('parseKnownHosts skips comments/blanks and reads type + key')

// --- the happy path ---
assert.equal(verifyHostKey(parseKnownHosts(PLAIN), { host: 'example.com', port: 22, keyType: TYPE, keyBase64: KEY }), 'match')
ok('a known host presenting its known key matches')

// --- the attack this exists to stop ---
assert.equal(verifyHostKey(parseKnownHosts(PLAIN), { host: 'example.com', port: 22, keyType: TYPE, keyBase64: OTHER_KEY }), 'mismatch')
ok('a known host presenting a DIFFERENT key is a mismatch, not a silent accept')

// --- first contact ---
assert.equal(verifyHostKey(parseKnownHosts(PLAIN), { host: 'unlisted.example.org', port: 22, keyType: TYPE, keyBase64: KEY }), 'unknown')
assert.equal(verifyHostKey([], { host: 'example.com', port: 22, keyType: TYPE, keyBase64: KEY }), 'unknown')
ok('an unlisted host, or an empty/absent file, is unknown rather than trusted')

// --- hashed known_hosts (the Debian/Ubuntu default) ---
assert.equal(verifyHostKey(parseKnownHosts(HASHED), { host: 'example.com', port: 22, keyType: TYPE, keyBase64: KEY }), 'match')
assert.equal(verifyHostKey(parseKnownHosts(HASHED), { host: 'example.com', port: 22, keyType: TYPE, keyBase64: OTHER_KEY }), 'mismatch')
assert.equal(verifyHostKey(parseKnownHosts(HASHED), { host: 'other.example.com', port: 22, keyType: TYPE, keyBase64: KEY }), 'unknown')
ok('HMAC-hashed host entries match, mismatch and miss correctly')

// --- ports: OpenSSH writes [host]:port for anything but 22 ---
assert.equal(verifyHostKey(parseKnownHosts(PORTED), { host: 'example.com', port: 2222, keyType: TYPE, keyBase64: KEY }), 'match')
assert.equal(verifyHostKey(parseKnownHosts(PORTED), { host: 'example.com', port: 22, keyType: TYPE, keyBase64: KEY }), 'unknown')
assert.equal(verifyHostKey(parseKnownHosts(PLAIN), { host: 'example.com', port: 2222, keyType: TYPE, keyBase64: KEY }), 'unknown')
ok('a non-default port is matched via the [host]:port form and does not cross-match port 22')

// --- several keys for one host is normal (ed25519 + rsa), not a mismatch ---
const multi = parseKnownHosts(`example.com ssh-rsa AAAAB3NzaC1yc2ETESTTESTTEST\nexample.com ${TYPE} ${KEY}`)
assert.equal(verifyHostKey(multi, { host: 'example.com', port: 22, keyType: TYPE, keyBase64: KEY }), 'match')
ok('a host with several key types matches on the type actually presented')

// --- comma-separated aliases ---
const aliased = parseKnownHosts(`alias.example.com,10.0.0.7 ${TYPE} ${KEY}`)
assert.equal(verifyHostKey(aliased, { host: '10.0.0.7', port: 22, keyType: TYPE, keyBase64: KEY }), 'match')
ok('comma-separated host aliases each match')

// --- markers ---
const revoked = parseKnownHosts(`@revoked example.com ${TYPE} ${KEY}`)
assert.equal(verifyHostKey(revoked, { host: 'example.com', port: 22, keyType: TYPE, keyBase64: KEY }), 'revoked')
ok('@revoked wins over a key that would otherwise match')

// A @cert-authority line delegates trust to a CA, which is not implemented — it must not be
// mistaken for a plain host entry and accepted.
const ca = parseKnownHosts(`@cert-authority *.example.com ${TYPE} ${KEY}`)
assert.equal(verifyHostKey(ca, { host: 'host.example.com', port: 22, keyType: TYPE, keyBase64: KEY }), 'unknown')
ok('@cert-authority entries are not treated as direct host keys')

// --- malformed input must not throw ---
for (const junk of ['', 'garbage', 'only-a-host', '|1|badsalt ssh-ed25519 key', '\n\n\n']) {
  assert.doesNotThrow(() => verifyHostKey(parseKnownHosts(junk), { host: 'example.com', port: 22, keyType: TYPE, keyBase64: KEY }))
}
ok('malformed lines are skipped rather than thrown on')

console.log(`\nknown_hosts: ${passed} checks passed`)
