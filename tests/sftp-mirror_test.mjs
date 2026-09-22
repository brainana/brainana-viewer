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
// sub-r3 is a SESSION-keyed recon tree and sub-r4 a longitudinal one -- see their blocks below.
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

// --- sub-r3: session-layout anat with a SESSION-KEYED recon tree -----------------------------
// Before view targets, the mirror hardcoded `fastsurfer/<subjectId>`, found nothing, and returned
// early -- so a remote subject processed at synthesis_level "session" had no surfaces at all.
// This is that regression, and it fails against the old materialiser.
//
// --- sub-r4: the longitudinal shape ----------------------------------------------------------
// Five recon trees exist; only the two a target actually needs may be mirrored. Fetching all of
// them would be a serious regression on the slow links this source exists for.
const SURF_NAMES = ['lh.pial', 'rh.pial', 'lh.white', 'rh.white', 'lh.curv', 'rh.curv', 'lh.thickness', 'rh.thickness']
function morphometry(vertexCount) {
  const b = Buffer.alloc(15 + vertexCount * 4)
  b[0] = 0xff; b[1] = 0xff; b[2] = 0xff
  b.writeInt32BE(vertexCount, 3); b.writeInt32BE(1, 7); b.writeInt32BE(1, 11)
  return b
}
async function remoteRecon(name, vertexCount) {
  const surf = path.join(remoteRoot, 'fastsurfer', name, 'surf')
  await fsp.mkdir(surf, { recursive: true })
  for (const n of SURF_NAMES) {
    await fsp.writeFile(path.join(surf, n), /\.(curv|thickness)$/.test(n) ? morphometry(vertexCount) : Buffer.from(`SURFACE-${n}`))
  }
  // Noise directories a real recon carries; the mirror must not walk them.
  for (const noise of ['tmp', 'trash']) {
    await fsp.mkdir(path.join(remoteRoot, 'fastsurfer', name, noise), { recursive: true })
    await fsp.writeFile(path.join(remoteRoot, 'fastsurfer', name, noise, 'junk.dat'), 'JUNK')
  }
}
{
  const anat = path.join(remoteRoot, 'sub-r3', 'ses-001', 'anat')
  await fsp.mkdir(anat, { recursive: true })
  await fsp.writeFile(path.join(anat, 'sub-r3_ses-001_space-T1w_desc-preproc_T1w.nii.gz'), T1W)
  const anat2 = path.join(remoteRoot, 'sub-r3', 'ses-002', 'anat')
  await fsp.mkdir(anat2, { recursive: true })
  await fsp.writeFile(path.join(anat2, 'sub-r3_ses-002_space-T1w_desc-preproc_T1w.nii.gz'), T1W)
  await remoteRecon('sub-r3_ses-001', 6)
  await remoteRecon('sub-r3_ses-002', 6)
}
{
  const flat = path.join(remoteRoot, 'sub-r4', 'anat')
  await fsp.mkdir(flat, { recursive: true })
  await fsp.writeFile(path.join(flat, 'sub-r4_space-base_desc-brain_T1w.nii.gz'), T1W)
  for (const ses of ['ses-001', 'ses-002']) {
    const anat = path.join(remoteRoot, 'sub-r4', ses, 'anat')
    await fsp.mkdir(anat, { recursive: true })
    await fsp.writeFile(path.join(anat, `sub-r4_${ses}_space-T1w_desc-preproc_T1w.nii.gz`), T1W)
    await remoteRecon(`sub-r4_${ses}`, 6)
    await remoteRecon(`sub-r4_${ses}_long`, 5)
  }
  await remoteRecon('sub-r4_base', 5)
  // The change maps live only in the base recon, and the server parses them, so they must be
  // materialised as real bytes rather than sparse placeholders.
  const baseSurf = path.join(remoteRoot, 'fastsurfer', 'sub-r4_base', 'surf')
  const map = Buffer.alloc(284 + 5 * 4)
  map.writeInt32BE(1, 0); map.writeInt32BE(5, 4); map.writeInt32BE(1, 8)
  map.writeInt32BE(1, 12); map.writeInt32BE(1, 16); map.writeInt32BE(3, 20)
  ;[0.1, -0.2, 0.3, 0, 0.5].forEach((v, i) => map.writeFloatBE(v, 284 + i * 4))
  for (const hemi of ['lh', 'rh']) await fsp.writeFile(path.join(baseSurf, `${hemi}.long.thickness-rate.mgh`), map)
  const stats = path.join(remoteRoot, 'fastsurfer', 'sub-r4_base', 'stats')
  await fsp.mkdir(stats, { recursive: true })
  await fsp.writeFile(path.join(stats, 'long.change-stats.json'), JSON.stringify({ time_source: 'session label', timepoints: ['sub-r4_ses-001_long', 'sub-r4_ses-002_long'] }))
  for (const hemi of ['lh', 'rh']) await fsp.writeFile(path.join(stats, `${hemi}.long.roi-rates.csv`), 'roi,measure,slope,mean,spc,n_timepoints\nV1,ThickAvg,0.1,2,1,2\n')
}

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

  // --- a SESSION-keyed recon tree must be found ---
  const m3 = await source.buildManifest('sub-r3')
  assert.ok(m3.surfaces.pial, 'a remote session-layout subject has surfaces')
  assert.match(m3.surfaces.pial.left, /fastsurfer\/sub-r3_ses-001\/surf\/lh\.pial/)
  assert.deepEqual(m3.scans.map((x) => x.id), ['sub-r3_ses-001', 'sub-r3_ses-002'], 'both sessions are offered')
  ok('a remote SESSION-keyed reconstruction is mirrored and reaches the manifest')

  // Selecting the second session must mirror ITS recon, not the first's.
  const m3b = await source.buildManifest('sub-r3', { target: 'sub-r3_ses-002' })
  assert.match(m3b.surfaces.pial.left, /fastsurfer\/sub-r3_ses-002\/surf\/lh\.pial/)
  assert.equal(m3b.scan.id, 'sub-r3_ses-002')
  ok('a remote scan selection mirrors that reconstruction')

  // --- longitudinal: only the needed recons are fetched ---
  const m4 = await source.buildManifest('sub-r4', { target: 'sub-r4_base' })
  assert.equal(m4.scan.stream, 'base')
  assert.equal(m4.longitudinal.timeSource, 'session label', 'the change-stats sidecar is read through the mirror')
  assert.equal(m4.longitudinal.changeMaps.length, 1, 'the .mgh change map was materialised and converted')
  assert.ok(m4.longitudinal.roiRates.left, 'the ROI table is offered by URL')
  ok('a remote longitudinal base scan exposes its change maps')

  // The ROI CSV is handed over as a URL, so it must stay a placeholder until something asks for it.
  const roiMirror = path.join(cacheRoot, 'mirror', 'fastsurfer', 'sub-r4_base', 'stats', 'lh.long.roi-rates.csv')
  assert.equal(fs.statSync(roiMirror).size > 0, true, 'the ROI table placeholder is sized')
  // ...while the change map itself had to be read by the server, so it is real bytes.
  const mapMirror = path.join(cacheRoot, 'mirror', 'fastsurfer', 'sub-r4_base', 'surf', 'lh.long.thickness-rate.mgh')
  assert.equal(fs.readFileSync(mapMirror).readInt32BE(0), 1, 'the change map was fetched for real, not left sparse')
  ok('files the server parses are fetched; files it only hands out as URLs are not')

  // Economy: a base target needs the base recon only. The four per-session trees must NOT have
  // been walked into -- mirroring all five would defeat the point of a sparse mirror.
  const surfaced = (name) => fs.existsSync(path.join(cacheRoot, 'mirror', 'fastsurfer', name, 'surf', 'lh.pial'))
  assert.equal(surfaced('sub-r4_base'), true)
  assert.equal(surfaced('sub-r4_ses-001'), false, 'an unselected cross-sectional recon is not mirrored')
  assert.equal(surfaced('sub-r4_ses-001_long'), false, 'an unselected longitudinal recon is not mirrored')
  ok('only the reconstructions the selected scan needs are mirrored')

  // A long target needs its own recon AND the base (the change maps live there).
  await source.buildManifest('sub-r4', { target: 'sub-r4_ses-001_long' })
  assert.equal(surfaced('sub-r4_ses-001_long'), true, 'the selected long recon is mirrored')
  assert.equal(fs.existsSync(path.join(cacheRoot, 'mirror', 'fastsurfer', 'sub-r4_base', 'tmp', 'junk.dat')), false,
    'recon noise directories are never walked')
  ok('a long scan mirrors its own recon, and noise directories are skipped')
} finally {
  await source.close()
  for (const client of clients) client.end()
  await new Promise((resolve) => server.close(resolve))
  for (const dir of [remoteRoot, cacheRoot, khDir]) await fsp.rm(dir, { recursive: true, force: true })
}

console.log(`\nsftp-mirror_test: ${passed} checks passed`)
