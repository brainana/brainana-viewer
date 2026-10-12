// Renderer half of the desktop preference bridge (packages/core-client/preferenceStorage.ts).
//
// The module keeps state, so each scenario imports a fresh instance (a distinct ?query is a
// distinct ES module). `window` is a minimal stand-in: the module only needs the bridge object and
// dispatchEvent for error reports.
import assert from 'node:assert/strict'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const KEYS = ['brainana.recentSources.v1', 'brainana.fovMode.v1']
let instance = 0

function setup({ disk = {}, legacy = {}, readAll, write } = {}) {
  const errors = []
  const legacyMap = new Map(Object.entries(legacy))
  globalThis.localStorage = {
    getItem: (k) => (legacyMap.has(k) ? legacyMap.get(k) : null),
    setItem: (k, v) => legacyMap.set(k, v),
    removeItem: (k) => legacyMap.delete(k),
  }
  globalThis.window = {
    dispatchEvent: (e) => errors.push(e.detail),
    brainanaPreferences: {
      readAll: readAll ?? (async () => ({ keys: KEYS, values: { ...disk } })),
      write:
        write ??
        (async (k, v) => {
          if (v === null) delete disk[k]
          else disk[k] = v
        }),
      onSettings: () => () => {},
    },
  }
  return { disk, errors }
}

const load = () => import(`../packages/core-client/preferenceStorage.ts?case=${++instance}`)

// --- persistence across launches, independent of the page origin --------------------------------
{
  const { disk } = setup()
  let m = await load()
  await m.initializePreferenceStorage()
  m.preferenceStorage().setItem('brainana.fovMode.v1', 'full')
  await m.flushPreferences()
  assert.equal(disk['brainana.fovMode.v1'], 'full')

  setup({ disk })
  m = await load()
  await m.initializePreferenceStorage()
  assert.equal(m.preferenceStorage().getItem('brainana.fovMode.v1'), 'full')
  ok('a value written in one launch is read in the next')
}

// --- one-time migration from origin localStorage --------------------------------------------------
{
  const { disk } = setup({ legacy: { 'brainana.recentSources.v1': '[]', 'brainana.unrelated': 'x' } })
  const m = await load()
  await m.initializePreferenceStorage()
  await m.flushPreferences()
  assert.equal(disk['brainana.recentSources.v1'], '[]')
  assert.equal(disk['brainana.unrelated'], undefined, 'undeclared keys are not migrated')
  ok('declared keys migrate from localStorage when the desktop store has none')
}

// --- writes ---------------------------------------------------------------------------------------
{
  const { errors } = setup({ disk: { 'brainana.fovMode.v1': 'best' } })
  const m = await load()
  await m.initializePreferenceStorage()
  assert.throws(() => m.preferenceStorage().setItem('arbitrary', 'x'), /Unsupported/)

  globalThis.window.brainanaPreferences.write = async () => {
    throw new Error('disk full')
  }
  m.preferenceStorage().setItem('brainana.fovMode.v1', 'full')
  await assert.rejects(m.flushPreferences(), /disk full/)
  assert.equal(m.preferenceStorage().getItem('brainana.fovMode.v1'), 'best', 'failed write rolls back')
  assert.deepEqual(errors, ['disk full'])
  assert.equal(m.preferenceStorageError(), 'disk full')
  ok('undeclared keys are refused; a failed write rolls back and is reported')
}

// --- an unreadable store must not be overwritten ----------------------------------------------------
{
  const writes = []
  const { errors } = setup({
    readAll: async () => {
      throw new Error('EACCES')
    },
    write: async (k, v) => writes.push([k, v]),
  })
  const m = await load()
  await m.initializePreferenceStorage()
  m.preferenceStorage().setItem('brainana.fovMode.v1', 'full')
  await m.flushPreferences()
  assert.equal(m.preferenceStorage().getItem('brainana.fovMode.v1'), 'full', 'still applies in memory')
  assert.deepEqual(writes, [], 'nothing is written')
  assert.deepEqual(errors, ['EACCES'])
  assert.match(m.preferenceStorageError(), /could not be read/)
  ok('a failed read makes the session read-only instead of replacing files with defaults')
}

// --- browser mode ---------------------------------------------------------------------------------
{
  setup()
  delete globalThis.window.brainanaPreferences
  const m = await load()
  await m.initializePreferenceStorage()
  assert.equal(m.preferenceStorage(), globalThis.localStorage)
  ok('without the desktop bridge, storage is plain localStorage')
}

console.log(`preference_bridge_test: ${passed} checks passed`)
