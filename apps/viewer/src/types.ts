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

export interface Manifest {
  id: string
  label: string
  session: string | null
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
    veryinflated: SurfacePair | null
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
