// SFTP mirror fidelity (audit findings M3 and M5).
//
// SftpDataSource materialises a subject as PLACEHOLDER files so the injected manifest provider can
// glob the mirror as if it were a local dataset. Two properties that placeholder has to have, and
// did not:
//
//   M3 — it must carry the remote file's SIZE. The provider rejects zero-byte files as brainana's
//        `.dummy` sentinels (see local-source_test), so 0-byte placeholders made every size-checked
//        output — starting with the full-FOV conform — silently invisible on every remote source.
//   M5 — the placeholder registry must survive a restart. It lived only in RAM while the files it
//        described persisted in the on-disk cache, so a later session saw them as real files and
//        served empty bytes as data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hasSsh2, startFakeSftpServer } from './fixtures/fakeSftpServer.mjs'

if (!hasSsh2) {
  console.log('  skip - ssh2 not installed (run `npm install`)')
  console.log('sftp-mirror_test: skipped')
  process.exit(0)
}

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const { SftpDataSource } = await import('@brainana/core-server/sftpSource.mjs')
const { viewerManifestProvider } = await import('../apps/viewer/server/manifest.mjs')

const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-mirror-remote-'))
const cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-mirror-cache-'))

// sub-r1 has a REAL full-FOV conform; sub-r2 has a zero-byte sentinel in its place.
const T1W = 'THIS-IS-THE-PREPROC-T1W-VOLUME'
const FULLFOV = 'THIS-IS-THE-UNCROPPED-CONFORM-FULL-FOV-VOLUME'
for (const sub of ['sub-r1', 'sub-r2']) {
  const anat = path.join(remoteRoot, sub, 'anat')
  await fsp.mkdir(anat, { recursive: true })
  await fsp.writeFile(path.join(anat, `${sub}_space-T1w_desc-preproc_T1w.nii.gz`), T1W)
  await fsp.writeFile(path.join(anat, `${sub}_space-T1w_desc-conformFullFOV_T1w.nii.gz`), sub === 'sub-r1' ? FULLFOV : '')
}
await fsp.writeFile(
  path.join(remoteRoot, 'sub-r1', 'anat', 'sub-r1_space-T1w_desc-conformFullFOV_T1w.json'),
  JSON.stringify({ FullFOVPadding: { status: 'expanded' } }),
)

const { server, port, clients, hostKey } = await startFakeSftpServer(remoteRoot)
const khDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-mirror-kh-'))
const knownHostsPath = path.join(khDir, 'known_hosts')
await fsp.writeFile(knownHostsPath, `[127.0.0.1]:${port} ${hostKey.type} ${hostKey.base64}\n`)

const newSource = () =>
  new SftpDataSource({
    id: 'remote-bbbbbbbbbbbb',
    connection: { host: '127.0.0.1', port, username: 'test', password: 'test', knownHostsPath },
    remoteRoot,
    cacheRoot,
    manifest: viewerManifestProvider,
  })

let source = newSource()
try {
  await source.open()

  // --- M3: the full-FOV volume must be visible over SFTP exactly as it is locally ---
  const m1 = await source.buildManifest('sub-r1')
  assert.ok(m1.fullFov, 'a remote subject with a real full-FOV conform offers it')
  assert.match(m1.fullFov.url, /desc-conformFullFOV_T1w\.nii\.gz$/)
  assert.equal(m1.fullFov.status, 'expanded', 'the sidecar status is read through the mirror')
  ok('a remote full-FOV conform reaches the manifest')

  // ...and the sentinel must still be rejected, or the guard has just been deleted rather than fixed.
  const m2 = await source.buildManifest('sub-r2')
  assert.equal(m2.fullFov, null, 'a zero-byte sentinel is still not offered, remote or local')
  ok('a remote zero-byte sentinel is still rejected')

  // The placeholder is sparse: right length, no bytes actually transferred.
  const mirrorFile = path.join(cacheRoot, 'mirror', 'sub-r1', 'anat', 'sub-r1_space-T1w_desc-conformFullFOV_T1w.nii.gz')
  assert.equal(fs.statSync(mirrorFile).size, FULLFOV.length, 'the placeholder carries the remote size')
  ok('placeholders are sized from the remote listing')

  // --- M5: a restart must not turn placeholders into "real" empty files ---
  await source.close()
  source = newSource()
  await source.open()
  // No buildManifest first — this is the ordering that used to serve empty bytes.
  const opened = await source.openFile('sub-r1/anat/sub-r1_space-T1w_desc-conformFullFOV_T1w.nii.gz')
  const chunks = []
  for await (const c of opened.stream) chunks.push(c)
  assert.equal(Buffer.concat(chunks).toString('utf8'), FULLFOV, 'the real remote bytes are served, not the sparse placeholder')
  ok('placeholders are still recognised after a restart, so real bytes are fetched')
} finally {
  await source.close()
  for (const client of clients) client.end()
  await new Promise((resolve) => server.close(resolve))
  for (const dir of [remoteRoot, cacheRoot, khDir]) await fsp.rm(dir, { recursive: true, force: true })
}

console.log(`\nsftp-mirror_test: ${passed} checks passed`)
