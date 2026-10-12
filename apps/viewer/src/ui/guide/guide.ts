// The guided tour's floating card: highlights the control the current step is about, places itself
// beside it, and offers a one-click helper where one makes sense. What each step says lives in
// steps.ts; this file is only the DOM.
//
// The guide never drives the app by itself. It polls the live state while open (cheap: a handful of
// DOM lookups) and re-renders only when the step actually changes, so it follows whatever the user
// does — including things done with the guide hidden.
import { h } from '@brainana/ui/dom.ts'
import { GUIDE_KEY, PREFERENCES_CHANGED, prefs, readJson, writeJson } from '../../settings/preferences.ts'
import { setupStep, tourSteps, type GuideState, type GuideStep } from './steps.ts'

export interface GuideDeps {
  readState: () => GuideState
  openDatasets: () => void
  retry: () => void
  openSettings: () => void
}

const POLL_MS = 300
const GAP = 12 // px between the card and what it points at / the window edge

export function installGuide(button: HTMLButtonElement, deps: GuideDeps): void {
  const progress = h('span', { class: 'guide-progress' })
  const hideBtn = h('button', { type: 'button', class: 'ghost sm guide-hide', title: 'Hide the guide; “resume guide” continues' }, ['×'])
  hideBtn.setAttribute('aria-label', 'Hide guide')
  const head = h('div', { class: 'guide-head', title: 'Drag to move' }, [h('span', { class: 'guide-kicker' }, ['guided setup']), progress, hideBtn])
  const title = h('h2', { id: 'guide-title', tabIndex: -1 })
  const text = h('p', { id: 'guide-text' })
  const actions = h('div', { class: 'guide-actions' })
  const stopSelect = h('select', { id: 'guide-stop', title: 'Jump to a stop' }) as HTMLSelectElement
  const backBtn = h('button', { type: 'button', class: 'ghost' }, ['back']) as HTMLButtonElement
  const nextBtn = h('button', { type: 'button', class: 'primary' }, ['next']) as HTMLButtonElement
  const nav = h('div', { class: 'guide-nav' }, [stopSelect, backBtn, nextBtn])
  const endBtn = h('button', { type: 'button', class: 'ghost sm' }, ['end tour'])
  const card = h('section', { id: 'guided-card', class: 'guide-card', hidden: true }, [
    head,
    title,
    text,
    actions,
    nav,
    h('div', { class: 'guide-foot' }, [endBtn]),
  ])
  for (const [k, v] of Object.entries({ role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': title.id, 'aria-describedby': text.id })) card.setAttribute(k, v)
  text.setAttribute('aria-live', 'polite')
  document.body.append(card)

  let open = false
  let started = false // a tour is in progress (drives the "resume guide" label)
  let tourKey: string | null = null
  let timer: number | undefined
  let target: HTMLElement | null = null
  let rendered = ''
  let roster = ''
  let pinned: { x: number; y: number } | null = null // set by dragging the header

  const saved = readJson(GUIDE_KEY) as { step?: unknown } | null
  if (prefs().guide.rememberProgress && typeof saved?.step === 'string') {
    tourKey = saved.step
    started = true
  }

  const persist = (): void => {
    if (prefs().guide.rememberProgress && tourKey) writeJson(GUIDE_KEY, { step: tourKey })
  }
  const syncButton = (): void => {
    button.textContent = !open && started ? 'resume guide' : 'guided setup'
    button.classList.toggle('active', open)
    button.setAttribute('aria-expanded', String(open))
  }

  const highlight = (el: HTMLElement | null): void => {
    if (el === target) return
    target?.classList.remove('guided-target')
    target = el
    target?.classList.add('guided-target')
  }

  // --- placement ---------------------------------------------------------------------------------
  // Beside the target where it fits (below, left, above, right — in that order), else the bottom-
  // right corner. A dragged card stays where it was put until the guide is hidden.
  function place(): void {
    if (!open) return
    const w = card.offsetWidth
    const ht = card.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const clampX = (x: number): number => Math.max(GAP, Math.min(x, vw - w - GAP))
    const clampY = (y: number): number => Math.max(GAP, Math.min(y, vh - ht - GAP))
    let x = vw - w - GAP
    let y = vh - ht - GAP
    if (pinned) {
      x = pinned.x
      y = pinned.y
    } else if (target) {
      const r = target.getBoundingClientRect()
      const spots: Array<[number, number, boolean]> = [
        [r.left, r.bottom + GAP, r.bottom + GAP + ht <= vh - GAP],
        [r.left - w - GAP, r.top, r.left - w - GAP >= GAP],
        [r.left, r.top - ht - GAP, r.top - ht - GAP >= GAP],
        [r.right + GAP, r.top, r.right + GAP + w <= vw - GAP],
      ]
      const fit = spots.find(([, , ok]) => ok)
      if (fit) [x, y] = fit
    }
    card.style.left = `${clampX(x)}px`
    card.style.top = `${clampY(y)}px`
  }

  // --- rendering ---------------------------------------------------------------------------------
  function current(state: GuideState): { step: GuideStep; steps: GuideStep[] | null } {
    const setup = setupStep(state)
    if (setup) return { step: setup, steps: null }
    const steps = tourSteps(state)
    // Keep the current stop across subject/scan switches when the new subject has it too.
    const step = steps.find((s) => s.key === tourKey) ?? steps[0]
    return { step, steps }
  }

  function refresh(): void {
    if (!open) return
    const state = deps.readState()
    const { step, steps } = current(state)
    if (steps) {
      started = true
      if (tourKey !== step.key) {
        tourKey = step.key
        persist()
      }
      const names = steps.map((s) => `${s.key}:${s.title}`).join('|')
      if (names !== roster) {
        roster = names
        stopSelect.replaceChildren(...steps.map((s, i) => h('option', { value: s.key }, [`${i + 1}. ${s.title}`])))
      }
      const i = steps.indexOf(step)
      stopSelect.value = step.key
      progress.textContent = `${i + 1} / ${steps.length}`
      backBtn.disabled = i === 0
      nextBtn.disabled = i === steps.length - 1
    }
    nav.hidden = !steps
    progress.hidden = !steps

    const el = document.querySelector<HTMLElement>(step.target)
    const signature = [step.key, step.title, step.text, step.action?.label, el ? 'y' : 'n'].join('|')
    if (signature !== rendered) {
      rendered = signature
      title.textContent = step.title
      text.textContent = step.text
      actions.replaceChildren(...(step.action ? [actionButton(step)] : []))
      revealWithinScrollers(el)
    }
    highlight(el)
    place()
  }

  function actionButton(step: GuideStep): HTMLButtonElement {
    const action = step.action!
    const b = h('button', { type: 'button', class: 'ghost' }, [action.label]) as HTMLButtonElement
    const click = (selector: string): void => document.querySelector<HTMLElement>(selector)?.click()
    b.addEventListener('click', () => {
      if (action.id === 'open-datasets') deps.openDatasets()
      else if (action.id === 'retry') deps.retry()
      else if (action.id === 'open-settings') deps.openSettings()
      else if (action.id === 'focus-subject') document.querySelector<HTMLElement>('#monkey-select')?.focus()
      else if (action.id === 'add-point') click('#tour-add-point')
      else if (action.id === 'open-report') click('#tour-report')
      else if (action.id === 'open-panel' && action.tab) {
        const tab = document.querySelector<HTMLElement>(action.tab)
        if (tab && !tab.classList.contains('active')) tab.click()
      }
      refresh()
    })
    if (action.id === 'add-point') b.disabled = document.querySelector<HTMLButtonElement>('#tour-add-point')?.disabled ?? true
    return b
  }

  // --- open / hide / end -------------------------------------------------------------------------
  function show(): void {
    if (open) return
    open = true
    card.hidden = false
    rendered = ''
    syncButton()
    refresh()
    title.focus({ preventScroll: true })
    timer = window.setInterval(refresh, POLL_MS)
  }
  function hide(): void {
    if (!open) return
    open = false
    pinned = null
    card.hidden = true
    window.clearInterval(timer)
    highlight(null)
    syncButton()
    button.focus({ preventScroll: true })
  }
  function end(): void {
    hide()
    started = false
    tourKey = null
    writeJson(GUIDE_KEY, null)
    syncButton()
  }
  const go = (offset: number): void => {
    const state = deps.readState()
    if (setupStep(state)) return
    const steps = tourSteps(state)
    const i = Math.max(0, steps.findIndex((s) => s.key === tourKey))
    tourKey = steps[Math.max(0, Math.min(steps.length - 1, i + offset))].key
    persist()
    refresh()
  }

  button.setAttribute('aria-haspopup', 'dialog')
  button.addEventListener('click', () => (open ? hide() : show()))
  hideBtn.addEventListener('click', hide)
  endBtn.addEventListener('click', end)
  backBtn.addEventListener('click', () => go(-1))
  nextBtn.addEventListener('click', () => go(1))
  stopSelect.addEventListener('change', () => {
    tourKey = stopSelect.value
    persist()
    refresh()
  })
  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') hide()
  })
  window.addEventListener('resize', place)
  window.addEventListener(PREFERENCES_CHANGED, () => {
    if (!prefs().guide.rememberProgress) writeJson(GUIDE_KEY, null)
  })

  // Drag the header to move the card; it stays put until hidden.
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, left: card.offsetLeft, top: card.offsetTop }
    head.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      pinned = { x: start.left + ev.clientX - start.x, y: start.top + ev.clientY - start.y }
      place()
    }
    const stop = (): void => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', stop)
      head.removeEventListener('pointercancel', stop)
    }
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', stop)
    head.addEventListener('pointercancel', stop)
  })

  syncButton()
  if (prefs().guide.openOnLaunch) window.setTimeout(show, 0)
}

/**
 * Scroll `el` into view within the scroll containers that hold it — and ONLY those. Element
 * .scrollIntoView() also scrolls overflow-hidden ancestors, which can shift the whole clipped side
 * column and strand the panel picker out of reach; overflow:clip containers are left alone.
 */
export function revealWithinScrollers(el: HTMLElement | null): void {
  if (!el) return
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const overflow = window.getComputedStyle(p).overflowY
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    const box = p.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const top = box.top + p.clientTop
    const height = p.clientHeight
    if (!height) continue
    if (r.top < top || r.height > height) p.scrollTop += r.top - top
    else if (r.bottom > top + height) p.scrollTop += r.bottom - top - height
  }
}
