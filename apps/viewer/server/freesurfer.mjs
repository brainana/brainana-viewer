// Viewer-domain FreeSurfer binary parsing + derived-asset generation.
// Ported verbatim in behavior from server.mjs:173-317; the only change is that
// `ensureDerivedAssets` receives an explicit `outputRoot` instead of a module global,
// so it works for any local data-source root.
import fs from 'node:fs'
import path from 'node:path'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

// Local containment check -- kept here rather than imported so this domain module stays free of a
// core dependency. cacheKey is always derived from readdirSync output, so this is a guard against
// a future caller, not against user input.
function containedIn(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// FreeSurfer curv/sulc/thickness ("morphology") binary → Float32Array of per-vertex values.
// Handles both the new (0xffffff magic) and legacy int16/100 formats.
export function parseFsMorphology(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const readUint24 = (offset) => (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2)
  const magic = readUint24(0)
  if (magic === 0xffffff) {
    const vertexCount = view.getInt32(3, false)
    const valuesPerVertex = view.getInt32(11, false)
    let offset = 15
    const values = new Float32Array(vertexCount)
    for (let i = 0; i < vertexCount; i++) {
      values[i] = view.getFloat32(offset, false)
      offset += 4 * valuesPerVertex
    }
    return values
  }
  const vertexCount = magic
  let offset = 6
  const values = new Float32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    values[i] = view.getInt16(offset, false) / 100
    offset += 2
  }
  return values
}

// Uncompressed FreeSurfer MGH v1. brainana writes the longitudinal change maps
// (?h.long.<measure>-{rate,avg,spc}.mgh) as nvertices x 1 x 1, one frame, MRI_FLOAT, big-endian,
// with the data at a fixed 284-byte offset.
//
// Deliberately narrow: anything that is not that exact shape throws rather than being mis-parsed
// into a plausible-looking array. In particular .mgz is NOT accepted -- mri/*.mgz is served raw to
// NiiVue and must stay that way, so a reader that quietly handled both would invite someone to
// route those through here and decompress megabytes per manifest build.
const MGH_DATA_OFFSET = 284
const MGH_TYPE_FLOAT = 3

export function parseMgh(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    throw new Error('Compressed .mgz is not supported here; only uncompressed .mgh')
  }
  if (buffer.length < MGH_DATA_OFFSET) throw new Error('MGH file is shorter than its header')
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const version = view.getInt32(0, false)
  if (version !== 1) throw new Error(`Unsupported MGH version ${version}`)
  const width = view.getInt32(4, false)
  const height = view.getInt32(8, false)
  const depth = view.getInt32(12, false)
  const nframes = view.getInt32(16, false)
  const type = view.getInt32(20, false)
  if (type !== MGH_TYPE_FLOAT) throw new Error(`Unsupported MGH data type ${type} (expected float)`)
  if (height !== 1 || depth !== 1 || nframes !== 1) {
    throw new Error(`Expected a per-vertex MGH (n x 1 x 1, 1 frame), got ${width}x${height}x${depth}x${nframes}`)
  }
  if (width <= 0) throw new Error('MGH declares no vertices')
  const needed = MGH_DATA_OFFSET + width * 4
  if (buffer.length < needed) throw new Error(`MGH body is truncated (need ${needed} bytes, have ${buffer.length})`)
  const values = new Float32Array(width)
  for (let i = 0; i < width; i++) values[i] = view.getFloat32(MGH_DATA_OFFSET + i * 4, false)
  return { width, height, depth, nframes, values }
}

// Vertex count of a hemisphere's mesh, read from a fixed-size header -- no full file read.
// Tries the cheap morphometry headers first, then the surface itself. null when nothing is readable.
export function surfaceVertexCount(surfDir, hemi) {
  for (const name of [`${hemi}.thickness`, `${hemi}.curv`, `${hemi}.sulc`]) {
    const file = path.join(surfDir, name)
    if (!exists(file)) continue
    try {
      const head = Buffer.alloc(15)
      const fd = fs.openSync(file, 'r')
      try {
        fs.readSync(fd, head, 0, 15, 0)
      } finally {
        fs.closeSync(fd)
      }
      const magic = (head[0] << 16) | (head[1] << 8) | head[2]
      if (magic === 0xffffff) return head.readInt32BE(3)
      return magic // legacy int16 format stores the count in the magic slot
    } catch {
      // fall through to the next candidate
    }
  }
  const surface = path.join(surfDir, `${hemi}.white`)
  if (!exists(surface)) return null
  try {
    return readFsSurface(fs.readFileSync(surface)).vertexCount
  } catch {
    return null
  }
}

// Dim0 of the first DataArray in a GIFTI file, from its opening bytes. Used to reject a surface
// overlay whose vertex count does not match the mesh it would be painted on -- the base and
// cross-sectional meshes of one subject have different vertex counts, so a mispaired overlay is
// not a subtle misalignment but an array of the wrong length.
export function giftiDim0(file) {
  try {
    const head = Buffer.alloc(4096)
    const fd = fs.openSync(file, 'r')
    let read = 0
    try {
      read = fs.readSync(fd, head, 0, head.length, 0)
    } finally {
      fs.closeSync(fd)
    }
    const match = head.subarray(0, read).toString('utf8').match(/\bDim0="(\d+)"/)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

// Serialise per-vertex scalars to a GIFTI array (base64 float32).
// `intent` selects how a consumer reads the array: SHAPE for morphometry that shades a
// surface, NONE for a statistical map painted over it. NiiVue accepts either as a mesh
// layer; the distinction is for anything that inspects the file.
export function giftiScalar(values, intent = 'NIFTI_INTENT_SHAPE') {
  const bytes = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i], i * 4)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<GIFTI Version="1.0" NumberOfDataArrays="1">\n  <MetaData/>\n  <LabelTable/>\n  <DataArray Intent="${intent}" DataType="NIFTI_TYPE_FLOAT32" ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="${values.length}" Encoding="Base64Binary" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">\n    <MetaData/>\n    <CoordinateSystemTransformMatrix><DataSpace>NIFTI_XFORM_UNKNOWN</DataSpace><TransformedSpace>NIFTI_XFORM_UNKNOWN</TransformedSpace><MatrixData>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</MatrixData></CoordinateSystemTransformMatrix>\n    <Data>${bytes.toString('base64')}</Data>\n  </DataArray>\n</GIFTI>\n`
}

export const giftiShape = (values) => giftiScalar(values)

// Parse a FreeSurfer binary surface (magic 0xfffffe): returns vertex data + the byte
// offset where vertices begin (so we can rewrite them in place, preserving faces).
export function readFsSurface(buffer) {
  let offset = 0
  const magic = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2]
  offset += 3
  if (magic !== 0xfffffe) throw new Error('Unsupported FreeSurfer surface format')
  const nl1 = buffer.indexOf(10, offset)
  offset = nl1 + 1
  const nl2 = buffer.indexOf(10, offset)
  offset = nl2 + 1
  const vertexCount = buffer.readInt32BE(offset)
  offset += 4
  const faceCount = buffer.readInt32BE(offset)
  offset += 4
  const verticesOffset = offset
  const vertices = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = buffer.readFloatBE(offset)
    offset += 4
  }
  return { magic, vertexCount, faceCount, verticesOffset, vertices }
}

function surfaceXBounds(points) {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]
    if (x < min) min = x
    if (x > max) max = x
  }
  return { min, max, width: max - min }
}

function writeFsSurface(input, parsed, points, dest) {
  const output = Buffer.from(input)
  let offset = parsed.verticesOffset
  for (const value of points) {
    output.writeFloatBE(value, offset)
    offset += 4
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, output)
}

// Recenter a left/right inflated (or sphere) pair, apply an optional radial puff for
// "veryinflated", and compute adaptive per-subject hemisphere spacing so the two
// hemispheres sit side by side without overlap.
export function transformFsSurfacePair(leftSrc, rightSrc, leftDest, rightDest, kind) {
  const leftInput = fs.readFileSync(leftSrc)
  const rightInput = fs.readFileSync(rightSrc)
  const leftParsed = readFsSurface(leftInput)
  const rightParsed = readFsSurface(rightInput)
  const left = new Float32Array(leftParsed.vertices)
  const right = new Float32Array(rightParsed.vertices)
  const radial = kind === 'veryinflated' ? 1.13 : 1

  for (const points of [left, right]) {
    let cx = 0,
      cy = 0,
      cz = 0
    const count = points.length / 3
    for (let i = 0; i < points.length; i += 3) {
      cx += points[i]
      cy += points[i + 1]
      cz += points[i + 2]
    }
    cx /= count
    cy /= count
    cz /= count
    for (let i = 0; i < points.length; i += 3) {
      points[i] = cx + (points[i] - cx) * radial
      points[i + 1] = cy + (points[i + 1] - cy) * radial + 6
      points[i + 2] = cz + (points[i + 2] - cz) * radial
    }
  }

  const leftBounds = surfaceXBounds(left)
  const rightBounds = surfaceXBounds(right)
  const referenceWidth = Math.max(1, Math.min(leftBounds.width, rightBounds.width))
  const desiredGap = Math.max(4, Math.min(12, referenceWidth * 0.06))

  const leftShift = -desiredGap / 2 - leftBounds.max
  const rightShift = desiredGap / 2 - rightBounds.min
  for (let i = 0; i < left.length; i += 3) left[i] += leftShift
  for (let i = 0; i < right.length; i += 3) right[i] += rightShift

  const finalLeft = surfaceXBounds(left)
  const finalRight = surfaceXBounds(right)
  const pairCenter = (Math.min(finalLeft.min, finalRight.min) + Math.max(finalLeft.max, finalRight.max)) / 2
  for (let i = 0; i < left.length; i += 3) left[i] -= pairCenter
  for (let i = 0; i < right.length; i += 3) right[i] -= pairCenter

  writeFsSurface(leftInput, leftParsed, left, leftDest)
  writeFsSurface(rightInput, rightParsed, right, rightDest)
}

// Longitudinal change maps brainana fits on the base mesh: measure x statistic.
// `rate` and `spc` are signed (a diverging colormap centred on zero); `avg` is the plain measure.
export const LONG_MEASURES = ['thickness', 'area', 'curv']
export const LONG_STATISTICS = ['rate', 'avg', 'spc']

// Summary statistics of a per-vertex map, computed in the same pass that writes the GIFTI so the
// client can seed a sensible display window without fetching and decoding the array first.
// Zeros are excluded: brainana writes the medial wall and non-cortex as exactly 0.0, and including
// them drags every percentile toward zero -- a rate map is ~0.01 mm/yr, so a window derived from
// the full array renders as a blank surface.
function scalarRange(values) {
  const finite = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v) && v !== 0) finite.push(v)
  }
  if (!finite.length) return { min: 0, max: 0, p02: 0, p98: 0, absP98: 0 }
  finite.sort((a, b) => a - b)
  const at = (q) => finite[Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))))]
  const abs = finite.map(Math.abs).sort((a, b) => a - b)
  return {
    min: finite[0],
    max: finite[finite.length - 1],
    p02: at(0.02),
    p98: at(0.98),
    absP98: abs[Math.min(abs.length - 1, Math.round(0.98 * (abs.length - 1)))],
  }
}

// Build (and mtime-cache) GIFTI shape arrays + display surfaces for one RECONSTRUCTION.
// `outputRoot` is the data-source root; cache lives under <outputRoot>/.brainana-viewer-cache.
//
// `cacheKey` identifies the recon, NOT the subject. Keying on the subject (as this did before v3)
// makes two sessions of one subject share a cache directory: the second build overwrites the
// first's lh.thickness.shape.gii with data for a different mesh, and because the overwrite is
// newer than its source the mtime guard below will never regenerate it. That is a collision that
// survives a reload.
//
// `baseDir` is the subject's base template recon, present only for the longitudinal streams; it is
// where the ?h.long.*.mgh change maps live (a _long tree does not carry them).
export function ensureDerivedAssets(outputRoot, fsDir, { cacheKey, baseDir = null } = {}) {
  if (!fsDir || !exists(fsDir)) return {}
  const surf = path.join(fsDir, 'surf')
  const cacheRoot = path.join(outputRoot, '.brainana-viewer-cache', 'surface-spacing-v2')
  const cache = path.join(cacheRoot, cacheKey)
  if (!containedIn(cacheRoot, cache)) throw new Error('Derived-asset cache key escapes the cache root')
  fs.mkdirSync(cache, { recursive: true })
  const result = { shapes: {}, displaySurfaces: {}, longMaps: {}, longRanges: {} }

  for (const hemi of ['lh', 'rh']) {
    for (const metric of ['curv', 'sulc', 'thickness']) {
      const src = path.join(surf, `${hemi}.${metric}`)
      if (!exists(src)) continue
      const dest = path.join(cache, `${hemi}.${metric}.shape.gii`)
      if (!exists(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs) {
        const values = parseFsMorphology(fs.readFileSync(src))
        fs.writeFileSync(dest, giftiShape(values))
      }
      result.shapes[`${hemi}.${metric}`] = dest
    }
  }

  const leftInflated = path.join(surf, 'lh.inflated')
  const rightInflated = path.join(surf, 'rh.inflated')
  if (exists(leftInflated) && exists(rightInflated)) {
    for (const kind of ['inflated', 'veryinflated']) {
      const leftDest = path.join(cache, kind, 'lh.inflated')
      const rightDest = path.join(cache, kind, 'rh.inflated')
      const sourceMtime = Math.max(fs.statSync(leftInflated).mtimeMs, fs.statSync(rightInflated).mtimeMs)
      if (!exists(leftDest) || !exists(rightDest) || fs.statSync(leftDest).mtimeMs < sourceMtime || fs.statSync(rightDest).mtimeMs < sourceMtime) {
        transformFsSurfacePair(leftInflated, rightInflated, leftDest, rightDest, kind)
      }
      result.displaySurfaces[`lh.${kind}`] = leftDest
      result.displaySurfaces[`rh.${kind}`] = rightDest
    }
  }

  const leftSphere = path.join(surf, 'lh.sphere')
  const rightSphere = path.join(surf, 'rh.sphere')
  if (exists(leftSphere) && exists(rightSphere)) {
    const leftDest = path.join(cache, 'sphere', 'lh.sphere')
    const rightDest = path.join(cache, 'sphere', 'rh.sphere')
    const sourceMtime = Math.max(fs.statSync(leftSphere).mtimeMs, fs.statSync(rightSphere).mtimeMs)
    if (!exists(leftDest) || !exists(rightDest) || fs.statSync(leftDest).mtimeMs < sourceMtime || fs.statSync(rightDest).mtimeMs < sourceMtime) {
      transformFsSurfacePair(leftSphere, rightSphere, leftDest, rightDest, 'sphere')
    }
    result.displaySurfaces['lh.sphere'] = leftDest
    result.displaySurfaces['rh.sphere'] = rightDest
  }

  // Longitudinal change maps -> GIFTI, alongside the morphometry shapes. Converted rather than
  // served raw because the client needs the values twice over (for the display window and the
  // crosshair readout) and parseGiftiFloat32 is the only array reader it has.
  const longSurf = baseDir ? path.join(baseDir, 'surf') : null
  if (longSurf && exists(longSurf)) {
    for (const hemi of ['lh', 'rh']) {
      for (const measure of LONG_MEASURES) {
        for (const stat of LONG_STATISTICS) {
          const src = path.join(longSurf, `${hemi}.long.${measure}-${stat}.mgh`)
          if (!exists(src)) continue
          const key = `${hemi}.${measure}-${stat}`
          const dest = path.join(cache, `${hemi}.long.${measure}-${stat}.shape.gii`)
          const rangeFile = path.join(cache, `${hemi}.long.${measure}-${stat}.range.json`)
          try {
            if (!exists(dest) || !exists(rangeFile) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs) {
              const { values } = parseMgh(fs.readFileSync(src))
              fs.writeFileSync(dest, giftiScalar(values, 'NIFTI_INTENT_NONE'))
              fs.writeFileSync(rangeFile, JSON.stringify(scalarRange(values)))
            }
            result.longMaps[key] = dest
            result.longRanges[key] = JSON.parse(fs.readFileSync(rangeFile, 'utf8'))
          } catch {
            // A map that will not parse must not fail the whole manifest: it is simply not offered.
          }
        }
      }
    }
  }
  return result
}
