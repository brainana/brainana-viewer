// sessionPersistence + browserCapabilities (audit finding X4).
//
// sessionPersistence is where the promise "secrets are NEVER persisted" is either kept or quietly
// broken by a future edit. That promise is a comment today; here it becomes an assertion.
import assert from 'node:assert/strict'

// localStorage must exist before the module under test is imported, since it reads it lazily but
// the accessor is evaluated per call — install it first regardless.
function installStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
  return map
}
const store = installStorage()

const { loadRecent, rememberLocal, rememberRemote, forgetRecent, clearRecent, loadProfiles, rememberProfile, forgetProfile } = await import(
  '../packages/core-client/sessionPersistence.ts'
)
const { hasWebGL2, isChromium, detectCapabilities, isSupported } = await import('../packages/core-client/browserCapabilities.ts')

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- the security promise ------------------------------------------------------------------------
store.clear()
rememberRemote({
  type: 'remote',
  connection: { host: 'lab.example.org', port: 2222, username: 'me', password: 'hunter2', privateKey: 'PRIVATE-KEY-MATERIAL', passphrase: 'p4ss' },
  remoteRoot: '/data/out',
  cacheRoot: '/tmp/cache',
  label: 'lab',
})
const serialised = JSON.stringify([...store.entries()])
for (const secret of ['hunter2', 'PRIVATE-KEY-MATERIAL', 'p4ss']) {
  assert.ok(!serialised.includes(secret), `${secret} must never reach storage`)
}
const [remembered] = loadRecent()
assert.deepEqual(remembered, { type: 'remote', host: 'lab.example.org', port: 2222, username: 'me', remoteRoot: '/data/out', label: 'lab' })
ok('no password, private key or passphrase is ever written to storage')

store.clear()
rememberProfile({ host: 'h', port: 22, username: 'u', password: 'nope', privateKey: 'nope2' })
assert.ok(!JSON.stringify([...store.entries()]).includes('nope'), 'rememberProfile strips anything beyond host/port/user')
assert.deepEqual(loadProfiles(), [{ host: 'h', port: 22, username: 'u' }])
ok('a connection profile keeps only host, port and username')

// --- recents behaviour ---------------------------------------------------------------------------
store.clear()
rememberLocal({ type: 'local', path: '/a', label: 'A' })
rememberLocal({ type: 'local', path: '/b', label: 'B' })
assert.deepEqual(loadRecent().map((r) => r.path), ['/b', '/a'], 'newest first')
rememberLocal({ type: 'local', path: '/a', label: 'A again' })
assert.deepEqual(loadRecent().map((r) => r.path), ['/a', '/b'], 're-adding moves to front rather than duplicating')
assert.equal(loadRecent().length, 2)
ok('recents are newest-first and de-duplicated by identity')

store.clear()
for (let i = 0; i < 15; i++) rememberLocal({ type: 'local', path: `/p${i}` })
assert.equal(loadRecent().length, 10, 'the list is capped')
assert.equal(loadRecent()[0].path, '/p14', 'and keeps the most recent')
ok('the recents list is capped at 10, keeping the newest')

store.clear()
rememberLocal({ type: 'local', path: '/a' })
rememberLocal({ type: 'local', path: '/b' })
forgetRecent({ type: 'local', path: '/a', label: 'a label that should not matter' })
assert.deepEqual(loadRecent().map((r) => r.path), ['/b'], 'matched by identity, ignoring the label')
clearRecent()
assert.deepEqual(loadRecent(), [])
ok('forgetRecent matches on identity and clearRecent empties the list')

store.clear()
rememberProfile({ host: 'h1', username: 'u' })
rememberProfile({ host: 'h2', username: 'u' })
forgetProfile({ host: 'h1', username: 'u' })
assert.deepEqual(loadProfiles().map((p) => p.host), ['h2'])
ok('profiles can be forgotten individually')

// --- storage that misbehaves ----------------------------------------------------------------------
// Safari private mode throws on access; a full quota throws on write. Neither may break the app.
{
  const original = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError') } })
  assert.deepEqual(loadRecent(), [], 'an inaccessible storage reads as empty')
  assert.deepEqual(loadProfiles(), [])
  assert.doesNotThrow(() => rememberLocal({ type: 'local', path: '/x' }), 'and writing is a silent no-op')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: original })
}
ok('storage that throws on access degrades to empty rather than breaking')

{
  const original = globalThis.localStorage
  globalThis.localStorage = { ...original, setItem: () => { throw new Error('QuotaExceededError') } }
  assert.doesNotThrow(() => rememberLocal({ type: 'local', path: '/y' }), 'a full quota is survivable')
  assert.doesNotThrow(() => rememberProfile({ host: 'h', username: 'u' }))
  globalThis.localStorage = original
}
ok('a full or read-only storage never throws out of a remember call')

store.clear()
globalThis.localStorage.setItem('brainana.recentSources.v1', '{"not":"an array"}')
assert.deepEqual(loadRecent(), [], 'a non-array payload is discarded')
globalThis.localStorage.setItem('brainana.recentSources.v1', 'not json at all')
assert.deepEqual(loadRecent(), [], 'unparseable JSON is discarded')
ok('corrupt stored data is discarded rather than thrown on')

// --- browserCapabilities ---------------------------------------------------------------------------
delete globalThis.document
assert.equal(hasWebGL2(), false, 'no document (or no canvas) means no WebGL2')
const report = detectCapabilities()
assert.equal(report.webgl2, false)
assert.equal(isSupported(report), false, 'WebGL2 is the hard requirement')
assert.match(report.messages[0], /WebGL2/, 'and the message says so')
ok('capability detection reports unsupported without WebGL2, with an explanatory message')

{
  // Chromium is the tested baseline but NOT a requirement — isSupported must ignore it.
  // Node defines `navigator` as a getter-only global, so it has to be replaced by descriptor.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', { configurable: true, value })

  setNavigator({ userAgent: 'Mozilla/5.0 Firefox/130.0' })
  assert.equal(isChromium(), false)
  setNavigator({ userAgent: 'Mozilla/5.0 Chrome/120', userAgentData: { brands: [{ brand: 'Google Chrome' }] } })
  assert.equal(isChromium(), true)
  // Opera reports Chrome in its UA but is excluded by the OPR marker.
  setNavigator({ userAgent: 'Mozilla/5.0 Chrome/120 OPR/106' })
  assert.equal(isChromium(), false)
  assert.equal(isSupported({ webgl2: true, chromium: false, messages: [] }), true, 'a non-Chromium browser with WebGL2 is supported')

  if (original) Object.defineProperty(globalThis, 'navigator', original)
}
ok('Chromium detection handles userAgentData, UA fallback and Opera, and is not a requirement')

console.log(`\nclient_persistence: ${passed} checks passed`)
