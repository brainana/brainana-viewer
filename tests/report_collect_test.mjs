// Unit tests for the crosshair collectors (apps/viewer/src/report/collect.ts) — the single
// sampling path shared by the live info panel and the HTML report.
import assert from 'node:assert/strict'
import { collectAtlasRows, collectVertex, collectMorphology, collectVisualFieldPoints, collectRetinotopy, collectSomatotopy } from '../apps/viewer/src/report/collect.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- atlas rows ---
const labels = (entries) => new Map(entries.map((e) => [e.id, e]))
const atlasSampler = (values, continuous = {}) => ({
  sampleReportVolume: (key) => (key in values ? values[key] : null),
  reportVolumeContinuous: (key) => Boolean(continuous[key]),
})

const specs = [
  { key: 'D99', label: 'D99', byId: labels([{ id: 7, name: 'area_V1', nameShort: 'V1' }]) },
  { key: 'CortHierarchy', label: 'CortHierarchy', byId: new Map() },
]
const rows = collectAtlasRows(atlasSampler({ D99: 7, CortHierarchy: 0.4213 }, { CortHierarchy: true }), specs)

assert.equal(rows[0].id, 7)
assert.equal(rows[0].region, 'area V1', 'underscores are a storage convention, not part of the name')
assert.equal(rows[0].shortName, 'V1')
assert.equal(rows[0].continuous, false)
assert.equal(rows[0].unknown, false)
ok('a parcellation resolves id, region and short name')

assert.equal(rows[1].continuous, true)
assert.equal(rows[1].value, 0.4213)
assert.equal(rows[1].id, null, 'a continuous atlas has no label id')
assert.equal(rows[1].region, null)
ok('a continuous atlas reports its raw value and no id/region')

// Voxel 0 is background in both modes — neither an id nor a value.
const bg = collectAtlasRows(atlasSampler({ D99: 0, CortHierarchy: 0 }, { CortHierarchy: true }), specs)
assert.equal(bg[0].id, null)
assert.equal(bg[0].unknown, false, 'background is not an unresolved label')
assert.equal(bg[1].value, null)
ok('voxel 0 reads as background, not as a label or a value')

// An id with no LUT entry is a real signal (volume/LUT mismatch), distinct from background.
const unknown = collectAtlasRows(atlasSampler({ D99: 304 }), [specs[0]])
assert.equal(unknown[0].id, 304)
assert.equal(unknown[0].region, null)
assert.equal(unknown[0].unknown, true)
ok('an id with no LUT entry is flagged unknown, not silently blank')

// Sampling outside the volume returns null; non-finite voxels must not become NaN ids.
const outside = collectAtlasRows({ sampleReportVolume: () => null, reportVolumeContinuous: () => false }, [specs[0]])
assert.equal(outside[0].id, null)
assert.equal(outside[0].unknown, false)
const nonFinite = collectAtlasRows(atlasSampler({ D99: NaN }), [specs[0]])
assert.equal(nonFinite[0].id, null, 'a NaN voxel is not a label id')
ok('out-of-bounds and non-finite samples yield no id')

// A float value that rounds to an integer must still be a value, never an id-looking number.
const wholeFloat = collectAtlasRows(atlasSampler({ CortHierarchy: 1 }, { CortHierarchy: true }), [specs[1]])
assert.equal(wholeFloat[0].value, 1)
assert.equal(wholeFloat[0].continuous, true)
ok('a whole-numbered continuous value stays a value')

assert.deepEqual(collectAtlasRows(atlasSampler({}), []), [], 'no atlases → no rows')
ok('an empty atlas list yields no rows')

// --- vertex ---
const vertexView = { referenceVertexWorld: () => [3, 4, 0] }
assert.deepEqual(collectVertex(vertexView, { hemi: 0, index: 12 }, [0, 0, 0]), { index: 12, hemi: 0, distanceMm: 5 })
assert.equal(collectVertex(vertexView, null, [0, 0, 0]), null, 'no node → no vertex readout')
ok('collectVertex reports the index and its distance from the crosshair')

// A vertex whose world position is unknown still reports the index, with an undefined distance.
assert.deepEqual(collectVertex({ referenceVertexWorld: () => null }, { hemi: 1, index: 3 }, [0, 0, 0]), { index: 3, hemi: 1, distanceMm: null })
assert.equal(collectVertex(vertexView, { hemi: 0, index: 1 }, null).distanceMm, null, 'no crosshair → no distance')
ok('an unlocatable vertex reports a null distance rather than a bogus number')

// --- morphology ---
const shape = { curvature: [new Float32Array([0.1, 0.2]), new Float32Array([0.3])], thickness: [new Float32Array([2.5, 2.6]), new Float32Array([2.7])] }
const morph = collectMorphology(shape, { hemi: 0, index: 1 })
assert.equal(morph.curvature, Math.fround(0.2))
assert.equal(morph.thickness, Math.fround(2.6))
assert.ok(Number.isNaN(morph.sulc), 'an absent metric samples as NaN, rendered as an em dash')
ok('collectMorphology samples the correct hemisphere and flags absent metrics')

// The right hemisphere's arrays are shorter here: an out-of-range index must not read garbage.
assert.ok(Number.isNaN(collectMorphology(shape, { hemi: 1, index: 99 }).curvature))
assert.equal(collectMorphology(shape, null), null)
ok('an out-of-range vertex index yields NaN, not a stray value')

// --- visual-field neighborhood sweep ---
const frames = { polar: 0, polarF: 1, eccentricity: 2, eccentricityF: 3 }
// A 3x3x3 volume where every voxel is a valid retinotopic sample (ecc 5, F 10).
const uniform = {
  functionCrosshairVox: () => [1, 1, 1],
  functionDims: () => [3, 3, 3],
  sampleFunctionFrame: (_v, frame) => (frame === frames.eccentricity ? 5 : frame === frames.polar ? 0 : 10),
}
const swept = collectVisualFieldPoints(uniform, frames, [1, 1, 1], [3, 3, 3], 1, 0)
assert.equal(swept.possible, 27)
assert.equal(swept.points.length, 27)
assert.equal(swept.points.filter((p) => p.center).length, 1, 'exactly one point is the crosshair itself')
ok('the neighborhood sweep visits every in-bounds voxel and marks the centre')

// At a corner most of the neighborhood is out of bounds and must not be counted.
const corner = collectVisualFieldPoints(uniform, frames, [0, 0, 0], [3, 3, 3], 1, 0)
assert.equal(corner.possible, 8, 'out-of-bounds neighbours are excluded from the denominator')
ok('out-of-bounds neighbours are excluded from the sweep')

// The F-threshold masks voxels out of the valid set but leaves the denominator intact.
const thresholded = collectVisualFieldPoints(uniform, frames, [1, 1, 1], [3, 3, 3], 1, 20)
assert.equal(thresholded.possible, 27)
assert.equal(thresholded.points.length, 0, 'F below threshold is not a valid sample')
ok('the F-threshold masks samples without shrinking the denominator')

// Eccentricity outside [0, ECC_MAX] is not a usable retinotopic sample.
const outOfDomain = { ...uniform, sampleFunctionFrame: (_v, frame) => (frame === frames.eccentricity ? 42 : 10) }
assert.equal(collectVisualFieldPoints(outOfDomain, frames, [1, 1, 1], [3, 3, 3], 1, 0).points.length, 0)
ok('eccentricity beyond the domain cap is rejected')

// --- retinotopy readout ---
const retino = collectRetinotopy(uniform, frames, 1, 0)
assert.equal(retino.eccentricity, 5)
assert.equal(retino.visualX, 5, 'polar 0 → visual X = ecc')
assert.equal(retino.visualY, 0)
assert.equal(retino.validVoxels, 27)
assert.equal(retino.possibleVoxels, 27)
assert.equal(retino.spreadDeg, 0, 'identical samples have zero spread')
assert.equal(retino.neighborhood, 1)
ok('collectRetinotopy reports the crosshair values and neighborhood statistics')

// The live panel opts out of the sweep; the plot fills those numbers instead.
const light = collectRetinotopy(uniform, frames, 1, 0, false)
assert.equal(light.eccentricity, 5)
assert.equal(light.validVoxels, null)
assert.equal(light.spreadDeg, null)
ok('the neighborhood sweep can be skipped for the per-move panel update')

// With no valid voxel the spread is undefined, not zero.
const empty = collectRetinotopy(uniform, frames, 1, 999)
assert.equal(empty.validVoxels, 0)
assert.equal(empty.spreadDeg, null, 'no valid samples → spread is undefined, not 0')
ok('an empty neighborhood reports an undefined spread rather than zero')

// No crosshair voxel (crosshair outside the functional volume) → no readout at all.
assert.equal(collectRetinotopy({ ...uniform, functionCrosshairVox: () => null }, frames, 1, 0), null)
ok('a crosshair outside the functional volume yields no retinotopy readout')

// --- somatotopy ---
const som = collectSomatotopy(
  { functionCrosshairVox: () => [1, 1, 1], functionDims: () => [3, 3, 3], sampleFunctionFrame: (_v, frame) => (frame === 0 ? 63.5 : 8.2) },
  { phase: 0, fstat: 1 },
)
assert.deepEqual(som, { bodyPosition: 63.5, fStat: 8.2 })
assert.equal(collectSomatotopy({ functionCrosshairVox: () => null }, { phase: 0, fstat: 1 }), null)
ok('collectSomatotopy reports body position and its F-stat')

console.log(`\nreport_collect_test: ${passed} checks passed`)
