// View-target enumeration: which reconstructions a subject offers, and which directories each one
// pairs together.
//
// brainana v3.0.0's `anat.synthesis_level` produces three tree shapes, and a real dataset can mix
// them (a subject whose raw data had no sessions keeps a flat layout beside one that did). Every
// fixture below is a shape observed in real pipeline output, named for the case it pins.
//
// The fixtures give the base/long recons 5 vertices and the cross-sectional ones 6, because that
// asymmetry is the whole reason the pairing rules exist: a subject's base and cross-sectional
// meshes genuinely differ in vertex count, so an overlay taken from the wrong one is an array of
// the wrong length rather than a slightly-off picture.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listViewTargets, resolveViewTarget } from '../apps/viewer/server/viewTargets.mjs'
import { buildManifest } from '../apps/viewer/server/manifest.mjs'
import { surfaceVertexCount } from '../apps/viewer/server/freesurfer.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-targets-'))
const write = async (dir, name, body = 'X') => {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, name), body)
}

// A FreeSurfer morphometry file: 0xffffff magic, then the vertex count. surfaceVertexCount reads
// exactly these 15 bytes, so the fixture only has to be honest about its header.
function morphometry(vertexCount) {
  const head = Buffer.alloc(15 + vertexCount * 4)
  head[0] = 0xff
  head[1] = 0xff
  head[2] = 0xff
  head.writeInt32BE(vertexCount, 3)
  head.writeInt32BE(1, 7)
  head.writeInt32BE(1, 11)
  return head
}
const giftiWith = (dim0) =>
  `<?xml version="1.0"?><GIFTI Version="1.0" NumberOfDataArrays="1"><DataArray Intent="NIFTI_INTENT_SHAPE" DataType="NIFTI_TYPE_FLOAT32" Dim0="${dim0}" Encoding="Base64Binary"><Data></Data></DataArray></GIFTI>`

// A recon tree with a surf/ dir carrying both hemispheres' morphometry.
async function recon(name, vertexCount) {
  const surf = path.join(root, 'fastsurfer', name, 'surf')
  await fsp.mkdir(surf, { recursive: true })
  for (const hemi of ['lh', 'rh']) {
    await fsp.writeFile(path.join(surf, `${hemi}.thickness`), morphometry(vertexCount))
    await fsp.writeFile(path.join(surf, `${hemi}.curv`), morphometry(vertexCount))
    await fsp.writeFile(path.join(surf, `${hemi}.pial`), 'PIAL')
  }
}
async function atlasDir(anat, space, suffix, dim0) {
  const dir = path.join(anat, `atlas_space-${space}`)
  await write(dir, `atlas-ARM1_space-${space}_${suffix}.nii.gz`)
  await write(dir, 'atlas-ARM1.tsv')
  if (dim0 != null) {
    for (const hemi of ['L', 'R']) {
      await write(dir, `atlas-ARM1_space-fsnative_hemi-${hemi}_${suffix}.func.gii`, giftiWith(dim0))
    }
  }
  return dir
}

const ids = (sub) => listViewTargets({ outputRoot: root, subjectDir: path.join(root, sub) }).map((t) => t.id)
const targetsOf = (sub) => listViewTargets({ outputRoot: root, subjectDir: path.join(root, sub) })
const rel = (p) => (p ? path.relative(root, p).split(path.sep).join('/') : p)

// --- sub-flat: the pre-v3 / synthesis_level "subject" layout ------------------------------
{
  const anat = path.join(root, 'sub-flat', 'anat')
  await write(anat, 'sub-flat_space-T1w_desc-preproc_T1w.nii.gz')
  await atlasDir(anat, 'fsnative', 'sub-flat', 6)
  await recon('sub-flat', 6)
}
assert.deepEqual(ids('sub-flat'), ['sub-flat'], 'a flat subject is exactly one target')
assert.equal(targetsOf('sub-flat')[0].session, null)
assert.equal(targetsOf('sub-flat')[0].stream, 'cross')
assert.equal(targetsOf('sub-flat')[0].isDefault, true)
ok('a pre-v3 flat subject yields one cross-sectional target (no regression)')

// --- sub-collapse: session anat, but ONE anat session, so brainana names the recon for the
// subject rather than the session. This is the demo dataset's shape. ------------------------
{
  const anat = path.join(root, 'sub-collapse', 'ses-001', 'anat')
  await write(anat, 'sub-collapse_ses-001_space-T1w_desc-preproc_T1w.nii.gz')
  await atlasDir(anat, 'fsnative', 'sub-collapse_ses-001', 6)
  await fsp.mkdir(path.join(root, 'sub-collapse', 'ses-002', 'func'), { recursive: true })
  await recon('sub-collapse', 6)
}
assert.deepEqual(ids('sub-collapse'), ['sub-collapse_ses-001'])
assert.equal(rel(targetsOf('sub-collapse')[0].fsDir), 'fastsurfer/sub-collapse')
ok('a single-anat-session subject pairs with the subject-keyed recon, and a func-only session is not a target')

// --- sub-stale: BOTH a leftover subject-keyed recon (no surf/) and a session-keyed one ------
{
  const anat = path.join(root, 'sub-stale', 'ses-001', 'anat')
  await write(anat, 'sub-stale_ses-001_space-T1w_desc-preproc_T1w.nii.gz')
  await fsp.mkdir(path.join(root, 'fastsurfer', 'sub-stale', 'mri'), { recursive: true })
  await recon('sub-stale_ses-001', 6)
}
assert.equal(rel(targetsOf('sub-stale')[0].fsDir), 'fastsurfer/sub-stale_ses-001')
ok('a session-keyed recon wins over a stale subject-keyed one')

// --- sub-t2only: a session whose anat holds only T2w derivatives and has no recon -----------
// Real case (sub-032309m/ses-002). resolveFsDir would fall back to the subject-level recon, so
// without session-specific evidence this session would mint an empty target.
{
  const s1 = path.join(root, 'sub-t2only', 'ses-001', 'anat')
  await write(s1, 'sub-t2only_ses-001_space-T1w_desc-preproc_T1w.nii.gz')
  await atlasDir(s1, 'fsnative', 'sub-t2only_ses-001', 6)
  const s2 = path.join(root, 'sub-t2only', 'ses-002', 'anat')
  await write(s2, 'sub-t2only_ses-002_space-T1w_desc-preproc_T2w.nii.gz')
  await write(s2, 'sub-t2only_ses-002_space-scanner_T2w.nii.gz')
  await recon('sub-t2only_ses-001', 6)
}
assert.deepEqual(ids('sub-t2only'), ['sub-t2only_ses-001'], 'the T2w-only session is not offered')
ok('a session with only T2w derivatives and no recon of its own is excluded')

// --- sub-nofunc: no anat anywhere -----------------------------------------------------------
await fsp.mkdir(path.join(root, 'sub-nofunc', 'ses-001', 'func'), { recursive: true })
assert.deepEqual(ids('sub-nofunc'), [])
ok('a subject with no anat has no targets')

// --- sub-long: the full session_longitudinal shape ------------------------------------------
{
  const flat = path.join(root, 'sub-long', 'anat')
  await write(flat, 'sub-long_space-base_desc-brain_T1w.nii.gz')
  await atlasDir(flat, 'base', 'sub-long')
  await atlasDir(flat, 'fsnative', 'sub-long', 5) // the BASE mesh's projection: 5 vertices
  for (const ses of ['ses-001', 'ses-002']) {
    const anat = path.join(root, 'sub-long', ses, 'anat')
    await write(anat, `sub-long_${ses}_space-T1w_desc-preproc_T1w.nii.gz`)
    await atlasDir(anat, 'fsnative', `sub-long_${ses}`, 6) // the CROSS mesh's: 6 vertices
    await recon(`sub-long_${ses}`, 6)
    await recon(`sub-long_${ses}_long`, 5)
  }
  await recon('sub-long_base', 5)
  await write(path.join(root, 'fastsurfer', 'sub-long_base', 'scripts'), 'base-tps', 'sub-long_ses-001\nsub-long_ses-002\n')
}
assert.deepEqual(
  ids('sub-long'),
  ['sub-long_ses-001', 'sub-long_ses-002', 'sub-long_base', 'sub-long_ses-001_long', 'sub-long_ses-002_long'],
  'cross-sectional first, then the base template, then the base-seeded timepoints',
)
ok('a longitudinal subject offers its cross-sectional AND longitudinal reconstructions')

{
  const t = targetsOf('sub-long')
  const byId = Object.fromEntries(t.map((x) => [x.id, x]))
  // The base template is the default: it is the only target carrying the change maps, so opening on
  // a cross-sectional session would hide the change tab on every longitudinal subject.
  assert.equal(t.find((x) => x.isDefault).id, 'sub-long_base')
  assert.equal(byId['sub-long_base'].stream, 'base')
  assert.equal(byId['sub-long_ses-001_long'].stream, 'long')
  assert.equal(byId['sub-long_ses-001_long'].session, 'ses-001')
  ok('the default target is the base template, which is where the change maps live')

  // The pairing table: base/long take the SUBJECT-level anat; cross takes its own session's.
  assert.equal(rel(byId['sub-long_ses-001'].atlasAnatDir), 'sub-long/ses-001/anat')
  assert.equal(rel(byId['sub-long_base'].atlasAnatDir), 'sub-long/anat')
  assert.equal(rel(byId['sub-long_ses-001_long'].atlasAnatDir), 'sub-long/anat')
  // ...and each points at its own recon.
  assert.equal(rel(byId['sub-long_ses-001'].fsDir), 'fastsurfer/sub-long_ses-001')
  assert.equal(rel(byId['sub-long_base'].fsDir), 'fastsurfer/sub-long_base')
  assert.equal(rel(byId['sub-long_ses-001_long'].fsDir), 'fastsurfer/sub-long_ses-001_long')
  assert.equal(rel(byId['sub-long_ses-001_long'].baseDir), 'fastsurfer/sub-long_base')
  assert.equal(byId['sub-long_ses-001'].baseDir, null)
  ok('base and long targets pair with the subject-level anat; cross targets with their session')
}

// --- id resolution --------------------------------------------------------------------------
{
  const sd = path.join(root, 'sub-long')
  assert.equal(resolveViewTarget({ outputRoot: root, subjectDir: sd, targetId: null }).target.id, 'sub-long_base')
  assert.equal(resolveViewTarget({ outputRoot: root, subjectDir: sd, targetId: 'sub-long_base' }).target.id, 'sub-long_base')
  // An id that names no reconstruction resolves to NOTHING rather than quietly falling back to the
  // default -- showing a different scan than the one asked for is worse than an error.
  for (const bogus of ['sub-long_ses-009', 'sub-long_base_evil', '../../etc/passwd', '']) {
    const r = resolveViewTarget({ outputRoot: root, subjectDir: sd, targetId: bogus })
    if (bogus === '') assert.equal(r.target.id, 'sub-long_base', 'empty id means "the default"')
    else assert.equal(r.target, null, `unknown id '${bogus}' resolves to null`)
  }
  ok('an unknown scan id resolves to null; it never falls back to a different scan')
}

// --- the manifest actually honours the pairing ------------------------------------------------
{
  const sd = path.join(root, 'sub-long')
  const m = (targetId) => buildManifest({ outputRoot: root, subjectDir: sd, fileUrl: (p) => rel(p), targetId })

  const cross = m('sub-long_ses-001')
  assert.match(cross.atlases[0].volume, /^sub-long\/ses-001\/anat\/atlas_space-fsnative\//)
  assert.match(cross.atlases[0].surface.left, /^sub-long\/ses-001\/anat\/atlas_space-fsnative\//)
  assert.equal(cross.longitudinal, null)

  const base = m('sub-long_base')
  assert.match(base.atlases[0].volume, /^sub-long\/anat\/atlas_space-base\//, 'base volumes come from atlas_space-base')
  assert.match(base.atlases[0].surface.left, /^sub-long\/anat\/atlas_space-fsnative\//, 'base surfaces come from the subject-level fsnative dir')

  const long = m('sub-long_ses-001_long')
  assert.match(long.atlases[0].volume, /^sub-long\/anat\/atlas_space-base\//)
  assert.match(long.atlases[0].surface.left, /^sub-long\/anat\/atlas_space-fsnative\//)
  assert.equal(rel(path.join(root, 'x')) && long.surfaces.pial.left.startsWith('fastsurfer/sub-long_ses-001_long/'), true,
    'a long target renders ITS OWN timepoint surfaces, on the shared mesh')
  ok('each stream sources its atlases and surfaces from the directories that belong to it')

  // No target may reach another reconstruction's overlays.
  assert.ok(!cross.atlases.some((a) => a.surface && a.surface.left.startsWith('sub-long/anat/')),
    'a cross target never borrows the base mesh overlay')
  assert.ok(!base.atlases.some((a) => a.surface && a.surface.left.includes('/ses-')),
    'a base target never borrows a session mesh overlay')
  ok('there is no cross-directory fallback between reconstructions')

  // Two reconstructions of one subject must not share a derived-asset cache directory.
  assert.notEqual(base.morphology.shape.curvature.left, cross.morphology.shape.curvature.left)
  assert.notEqual(long.morphology.shape.curvature.left, base.morphology.shape.curvature.left)
  ok('each reconstruction gets its own derived-asset cache directory')
}

// --- the vertex-count guard --------------------------------------------------------------------
{
  // Corrupt one session's overlay to claim the BASE mesh's vertex count. Nothing about the file's
  // name or location says it is wrong; only its Dim0 does.
  const bad = path.join(root, 'sub-long', 'ses-002', 'anat', 'atlas_space-fsnative')
  await fsp.writeFile(path.join(bad, 'atlas-ARM1_space-fsnative_hemi-L_sub-long_ses-002.func.gii'), giftiWith(5))
  const m = buildManifest({ outputRoot: root, subjectDir: path.join(root, 'sub-long'), fileUrl: (p) => rel(p), targetId: 'sub-long_ses-002' })
  assert.equal(m.atlases[0].surface, null, 'the mismatched overlay is withheld')
  assert.ok(m.warnings.some((w) => /vertex count/i.test(w)), 'and the manifest says why')
  ok('a surface overlay whose vertex count disagrees with the mesh is withheld, with a warning')
}

// --- an unknown scan id is a 404, not a different scan ------------------------------------------
{
  // The pure-function layer is covered above (resolveViewTarget returns null). This pins the
  // behaviour the data contract actually promises to a client: buildManifest THROWS, carrying a
  // 404, rather than quietly resolving to the subject's default and rendering another brain.
  const subjectDir = path.join(root, 'sub-long')
  // An EMPTY `?scan=` is deliberately not in this list: it is falsy, so it means "not specified"
  // and resolves to the default, exactly as omitting the parameter does.
  for (const bogus of ['sub-long_ses-999', '../../etc/passwd', 'sub-other_base', 'sub-long_base_long']) {
    assert.throws(
      () => buildManifest({ outputRoot: root, subjectDir, fileUrl: (p) => rel(p), targetId: bogus }),
      (err) => err.statusCode === 404 && /Unknown scan|no viewable reconstruction/.test(err.message),
      `targetId ${JSON.stringify(bogus)} must 404`,
    )
  }
  ok('an id naming no reconstruction of the subject is a 404, never a fallback to another scan')

  // ...and the id is reflected back so the client can say which scan was refused. It is echoed
  // into a JSON body, never interpolated into a path.
  const err = (() => {
    try {
      buildManifest({ outputRoot: root, subjectDir, fileUrl: (p) => rel(p), targetId: 'sub-long_ses-999' })
    } catch (e) {
      return e
    }
  })()
  assert.match(err.message, /sub-long_ses-999/)
  ok('the 404 names the scan that was asked for')
}

// --- a zero-filled morphometry header is "unknown", not "zero vertices" -------------------------
{
  // An SFTP mirror writes a failed transfer as a sized but zero-filled placeholder. Parsed
  // literally that is a well-formed vertex count of 0, which mismatches every real overlay and
  // made them all vanish behind a "vertex count does not match" warning.
  const surf = path.join(root, 'fastsurfer', 'sub-long_ses-002', 'surf')
  const saved = await fsp.readFile(path.join(surf, 'lh.thickness'))
  await fsp.writeFile(path.join(surf, 'lh.thickness'), Buffer.alloc(64))
  assert.equal(surfaceVertexCount(surf, 'lh'), 6, 'falls through the zeroed file to a readable one')

  for (const name of ['lh.curv', 'lh.sulc', 'lh.white']) {
    await fsp.rm(path.join(surf, name), { force: true })
  }
  assert.equal(surfaceVertexCount(surf, 'lh'), null, 'with nothing readable the count is unknown, not 0')

  await fsp.writeFile(path.join(surf, 'lh.thickness'), saved)
  ok('a zero-filled morphometry header reads as unknown rather than a mesh with no vertices')
}

await fsp.rm(root, { recursive: true, force: true })
console.log(`view-targets_test: ${passed} checks passed`)
