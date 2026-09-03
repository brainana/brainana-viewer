// Unit tests for core/server/security.mjs: token compare + path containment.
import assert from 'node:assert/strict'
import path from 'node:path'
import { generateSessionToken, timingSafeEqual, createTokenGuard, isWithin, cleanRelative, resolveWithin, extractToken } from '@brainana/core-server/security.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- token ---
const token = generateSessionToken()
assert.equal(typeof token, 'string')
assert.equal(token.length, 64, 'token is 32 bytes hex')
ok('generateSessionToken returns 64-hex chars')

assert.equal(timingSafeEqual(token, token), true)
// Swap the last hex char for a guaranteed-different one (never equal, so never flaky).
assert.equal(timingSafeEqual(token, token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')), false)
assert.equal(timingSafeEqual(token, ''), false)
assert.equal(timingSafeEqual('', ''), true)
assert.equal(timingSafeEqual(token, 'short'), false, 'length mismatch is safely false, not a throw')
ok('timingSafeEqual handles equal, unequal, and length-mismatch inputs')

// --- guard ---
const guard = createTokenGuard(token)
const reqWith = (t) => ({ headers: t ? { authorization: `Bearer ${t}` } : {} })
assert.equal(guard(reqWith(token)), true)
assert.equal(guard(reqWith('nope')), false)
assert.equal(guard(reqWith(null)), false)
assert.equal(guard({ headers: { 'x-brainana-token': token } }), true)
ok('createTokenGuard accepts a bearer or x-brainana-token header, and rejects wrong/absent')

// The guard reads ONLY `req` — it is given no URL and therefore cannot consult a query string,
// which is how "?token= is never accepted" is enforced structurally rather than by a check.
// This used to be asserted by passing a URL as a second argument and expecting false; that
// argument was silently discarded, so the assertion merely re-tested the no-headers case above and
// would have passed whatever the policy were. The real property is asserted end-to-end against a
// running server in token_transport_test.mjs.
assert.equal(createTokenGuard(token).length, 1, 'the guard takes req alone, so a query string is unreachable to it')
ok('the guard has no access to the request URL by construction')

const openGuard = createTokenGuard(null)
assert.equal(openGuard({ headers: {} }, new URL('http://x/')), true, 'null token disables the guard')
ok('null token disables the guard (legacy loopback)')

// --- path containment ---
assert.equal(isWithin('/a/b', '/a/b/c'), true)
assert.equal(isWithin('/a/b', '/a/b'), true)
assert.equal(isWithin('/a/b', '/a/x'), false)
assert.equal(isWithin('/a/b', '/a/b/../x'), false)
ok('isWithin rejects sibling and parent escapes')

assert.equal(cleanRelative('sub-1/anat'), 'sub-1/anat')
assert.equal(cleanRelative('/sub-1//anat/'), 'sub-1/anat')
assert.equal(cleanRelative('a\\b'), 'a/b')
for (const bad of ['../x', 'a/../../b', 'a/./b/..', 'a\0b']) {
  assert.throws(() => cleanRelative(bad), /Invalid path/, `cleanRelative rejects ${JSON.stringify(bad)}`)
}
ok('cleanRelative normalises and rejects traversal/NUL')

const { clean, resolved } = resolveWithin('/root', 'a/b')
assert.equal(clean, 'a/b')
assert.equal(resolved, path.resolve('/root', 'a', 'b'))
assert.throws(() => resolveWithin('/root', '../escape'))
ok('resolveWithin resolves inside root and rejects escapes')

// --- Windows-shaped path strings (fed on any host; cleanRelative is a pure string function) ---
// Backslashes are normalised to '/', then '.'/'..'/NUL segments are rejected.
assert.throws(() => cleanRelative('..\\..\\etc\\passwd'), /Invalid path/, 'backslash traversal is rejected')
assert.throws(() => cleanRelative('a\\..\\..\\b'), /Invalid path/, 'mixed backslash traversal is rejected')
assert.throws(() => cleanRelative('a\0b'), /Invalid path/, 'embedded NUL is rejected')
assert.equal(cleanRelative('a\\b\\c'), 'a/b/c', 'backslashes normalise to forward slashes')
assert.equal(cleanRelative('\\\\server\\share\\x'), 'server/share/x', 'UNC leading slashes are stripped')
assert.equal(cleanRelative('/a//b/'), 'a/b', 'leading/duplicate/trailing slashes collapse')
// A Windows drive letter is kept as a literal segment by the (platform-agnostic) string pass;
// resolveWithin is what ultimately enforces containment — on win32 `path.resolve` re-roots a
// drive letter and isWithin then rejects it. Documented here so the behavior can't drift.
assert.equal(cleanRelative('C:\\Windows'), 'C:/Windows', 'drive letter survives as a literal segment')
assert.equal(cleanRelative('C:foo'), 'C:foo', 'drive-relative form survives as a literal segment')
ok('cleanRelative normalises Windows separators and rejects traversal cross-platform')

// resolveWithin returns the cleaned relative path plus an absolute resolution inside root.
{
  const { clean, resolved } = resolveWithin('/root', 'a\\b')
  assert.equal(clean, 'a/b', 'resolveWithin cleans backslashes')
  assert.equal(resolved, path.resolve('/root', 'a', 'b'), 'resolveWithin resolves inside root')
}
ok('resolveWithin accepts backslash input and resolves within root')

// isWithin path comparison is case-sensitive on Linux and case-insensitive on macOS/Windows —
// assert the host behavior so containment is never assumed to be case-insensitive.
if (process.platform === 'linux') {
  assert.equal(isWithin('/Root', '/root/x'), false, 'POSIX path comparison is case-sensitive')
}
ok('isWithin case-sensitivity matches the host platform')

// --- extractToken precedence: Bearer > X-Brainana-Token > cookie ---
const bearerReq = { headers: { authorization: 'Bearer AAA', 'x-brainana-token': 'BBB', cookie: 'brainana_token=CCC' } }
assert.equal(extractToken(bearerReq), 'AAA', 'Authorization: Bearer wins')
assert.equal(extractToken({ headers: { 'x-brainana-token': 'BBB', cookie: 'brainana_token=CCC' } }), 'BBB', 'X-Brainana-Token beats cookie')
assert.equal(extractToken({ headers: { cookie: 'other=1; brainana_token=CCC; foo=2' } }), 'CCC', 'cookie is parsed among others')
assert.equal(extractToken({ headers: { cookie: 'no_token_here=1' } }), null, 'missing cookie token → null')
assert.equal(extractToken({ headers: { authorization: 'Basic xyz' } }), null, 'non-Bearer Authorization is ignored')
assert.equal(extractToken({ headers: {} }), null, 'no credentials → null')
ok('extractToken honours the documented header precedence')

console.log(`security_test: ${passed} checks passed`)
