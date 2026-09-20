// Longitudinal change-map helpers (viewer/src/data/longitudinal.ts).
//
// The unit of a fitted rate depends on where brainana got its time values. When sessions.tsv has
// no age/acq_time column the fit is against scan order, and the result is a change per SCAN that
// looks exactly like a rate and is quotable as one. Everything here exists so that number can
// never be rendered without its real denominator attached.
import assert from 'node:assert/strict'
import {
  isTimeInterpretable, timeUnit, rateUnitLabel, timeSourceCaveat, timeSourceSummary,
  skippedSummary, exactlyDeterminedNote, symmetricRobustRange, robustRange,
  parseRoiRatesCsv, parseSegmentationAgreement, worstAgreement, MEASURE_TO_STATS, selectRoiRows,
} from '../apps/viewer/src/data/longitudinal.ts'
import { maskSurfaceBinsByMagnitude, quantizeScalarToBins } from '../apps/viewer/src/data/functional.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}
const info = (timeSource, extra = {}) => ({
  stream: 'base', baseSubjectId: 'sub-a_base', timepoints: ['t1', 't2'], times: { t1: 1, t2: 3 },
  timeSource, skipped: {}, ordinalTimeFallback: [], changeMaps: [], roiRates: { left: null, right: null },
  agreement: null, ...extra,
})

// --- the whitelist ------------------------------------------------------------------------------
for (const source of ['age', 'acq_time', 'AGE', ' Age ', 'acquisition date']) {
  assert.equal(isTimeInterpretable(info(source)), true, `${source} is real elapsed time`)
}
// Everything else is NOT interpretable -- including a source a future brainana might add. The list
// is a whitelist precisely so the failure mode is an over-cautious caveat, never a fabricated rate.
for (const source of ['session label', 'scan order', 'ordinal', '', null, undefined, 'some_future_source']) {
  assert.equal(isTimeInterpretable(info(source)), false, `${String(source)} is not real elapsed time`)
}
assert.equal(isTimeInterpretable(null), false)
ok('time sources are whitelisted: an unrecognised one is never treated as real time')

assert.equal(timeUnit(info('age')), 'year')
assert.equal(timeUnit(info('acq_time')), 'day')
assert.equal(timeUnit(info('session label')), 'scan')
assert.equal(timeUnit(null), 'scan')
ok('the denominator follows the time source, defaulting to per-scan')

// --- units travel with every number --------------------------------------------------------------
{
  const rate = { measure: 'thickness', statistic: 'rate' }
  assert.equal(rateUnitLabel(info('age'), rate), 'mm per year')
  assert.equal(rateUnitLabel(info('session label'), rate), 'mm per scan')
  assert.equal(rateUnitLabel(info('acq_time'), rate), 'mm per day')
  // A temporal mean is just the measure; it has no denominator to get wrong.
  assert.equal(rateUnitLabel(info('session label'), { measure: 'thickness', statistic: 'avg' }), 'mm')
  assert.equal(rateUnitLabel(info('age'), { measure: 'area', statistic: 'rate' }), 'mm² per year')
  assert.equal(rateUnitLabel(info('age'), { measure: 'thickness', statistic: 'spc' }), '% per year')
  // Curvature is unitless, so the label must still carry the denominator and nothing else.
  assert.equal(rateUnitLabel(info('session label'), { measure: 'curv', statistic: 'rate' }), 'per scan')
  // The critical negative: a non-time source must never produce a time unit anywhere.
  for (const stat of ['rate', 'spc']) {
    for (const measure of ['thickness', 'area', 'curv']) {
      const label = rateUnitLabel(info('session label'), { measure, statistic: stat })
      assert.doesNotMatch(label, /year|day|month/i, `${measure}-${stat} must not claim a time unit`)
      assert.match(label, /scan/, `${measure}-${stat} says per scan`)
    }
  }
  ok('a per-scan value never carries a time unit, for any measure or statistic')
}

// --- the caveat ------------------------------------------------------------------------------------
{
  assert.equal(timeSourceCaveat(info('age')), null, 'a real time column needs no caveat')
  const caveat = timeSourceCaveat(info('session label'))
  assert.match(caveat, /per scan, not per unit time/i)
  assert.match(caveat, /session label/, 'it names the source brainana actually used')
  assert.match(caveat, /sessions\.tsv/, 'and says how to fix it')
  assert.equal(timeSourceCaveat(null), null)
  ok('the caveat states the problem, names the source, and says how to fix it')
}
{
  assert.match(timeSourceSummary(info('age')), /Time source: age/)
  assert.match(timeSourceSummary(info('age')), /2 timepoints/)
  assert.equal(timeSourceSummary(null), '')
  ok('the good case fills the same slot, so an empty banner is never ambiguous')
}
{
  assert.equal(skippedSummary(info('age')), null)
  assert.match(skippedSummary(info('age', { skipped: { 'ses-002': 'missing surface' } })), /ses-002: missing surface/)
  assert.match(exactlyDeterminedNote(info('age')), /no residual/i, 'two timepoints is an exact fit')
  assert.equal(exactlyDeterminedNote(info('age', { timepoints: ['a', 'b', 'c'] })), null)
  ok('skipped timepoints and an exactly-determined fit are both surfaced')
}

// --- display windows -----------------------------------------------------------------------------
{
  const r = symmetricRobustRange([new Float32Array([-2, -1, 0, 0, 1, 3])])
  assert.equal(r.min, -r.max, 'symmetric, so zero lands on the diverging midpoint')
  assert.ok(r.max > 0)
  // brainana writes the medial wall as exactly 0.0; including those would drag the window to zero.
  const withWall = symmetricRobustRange([new Float32Array([...new Array(1000).fill(0), 0.5, -0.5])])
  assert.ok(withWall.max >= 0.5, 'zeros are excluded from the percentile')
  // An all-zero map is real (identical inputs produce one); a zero-width window would quantize
  // every vertex into a single bin.
  assert.deepEqual(symmetricRobustRange([new Float32Array(50)]), { min: -1, max: 1 })
  assert.deepEqual(symmetricRobustRange([]), { min: -1, max: 1 })
  assert.deepEqual(symmetricRobustRange([new Float32Array([NaN, Infinity])]), { min: -1, max: 1 })
  ok('a signed window is symmetric, zero-excluding, and never zero-width')

  const seq = robustRange([new Float32Array([1, 2, 3, 4, 5])])
  assert.ok(seq.min < seq.max)
  assert.deepEqual(robustRange([new Float32Array(10)]), { min: 0, max: 1 })
  ok('an unsigned window is one-sided and never degenerate')
}

// --- zero lands on the colormap midpoint -----------------------------------------------------------
{
  // The reason the window is symmetric: quantizeScalarToBins maps the window onto bins, and a
  // diverging colormap's neutral colour sits at the middle. An off-centre zero reads as
  // "everything increased slightly", which is a conclusion, not a rendering artefact.
  const { min, max } = symmetricRobustRange([new Float32Array([-4, 4])])
  const bins = quantizeScalarToBins(new Float32Array([min, 0.0001, max]), min, max)
  assert.ok(Math.abs(bins[1] - 128) <= 1, `a near-zero value lands mid-scale (got ${bins[1]})`)
  assert.ok(bins[2] > bins[1] && bins[1] > bins[0], 'the window is monotonic across the range')
  ok('with a symmetric window, zero quantizes to the colormap midpoint')
}

// --- the magnitude threshold -----------------------------------------------------------------------
{
  const values = new Float32Array([-3, -0.5, 0, 0.5, 3])
  const bins = new Float32Array([10, 20, 30, 40, 50])
  assert.deepEqual([...maskSurfaceBinsByMagnitude(bins, values, 0)], [10, 20, 30, 40, 50], 'threshold 0 shows everything')
  // Signed and symmetric: it hides the near-zero middle and keeps BOTH tails. That is the opposite
  // of a value-clip, which is why it is its own function.
  assert.deepEqual([...maskSurfaceBinsByMagnitude(bins, values, 1)], [10, 0, 0, 0, 50])
  assert.deepEqual([...maskSurfaceBinsByMagnitude(bins, values, 0.5)], [10, 20, 0, 40, 50], 'the boundary is inclusive')
  assert.deepEqual([...maskSurfaceBinsByMagnitude(bins, new Float32Array([NaN, 1, 1, 1, 1]), 0.5)][0], 0, 'NaN is hidden')
  ok('the magnitude threshold hides the near-zero middle and keeps both tails')
}

// --- the ROI rate table ------------------------------------------------------------------------------
{
  const csv = 'roi,measure,slope,mean,spc,n_timepoints\nV1,ThickAvg,0.1,2.5,1.2,3\nMT,SurfArea,-0.4,100,-0.9,3\n'
  const rows = parseRoiRatesCsv(csv)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { roi: 'V1', measure: 'ThickAvg', slope: 0.1, mean: 2.5, spc: 1.2, nTimepoints: 3 })
  // Column order is not guaranteed, so the parser is header-indexed rather than positional.
  const shuffled = parseRoiRatesCsv('measure,n_timepoints,roi,spc,mean,slope\nThickAvg,3,V1,1.2,2.5,0.1\n')
  assert.deepEqual(shuffled[0], rows[0], 'shuffled columns parse identically')
  assert.deepEqual(parseRoiRatesCsv(csv.replace(/\n/g, '\r\n')), rows, 'CRLF')
  // A malformed row is DROPPED, never coerced: a silently zeroed rate is worse than a missing one.
  assert.equal(parseRoiRatesCsv('roi,measure,slope,mean,spc,n_timepoints\nV1,ThickAvg,oops,nope,x,y\n').length, 0)
  assert.equal(parseRoiRatesCsv('roi,measure,slope,mean,spc,n_timepoints\nV1,ThickAvg,0.1\n').length, 0, 'short row')
  assert.deepEqual(parseRoiRatesCsv(''), [])
  assert.deepEqual(parseRoiRatesCsv('roi,measure\n'), [])
  assert.deepEqual(parseRoiRatesCsv('a,b,c\n1,2,3\n'), [], 'a table without roi/measure is not this table')
  ok('the ROI table parses by header, tolerates CRLF, and drops malformed rows rather than coercing')

  // The CSV carries FreeSurfer's stat names, which are not the change-map measure ids.
  assert.ok(MEASURE_TO_STATS.thickness.includes('ThickAvg'))
  assert.ok(MEASURE_TO_STATS.area.includes('SurfArea'))
  assert.ok(!Object.values(MEASURE_TO_STATS).flat().includes('NumVert'), 'NumVert is mesh density, not a morphometric')
  ok('each vertex-wise measure maps to the FreeSurfer stat columns that belong to it')
}

// --- which ROI rows the table shows -------------------------------------------------------------
{
  const row = (roi, measure, slope, hemi) => ({ roi, measure, slope, mean: 1, spc: 1, nTimepoints: 3, hemi })
  const all = [
    row('V1', 'ThickAvg', 0.1, 'L'),
    row('MT', 'ThickAvg', -0.5, 'L'),
    row('V1', 'ThickAvg', 0.3, 'R'),
    row('V1', 'SurfArea', 9.9, 'L'),
    row('V1', 'NumVert', 500, 'L'),
  ]
  // The CSV carries FreeSurfer's stat names, so selecting "thickness" is a lookup, not an equality
  // test against the measure id -- and NumVert is mesh density, which is not a morphometric.
  assert.deepEqual(selectRoiRows(all, { measure: 'thickness' }).map((r) => `${r.roi}${r.hemi}`), ['MTL', 'V1R', 'V1L'])
  assert.deepEqual(selectRoiRows(all, { measure: 'area' }).map((r) => r.measure), ['SurfArea'])
  assert.equal(selectRoiRows(all, { measure: 'curv' }).length, 0)
  // Largest absolute change first: sign is already a column, so ordering by magnitude answers
  // "where did the most happen" rather than "what increased".
  assert.deepEqual(selectRoiRows(all, { measure: 'thickness' }).map((r) => r.slope), [-0.5, 0.3, 0.1])
  assert.deepEqual(selectRoiRows(all, { measure: 'thickness', hemi: 'R' }).map((r) => r.hemi), ['R'])
  assert.deepEqual(selectRoiRows(all, { measure: 'thickness', sort: 'roi' }).map((r) => `${r.roi}${r.hemi}`), ['MTL', 'V1L', 'V1R'])
  assert.deepEqual(selectRoiRows([], { measure: 'thickness' }), [])
  ok('the ROI table selects by FreeSurfer stat name and orders by absolute change')
}

// --- base segmentation agreement -------------------------------------------------------------------
{
  const rows = parseSegmentationAgreement({ per_timepoint_median_dice: { 'sub-a_ses-001': 0.91, 'sub-a_ses-003': 0.72 } })
  assert.deepEqual(rows.map((r) => r.timepoint), ['sub-a_ses-003', 'sub-a_ses-001'], 'worst first')
  assert.equal(worstAgreement(rows).dice, 0.72)
  assert.deepEqual(parseSegmentationAgreement(null), [])
  assert.deepEqual(parseSegmentationAgreement({}), [])
  assert.deepEqual(parseSegmentationAgreement({ per_timepoint_median_dice: { a: 'nope' } }), [])
  assert.equal(worstAgreement([]), null)
  ok('segmentation agreement parses worst-first and tolerates a missing or junk payload')
}

console.log(`longitudinal_test: ${passed} checks passed`)
