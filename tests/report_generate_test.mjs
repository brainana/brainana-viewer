// Unit tests for collectFiles (apps/viewer/src/report/generate.ts): which loaded assets earn a card,
// how sidecar lookups are deduplicated, and where the dataset's pipeline version comes from.
import assert from 'node:assert/strict'
import { collectFiles, generateReport, reportFilename } from '../apps/viewer/src/report/generate.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const hdr = { dims: [3, 8, 8, 8, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 0, 0, 0, 0], datatypeCode: 16, numBitsPerVoxel: 32 }
const mesh = { pts: new Float32Array(9), tris: new Uint32Array(3) }

// A viewer with everything loaded: the D99 atlas is BOTH the overlay and a sampled report volume,
// and it is the only file carrying a brainana sidecar.
const assets = [
  { role: 'base volume', url: '/brainana-data/local-0123456789ab/fastsurfer/sub-x/mri/norm.mgz', hdr, mesh: null },
  { role: 'atlas overlay: D99', url: '/brainana-data/local-0123456789ab/anat/atlas-D99.nii.gz', hdr, mesh: null },
  { role: 'functional map', url: '/brainana-data/local-0123456789ab/anat/atlas-somatotopy.nii.gz', hdr, mesh: null },
  { role: 'atlas (sampled): D99', url: '/brainana-data/local-0123456789ab/anat/atlas-D99.nii.gz', hdr, mesh: null },
  { role: 'atlas (sampled): MacBNA', url: '/brainana-data/local-0123456789ab/anat/atlas-MacBNA.nii.gz', hdr, mesh: null },
  { role: 'surface (left)', url: '/brainana-data/local-0123456789ab/fastsurfer/sub-x/surf/lh.pial', hdr: null, mesh },
  { role: 'surface (right)', url: '/brainana-data/local-0123456789ab/fastsurfer/sub-x/surf/rh.pial', hdr: null, mesh },
  { role: 'morphometry: curvature (left)', url: '/brainana-data/local-0123456789ab/.cache/lh.curv.shape.gii', hdr: null, mesh: null },
  { role: 'morphometry: curvature (right)', url: '/brainana-data/local-0123456789ab/.cache/rh.curv.shape.gii', hdr: null, mesh: null },
]

const sidecars = {
  '/brainana-data/local-0123456789ab/anat/atlas-D99.json': { GeneratedBy: [{ Name: 'brainana', Version: '1.3.0' }] },
  '/brainana-data/local-0123456789ab/anat/atlas-MacBNA.json': { GeneratedBy: [{ Name: 'brainana', Version: '1.3.0' }] },
  '/brainana-data/local-0123456789ab/anat/atlas-somatotopy.json': { GeneratedBy: [{ Name: 'brainana', Version: '1.3.0' }] },
}

const makeCtx = (list = assets) => {
  const requested = []
  return {
    requested,
    ctx: {
      apiFetch: async (url) => {
        requested.push(url)
        const body = sidecars[url]
        return body ? { ok: true, json: async () => body } : { ok: false }
      },
      loadedAssets: () => list,
    },
  }
}

const { ctx, requested } = makeCtx()
const { files, pipelineVersions } = await collectFiles(ctx)

// --- which assets earn a card ---
assert.deepEqual(
  files.map((f) => f.role),
  ['base volume', 'atlas overlay: D99', 'functional map', 'surface (left)', 'surface (right)'],
)
ok('lists the base volume, the named atlas overlay, the functional map and both surfaces')

assert.equal(files.some((f) => f.role.startsWith('atlas (sampled)')), false, 'sampled-atlas duplicates are the same files, listed once')
ok('sampled-atlas duplicates are filtered out')

assert.equal(files.some((f) => f.role.startsWith('morphometry')), false, 'a card with no header and no mesh says nothing')
ok('auxiliary assets with neither a header nor a mesh are dropped')

// ...but never the two the report is about. A viewer that failed to expose a header for the base
// volume must produce a detail-less card, not a report that silently omits the underlay.
const detailless = await collectFiles(
  makeCtx([
    { role: 'base volume', url: '/brainana-data/local-0123456789ab/mri/norm.mgz', hdr: null, mesh: null },
    { role: 'atlas overlay: D99', url: '/brainana-data/local-0123456789ab/anat/atlas-D99.nii.gz', hdr: null, mesh: null },
    { role: 'morphometry: curvature (left)', url: '/brainana-data/local-0123456789ab/.cache/lh.curv.shape.gii', hdr: null, mesh: null },
  ]).ctx,
)
assert.deepEqual(detailless.files.map((f) => f.role), ['base volume', 'atlas overlay: D99'])
ok('the base volume and atlas overlay are listed even when they carry no detail')

// Surfaces keep their geometry; volumes keep their header.
assert.deepEqual(files.find((f) => f.role === 'surface (left)').mesh, { vertices: 3, faces: 1 })
assert.equal(files.find((f) => f.role === 'surface (left)').header, null)
assert.equal(files.find((f) => f.role === 'base volume').header.datatype, 'FLOAT32')
ok('each card carries the detail appropriate to its kind')

// The report shows a source-relative path per file.
assert.equal(files[0].path, 'fastsurfer/sub-x/mri/norm.mgz')
ok('paths are source-relative and decoded')

// --- provenance ---
// The version must come from the whole scene, not just the listed files: a dataset whose only
// sidecars sit on the sampled atlases would otherwise report an unknown pipeline version.
assert.deepEqual(pipelineVersions, ['1.3.0'])
ok('the pipeline version is aggregated across every loaded asset, not just the listed ones')

// D99 appears twice (overlay + sampled) but must only be fetched once.
const d99 = requested.filter((u) => u === '/brainana-data/local-0123456789ab/anat/atlas-D99.json')
assert.equal(d99.length, 1, 'a file that is both overlaid and sampled is fetched once')
assert.equal(new Set(requested).size, requested.length, 'no URL is fetched twice')
ok('sidecar lookups are deduplicated by URL')

// Extensionless FreeSurfer files and .mgz volumes have no sidecar convention, so none is requested.
assert.equal(requested.some((u) => u.includes('norm')), false, 'no sidecar requested for a .mgz volume')
assert.equal(requested.some((u) => u.includes('pial')), false, 'no sidecar requested for a FreeSurfer surface')
assert.equal(files.find((f) => f.role === 'base volume').brainanaVersion, null)
assert.equal(files.find((f) => f.role === 'atlas overlay: D99').brainanaVersion, '1.3.0')
ok('no sidecar is requested for assets that have none, and per-file versions still resolve')

// --- degenerate scenes ---
const empty = await collectFiles(makeCtx([]).ctx)
assert.deepEqual(empty.files, [])
assert.deepEqual(empty.pipelineVersions, [])
ok('an empty scene produces no files and no version')

// A scene with no sidecars anywhere must report an unknown version rather than inventing one.
const bare = await collectFiles(makeCtx([assets[0], assets[5]]).ctx)
assert.deepEqual(bare.files.map((f) => f.role), ['base volume', 'surface (left)'])
assert.deepEqual(bare.pipelineVersions, [])
ok('a scene with no pipeline sidecars reports no version')

// An asset with no URL must not break the pass (a derived surface the server synthesised).
const noUrl = await collectFiles(makeCtx([{ role: 'base volume', url: null, hdr, mesh: null }]).ctx)
assert.equal(noUrl.files.length, 1)
assert.equal(noUrl.files[0].path, '—')
assert.deepEqual(noUrl.files[0].generatedBy, [])
ok('an asset without a URL is described without provenance instead of throwing')

// --- the filename names the scan -----------------------------------------------------------
// Two reports from two timepoints of one animal are different documents; colliding in a downloads
// folder would make one silently overwrite the other.
{
  const base = { generatedAt: '2026-09-20T11:22:33.000Z', dataset: { subjectId: 'sub-032309m', scan: null } }
  assert.equal(reportFilename(base), 'brainana-report_sub-032309m_2026-09-20-11-22-33.html')

  const withScan = (id) => reportFilename({ ...base, dataset: { subjectId: 'sub-032309m', scan: { id } } })
  // The scan id already starts with the subject id, so it is stripped rather than repeated.
  assert.equal(withScan('sub-032309m_ses-003_long'), 'brainana-report_sub-032309m_ses-003_long_2026-09-20-11-22-33.html')
  assert.equal(withScan('sub-032309m_base'), 'brainana-report_sub-032309m_base_2026-09-20-11-22-33.html')
  // A subject-level scan id IS the subject id; nothing is left to add.
  assert.equal(withScan('sub-032309m'), 'brainana-report_sub-032309m_2026-09-20-11-22-33.html')
  // Two timepoints must not produce the same name.
  assert.notEqual(withScan('sub-032309m_ses-001_long'), withScan('sub-032309m_ses-003_long'))
  // Whatever a scan id contains, the result stays a safe filename.
  const nasty = reportFilename({ ...base, dataset: { subjectId: 'sub-a', scan: { id: 'sub-a_../../etc/passwd' } } })
  assert.equal(/[/\\]/.test(nasty), false, 'no path separators survive into the filename')
  ok('the report filename names the scan, so two timepoints cannot collide')
}

// --- the time-source caveat reaches `notes` -----------------------------------------------------
// The caveat is rendered in the longitudinal section (covered in report_html_test), but the claim
// that matters is that it ALSO lands in `notes`, which render above the fold. A reader who never
// scrolls to the longitudinal section must still be told the rates are per scan. Nothing tested
// that end to end: the html test hands `notes` in ready-made.
{
  const ctx = (longitudinal, viewLong) => ({
    apiFetch: () => Promise.reject(new Error('no sidecars in this fixture')),
    app: { name: 'brainana-viewer', version: '0.0.0', buildId: null },
    dataset: () => ({ subjectId: 'sub-x', subjectLabel: 'x', session: null, scan: null, synthesisLevel: null, sourceLabel: 'l', sourceType: 'local', relativePath: null }),
    loadedAssets: () => [],
    currentReadout: () => null,
    viewState: () => ({ longitudinal: viewLong, atlas: null, function: null, morphology: { metric: 'none' }, camera: null, markerMode: 'none' }),
    longitudinal: () => longitudinal,
    panes: () => ({ slices: null, surface: null }),
    crosshair: () => null,
    moveCrosshair: () => {},
  })
  const fit = { timepoints: ['ses-001'], times: { 'ses-001': 0 }, timeSource: 'scan order', timeInterpretable: false, skipped: {}, roiRates: [], agreement: [] }
  const viewLong = { measure: 'thickness', statistic: 'rate', colormap: 'bwr', displayRange: null, threshold: 0, opacity: 1, unit: 'mm per scan', timeSource: 'scan order', timeInterpretable: false }
  const opts = { includeScreenshots: false }

  const bad = await generateReport(ctx(fit, viewLong), [], opts)
  const caveat = bad.notes.find((n) => /per scan/i.test(n))
  assert.ok(caveat, 'the caveat is in notes, not only in the longitudinal section')
  assert.match(caveat, /mm per scan/, 'and it carries the unit the map is actually in')
  assert.match(caveat, /scan order/, 'and names the time source brainana fell back to')
  assert.match(caveat, /cannot be read as change per year/, 'and says plainly what it may not be read as')

  // The mirror image: a real time column must NOT produce the caveat, or it becomes noise.
  const good = await generateReport(
    ctx({ ...fit, timeSource: 'age', timeInterpretable: true }, { ...viewLong, unit: 'mm per year', timeSource: 'age', timeInterpretable: true }),
    [],
    opts,
  )
  assert.equal(good.notes.some((n) => /per scan/i.test(n)), false, 'an interpretable time source adds no caveat')
  ok('the per-scan caveat propagates into notes, and only when the time source warrants it')

  // Low base-segmentation agreement is its own note, and the excluded sessions are named.
  const flagged = await generateReport(
    ctx({ ...fit, agreement: [{ timepoint: 'ses-002', dice: 0.41 }], skipped: { 'ses-009': 'no anat' } }, viewLong),
    [],
    opts,
  )
  assert.ok(flagged.notes.some((n) => /ses-002/.test(n) && /0\.41/.test(n)), 'the worst timepoint is named with its Dice')
  assert.ok(flagged.notes.some((n) => /ses-009/.test(n)), 'and excluded sessions are listed')
  ok('low base-segmentation agreement and excluded sessions each earn a note')
}

console.log(`\nreport_generate_test: ${passed} checks passed`)
