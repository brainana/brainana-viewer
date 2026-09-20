// Longitudinal change maps: measures, units, and the time-source question.
//
// brainana fits a rate of change per vertex across a subject's timepoints. Whether that rate means
// anything depends entirely on where the TIME values came from. When sessions.tsv carries an `age`
// or `acq_time` column the fit is against real elapsed time and the rate is mm per year. When it
// does not, brainana falls back to digits in the session label and then to scan order, and the
// fitted value is a change per SCAN — a number that looks exactly like a rate, is quotable as one,
// and is not one unless the sessions happen to be evenly spaced.
//
// brainana's own docs put it plainly: "a rate is not interpretable without it". So every function
// here that produces a number for display also produces the unit that number is in.
import type { ChangeMap, LongitudinalInfo } from '../types'

export const LONG_MEASURES = [
  { id: 'thickness', label: 'thickness', unit: 'mm' },
  { id: 'area', label: 'area', unit: 'mm²' },
  { id: 'curv', label: 'curvature', unit: '' },
] as const

export const LONG_STATISTICS = [
  { id: 'rate', label: 'rate of change', diverging: true },
  { id: 'avg', label: 'temporal mean', diverging: false },
  { id: 'spc', label: 'percent change', diverging: true },
] as const

export type Measure = (typeof LONG_MEASURES)[number]['id']
export type Statistic = (typeof LONG_STATISTICS)[number]['id']

/**
 * Time sources that represent REAL elapsed time, and the unit each is measured in.
 *
 * This is deliberately a whitelist. An unrecognised source — including one a future brainana
 * release introduces — is treated as not interpretable, so the failure mode is an over-cautious
 * caveat rather than a fabricated rate.
 */
const TIME_BEARING_SOURCES: Record<string, string> = {
  age: 'year',
  ages: 'year',
  acq_time: 'day',
  'acquisition date': 'day',
  'acquisition time': 'day',
  sessions_tsv_age: 'year',
}

function normalizeSource(source: string | null | undefined): string {
  return String(source ?? '').trim().toLowerCase()
}

/** Was the fit against real elapsed time, rather than scan order? */
export function isTimeInterpretable(info: Pick<LongitudinalInfo, 'timeSource'> | null): boolean {
  if (!info) return false
  return normalizeSource(info.timeSource) in TIME_BEARING_SOURCES
}

/** The denominator a rate is in: 'year' / 'day' for a real time column, else 'scan'. */
export function timeUnit(info: Pick<LongitudinalInfo, 'timeSource'> | null): string {
  if (!info) return 'scan'
  return TIME_BEARING_SOURCES[normalizeSource(info.timeSource)] ?? 'scan'
}

/**
 * The unit label that must accompany every displayed value of this map, everywhere it appears —
 * the picker, the colorbar, the crosshair readout, the ROI table and the report. Attaching the
 * denominator to the number is what stops a per-scan value being read as a per-year one.
 */
export function rateUnitLabel(info: Pick<LongitudinalInfo, 'timeSource'> | null, map: Pick<ChangeMap, 'measure' | 'statistic'>): string {
  const measure = LONG_MEASURES.find((m) => m.id === map.measure)
  const base = measure?.unit ?? ''
  if (map.statistic === 'avg') return base
  const per = timeUnit(info)
  if (map.statistic === 'spc') return `% per ${per}`
  return base ? `${base} per ${per}` : `per ${per}`
}

/**
 * The caveat to show when a rate is not a rate. Null when the fit used real time, so the absence
 * of this string is itself meaningful — see timeSourceSummary for what fills the slot instead.
 */
export function timeSourceCaveat(info: LongitudinalInfo | null): string | null {
  if (!info || isTimeInterpretable(info)) return null
  const source = info.timeSource ? `time source: ${info.timeSource}` : 'no time source was recorded'
  return (
    `Rates are per scan, not per unit time. brainana found no age or acquisition-time column in ` +
    `sessions.tsv, so it fit change against scan order (${source}). These values say nothing about ` +
    `change per year unless this animal's sessions were evenly spaced. Add an ‘age’ or ` +
    `‘acq_time’ column to sessions.tsv and reprocess to get a real rate.`
  )
}

/** The good-case line, so the caveat's slot is never simply empty (which would be ambiguous). */
export function timeSourceSummary(info: LongitudinalInfo | null): string {
  if (!info) return ''
  const n = info.timepoints.length
  const times = info.timepoints.map((tp) => info.times[tp]).filter((v) => typeof v === 'number')
  const span = times.length >= 2 ? ` · ${Math.min(...times)}–${Math.max(...times)} ${timeUnit(info)}s` : ''
  return `Time source: ${info.timeSource ?? 'unknown'} · ${n} timepoint${n === 1 ? '' : 's'}${span}`
}

/** Timepoints brainana excluded from the fit, as a sentence; null when nothing was skipped. */
export function skippedSummary(info: LongitudinalInfo | null): string | null {
  const entries = Object.entries(info?.skipped ?? {})
  if (!entries.length) return null
  const detail = entries.map(([k, v]) => (v ? `${k}: ${String(v)}` : k)).join('; ')
  return `${entries.length} session${entries.length === 1 ? ' was' : 's were'} excluded from the fit (${detail}).`
}

/** A two-timepoint fit is exactly determined — worth saying, because it has no residual. */
export function exactlyDeterminedNote(info: LongitudinalInfo | null): string | null {
  if (!info || info.timepoints.length !== 2) return null
  return 'Only 2 timepoints: the fitted line passes exactly through both, so it has no residual to inspect.'
}

// --- display range -----------------------------------------------------------------------------

/**
 * A symmetric, zero-centred window for a signed map, from robust limits.
 *
 * Symmetric so that zero lands on the diverging colormap's neutral colour — an offset neutral
 * point reads as "everything increased slightly". Zeros are excluded because brainana writes the
 * medial wall and non-cortex as exactly 0.0, and including them drags the percentiles toward zero;
 * a rate map is ~0.01 mm/yr, so a window computed over the full array renders a blank surface.
 */
export function symmetricRobustRange(values: ArrayLike<number>[], pct = 0.98): { min: number; max: number } {
  const magnitudes: number[] = []
  for (const array of values) {
    for (let i = 0; i < array.length; i++) {
      const v = array[i]
      if (Number.isFinite(v) && v !== 0) magnitudes.push(Math.abs(v))
    }
  }
  if (!magnitudes.length) return { min: -1, max: 1 } // a zero-width window quantizes everything to one bin
  magnitudes.sort((a, b) => a - b)
  const m = magnitudes[Math.min(magnitudes.length - 1, Math.max(0, Math.round(pct * (magnitudes.length - 1))))]
  if (!(m > 0)) return { min: -1, max: 1 }
  return { min: -m, max: m }
}

/** A one-sided robust window, for the unsigned `avg` maps. */
export function robustRange(values: ArrayLike<number>[], lo = 0.02, hi = 0.98): { min: number; max: number } {
  const finite: number[] = []
  for (const array of values) {
    for (let i = 0; i < array.length; i++) {
      const v = array[i]
      if (Number.isFinite(v) && v !== 0) finite.push(v)
    }
  }
  if (!finite.length) return { min: 0, max: 1 }
  finite.sort((a, b) => a - b)
  const at = (q: number) => finite[Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))))]
  const min = at(lo)
  const max = at(hi)
  return max > min ? { min, max } : { min, max: min + 1 }
}

// --- the ROI rate table ------------------------------------------------------------------------

export interface RoiRateRow {
  roi: string
  measure: string
  slope: number
  mean: number
  spc: number
  nTimepoints: number
}

/**
 * Parse brainana's ?h.long.roi-rates.csv. Header-indexed rather than positional, and tolerant: a
 * malformed row is dropped rather than coerced, because a silently zeroed rate is worse than a
 * missing one. No CSV dependency — these files are plain comma-separated with no quoting.
 */
export function parseRoiRatesCsv(text: string): RoiRateRow[] {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const iRoi = col('roi')
  const iMeasure = col('measure')
  const iSlope = col('slope')
  const iMean = col('mean')
  const iSpc = col('spc')
  const iN = col('n_timepoints')
  if (iRoi < 0 || iMeasure < 0) return []
  const num = (cells: string[], index: number) => {
    if (index < 0) return NaN
    const v = Number(cells[index])
    return Number.isFinite(v) ? v : NaN
  }
  const rows: RoiRateRow[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    if (cells.length !== header.length) continue
    const roi = cells[iRoi]?.trim()
    const measure = cells[iMeasure]?.trim()
    if (!roi || !measure) continue
    const slope = num(cells, iSlope)
    const mean = num(cells, iMean)
    const spc = num(cells, iSpc)
    if (!Number.isFinite(slope) && !Number.isFinite(mean)) continue
    rows.push({ roi, measure, slope, mean, spc, nTimepoints: num(cells, iN) })
  }
  return rows
}

/**
 * Which FreeSurfer stat columns belong to each of the three vertex-wise measures. The CSV carries
 * FreeSurfer's own stat names, which do not match the change-map measure ids.
 */
export const MEASURE_TO_STATS: Record<Measure, string[]> = {
  thickness: ['ThickAvg', 'ThickStd'],
  area: ['SurfArea', 'GrayVol'],
  curv: ['MeanCurv', 'GausCurv', 'CurvInd', 'FoldInd'],
}

export interface RoiRateTableRow extends RoiRateRow {
  hemi: 'L' | 'R'
}

/**
 * Which rows the ROI table shows, in what order.
 *
 * Pulled out of the component because this is the part with decisions in it: the CSV carries
 * FreeSurfer's stat names rather than the change maps' measure ids, so picking the rows for
 * "thickness" is a lookup rather than an equality test.
 */
export function selectRoiRows(
  rows: RoiRateTableRow[],
  { measure, hemi = 'both', sort = 'slope' }: { measure: Measure; hemi?: 'both' | 'L' | 'R'; sort?: 'slope' | 'roi' },
): RoiRateTableRow[] {
  const stats = MEASURE_TO_STATS[measure] ?? []
  const filtered = rows.filter((r) => stats.includes(r.measure) && (hemi === 'both' || r.hemi === hemi))
  return filtered.sort((a, b) =>
    sort === 'roi'
      ? a.roi.localeCompare(b.roi, undefined, { numeric: true, sensitivity: 'base' }) || a.hemi.localeCompare(b.hemi)
      : // Largest absolute change first: the question a rate table is opened to answer is "where
        // did the most happen", and sign is already a column.
        Math.abs(b.slope) - Math.abs(a.slope),
  )
}

// --- base segmentation agreement ---------------------------------------------------------------

export interface AgreementRow {
  timepoint: string
  dice: number
}

/**
 * Dice below this earns a warning. A viewer-chosen threshold, not one brainana states — brainana
 * calls the file a diagnostic and says only that "low values are the signal".
 */
export const AGREEMENT_WARN_DICE = 0.8

export function parseSegmentationAgreement(json: unknown): AgreementRow[] {
  const record = json as { per_timepoint_median_dice?: Record<string, unknown> } | null
  const per = record?.per_timepoint_median_dice
  if (!per || typeof per !== 'object') return []
  const rows: AgreementRow[] = []
  for (const [timepoint, value] of Object.entries(per)) {
    const dice = Number(value)
    if (Number.isFinite(dice)) rows.push({ timepoint, dice })
  }
  return rows.sort((a, b) => a.dice - b.dice)
}

export function worstAgreement(rows: AgreementRow[]): AgreementRow | null {
  return rows.length ? rows.reduce((a, b) => (a.dice <= b.dice ? a : b)) : null
}
