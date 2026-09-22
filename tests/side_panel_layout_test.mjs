// Guards the side column's height budget, whose failure mode is text painting over other text.
//
// `.atlas-legend` is a flex column holding three children: the docked category picker, the content
// slot (ROI legend / func / morphology / the change tab's ROI fits table), and the COLOR DISPLAY
// dock. The dock is the LAST sibling, so it paints on top of whatever the earlier two let escape.
//
// The bug this pins down: both the picker and the dock were `flex: 0 0 auto`, so every pixel of
// shortage landed on the one shrinkable child. Its descendants (`.roi-rate-controls`, the captions)
// are flex items with min-height:auto -- their content height is a hard floor -- and nothing
// between them and `.atlas-legend` set `overflow`, so they spilled out and the COLOR DISPLAY header
// rendered straight through the `hemi` row while the table's rows collapsed to nothing.
//
// Two rules make the overlap structurally impossible, independent of any future height budget:
//   1. `.side-slot { overflow: hidden }`  -- a squeezed slot truncates, it never spills
//   2. `.color-dock { flex: 0 1 auto }`   -- it has min-height:0 and its own scroller, so it must
//                                            be allowed to give height back
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = fs.readFileSync(path.join(root, 'apps', 'viewer', 'src', 'style.css'), 'utf8')

// Match the rule for an exact selector, so `.side-slot[hidden]` cannot stand in for `.side-slot`.
const rule = (selector) => {
  const m = css.match(new RegExp(`(^|\\n)\\s*${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{[^}]*\\}`))
  assert.ok(m, `${selector} rule not found in style.css`)
  return m[0]
}

let passed = 0

assert.match(
  rule('.side-slot'),
  /overflow:\s*hidden/,
  '.side-slot must clip: .color-dock is a later sibling, so a spilling slot paints over COLOR DISPLAY',
)
passed++
console.log('  ok - a squeezed side slot truncates instead of painting over the colour dock')

for (const selector of ['.color-dock', '.side-picker']) {
  const flex = rule(selector).match(/flex:\s*([^;]+);/)
  assert.ok(flex, `${selector} must declare flex`)
  assert.equal(
    /^0\s+0\b/.test(flex[1].trim()),
    false,
    `${selector} is flex-shrink 0, so all of the column's shortage falls on .side-content — it has ` +
      `min-height:0 and its own scroller, so let it shrink (0 1 auto)`,
  )
  passed++
  console.log(`  ok - ${selector} yields height instead of forcing the squeeze onto the content slot`)
}

// The picker and the dock may shrink only because each one scrolls its own overflow.
for (const selector of ['.color-dock', '.side-picker']) {
  assert.match(rule(selector), /overflow-y:\s*auto/, `${selector} must scroll what it cannot show`)
  passed++
  console.log(`  ok - ${selector} scrolls its own overflow`)
}

// The ROI fits controls sit in the block that cannot shrink, so their line count is load-bearing:
// three 96px `select.narrow` fields wrapped to three lines at the panel's 220-280px.
const controls = rule('.roi-rate-controls')
assert.match(controls, /display:\s*grid/, '.roi-rate-controls must not wrap as a flex row')
assert.match(css, /\.roi-rate-controls\s+\.field\[hidden\]\s*\{[^}]*display:\s*none/,
  '.field { display: flex } out-ranks the UA [hidden] rule, so a hidden stat picker still shows')
passed++
console.log('  ok - ROI fits controls stay compact and a hidden control is really hidden')

console.log(`side_panel_layout_test: ${passed} checks passed`)
