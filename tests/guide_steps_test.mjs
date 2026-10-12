// Guided tour content (apps/viewer/src/ui/guide/steps.ts): setup steps follow real state, the tour
// lists only features the subject has, and every step points at an anchor that exists.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupStep, tourSteps, tourFeatures } from '../apps/viewer/src/ui/guide/steps.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const none = tourFeatures(null)
const base = { datasets: 0, subjects: 0, dialogOpen: false, remoteOpen: false, connected: false, loading: false, loaded: false, error: null, features: none, activePanel: null, reportOpen: false }
const at = (patch) => setupStep({ ...base, ...patch })?.key ?? null

// --- setup ---------------------------------------------------------------------------------------
assert.equal(at({}), 'dataset')
assert.equal(at({ dialogOpen: true }), 'local-folder')
assert.equal(at({ dialogOpen: true, remoteOpen: true }), 'connect')
assert.equal(at({ dialogOpen: true, remoteOpen: true, connected: true }), 'remote-folder')
assert.equal(at({ dialogOpen: true, datasets: 1 }), 'continue')
assert.equal(at({ datasets: 1, subjects: 3 }), 'subject')
assert.equal(at({ datasets: 1, subjects: 3, loading: true }), 'loading')
assert.equal(at({ datasets: 1, subjects: 3, error: 'boom' }), 'error')
assert.equal(at({ datasets: 1, subjects: 3, loaded: true, error: 'boom' }), 'error', 'a failed switch is reported even with a subject on screen')
assert.equal(at({ datasets: 1, subjects: 3, loaded: true }), null, 'loaded → the tour takes over')
ok('setup steps follow the actual state, from no dataset to a loaded subject')

// --- tour roster -------------------------------------------------------------------------------------
const loaded = { ...base, datasets: 1, subjects: 1, loaded: true }
const minimal = tourSteps(loaded).map((s) => s.key)
assert.deepEqual(minimal, ['navigate', 'layout', 'readouts', 'points', 'report', 'settings', 'done'])
const all = { volume: true, surfaces: true, fullFov: true, atlases: true, morphology: true, retinotopy: true, somatotopy: true, changes: true, scans: true }
const full = tourSteps({ ...loaded, subjects: 2, features: all })
const keys = full.map((s) => s.key)
for (const k of ['volume', 'underlay', 'fov', 'surface', 'marker', 'atlas', 'morphology', 'function', 'visual-field', 'changes', 'colors', 'scans', 'subjects']) assert.ok(keys.includes(k), k)
assert.equal(new Set(keys).size, keys.length, 'stop keys are unique')
assert.ok(full.every((s) => s.text.length <= 200), 'every stop is short')
ok('the tour lists only the features the subject has')

const atlas = (activePanel) => tourSteps({ ...loaded, features: all, activePanel }).find((s) => s.key === 'atlas')
assert.equal(atlas(null).target, '#tour-atlas')
assert.equal(atlas('atlas').target, '#tour-atlas-panel')
assert.equal(tourSteps({ ...loaded, features: all, activePanel: 'longitudinal' }).find((s) => s.key === 'changes').target, '#tour-change-panel')
assert.equal(atlas(null).action.tab, '#tour-atlas')
ok('a side-panel stop points at its tab, then at the open panel')

// --- tour features from a manifest -------------------------------------------------------------------
const pair = { left: 'l', right: 'r' }
const f = tourFeatures({ volumes: [{}], surfaces: { pial: pair }, fullFov: { url: 'x' }, atlases: [], morphology: { shape: { curvature: pair } }, scans: [{}] })
assert.deepEqual(
  { volume: f.volume, surfaces: f.surfaces, fullFov: f.fullFov, atlases: f.atlases, morphology: f.morphology, scans: f.scans },
  { volume: true, surfaces: true, fullFov: true, atlases: false, morphology: true, scans: false },
)
assert.equal(tourFeatures({ volumes: [], surfaces: { pial: { left: 'l' } } }).surfaces, false, 'a half pair is not a surface')
ok('features come from real files, not from toolbar tabs')

// --- anchors exist -----------------------------------------------------------------------------------
// Every `#id` a step targets must be created somewhere in the viewer, or the guide silently
// highlights nothing. Panel tab ids are built from PANEL_BUTTONS, so check that mapping instead.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const sources = ['apps/viewer/src/ui/dashboard.ts', 'apps/viewer/src/ui/dialogs/sources.ts'].map(read).join('\n')
const targets = new Set([...full, ...tourSteps({ ...loaded, features: all, activePanel: 'atlas' })].map((s) => s.target))
for (const k of ['dataset', 'local-folder', 'connect', 'remote-folder', 'continue', 'subject', 'error']) {
  const patch = { dataset: {}, 'local-folder': { dialogOpen: true }, connect: { dialogOpen: true, remoteOpen: true }, 'remote-folder': { dialogOpen: true, remoteOpen: true, connected: true }, continue: { dialogOpen: true, datasets: 1 }, subject: { datasets: 1 }, error: { error: 'x' } }[k]
  targets.add(setupStep({ ...base, ...patch }).target)
}
const missing = []
for (const t of targets) {
  if (t === '.report-dialog') continue // the report dialog's own class
  const id = t.replace(/^#/, '')
  const tab = /^tour-(atlas|morphology|function|change)$/.exec(id)
  if (tab) {
    if (!sources.includes("id: `tour-${name === 'func map' ? 'function' : name}`")) missing.push(id)
    continue
  }
  if (!sources.includes(`'${id}'`)) missing.push(id)
}
// The guide's helpers click a few controls directly, too.
for (const m of read('apps/viewer/src/ui/guide/guide.ts').matchAll(/'#((?:tour|monkey)-[a-z-]+)'/g)) {
  if (!sources.includes(`'${m[1]}'`)) missing.push(m[1])
}
assert.deepEqual(missing, [], 'every guide target id exists in the viewer')
ok('every highlighted control exists')

console.log(`guide_steps_test: ${passed} checks passed`)
