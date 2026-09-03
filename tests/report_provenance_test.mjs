// Unit tests for pipeline-provenance resolution (apps/viewer/src/report/provenance.ts):
// sidecar URL derivation, GeneratedBy parsing, and the best-effort fetch contract.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sidecarUrl, displayPath, parseGeneratedBy, brainanaVersion, fetchGeneratedBy, distinctVersions } from '../apps/viewer/src/report/provenance.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- sidecar URL derivation ---
assert.equal(
  sidecarUrl('/brainana-data/src1/sub-example/ses-001/anat/atlas_space-fsnative/atlas-D99_space-fsnative_sub-example_ses-001.nii.gz'),
  '/brainana-data/src1/sub-example/ses-001/anat/atlas_space-fsnative/atlas-D99_space-fsnative_sub-example_ses-001.json',
)
ok('a .nii.gz volume maps to its .json sidecar')

// .surf.gii / .func.gii must strip the full double extension, not just ".gii".
assert.equal(sidecarUrl('/brainana-data/s/a/atlas-D99_hemi-L.func.gii'), '/brainana-data/s/a/atlas-D99_hemi-L.json')
assert.equal(sidecarUrl('/brainana-data/s/a/lh.pial.surf.gii'), '/brainana-data/s/a/lh.pial.json')
ok('double .gii extensions are stripped whole')

// FreeSurfer assets are not pipeline outputs: guessing "lh.json" would fetch a nonexistent file.
assert.equal(sidecarUrl('/brainana-data/s/fastsurfer/sub-x/surf/lh.curv'), null)
assert.equal(sidecarUrl('/brainana-data/s/fastsurfer/sub-x/mri/norm.mgz'), null)
ok('extensionless FreeSurfer files and .mgz volumes have no sidecar')

// The bundled atlas LUTs are inlined as data: URLs and have nothing to fetch.
assert.equal(sidecarUrl('data:text/plain;charset=utf-8,id%09name'), null)
assert.equal(sidecarUrl(null), null)
assert.equal(sidecarUrl(undefined), null)
ok('data: URLs and missing URLs yield no sidecar')

// A query/hash must not end up inside the derived filename.
assert.equal(sidecarUrl('/brainana-data/s/a/x.nii.gz?v=2'), '/brainana-data/s/a/x.json')
ok('a query string is stripped before the extension swap')

// --- display path ---
// Source ids are `<type>-<12 hex>` (SOURCE_ID_PATTERN); the fixtures use that real shape, because
// only it distinguishes a scoped URL from a legacy unscoped one.
assert.equal(displayPath('/brainana-data/local-0123456789ab/sub-example/ses-001/anat/x.nii.gz'), 'sub-example/ses-001/anat/x.nii.gz')
assert.equal(displayPath('/brainana-data/sftp-abcdef012345/sub-a%20b/x%2Ey.nii.gz'), 'sub-a b/x.y.nii.gz', 'per-segment escapes are decoded')
assert.equal(displayPath('data:text/plain,x'), '(bundled with the app)')
assert.equal(displayPath(null), '—')
ok('displayPath strips the source scope and decodes segment escapes')

// Legacy (--legacyCompat) URLs are unscoped. Every segment is part of the path and none may be
// mistaken for a source id and dropped.
assert.equal(displayPath('/brainana-data/sub-example/anat/x.nii.gz'), 'sub-example/anat/x.nii.gz')
ok('an unscoped legacy URL keeps its first path segment')

// A malformed escape must degrade, not throw mid-report.
assert.equal(displayPath('/brainana-data/local-0123456789ab/bad%ZZname.nii.gz'), 'bad%ZZname.nii.gz')
ok('a malformed percent-escape is shown verbatim instead of throwing')

// --- GeneratedBy parsing, against the shape the real pipeline writes ---
const real = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'datasets/demo_viewer/sub-example/ses-001/anat/atlas_space-fsnative/atlas-D99_space-fsnative_sub-example_ses-001.json'), 'utf8'),
)
const entries = parseGeneratedBy(real)
assert.deepEqual(entries, [{ name: 'brainana', version: '1.3.0' }])
assert.equal(brainanaVersion(entries), '1.3.0')
ok('parses GeneratedBy from a real demo-dataset sidecar')

// Tolerate the field being a bare object, and entries missing a version or a name.
assert.deepEqual(parseGeneratedBy({ GeneratedBy: { Name: 'brainana', Version: '2.0' } }), [{ name: 'brainana', version: '2.0' }])
assert.deepEqual(parseGeneratedBy({ GeneratedBy: [{ Name: 'brainana' }] }), [{ name: 'brainana', version: null }])
assert.deepEqual(parseGeneratedBy({ GeneratedBy: [{ Version: '1.0' }, null, 'nonsense'] }), [], 'entries without a Name are dropped')
assert.deepEqual(parseGeneratedBy({ GeneratedBy: [{ Name: 'x', Version: 3 }] }), [{ name: 'x', version: '3' }], 'a numeric Version is stringified')
ok('parseGeneratedBy tolerates malformed sidecar shapes')

assert.deepEqual(parseGeneratedBy({}), [])
assert.deepEqual(parseGeneratedBy(null), [])
assert.deepEqual(parseGeneratedBy('not json'), [])
assert.equal(brainanaVersion([{ name: 'fastsurfer', version: '2.2' }]), null, 'a non-brainana generator is not the pipeline version')
ok('absent/foreign provenance yields no brainana version')

// --- fetch contract: best-effort, never rejects ---
const okRes = (body) => ({ ok: true, json: async () => body })
assert.deepEqual(await fetchGeneratedBy(async () => okRes(real), '/brainana-data/s/a/x.nii.gz'), [{ name: 'brainana', version: '1.3.0' }])
assert.deepEqual(await fetchGeneratedBy(async () => ({ ok: false }), '/brainana-data/s/a/x.nii.gz'), [], '404 sidecar')
assert.deepEqual(
  await fetchGeneratedBy(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json') } }), '/brainana-data/s/a/x.nii.gz'),
  [],
  'malformed JSON body',
)
assert.deepEqual(await fetchGeneratedBy(async () => { throw new Error('network down') }, '/brainana-data/s/a/x.nii.gz'), [], 'network failure')
assert.deepEqual(await fetchGeneratedBy(async () => okRes(real), '/brainana-data/s/surf/lh.curv'), [], 'no sidecar → no fetch')
ok('fetchGeneratedBy degrades to [] on 404, bad JSON, and network failure')

// A source that never responds must not hang report generation.
const started = Date.now()
assert.deepEqual(await fetchGeneratedBy(() => new Promise(() => {}), '/brainana-data/s/a/x.nii.gz', 50), [])
assert.ok(Date.now() - started < 2000, 'timed out promptly rather than hanging')
ok('a hung sidecar fetch times out instead of blocking the report')

// --- version aggregation ---
assert.deepEqual(distinctVersions(['1.3.0', null, '1.3.0', '1.10.0', '1.2.0']), ['1.2.0', '1.3.0', '1.10.0'], 'natural sort, nulls dropped')
assert.deepEqual(distinctVersions([null, null]), [])
ok('distinctVersions de-duplicates and sorts naturally')

console.log(`\nreport_provenance_test: ${passed} checks passed`)
