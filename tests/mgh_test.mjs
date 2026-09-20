// parseMgh: the uncompressed FreeSurfer MGH reader for brainana's longitudinal change maps
// (?h.long.<measure>-{rate,avg,spc}.mgh).
//
// The reader is deliberately narrow. Every rejection below is a case where a lenient parser would
// hand back a plausible-looking Float32Array built from the wrong bytes -- and a change map is
// exactly the kind of data nobody can eyeball for correctness, so a wrong array would be believed.
import assert from 'node:assert/strict'
import { parseMgh, giftiScalar } from '../apps/viewer/server/freesurfer.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const DATA_OFFSET = 284

function mgh({ version = 1, width = 4, height = 1, depth = 1, nframes = 1, type = 3, values = null, truncate = 0 } = {}) {
  const body = values ?? Array.from({ length: width }, (_, i) => (i + 1) * 0.25)
  const buf = Buffer.alloc(DATA_OFFSET + body.length * 4)
  buf.writeInt32BE(version, 0)
  buf.writeInt32BE(width, 4)
  buf.writeInt32BE(height, 8)
  buf.writeInt32BE(depth, 12)
  buf.writeInt32BE(nframes, 16)
  buf.writeInt32BE(type, 20)
  body.forEach((v, i) => buf.writeFloatBE(v, DATA_OFFSET + i * 4))
  return truncate ? buf.subarray(0, buf.length - truncate) : buf
}

// --- the happy path -------------------------------------------------------------------------
{
  const parsed = parseMgh(mgh({ width: 4, values: [-0.25, 0, 1.5, 3.75] }))
  assert.equal(parsed.width, 4)
  assert.equal(parsed.nframes, 1)
  assert.deepEqual([...parsed.values], [-0.25, 0, 1.5, 3.75], 'big-endian floats are read from offset 284')
  ok('a per-vertex MGH parses to its float values')
}

// --- rejections -----------------------------------------------------------------------------
{
  const gz = Buffer.alloc(DATA_OFFSET + 16)
  gz[0] = 0x1f
  gz[1] = 0x8b
  assert.throws(() => parseMgh(gz), /mgz/i, 'a gzipped .mgz names itself in the error')
  ok('a compressed .mgz is refused rather than read as garbage')
}
assert.throws(() => parseMgh(mgh({ version: 2 })), /version/i)
ok('an unknown MGH version is refused')

assert.throws(() => parseMgh(mgh({ type: 1 })), /type/i)
ok('a non-float data type is refused (the bytes would be misread)')

for (const shape of [{ nframes: 2 }, { height: 2 }, { depth: 2 }]) {
  assert.throws(() => parseMgh(mgh(shape)), /per-vertex/i)
}
ok('a volume or multi-frame MGH is refused; only n x 1 x 1 is a per-vertex map')

assert.throws(() => parseMgh(mgh({ width: 4, truncate: 8 })), /truncat/i)
ok('a truncated body is refused rather than returning a short array')

assert.throws(() => parseMgh(Buffer.alloc(32)), /header/i)
ok('a file shorter than the header is refused')

// --- round-trip through the GIFTI serialiser ---------------------------------------------------
// parseMgh reads BIG-endian; giftiScalar writes LITTLE-endian. Getting that conversion wrong
// produces finite, wrongly-scaled numbers rather than an obvious failure, so assert the values
// survive rather than trusting the two functions agree.
{
  const values = [-1.5, 0, 0.125, 42]
  const xml = giftiScalar(parseMgh(mgh({ width: 4, values })).values, 'NIFTI_INTENT_NONE')
  assert.match(xml, /Intent="NIFTI_INTENT_NONE"/, 'the requested intent is written')
  assert.match(xml, /Dim0="4"/)
  const b64 = xml.match(/<Data>([^<]*)<\/Data>/)[1]
  const bytes = Buffer.from(b64, 'base64')
  const back = Array.from({ length: 4 }, (_, i) => bytes.readFloatLE(i * 4))
  assert.deepEqual(back, values, 'values survive the big-endian -> little-endian conversion')
  ok('parseMgh -> giftiScalar round-trips the values and honours the intent')
}

console.log(`mgh_test: ${passed} checks passed`)
