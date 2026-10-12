// What the guided tour says and points at — pure, so it is testable without a DOM.
//
// Two phases. SETUP walks a new user from nothing to a loaded subject; each step is derived from
// the live state (a dataset exists, the dialog is open, a load failed…), so the guide advances on
// real results, never on a click it merely hoped would work. The TOUR then visits one stop per
// feature, built from what the loaded subject actually has: no atlas, no atlas stops.
import type { Manifest } from '../../types.ts'
import { functionalModes } from '../../data/functional.ts'

export interface TourFeatures {
  volume: boolean
  surfaces: boolean
  fullFov: boolean
  atlases: boolean
  morphology: boolean
  retinotopy: boolean
  somatotopy: boolean
  changes: boolean
  scans: boolean
}

export interface GuideState {
  datasets: number
  subjects: number
  dialogOpen: boolean
  remoteOpen: boolean
  connected: boolean
  loading: boolean
  loaded: boolean
  error: string | null
  features: TourFeatures
  /** The docked side-panel tab ('atlas', 'function', …), or null. */
  activePanel: string | null
  reportOpen: boolean
}

export interface GuideStep {
  key: string
  /** CSS selector of the control to highlight. */
  target: string
  title: string
  text: string
  /** Optional one-click helper shown in the guide (handled by the guide controller). */
  action?: { id: GuideAction; label: string; tab?: string }
}

export type GuideAction = 'open-datasets' | 'focus-subject' | 'retry' | 'open-panel' | 'add-point' | 'open-report' | 'open-settings'

const NO_FEATURES: TourFeatures = {
  volume: false,
  surfaces: false,
  fullFov: false,
  atlases: false,
  morphology: false,
  retinotopy: false,
  somatotopy: false,
  changes: false,
  scans: false,
}

// Count only real files and selectable maps, not the mere presence of a toolbar tab.
export function tourFeatures(m: Manifest | null): TourFeatures {
  if (!m) return NO_FEATURES
  const pair = (p: { left?: string; right?: string } | null | undefined): boolean => Boolean(p?.left && p?.right)
  const surfaces = Object.values(m.surfaces ?? {}).some(pair)
  const shape = m.morphology?.shape
  return {
    volume: m.volumes.length > 0,
    surfaces,
    fullFov: m.volumes.length > 0 && Boolean(m.fullFov?.url),
    atlases: (m.atlases?.length ?? 0) > 0,
    morphology: surfaces && [shape?.curvature, shape?.sulc, shape?.thickness].some(pair),
    retinotopy: Boolean(m.function?.retinotopy && functionalModes('retinotopy', m.function.retinotopy.frames).length),
    somatotopy: Boolean(m.function?.somatotopy && functionalModes('somatotopy', m.function.somatotopy.frames).length),
    changes: surfaces && (m.longitudinal?.changeMaps?.length ?? 0) > 0,
    scans: (m.scans?.length ?? 0) > 1,
  }
}

/** The setup step for the current state, or null once a subject is loaded (the tour takes over). */
export function setupStep(s: GuideState): GuideStep | null {
  if (s.dialogOpen) {
    if (s.datasets > 0) {
      return {
        key: 'continue',
        target: '#dataset-continue',
        title: 'Continue to your subjects',
        text: 'Your dataset is added. Click “continue, choose a sub” — or add another dataset first.',
      }
    }
    if (s.remoteOpen && !s.connected) {
      return {
        key: 'connect',
        target: '#dataset-remote',
        title: 'Connect to your workstation',
        text: 'Enter host, user and password (or rely on your SSH key), then click “connect”.',
      }
    }
    if (s.remoteOpen) {
      return {
        key: 'remote-folder',
        target: '#dataset-remote-add',
        title: 'Choose the remote output folder',
        text: 'Browse to the brainana output root (the folder holding sub-*), then click “add”.',
      }
    }
    return {
      key: 'local-folder',
      target: '#dataset-local',
      title: 'Choose a local output folder',
      text: 'Browse to the brainana output root (the folder holding sub-*), then click “add”. Data on a workstation? Open “remote dataset” below.',
    }
  }
  if (s.loading) return { key: 'loading', target: '#monkey-select', title: 'Loading…', text: 'The subject is loading; the tour starts when it is ready.' }
  if (s.error) {
    return {
      key: 'error',
      target: '#monkey-select',
      title: 'The subject did not load',
      text: 'Read the message in the viewer, then retry — or pick another subject or check the dataset.',
      action: { id: 'retry', label: 'retry' },
    }
  }
  if (s.loaded) return null
  if (s.datasets === 0) {
    return {
      key: 'dataset',
      target: '#dataset-open',
      title: 'Add a dataset',
      text: 'Open the dataset manager to add a brainana output folder, local or on a workstation.',
      action: { id: 'open-datasets', label: 'open datasets' },
    }
  }
  return {
    key: 'subject',
    target: '#monkey-select',
    title: 'Choose a subject',
    text: s.subjects ? 'Pick a subject in the “sub” dropdown; it loads automatically.' : 'No subjects found yet. Check that the dataset points at the output root (the folder holding sub-*).',
    action: s.subjects ? { id: 'focus-subject', label: 'choose a subject' } : { id: 'open-datasets', label: 'open datasets' },
  }
}

/** One stop per feature this subject has, in a sensible order. */
export function tourSteps(s: GuideState): GuideStep[] {
  const f = s.features
  const steps: GuideStep[] = []
  const add = (key: string, target: string, title: string, text: string, action?: GuideStep['action']): void => {
    steps.push({ key, target, title, text, action })
  }
  // A side-panel stop points at its toolbar tab until the panel is open, then at the panel itself.
  // `tab` is the dashboard's dockedTab value; `id` names both the tab button and the panel.
  const panel = (tab: string, id: string): string => (s.activePanel === tab ? `#tour-${id}-panel` : `#tour-${id}`)
  const openPanel = (label: string, id: string): GuideStep['action'] => ({ id: 'open-panel', label, tab: `#tour-${id}` })

  add(
    'navigate',
    f.volume ? '#tour-slices' : f.surfaces ? '#tour-surface' : '#tour-readouts',
    'Your subject is loaded',
    f.volume
      ? 'Click a slice to move the crosshair; every view and readout follows. Use “next” to tour the tools this subject has.'
      : 'Drag the surface to rotate, scroll to zoom. Use “next” to tour the tools this subject has.',
  )
  if (f.volume) {
    add('volume', '#tour-volume', 'Anatomy', 'Choose the base volume in “vol”; the checkbox shows or hides the slice pane.')
    add('underlay', '#tour-underlay', 'Image display', 'Adjust brightness, contrast, range and clipping here; “reset” restores the defaults. Crosshair and orientation labels toggle below.')
  }
  if (f.fullFov) add('fov', '#tour-fov', 'Full field of view', '“full” shows the uncropped scan (chamber, head-post); “best” returns to the processing box. Coordinates stay the same.')
  add('layout', '#tour-layout', 'Layout', 'Arrange the slices and surface as a column, row or grid. Drag any panel edge to resize it.')
  if (f.surfaces) {
    add('surface', '#tour-surface-controls', 'Cortical surface', 'Choose pial, white, inflated or sphere in “surf”. Drag the 3D view to rotate, scroll to zoom.')
    add('views', '#tour-surface-views', 'Camera and hemispheres', 'Jump to a preset view; LH and RH show or hide each hemisphere.')
    add('marker', '#tour-marker', 'Surface marker', 'The marker shows the crosshair on the surface. In “nearest vertex” mode you can drag it along the cortex.')
  }
  if (f.atlases) {
    add('atlas', panel('atlas', 'atlas'), 'Atlases', 'Open the atlas panel and pick an atlas. Click a region row to hide it, shift-click to show only that region.', openPanel('open atlas panel', 'atlas'))
  }
  if (f.morphology) add('morphology', panel('morphology', 'morphology'), 'Morphology', 'Shade the surface by curvature, sulcal depth or thickness.', openPanel('open morphology panel', 'morphology'))
  if (f.retinotopy || f.somatotopy) {
    add(
      'function',
      panel('function', 'function'),
      'Functional maps',
      `Pick a ${[f.retinotopy && 'retinotopy', f.somatotopy && 'somatotopy'].filter(Boolean).join(' or ')} map; the F-stat threshold and opacity tune what shows.`,
      openPanel('open function panel', 'function'),
    )
  }
  if (f.retinotopy) add('visual-field', '#tour-visual-field', 'Visual field', 'With a retinotopy map selected, this plot shows where the crosshair’s neighbourhood sits in the visual field.')
  if (f.changes) add('changes', panel('longitudinal', 'change'), 'Longitudinal change', 'Map rates of change between sessions; check the time units before reading a rate.', openPanel('open change panel', 'change'))
  if (f.atlases || f.morphology || f.retinotopy || f.somatotopy || f.changes) {
    add('colors', '#tour-colors', 'Colour display', 'Colormap, range and clipping for the active overlay. This changes the display, never the data.')
  }
  add('readouts', '#tour-readouts', 'Readouts', 'Coordinates and values at the crosshair. Type a coordinate to jump there.')
  add('points', '#tour-points', 'Bookmarks', 'Bookmark the crosshair with “+ point”; each point keeps its coordinates and readouts for the report.', { id: 'add-point', label: 'bookmark this point' })
  add(
    'report',
    s.reportOpen ? '.report-dialog' : '#tour-report',
    'Report',
    'Export the bookmarked points, readouts and screenshots as one self-contained HTML file.',
    s.reportOpen ? undefined : { id: 'open-report', label: 'open report options' },
  )
  if (f.scans) add('scans', '#scan-select', 'Sessions', 'Switch reconstruction in “ses”. Bookmarks are cleared, since they belong to the previous scan.')
  if (s.subjects > 1) add('subjects', '#monkey-select', 'Other subjects', 'Switch subject in “sub”; the view settings carry over where they apply.')
  add('settings', '#settings-open', 'Settings', 'Set what new subjects open with, report defaults and the look of the viewer.', { id: 'open-settings', label: 'open settings' })
  add('done', '#guided-setup', 'That’s the tour', 'Revisit any stop from the list above, or end the tour. “guided setup” brings it back any time.')
  return steps
}
