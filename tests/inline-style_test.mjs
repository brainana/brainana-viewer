// Guards one CSS invariant that is invisible in code review and looks like a stale bundle on screen.
//
// `el.style.background = ...` is a SHORTHAND. It resets every background longhand it does not
// mention back to its initial value -- background-origin among them -- and an inline style beats the
// stylesheet. So a single shorthand assignment silently undoes a rule like
// `.cmap-swatch { background-origin: border-box }` on every repaint.
//
// The symptom that cost two rounds of debugging: .cmap-swatch is 34px wide with a 1px border, so
// with background-origin back at its padding-box default the browser sized a 32px gradient tile and
// filled the leftover 1px strips by REPEATING it -- painting the colormap's LAST colour down the
// swatch's left edge. On a diverging map that put red hard against blue and read as part of the ramp.
//
// If this test fails: use the longhand for what you are actually setting --
//   a gradient or image  -> el.style.backgroundImage
//   a solid colour       -> el.style.backgroundColor
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCANNED = [path.join(root, 'apps', 'viewer', 'src'), path.join(root, 'packages', 'ui')]

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full)
    return /\.(mjs|ts)$/.test(e.name) ? [full] : []
  })
}

// `.style.background =` but NOT .backgroundImage / .backgroundColor / .backgroundSize / ...
// The negative lookahead is what distinguishes the shorthand from every legitimate longhand.
const SHORTHAND = /\.style\.background\s*=(?!=)/

let passed = 0
const violations = []
for (const dir of SCANNED) {
  for (const file of walk(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // Skip comments, so the explanatory prose above each call site does not trip its own guard.
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (SHORTHAND.test(code)) violations.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`)
    })
  }
}

assert.deepEqual(
  violations,
  [],
  `the \`background\` shorthand resets background-origin/-clip and beats the stylesheet inline.\n` +
    `Use .backgroundImage (gradient/image) or .backgroundColor (solid) instead:\n${violations.join('\n')}`,
)
passed++
console.log('  ok - no inline `style.background` shorthand clobbers stylesheet background longhands')

// The rule only earns its keep while the stylesheet actually depends on it.
const css = fs.readFileSync(path.join(root, 'apps', 'viewer', 'src', 'style.css'), 'utf8')
const swatch = css.match(/\.cmap-swatch\s*\{[^}]*\}/)
assert.ok(swatch, '.cmap-swatch rule not found')
assert.match(swatch[0], /background-origin:\s*border-box/, '.cmap-swatch must size its gradient to the border box')
assert.equal(
  /border-radius/.test(swatch[0]),
  false,
  '.cmap-swatch is square on purpose: a corner radius clips the endpoint colours a diverging map is read by',
)
passed++
console.log('  ok - .cmap-swatch sizes its gradient to the border box and stays square')

console.log(`inline-style_test: ${passed} checks passed`)
