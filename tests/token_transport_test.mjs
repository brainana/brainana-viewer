// How secrets travel over the API (audit findings M8 and N1).
//
// security.mjs states the rule plainly: a token must never ride in a URL, because that lands it in
// server logs, the Referer header and browser history. Two things did not hold up to it.
//
// N1 — security_test asserted "?token= query param is rejected" by calling guard(req, url). But
//      createTokenGuard returns a ONE-parameter (req) => function; the URL was silently discarded,
//      so the assertion only re-tested "no headers ⇒ reject" and would have passed no matter what
//      the query-param policy was. The property is real and worth keeping, so it is asserted here
//      against the actual server instead.
// M8 — the remote-browse token DID ride in the query string, breaking the same rule it states.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '@brainana/core-server/runtime.mjs'
import { generateSessionToken } from '@brainana/core-server/security.mjs'
import { viewerManifestProvider } from '../apps/viewer/server/manifest.mjs'
import { hasSsh2, startFakeSftpServer } from './fixtures/fakeSftpServer.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-tokentransport-'))
await fsp.mkdir(path.join(root, 'sub-x', 'anat'), { recursive: true })
await fsp.writeFile(path.join(root, 'sub-x', 'anat', 'sub-x_space-T1w_desc-preproc_T1w.nii.gz'), 'DATA')

const token = generateSessionToken()
const { server, address } = await startServer({
  token,
  initialSources: [{ type: 'local', path: root, label: 'fixture' }],
  manifestProvider: viewerManifestProvider,
  port: 0,
})
const base = `http://127.0.0.1:${address.port}`

try {
  // --- N1: the session token must not authenticate from the query string --------------------
  const viaQuery = await fetch(`${base}/api/runtime?token=${encodeURIComponent(token)}`)
  assert.equal(viaQuery.status, 401, 'a VALID token in ?token= does not authenticate')
  ok('the session token is refused when presented only in the query string')

  const viaHeader = await fetch(`${base}/api/runtime`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(viaHeader.status, 200, 'the same token in a header does authenticate')
  ok('the same token in a header is accepted (the query rejection is not a blanket failure)')

  // --- M8: the remote-browse token must travel in a header too -------------------------------
  if (!hasSsh2) {
    console.log('  skip - ssh2 not installed; remote-browse transport not exercised')
  } else {
    const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-tokentransport-remote-'))
    await fsp.mkdir(path.join(remoteRoot, 'somedir'), { recursive: true })
    const fake = await startFakeSftpServer(remoteRoot)
    const khDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-tokentransport-kh-'))
    const knownHostsPath = path.join(khDir, 'known_hosts')
    await fsp.writeFile(knownHostsPath, `[127.0.0.1]:${fake.port} ${fake.hostKey.type} ${fake.hostKey.base64}\n`)

    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const connectRes = await fetch(`${base}/api/remote/connect`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ connection: { host: '127.0.0.1', port: fake.port, username: 'test', password: 'test', knownHostsPath } }),
    })
    assert.equal(connectRes.status, 200, 'the fake remote connects')
    const { token: browseToken } = await connectRes.json()
    assert.ok(browseToken, 'a browse token is issued')

    // The header is the supported transport.
    const byHeader = await fetch(`${base}/api/remote/browse?path=${encodeURIComponent(remoteRoot)}`, {
      headers: { ...auth, 'X-Brainana-Remote-Token': browseToken },
    })
    assert.equal(byHeader.status, 200, 'browsing works with the token in a header')
    assert.ok((await byHeader.json()).entries.some((e) => e.name === 'somedir'))
    ok('the remote-browse token is accepted from a header')

    // The query string is not, even with a valid token.
    const byQuery = await fetch(`${base}/api/remote/browse?token=${encodeURIComponent(browseToken)}&path=${encodeURIComponent(remoteRoot)}`, { headers: auth })
    assert.equal(byQuery.status, 404, 'a browse token in the query string does not authenticate')
    ok('the remote-browse token is refused from the query string')

    await fetch(`${base}/api/remote/disconnect`, { method: 'POST', headers: { ...auth, 'X-Brainana-Remote-Token': browseToken }, body: '{}' })
    for (const c of fake.clients) c.end()
    await new Promise((r) => fake.server.close(r))
    await fsp.rm(remoteRoot, { recursive: true, force: true })
    await fsp.rm(khDir, { recursive: true, force: true })
  }
} finally {
  server.close()
  await fsp.rm(root, { recursive: true, force: true })
}

console.log(`\ntoken_transport: ${passed} checks passed`)
