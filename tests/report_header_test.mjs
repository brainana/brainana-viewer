// Unit tests for the NIfTI header formatter (apps/viewer/src/report/header.ts).
// Run via Node's native TypeScript support (Node >= 22.18 strips types on import).
import assert from 'node:assert/strict'
import { describeHeader, describeMesh, formatResolution } from '../apps/viewer/src/report/header.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// A realistic 3-D anatomical header (0.5 mm isotropic, uint8, mm units).
const anat = {
  dims: [3, 256, 256, 256, 1, 1, 1, 1],
  pixDims: [1, 0.5, 0.5, 0.5, 0, 0, 0, 0],
  datatypeCode: 2,
  numBitsPerVoxel: 8,
  intent_code: 0,
  scl_slope: 1,
  scl_inter: 0,
  cal_min: 0,
  cal_max: 255,
  qform_code: 1,
  sform_code: 1,
  xyzt_units: 10, // 2 (mm) | 8 (s)
  affine: [
    [-0.5, 0, 0, 64],
    [0, 0.5, 0, -64],
    [0, 0, 0.5, -32],
    [0, 0, 0, 1],
  ],
  littleEndian: true,
  description: 'FreeSurfer norm',
}

const info = describeHeader(anat)
assert.equal(info.nDim, 3)
assert.deepEqual(info.dims, [256, 256, 256])
assert.deepEqual(info.resolution, [0.5, 0.5, 0.5])
assert.equal(info.datatype, 'UINT8')
assert.equal(info.bitpix, 8)
assert.equal(info.spatialUnit, 'mm')
assert.equal(info.timeUnit, 's')
assert.equal(info.intent, 'NONE')
assert.equal(info.description, 'FreeSurfer norm')
ok('describeHeader resolves dims, resolution, datatype and packed xyzt_units')

// dims[0] is the dimensionality; extents come from dims[1..n], never the whole array.
assert.equal(info.frames, 1, '3-D volume reports one frame, not zero')
ok('a 3-D volume reports a single frame')

// A 4-D functional map: the frame count must come from dims[4].
const func = describeHeader({ ...anat, dims: [4, 128, 128, 96, 4, 1, 1, 1], datatypeCode: 16, intent_code: 4 })
assert.equal(func.nDim, 4)
assert.deepEqual(func.dims, [128, 128, 96, 4])
assert.equal(func.frames, 4)
assert.equal(func.datatype, 'FLOAT32')
assert.equal(func.intent, 'FTEST')
ok('describeHeader reads a 4-D map frame count from dims[4]')

// A label volume carries the atlas intent, which is what selects NiiVue's discrete shader.
assert.equal(describeHeader({ ...anat, intent_code: 1002 }).intent, 'LABEL')
ok('NIFTI_INTENT_LABEL is named')

// Unknown codes must be reported, never silently rendered as a plausible name.
const odd = describeHeader({ ...anat, datatypeCode: 9999, intent_code: 4242 })
assert.equal(odd.datatype, 'code 9999')
assert.equal(odd.intent, 'code 4242')
ok('unrecognised datatype/intent codes are reported as codes')

// A negative pixdim encodes handedness, not a negative voxel size.
assert.deepEqual(describeHeader({ ...anat, pixDims: [-1, -0.5, 0.5, -0.5, 0, 0, 0, 0] }).resolution, [0.5, 0.5, 0.5])
ok('negative pixdims are reported as absolute voxel sizes')

// Degenerate headers must not throw mid-report.
assert.equal(describeHeader(null), null)
assert.equal(describeHeader({}), null)
assert.equal(describeHeader({ dims: [3] }), null, 'dims with no extents is not a usable header')
ok('missing/degenerate headers return null instead of throwing')

// A header with no affine still formats, falling back to identity.
const noAffine = describeHeader({ ...anat, affine: undefined })
assert.equal(noAffine.affine.length, 4)
assert.deepEqual(noAffine.affine[0], [1, 0, 0, 0])
ok('a header without an affine falls back to identity')

// A bogus dims[0] must not slice past the array or produce a negative dimensionality.
const bogus = describeHeader({ ...anat, dims: [99, 64, 64, 64, 1, 1, 1, 1] })
assert.equal(bogus.nDim, 7)
assert.equal(bogus.dims.length, 7)
ok('an out-of-range dims[0] falls back to the array length')

// Resolution formatting collapses an isotropic grid and keeps anisotropic axes explicit.
assert.equal(formatResolution(info), '0.5³ mm')
assert.equal(formatResolution(describeHeader({ ...anat, pixDims: [1, 0.5, 0.5, 1.2, 0, 0, 0, 0] })), '0.5 × 0.5 × 1.2 mm')
assert.equal(formatResolution(describeHeader({ ...anat, xyzt_units: 0 })), '0.5³', 'unknown units print no unit suffix')
ok('formatResolution collapses isotropic grids and omits unknown units')

// Mesh counts derive from the flat NVMesh arrays: 3 floats per vertex, 3 indices per face.
assert.deepEqual(describeMesh({ pts: new Float32Array(9), tris: new Uint32Array(6) }), { vertices: 3, faces: 2 })
assert.equal(describeMesh(null), null)
assert.equal(describeMesh({ pts: new Float32Array(9) }), null, 'a mesh without triangles is not describable')
ok('describeMesh counts vertices and faces from flat arrays')

console.log(`\nreport_header_test: ${passed} checks passed`)
