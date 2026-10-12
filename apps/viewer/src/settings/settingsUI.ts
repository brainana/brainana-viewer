// The settings dialog: a side nav of sections, each a few titled groups of `label | control` rows.
// Every change saves immediately (no OK/cancel). Viewing defaults affect the next subject load; the
// "apply to current view" action pushes them onto what is on screen now.
//
// Mounted per open and removed on close, like the other dialogs (report/dialog.ts,
// ui/dialogs/sources.ts), so it always renders the current preferences.
import { h, errorText, dismissOnBackdrop } from '@brainana/ui/dom.ts'
import { STORAGE_ERROR_EVENT, preferenceStorageError } from '@brainana/core-client/preferenceStorage.ts'
import { FOV_MODES, type FovMode } from '../state/fovMode.ts'
import {
  DEFAULTS,
  DESTINATIONS,
  LAYOUTS,
  MARKER_MODES,
  SURFACES,
  TEXT_SIZES,
  THEMES,
  exportPreferences,
  parseSettingsFile,
  prefs,
  savePreferences,
  type Preferences,
  type Section,
} from './preferences.ts'

export interface SettingsActions {
  /** Push the viewing defaults onto the loaded subject. Throws with a user-facing reason if it can't. */
  applyToView: () => Promise<void>
  resetPanels: () => void
  /** The sticky FOV choice lives with the toolbar toggle (state/fovMode.ts), not in preferences. */
  fov: () => FovMode
  setFov: (mode: FovMode) => void
}

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'viewing', label: 'viewing' },
  { id: 'navigation', label: 'navigation' },
  { id: 'reports', label: 'reports' },
  { id: 'appearance', label: 'appearance' },
]

const LAYOUT_LABELS: Record<(typeof LAYOUTS)[number], string> = { column: 'planes in a column', row: 'planes in a row', grid: '2×2 grid' }
const MARKER_LABELS: Record<(typeof MARKER_MODES)[number], string> = { nearestNode: 'nearest vertex', crosshair3d: '3D crosshair' }
const DESTINATION_LABELS: Record<(typeof DESTINATIONS)[number], string> = { download: 'download', dataset: 'save into the dataset' }

type Option = { value: string; label: string }
const options = (values: readonly string[], labels?: Record<string, string>): Option[] =>
  values.map((value) => ({ value, label: labels?.[value] ?? value }))
// ARIA as attributes (not the reflected properties) so they are visible to every DOM implementation.
function aria<E extends HTMLElement>(el: E, attrs: Record<string, string>): E {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

let openDialog: (() => void) | null = null

export function openSettings(actions: SettingsActions): void {
  if (openDialog) return
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let section: Section = 'viewing'

  const overlay = h('div', { class: 'overlay', id: 'viewer-settings' })
  const msg = aria(h('span', { class: 'msg' }), { role: 'status' })
  const status = (text: string, isError = false): void => {
    msg.textContent = text
    msg.classList.toggle('error', isError)
  }
  const onStorageError = (e: Event): void => status(`not saved: ${(e as CustomEvent<string>).detail}`, true)

  const close = (): void => {
    window.removeEventListener(STORAGE_ERROR_EVENT, onStorageError)
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
    openDialog = null
    returnFocus?.focus({ preventScroll: true })
  }
  openDialog = close
  dismissOnBackdrop(overlay, close)

  // --- controls bound to one preference --------------------------------------------------------
  const update = <S extends Section>(s: S, patch: Partial<Preferences[S]>): void => {
    const next = structuredClone(prefs()) as Preferences
    Object.assign(next[s], patch)
    savePreferences(next)
    status('saved')
  }
  type Key<S extends Section> = keyof Preferences[S] & string

  function check<S extends Section>(s: S, key: Key<S>, label?: string): HTMLElement {
    const input = h('input', { type: 'checkbox', id: `settings-${s}-${key}` }) as HTMLInputElement
    input.checked = prefs()[s][key] as boolean
    input.addEventListener('change', () => update(s, { [key]: input.checked } as Partial<Preferences[S]>))
    return label ? h('label', { class: 'settings-check' }, [input, h('span', {}, [label])]) : input
  }

  function select<S extends Section>(s: S, key: Key<S>, opts: Option[]): HTMLSelectElement {
    const el = h('select', { id: `settings-${s}-${key}` }, opts.map((o) => h('option', { value: o.value }, [o.label]))) as HTMLSelectElement
    el.value = String(prefs()[s][key])
    el.addEventListener('change', () => update(s, { [key]: el.value } as Partial<Preferences[S]>))
    return el
  }

  function num<S extends Section>(s: S, key: Key<S>, min: number, max: number, step: number, title: string): HTMLInputElement {
    const el = h('input', { type: 'number', id: `settings-${s}-${key}`, min: String(min), max: String(max), step: String(step), title }) as HTMLInputElement
    el.value = String(prefs()[s][key])
    el.addEventListener('change', () => {
      const value = Number(el.value)
      if (!Number.isFinite(value)) return
      update(s, { [key]: value } as Partial<Preferences[S]>)
      el.value = String(prefs()[s][key]) // show the clamped value
    })
    return el
  }

  function color<S extends Section>(s: S, key: Key<S>, title: string): HTMLInputElement {
    const el = h('input', { type: 'color', id: `settings-${s}-${key}`, title }) as HTMLInputElement
    el.value = String(prefs()[s][key])
    el.addEventListener('change', () => update(s, { [key]: el.value } as Partial<Preferences[S]>))
    return el
  }

  // --- layout helpers --------------------------------------------------------------------------
  const row = (label: string, ...controls: HTMLElement[]): HTMLElement[] => [
    h('span', { class: 'settings-label' }, [label]),
    h('div', { class: 'settings-control' }, controls),
  ]
  const group = (title: string, rows: HTMLElement[][], extra: HTMLElement[] = []): HTMLElement =>
    h('section', { class: 'settings-group' }, [h('h3', {}, [title]), h('div', { class: 'settings-rows' }, rows.flat()), ...extra])
  const hint = (text: string): HTMLElement => h('p', { class: 'settings-hint' }, [text])
  const action = (label: string, run: () => unknown | Promise<unknown>, done: string): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'ghost' }, [label]) as HTMLButtonElement
    b.addEventListener('click', () => {
      b.disabled = true
      Promise.resolve()
        .then(run)
        .then(() => status(done))
        .catch((err: unknown) => status(errorText(err), true))
        .finally(() => (b.disabled = false))
    })
    return b
  }
  const actionsRow = (...buttons: HTMLElement[]): HTMLElement => h('div', { class: 'settings-actions' }, buttons)

  // --- sections --------------------------------------------------------------------------------
  function viewing(): HTMLElement[] {
    const fov = h('select', { id: 'settings-viewing-fov' }, FOV_MODES.map((m) => h('option', { value: m.mode, title: m.title }, [m.label]))) as HTMLSelectElement
    fov.value = actions.fov()
    fov.addEventListener('change', () => {
      actions.setFov(fov.value as FovMode)
      status('saved')
    })
    return [
      group(
        'new subjects open with',
        [
          row('layout', select('viewing', 'layout', options(LAYOUTS, LAYOUT_LABELS))),
          row('surface', select('viewing', 'surface', options(SURFACES))),
          row('hemispheres', check('viewing', 'left', 'LH'), check('viewing', 'right', 'RH')),
          row(
            'crosshair',
            check('viewing', 'crosshair', 'show'),
            color('viewing', 'crosshairColor', 'Crosshair colour'),
            num('viewing', 'crosshairWidth', 1, 5, 1, 'Crosshair line width (px)'),
          ),
          row('orientation labels', check('viewing', 'orientation', 'show')),
          row(
            'surface marker',
            check('viewing', 'marker', 'show'),
            num('viewing', 'markerSize', 0.3, 3, 0.1, 'Marker size'),
            select('viewing', 'markerMode', options(MARKER_MODES, MARKER_LABELS)),
          ),
          row('field of view', fov),
          row('between subjects', check('viewing', 'carryAcrossSubjects', 'keep my current choices')),
        ],
        [
          hint('When “keep my current choices” is off, every subject opens with these defaults.'),
          actionsRow(action('apply to current view', actions.applyToView, 'applied to the current view')),
        ],
      ),
      group('panels', [row('panel sizes', check('viewing', 'rememberPanels', 'remember between launches'))], [
        actionsRow(action('reset panel sizes', actions.resetPanels, 'panel sizes reset')),
      ]),
    ]
  }

  function navigation(): HTMLElement[] {
    return [
      group('slices', [
        row('scroll wheel', check('navigation', 'reverseScroll', 'reverse slice direction')),
        row('arrow-key step', num('navigation', 'arrowStep', 0.1, 10, 0.1, 'Crosshair step per arrow key'), h('span', { class: 'muted' }, ['mm'])),
      ]),
    ]
  }

  function reports(): HTMLElement[] {
    return [
      group(
        'report defaults',
        [
          row('screenshots', check('reports', 'screenshots', 'include')),
          row('destination', select('reports', 'destination', options(DESTINATIONS, DESTINATION_LABELS))),
        ],
        [hint('These pre-fill the report dialog; you can still change them there.')],
      ),
    ]
  }

  function appearance(): HTMLElement[] {
    return [
      group(
        'interface',
        [
          row('theme', select('appearance', 'theme', [...THEMES])),
          row('text size', select('appearance', 'textSize', [...TEXT_SIZES])),
          row('controls', check('appearance', 'largeControls', 'larger click targets')),
        ],
        [hint('Image and overlay colours are not affected.')],
      ),
    ]
  }

  const RENDER: Record<Section, () => HTMLElement[]> = { viewing, navigation, reports, appearance }

  // --- shell -----------------------------------------------------------------------------------
  const pane = aria(h('div', { class: 'settings-pane', id: 'settings-pane' }), { role: 'tabpanel' })
  const tabs = SECTIONS.map(({ id, label }) => {
    const b = aria(h('button', { type: 'button', class: 'settings-tab', id: `settings-tab-${id}` }, [label]), { role: 'tab', 'aria-controls': 'settings-pane' })
    b.dataset.section = id
    b.addEventListener('click', () => show(id))
    return b
  })
  function show(id: Section): void {
    section = id
    for (const t of tabs) {
      const on = t.dataset.section === id
      t.classList.toggle('active', on)
      t.setAttribute('aria-selected', String(on))
      t.tabIndex = on ? 0 : -1
    }
    pane.setAttribute('aria-labelledby', `settings-tab-${id}`)
    pane.replaceChildren(...RENDER[id]())
  }
  const nav = aria(h('nav', { class: 'settings-nav' }, tabs), { role: 'tablist', 'aria-label': 'Settings sections', 'aria-orientation': 'vertical' })
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = SECTIONS.findIndex((s) => s.id === section)
    const next = SECTIONS[(i + (e.key === 'ArrowDown' ? 1 : SECTIONS.length - 1)) % SECTIONS.length].id
    show(next)
    tabs.find((t) => t.dataset.section === next)?.focus()
  })

  // --- footer: reset / export / import ---------------------------------------------------------
  const resetBtn = h('button', { type: 'button', class: 'ghost', title: 'Restore this section’s defaults' }, ['reset section'])
  resetBtn.addEventListener('click', () => {
    const next = structuredClone(prefs()) as Preferences
    ;(next as Record<Section, unknown>)[section] = structuredClone(DEFAULTS[section])
    savePreferences(next)
    show(section)
    status(`${section} reset to defaults`)
  })
  const exportBtn = h('button', { type: 'button', class: 'ghost', title: 'Save these settings to a file' }, ['export'])
  exportBtn.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportPreferences()], { type: 'application/json' }))
    h('a', { href: url, download: 'brainana-viewer-settings.json' }).click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  })
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement
  const importBtn = h('button', { type: 'button', class: 'ghost', title: 'Load settings from a file' }, ['import'])
  importBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    if (file.size > 100_000) return status('settings file is too large', true)
    file
      .text()
      .then((text) => {
        savePreferences(parseSettingsFile(text))
        show(section)
        status('settings imported')
      })
      .catch((err: unknown) => status(errorText(err), true))
  })

  const closeBtn = aria(h('button', { type: 'button', class: 'ghost' }, ['close']), { 'aria-label': 'Close settings' })
  closeBtn.addEventListener('click', close)

  const dialog = aria(h('div', { class: 'dialog settings-dialog' }, [
    h('div', { class: 'dialog-head' }, [h('h2', {}, ['settings']), h('span', { class: 'spacer' }), closeBtn]),
    h('div', { class: 'settings-body' }, [nav, pane]),
    h('div', { class: 'dialog-foot' }, [msg, h('span', { class: 'spacer' }), resetBtn, exportBtn, importBtn, fileInput]),
  ]), { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' })

  // Escape closes; Tab stays inside the dialog while it is open.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
    } else if (e.key === 'Tab') {
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), select:not(:disabled)')).filter(
        (el) => el.tabIndex >= 0,
      )
      const first = items[0]
      const last = items.at(-1)
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
  }
  document.addEventListener('keydown', onKey, true)
  window.addEventListener(STORAGE_ERROR_EVENT, onStorageError)

  show(section)
  const storageProblem = preferenceStorageError()
  if (storageProblem) status(storageProblem, true)
  overlay.append(dialog)
  document.body.append(overlay)
  tabs.find((t) => t.dataset.section === section)?.focus({ preventScroll: true })
}

export function closeSettings(): void {
  openDialog?.()
}

export function settingsOpen(): boolean {
  return openDialog !== null
}
