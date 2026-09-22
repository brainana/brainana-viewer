// Unit tests for custom LUTs (viewer/src/niivue/colormaps.ts).
// Key invariant: somatotopy is the eccentricity ramp REVERSED (blue at 0 → red at 100).
import assert from 'node:assert/strict'
import { buildColormap, reverseColormap, ECCENTRICITY_STOPS, SOMATOTOPY_STOPS, POLAR_STOPS, COLORMAPS, CURVATURE_BINARY } from '../apps/viewer/src/niivue/colormaps.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// buildColormap structure
const cm = buildColormap([
  [255, 0, 0],
  [0, 0, 255],
])
assert.equal(cm.I[0], 0, 'index 0 present')
assert.equal(cm.A[0], 0, 'index 0 transparent')
assert.deepEqual([cm.R[1], cm.G[1], cm.B[1]], [255, 0, 0], 'first stop')
assert.deepEqual([cm.R[2], cm.G[2], cm.B[2]], [0, 0, 255], 'last stop')
assert.ok(cm.I.every((v, i, arr) => i === 0 || v > arr[i - 1]), 'intensities strictly ascending')
assert.equal(cm.I[cm.I.length - 1], 255, 'last intensity is 255')
ok('buildColormap: transparent index 0, ascending intensities, stop colors preserved')

// somatotopy = eccentricity reversed
assert.deepEqual(SOMATOTOPY_STOPS, [...ECCENTRICITY_STOPS].reverse())
assert.deepEqual(SOMATOTOPY_STOPS[0], ECCENTRICITY_STOPS[ECCENTRICITY_STOPS.length - 1], 'somato starts where ecc ends')
assert.deepEqual(SOMATOTOPY_STOPS[0], [0, 0, 255], 'somatotopy 0 = blue')
assert.deepEqual(SOMATOTOPY_STOPS[SOMATOTOPY_STOPS.length - 1], [204, 16, 51], 'somatotopy 100 = red')
ok('somatotopy LUT is the eccentricity ramp reversed (blue 0 → red 100)')

// registered maps present
for (const name of ['brainana_eccentricity', 'brainana_somatotopy', 'brainana_polar_angle', 'brainana_curvature']) {
  assert.ok(COLORMAPS[name], `${name} registered`)
}
assert.equal(COLORMAPS.brainana_curvature, CURVATURE_BINARY)
assert.deepEqual(CURVATURE_BINARY.I, [0, 127, 128, 255], 'curvature is a binary step LUT')
ok('all custom colormaps are present incl. binary curvature')

// polar wheel is cyclic-ish (17 distinct stops)
assert.equal(POLAR_STOPS.length, 17)
for (const c of POLAR_STOPS) for (const ch of c) assert.ok(Number.isInteger(ch) && ch >= 0 && ch <= 255)
ok('polar-angle wheel has 17 valid stops')

// --- the matplotlib diverging family -------------------------------------------------------------
// The point of a diverging map here is that ZERO reads as "no change". The change tab pairs these
// with a symmetric window, so the neutral colour has to sit at the exact centre of the ramp --
// index 128 of 1..255. That holds only while each map has an ODD number of stops.
{
  const DIVERGING = ['piyg', 'prgn', 'brbg', 'puor', 'rdgy', 'rdbu', 'rdylbu', 'rdylgn', 'spectral', 'coolwarm', 'bwr', 'seismic']
  for (const key of DIVERGING) {
    const cm = COLORMAPS[key]
    assert.ok(cm, `${key} is registered`)
    assert.equal(cm.A[0], 0, `${key} keeps index 0 transparent`)
    assert.equal(cm.I[0], 0, `${key} starts at index 0`)
    assert.equal(cm.I[cm.I.length - 1], 255, `${key} ends at index 255`)
    // stops = entries minus the reserved index-0 slot
    const stops = cm.I.length - 1
    assert.equal(stops % 2, 1, `${key} has an odd stop count, so it HAS a middle stop`)
    const mid = 1 + (stops - 1) / 2
    assert.equal(cm.I[mid], 128, `${key}'s neutral stop sits at index 128`)
    assert.ok(cm.I.every((v, i, arr) => i === 0 || v > arr[i - 1]), `${key} intensities ascend`)
  }
  // Spot-check against matplotlib's published anchors rather than trusting the generator blindly.
  assert.deepEqual([COLORMAPS.bwr.R[1], COLORMAPS.bwr.G[1], COLORMAPS.bwr.B[1]], [0, 0, 255], 'bwr starts blue')
  assert.deepEqual([COLORMAPS.bwr.R[2], COLORMAPS.bwr.G[2], COLORMAPS.bwr.B[2]], [255, 255, 255], 'bwr is white at zero')
  assert.deepEqual([COLORMAPS.bwr.R[3], COLORMAPS.bwr.G[3], COLORMAPS.bwr.B[3]], [255, 0, 0], 'bwr ends red')
  // PRGn's ColorBrewer endpoints.
  assert.deepEqual([COLORMAPS.prgn.R[1], COLORMAPS.prgn.G[1], COLORMAPS.prgn.B[1]], [64, 0, 75], 'PRGn starts #40004b')
  assert.deepEqual([COLORMAPS.prgn.R[11], COLORMAPS.prgn.G[11], COLORMAPS.prgn.B[11]], [0, 68, 27], 'PRGn ends #00441b')
  ok('every diverging map is registered, transparent at 0, and neutral exactly at index 128')
}

// --- reverseColormap ------------------------------------------------------------------------------
{
  // A 4-entry flat RGBA LUT: [reserved slot, red, green, blue].
  const lut = [0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]
  const rev = reverseColormap(lut)
  assert.equal(rev.I[0], 0, 'index 0 is still index 0')
  assert.deepEqual([rev.R[0], rev.G[0], rev.B[0], rev.A[0]], [0, 0, 0, 0], 'the reserved slot is untouched')
  // The colours flip; the masked slot does NOT travel into the middle of the ramp.
  assert.deepEqual([rev.R[1], rev.G[1], rev.B[1]], [0, 0, 255], 'first colour is the old last')
  assert.deepEqual([rev.R[3], rev.G[3], rev.B[3]], [255, 0, 0], 'last colour is the old first')
  assert.equal(rev.I[rev.I.length - 1], 255, 'spans to 255')
  assert.ok(rev.I.every((v, i, arr) => i === 0 || v > arr[i - 1]), 'intensities ascend')
  assert.equal(reverseColormap([0, 0, 0, 0, 1, 1, 1, 1]), null, 'a LUT too short to reverse is refused')
  ok('reverseColormap flips the ramp and leaves the reserved index-0 slot in place')
}

// Reversing a real map twice returns the colours it started with.
{
  const flat = []
  for (let i = 0; i < 256; i++) flat.push(i, 255 - i, 128, i === 0 ? 0 : 255)
  const once = reverseColormap(flat)
  const onceFlat = []
  for (let i = 0; i < once.I.length; i++) onceFlat.push(once.R[i], once.G[i], once.B[i], once.A[i])
  const twice = reverseColormap(onceFlat)
  assert.deepEqual([twice.R[1], twice.G[1], twice.B[1]], [flat[4], flat[5], flat[6]], 'round-trips to the original start')
  ok('reversing twice restores the original ramp')
}

console.log(`colormaps_test: ${passed} checks passed`)
