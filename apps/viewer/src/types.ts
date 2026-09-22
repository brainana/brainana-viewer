// Typed view of the server manifest (viewer/server/manifest.mjs buildManifest output).
// Only the fields the frontend consumes are modelled; unknown extras are tolerated.

export interface SurfacePair {
  left: string
  right: string
}

export interface AtlasEntry {
  name: string
  label: string
  volume: string
  labels: string | null
  surface: SurfacePair | null
}

export interface FunctionalMap {
  combined: string
  frames: Record<string, number>
  surface: SurfacePair | null
}

export interface FullFovVolume {
  url: string
  label: string
  /** brainana's FullFOVPadding.status: 'expanded' | 'no_expansion_needed' | 'fallback'; null if the sidecar was unreadable. */
  status: string | null
}

/** Which stream a reconstruction belongs to. */
export type ScanStream = 'cross' | 'base' | 'long'

/**
 * One reconstruction of a subject -- what the scan picker lists and what a manifest describes.
 *
 * brainana's `anat.synthesis_level` decides how many a subject has: one at "subject", one per
 * session at "session", and at "session_longitudinal" those plus an unbiased base template and a
 * base-seeded reconstruction per timepoint. `cross` scans each have their own mesh; `base` and
 * `long` share the base template's mesh and vertex numbering.
 */
export interface ScanSummary {
  id: string
  subjectId: string
  session: string | null
  stream: ScanStream
  label: string
  isDefault: boolean
}

/** One per-vertex change map fitted across a subject's timepoints. */
export interface ChangeMap {
  /** `<measure>-<statistic>`, e.g. 'thickness-rate'. */
  key: string
  measure: string
  statistic: string
  /** rate and spc are signed and want a diverging colormap centred on zero; avg does not. */
  signed: boolean
  left: string
  right: string
  range: { min: number; max: number; p02: number; p98: number; absP98: number } | null
}

export interface LongitudinalInfo {
  stream: ScanStream
  baseSubjectId: string
  timepoints: string[]
  times: Record<string, number>
  /**
   * Where brainana got each timepoint's time value. Load-bearing: when this is not a real time
   * column from sessions.tsv, the fitted rate is per SCAN rather than per unit time, and a rate is
   * not interpretable without knowing which.
   */
  timeSource: string | null
  skipped: Record<string, unknown>
  ordinalTimeFallback: string[]
  changeMaps: ChangeMap[]
  roiRates: { left: string | null; right: string | null }
  agreement: string | null
}

export interface Manifest {
  id: string
  label: string
  session: string | null
  /** The reconstruction this manifest describes. */
  scan: ScanSummary
  /** Every reconstruction of this subject, so the picker needs no second request. */
  scans: ScanSummary[]
  /** brainana's anat.synthesis_level, when the run's config was readable. Display only. */
  synthesisLevel: 'subject' | 'session' | 'session_longitudinal' | null
  /** Non-fatal problems found while building the manifest (e.g. a withheld overlay). */
  warnings: string[]
  /** Present on the base template only; null elsewhere. */
  longitudinal: LongitudinalInfo | null
  relativePath: string
  anatomy: string | null
  volumes: Array<{ key: string; label: string; url: string }>
  // The uncropped conform (space-T1w, desc-conformFullFOV). Same world frame as `volumes`, just a
  // larger box; null for datasets processed before brainana 2.1 or with conform disabled.
  fullFov: FullFovVolume | null

  atlases: AtlasEntry[]
  function: {
    retinotopy: FunctionalMap | null
    somatotopy: FunctionalMap | null
  }
  transforms: {
    scanner: unknown
    templates: Record<string, unknown>
    nmt2sym: unknown
  }
  surfaces: {
    pial: SurfacePair | null
    smoothwm: SurfacePair | null
    inflated: SurfacePair | null
    sphere: SurfacePair | null
    white: SurfacePair | null
  }
  morphology: {
    raw: { curvature: SurfacePair; sulc: SurfacePair; thickness: SurfacePair }
    shape: { curvature: SurfacePair; sulc: SurfacePair; thickness: SurfacePair }
  }
  capabilities: {
    volume: boolean
    surfaces: boolean
    atlases: boolean
    retinotopy: boolean
    somatotopy: boolean
  }
}
