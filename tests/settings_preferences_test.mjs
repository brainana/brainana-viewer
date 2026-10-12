// Personal settings model (apps/viewer/src/settings/preferences.ts): validation of stored and
// imported settings, persistence, and the settings-file format.
import assert from 'node:assert/strict'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const map = new Map()
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
}
const events = []
globalThis.window = { dispatchEvent: (e) => events.push(e.type) }

const { DEFAULTS, PREFERENCES_KEY, normalizePreferences, loadPreferences, savePreferences, prefs, exportPreferences, parseSettingsFile, hexToRgba } = await import(
  '../apps/viewer/src/settings/preferences.ts'
)

// --- normalization ---------------------------------------------------------------------------------
assert.deepEqual(normalizePreferences(null), DEFAULTS)
assert.deepEqual(normalizePreferences('nonsense'), DEFAULTS)
{
  const p = normalizePreferences({
    appearance: { theme: 'neon', textSize: 'large', largeControls: 'yes' },
    viewing: { layout: 'grid', surface: '../../etc', markerSize: 99, crosshairWidth: -3, crosshairColor: 'red', left: false, right: false, extra: 1 },
    navigation: { arrowStep: Number.NaN, reverseScroll: true },
    unknownSection: { a: 1 },
  })
  assert.equal(p.appearance.theme, DEFAULTS.appearance.theme, 'unknown enum value falls back')
  assert.equal(p.appearance.textSize, 'large')
  assert.equal(p.appearance.largeControls, false, 'wrong type falls back')
  assert.equal(p.viewing.layout, 'grid')
  assert.equal(p.viewing.surface, DEFAULTS.viewing.surface)
  assert.equal(p.viewing.markerSize, 3, 'numbers are clamped')
  assert.equal(p.viewing.crosshairWidth, 1)
  assert.equal(p.viewing.crosshairColor, DEFAULTS.viewing.crosshairColor, 'colours must be #rrggbb')
  assert.equal(p.viewing.left, true, 'at least one hemisphere stays visible')
  assert.equal(p.navigation.arrowStep, DEFAULTS.navigation.arrowStep, 'non-finite numbers fall back')
  assert.equal(p.navigation.reverseScroll, true)
  assert.equal('extra' in p.viewing, false)
  assert.equal('unknownSection' in p, false)
}
ok('stored values are type-checked, bounded and stripped of unknown keys')

// --- persistence -----------------------------------------------------------------------------------
loadPreferences()
assert.deepEqual(prefs(), DEFAULTS, 'no saved settings → defaults')
savePreferences({ ...structuredClone(DEFAULTS), navigation: { reverseScroll: true, arrowStep: 2 } })
assert.equal(JSON.parse(map.get(PREFERENCES_KEY)).navigation.arrowStep, 2)
assert.deepEqual(events, ['brainana-preferences-changed'])
map.set(PREFERENCES_KEY, '{broken json')
loadPreferences()
assert.deepEqual(prefs(), DEFAULTS, 'corrupt storage reads as defaults')
ok('saving persists and notifies; corrupt storage falls back to defaults')

// --- settings files --------------------------------------------------------------------------------
savePreferences({ ...structuredClone(DEFAULTS), reports: { screenshots: false, destination: 'dataset' } })
const file = exportPreferences()
assert.equal(parseSettingsFile(file).reports.destination, 'dataset', 'export → import round-trips')
assert.throws(() => parseSettingsFile('not json'), /invalid JSON/)
assert.throws(() => parseSettingsFile(JSON.stringify({ app: 'brainana-align', kind: 'settings', version: 1 })), /not a Brainana Viewer settings file/)
assert.throws(() => parseSettingsFile(JSON.stringify(DEFAULTS)), /not a Brainana Viewer settings file/)
assert.equal(parseSettingsFile(JSON.stringify({ app: 'brainana-viewer', kind: 'settings', version: 1, preferences: { viewing: { markerSize: 50 } } })).viewing.markerSize, 3)
ok('settings files round-trip; other apps’ files and bare objects are refused; imports are bounded')

// --- FOV keeps its single source of truth ------------------------------------------------------------
assert.equal('fov' in DEFAULTS.viewing, false, 'FOV lives in state/fovMode.ts, not in preferences')
ok('the FOV choice is not duplicated into preferences')

assert.deepEqual(hexToRgba('#ff0000'), [1, 0, 0, 1])
ok('hex colours convert to NiiVue rgba')

console.log(`settings_preferences_test: ${passed} checks passed`)
