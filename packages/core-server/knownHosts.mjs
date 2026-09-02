// OpenSSH `known_hosts` parsing and host-key verification.
//
// WHY THIS EXISTS: ssh2's Client.connect() accepts ANY host key when no `hostVerifier` is supplied.
// That is not a weaker check than `ssh` — it is no check at all, so a remote source could be
// answered by anything on the path and would still be handed the user's password. This module is
// the trust decision; sftpClient.mjs is the plumbing that enforces it.
//
// Deliberately parses the real on-disk format rather than shelling out to `ssh-keygen -F`: the
// server must work identically on Windows, where no OpenSSH binary is guaranteed.
//
// Pure and filesystem-free (the caller supplies the text) so every branch is unit-testable.
import crypto from 'node:crypto'

// Trust markers OpenSSH understands at the start of a line.
const MARKER_REVOKED = '@revoked'
const MARKER_CERT_AUTHORITY = '@cert-authority'

/**
 * Parse known_hosts text into entries. Unparseable lines are skipped, never thrown on — a single
 * corrupt line in a long file must not make every host unverifiable.
 *
 * Returns [{ marker, patterns, hashed: { salt, hash } | null, keyType, keyBase64 }].
 */
export function parseKnownHosts(text) {
  const entries = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    let fields = line.split(/\s+/)
    let marker = null
    if (fields[0] === MARKER_REVOKED || fields[0] === MARKER_CERT_AUTHORITY) {
      marker = fields[0]
      fields = fields.slice(1)
    }
    // host-spec, key-type, base64-key. Trailing comments/fields are ignored.
    if (fields.length < 3) continue
    const [hostSpec, keyType, keyBase64] = fields
    if (!keyType.includes('-') || !keyBase64) continue

    // A hashed entry names exactly one host as |1|<base64 salt>|<base64 HMAC-SHA1>.
    let hashed = null
    let patterns = []
    if (hostSpec.startsWith('|1|')) {
      const parts = hostSpec.split('|')
      // ['', '1', salt, hash]
      if (parts.length !== 4 || !parts[2] || !parts[3]) continue
      hashed = { salt: parts[2], hash: parts[3] }
    } else {
      patterns = hostSpec.split(',').filter(Boolean)
      if (patterns.length === 0) continue
    }
    entries.push({ marker, patterns, hashed, keyType, keyBase64 })
  }
  return entries
}

// The name OpenSSH looks up: the bare host on port 22, "[host]:port" on anything else.
function hostSpecFor(host, port) {
  return Number(port) === 22 || port == null ? String(host) : `[${host}]:${port}`
}

// OpenSSH host patterns allow `*` and `?` wildcards. Anchored so "example.com" cannot be matched
// by a pattern that merely contains it.
function patternMatches(pattern, candidate) {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern.toLowerCase() === candidate.toLowerCase()
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(candidate)
}

// A hashed entry stores HMAC-SHA1(key = raw salt bytes, data = the host spec), base64-encoded.
function hashedMatches(hashed, candidate) {
  let salt
  try {
    salt = Buffer.from(hashed.salt, 'base64')
  } catch {
    return false
  }
  if (salt.length === 0) return false
  const digest = crypto.createHmac('sha1', salt).update(candidate).digest('base64')
  return digest === hashed.hash
}

function entryMatchesHost(entry, candidate) {
  if (entry.hashed) return hashedMatches(entry.hashed, candidate)
  // A leading '!' negates a pattern; if any negation matches, the entry does not apply at all.
  if (entry.patterns.some((p) => p.startsWith('!') && patternMatches(p.slice(1), candidate))) return false
  return entry.patterns.some((p) => !p.startsWith('!') && patternMatches(p, candidate))
}

/**
 * Decide whether a presented host key is trusted.
 *
 *   'match'    — this host is known and this is its key. Proceed.
 *   'mismatch' — this host is known and this is NOT its key. Someone is between you and it.
 *   'revoked'  — the key is explicitly revoked.
 *   'unknown'  — no entry for this host. First contact; the caller decides (we refuse).
 *
 * `keyBase64` is the base64 of the SSH wire-format public key blob — exactly what known_hosts
 * stores, and exactly what ssh2 hands `hostVerifier` once it is base64-encoded.
 *
 * Several keys per host (an ed25519 AND an rsa entry) is normal, so a host that matches on a
 * different key TYPE than the one presented is 'unknown', not 'mismatch'. Only a same-type,
 * different-key collision is the alarming case.
 */
export function verifyHostKey(entries, { host, port = 22, keyType, keyBase64 }) {
  const candidate = hostSpecFor(host, port)
  let sawSameTypeDifferentKey = false

  for (const entry of entries) {
    if (!entryMatchesHost(entry, candidate)) continue
    // Trust delegated to a CA is not implemented; such a line must never be read as a direct key.
    if (entry.marker === MARKER_CERT_AUTHORITY) continue
    if (entry.keyBase64 === keyBase64) {
      // A revocation anywhere for this exact key wins outright, whatever else the file says.
      if (entry.marker === MARKER_REVOKED) return 'revoked'
      if (entry.keyType === keyType) return 'match'
    } else if (entry.keyType === keyType && entry.marker !== MARKER_REVOKED) {
      sawSameTypeDifferentKey = true
    }
  }
  return sawSameTypeDifferentKey ? 'mismatch' : 'unknown'
}
