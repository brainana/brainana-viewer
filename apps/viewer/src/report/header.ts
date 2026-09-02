// NIfTI header → HeaderInfo. Pure and NiiVue-free: it takes the raw header object NVImage exposes
// as `.hdr` (a nifti-reader-js NIFTI1) and resolves the numeric codes a reader cannot interpret
// (datatype, intent, xyzt_units) into names. Kept out of multiView.ts so it stays unit-testable.
import type { HeaderInfo, MeshInfo } from './model.ts'

// The raw shape we consume. Declared structurally (not imported from nifti-reader-js) because
// NiiVue also synthesises this object for .mgz volumes, which never pass through that parser.
export interface RawNiftiHeader {
  dims?: number[]
  pixDims?: number[]
  datatypeCode?: number
  numBitsPerVoxel?: number
  intent_code?: number
  scl_slope?: number
  scl_inter?: number
  cal_min?: number
  cal_max?: number
  qform_code?: number
  sform_code?: number
  xyzt_units?: number
  affine?: number[][]
  littleEndian?: boolean
  description?: string
}

// NIfTI datatype codes (nifti1.h). Codes outside this table render as `code <n>` rather than
// silently reading as "unknown data".
const DATATYPES: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'BINARY',
  2: 'UINT8',
  4: 'INT16',
  8: 'INT32',
  16: 'FLOAT32',
  32: 'COMPLEX64',
  64: 'FLOAT64',
  128: 'RGB24',
  256: 'INT8',
  512: 'UINT16',
  768: 'UINT32',
  1024: 'INT64',
  1280: 'UINT64',
  1536: 'FLOAT128',
  1792: 'COMPLEX128',
  2048: 'COMPLEX256',
  2304: 'RGBA32',
}

// The intent codes that actually occur in brainana output; everything else falls back to the code.
const INTENTS: Record<number, string> = {
  0: 'NONE',
  2: 'CORRELATION',
  3: 'TTEST',
  4: 'FTEST',
  5: 'ZSCORE',
  11: 'ESTIMATE',
  1002: 'LABEL',
  1007: 'VECTOR',
  1008: 'POINTSET',
  1009: 'TRIANGLE',
  1011: 'NODE_INDEX',
  2001: 'TIME_SERIES',
  2002: 'NODE_INDEX',
  2005: 'SHAPE',
}

// xyzt_units packs a spatial unit in the low 3 bits and a temporal unit in the next 3.
const SPATIAL_UNITS: Record<number, string> = { 0: 'unknown', 1: 'm', 2: 'mm', 3: 'µm' }
const TIME_UNITS: Record<number, string> = { 0: 'unknown', 8: 's', 16: 'ms', 24: 'µs', 32: 'Hz', 40: 'ppm', 48: 'rad/s' }

const named = (table: Record<number, string>, code: number, prefix: string): string => table[code] ?? `${prefix} ${code}`

const finite = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Identity affine, used when a header carries none (some synthesised .mgz headers). */
const IDENTITY: number[][] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
]

/**
 * Format a raw NIfTI header for the report. `dims[0]` is the dimensionality, `dims[1..n]` the
 * extents — the report shows both, since "n_dim" alone tells a reader nothing about the shape.
 * Returns null for a header that carries no dims at all (nothing meaningful to show).
 */
export function describeHeader(hdr: RawNiftiHeader | null | undefined): HeaderInfo | null {
  if (!hdr || !Array.isArray(hdr.dims) || hdr.dims.length < 2) return null
  const rawDims = hdr.dims
  // Trust dims[0] only when it is a sane NIfTI dimensionality; otherwise infer from the array.
  const declared = Math.round(finite(rawDims[0]))
  const nDim = declared >= 1 && declared <= 7 && declared < rawDims.length ? declared : Math.max(1, rawDims.length - 1)
  const dims = rawDims.slice(1, nDim + 1).map((d) => Math.round(finite(d)))
  const pix = Array.isArray(hdr.pixDims) ? hdr.pixDims : []
  // Voxel size is direction-agnostic: a negative pixdim encodes handedness, not a negative size.
  const resolution = [1, 2, 3].map((i) => Math.abs(finite(pix[i], 0)))
  const units = Math.round(finite(hdr.xyzt_units))
  const datatypeCode = Math.round(finite(hdr.datatypeCode))
  const intentCode = Math.round(finite(hdr.intent_code))
  const affine = Array.isArray(hdr.affine) && hdr.affine.length === 4 ? hdr.affine.map((row) => row.map((v) => finite(v))) : IDENTITY

  return {
    nDim,
    dims,
    // A 3-D volume has no dims[4]; report 1 frame rather than 0 so "frames" always reads sensibly.
    frames: nDim >= 4 ? Math.max(1, Math.round(finite(rawDims[4], 1))) : 1,
    resolution,
    spatialUnit: named(SPATIAL_UNITS, units & 0x07, 'code'),
    timeUnit: named(TIME_UNITS, units & 0x38, 'code'),
    datatype: named(DATATYPES, datatypeCode, 'code'),
    datatypeCode,
    bitpix: Math.round(finite(hdr.numBitsPerVoxel)),
    intent: named(INTENTS, intentCode, 'code'),
    intentCode,
    // A zero slope means "no scaling applied", which is 1 in effect — report it as stored, since a
    // reader comparing against the file expects the raw value.
    sclSlope: finite(hdr.scl_slope),
    sclInter: finite(hdr.scl_inter),
    calMin: finite(hdr.cal_min),
    calMax: finite(hdr.cal_max),
    qformCode: Math.round(finite(hdr.qform_code)),
    sformCode: Math.round(finite(hdr.sform_code)),
    affine,
    littleEndian: typeof hdr.littleEndian === 'boolean' ? hdr.littleEndian : null,
    description: typeof hdr.description === 'string' && hdr.description.trim() ? hdr.description.trim() : null,
  }
}

/** Vertex/face counts for a surface. NVMesh stores flat arrays: 3 floats per vertex, 3 ids per face. */
export function describeMesh(mesh: { pts?: ArrayLike<number>; tris?: ArrayLike<number> } | null | undefined): MeshInfo | null {
  if (!mesh || !mesh.pts || !mesh.tris) return null
  return { vertices: Math.floor(mesh.pts.length / 3), faces: Math.floor(mesh.tris.length / 3) }
}

/** Voxel resolution as a compact string: "0.5 × 0.5 × 0.5 mm", collapsing an isotropic grid. */
export function formatResolution(info: HeaderInfo): string {
  const [x, y, z] = info.resolution
  const unit = info.spatialUnit === 'unknown' ? '' : ` ${info.spatialUnit}`
  const round = (v: number): string => String(Number(v.toFixed(4)))
  if (x === y && y === z) return `${round(x)}³${unit}`
  return `${round(x)} × ${round(y)} × ${round(z)}${unit}`
}
