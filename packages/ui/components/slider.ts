// Single labelled slider with an editable numeric box, laid out on one row (label · slider · box).
// Generalized so the panels stop hand-rolling `<input type="range">` + a read-out span; the box is
// a real `<input type="number">` so the value can be typed as well as dragged. The two stay in sync.
import { h } from '../dom.ts'

export interface SliderOptions {
  label: string
  min: number
  max: number
  step: number
  value: number
  onInput: (v: number) => void
  /** Optional formatter for the label suffix (e.g. "F ≥ 1.20"); shown after the label text. */
  suffix?: (v: number) => string
  /** Optional formatter for the editable number box read-out (e.g. fixed 4 decimals). Default: String. */
  format?: (v: number) => string
  /** Drop the editable number box, keeping only the slider (e.g. tight toolbar slots). */
  hideBox?: boolean
  disabled?: boolean
}

export interface Slider {
  element: HTMLElement
  value: () => number
  setValue: (v: number) => void
  setBounds: (min: number, max: number, step?: number) => void
  setDisabled: (disabled: boolean) => void
  /** Relabel in place — for a slider whose meaning follows another control (see the change panel's
   *  magnitude threshold, which names the statistic it is thresholding). */
  setLabel: (label: string) => void
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function createSlider(opts: SliderOptions): Slider {
  let min = opts.min
  let max = opts.max
  let step = opts.step
  const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(opts.value) }) as HTMLInputElement
  const box = h('input', { type: 'number', class: 'slider-num', min: String(min), max: String(max), step: String(step), value: String(opts.value) }) as HTMLInputElement
  const suffixEl = opts.suffix ? h('span', { class: 'muted slider-suffix' }, [opts.suffix(opts.value)]) : null
  let labelText = opts.label
  const labelEl = h('span', { class: 'slider-label' }, suffixEl ? [`${labelText} `, suffixEl] : [labelText])
  const fmtBox = opts.format ?? String // number-box read-out formatter; range input stays raw-numeric

  const sync = (v: number, source: 'range' | 'box' | 'both'): void => {
    if (source !== 'range') range.value = String(v)
    if (source !== 'box') box.value = fmtBox(v)
    if (suffixEl && opts.suffix) suffixEl.textContent = opts.suffix(v)
  }
  range.addEventListener('input', () => {
    const v = Number(range.value)
    sync(v, 'range')
    opts.onInput(v)
  })
  // The box commits on change/blur (not every keystroke); empty/NaN restores the current slider value.
  const commitBox = (): void => {
    if (box.value.trim() === '' || Number.isNaN(Number(box.value))) {
      box.value = range.value
      return
    }
    const v = clamp(Number(box.value), min, max)
    sync(v, 'box')
    box.value = fmtBox(v)
    opts.onInput(v)
  }
  box.addEventListener('change', commitBox)

  // The box stays wired for value sync; when hidden it's simply not placed in the DOM (its change
  // listener then never fires), so value()/setValue() keep working unchanged.
  const rowKids = opts.hideBox ? [range] : [range, box]
  const element = h('label', { class: 'field slider-field' }, [labelEl, h('div', { class: 'slider-row' }, rowKids)])
  if (opts.disabled) {
    range.disabled = true
    box.disabled = true
  }

  return {
    element,
    value: () => Number(range.value),
    setValue: (v) => {
      const c = clamp(v, min, max)
      sync(c, 'both')
    },
    setBounds: (lo, hi, st) => {
      min = lo
      max = hi
      if (st != null) step = st
      for (const inp of [range, box]) {
        inp.min = String(min)
        inp.max = String(max)
        inp.step = String(step)
      }
    },
    setDisabled: (disabled) => {
      range.disabled = disabled
      box.disabled = disabled
      element.classList.toggle('is-disabled', disabled)
    },
    setLabel: (label) => {
      labelText = label
      // Rebuild rather than set textContent: the suffix span is a child of the label and would be
      // wiped by a plain assignment.
      labelEl.textContent = ''
      if (suffixEl) labelEl.append(`${labelText} `, suffixEl)
      else labelEl.append(labelText)
    },
  }
}
