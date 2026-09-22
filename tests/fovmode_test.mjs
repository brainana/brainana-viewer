// Unit tests for the FOV mode state helpers (viewer/src/state/fovMode.ts).
// Run via Node's native TypeScript support (Node >= 22.18 strips types on import).
import assert from 'node:assert/strict'
import {
  FOV_MODES,
  resolveFovMode,
  fovTooltip,
  loadFovPreference,
  saveFovPreference,
} from '../apps/viewer/src/state/fovMode.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// A minimal localStorage stand-in; the module reads the global lazily so tests can swap it.
function installStorage() {
  const map = new Map()
  const stub = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  }
  globalThis.localStorage = stub
  return { map, stub }
}
function clearStorage() {
  delete globalThis.localStorage
}

// --- FOV_MODES is the ordered pair the segmented control renders ---
{
  assert.deepEqual(
    FOV_MODES.map((m) => m.mode),
    ['best', 'full'],
    'best comes first (it is the default and the processing FOV)',
  )
  for (const m of FOV_MODES) {
    assert.equal(m.label, m.label.toLowerCase(), `label "${m.label}" is lowercase per the casing guideline`)
    assert.ok(m.title.length > 0, 'every mode carries a tooltip')
  }
  ok('FOV_MODES lists best then full with lowercase labels and tooltips')
}

// --- resolveFovMode: the preference only takes effect when the file exists ---
{
  assert.equal(resolveFovMode('full', true), 'full', 'full honoured when the subject has a full-FOV volume')
  assert.equal(resolveFovMode('full', false), 'best', 'full falls back to best when the volume is missing')
  assert.equal(resolveFovMode('best', true), 'best', 'best stays best even when full is available')
  assert.equal(resolveFovMode('best', false), 'best', 'best stays best when nothing is available')
  ok('resolveFovMode falls back to best only when the full-FOV volume is absent')
}

// --- resolveFovMode is pure: it must not rewrite the stored preference ---
{
  const { map } = installStorage()
  saveFovPreference('full')
  assert.equal(resolveFovMode('full', false), 'best', 'displayed mode degrades')
  assert.equal(loadFovPreference(), 'full', 'stored preference is untouched, so it re-engages on the next subject')
  assert.equal(map.size, 1, 'exactly one key written')
  clearStorage()
  ok('a subject without the volume degrades the display without clearing the preference')
}

// --- preference round-trip, and the guards around a hostile/absent storage ---
{
  installStorage()
  assert.equal(loadFovPreference(), 'best', 'defaults to best with nothing stored')
  saveFovPreference('full')
  assert.equal(loadFovPreference(), 'full', 'round-trips full')
  saveFovPreference('best')
  assert.equal(loadFovPreference(), 'best', 'round-trips best')
  globalThis.localStorage.setItem('brainana.fovMode.v1', 'nonsense')
  assert.equal(loadFovPreference(), 'best', 'an unrecognised stored value falls back to best')
  clearStorage()
  ok('preference round-trips and rejects unrecognised stored values')
}

{
  clearStorage()
  assert.equal(loadFovPreference(), 'best', 'no localStorage at all still yields a usable default')
  assert.doesNotThrow(() => saveFovPreference('full'), 'saving without localStorage is a no-op, not a throw')
  ok('missing localStorage degrades to the default instead of throwing')
}

{
  // Safari private mode: present but throws on write.
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => {},
  }
  assert.equal(loadFovPreference(), 'best', 'a throwing storage reads as the default')
  assert.doesNotThrow(() => saveFovPreference('full'), 'a throwing storage does not break the toggle')
  clearStorage()
  ok('a storage that throws on access is tolerated')
}

// --- fovTooltip: explains the disabled state and the degenerate-but-valid cases ---
{
  const missing = fovTooltip(null)
  assert.match(missing, /full-FOV/i, 'names the missing output')
  assert.match(missing, /2\.1/, 'names the brainana version that produces it')

  const expanded = fovTooltip({ url: 'u', label: 'l', status: 'expanded' })
  assert.doesNotMatch(expanded, /no expansion/i, 'a genuinely expanded volume gets no caveat')

  for (const status of ['no_expansion_needed', 'fallback']) {
    const t = fovTooltip({ url: 'u', label: 'l', status })
    assert.match(t, /no expansion|identical/i, `${status} warns that the image matches the cropped one`)
  }

  const unknown = fovTooltip({ url: 'u', label: 'l', status: null })
  assert.ok(unknown.length > 0, 'an unreadable sidecar still yields a usable tooltip')
  assert.doesNotMatch(unknown, /undefined|null/, 'no placeholder leaks into the UI string')
  ok('fovTooltip covers missing, expanded, degenerate and unknown-status volumes')
}

// --- a longitudinal scan never has a full-FOV conform ------------------------------------------
// It is built in the base template's space from already-conformed volumes, so the generic
// "reprocess with brainana 2.1 or newer" line would be advice that cannot work.
{
  assert.match(fovTooltip(null, 'cross'), /Reprocess with brainana/, 'the generic advice still applies to a cross-sectional scan')
  assert.match(fovTooltip(null, null), /Reprocess with brainana/, 'and when the stream is unknown')
  for (const stream of ['base', 'long']) {
    const tip = fovTooltip(null, stream)
    assert.doesNotMatch(tip, /Reprocess/i, `${stream}: does not advise a reprocess that cannot help`)
    assert.match(tip, /base template/i, `${stream}: explains why instead`)
  }
  // A scan that DOES have one is unaffected by the stream.
  const present = { url: '/x', label: 'T1w (full FOV)', status: 'expanded' }
  assert.equal(fovTooltip(present, 'base'), fovTooltip(present, 'cross'))
  ok('a longitudinal scan explains why it has no full-FOV conform instead of advising a reprocess')
}

console.log(`fovmode_test: ${passed} checks passed`)
