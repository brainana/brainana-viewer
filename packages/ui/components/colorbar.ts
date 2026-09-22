// Reusable colorbar strip: a gradient bar with min/mid/max tick labels (monospace) and optional
// clip shading showing which value bands are hidden. We draw our own DOM colorbar because NiiVue's
// on-canvas colorbar is deliberately disabled (isColorbar:false) to keep the render surfaces clean.
import { h } from '../dom.ts'

export interface ColorbarState {
  gradient: string
  min: number
  max: number
  /** Value clip window; portions of the bar outside [clipLow, clipHigh] are dimmed as hidden. */
  clipLow?: number | null
  clipHigh?: number | null
  unit?: string
  /** Optional [min, mid, max] tick labels that replace the numeric ticks with semantic anchors
   *  (e.g. somatotopy's foot / hand / face). Clip shading still uses the numeric min/max. */
  ticks?: [string, string, string]
}

export interface Colorbar {
  element: HTMLElement
  set: (state: ColorbarState) => void
  hide: () => void
}

const fmt = (v: number): string => {
  if (!Number.isFinite(v)) return '—'
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2)
  return s.replace(/\.?0+$/, '') || '0'
}

export function createColorbar(label = 'Range'): Colorbar {
  const gradient = h('div', { class: 'colorbar-gradient' })
  const clipLo = h('div', { class: 'colorbar-clip lo' })
  const clipHi = h('div', { class: 'colorbar-clip hi' })
  const track = h('div', { class: 'colorbar-track' }, [gradient, clipLo, clipHi])
  const tMin = h('span', { class: 'colorbar-tick' }, ['—'])
  const tMid = h('span', { class: 'colorbar-tick' }, ['—'])
  const tMax = h('span', { class: 'colorbar-tick' }, ['—'])
  const ticks = h('div', { class: 'colorbar-ticks' }, [tMin, tMid, tMax])
  const head = h('div', { class: 'colorbar-head muted' }, [label])
  const element = h('div', { class: 'colorbar', hidden: true }, [head, track, ticks])

  const pctOf = (v: number, min: number, max: number): number => {
    if (!(max > min)) return 0
    return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))
  }

  return {
    element,
    hide: () => (element.hidden = true),
    set: (s) => {
      element.hidden = false
      // Longhand, not the `background` shorthand: the shorthand resets background-origin/-clip and
      // would clobber stylesheet rules on any bordered target. Harmless here (.colorbar-gradient is
      // inset:0 with no border of its own) but kept uniform so the pattern is never copied.
      gradient.style.backgroundImage = s.gradient
      const unit = s.unit ? ` ${s.unit}` : ''
      // Semantic tick labels (e.g. foot/hand/face) override the numeric readout when provided.
      if (s.ticks) {
        ;[tMin.textContent, tMid.textContent, tMax.textContent] = s.ticks
      } else {
        tMin.textContent = fmt(s.min) + unit
        tMid.textContent = fmt((s.min + s.max) / 2)
        tMax.textContent = fmt(s.max) + unit
      }
      // Clip shading: dim the hidden bands at each end.
      const lo = s.clipLow ?? null
      const hi = s.clipHigh ?? null
      if (lo !== null && lo > s.min) {
        clipLo.hidden = false
        clipLo.style.width = `${pctOf(lo, s.min, s.max)}%`
      } else clipLo.hidden = true
      if (hi !== null && hi < s.max) {
        clipHi.hidden = false
        clipHi.style.width = `${100 - pctOf(hi, s.min, s.max)}%`
      } else clipHi.hidden = true
    },
  }
}
