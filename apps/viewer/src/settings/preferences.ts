// Personal Viewer settings: one versioned JSON document in preference storage (localStorage in the
// browser, the desktop preference files in the app — see core-client/preferenceStorage.ts).
//
// Everything read from storage or an imported file goes through normalizePreferences(): unknown
// keys are dropped, wrong types fall back to the default, enums and numbers are bounded. Callers
// can therefore trust prefs() without re-validating.
//
// The FOV choice is deliberately NOT here: it already has its own sticky key (state/fovMode.ts),
// written by the toolbar toggle, and two sources of truth for one choice drift apart.
import { preferenceStorage } from '@brainana/core-client/preferenceStorage.ts'

export const PREFERENCES_KEY = 'brainana.viewer.preferences.v1'
export const PANEL_SIZES_KEY = 'brainana.viewer.panels.v1'
export const GUIDE_KEY = 'brainana.viewer.guide.v1'
/** Fired on window after the saved preferences change. */
export const PREFERENCES_CHANGED = 'brainana-preferences-changed'

export const THEMES = [
  { value: 'graphite', label: 'graphite + amber' },
  { value: 'neutral', label: 'neutral dark' },
  { value: 'contrast', label: 'high contrast' },
] as const
export const TEXT_SIZES = [
  { value: 'normal', label: 'normal' },
  { value: 'large', label: 'large' },
  { value: 'larger', label: 'larger' },
] as const
export const LAYOUTS = ['column', 'row', 'grid'] as const
export const SURFACES = ['inflated', 'pial', 'white', 'smoothwm', 'sphere'] as const
export const MARKER_MODES = ['nearestNode', 'crosshair3d'] as const
export const DESTINATIONS = ['download', 'dataset'] as const

export interface Preferences {
  appearance: {
    theme: (typeof THEMES)[number]['value']
    textSize: (typeof TEXT_SIZES)[number]['value']
    largeControls: boolean
  }
  viewing: {
    layout: (typeof LAYOUTS)[number]
    surface: (typeof SURFACES)[number]
    left: boolean
    right: boolean
    crosshair: boolean
    crosshairColor: string
    crosshairWidth: number
    orientation: boolean
    marker: boolean
    markerSize: number
    markerMode: (typeof MARKER_MODES)[number]
    carryAcrossSubjects: boolean
    rememberPanels: boolean
  }
  navigation: {
    reverseScroll: boolean
    arrowStep: number
  }
  reports: {
    screenshots: boolean
    destination: (typeof DESTINATIONS)[number]
  }
  guide: {
    openOnLaunch: boolean
    rememberProgress: boolean
  }
}

export type Section = keyof Preferences

export const DEFAULTS: Preferences = {
  appearance: { theme: 'graphite', textSize: 'normal', largeControls: false },
  viewing: {
    layout: 'column',
    surface: 'inflated',
    left: true,
    right: true,
    crosshair: true,
    crosshairColor: '#8bbf6e', // --ok: legible on grey anatomy, distinct from the amber accent
    crosshairWidth: 1,
    orientation: true,
    marker: true,
    markerSize: 1,
    markerMode: 'nearestNode',
    carryAcrossSubjects: true,
    rememberPanels: true,
  },
  navigation: { reverseScroll: false, arrowStep: 1.5 },
  reports: { screenshots: true, destination: 'download' },
  guide: { openOnLaunch: false, rememberProgress: true },
}

// Constraints beyond "same type as the default".
type Rule = { choices: readonly string[] } | { min: number; max: number } | { pattern: RegExp }
const RULES: { [S in Section]?: { [K in keyof Preferences[S]]?: Rule } } = {
  appearance: { theme: { choices: THEMES.map((t) => t.value) }, textSize: { choices: TEXT_SIZES.map((t) => t.value) } },
  viewing: {
    layout: { choices: LAYOUTS },
    surface: { choices: SURFACES },
    markerMode: { choices: MARKER_MODES },
    crosshairColor: { pattern: /^#[0-9a-f]{6}$/i },
    crosshairWidth: { min: 1, max: 5 },
    markerSize: { min: 0.3, max: 3 },
  },
  navigation: { arrowStep: { min: 0.1, max: 10 } },
  reports: { destination: { choices: DESTINATIONS } },
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function normalizePreferences(input: unknown): Preferences {
  const out = structuredClone(DEFAULTS)
  if (!isRecord(input)) return out
  for (const section of Object.keys(out) as Section[]) {
    const given = input[section]
    if (!isRecord(given)) continue
    const target = out[section] as Record<string, unknown>
    const rules = (RULES[section] ?? {}) as Record<string, Rule | undefined>
    for (const [key, fallback] of Object.entries(target)) {
      const value = given[key]
      if (typeof value !== typeof fallback) continue
      if (typeof value === 'number' && !Number.isFinite(value)) continue
      const rule = rules[key]
      if (rule && 'choices' in rule && !rule.choices.includes(value as string)) continue
      if (rule && 'pattern' in rule && !rule.pattern.test(value as string)) continue
      target[key] = rule && 'min' in rule ? Math.min(rule.max, Math.max(rule.min, value as number)) : value
    }
  }
  // Hiding both hemispheres would leave an empty surface pane with no obvious way back.
  if (!out.viewing.left && !out.viewing.right) out.viewing.left = true
  return out
}

let current: Preferences = structuredClone(DEFAULTS)

/** The live preferences. Read-only by convention: change them through savePreferences(). */
export function prefs(): Readonly<Preferences> {
  return current
}

export function loadPreferences(): void {
  current = normalizePreferences(readJson(PREFERENCES_KEY))
  applyAppearance(current)
}

/** Validate, persist and apply. Storage failures are reported by preferenceStorage's error event. */
export function savePreferences(next: Preferences): void {
  current = normalizePreferences(next)
  writeJson(PREFERENCES_KEY, current)
  applyAppearance(current)
  window.dispatchEvent(new Event(PREFERENCES_CHANGED))
}

// Themes, text size and control size are CSS token overrides keyed off these attributes
// (apps/viewer/src/style.css, "personal appearance"); the image canvases are unaffected.
export function applyAppearance(p: Preferences): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = p.appearance.theme
  root.dataset.textSize = p.appearance.textSize
  root.dataset.largeControls = String(p.appearance.largeControls)
}

// --- settings files ------------------------------------------------------------------------------

const FILE_TAG = { app: 'brainana-viewer', kind: 'settings', version: 1 }

export function exportPreferences(): string {
  return JSON.stringify({ ...FILE_TAG, preferences: current }, null, 2)
}

export function parseSettingsFile(text: string): Preferences {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('not a settings file (invalid JSON)')
  }
  if (!isRecord(data) || data.app !== FILE_TAG.app || data.kind !== FILE_TAG.kind || data.version !== FILE_TAG.version) {
    throw new Error('not a Brainana Viewer settings file')
  }
  return normalizePreferences(data.preferences)
}

// --- small JSON helpers for the other viewer keys --------------------------------------------------

export function readJson(key: string): unknown {
  try {
    const raw = preferenceStorage()?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    const store = preferenceStorage()
    if (value === null) store?.removeItem(key)
    else store?.setItem(key, JSON.stringify(value))
  } catch {
    // Best-effort, like every other remembered choice: storage trouble must never break the UI.
  }
}

export function hexToRgba(hex: string): [number, number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return [r, g, b, 1]
}
