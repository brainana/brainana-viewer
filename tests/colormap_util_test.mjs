// Unit tests for the pure colormap registry + gradient helpers (viewer/src/data/colormap.ts).
// Run via Node's native TypeScript support (Node >= 22.18 strips types on import).
import assert from 'node:assert/strict'
import {
  COLORMAP_REGISTRY,
  BRAINANA_COLORMAPS,
  BUILTIN_COLORMAPS,
  colormapInfo,
  gradientFromStops,
  gradientFromRgba,
  buildColormapRegistry,
  prettifyLabel, isReversedKey, reversedKey, baseColormapKey, toggleReversedKey, colormapDisplayName } from '../apps/viewer/src/data/colormap.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- registry composition + lookup ---
assert.equal(COLORMAP_REGISTRY.length, BRAINANA_COLORMAPS.length + BUILTIN_COLORMAPS.length, 'registry = brainana + builtin')
assert.equal(COLORMAP_REGISTRY[0].group, 'Brainana', 'brainana maps listed first')
assert.ok(COLORMAP_REGISTRY.every((c) => c.key && c.label && c.group), 'every entry has key/label/group')
assert.equal(new Set(COLORMAP_REGISTRY.map((c) => c.key)).size, COLORMAP_REGISTRY.length, 'keys are unique')
ok('COLORMAP_REGISTRY composes brainana + builtin maps with unique keys')

assert.equal(colormapInfo('viridis')?.label, 'viridis', 'lookup by key')
assert.equal(colormapInfo('nope'), undefined, 'unknown key -> undefined')
assert.equal(colormapInfo('brainana_polar_angle')?.cyclic, true, 'polar angle flagged cyclic')
ok('colormapInfo resolves keys and flags cyclic maps')

// --- gradientFromStops ---
{
  const g = gradientFromStops([[255, 0, 0], [0, 0, 255]])
  assert.ok(g.startsWith('linear-gradient(90deg,'), 'is a linear-gradient')
  assert.ok(g.includes('rgb(255,0,0) 0%'), 'first stop at 0%')
  assert.ok(g.includes('rgb(0,0,255) 100%'), 'last stop at 100%')
  ok('gradientFromStops spaces stops evenly from 0% to 100%')
}
{
  const single = gradientFromStops([[10, 20, 30]])
  assert.ok(single.includes('rgb(10,20,30)'), 'single stop repeated')
  assert.equal(gradientFromStops([]), 'linear-gradient(90deg, #000, #000)', 'empty -> neutral')
  ok('gradientFromStops handles single-stop and empty inputs')
}

// --- gradientFromRgba samples a flat RGBA LUT ---
{
  // 2 entries: red then blue (alpha ignored)
  const rgba = [255, 0, 0, 255, 0, 0, 255, 255]
  const g = gradientFromRgba(rgba, 2)
  assert.ok(g.includes('rgb(255,0,0) 0%') && g.includes('rgb(0,0,255) 100%'), 'endpoints sampled')
  assert.equal(gradientFromRgba([], 8), 'linear-gradient(90deg, #000, #000)', 'empty LUT -> neutral')
  ok('gradientFromRgba samples endpoints from a flat RGBA LUT')
}

// --- buildColormapRegistry: brainana first, curated groups, unknowns -> Other ---
{
  const reg = buildColormapRegistry(['viridis', 'brainana_polar_angle', 'coolwarm', 'weird_map', 'gray'])
  assert.equal(reg[0].group, 'Brainana', 'brainana maps listed first')
  // brainana_polar_angle is in the brainana block, not duplicated among builtins
  assert.equal(reg.filter((c) => c.key === 'brainana_polar_angle').length, 1, 'no duplicate brainana entry')
  assert.equal(reg.find((c) => c.key === 'viridis')?.group, 'Perceptually Uniform', 'viridis grouped')
  assert.equal(reg.find((c) => c.key === 'coolwarm')?.group, 'Diverging', 'coolwarm grouped')
  const weird = reg.find((c) => c.key === 'weird_map')
  assert.equal(weird?.group, 'Other', 'unknown -> Other')
  assert.equal(weird?.label, 'weird map', 'unknown label lower-cased')
  ok('buildColormapRegistry orders brainana first, curates known maps, lower-cases unknowns')
}

// --- reversed keys ------------------------------------------------------------------------------
// Reversal rides in the key, so these four have to agree exactly: every apply path, the report and
// the session snapshot all just pass the string along.
{
  assert.equal(isReversedKey('viridis'), false)
  assert.equal(isReversedKey('viridis_r'), true)
  assert.equal(reversedKey('viridis'), 'viridis_r')
  assert.equal(reversedKey('viridis_r'), 'viridis_r', 'reversing twice is still reversed, never x_r_r')
  assert.equal(baseColormapKey('viridis_r'), 'viridis')
  assert.equal(baseColormapKey('viridis'), 'viridis', 'identity for a forward key')
  assert.equal(toggleReversedKey('coolwarm'), 'coolwarm_r')
  assert.equal(toggleReversedKey('coolwarm_r'), 'coolwarm', 'the toggle round-trips')
  // A reversed twin is registered on NiiVue so it can be applied, but must never reach the dropdown
  // -- listing both directions of every map would double a list that is already ~60 long.
  const reg = buildColormapRegistry(['viridis', 'viridis_r', 'coolwarm', 'coolwarm_r'])
  assert.deepEqual(reg.filter((c) => isReversedKey(c.key)), [], 'no reversed keys are offered')
  assert.equal(reg.filter((c) => c.key === 'viridis').length, 1)
  ok('reversed keys round-trip and stay out of the picker list')
}

// --- the diverging family is curated -------------------------------------------------------------
{
  const keys = ['piyg', 'prgn', 'brbg', 'puor', 'rdgy', 'rdbu', 'rdylbu', 'rdylgn', 'spectral', 'coolwarm', 'bwr', 'seismic']
  const reg = buildColormapRegistry(keys)
  for (const key of keys) {
    assert.equal(reg.find((c) => c.key === key)?.group, 'Diverging', `${key} is grouped Diverging`)
  }
  // Acronym-style names keep their matplotlib casing (docs/design_guideline/text-casing.md).
  assert.equal(reg.find((c) => c.key === 'prgn')?.label, 'PRGn')
  assert.equal(reg.find((c) => c.key === 'piyg')?.label, 'PiYG')
  assert.equal(reg.find((c) => c.key === 'bwr')?.label, 'BWR')
  assert.equal(reg.find((c) => c.key === 'coolwarm')?.label, 'coolwarm')
  ok('every matplotlib diverging map lands in the Diverging group with its published casing')
}

// --- display names ------------------------------------------------------------------------------
assert.equal(colormapDisplayName('coolwarm'), 'coolwarm')
assert.equal(colormapDisplayName('coolwarm_r'), 'coolwarm (reversed)')
assert.equal(colormapDisplayName('prgn_r'), 'PRGn (reversed)')
assert.equal(colormapDisplayName('weird_map'), 'weird map', 'unknown keys still prettify')
ok('colormapDisplayName names reversed twins in prose instead of leaking the key')

assert.equal(prettifyLabel('blue2red'), 'blue2red', 'prettify simple')
assert.equal(prettifyLabel('rd_bu'), 'rd bu', 'prettify underscores')
ok('prettifyLabel lower-cases colormap keys')

console.log(`colormap_util_test: ${passed} checks passed`)
