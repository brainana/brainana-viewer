// Reusable colormap picker: a trigger button showing the active map's gradient + label, and a
// grouped popover of gradient swatches. Framework-free (built with the h() helper); the host
// supplies the CSS gradient per colormap key (see data/colormap.ts + niivue buildColormapAssets).
import { h } from '@brainana/ui/dom.ts'
import { COLORMAP_REGISTRY, type ColormapInfo } from '../../data/colormap.ts'

export interface ColormapPickerOptions {
  gradients: Record<string, string>
  value?: string
  onChange: (key: string) => void
  /** Restrict/reorder the offered maps; defaults to the full registry. */
  infos?: ColormapInfo[]
}

export interface ColormapPicker {
  element: HTMLElement
  value: () => string
  setValue: (key: string) => void
  setGradients: (g: Record<string, string>) => void
  /** Replace the offered maps (e.g. drop the categorical "labels" entry for a continuous atlas). */
  setInfos: (infos: ColormapInfo[]) => void
}

const FALLBACK = 'linear-gradient(90deg, rgb(20,18,13), rgb(236,230,216))'

export function createColormapPicker(opts: ColormapPickerOptions): ColormapPicker {
  let infos = opts.infos ?? COLORMAP_REGISTRY
  let gradients = opts.gradients
  let current = opts.value ?? infos[0]?.key ?? 'gray'
  let open = false

  const swatch = h('span', { class: 'cmap-swatch' })
  const label = h('span', { class: 'cmap-label' }, [labelFor(current)])
  const trigger = h('button', { type: 'button', class: 'cmap-trigger' }, [swatch, label, h('span', { class: 'cmap-caret' }, ['▾'])]) as HTMLButtonElement
  const pop = h('div', { class: 'cmap-pop', hidden: true })
  const element = h('div', { class: 'cmap-picker' }, [trigger, pop])

  function labelFor(key: string): string {
    return infos.find((i) => i.key === key)?.label ?? key
  }
  function grad(key: string): string {
    return gradients[key] ?? FALLBACK
  }

  function paintTrigger(): void {
    swatch.style.background = grad(current)
    label.textContent = labelFor(current)
  }

  function buildOptions(): void {
    pop.innerHTML = ''
    let lastGroup = ''
    for (const info of infos) {
      if (info.group !== lastGroup) {
        pop.append(h('div', { class: 'cmap-group' }, [info.group]))
        lastGroup = info.group
      }
      const optSwatch = h('span', { class: 'cmap-swatch' })
      optSwatch.style.background = grad(info.key)
      const btn = h('button', { type: 'button', class: `cmap-option${info.key === current ? ' active' : ''}` }, [
        optSwatch,
        h('span', { class: 'cmap-label' }, [info.label]),
        ...(info.cyclic ? [h('span', { class: 'cmap-tag' }, ['cyclic'])] : []),
      ]) as HTMLButtonElement
      btn.addEventListener('click', () => {
        select(info.key)
        close()
      })
      pop.append(btn)
    }
  }

  function select(key: string): void {
    if (key === current) return
    current = key
    paintTrigger()
    for (const b of pop.querySelectorAll('.cmap-option')) b.classList.remove('active')
    opts.onChange(key)
  }

  const onDocPointer = (e: Event): void => {
    if (!element.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }

  // Position the popover with position:fixed anchored to the trigger's viewport rect so it escapes
  // any ancestor overflow/clipping (the color-display section is docked at the bottom of a scrollable
  // side panel). Drop UP when there is more room above than below, and cap the height to the available
  // space so the list always fits and scrolls internally instead of being cut off.
  const GAP = 4
  const positionPop = (): void => {
    const r = trigger.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - GAP
    const above = r.top - GAP
    const dropUp = below < 200 && above > below
    pop.style.position = 'fixed'
    pop.style.left = `${r.left}px`
    pop.style.width = `${r.width}px`
    pop.style.right = 'auto'
    pop.style.maxHeight = `${Math.min(320, Math.max(120, dropUp ? above : below))}px`
    if (dropUp) {
      pop.style.top = 'auto'
      pop.style.bottom = `${window.innerHeight - r.top + GAP}px`
    } else {
      pop.style.bottom = 'auto'
      pop.style.top = `${r.bottom + GAP}px`
    }
  }

  function openPop(): void {
    if (open) return
    open = true
    buildOptions()
    pop.hidden = false
    positionPop()
    trigger.classList.add('open')
    document.addEventListener('pointerdown', onDocPointer, true)
    document.addEventListener('keydown', onKey)
    // Keep it anchored if the panel scrolls or the window resizes while open (capture catches scrolls
    // on inner scrollers, not just window).
    document.addEventListener('scroll', positionPop, true)
    window.addEventListener('resize', positionPop)
  }
  function close(): void {
    if (!open) return
    open = false
    pop.hidden = true
    trigger.classList.remove('open')
    document.removeEventListener('pointerdown', onDocPointer, true)
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('scroll', positionPop, true)
    window.removeEventListener('resize', positionPop)
  }

  trigger.addEventListener('click', () => (open ? close() : openPop()))
  paintTrigger()

  // openPop() registers four listeners on document/window, and only close() removes them. Those
  // outlive the element, because document and window do — so a picker discarded while its popup is
  // open (a panel rebuilt via innerHTML = '', which is how this UI re-renders) leaks all four, and
  // each of them closes over the detached trigger and popup, holding that DOM alive too.
  //
  // Watching for the element leaving the DOM ties the listeners' lifetime to the component's
  // instead of to the user remembering to click elsewhere first. Guarded because MutationObserver
  // is absent in a non-DOM context (the module is imported by unit tests).
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    const detachWatcher = new MutationObserver(() => {
      if (element.isConnected) return
      close() // removes the document/window listeners
      detachWatcher.disconnect()
    })
    detachWatcher.observe(document.body, { childList: true, subtree: true })
  }

  return {
    element,
    value: () => current,
    setValue: (key) => {
      current = key
      paintTrigger()
    },
    setGradients: (g) => {
      gradients = g
      paintTrigger()
      if (open) buildOptions()
    },
    setInfos: (next) => {
      infos = next.length ? next : COLORMAP_REGISTRY
      paintTrigger() // label lookup uses infos
      if (open) buildOptions()
    },
  }
}
