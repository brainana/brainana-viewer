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
import { selectRoiRows, type Measure } from '../data/longitudinal.ts'
import { h } from '@brainana/ui/dom.ts'

export interface RoiRateTable {
  element: HTMLElement
  setRows: (left: RoiRateRow[], right: RoiRateRow[]) => void
  /** Follow the panel's measure picker; `unit` is what the slope column's numbers are in. */
  setMeasure: (measure: Measure, unit: string, perScan: boolean) => void
  /** Everything currently shown, for the report. */
  rows: () => RoiRateTableRow[]
  clear: () => void
}

type SortKey = 'slope' | 'roi'

export function createRoiRateTable(): RoiRateTable {
  let all: RoiRateTableRow[] = []
  let measure: Measure = 'thickness'
  let unit = ''
  let perScan = false
  let sort: SortKey = 'slope'
  let hemiFilter: 'both' | 'L' | 'R' = 'both'

  const body = h('div', { class: 'roi-rate-body' })
  const caption = h('p', { class: 'muted roi-rate-caption' })

  const sortSelect = h('select', { class: 'narrow' }, [
    h('option', { value: 'slope' }, ['|slope|']),
    h('option', { value: 'roi' }, ['name']),
  ]) as HTMLSelectElement
  sortSelect.addEventListener('change', () => {
    sort = sortSelect.value as SortKey
    render()
  })
  const hemiSelect = h('select', { class: 'narrow' }, [
    h('option', { value: 'both' }, ['LH + RH']),
    h('option', { value: 'L' }, ['LH']),
    h('option', { value: 'R' }, ['RH']),
  ]) as HTMLSelectElement
  hemiSelect.addEventListener('change', () => {
    hemiFilter = hemiSelect.value as 'both' | 'L' | 'R'
    render()
  })

  const controls = h('div', { class: 'roi-rate-controls' }, [
    h('label', { class: 'field inline' }, [h('span', {}, ['sort']), sortSelect]),
    h('label', { class: 'field inline' }, [h('span', {}, ['hemi']), hemiSelect]),
  ])

  const visible = (): RoiRateTableRow[] => selectRoiRows(all, { measure, hemi: hemiFilter, sort })

  const num = (v: number, digits = 4): string => (Number.isFinite(v) ? v.toFixed(digits) : '—')

  function render(): void {
    const rows = visible()
    // The header repeats "per scan" so a screenshot of this table alone is still honest about what
    // its numbers mean -- the panel's banner is not in the picture.
    caption.textContent = rows.length
      ? `${measure} · slope in ${unit || 'measure units'}${perScan ? ' (per scan, not per unit time)' : ''}`
      : 'No ROI fits for this measure.'
    body.innerHTML = ''
    if (!rows.length) return
    body.append(
      h('div', { class: 'roi-rate-row head' }, [
        h('span', { class: 'roi' }, ['roi']),
        h('span', { class: 'hemi' }, ['hemi']),
        h('span', { class: 'num' }, ['slope']),
        h('span', { class: 'num' }, ['mean']),
        h('span', { class: 'num' }, ['spc']),
        h('span', { class: 'num' }, ['n']),
      ]),
    )
    for (const row of rows) {
      body.append(
        h('div', { class: 'roi-rate-row' }, [
          h('span', { class: 'roi', title: row.roi }, [row.roi]),
          h('span', { class: 'hemi' }, [row.hemi]),
          h('span', { class: 'num' }, [num(row.slope)]),
          h('span', { class: 'num' }, [num(row.mean, 3)]),
          h('span', { class: 'num' }, [num(row.spc, 3)]),
          h('span', { class: 'num' }, [Number.isFinite(row.nTimepoints) ? String(row.nTimepoints) : '—']),
        ]),
      )
    }
  }

  const element = h('div', { class: 'roi-rate-table' }, [controls, caption, body])
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
    setMeasure: (m, u, scan) => {
      measure = m
      unit = u
      perScan = scan
      render()
    },
    rows: () => visible(),
    clear: () => {
      all = []
      render()
    },
  }
}
