// Types for the HTML report. Deliberately plain data (no DOM nodes, no NiiVue objects) so the
// whole payload can be JSON-serialised into the report itself and so buildReportHtml stays a pure
// function that tests can drive without a browser.

/** Formatted NIfTI header fields (see header.ts). Values already resolved to display strings where
 *  a raw code would be meaningless (datatype, intent, units). */
export interface HeaderInfo {
  nDim: number
  /** Spatial+temporal extents, dims[1..nDim] — the "n_dim" row's companion. */
  dims: number[]
  frames: number
  /** Voxel size along i/j/k, pixDims[1..3]. */
  resolution: number[]
  spatialUnit: string
  timeUnit: string
  datatype: string
  datatypeCode: number
  bitpix: number
  intent: string
  intentCode: number
  sclSlope: number
  sclInter: number
  calMin: number
  calMax: number
  qformCode: number
  sformCode: number
  /** 4x4 voxel→world affine, row-major. */
  affine: number[][]
  littleEndian: boolean | null
  description: string | null
}

export interface MeshInfo {
  vertices: number
  faces: number
}

/** One asset loaded into the scene. `header` is set for volumes, `mesh` for surfaces. */
export interface FileInfo {
  role: string
  /** Path relative to the data source root, derived from the asset's /brainana-data URL. */
  path: string
  url: string
  /** Version from the file's JSON sidecar (`GeneratedBy`), null when it has none. */
  brainanaVersion: string | null
  generatedBy: Array<{ name: string; version: string | null }>
  header: HeaderInfo | null
  mesh: MeshInfo | null
}

export interface AtlasReadout {
  name: string
  label: string
  /** Continuous (float scalar) atlases carry `value`; parcellations carry `id` + `region`. */
  continuous: boolean
  value: number | null
  id: number | null
  region: string | null
  shortName: string | null
  /** An id is present but no region name resolves for it. */
  unknown: boolean
}

export interface MorphologyReadout {
  curvature: number
  sulc: number
  thickness: number
}

export interface RetinotopyReadout {
  polar: number
  polarF: number
  eccentricity: number
  eccentricityF: number
  visualX: number
  visualY: number
  /** Neighborhood statistics, null when the visual-field plot has not been computed. */
  validVoxels: number | null
  possibleVoxels: number | null
  spreadDeg: number | null
  neighborhood: number
}

export interface SomatotopyReadout {
  bodyPosition: number
  fStat: number
}

/** Everything the viewer knows about one location. Sections are null when the corresponding data
 *  is not loaded (no surface, no atlas, no functional map). */
export interface LocationReadout {
  mm: [number, number, number]
  voxel: [number, number, number] | null
  hemisphere: string
  vertex: { index: number; hemi: 0 | 1; distanceMm: number | null } | null
  atlases: AtlasReadout[]
  morphology: MorphologyReadout | null
  retinotopy: RetinotopyReadout | null
  somatotopy: SomatotopyReadout | null
  /** The active overlay's value at this point, as shown in the Coordinates panel. */
  overlay: { target: string; label: string; value: string | null } | null
}

/** A pair of pane screenshots as data URLs. A pane that is hidden (or failed to capture) is null
 *  and explained by `note`. */
export interface PaneShots {
  slices: string | null
  surface: string | null
  note: string | null
}

export interface Bookmark {
  id: string
  /** User-supplied name, or null to fall back to the point's ordinal ("Point 2"). Kept nullable so
   *  removing a point renumbers the rest contiguously instead of leaving a gap. */
  label: string | null
  /** ISO timestamp of when the point was added (its readout was snapshotted then). */
  addedAt: string
  /** Which overlay was active at add time — explains why retinotopy/somatotopy may be absent. */
  activeOverlay: string
  readout: LocationReadout
  shots: PaneShots | null
}

export interface ViewState {
  layout: string
  surfaceKind: string | null
  panes: { volume: boolean; surface: boolean }
  hemispheres: { left: boolean; right: boolean }
  baseVolume: {
    key: string | null
    label: string | null
    window: { min: number; max: number } | null
    clip: { lo: number | null; hi: number | null } | null
  }
  atlas: {
    name: string
    colormap: string
    opacity: number
    continuous: boolean
    displayRange: { min: number; max: number } | null
    clip: { lo: number | null; hi: number | null }
    hiddenRois: number
  } | null
  morphology: {
    metric: string
    curvatureStyle: string
    colormap: string | null
    range: { min: number; max: number } | null
    clip: { lo: number | null; hi: number | null } | null
  }
  function: {
    kind: string
    mode: string
    threshold: number
    opacity: number
    brightness: number
    colormap: string
    displayRange: { min: number; max: number } | null
    clip: { lo: number | null; hi: number | null }
  } | null
  camera: { azimuth: number; elevation: number; scale: number } | null
  markerMode: string
}

export interface ReportData {
  generatedAt: string
  app: { name: string; version: string; buildId: string | null; userAgent: string | null }
  dataset: {
    sourceId: string | null
    sourceLabel: string | null
    sourceType: string | null
    /** Absolute root of the data source, so the report can name the real path on disk. */
    sourceRoot: string | null
    subjectId: string | null
    subjectLabel: string | null
    session: string | null
    relativePath: string | null
  }
  /** Distinct brainana pipeline versions found across the loaded files' sidecars. */
  pipelineVersions: string[]
  files: FileInfo[]
  view: ViewState
  current: { readout: LocationReadout | null; shots: PaneShots | null }
  bookmarks: Bookmark[]
  /** Caveats surfaced to the reader (hidden pane, capture failure, missing sidecars, …). */
  notes: string[]
}
