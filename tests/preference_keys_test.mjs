// The desktop shell persists only the preference keys the app declares (apps/viewer/desktop.mjs).
// A key used in code but missing from that list fails every write in the desktop app (and only
// there), so check the two against each other.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KEY_RE = /'(brainana\.[A-Za-z.]+\.v\d+)'/g

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full)
    return /\.ts$/.test(e.name) ? [full] : []
  })
}

const used = new Set()
for (const dir of ['apps/viewer/src', 'packages/core-client']) {
  for (const file of walk(path.join(root, dir))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(KEY_RE)) used.add(m[1])
  }
}
const desktop = fs.readFileSync(path.join(root, 'apps/viewer/desktop.mjs'), 'utf8')
const block = desktop.match(/preferenceKeys:\s*\[([\s\S]*?)\]/)
assert.ok(block, 'desktop.mjs declares preferenceKeys')
const declared = new Set([...block[1].matchAll(KEY_RE)].map((m) => m[1]))

assert.ok(used.size >= 4, `found the keys in use (${[...used].join(', ')})`)
assert.deepEqual([...used].filter((k) => !declared.has(k)), [], 'every key the code uses is declared for the desktop store')
assert.deepEqual([...declared].filter((k) => !used.has(k)), [], 'no stale keys are declared')
console.log('  ok - desktop preference keys match the keys the viewer uses')
console.log('preference_keys_test: 1 checks passed')
