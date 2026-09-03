// ServerExport, buildZip and FilesystemClient request shapes (audit finding X4).
import assert from 'node:assert/strict'
import { unzipSync } from 'fflate'
import { RuntimeClient } from '../packages/core-client/runtimeClient.ts'
import { ServerExport, buildZip } from '../packages/core-client/exportDestination.ts'
import { FilesystemClient } from '../packages/core-client/filesystemClient.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

function stubFetch(replies) {
  const calls = []
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body })
    const reply = replies.shift() ?? { status: 200, body: '{}' }
    return new Response(reply.body, { status: reply.status })
  }
  return calls
}

const client = new RuntimeClient('tok')

// --- ServerExport.saveFile ------------------------------------------------------------------------
{
  const calls = stubFetch([{ status: 200, body: '{"path":"out/report.html","bytes":42}' }])
  const result = await new ServerExport(client).saveFile('local-1', 'out/report.html', 'hello')
  assert.deepEqual(result, { path: 'out/report.html', bytes: 42 })
  assert.match(calls[0].path, /^\/api\/sources\/local-1\/save-file\?path=out%2Freport\.html&overwrite=0$/)
  assert.equal(calls[0].method, 'POST')
  ok('saveFile posts to the source-scoped route with the path encoded and overwrite off')
}
{
  const calls = stubFetch([{ status: 200, body: '{"path":"x","bytes":1}' }])
  await new ServerExport(client).saveFile('local-1', 'x', 'data', true)
  assert.match(calls[0].path, /overwrite=1$/)
  ok('overwrite=true is passed through as overwrite=1')
}
{
  // 409 is not an error: it is how the server says "already there, ask the user".
  stubFetch([{ status: 409, body: '{"error":"File already exists","path":"out/report.html"}' }])
  const result = await new ServerExport(client).saveFile('local-1', 'out/report.html', 'x')
  assert.deepEqual(result, { path: 'out/report.html', exists: true })
  ok('a 409 returns exists:true rather than throwing')
}
{
  // A 5xx often carries an HTML error page; res.json() would throw a raw SyntaxError.
  stubFetch([{ status: 500, body: '<html>Internal Server Error</html>' }])
  await assert.rejects(() => new ServerExport(client).saveFile('local-1', 'x', 'y'), /Save failed \(500\)/)
  ok('a non-JSON error body yields "Save failed (status)", not a JSON parse error')
}
{
  stubFetch([{ status: 400, body: '{"error":"A filename is required"}' }])
  await assert.rejects(() => new ServerExport(client).saveFile('local-1', '', 'y'), /A filename is required/)
  ok("a JSON error body surfaces the server's own message")
}
{
  stubFetch([{ status: 409, body: '' }])
  const result = await new ServerExport(client).saveFile('local-1', 'fallback.txt', 'x')
  assert.deepEqual(result, { path: 'fallback.txt', exists: true }, 'falls back to the requested path')
  ok('a 409 with an empty body still reports the path it was asked to write')
}

// --- buildZip ---------------------------------------------------------------------------------------
{
  const blob = buildZip({ 'a.txt': new TextEncoder().encode('alpha'), 'nested/b.txt': new TextEncoder().encode('beta') })
  assert.equal(blob.type, 'application/zip')
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  assert.deepEqual(Object.keys(entries).sort(), ['a.txt', 'nested/b.txt'])
  assert.equal(new TextDecoder().decode(entries['a.txt']), 'alpha')
  assert.equal(new TextDecoder().decode(entries['nested/b.txt']), 'beta')
  ok('buildZip produces a real zip whose entries round-trip, nested paths included')
}

// --- FilesystemClient request shapes ------------------------------------------------------------------
{
  const files = new FilesystemClient(client)
  const calls = stubFetch([
    { status: 200, body: '[]' },
    { status: 200, body: '{}' },
    { status: 200, body: '{}' },
    { status: 200, body: '{}' },
  ])
  await files.listMonkeys('local-1')
  await files.getManifest('local-1', 'sub-x')
  await files.listImportFiles('local-1', 'a b/c', 'q&q')
  await files.browseFs('/abs path')
  assert.equal(calls[0].path, '/api/sources/local-1/monkeys')
  assert.equal(calls[1].path, '/api/sources/local-1/manifest/sub-x')
  // Every user-supplied value is encoded, so a space or & cannot restructure the query.
  assert.equal(calls[2].path, '/api/sources/local-1/import-files?path=a%20b%2Fc&q=q%26q')
  assert.equal(calls[3].path, '/api/fs/browse?path=%2Fabs%20path')
  ok('FilesystemClient encodes every user-supplied path and query value')
}
{
  // The remote-browse token is a header, never a query parameter (audit M8).
  const files = new FilesystemClient(client)
  const calls = stubFetch([{ status: 200, body: '{}' }, { status: 200, body: '{}' }])
  await files.browseRemote('browse-tok-1', '/remote/dir')
  assert.equal(calls[0].headers.get('x-brainana-remote-token'), 'browse-tok-1')
  assert.ok(!calls[0].path.includes('browse-tok-1'), 'the token does not appear in the URL')
  await files.disconnectRemote('browse-tok-1')
  assert.equal(calls[1].headers.get('x-brainana-remote-token'), 'browse-tok-1')
  assert.ok(!calls[1].path.includes('browse-tok-1'))
  ok('the remote-browse token travels in a header on both browse and disconnect')
}
{
  const files = new FilesystemClient(client)
  const calls = stubFetch([{ status: 200, body: '{"path":"/c","bytes":10,"reclaimableBytes":4}' }, { status: 200, body: '{"freedBytes":4,"path":"/c","bytes":6,"reclaimableBytes":0}' }])
  assert.equal((await files.cacheUsage()).reclaimableBytes, 4)
  assert.equal((await files.reclaimCache()).freedBytes, 4)
  assert.equal(calls[1].method, 'DELETE')
  ok('the cache endpoints are reached with the right methods and shapes')
}

console.log(`\nclient_export: ${passed} checks passed`)
