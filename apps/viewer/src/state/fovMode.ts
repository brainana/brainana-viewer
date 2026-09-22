// Field-of-view mode for the slice underlay.
//
// brainana sizes the processing field of view from the template, so anything outside it — a
// recording chamber, head-post, coil markers, the neck — is cropped from every derivative.
// `<ses_prefix>_space-T1w_desc-conformFullFOV_T1w.nii.gz` is the one output that keeps it, and
// 'full' displays it as the underlay so chambers and electrode trajectories can be located.
//
// The full-FOV volume sits on the SAME 1 mm lattice and world frame as both the preprocessed T1w
// and the FreeSurfer fsnative volumes (the grids differ only by a whole number of voxels), so the
// swap needs no resample and leaves every overlay registered where it was.
//
// Logic lives here rather than in the dashboard because the dashboard has no DOM test environment;
// everything below is pure or storage-only, and is covered by tests/fovmode_test.mjs.

import type { FullFovVolume } from '../types.ts'

export type FovMode = 'best' | 'full'

/** The segmented control's entries, in render order. Labels are lowercase (text-casing guideline). */
export const FOV_MODES: ReadonlyArray<{ mode: FovMode; label: string; title: string }> = [
  {
    mode: 'best',
    label: 'best',
    title: 'Processing field of view — the preprocessed volume every derivative is aligned to.',
  },
  {
    mode: 'full',
    label: 'full',
    title:
      'Uncropped conform — the full scanner field of view, keeping the chamber, head-post and neck that the processing box cuts away.',
  },
]

/**
 * The mode to actually display. A stored 'full' preference degrades to 'best' for a subject whose
 * dataset has no full-FOV volume; the caller keeps the preference itself untouched so it re-engages
 * on the next subject that does have one.
 */
export function resolveFovMode(preferred: FovMode, hasFullFov: boolean): FovMode {
  return preferred === 'full' && hasFullFov ? 'full' : 'best'
}

/**
 * Tooltip for the switch, covering the states a user can otherwise misread: the output is missing
 * entirely, it exists but brainana could not expand it (so flipping changes nothing), or the scan
 * is one that never has one.
 *
 * `stream` is the reconstruction's stream. The base template and its base-seeded timepoints are
 * built from already-conformed volumes, so brainana never writes an uncropped conform for them --
 * telling someone to reprocess would be advice that cannot work.
 */
export function fovTooltip(fullFov: FullFovVolume | null, stream: string | null = null): string {
  if (!fullFov) {
    if (stream === 'base' || stream === 'long') {
      return 'No full-FOV T1w for a longitudinal reconstruction — it is built in the base template’s space, from volumes that are already conformed.'
    }
    return 'No full-FOV T1w in this dataset. Reprocess with brainana 2.1 or newer to generate one.'
  }
  if (fullFov.status === 'no_expansion_needed' || fullFov.status === 'fallback') {
    return 'Full field of view — this scan needed no expansion, so the image is identical to the processing FOV.'
  }
  return 'Full field of view — the uncropped conform, including anything outside the processing box.'
}

// --- preference persistence -------------------------------------------------------------------
// Versioned key + null-guarded accessor, matching packages/core-client/sessionPersistence.ts.

const KEY = 'brainana.fovMode.v1'
const DEFAULT_MODE: FovMode = 'best'

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // Safari private mode et al.
  }
}

function isFovMode(value: unknown): value is FovMode {
  return value === 'best' || value === 'full'
}

/** The user's chosen mode, remembered across subject switches and app restarts. */
export function loadFovPreference(): FovMode {
  const store = storage()
  if (!store) return DEFAULT_MODE
  try {
    const raw = store.getItem(KEY)
    return isFovMode(raw) ? raw : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

export function saveFovPreference(mode: FovMode): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(KEY, mode)
  } catch {
    // Best-effort: a full or locked-down storage must never break the toggle.
  }
}
