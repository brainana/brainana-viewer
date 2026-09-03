// Unit + integration tests for the loopback Host guard (audit finding H2).
//
// The server binds 127.0.0.1, but binding alone does not stop DNS rebinding: an attacker page on
// evil.com whose name re-resolves to 127.0.0.1 reaches this socket, and index.html hands out the
// session token in a <meta> tag to whoever asks. Validating the Host header is what makes the
// loopback bind mean what it looks like it means.
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isLoopbackHost } from '@brainana/core-server/security.mjs'
import { startServer } from '@brainana/core-server/runtime.mjs'
import { generateSessionToken } from '@brainana/core-server/security.mjs'
import { viewerManifestProvider } from '../apps/viewer/server/manifest.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- unit: which Host values name this machine's loopback interface ---
for (const good of ['127.0.0.1', '127.0.0.1:5173', '127.0.0.2:5173', 'localhost', 'localhost:5173', '[::1]', '[::1]:5173', 'LOCALHOST:5173']) {
  assert.equal(isLoopbackHost(good), true, `${good} is loopback`)
}
ok('isLoopbackHost accepts 127/8, localhost and [::1], with or without a port')

for (const bad of ['evil.com', 'evil.com:5173', '192.168.1.5:5173', '10.0.0.1', 'localhost.evil.com:5173', '127.0.0.1.evil.com', '0.0.0.0:5173', '', null, undefined]) {
  assert.equal(isLoopbackHost(bad), false, `${JSON.stringify(bad)} is not loopback`)
}
ok('isLoopbackHost rejects public names, LAN addresses, suffix tricks and a missing header')

// --- integration: a rebound Host reaches neither the token nor the data ---
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-hostguard-'))
await fsp.mkdir(path.join(root, 'sub-x', 'anat'), { recursive: true })
await fsp.writeFile(path.join(root, 'sub-x', 'anat', 'sub-x_space-T1w_desc-preproc_T1w.nii.gz'), 'VOLUME')

const dist = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-hostguard-dist-'))
await fsp.writeFile(path.join(dist, 'index.html'), '<html><head></head><body></body></html>')

const token = generateSessionToken()
const { server, address } = await startServer({
  token,
  distRoot: dist,
  initialSources: [{ type: 'local', path: root, label: 'fixture' }],
  manifestProvider: viewerManifestProvider,
  port: 0,
})

// `fetch` refuses to set Host (a forbidden header name), so the rebinding case has to be spoken
// over raw http — which is what the attacking browser does for us in the real scenario.
function request(pathname, { host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: address.port, path: pathname, method: 'GET', headers: { ...(host ? { Host: host } : {}), ...headers } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// The attack: the browser resolves evil.com to 127.0.0.1 and sends its own name in Host.
const rebound = await request('/', { host: 'evil.com' })
assert.equal(rebound.status, 421, 'a non-loopback Host is refused with 421 Misdirected Request')
assert.ok(!rebound.body.includes(token), 'the session token never reaches a rebound origin')
ok('index.html does not hand the session token to a non-loopback Host')

const reboundApi = await request('/api/runtime', { host: 'evil.com', headers: { Authorization: `Bearer ${token}` } })
assert.equal(reboundApi.status, 421, 'even a correctly-tokened API call is refused off-loopback')
ok('a valid token does not excuse a non-loopback Host')

// Health is unauthenticated, so it is the one route most likely to be left open by accident.
const reboundHealth = await request('/api/health', { host: 'evil.com' })
assert.equal(reboundHealth.status, 421, 'the unauthenticated health route is guarded too')
ok('the unauthenticated health/version routes are behind the Host guard')

// And the real client is unaffected.
const normal = await request('/')
assert.equal(normal.status, 200)
assert.ok(normal.body.includes(token), 'a loopback request still receives the templated token')
ok('a genuine loopback request is served normally')

server.close()
await fsp.rm(root, { recursive: true, force: true })
await fsp.rm(dist, { recursive: true, force: true })

console.log(`\nhost_guard: ${passed} checks passed`)
