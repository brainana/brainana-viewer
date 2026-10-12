// The guided tour's card (apps/viewer/src/ui/guide/guide.ts) in a DOM: opening, highlighting,
// tour navigation, hide/resume, ending, remembered progress and the one-click helpers.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const dom = new JSDOM(
  `<!doctype html><button id="guided-setup">guided setup</button><button id="dataset-open">dataset</button>
   <select id="monkey-select"></select><div id="tour-slices"></div><div id="tour-layout"></div>
   <div id="tour-readouts"></div><div id="tour-points"><button id="tour-add-point">+ point</button></div>
   <button id="tour-report">report</button><button id="settings-open">settings</button>`,
  { url: 'http://127.0.0.1:5173', pretendToBeVisual: true },
)
const { window } = dom
const { document, KeyboardEvent } = window
Object.assign(globalThis, { window, document, localStorage: window.localStorage, HTMLElement: window.HTMLElement, Event: window.Event, CustomEvent: window.CustomEvent })

const { loadPreferences } = await import('../apps/viewer/src/settings/preferences.ts')
const { installGuide, revealWithinScrollers } = await import('../apps/viewer/src/ui/guide/guide.ts')
const { tourFeatures } = await import('../apps/viewer/src/ui/guide/steps.ts')
loadPreferences()

const state = {
  datasets: 0,
  subjects: 0,
  dialogOpen: false,
  remoteOpen: false,
  connected: false,
  loading: false,
  loaded: false,
  error: null,
  features: { ...tourFeatures(null), volume: true },
  activePanel: null,
  reportOpen: false,
}
const calls = []
const button = document.querySelector('#guided-setup')
installGuide(button, {
  readState: () => ({ ...state }),
  openDatasets: () => calls.push('datasets'),
  retry: () => calls.push('retry'),
  openSettings: () => calls.push('settings'),
})
const card = document.querySelector('#guided-card')
const $ = (sel) => card.querySelector(sel)
const tick = () => new Promise((r) => setTimeout(r, 350)) // one poll

// --- setup ---------------------------------------------------------------------------------------
assert.equal(card.hidden, true)
button.click()
assert.equal(card.hidden, false)
assert.equal(button.getAttribute('aria-expanded'), 'true')
assert.equal($('h2').textContent, 'Add a dataset')
assert.ok(document.querySelector('#dataset-open').classList.contains('guided-target'))
assert.equal($('.guide-nav').hidden, true, 'no tour navigation during setup')
$('.guide-actions button').click()
assert.deepEqual(calls, ['datasets'])
ok('opens on the first setup step, highlights its control and runs its helper')

state.datasets = 1
state.subjects = 2
await tick()
assert.equal($('h2').textContent, 'Choose a subject')
assert.ok(document.querySelector('#monkey-select').classList.contains('guided-target'))
assert.ok(!document.querySelector('#dataset-open').classList.contains('guided-target'), 'the old highlight is removed')
ok('advances by itself when the state changes')

// --- tour --------------------------------------------------------------------------------------
state.loaded = true
await tick()
assert.equal($('h2').textContent, 'Your subject is loaded')
assert.equal($('.guide-nav').hidden, false)
const total = $('#guide-stop').options.length
assert.equal($('.guide-progress').textContent, `1 / ${total}`)
assert.equal($('.guide-nav .ghost').disabled, true, 'back is disabled on the first stop')
$('.guide-nav .primary').click()
assert.equal($('#guide-stop').value, 'volume')
assert.equal($('.guide-progress').textContent, `2 / ${total}`)
const stop = $('#guide-stop')
stop.value = 'points'
stop.dispatchEvent(new Event('change'))
assert.equal($('h2').textContent, 'Bookmarks')
assert.equal(JSON.parse(localStorage.getItem('brainana.viewer.guide.v1')).step, 'points', 'progress is remembered')
ok('next/back and the stop list move through the tour; progress is saved')

// --- hide / resume / end ---------------------------------------------------------------------------
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
assert.equal(card.hidden, true)
assert.equal(button.textContent, 'resume guide')
assert.equal(document.querySelectorAll('.guided-target').length, 0, 'no highlight left behind')
button.click()
assert.equal($('h2').textContent, 'Bookmarks', 'resumes where it was')
$('.guide-foot button').click()
assert.equal(card.hidden, true)
assert.equal(button.textContent, 'guided setup')
assert.equal(localStorage.getItem('brainana.viewer.guide.v1'), null)
ok('Escape hides (resume continues); “end tour” resets and forgets progress')

// --- a failed load is surfaced with a retry ------------------------------------------------------------
button.click()
state.error = 'manifest 404'
await tick()
assert.equal($('h2').textContent, 'The subject did not load')
$('.guide-actions button').click()
assert.equal(calls.at(-1), 'retry')
ok('a failed load shows a retry step')

// --- revealing a target scrolls only real scroll containers -------------------------------------------
{
  const host = document.createElement('div')
  host.innerHTML = '<div id="clipped" style="overflow-y:hidden"><div id="scroller" style="overflow-y:auto"><select id="deep"></select></div></div>'
  document.body.append(host)
  const clipped = document.querySelector('#clipped')
  const scroller = document.querySelector('#scroller')
  const deep = document.querySelector('#deep')
  clipped.scrollTop = 25
  scroller.scrollTop = 160
  Object.defineProperty(scroller, 'clientHeight', { value: 100 })
  Object.defineProperty(scroller, 'clientTop', { value: 0 })
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 200, height: 100 })
  deep.getBoundingClientRect = () => ({ top: 20, bottom: 40, height: 20 })
  revealWithinScrollers(deep)
  assert.equal(scroller.scrollTop, 80, 'scrolled up just enough')
  assert.equal(clipped.scrollTop, 25, 'the overflow-hidden ancestor did not move')
  deep.getBoundingClientRect = () => ({ top: 190, bottom: 220, height: 30 })
  revealWithinScrollers(deep)
  assert.equal(scroller.scrollTop, 100, 'scrolled down just enough')
  revealWithinScrollers(null)
  ok('revealing a target scrolls only its scroll containers, never clipped ancestors')
}

console.log(`guide_ui_test: ${passed} checks passed`)
process.exit(0) // the open guide's poll timer would otherwise keep the process alive
