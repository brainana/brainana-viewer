// RuntimeClient + SourceManager (audit finding X4).
//
// These are the modules the rest of the frontend trusts for authentication and for knowing which
// datasets exist, and they had no tests at all. They need no DOM beyond a meta tag and no network
// beyond a fetch stub, so the only thing that was ever stopping this was that nobody wrote it.
import assert from 'node:assert/strict'
import { RuntimeClient, sourceBase } from '../packages/core-client/runtimeClient.ts'
import { SourceManager } from '../packages/core-client/sourceManager.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// A fetch stub that records what it was asked to do and replies from a queue.
function stubFetch(replies) {
  const calls = []
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body })
    const reply = replies.shift() ?? { status: 200, body: 'null' }
    return new Response(reply.body, { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }
  return calls
}

// --- sourceBase ---------------------------------------------------------------------------------
assert.equal(sourceBase('local-abc123'), '/api/sources/local-abc123')
// Ids come from the server, but encoding them is what keeps a surprising one from changing the path.
assert.equal(sourceBase('a/b'), '/api/sources/a%2Fb')
ok('sourceBase encodes the source id into the path')

// --- token plumbing -----------------------------------------------------------------------------
{
  const calls = stubFetch([{ status: 200, body: '{"ok":true}' }])
  await new RuntimeClient('tok-123').apiFetch('/api/health')
  assert.equal(calls[0].headers.get('authorization'), 'Bearer tok-123', 'the token rides in Authorization')
  ok('apiFetch attaches the session token as a bearer header')
}
{
  const calls = stubFetch([{ status: 200, body: '{}' }])
  await new RuntimeClient(null).apiFetch('/api/health')
  assert.equal(calls[0].headers.get('authorization'), null, 'no token, no header')
  ok('apiFetch sends no Authorization header when there is no token')
}
{
  // Caller-supplied headers must survive the token being added alongside them.
  const calls = stubFetch([{ status: 200, body: '{}' }])
  await new RuntimeClient('tok').apiFetch('/api/x', { headers: { 'Content-Type': 'application/json' } })
  assert.equal(calls[0].headers.get('content-type'), 'application/json')
  assert.equal(calls[0].headers.get('authorization'), 'Bearer tok')
  ok('caller headers are preserved when the token header is added')
}

// The token is read from the meta tag the server templates into index.html — never from a URL.
{
  globalThis.document = { querySelector: (sel) => (sel === 'meta[name="brainana-token"]' ? { getAttribute: () => 'meta-token' } : null) }
  assert.equal(new RuntimeClient().token, 'meta-token')
  globalThis.document = { querySelector: () => null }
  assert.equal(new RuntimeClient().token, null, 'a missing meta tag yields null, not undefined or a throw')
  delete globalThis.document
  ok('the token is read from the brainana-token meta tag, and absence is handled')
}

// --- apiJson error handling ---------------------------------------------------------------------
{
  stubFetch([{ status: 400, body: '{"error":"No sub-* subjects here."}' }])
  await assert.rejects(() => new RuntimeClient('t').apiJson('/api/sources'), /No sub-\* subjects here\./)
  ok("apiJson throws with the server's own error message")
}
{
  // A proxy error or SPA fallback returns HTML; that must not surface as a raw SyntaxError.
  stubFetch([{ status: 502, body: '<html>Bad Gateway</html>' }])
  await assert.rejects(() => new RuntimeClient('t').apiJson('/api/sources'), /Request failed \(502\)/)
  ok('a non-JSON error body becomes "Request failed (status)", not a JSON parse error')
}
{
  stubFetch([{ status: 200, body: '' }])
  assert.equal(await new RuntimeClient('t').apiJson('/api/x'), null, 'an empty 200 body is null')
  ok('an empty successful body parses to null rather than throwing')
}

// --- dataUrl ------------------------------------------------------------------------------------
{
  const client = new RuntimeClient('tok')
  const url = '/brainana-data/local-abc/sub-x/anat/t1.nii.gz'
  assert.equal(client.dataUrl(url), url, 'returned unchanged — no ?token= appended')
  ok('dataUrl does not append the token to a URL NiiVue will fetch')
}

// --- SourceManager ------------------------------------------------------------------------------
const summary = (id, over = {}) => ({ id, type: 'local', label: id, customLabel: null, root: `/data/${id}`, ...over })

{
  stubFetch([{ status: 200, body: JSON.stringify([summary('local-1'), summary('local-2')]) }])
  const mgr = new SourceManager(new RuntimeClient('t'))
  const seen = []
  const unsubscribe = mgr.subscribe((s) => seen.push(s.map((x) => x.id)))
  assert.deepEqual(seen, [[]], 'a new subscriber is called immediately with the current state')
  await mgr.refresh()
  assert.deepEqual(seen.at(-1), ['local-1', 'local-2'])
  assert.deepEqual(mgr.list().map((s) => s.id), ['local-1', 'local-2'])
  unsubscribe()
  await mgr.refresh()
  assert.equal(seen.length, 2, 'an unsubscribed listener stops hearing about changes')
  ok('SourceManager notifies on subscribe and on refresh, and unsubscribe works')
}

{
  const calls = stubFetch([{ status: 200, body: JSON.stringify(summary('local-new')) }])
  const mgr = new SourceManager(new RuntimeClient('t'))
  const added = await mgr.add({ type: 'local', path: '/data/new' })
  assert.equal(added.id, 'local-new')
  assert.deepEqual(mgr.list().map((s) => s.id), ['local-new'], 'the POST response is appended directly')
  assert.equal(calls.length, 1, 'no second GET is fired to re-list what the POST already returned')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { type: 'local', path: '/data/new' })
  ok('add posts the spec and appends the response without a re-list round-trip')
}

{
  stubFetch([
    { status: 200, body: JSON.stringify([summary('a'), summary('b')]) },
    { status: 200, body: JSON.stringify(summary('a', { customLabel: 'My data' })) },
  ])
  const mgr = new SourceManager(new RuntimeClient('t'))
  await mgr.refresh()
  await mgr.setLabel('a', 'My data')
  assert.equal(mgr.list().find((s) => s.id === 'a').customLabel, 'My data')
  assert.equal(mgr.list().length, 2, 'the other source is untouched')
  ok('setLabel replaces only the renamed source in the cache')
}

{
  // A failed removal must NOT drop the source locally — that would show a lie in the UI.
  stubFetch([
    { status: 200, body: JSON.stringify([summary('a')]) },
    { status: 404, body: '{"error":"Source not found"}' },
  ])
  const mgr = new SourceManager(new RuntimeClient('t'))
  await mgr.refresh()
  await assert.rejects(() => mgr.remove('a'), /Source not found/)
  assert.deepEqual(mgr.list().map((s) => s.id), ['a'], 'the source stays in the list when the server refuses')
  ok('a refused removal leaves the local registry unchanged')
}

{
  stubFetch([
    { status: 200, body: JSON.stringify([summary('a'), summary('b')]) },
    { status: 200, body: '{"id":"a"}' },
  ])
  const mgr = new SourceManager(new RuntimeClient('t'))
  await mgr.refresh()
  await mgr.remove('a')
  assert.deepEqual(mgr.list().map((s) => s.id), ['b'])
  ok('a successful removal drops the source and keeps the rest')
}

console.log(`\nclient_runtime: ${passed} checks passed`)
