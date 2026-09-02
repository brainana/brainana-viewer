// Unit tests for the bookmark store (apps/viewer/src/report/bookmarks.ts).
import assert from 'node:assert/strict'
import { BookmarkStore, bookmarkName } from '../apps/viewer/src/report/bookmarks.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const readout = (x) => ({
  mm: [x, 0, 0],
  voxel: [x, 0, 0],
  hemisphere: 'left',
  vertex: null,
  atlases: [],
  morphology: null,
  retinotopy: null,
  somatotopy: null,
  overlay: null,
})

const store = new BookmarkStore()
assert.equal(store.count(), 0)
assert.deepEqual(store.list(), [])

const a = store.add({ readout: readout(1), activeOverlay: 'atlas · D99' })
const b = store.add({ readout: readout(2), activeOverlay: 'none' })
assert.equal(store.count(), 2)
assert.notEqual(a.id, b.id)
assert.equal(a.activeOverlay, 'atlas · D99', 'the overlay active at add time is recorded')
assert.equal(a.shots, null, 'screenshots are taken at generation time, not at add time')
assert.ok(!Number.isNaN(Date.parse(a.addedAt)), 'addedAt is a parseable timestamp')
ok('add stores a readout with a unique id, timestamp and the active overlay')

// list() must be a defensive copy — the dialog renders from it and must not be able to mutate state.
const listed = store.list()
listed.push('junk')
assert.equal(store.count(), 2, 'mutating the returned list does not affect the store')
ok('list returns a defensive copy')

// Ids are never reused: a stale remove must not delete a later point.
const staleId = a.id
store.remove(a.id)
const c = store.add({ readout: readout(3), activeOverlay: 'none' })
assert.notEqual(c.id, staleId, 'a new point never inherits a removed point’s id')
store.remove(staleId) // replaying the stale remove must be a no-op
assert.equal(store.count(), 2)
assert.deepEqual(
  store.list().map((x) => x.readout.mm[0]),
  [2, 3],
)
ok('removed ids are never reused, so a replayed remove is a no-op')

store.remove('does-not-exist')
assert.equal(store.count(), 2, 'removing an unknown id is ignored')
ok('removing an unknown id is ignored')

// Naming: default to the ordinal so removals renumber contiguously, and honour a custom label.
assert.equal(bookmarkName(store.list()[0], 0), 'Bookmarked #1')
assert.equal(bookmarkName(store.list()[1], 1), 'Bookmarked #2')
store.rename(b.id, '  V1 border  ')
assert.equal(store.list()[0].label, 'V1 border', 'a custom label is trimmed')
assert.equal(bookmarkName(store.list()[0], 0), 'V1 border')
ok('names fall back to a contiguous ordinal and honour a trimmed custom label')

// Clearing a name reverts to the ordinal rather than showing a blank row.
store.rename(b.id, '   ')
assert.equal(store.list()[0].label, null)
assert.equal(bookmarkName(store.list()[0], 0), 'Bookmarked #1')
store.rename('does-not-exist', 'x') // must not throw
ok('a blank name reverts to the ordinal')

// --- subscriptions ---
const seen = []
const unsubscribe = store.subscribe((items) => seen.push(items.length))
assert.deepEqual(seen, [2], 'subscribe fires immediately with the current list')
store.add({ readout: readout(4), activeOverlay: 'none' })
store.remove(c.id)
store.rename(b.id, 'renamed')
assert.deepEqual(seen, [2, 3, 2, 2], 'add, remove and rename each notify')
unsubscribe()
store.add({ readout: readout(5), activeOverlay: 'none' })
assert.deepEqual(seen, [2, 3, 2, 2], 'no notification after unsubscribe')
ok('subscribers see the current list and every subsequent change')

// --- clear (fired on a subject switch: coordinates are subject-space) ---
const events = []
const store2 = new BookmarkStore()
store2.subscribe((items) => events.push(items.length))
store2.clear()
assert.deepEqual(events, [0], 'clearing an empty store does not fire a redundant event')
store2.add({ readout: readout(1), activeOverlay: 'none' })
store2.clear()
assert.equal(store2.count(), 0)
assert.deepEqual(events, [0, 1, 0])
ok('clear empties the store and only notifies when something changed')

console.log(`\nreport_bookmarks_test: ${passed} checks passed`)
