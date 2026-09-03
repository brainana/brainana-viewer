// Unit tests for core-server/dataSource.mjs pure helpers: HTTP Range parsing (incl. RFC 7233
// suffix ranges), content-type mapping, and the in-process SourceRegistry. No filesystem or
// network — these run identically on every platform.
import assert from 'node:assert/strict'
import { parseRange, contentTypeFor, SourceRegistry } from '@brainana/core-server/dataSource.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- parseRange ---
assert.deepEqual(parseRange('bytes=2-5', 1000), { start: 2, end: 5 }, 'explicit range')
assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 }, 'open-ended range')
assert.deepEqual(parseRange('bytes=0-0', 1000), { start: 0, end: 0 }, 'single-byte range')
assert.deepEqual(parseRange('bytes=2-100000', 1000), { start: 2, end: 999 }, 'end clamped to EOF')
// Suffix ranges: the final N bytes (the bug this fixes — used to return the FIRST N+1 bytes).
assert.deepEqual(parseRange('bytes=-500', 1000), { start: 500, end: 999 }, 'suffix = last 500 bytes')
assert.deepEqual(parseRange('bytes=-2000', 1000), { start: 0, end: 999 }, 'suffix larger than file = whole file')
ok('parseRange handles explicit, open-ended, clamped, and suffix ranges per RFC 7233')

assert.equal(parseRange('bytes=2000-3000', 100), null, 'start beyond EOF is unsatisfiable')
assert.equal(parseRange('bytes=-', 100), null, '"bytes=-" names no range')
assert.equal(parseRange('bytes=-0', 100), null, 'zero-length suffix is unsatisfiable')
assert.equal(parseRange('bytes=abc', 100), null, 'garbage header is ignored')
assert.equal(parseRange('bytes=5-2', 100), null, 'start > end is invalid')
assert.equal(parseRange('', 100), null, 'empty header')
assert.equal(parseRange(undefined, 100), null, 'missing header')
ok('parseRange rejects unsatisfiable, empty, reversed, and malformed ranges')

// --- contentTypeFor (case-insensitive; .nii.gz must not be shadowed by .nii) ---
assert.equal(contentTypeFor('x.gii'), 'application/gifti+xml')
assert.equal(contentTypeFor('x.nii'), 'application/octet-stream')
assert.equal(contentTypeFor('x.nii.gz'), 'application/gzip')
assert.equal(contentTypeFor('X.NII.GZ'), 'application/gzip', 'upper-case extension')
assert.equal(contentTypeFor('data.json'), 'application/json')
assert.equal(contentTypeFor('noext'), 'application/octet-stream', 'unknown falls back to octet-stream')
ok('contentTypeFor maps known extensions case-insensitively')

// --- SourceRegistry ---
async function registryChecks() {
  const reg = new SourceRegistry()
  let closed = 0
  const mk = (label) => ({ type: 'local', label, close: async () => { closed++ } })

  const a = reg.add(mk('A'), { type: 'local' })
  assert.match(a.id, /^local-[0-9a-f]{12}$/, 'add mints a typed id')
  assert.equal(reg.get(a.id), a, 'get returns the stored source')
  assert.equal(reg.get('missing-000000000000'), null, 'get of unknown id is null')

  reg.add(mk('B'), { type: 'local' }) // registered for the list/remove assertions below; handle unused
  assert.deepEqual(reg.list().map((s) => s.label).sort(), ['A', 'B'], 'list summarises all sources')

  assert.equal(await reg.remove(a.id), true, 'remove returns true and closes the source')
  assert.equal(await reg.remove(a.id), false, 'removing a missing id is a no-op')
  assert.equal(closed, 1, 'remove awaited source.close()')

  await reg.closeAll()
  assert.equal(reg.list().length, 0, 'closeAll empties the registry')
  assert.equal(closed, 2, 'closeAll closed the remaining source')
  ok('SourceRegistry add/get/list/remove/closeAll behave and close sources')
}

await registryChecks()

console.log(`dataSource_test: ${passed} checks passed`)

// --- L6: the Range header must be parsed anchored -------------------------------------------
// The pattern was /bytes=(\d*)-(\d*)/ with no anchor, so any header merely CONTAINING "bytes="
// parsed as a valid range. A malformed header should be ignored (null => serve the whole file),
// not half-understood.
for (const junk of ['xbytes=0-1', 'items=0-1', 'foo bytes=0-1', 'BYTES=0-1']) {
  assert.equal(parseRange(junk, 100), null, `${junk} is not a range header`)
}
assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 }, 'a real range still parses')
assert.deepEqual(parseRange('  bytes=0-1  ', 100), { start: 0, end: 1 }, 'surrounding whitespace is tolerated')
ok('parseRange only accepts a properly formed bytes= header')

