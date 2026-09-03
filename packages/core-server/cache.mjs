// Tool-agnostic async cache for remote files, validated by size + mtime.
// Ported/generalised from remote-filesystem.mjs ensureCached (server.mjs finding R4):
// the SSH-specific spawnSync fetch is replaced by an injected async `fetchToTemp`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export class RemoteFileCache {
  // namespace scopes the digest so two sources (different host/root) never collide.
  constructor({ cacheRoot, namespace = '' }) {
    if (!cacheRoot) throw new Error('RemoteFileCache requires a cacheRoot')
    this.cacheRoot = cacheRoot
    this.namespace = namespace
    fs.mkdirSync(cacheRoot, { recursive: true })
  }

  cachePath(relative) {
    const digest = crypto.createHash('sha256').update(`${this.namespace}\0${relative}`).digest('hex').slice(0, 20)
    const basename = path.basename(relative) || 'root'
    return path.join(this.cacheRoot, 'files', digest, basename)
  }

  // Return a local path to the cached file, fetching it if the cache is missing or stale.
  //   relative     — key identifying the remote file
  //   info         — { size, mtimeMs } remote stat used to validate the cache
  //   fetchToTemp  — async (tempPath) => void; must write the full file to tempPath
  async ensure(relative, info, fetchToTemp) {
    const dest = this.cachePath(relative)
    const metaPath = `${dest}.brainana-meta.json`

    let valid = false
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
      valid =
        fs.existsSync(dest) &&
        meta.size === info.size &&
        meta.mtimeMs === info.mtimeMs &&
        fs.statSync(dest).size === info.size
    } catch {
      // no/invalid meta → refetch
    }
    if (valid) return dest

    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const temp = `${dest}.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    try {
      await fetchToTemp(temp)
      const written = fs.statSync(temp).size
      if (written !== info.size) throw new Error(`Remote file transfer incomplete (${written}/${info.size} bytes)`)
      await fsp.rename(temp, dest)
      await fsp.writeFile(metaPath, JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs, relative }))
      return dest
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// Cache administration
// ---------------------------------------------------------------------------
//
// The cache has no eviction policy: it holds whole neuroimaging volumes and grows until something
// else fills the disk. Real LRU eviction is a bigger design question (what is hot? across how many
// sources?) and is deliberately not attempted here. What IS provided is the escape hatch — see the
// size, and reclaim it — which is what turns an invisible problem into a manageable one.

// Recursively total the bytes under a directory. Missing directories count as zero, and an
// unreadable entry is skipped rather than aborting the walk: this is a size report, and a partial
// number is far more useful than an exception.
async function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await dirSize(full)
      else if (entry.isFile()) total += (await fsp.stat(full)).size
    } catch {
      // vanished mid-walk, or unreadable — skip it
    }
  }
  return total
}

// Every `files/` directory under the cache root: one per remote source, holding fetched bytes.
// These are the reclaimable part. `mirror/` is NOT — it carries the placeholder tree and the
// materialised surface binaries buildManifest parses, so deleting it would break an open source
// until the next manifest build.
async function fileStores(cacheRoot) {
  const found = []
  const walk = async (dir, depth) => {
    if (depth < 0) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'mirror') continue // never descend into a mirror
      const full = path.join(dir, entry.name)
      if (entry.name === 'files') found.push(full)
      else await walk(full, depth - 1)
    }
  }
  await walk(cacheRoot, 4)
  return found
}

/** Total and reclaimable size of the cache tree. Never throws; an absent root reports zero. */
export async function cacheUsage(cacheRoot) {
  const bytes = await dirSize(cacheRoot)
  let reclaimableBytes = 0
  for (const store of await fileStores(cacheRoot)) reclaimableBytes += await dirSize(store)
  return { path: cacheRoot, bytes, reclaimableBytes }
}

/**
 * Delete the fetched file bytes, keeping every mirror intact. Safe to call while sources are open:
 * openFile re-fetches whatever it needs on the next read, so the cost is time, never correctness.
 */
export async function reclaimCachedFiles(cacheRoot) {
  let freed = 0
  for (const store of await fileStores(cacheRoot)) {
    freed += await dirSize(store)
    await fsp.rm(store, { recursive: true, force: true }).catch(() => {})
  }
  return { bytes: freed }
}
