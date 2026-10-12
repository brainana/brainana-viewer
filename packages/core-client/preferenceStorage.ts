// Storage for remembered preferences (recent sources, profiles, app settings).
//
// In the browser this is plain localStorage. In the desktop shell, localStorage is keyed by the
// loopback origin, whose port can change between launches — so the shell exposes a preference
// bridge (packages/core-desktop/preload.cjs) backed by files the main process owns. Callers keep a
// synchronous Storage-like API: reads come from a cache loaded once at startup, writes update the
// cache immediately and reach disk asynchronously, in order. A failed write rolls the cache back.

interface PreferenceBridge {
  readAll(): Promise<{ keys: string[]; values: Record<string, string> }>
  write(key: string, value: string | null): Promise<void>
  onSettings(callback: () => void): () => void
}

declare global {
  interface Window {
    brainanaPreferences?: PreferenceBridge
  }
}

export type PreferenceStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Fired on window when a preference cannot be read or saved; detail is the message. */
export const STORAGE_ERROR_EVENT = 'brainana-storage-error'

let bridge: PreferenceBridge | null = null
let keys = new Set<string>()
let cache: Record<string, string> = {}
let durable: Record<string, string> = {}
let readOnly = false
let writes: Promise<void> = Promise.resolve()
let lastError: string | null = null

function report(err: unknown): void {
  lastError = err instanceof Error ? err.message : String(err)
  window.dispatchEvent(new CustomEvent(STORAGE_ERROR_EVENT, { detail: lastError }))
}

function legacyStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // Safari private mode et al.
  }
}

/** Load desktop preferences into the cache. Call once before anything reads a preference. */
export async function initializePreferenceStorage(): Promise<void> {
  bridge = typeof window !== 'undefined' ? (window.brainanaPreferences ?? null) : null
  if (!bridge) return
  try {
    const saved = await bridge.readAll()
    keys = new Set(saved.keys)
    cache = { ...saved.values }
  } catch (err) {
    // Files exist but could not be read. Writing now would replace them with defaults, so keep this
    // session read-only: changes still apply in memory, but nothing is saved.
    readOnly = true
    report(err)
    return
  }
  // One-time migration from this origin's localStorage (browser-mode or older desktop builds).
  const legacy = legacyStorage()
  for (const key of keys) {
    if (cache[key] !== undefined) continue
    const value = legacy?.getItem(key)
    if (value != null && value.length <= 1_000_000) {
      cache[key] = value
      queue(key, value)
    }
  }
  durable = { ...cache }
}

function queue(key: string, value: string | null): void {
  const active = bridge
  if (!active || readOnly) return
  writes = writes
    .catch(() => {})
    .then(async () => {
      await active.write(key, value)
      if (value === null) delete durable[key]
      else durable[key] = value
      lastError = null
    })
    .catch((err: unknown) => {
      // Roll back only if nothing newer replaced the value meanwhile.
      if ((cache[key] ?? null) === value) {
        if (durable[key] === undefined) delete cache[key]
        else cache[key] = durable[key]
      }
      report(err)
      throw err
    })
  writes.catch(() => {})
}

const desktopStore: PreferenceStore = {
  getItem: (key) => cache[key] ?? null,
  setItem: (key, value) => {
    if (!keys.has(key) && !readOnly) throw new Error(`Unsupported preference key: ${key}`)
    cache[key] = value
    queue(key, value)
  },
  removeItem: (key) => {
    delete cache[key]
    queue(key, null)
  },
}

/** The active store: the desktop cache when the bridge is present, else localStorage (or null). */
export function preferenceStorage(): PreferenceStore | null {
  return bridge ? desktopStore : legacyStorage()
}

/** Resolves once every queued desktop write has settled; rejects if the last one failed. */
export async function flushPreferences(): Promise<void> {
  await writes
}

/** The last read/write failure, or null. Read-only sessions keep their read error. */
export function preferenceStorageError(): string | null {
  return readOnly ? `preferences could not be read; changes will not be saved (${lastError})` : lastError
}

/** Desktop menu → "Settings…". Returns an unsubscribe function (a no-op in the browser). */
export function onSettingsRequest(callback: () => void): () => void {
  return bridge ? bridge.onSettings(callback) : () => {}
}
