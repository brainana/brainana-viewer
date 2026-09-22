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
  type Measure,
  type Statistic,
  changeMapsEmptyMessage,
  exactlyDeterminedNote,
  isTimeInterpretable,
  rateUnitLabel,
  skippedSummary,
  thresholdLabel,
  timeSourceCaveat,
  timeSourceSummary,
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

  // Opens on NO overlay, like the funcmap and atlas panels: the pickers used to READ
  // "thickness / rate of change" on mount while nothing had actually been selected (emit() is only
  // called from the change handlers), so the panel described a map the surface was not showing and
  // the user had to wiggle a dropdown to make the two agree. `none` makes the mount state honest.
  const NONE = 'none'
  let measure: Measure | typeof NONE = NONE
  let statistic: Statistic = statistics[0]?.id ?? 'rate'
  const chosen = (): ChangeChoice | null => (measure === NONE ? null : { measure, statistic })
  const emit = (): void => {
    const choice = chosen()
    cb.onSelect(choice && byKey.has(changeKey(choice)) ? choice : null)
  }

  // `none` first, so the browser's own "first option is selected" rule makes it the mount state.
  const measureOptions: SelectOption[] = [
    { value: NONE, label: 'none' },
    ...measures.map((m) => ({ value: m.id, label: m.label })),
  ]
  // Each statistic carries the unit its values are in, so the denominator is chosen WITH the
  // statistic rather than discovered afterwards.
  const statisticOptions = (): SelectOption[] => {
    const forUnits = measure === NONE ? (measures[0]?.id ?? 'thickness') : measure
    return statistics.map((s) => ({
      value: s.id,
      label: `${s.label} (${rateUnitLabel(info, { measure: forUnits, statistic: s.id }) || 'unitless'})`,
    }))
  }

  const measurePicker = selectField('measure', measureOptions, (value) => {
    measure = value === NONE ? NONE : (value as Measure)
    refreshStatisticOptions()
    syncEnabled()
    emit()
  })
  const statisticPicker = selectField('statistic', statisticOptions(), (value) => {
    statistic = value as Statistic
    syncThresholdLabel()
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

  // Nothing is on screen while the measure is `none`, so the controls that shape that overlay are
  // inert -- disable them rather than leaving live-looking widgets that do nothing. Opacity is left
  // alone: it is the panel's own persistent preference, not a property of the current map.
  function syncEnabled(): void {
    const off = measure === NONE
    statisticPicker.select.disabled = off
    if (off) thresh.setDisabled(true)
    syncThresholdLabel()
  }

  // The threshold's meaning changes with the statistic, so its label has to as well.
  function syncThresholdLabel(): void {
    const forUnits = measure === NONE ? (measures[0]?.id ?? 'thickness') : measure
    thresh.setLabel(thresholdLabel(info, { measure: forUnits, statistic }))
  }

  // |value| >= threshold. A magnitude threshold rather than a window: a signed map needs its
  // near-zero middle hidden and both tails kept. 0 shows everything.
  //
  // The label NAMES the statistic it is thresholding (see thresholdLabel). It used to read
  // "|change| ≥" whatever was selected, which was simply wrong for the temporal mean -- that is not
  // a change, and thresholding it by magnitude hides thin cortex rather than small change.
  const thresh: Slider = createSlider({
    label: '|rate| ≥',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0,
    disabled: true,
    onInput: (v) => cb.onThreshold(v),
  })
  const opacity = createSlider({ label: 'opacity', min: 0, max: 1, step: 0.05, value: initial.opacity ?? 1, onInput: (v) => cb.onOpacity(v) })

  // --- the time-source block ------------------------------------------------------------------
  // Sits BELOW the pickers: it is context you read once, not a control, and at the top it pushed
  // measure/statistic/threshold/opacity below the fold of the (scrollable) side picker. The good
  // case fills the same slot as the warning, so the absence of a banner is never ambiguous about
  // whether the question was asked.
  const caveat = timeSourceCaveat(info)
  // Headline always visible, the reasoning behind a caret. The banner still cannot be dismissed —
  // but the sentence that actually matters is one line, and the map controls above it should not be
  // pushed down by five lines most people read once. A scroll box was worse: a scrollbar inside the
  // side picker's own scrollbar, and the text still ate the height.
  const headline = caveat
    ? h('strong', {}, ['Rates are per scan, not per unit time.'])
    : h('span', {}, [timeSourceSummary(info)])
  const detail = [
    ...(caveat ? [h('p', {}, [caveat.replace(/^Rates are per scan, not per unit time\. /, '')])] : []),
    ...(skippedSummary(info) ? [h('p', {}, [skippedSummary(info) as string])] : []),
    ...(exactlyDeterminedNote(info) ? [h('p', {}, [exactlyDeterminedNote(info) as string])] : []),
  ]
  const noteClass = caveat ? 'panel-note warn' : 'panel-note muted'
  // No detail to reveal -> a plain note, not a caret: a disclosure control that opens onto nothing
  // reads as broken.
  const timeBlock = detail.length
    ? h('details', { class: noteClass }, [h('summary', {}, [headline]), ...detail])
    : h('div', { class: noteClass }, [h('p', {}, [headline])])

  // Mount state: `none`, with the map-shaping controls disabled to match.
  syncEnabled()

  const emptyHint = h('p', { class: 'muted' }, [changeMapsEmptyMessage(manifest)])
  const emptyBody = info ? [emptyHint, timeBlock] : [emptyHint]

  const element = h('div', { class: 'side-panel', hidden: true }, [
    h('div', { class: 'side-panel-head' }, ['change']),
    ...(maps.length
      ? [measurePicker.element, statisticPicker.element, thresh.element, opacity.element, timeBlock]
      : emptyBody),
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
      if (!map) {
        // A cleared overlay (tab entry, scan switch, an unknown key) puts the picker back to `none`
        // instead of leaving it naming a map that is no longer painted.
        measure = NONE
        measurePicker.setValue(NONE)
        refreshStatisticOptions()
        syncEnabled()
        return
      }
      measure = map.measure as Measure
      statistic = map.statistic as Statistic
      measurePicker.setValue(measure)
      refreshStatisticOptions()
      syncEnabled()
    },
    setThresholdBounds: (max, value) => {
      if (!(max > 0) || measure === NONE) {
        thresh.setValue(0)
        thresh.setDisabled(true)
        return
      }
      thresh.setBounds(0, max, max / 100)
      thresh.setValue(value)
      thresh.setDisabled(false)
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
