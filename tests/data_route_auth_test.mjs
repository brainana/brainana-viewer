// Every data route requires the session token — there is no exempt path (audit finding M2).
//
// createServer used to accept a `legacyCompat` flag that exposed an unscoped /brainana-data/<rel>
// route bound to the first source and EXEMPT from the token guard, for a dist/ bundle that no
// longer exists. Nothing in this repo ever produced an unscoped data URL: every fileUrl() emits
// /brainana-data/<sourceId>/<rel>. Carrying an auth-bypass switch for a consumer nobody can name
// is worse than the code it saves, so the flag is gone and this test is what keeps it gone.
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

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-legacy-'))
const anat = path.join(root, 'sub-x', 'anat')
await fsp.mkdir(anat, { recursive: true })
await fsp.writeFile(path.join(anat, 'sub-x_space-T1w_desc-preproc_T1w.nii.gz'), 'SECRET-VOLUME-BYTES')

const token = generateSessionToken()
// legacyCompat is passed deliberately: a stale caller (or an old script) must not be able to
// re-enable an auth bypass by setting an option the server no longer honours.
const { server, address, registry } = await startServer({
  token,
  initialSources: [{ type: 'local', path: root, label: 'fixture' }],
  manifestProvider: viewerManifestProvider,
  legacyCompat: true,
  port: 0,
})
const base = `http://127.0.0.1:${address.port}`
const rel = 'sub-x/anat/sub-x_space-T1w_desc-preproc_T1w.nii.gz'

try {
  const unscoped = await fetch(`${base}/brainana-data/${rel}`)
  assert.equal(unscoped.status, 401, 'an unscoped data path is refused without a token')
  assert.ok(!(await unscoped.text()).includes('SECRET-VOLUME-BYTES'), 'and serves no bytes')
  ok('an unscoped /brainana-data path is token-guarded even with legacyCompat requested')

  // With a token it still must not resolve to file bytes: the route simply does not exist.
  const withToken = await fetch(`${base}/brainana-data/${rel}`, { headers: { Authorization: `Bearer ${token}` } })
  assert.ok(!(await withToken.text()).includes('SECRET-VOLUME-BYTES'), 'no unscoped route serves data even when authenticated')
  ok('the unscoped route resolves to no data at all, token or not')

  // The scoped route is the only way in, and it still works.
  const sourceId = registry.list()[0].id
  const scoped = await fetch(`${base}/brainana-data/${sourceId}/${rel}`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(scoped.status, 200)
  assert.equal(await scoped.text(), 'SECRET-VOLUME-BYTES')
  ok('the source-scoped route still serves data normally')
} finally {
  server.close()
  await fsp.rm(root, { recursive: true, force: true })
}

console.log(`\ndata_route_auth: ${passed} checks passed`)
