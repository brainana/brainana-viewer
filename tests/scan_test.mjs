// Scan selection rules (viewer/src/state/scan.ts).
//
// These decide which reconstruction the viewer opens on and whether a crosshair may be carried
// across a switch. Both are cases where the wrong answer is invisible: the viewer would show a
// real brain, just not the one the user meant, or a coordinate in the wrong frame.
import assert from 'node:assert/strict'
import { groupScans, defaultScan, matchScan, sameSpace, hasChoice, scanTooltip } from '../apps/viewer/src/state/scan.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const scan = (id, stream, session, isDefault = false, subjectId = 'sub-a') => ({ id, subjectId, session, stream, label: id, isDefault })

const LONGITUDINAL = [
  scan('sub-a_ses-001', 'cross', 'ses-001', true),
  scan('sub-a_ses-002', 'cross', 'ses-002'),
  scan('sub-a_base', 'base', null),
  scan('sub-a_ses-001_long', 'long', 'ses-001'),
  scan('sub-a_ses-002_long', 'long', 'ses-002'),
]

// --- grouping ---------------------------------------------------------------------------------
{
  const { cross, longitudinal } = groupScans(LONGITUDINAL)
  assert.deepEqual(cross.map((s) => s.id), ['sub-a_ses-001', 'sub-a_ses-002'])
  assert.deepEqual(longitudinal.map((s) => s.id), ['sub-a_base', 'sub-a_ses-001_long', 'sub-a_ses-002_long'])
  assert.deepEqual(groupScans([]), { cross: [], longitudinal: [] })
  ok('scans group into cross-sectional and longitudinal, base among the latter')
}

// --- the default ------------------------------------------------------------------------------
// The base template wins wherever there is one: it is the only scan carrying the change maps, and
// the change tab is hidden without them, so opening anywhere else hides the feature entirely.
assert.equal(defaultScan(LONGITUDINAL).id, 'sub-a_base')
// Order and the server's own isDefault flag do not change that.
{
  const crossFirst = [scan('sub-a_ses-001', 'cross', 'ses-001', true), scan('sub-a_base', 'base', null)]
  assert.equal(defaultScan(crossFirst).stream, 'base', 'the base template carries the change maps')
  assert.equal(defaultScan(crossFirst).id, 'sub-a_base')
}
// A subject with no base template is unaffected: a cross-sectional scan, isDefault respected.
{
  const crossOnly = [scan('sub-a_ses-001', 'cross', 'ses-001'), scan('sub-a_ses-002', 'cross', 'ses-002', true)]
  assert.equal(defaultScan(crossOnly).id, 'sub-a_ses-002')
}
assert.equal(defaultScan([]), null)
// A subject with ONLY base-seeded timepoints and no base still has to open on something.
assert.equal(defaultScan([scan('sub-a_ses-001_long', 'long', 'ses-001')]).id, 'sub-a_ses-001_long')
ok('the default scan is the base template wherever there is one, else a cross-sectional scan')

// --- carrying a choice across a subject switch --------------------------------------------------
assert.equal(matchScan(LONGITUDINAL, 'sub-a_base').id, 'sub-a_base', 'an exact id wins')
assert.equal(matchScan(LONGITUDINAL, 'sub-zz_ses-009', 'long').id, 'sub-a_ses-001_long', 'else the same stream')
assert.equal(matchScan(LONGITUDINAL, 'sub-zz_ses-009').id, 'sub-a_base', 'else the default')
assert.equal(matchScan([], 'anything'), null)
// A subject that simply has no longitudinal stream must not end up on nothing.
assert.equal(matchScan([scan('sub-b', 'cross', null)], 'sub-a_base', 'base').id, 'sub-b')
ok('a scan choice carries across a subject switch, degrading to the stream then the default')

// --- same space? ---------------------------------------------------------------------------------
// The base and every base-seeded timepoint share one mesh and one frame; that is the entire point
// of the longitudinal stream. Two cross-sectional sessions do NOT.
assert.equal(sameSpace(LONGITUDINAL[2], LONGITUDINAL[3]), true, 'base <-> long')
assert.equal(sameSpace(LONGITUDINAL[3], LONGITUDINAL[4]), true, 'long <-> long')
assert.equal(sameSpace(LONGITUDINAL[0], LONGITUDINAL[1]), false, 'two cross sessions are different frames')
assert.equal(sameSpace(LONGITUDINAL[0], LONGITUDINAL[2]), false, 'cross <-> base')
assert.equal(sameSpace(LONGITUDINAL[0], LONGITUDINAL[0]), true, 'a scan is itself')
assert.equal(sameSpace(LONGITUDINAL[0], null), false)
assert.equal(sameSpace(null, null), false)
// Never across subjects, whatever the streams.
assert.equal(sameSpace(scan('sub-a_base', 'base', null), scan('sub-b_base', 'base', null, false, 'sub-b')), false)
ok('sameSpace holds within the base/long family of one subject, and nowhere else')

// --- picker affordances ---------------------------------------------------------------------------
assert.equal(hasChoice(LONGITUDINAL), true)
assert.equal(hasChoice([scan('sub-b', 'cross', null)]), false)
assert.equal(hasChoice([]), false)
for (const s of LONGITUDINAL) {
  const tip = scanTooltip(s)
  assert.ok(tip.length > 0 && /[.]$/.test(tip), `${s.id} has a full-sentence tooltip`)
}
assert.match(scanTooltip(LONGITUDINAL[2]), /template/i, 'the base explains what it is')
assert.match(scanTooltip(LONGITUDINAL[3]), /vertex numbering|base template/i, 'a long scan explains the shared mesh')
ok('every scan carries a tooltip explaining what its stream means')

console.log(`scan_test: ${passed} checks passed`)
