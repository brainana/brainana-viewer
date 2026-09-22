// The ROI rate table: brainana's per-parcel fits (?h.long.roi-rates.csv), shown in the change
// tab's content slot.
//
// Deliberately NOT folded into RoiLegend. That component is a virtualized visibility control bound
// to the atlas overlay's hidden set; giving it a second data source and numeric columns would fuse
// two unrelated jobs into the trickiest component in the app. There is no conflict to resolve
// either -- the atlas legend is only shown while the atlas tab is docked, so the two are never on
// screen together.
//
// Plain (non-virtualized) on purpose: brainana emits a few dozen ROIs per hemisphere for a given
// measure, and virtualizing that would be cost without benefit.
import type { RoiRateRow, RoiRateTableRow } from '../data/longitudinal.ts'
import {
  MEASURE_TO_STATS,
  PRIMARY_STAT,
  selectRoiRows,
  statBelongsTo,
  type Measure,
  type Statistic,
} from '../data/longitudinal.ts'
import { h } from '@brainana/ui/dom.ts'

export interface RoiRateTable {
  element: HTMLElement
  setRows: (left: RoiRateRow[], right: RoiRateRow[]) => void
  /**
   * Follow the panel's measure picker (slope units live in the statistic picker and time-source
   * note). `null` is the panel's `none` — the fits stay loaded, they are just not listed, so
   * picking a measure again costs no refetch.
   */
  setMeasure: (measure: Measure | null) => void
  /**
   * Which statistic the surface is painting. The table always shows all three as columns — the
   * picker only chooses which one is on the mesh — so this just highlights the matching column,
   * making the relationship between panel and table visible instead of implied.
   */
  setStatistic: (statistic: Statistic) => void
  /** Everything currently shown, for the report. */
  rows: () => RoiRateTableRow[]
  clear: () => void
}

type SortKey = 'slope' | 'roi'

export function createRoiRateTable(): RoiRateTable {
  let all: RoiRateTableRow[] = []
  // Starts unset, matching the change panel's `none` default: the table is the selected map's ROI
  // fits, so with no map selected it lists nothing rather than a measure nobody asked for.
  let measure: Measure | null = null
  let stat: string | null = null
  let statistic: Statistic = 'rate'
  let sort: SortKey = 'slope'
  let hemiFilter: 'both' | 'L' | 'R' = 'both'

  const body = h('div', { class: 'roi-rate-body' })
  const caption = h('p', { class: 'muted roi-rate-caption' })

  const sortSelect = h('select', { class: 'narrow' }, [
    // The VALUE stays 'slope' (it is the CSV's column name), but the label has to say what the
    // column now says -- offering a sort by "|slope|" over a column headed "rate" reintroduced
    // exactly the two-names-for-one-quantity confusion this rename removed.
    h('option', { value: 'slope' }, ['|rate|']),
    h('option', { value: 'roi' }, ['name']),
  ]) as HTMLSelectElement
  sortSelect.addEventListener('change', () => {
    sort = sortSelect.value as SortKey
    render()
  })
  // One stat at a time (see PRIMARY_STAT): a measure maps to two to four FreeSurfer stats, and
  // listing them together put each ROI on screen two to four times with nothing naming them.
  const statSelect = h('select', { class: 'narrow' }) as HTMLSelectElement
  statSelect.addEventListener('change', () => {
    stat = statSelect.value
    render()
  })
  function refreshStatOptions(): void {
    statSelect.innerHTML = ''
    const stats = measure ? (MEASURE_TO_STATS[measure] ?? []) : []
    for (const s of stats) statSelect.append(h('option', { value: s }, [s]))
    const active = measure && stat && statBelongsTo(measure, stat) ? stat : measure ? PRIMARY_STAT[measure] : ''
    stat = active || null
    if (active) statSelect.value = active
    statField.hidden = stats.length < 2
  }

  const hemiSelect = h('select', { class: 'narrow' }, [
    h('option', { value: 'both' }, ['LH + RH']),
    h('option', { value: 'L' }, ['LH']),
    h('option', { value: 'R' }, ['RH']),
  ]) as HTMLSelectElement
  hemiSelect.addEventListener('change', () => {
    hemiFilter = hemiSelect.value as 'both' | 'L' | 'R'
    render()
  })

  // Hidden until a measure is chosen, and for a measure with only one stat there is nothing to pick.
  const statField = h('label', { class: 'field inline', hidden: true }, [h('span', {}, ['stat']), statSelect])
  const controls = h('div', { class: 'roi-rate-controls' }, [
    statField,
    h('label', { class: 'field inline' }, [h('span', {}, ['sort']), sortSelect]),
    h('label', { class: 'field inline' }, [h('span', {}, ['hemi']), hemiSelect]),
  ])
  // The three numeric columns ARE the three statistics; the panel's picker only chooses which one
  // is painted. Saying so is what stops "rate" / "mean" / "% change" reading as unrelated numbers.
  const legend = h('p', { class: 'muted roi-rate-legend', hidden: true }, [
    'Highlighted column is the surface overlay.',
  ])

  const visible = (): RoiRateTableRow[] =>
    measure === null ? [] : selectRoiRows(all, { measure, stat: stat ?? undefined, hemi: hemiFilter, sort })

  const num = (v: number, digits = 4): string => (Number.isFinite(v) ? v.toFixed(digits) : '—')

  function render(): void {
    const rows = visible()
    if (!rows.length) {
      caption.hidden = false
      caption.textContent = measure === null ? 'Pick a measure to list its ROI fits.' : 'No ROI fits for this measure.'
      body.innerHTML = ''
      return
    }
    caption.hidden = true
    caption.textContent = ''
    body.innerHTML = ''
    // 'rate' rather than the CSV's own 'slope': it is the same quantity as the panel's "rate of
    // change", just fit per ROI instead of per vertex, and two names for it read as two things.
    // The CSV column name lives in the tooltip so the number stays traceable to brainana's output.
    const on = (s: Statistic): string => (statistic === s ? ' active' : '')
    body.append(
      h('div', { class: 'roi-rate-row head' }, [
        h('span', { class: 'roi' }, ['roi']),
        h('span', { class: 'hemi' }, ['hemi']),
        h('span', { class: `num${on('rate')}`, title: 'Slope of the per-ROI linear fit vs time (CSV column “slope”) — the ROI counterpart of the “rate of change” map.' }, ['rate']),
        h('span', { class: `num${on('avg')}`, title: 'Mean across timepoints (CSV column “mean”) — the ROI counterpart of the “temporal mean” map.' }, ['mean']),
        h('span', { class: `num${on('spc')}`, title: 'Symmetrised percent change (CSV column “spc”) — the ROI counterpart of the “percent change” map.' }, ['% change']),
        h('span', { class: 'num', title: 'Timepoints the fit used.' }, ['n']),
      ]),
    )
    for (const row of rows) {
      body.append(
        h('div', { class: 'roi-rate-row' }, [
          h('span', { class: 'roi', title: row.roi }, [row.roi]),
          h('span', { class: 'hemi' }, [row.hemi]),
          h('span', { class: `num${on('rate')}` }, [num(row.slope)]),
          h('span', { class: `num${on('avg')}` }, [num(row.mean, 3)]),
          h('span', { class: `num${on('spc')}` }, [num(row.spc, 3)]),
          h('span', { class: 'num' }, [Number.isFinite(row.nTimepoints) ? String(row.nTimepoints) : '—']),
        ]),
      )
    }
  }

  const element = h('div', { class: 'roi-rate-table' }, [controls, legend, caption, body])
  render()

  return {
    element,
    setRows: (left, right) => {
      all = [
        ...left.map((r) => ({ ...r, hemi: 'L' as const })),
        ...right.map((r) => ({ ...r, hemi: 'R' as const })),
      ]
      render()
    },
    setMeasure: (m) => {
      measure = m
      refreshStatOptions()
      legend.hidden = m === null
      render()
    },
    setStatistic: (s) => {
      statistic = s
      render()
    },
    rows: () => visible(),
    clear: () => {
      all = []
      measure = null
      stat = null
      refreshStatOptions()
      legend.hidden = true
      render()
    },
  }
}
