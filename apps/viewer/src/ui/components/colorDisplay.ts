// The unified "Color display" section docked at the bottom of the side panel. It owns the generic
// color controls that used to be nested in each panel — colormap picker, legend (bar/wheel/rings),
// display range (cal clamp), and clip (hide) — and targets whichever overlay is active. The dashboard
// drives it via setTarget() and routes the callbacks to the active overlay's apply path.
import { h } from '@brainana/ui/dom.ts'
import { createColormapPicker, type ColormapPicker } from './colormapPicker.ts'
import { createRangeControl, type RangeControl } from '@brainana/ui/components/rangeControl.ts'
import { createLegend, type Legend, type LegendShape } from '@brainana/ui/components/legend.ts'
import type { ColormapInfo } from '../../data/colormap.ts'

export interface ColorDisplayCallbacks {
  onColormap: (key: string) => void
  /** Flip the active colormap end-to-end (the dashboard rewrites the key and re-applies). */
  onReverse?: () => void
  onDisplayRange: (min: number, max: number) => void
  onDisplayAuto?: () => void
  onClipRange?: (lo: number | null, hi: number | null) => void
  onReset?: () => void
}

export interface ColorDisplayTarget {
  title: string
  colormap: string
  legendShape: LegendShape
  /** Hide the legend entirely (e.g. categorical atlas, where the ROI list above IS the legend and a
   *  continuous gradient bar over label ids is meaningless/misleading). Defaults to shown. */
  showLegend?: boolean
  gradient: string
  lut?: ArrayLike<number>
  displayDomain: { min: number; max: number }
  displayRange: { min: number; max: number }
  /** Hide the display-range slider (e.g. categorical atlas, where the map spreads across label ids). */
  showDisplayRange?: boolean
  /** Pin the display-range lower bound so only the upper bound drags (continuous atlas). */
  lockMin?: boolean
  /** Override the colormaps offered by the picker (e.g. drop "labels" for a continuous atlas). */
  colormaps?: ColormapInfo[]
  /** Is the active colormap currently reversed? Drives the toggle's pressed state. */
  reversed?: boolean
  /** Hide the reverse toggle (categorical atlas: there is no ramp to flip). Defaults to shown. */
  showReverse?: boolean
  /** Clip UI variant: a full lo/hi range, or none. */
  clip: 'range' | 'none'
  clipDomain?: { min: number; max: number }
  clipValue?: { lo: number | null; hi: number | null }
  unit?: string
  /** Bar-legend semantic tick labels [min, mid, max] (e.g. somatotopy's foot / hand / face). */
  barTicks?: [string, string, string]
  /**
   * Default collapsed state, applied only when the target *identity* (title) changes — e.g. a
   * categorical atlas starts collapsed since the ROI list above already shows the real palette,
   * yet a manual expand persists across the frequent same-target refreshes.
   */
  collapsed?: boolean
}

export interface ColorDisplay {
  element: HTMLElement
  setTarget: (t: ColorDisplayTarget | null) => void
}

const EPS = 1e-6

export function createColorDisplay(
  cb: ColorDisplayCallbacks,
  gradients: Record<string, string>,
  infos: ColormapInfo[],
): ColorDisplay {
  // Header doubles as a collapse toggle. Reset (restore the active overlay's defaults) sits inline
  // with the colormap row, not the header — it reads as "reset these colors".
  const head = h('button', { type: 'button', class: 'color-display-head' }, ['color display'])
  const resetBtn = h('button', { type: 'button', class: 'ghost sm' }, ['reset']) as HTMLButtonElement
  resetBtn.addEventListener('click', () => cb.onReset?.())
  // Reverse is a toggle rather than a second row per map in the picker: it applies to EVERY
  // colormap (sequential included), so listing forward and reversed twins would double a list that
  // is already ~60 long to say one bit.
  const reverseBtn = h('button', { type: 'button', class: 'ghost sm', title: 'Flip the colormap end to end' }, ['reverse']) as HTMLButtonElement
  reverseBtn.addEventListener('click', () => cb.onReverse?.())

  const picker: ColormapPicker = createColormapPicker({ gradients, infos, onChange: (k) => cb.onColormap(k) })
  const legend: Legend = createLegend('legend')

  let clipDomain = { min: 0, max: 1 }
  const displayRange: RangeControl = createRangeControl({
    onChange: ({ min, max }) => cb.onDisplayRange(min, max),
  })
  const clipRange: RangeControl = createRangeControl({
    onChange: ({ min, max }) => {
      const lo = min <= clipDomain.min + EPS ? null : min
      const hi = max >= clipDomain.max - EPS ? null : max
      cb.onClipRange?.(lo, hi)
    },
  })

  // Shared 3-column grid: [label (dcg-label)] [min side (range-side)] [max side (range-side)]
  // Both display and clip rows align their min/max columns on the same grid edges.
  const displayLabel = h('span', { class: 'dcg-label' }, ['display'])
  const clipLabel = h('span', { class: 'dcg-label' }, ['clip'])

  const rangesGrid = h('div', { class: 'display-clip-grid' }, [
    displayLabel,
    displayRange.minSide,
    displayRange.maxSide,
    clipLabel,
    clipRange.minSide,
    clipRange.maxSide,
  ])

  const body = h('div', { class: 'color-display-body' }, [
    h('div', { class: 'field' }, [
      h('div', { class: 'row' }, [h('span', { class: 'grow' }, ['colormap']), reverseBtn, resetBtn]),
      picker.element,
    ]),
    legend.element,
    rangesGrid,
  ])
  const element = h('div', { class: 'color-display', hidden: true }, [
    h('div', { class: 'color-display-title' }, [head]),
    body,
  ])
  // Clicking the header collapses/expands the body (keeps a short window usable).
  head.addEventListener('click', () => element.classList.toggle('collapsed'))

  // Apply a target's default collapsed state only when the target identity changes, so a manual
  // expand/collapse survives the many same-target refreshColorDisplay() re-renders.
  let lastTitle: string | null = null

  return {
    element,
    setTarget: (t) => {
      if (!t) {
        element.hidden = true
        lastTitle = null
        return
      }
      element.hidden = false
      if (t.title !== lastTitle) {
        element.classList.toggle('collapsed', !!t.collapsed)
        lastTitle = t.title
      }
      if (t.colormaps) picker.setInfos(t.colormaps)
      picker.setValue(t.colormap)
      // Reversing a categorical label table is meaningless — it would renumber ROI colours — so the
      // toggle follows the same continuous/ramp gate as the legend.
      const showReverse = t.showReverse ?? t.showLegend !== false
      reverseBtn.hidden = !showReverse
      reverseBtn.classList.toggle('active', !!t.reversed)
      reverseBtn.setAttribute('aria-pressed', t.reversed ? 'true' : 'false')
      // Legend — hidden when the target opts out (categorical atlas: the ROI list IS the legend, and a
      // gradient bar over label ids is misleading). legend.set() re-shows the element, so hide instead.
      if (t.showLegend === false) {
        legend.hide()
      } else {
        legend.set({
          shape: t.legendShape,
          gradient: t.gradient,
          lut: t.lut,
          min: t.displayRange.min,
          max: t.displayRange.max,
          clipLow: t.clipValue?.lo ?? null,
          clipHigh: t.clipValue?.hi ?? null,
          unit: t.unit,
          ticks: t.barTicks,
        })
      }
      // Display range
      const showDisplay = t.showDisplayRange !== false
      displayLabel.hidden = !showDisplay
      displayRange.minSide.hidden = !showDisplay
      displayRange.maxSide.hidden = !showDisplay
      displayRange.setDomain(t.displayDomain.min, t.displayDomain.max)
      displayRange.setValue(t.displayRange.min, t.displayRange.max)
      displayRange.setLockMin(!!t.lockMin)
      // Clip variant
      const showClip = t.clip === 'range'
      clipLabel.hidden = !showClip
      clipRange.minSide.hidden = !showClip
      clipRange.maxSide.hidden = !showClip
      if (showClip && t.clipDomain) {
        clipDomain = t.clipDomain
        clipRange.setDomain(t.clipDomain.min, t.clipDomain.max)
        clipRange.setValue(t.clipValue?.lo ?? t.clipDomain.min, t.clipValue?.hi ?? t.clipDomain.max)
      }
    },
  }
}
