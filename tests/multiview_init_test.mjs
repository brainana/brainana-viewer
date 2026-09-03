// MultiView's NiiVue initialisation order (audit finding N2).
//
// Niivue.attachToCanvas is ASYNC — it returns a Promise, and NiiVue's own docs await it — but a
// constructor cannot await. So MultiView used to fire both attachments and then immediately call
// setSliceType and assign .opts against instances whose GL context might not be attached yet. It
// worked because NiiVue tolerated the ordering, not because anything guaranteed it; that is the
// kind of assumption a Chromium/NiiVue upgrade quietly stops honouring, and the symptom would be
// an intermittently blank canvas rather than an error.
//
// initNiivuePair is the ordering, extracted so it can be driven by fakes and asserted here.
import assert from 'node:assert/strict'
import { initNiivuePair } from '../apps/viewer/src/niivue/multiView.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// A stand-in for Niivue that records the order of what happens to it and lets the test decide when
// attachment completes.
function fakeNiivue(log, name) {
  let release
  const attached = new Promise((resolve) => (release = resolve))
  const nv = {
    name,
    attachedYet: false,
    opts: new Proxy({}, {
      set(target, prop, value) {
        log.push(`${name}.opts.${String(prop)}`)
        target[prop] = value
        return true
      },
    }),
    attachToCanvas: async () => {
      log.push(`${name}.attachToCanvas:start`)
      await attached
      nv.attachedYet = true
      log.push(`${name}.attachToCanvas:done`)
      return nv
    },
    setSliceType: (t) => log.push(`${name}.setSliceType(${t})[attached=${nv.attachedYet}]`),
    addColormap: () => log.push(`${name}.addColormap[attached=${nv.attachedYet}]`),
  }
  return { nv, release: () => release() }
}

const log = []
const slices = fakeNiivue(log, 'slices')
const render = fakeNiivue(log, 'render')

const pending = initNiivuePair(slices.nv, render.nv, {}, {})

// Nothing may be configured while attachment is still in flight.
await new Promise((r) => setTimeout(r, 10))
const configuredEarly = log.filter((l) => /setSliceType|addColormap|\.opts\./.test(l))
assert.deepEqual(configuredEarly, [], `nothing is configured before attachment resolves, but saw: ${configuredEarly.join(', ')}`)
ok('no configuration happens while attachToCanvas is still pending')

slices.release()
render.release()
await pending

// Everything that did happen, happened after BOTH attachments finished.
assert.ok(log.includes('slices.attachToCanvas:done') && log.includes('render.attachToCanvas:done'), 'both canvases attached')
for (const entry of log.filter((l) => /setSliceType|addColormap|\.opts\./.test(l))) {
  assert.ok(!entry.includes('attached=false'), `${entry} ran before its instance was attached`)
}
const lastAttach = Math.max(log.indexOf('slices.attachToCanvas:done'), log.indexOf('render.attachToCanvas:done'))
const firstConfig = log.findIndex((l) => /setSliceType|addColormap|\.opts\./.test(l))
assert.ok(firstConfig > lastAttach, 'the first configuration call comes after the last attachment')
ok('every configuration call runs after both attachments have completed')

// And the configuration it was supposed to apply actually got applied.
assert.ok(log.some((l) => l.startsWith('slices.setSliceType')), 'the slice montage type is set')
assert.ok(log.some((l) => l.startsWith('render.setSliceType')), 'the render type is set')
assert.ok(log.some((l) => l === 'slices.opts.multiplanarShowRender'), 'the slices instance keeps pure planes')
assert.ok(log.some((l) => l === 'render.opts.isOrientCube'), 'the orientation cube is disabled')
assert.ok(log.some((l) => l === 'slices.opts.crosshairColor') && log.some((l) => l === 'render.opts.crosshairColor'), 'both crosshairs are tinted')
assert.ok(log.some((l) => l.startsWith('slices.addColormap')) && log.some((l) => l.startsWith('render.addColormap')), 'colormaps are registered on both')
ok('the full display configuration is still applied')

console.log(`\nmultiview_init: ${passed} checks passed`)
