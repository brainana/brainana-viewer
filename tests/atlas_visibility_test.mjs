// ROI legend visibility (apps/viewer/src/ui/roiLegend.ts): row clicks, shift-click isolation,
// bulk show/hide/invert, search, and the reset on atlas switch. The guided tour describes exactly
// these behaviours, so they are pinned here.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const dom = new JSDOM('<!doctype html><div id="legend"></div>')
Object.assign(globalThis, { window: dom.window, document: dom.window.document })
const { RoiLegend } = await import('../apps/viewer/src/ui/roiLegend.ts')

const root = dom.window.document.querySelector('#legend')
let hidden = new Set()
const legend = new RoiLegend(root, { onHiddenChange: (next) => (hidden = new Set(next)) })
const entries = [1, 2, 3].map((id) => ({ id, name: `Region ${id}`, region: '', hemi: '' }))
legend.setAtlas('ARM', entries, 42)
const row = (id) => root.querySelector(`[data-roi-id="${id}"]`)
const bulk = (label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label).click()

row(1).click()
assert.ok(hidden.has(1))
assert.equal(row(1).getAttribute('aria-pressed'), 'false')
row(1).click()
assert.ok(!hidden.has(1))
assert.equal(row(1).getAttribute('aria-pressed'), 'true')
row(2).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey: true }))
assert.deepEqual([...hidden].sort(), [1, 3])
ok('a click toggles a region (and its pressed state); shift-click isolates it')

bulk('show all')
assert.equal(hidden.size, 0)
bulk('hide all')
assert.equal(hidden.size, 3)
bulk('invert')
assert.equal(hidden.size, 0)
ok('show all / hide all / invert act on every region')

const search = root.querySelector('.legend-search')
search.value = 'Region 2'
search.dispatchEvent(new dom.window.Event('input'))
await new Promise((r) => setTimeout(r, 150))
assert.equal(root.querySelectorAll('.legend-row').length, 1)
assert.equal(hidden.size, 0, 'search filters the list, not the brain')
bulk('hide all')
assert.equal(hidden.size, 3, 'bulk actions include regions filtered out of the list')
legend.setAtlas('D99', entries, 42)
assert.equal(search.value, '')
assert.equal(hidden.size, 0)
assert.equal(root.querySelectorAll('.legend-row').length, 3)
ok('search only filters; switching atlas resets search and visibility')

dom.window.close()
console.log(`atlas_visibility_test: ${passed} checks passed`)
