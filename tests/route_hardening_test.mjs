// Small server-route defects found in the audit: L4 (unbounded request body) and L7 (DELETE
// matching scoped sub-paths).
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '@brainana/core-server/runtime.mjs'
import { generateSessionToken } from '@brainana/core-server/security.mjs'
import { viewerManifestProvider } from '../apps/viewer/server/manifest.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-routes-'))
await fsp.mkdir(path.join(root, 'sub-x', 'anat'), { recursive: true })
await fsp.writeFile(path.join(root, 'sub-x', 'anat', 'sub-x_space-T1w_desc-preproc_T1w.nii.gz'), 'DATA')

const token = generateSessionToken()
const { server, address, registry } = await startServer({
  token,
  initialSources: [{ type: 'local', path: root, label: 'fixture' }],
  manifestProvider: viewerManifestProvider,
  port: 0,
})
const base = `http://127.0.0.1:${address.port}`
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

try {
  // --- L4: a JSON body was buffered with no size limit ---------------------------------------
  const huge = JSON.stringify({ type: 'local', path: 'x'.repeat(3 * 1024 * 1024) })
  const res = await fetch(`${base}/api/sources`, { method: 'POST', headers: auth, body: huge })
  assert.equal(res.status, 413, 'an oversized JSON body is refused with 413')
  const body = await res.json()
  assert.match(body.error, /too large/i)
  ok('an oversized request body is rejected rather than buffered whole')

  // A normal body is unaffected.
  const small = await fetch(`${base}/api/sources`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'local', path: '/definitely/not/here' }) })
  assert.equal(small.status, 400, 'a normal body still reaches the handler (and fails on its merits)')
  ok('an ordinary request body is unaffected')

  // --- L7: DELETE matched any /api/sources/* path, including scoped actions -------------------
  const id = registry.list()[0].id
  const before = registry.list().length
  const bad = await fetch(`${base}/api/sources/${id}/monkeys`, { method: 'DELETE', headers: auth })
  assert.equal(bad.status, 405, 'DELETE on a scoped action is Method Not Allowed, not a source lookup')
  assert.equal(registry.list().length, before, 'and removes nothing')
  ok('DELETE on a scoped sub-path is a method error, not a mis-parsed source id')

  // The real DELETE still works.
  const good = await fetch(`${base}/api/sources/${id}`, { method: 'DELETE', headers: auth })
  assert.equal(good.status, 200)
  assert.equal(registry.list().length, before - 1, 'the source is gone')
  ok('DELETE on a bare source id still removes it')
} finally {
  server.close()
  await fsp.rm(root, { recursive: true, force: true })
}

console.log(`\nroute_hardening: ${passed} checks passed`)
