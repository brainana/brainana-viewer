// Crosshair sampling, separated from rendering.
//
// The bottom info panel used to sample AND build DOM inside each update*Report function. The HTML
// report needs the same numbers, and duplicating the sampling would guarantee the two drift apart —
// so the sampling lives here, returns plain structs, and both the live panel and the report render
// from those. Every collector takes the narrowest interface it needs (not the whole MultiView), so
// tests can drive them with small stubs and no browser.
import type { SurfaceNode } from '../niivue/multiView.ts'
import type { AtlasLabel } from '../data/atlas.ts'
import { ECC_MAX, visualXY, visualFieldStats, type VfPoint, type VfStats } from '../data/visualField.ts'
import type { AtlasReadout, MorphologyReadout, RetinotopyReadout, SomatotopyReadout } from './model.ts'

/** One discovered atlas plus its id→label table, as the dashboard already assembles it. */
export interface AtlasSpec {
  key: string
  label: string
  byId: Map<number, AtlasLabel>
}

export interface AtlasSampler {
  sampleReportVolume(key: string): number | null
  reportVolumeContinuous(key: string): boolean
}

export interface FunctionSampler {
  functionCrosshairVox(): [number, number, number] | null
  functionDims(): [number, number, number] | null
  sampleFunctionFrame(vox: [number, number, number], frame: number): number
}

export interface VertexSampler {
  referenceVertexWorld(node: SurfaceNode): [number, number, number] | null
}

/** Per-hemisphere morphometry arrays, indexed [left, right] — the dashboard's `morphShape` cache. */
export interface MorphologyShape {
  curvature?: [Float32Array, Float32Array]
  sulc?: [Float32Array, Float32Array]
  thickness?: [Float32Array, Float32Array]
}

/**
 * Every atlas at the crosshair. A continuous (float scalar) atlas reports its raw value with no id
 * lookup; a parcellation reports the rounded id and its region name. Voxel 0 is background in both
 * cases, so it yields neither an id nor a region.
 */
export function collectAtlasRows(view: AtlasSampler, specs: AtlasSpec[]): AtlasReadout[] {
  return specs.map((spec) => {
    const raw = view.sampleReportVolume(spec.key)
    if (view.reportVolumeContinuous(spec.key)) {
      const value = raw != null && Number.isFinite(raw) && raw !== 0 ? raw : null
      return { name: spec.key, label: spec.label, continuous: true, value, id: null, region: null, shortName: null, unknown: false }
    }
    const id = raw != null && Number.isFinite(raw) ? Math.round(raw) : null
    const known = id != null && id !== 0 ? spec.byId.get(id) : undefined
    return {
      name: spec.key,
      label: spec.label,
      continuous: false,
      value: null,
      id: id !== 0 ? id : null,
      // Underscores are a storage convention in the pipeline LUTs, not part of the region name.
      region: known ? known.name.replace(/_/g, ' ') : null,
      shortName: known?.nameShort ? known.nameShort.replace(/_/g, ' ') : null,
      // An id is present but no region resolves for it — a real signal (LUT/volume mismatch),
      // distinct from plain background.
      unknown: !known && id != null && id !== 0,
    }
  })
}

/** Nearest reference-surface vertex and its distance from the crosshair. */
export function collectVertex(
  view: VertexSampler,
  node: SurfaceNode | null,
  mm: [number, number, number] | null,
): { index: number; hemi: 0 | 1; distanceMm: number | null } | null {
  if (!node) return null
  const world = view.referenceVertexWorld(node)
  const distance = world && mm ? Math.hypot(world[0] - mm[0], world[1] - mm[1], world[2] - mm[2]) : NaN
  return { index: node.index, hemi: node.hemi, distanceMm: Number.isFinite(distance) ? distance : null }
}

/** Morphometry at a vertex. NaN where a metric is absent or the index is out of range — callers
 *  render those as an em dash rather than a number. */
export function collectMorphology(shape: MorphologyShape, node: SurfaceNode | null): MorphologyReadout | null {
  if (!node) return null
  const sample = (key: 'curvature' | 'sulc' | 'thickness'): number => {
    const arr = shape[key]?.[node.hemi]
    return arr && node.index < arr.length ? arr[node.index] : NaN
  }
  return { curvature: sample('curvature'), sulc: sample('sulc'), thickness: sample('thickness') }
}

/**
 * Retinotopic voxels in a cubic neighborhood around the crosshair. Extracted from the visual-field
 * plot so the plot, the info panel's "valid voxels" row, and the report all agree by construction.
 * `possible` counts in-bounds voxels considered — the denominator of "valid voxels".
 */
export function collectVisualFieldPoints(
  view: FunctionSampler,
  frames: Record<string, number>,
  vox: [number, number, number],
  dims: [number, number, number],
  neighborhood: number,
  threshold: number,
): { points: VfPoint[]; possible: number } {
  const points: VfPoint[] = []
  let possible = 0
  for (let dx = -neighborhood; dx <= neighborhood; dx++)
    for (let dy = -neighborhood; dy <= neighborhood; dy++)
      for (let dz = -neighborhood; dz <= neighborhood; dz++) {
        const v: [number, number, number] = [vox[0] + dx, vox[1] + dy, vox[2] + dz]
        if (v[0] < 0 || v[1] < 0 || v[2] < 0 || v[0] >= dims[0] || v[1] >= dims[1] || v[2] >= dims[2]) continue
        possible++
        const polar = view.sampleFunctionFrame(v, frames.polar)
        const polarF = view.sampleFunctionFrame(v, frames.polarF)
        const ecc = view.sampleFunctionFrame(v, frames.eccentricity)
        const eccF = view.sampleFunctionFrame(v, frames.eccentricityF)
        if (!(ecc >= 0 && ecc <= ECC_MAX && polarF >= threshold && eccF >= threshold)) continue
        const [x, y] = visualXY(polar, ecc)
        points.push({ x, y, polar, ecc, center: dx === 0 && dy === 0 && dz === 0 })
      }
  return { points, possible }
}

/** Retinotopy readout at the crosshair, including the neighborhood statistics when available. */
export function collectRetinotopy(
  view: FunctionSampler,
  frames: Record<string, number>,
  neighborhood: number,
  threshold: number,
  // The live info panel gets its neighborhood counts from the visual-field plot, which sweeps the
  // same voxels anyway; it passes false so a crosshair drag does not pay for the sweep twice.
  includeNeighborhood = true,
): RetinotopyReadout | null {
  const vox = view.functionCrosshairVox()
  if (!vox) return null
  const polar = view.sampleFunctionFrame(vox, frames.polar)
  const eccentricity = view.sampleFunctionFrame(vox, frames.eccentricity)
  const [visualX, visualY] = visualXY(polar, eccentricity)
  const dims = view.functionDims()
  let validVoxels: number | null = null
  let possibleVoxels: number | null = null
  let spreadDeg: number | null = null
  if (dims && includeNeighborhood) {
    const { points, possible } = collectVisualFieldPoints(view, frames, vox, dims, neighborhood, threshold)
    const stats: VfStats = visualFieldStats(points)
    validVoxels = points.length
    possibleVoxels = possible
    // With no valid voxel the spread is not 0 — it is undefined. Keep it null so the report says so.
    spreadDeg = points.length ? stats.spread : null
  }
  return {
    polar,
    polarF: view.sampleFunctionFrame(vox, frames.polarF),
    eccentricity,
    eccentricityF: view.sampleFunctionFrame(vox, frames.eccentricityF),
    visualX,
    visualY,
    validVoxels,
    possibleVoxels,
    spreadDeg,
    neighborhood,
  }
}

/** Somatotopy readout at the crosshair. */
export function collectSomatotopy(view: FunctionSampler, frames: Record<string, number>): SomatotopyReadout | null {
  const vox = view.functionCrosshairVox()
  if (!vox) return null
  return { bodyPosition: view.sampleFunctionFrame(vox, frames.phase), fStat: view.sampleFunctionFrame(vox, frames.fstat) }
}
