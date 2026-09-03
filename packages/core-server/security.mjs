// Tool-agnostic security primitives: per-launch session token and path containment.
// No Viewer-domain knowledge lives here so core/ can be lifted into a shared package later.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Session token
// ---------------------------------------------------------------------------

// A fresh, high-entropy token minted once per launch. The launcher generates it and
// the server templates it into index.html at serve time (loopback only), so it never
// appears in a URL or browser history.
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex')
}

// Constant-time comparison. Never short-circuits on length or content, so the caller
// leaks no timing signal about how much of a guessed token was correct.
export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  // crypto.timingSafeEqual throws on length mismatch; hash both to a fixed width first
  // so even the length comparison is constant-time.
  const hA = crypto.createHash('sha256').update(bufA).digest()
  const hB = crypto.createHash('sha256').update(bufB).digest()
  return crypto.timingSafeEqual(hA, hB)
}

// Name of the loopback session cookie set on index.html so same-origin data fetches
// (NiiVue volume/mesh loaders, which cannot set request headers) authenticate implicitly.
export const TOKEN_COOKIE = 'brainana_token'

function cookieToken(req) {
  const raw = req.headers['cookie']
  if (typeof raw !== 'string') return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === TOKEN_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

// Pull the token from a request, in priority order: `Authorization: Bearer <t>`,
// `X-Brainana-Token`, or the loopback cookie. A `?token=` query param is deliberately NOT
// accepted: it would land the token in server logs, the Referer header, and browser history,
// defeating the whole "token never appears in a URL" design. The JS client sends the Bearer
// header; NiiVue's own header-less loaders authenticate via the same-origin loopback cookie.
export function extractToken(req) {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim()
  const header = req.headers['x-brainana-token']
  if (typeof header === 'string' && header) return header.trim()
  const cookie = cookieToken(req)
  if (cookie) return cookie
  return null
}

// Guard factory. Returns a predicate `(req) => boolean`. When `token` is null
// (e.g. legacy-compat loopback mode) the guard is disabled and always passes.
export function createTokenGuard(token) {
  if (!token) return () => true
  return (req) => {
    const presented = extractToken(req)
    return presented != null && timingSafeEqual(presented, token)
  }
}

// ---------------------------------------------------------------------------
// Host containment
// ---------------------------------------------------------------------------

// True when a request's `Host` header names this machine's loopback interface.
//
// The server binds 127.0.0.1, but a bind does not decide what name the CLIENT used to get here.
// In a DNS-rebinding attack a page on evil.com re-resolves that name to 127.0.0.1, reaches this
// socket, and — because the browser considers it same-origin with evil.com — can read the response
// body, including the session token templated into index.html. Comparing Host against loopback is
// what makes the bind mean what it appears to mean. A missing/blank header is refused: every
// HTTP/1.1 client sends one, so its absence is not a case worth being lenient about.
export function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  // Split off the port. IPv6 literals are bracketed in a Host header ("[::1]:5173"), so they must
  // be unwrapped before the naive first-colon split that handles "127.0.0.1:5173".
  let host
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']')
    if (close < 0) return false
    host = hostHeader.slice(1, close)
  } else {
    const colon = hostHeader.indexOf(':')
    host = colon < 0 ? hostHeader : hostHeader.slice(0, colon)
  }
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower === '::1') return true
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1. Anchored so a suffix that merely
  // starts with a loopback address ("127.0.0.1.evil.com") is not mistaken for one.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)
}

// ---------------------------------------------------------------------------
// Path containment (ported from server.mjs isWithin / cleanRelative)
// ---------------------------------------------------------------------------

// True when `candidate` is `root` itself or lives inside it — rejects `..` escapes
// and absolute-path breakouts.
export function isWithin(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Normalise a client-supplied relative path to forward-slash segments, rejecting
// `.`/`..`/NUL. Returns '' for the root. Throws on traversal attempts.
export function cleanRelative(raw = '') {
  const value = String(raw).replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = value.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('Invalid path')
  }
  return parts.join('/')
}

// Containment that survives symlinks.
//
// isWithin() above compares LEXICALLY — it never touches the filesystem — so a symlink inside the
// root pointing out of it passes, and whatever follows (readdir, createReadStream) then dutifully
// follows the link. cleanRelative already blocks `..` in client input, which makes a symlink the
// remaining way out.
//
// Both sides are resolved to their real paths before comparing. `root` should be pre-resolved once
// by the caller (a data root does not move) so this costs ONE extra syscall per request, not one
// per byte range. A path that cannot be resolved — missing file, broken link, EACCES — is treated
// as outside: the caller reports "not found", which is also what it should say about a file it is
// not allowed to reach.
export function isWithinReal(resolvedRoot, candidate) {
  let realCandidate
  try {
    realCandidate = fs.realpathSync(candidate)
  } catch {
    return false
  }
  return isWithin(resolvedRoot, realCandidate)
}

// Resolve a clean relative path against an absolute root, asserting containment.
export function resolveWithin(root, raw) {
  const clean = cleanRelative(raw)
  const resolved = path.resolve(root, ...clean.split('/').filter(Boolean))
  if (!isWithin(root, resolved)) throw new Error('Path is outside the configured root')
  return { clean, resolved }
}
