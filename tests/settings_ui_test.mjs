// The settings dialog (apps/viewer/src/settings/settingsUI.ts) in a DOM: section navigation,
// autosave, actions, reset, import, keyboard handling and teardown.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const dom = new JSDOM('<!doctype html><button id="opener">settings</button>', { url: 'http://127.0.0.1:5173', pretendToBeVisual: true })
const { window } = dom
const { document, KeyboardEvent } = window
Object.assign(globalThis, {
  window,
  document: window.document,
  localStorage: window.localStorage,
  HTMLElement: window.HTMLElement,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  KeyboardEvent: window.KeyboardEvent,
})

const { loadPreferences, prefs, DEFAULTS } = await import('../apps/viewer/src/settings/preferences.ts')
const { openSettings, closeSettings, settingsOpen } = await import('../apps/viewer/src/settings/settingsUI.ts')
loadPreferences()

const $ = (sel) => document.querySelector(sel)
const change = (sel, value) => {
  const el = $(sel)
  if (el.type === 'checkbox') el.checked = value
  else el.value = String(value)
  el.dispatchEvent(new Event('change'))
}
const button = (label) => [...document.querySelectorAll('#viewer-settings button')].find((b) => b.textContent === label)
const tick = () => new Promise((r) => setTimeout(r, 0))

let applied = 0
let fov = 'best'
const actions = {
  applyToView: async () => {
    applied++
  },
  resetPanels: () => {},
  fov: () => fov,
  setFov: (mode) => {
    fov = mode
  },
}

// --- open, structure, focus --------------------------------------------------------------------------
$('#opener').focus()
openSettings(actions)
openSettings(actions) // a second open is a no-op
assert.equal(document.querySelectorAll('#viewer-settings').length, 1)
assert.equal($('.settings-dialog').getAttribute('role'), 'dialog')
const tabs = [...document.querySelectorAll('.settings-tab')]
assert.deepEqual(
  tabs.map((t) => t.textContent),
  ['viewing', 'navigation', 'reports', 'appearance'],
)
assert.equal($('.settings-tab.active').dataset.section, 'viewing')
assert.equal(document.activeElement, tabs[0])
ok('opens once, with a tablist of sections and focus on the active tab')

// --- autosave ----------------------------------------------------------------------------------------
change('#settings-viewing-surface', 'pial')
change('#settings-viewing-markerSize', 40)
assert.equal(prefs().viewing.surface, 'pial')
assert.equal(prefs().viewing.markerSize, 3)
assert.equal($('#settings-viewing-markerSize').value, '3', 'the clamped value is shown')
assert.equal(JSON.parse(localStorage.getItem('brainana.viewer.preferences.v1')).viewing.surface, 'pial')
change('#settings-viewing-fov', 'full')
assert.equal(fov, 'full', 'FOV goes to the sticky toolbar choice')
ok('changes save immediately and are bounded')

button('apply to current view').click()
await tick()
await tick()
assert.equal(applied, 1)
assert.match($('#viewer-settings .msg').textContent, /applied/)
ok('apply to current view runs the dashboard action and reports it')

// --- sections + keyboard -----------------------------------------------------------------------------
$('.settings-tab.active').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
assert.equal($('.settings-tab.active').dataset.section, 'navigation')
assert.ok($('#settings-navigation-arrowStep'))
tabs[3].click()
change('#settings-appearance-theme', 'contrast')
assert.equal(document.documentElement.dataset.theme, 'contrast')
ok('arrow keys and clicks switch sections; appearance applies at once')

button('reset section').click()
assert.equal(prefs().appearance.theme, DEFAULTS.appearance.theme)
assert.equal(prefs().viewing.surface, 'pial', 'reset touches only the current section')
assert.equal($('#settings-appearance-theme').value, DEFAULTS.appearance.theme, 're-rendered')
ok('reset section restores only that section')

// --- close ------------------------------------------------------------------------------------------
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
assert.equal(settingsOpen(), false)
assert.equal($('#viewer-settings'), null)
assert.equal(document.activeElement, $('#opener'), 'focus returns to the opener')
openSettings(actions)
assert.equal($('#settings-viewing-surface').value, 'pial', 'reopening shows the saved value')
closeSettings()
assert.equal($('#viewer-settings'), null)
ok('Escape closes and restores focus; reopening renders current settings')

console.log(`settings_ui_test: ${passed} checks passed`)
