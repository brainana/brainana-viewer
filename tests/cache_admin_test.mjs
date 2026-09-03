// Cache size reporting and reclaim (audit finding M6).
//
// The remote-file cache had no eviction, no size reporting and no way to empty it — it simply grew,
// invisibly, in a per-OS directory, while the files it holds are whole neuroimaging volumes. That
// matters most on a shared box with a per-user quota.
//
// Full LRU eviction is deliberately NOT built here. What is built is the escape hatch: see how big
// it is, and reclaim it. Reclaiming removes only the fetched file BYTES (`files/`), never the
// mirror — the mirror carries the placeholder tree and the materialised surface binaries that
// buildManifest depends on, and openFile re-fetches any bytes it needs. So clearing costs time on
// the next read, never correctness.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cacheUsage, reclaimCachedFiles } from '@brainana/core-server/cache.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-cacheadmin-'))
const src = path.join(root, 'remote', 'abc123')
await fsp.mkdir(path.join(src, 'files', 'deadbeef'), { recursive: true })
await fsp.mkdir(path.join(src, 'mirror', 'sub-r1', 'anat'), { recursive: true })
await fsp.writeFile(path.join(src, 'files', 'deadbeef', 'vol.nii.gz'), Buffer.alloc(4096, 1))
await fsp.writeFile(path.join(src, 'files', 'deadbeef', 'vol.nii.gz.brainana-meta.json'), '{"size":4096}')
await fsp.writeFile(path.join(src, 'mirror', 'sub-r1', 'anat', 'surface.gii'), Buffer.alloc(1024, 2))
await fsp.writeFile(path.join(src, 'mirror', '.brainana-placeholders.json'), '["sub-r1/anat/x.nii.gz"]')

const usage = await cacheUsage(root)
assert.equal(usage.path, root)
assert.ok(usage.bytes >= 4096 + 1024, 'total counts both files/ and mirror/')
assert.ok(usage.reclaimableBytes >= 4096, 'reclaimable counts the fetched bytes')
assert.ok(usage.reclaimableBytes < usage.bytes, 'the mirror is NOT counted as reclaimable')
ok('cacheUsage reports total and reclaimable sizes separately')

const freed = await reclaimCachedFiles(root)
assert.ok(freed.bytes >= 4096, 'it reports what it freed')
assert.equal(fs.existsSync(path.join(src, 'files')), false, 'the fetched bytes are gone')
ok('reclaimCachedFiles deletes the fetched file bytes')

assert.equal(fs.existsSync(path.join(src, 'mirror', 'sub-r1', 'anat', 'surface.gii')), true, 'materialised surfaces survive')
assert.equal(fs.existsSync(path.join(src, 'mirror', '.brainana-placeholders.json')), true, 'the placeholder registry survives')
ok('the mirror and its placeholder registry are left intact')

const after = await cacheUsage(root)
assert.equal(after.reclaimableBytes, 0)
ok('nothing is reclaimable immediately afterwards')

// A cache directory that does not exist yet is not an error — it just has not been created.
const missing = await cacheUsage(path.join(root, 'nope'))
assert.deepEqual({ bytes: missing.bytes, reclaimableBytes: missing.reclaimableBytes }, { bytes: 0, reclaimableBytes: 0 })
assert.deepEqual((await reclaimCachedFiles(path.join(root, 'nope'))).bytes, 0)
ok('an absent cache directory reports zero rather than throwing')

// --- the routes that expose all this ----------------------------------------------------------
// The functions above are unit-tested; these two assertions cover the WIRING, which is where a
// mistake actually happened (GET and DELETE return shapes that both carry a `bytes` field, and
// spreading them together silently lost the freed figure).
const { startServer } = await import('@brainana/core-server/runtime.mjs')
const { generateSessionToken } = await import('@brainana/core-server/security.mjs')
const { viewerManifestProvider } = await import('../apps/viewer/server/manifest.mjs')

const apiCacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-cacheapi-'))
await fsp.mkdir(path.join(apiCacheRoot, 'remote', 'xyz', 'files', 'aa'), { recursive: true })
await fsp.writeFile(path.join(apiCacheRoot, 'remote', 'xyz', 'files', 'aa', 'v.nii.gz'), Buffer.alloc(2048, 7))

const apiToken = generateSessionToken()
const { server, address } = await startServer({ token: apiToken, cacheRoot: apiCacheRoot, manifestProvider: viewerManifestProvider, port: 0 })
const apiBase = `http://127.0.0.1:${address.port}`
const apiAuth = { Authorization: `Bearer ${apiToken}` }
try {
  const got = await (await fetch(`${apiBase}/api/cache`, { headers: apiAuth })).json()
  assert.equal(got.path, apiCacheRoot)
  assert.ok(got.reclaimableBytes >= 2048)
  ok('GET /api/cache reports the usage')

  const cleared = await (await fetch(`${apiBase}/api/cache`, { method: 'DELETE', headers: apiAuth })).json()
  assert.ok(cleared.freedBytes >= 2048, 'the freed figure survives alongside the new total')
  assert.equal(cleared.reclaimableBytes, 0, 'and the refreshed usage is reported with it')
  ok('DELETE /api/cache frees the bytes and reports both figures')

  assert.equal((await fetch(`${apiBase}/api/cache`)).status, 401, 'the cache routes are token-guarded')
  ok('the cache routes require the session token')
} finally {
  server.close()
  await fsp.rm(apiCacheRoot, { recursive: true, force: true })
}

await fsp.rm(root, { recursive: true, force: true })
console.log(`\ncache_admin: ${passed} checks passed`)
