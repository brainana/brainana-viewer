// The report dialog starts from the report defaults in settings, and falls back to download when
// no dataset is open to save into.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const dom = new JSDOM('<!doctype html>', { url: 'http://127.0.0.1:5173' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
})

const { DEFAULTS, loadPreferences, savePreferences } = await import('../apps/viewer/src/settings/preferences.ts')
const { mountReportDialog } = await import('../apps/viewer/src/report/dialog.ts')
const { BookmarkStore } = await import('../apps/viewer/src/report/bookmarks.ts')

loadPreferences()
const client = {
  apiJson: async () => {
    throw new Error('opening the dialog must not touch the network')
  },
}
const context = { dataset: () => ({ subjectId: 'sub-example' }) }
const open = (sourceId) => {
  mountReportDialog({ client, context, bookmarks: new BookmarkStore(), sourceId, sourceLabel: sourceId ? 'dataset A' : null })
  const dialog = dom.window.document.querySelector('.report-dialog')
  const state = {
    screenshots: dialog.querySelector('input[type="checkbox"]').checked,
    dataset: dialog.querySelector('input[value="dataset"]').checked,
    download: dialog.querySelector('input[value="download"]').checked,
  }
  dialog.closest('.overlay').remove()
  return state
}

assert.deepEqual(open('source-a'), { screenshots: true, dataset: false, download: true })
ok('defaults: screenshots on, download')

savePreferences({ ...structuredClone(DEFAULTS), reports: { screenshots: false, destination: 'dataset' } })
assert.deepEqual(open('source-a'), { screenshots: false, dataset: true, download: false })
ok('the report defaults from settings pre-fill the dialog')

assert.deepEqual(open(null), { screenshots: false, dataset: false, download: true })
ok('with no dataset open, the destination falls back to download')

console.log(`report_preferences_test: ${passed} checks passed`)
