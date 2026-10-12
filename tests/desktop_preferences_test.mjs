// Desktop preference files (packages/core-desktop/preferenceStore.mjs).
//
// The store is the main-process half of the preference bridge: the only code that turns a
// renderer-supplied key into a file path. It must accept only the keys the app declared, bound
// values, serialize writes, and never leave half-written files behind.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPreferenceStore } from '@brainana/core-desktop/preferenceStore.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const KEY = 'brainana.example.v1'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brainana-preferences-'))
try {
  const store = createPreferenceStore(directory, [KEY, 'brainana.other.v1'])
  assert.deepEqual(await store.readAll(), {})
  assert.deepEqual(store.keys(), [KEY, 'brainana.other.v1'])
  ok('an empty directory reads as no preferences')

  await Promise.all([store.write(KEY, 'one'), store.write(KEY, 'two'), store.write(KEY, 'three')])
  await store.flush()
  assert.equal((await createPreferenceStore(directory, [KEY]).readAll())[KEY], 'three')
  assert.ok(!(await fs.readdir(directory)).some((f) => f.endsWith('.tmp')), 'no temp files left')
  ok('writes are serialized; the last one wins and survives a new store')

  assert.throws(() => store.write('../outside', 'x'), /Unknown/)
  assert.throws(() => store.write('brainana.undeclared.v1', 'x'), /Unknown/)
  assert.throws(() => createPreferenceStore(directory, ['../escape']), /Invalid preference key/)
  ok('only declared keys are accepted, and keys cannot name a path')

  assert.throws(() => store.write(KEY, 'x'.repeat(1_000_001)), /Invalid/)
  assert.throws(() => store.write(KEY, { not: 'a string' }), /Invalid/)
  ok('values must be bounded strings')

  await store.write(KEY, null)
  assert.equal((await store.readAll())[KEY], undefined)
  await fs.writeFile(path.join(directory, `${KEY}.json`), 'not json')
  assert.equal((await store.readAll())[KEY], undefined)
  ok('removed and corrupt entries read as unset')

  // A real read failure (here: the entry is a directory) must reach the renderer, not read as
  // "unset" — otherwise the next write would replace a file the user still has.
  await fs.rm(path.join(directory, `${KEY}.json`))
  await fs.mkdir(path.join(directory, `${KEY}.json`))
  await assert.rejects(store.readAll())
  ok('unreadable entries reject instead of reading as defaults')
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}

console.log(`desktop_preferences_test: ${passed} checks passed`)
