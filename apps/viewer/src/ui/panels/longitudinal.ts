// Docked "change" picker: the longitudinal change maps brainana fits across a subject's
// timepoints. Pick a measure and a statistic, threshold by magnitude, set opacity.
//
// The panel's other job is to stop a rate being misread. When the fit had no real time column the
// values are a change per SCAN, and nothing about the picture says so — so the caveat is pinned
// above the pickers where it cannot be scrolled past, and every statistic label carries its own
// denominator. Colour controls live in the shared "Color display" section, as for every overlay.
import type { LongitudinalInfo, Manifest } from '../../types.ts'
import {
  LONG_MEASURES,
  LONG_STATISTICS,
  type AgreementRow,
  type Measure,
  type Statistic,
  AGREEMENT_WARN_DICE,
  exactlyDeterminedNote,
  isTimeInterpretable,
  rateUnitLabel,
  skippedSummary,
  timeSourceCaveat,
  timeSourceSummary,
  worstAgreement,
} from '../../data/longitudinal.ts'
import { h, selectField, type SelectOption } from '@brainana/ui/dom.ts'
import { createSlider, type Slider } from '@brainana/ui/components/slider.ts'

export interface ChangeChoice {
  measure: Measure
  statistic: Statistic
}
export const changeKey = (c: ChangeChoice): string => `${c.measure}-${c.statistic}`

export interface LongitudinalPanelCallbacks {
  onSelect: (choice: ChangeChoice | null) => void
  onThreshold: (v: number) => void
  onOpacity: (v: number) => void
}

export interface LongitudinalPanelInitial {
  opacity?: number
}

export interface LongitudinalPanel {
  element: HTMLElement
  setActive: (key: string | null) => void
  setThresholdBounds: (max: number, value: number) => void
  setAgreement: (rows: AgreementRow[]) => void
  getChoice: (key: string) => ChangeChoice | null
  /** The unit the currently selected map's values are in, for the readout and the colour dock. */
  unitFor: (key: string) => string
}

export function createLongitudinalPanel(
  manifest: Manifest,
  cb: LongitudinalPanelCallbacks,
  initial: LongitudinalPanelInitial = {},
): LongitudinalPanel {
  const info: LongitudinalInfo | null = manifest.longitudinal
  const maps = info?.changeMaps ?? []
  const byKey = new Map(maps.map((m) => [m.key, m]))

  // Only offer what this subject actually has: a measure whose maps are all missing would be a
  // dropdown entry that renders nothing.
  const measures = LONG_MEASURES.filter((m) => maps.some((x) => x.measure === m.id))
  const statistics = LONG_STATISTICS.filter((s) => maps.some((x) => x.statistic === s.id))

  let measure: Measure = measures[0]?.id ?? 'thickness'
  let statistic: Statistic = statistics[0]?.id ?? 'rate'
  const current = (): ChangeChoice => ({ measure, statistic })
  const emit = (): void => cb.onSelect(byKey.has(changeKey(current())) ? current() : null)

  const measureOptions: SelectOption[] = measures.map((m) => ({ value: m.id, label: m.label }))
  // Each statistic carries the unit its values are in, so the denominator is chosen WITH the
  // statistic rather than discovered afterwards.
  const statisticOptions = (): SelectOption[] =>
    statistics.map((s) => ({ value: s.id, label: `${s.label} (${rateUnitLabel(info, { measure, statistic: s.id }) || 'unitless'})` }))

  const measurePicker = selectField('measure', measureOptions, (value) => {
    measure = value as Measure
    refreshStatisticOptions()
    emit()
  })
  const statisticPicker = selectField('statistic', statisticOptions(), (value) => {
    statistic = value as Statistic
    emit()
  })
  // selectField has no setOptions, and these labels genuinely have to be rebuilt: each carries the
  // unit its values are in, which depends on the measure just chosen.
  function refreshStatisticOptions(): void {
    statisticPicker.select.innerHTML = ''
    for (const option of statisticOptions()) {
      statisticPicker.select.append(h('option', { value: option.value }, [option.label]))
    }
    statisticPicker.setValue(statistic)
  }

  // |value| >= threshold. A magnitude threshold rather than a window: a signed map needs its
  // near-zero middle hidden and both tails kept. 0 shows everything.
  const thresh: Slider = createSlider({
    label: '|change| ≥',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0,
    disabled: true,
    onInput: (v) => cb.onThreshold(v),
  })
  const opacity = createSlider({ label: 'opacity', min: 0, max: 1, step: 0.05, value: initial.opacity ?? 1, onInput: (v) => cb.onOpacity(v) })

  // --- the time-source block ------------------------------------------------------------------
  // Pinned above the pickers. The good case fills the same slot as the warning, so the absence of
  // a banner is never ambiguous about whether the question was asked.
  const caveat = timeSourceCaveat(info)
  const timeBlock = h('div', { class: caveat ? 'panel-note warn' : 'panel-note muted' }, [
    caveat
      ? h('p', {}, [h('strong', {}, ['Rates are per scan, not per unit time. ']), caveat.replace(/^Rates are per scan, not per unit time\. /, '')])
      : h('p', {}, [timeSourceSummary(info)]),
    ...(skippedSummary(info) ? [h('p', {}, [skippedSummary(info) as string])] : []),
    ...(exactlyDeterminedNote(info) ? [h('p', {}, [exactlyDeterminedNote(info) as string])] : []),
  ])

  // --- base segmentation agreement ---------------------------------------------------------------
  const agreementSummary = h('span', { class: 'agreement-value' }, ['—'])
  const agreementRows = h('div', { class: 'agreement-rows' })
  const agreementNote = h('p', { class: 'agreement-note', hidden: true }, [
    'Low agreement between the base segmentation and this timepoint. The base’s surfaces deserve a closer look before you trust the change maps.',
  ])
  const agreement = h('details', { class: 'panel-group agreement', hidden: true }, [
    h('summary', {}, ['base agreement ', agreementSummary]),
    agreementNote,
    agreementRows,
  ])

  const empty = h('p', { class: 'muted' }, [
    'No longitudinal change maps in this dataset. Reprocess with brainana 3.0 or newer at anat.synthesis_level "session_longitudinal" to generate them.',
  ])

  const element = h('div', { class: 'side-panel', hidden: true }, [
    h('div', { class: 'side-panel-head' }, ['change']),
    ...(maps.length
      ? [timeBlock, measurePicker.element, statisticPicker.element, thresh.element, opacity.element, agreement]
      : [empty]),
  ])

  return {
    element,
    getChoice: (key) => {
      const map = byKey.get(key)
      return map ? { measure: map.measure as Measure, statistic: map.statistic as Statistic } : null
    },
    unitFor: (key) => {
      const map = byKey.get(key)
      return map ? rateUnitLabel(info, map) : ''
    },
    setActive: (key) => {
      const map = key ? byKey.get(key) : null
      if (!map) return
      measure = map.measure as Measure
      statistic = map.statistic as Statistic
      measurePicker.setValue(measure)
      refreshStatisticOptions()
    },
    setThresholdBounds: (max, value) => {
      if (!(max > 0)) {
        thresh.setValue(0)
        thresh.setDisabled(true)
        return
      }
      thresh.setBounds(0, max, max / 100)
      thresh.setValue(value)
      thresh.setDisabled(false)
    },
    setAgreement: (rows) => {
      const worst = worstAgreement(rows)
      if (!worst) {
        agreement.hidden = true
        return
      }
      agreement.hidden = false
      agreementSummary.textContent = `lowest Dice ${worst.dice.toFixed(2)} · ${worst.timepoint}`
      agreementSummary.classList.toggle('warn', worst.dice < AGREEMENT_WARN_DICE)
      agreementNote.hidden = worst.dice >= AGREEMENT_WARN_DICE
      agreementRows.innerHTML = ''
      for (const row of rows) {
        agreementRows.append(
          h('div', { class: 'agreement-row' }, [h('span', {}, [row.timepoint]), h('span', { class: 'num' }, [row.dice.toFixed(3)])]),
        )
      }
    },
  }
}

/** True when this manifest has change maps worth showing a tab for. */
export function hasChangeMaps(manifest: Manifest | null): boolean {
  return (manifest?.longitudinal?.changeMaps?.length ?? 0) > 0
}

/** Whether the time source makes a rate interpretable — for the report and the colour dock. */
export function ratesAreRates(manifest: Manifest | null): boolean {
  return isTimeInterpretable(manifest?.longitudinal ?? null)
}
