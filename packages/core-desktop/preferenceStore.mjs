// Durable per-app preference files for the desktop shell.
//
// Why not plain localStorage: the renderer's origin is the loopback server, whose port can change
// between launches (preferredPort is only a preference). localStorage is keyed by origin, so a port
// change would silently drop every remembered setting. The main process owns a fixed directory
// under userData instead, and the renderer reaches it through a narrow IPC bridge (preload.cjs).
//
// One JSON-encoded string per key, so the renderer keeps its synchronous Storage-like contract.
// Only keys the app declared are accepted (no path built from renderer input), values are bounded,
// and writes are serialized and atomic (tmp + rename) so a crash never leaves a half-written file.
import fs from 'node:fs/promises'
import path from 'node:path'

export const MAX_VALUE_BYTES = 1_000_000
const KEY_RE = /^[A-Za-z0-9._-]+$/

export function createPreferenceStore(directory, keys) {
  const allowed = new Set(keys)
  for (const key of allowed) if (!KEY_RE.test(key)) throw new Error(`Invalid preference key: ${key}`)

  const file = (key) => {
    if (!allowed.has(key)) throw new Error('Unknown preference key')
    return path.join(directory, `${key}.json`)
  }

  async function readOne(key) {
    try {
      if ((await fs.stat(file(key))).size > MAX_VALUE_BYTES) return null
      const value = JSON.parse(await fs.readFile(file(key), 'utf8'))
      return typeof value === 'string' ? [key, value] : null
    } catch (err) {
      // Missing or corrupt files read as "unset"; anything else (permissions, EMFILE) is a real
      // failure the renderer must hear about, so it does not overwrite files it could not read.
      if (err.code === 'ENOENT' || err instanceof SyntaxError) return null
      throw err
    }
  }

  let chain = Promise.resolve()
  return {
    keys: () => [...allowed],
    async flush() {
      await chain.catch(() => {})
    },
    async readAll() {
      await chain.catch(() => {})
      const entries = await Promise.all([...allowed].map(readOne))
      return Object.fromEntries(entries.filter(Boolean))
    },
    write(key, value) {
      const target = file(key)
      if (value !== null && (typeof value !== 'string' || Buffer.byteLength(JSON.stringify(value)) > MAX_VALUE_BYTES)) {
        throw new Error('Invalid preference value')
      }
      const write = chain
        .catch(() => {})
        .then(async () => {
          await fs.mkdir(directory, { recursive: true })
          if (value === null) {
            await fs.rm(target, { force: true })
            return
          }
          await fs.writeFile(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 })
          await fs.rename(`${target}.tmp`, target)
        })
      chain = write
      return write
    },
  }
}
