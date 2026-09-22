// Tool-agnostic DataSource contract + in-process registry.
//
// The server starts UNBOUND and holds a Map<sourceId, DataSource>. Each loaded subject
// carries its sourceId, so the browser can hold subjects from several sources at once.
//
// A DataSource implements:
//   async listMonkeys()                      -> [{ id, label, relativePath, session? }]
//   async buildManifest(subjectId, { target })           -> manifest object (source-scoped URLs)
//   async listDirectories(rel)               -> { path, displayPath, parent, selectable, entries }
//   async listImportFiles(rel, q)            -> { path, displayPath, parent, entries }
//   async openFile(rel, rangeHeader)         -> { total, contentType, start, end, partial, stream }
//   async saveList(rel)                      -> { path, entries }
//   async mkdir(rel)                         -> { path }
//   async saveFile(rel, readable, { overwrite }) -> { exists } | { bytes }
//   fileUrl(absOrRel)                        -> source-scoped URL string | null
//   async close()                            -> release resources (ssh connection, etc.)
import crypto from 'node:crypto'

// Extension → content type. NiiVue selects mesh/overlay parsers by URL suffix, so the
// real extension must survive into the served response (see server.mjs serveFile notes).
export function contentTypeFor(name) {
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.gii')) return 'application/gifti+xml'
  if (lower.endsWith('.nii')) return 'application/octet-stream'
  if (lower.endsWith('.nii.gz')) return 'application/gzip'
  if (lower.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

// Parse an HTTP Range header against a known total size (RFC 7233 single-range).
// Returns { start, end } (inclusive) or null when there is no/unsatisfiable range.
//   bytes=2-5   -> { start: 2, end: 5 }              (explicit range)
//   bytes=500-  -> { start: 500, end: totalSize-1 }  (open-ended)
//   bytes=-500  -> last 500 bytes                    (suffix; empty start)
export function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null
  // Anchored: unanchored, any header merely CONTAINING "bytes=" ("xbytes=0-1") parsed as a valid
  // range. A header we do not fully understand must be ignored — serving the whole file — rather
  // than half-understood.
  const m = /^\s*bytes=(\d*)-(\d*)\s*$/.exec(String(rangeHeader))
  if (!m) return null
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return null // "bytes=-" names no range
  let start
  let end
  if (!hasStart) {
    // Suffix range: the final N bytes of the resource.
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, totalSize - suffix)
    end = totalSize - 1
  } else {
    start = Number(m[1])
    end = hasEnd ? Number(m[2]) : totalSize - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0) return null
  if (start >= totalSize) return null // beyond EOF -> unsatisfiable (416)
  return { start, end: Math.min(end, totalSize - 1) }
}

// Regex fragment matching a source id in a URL path segment. A source id is `<type>-<12 hex>`
// (see #nextId). Exported so the runtime's data-route matching is built from the SAME pattern —
// changing the id shape here can never silently desync the routes that parse it.
export const SOURCE_ID_PATTERN = '[^/]+-[0-9a-f]{12}'

// In-process registry of live data sources.
// THE source summary shape sent to clients. Every route that returns a source must go through
// this: the shape was previously hand-built in three places (registry.list, POST /api/sources,
// PATCH /api/sources/:id), and a field added to one of them silently reached only some callers —
// which is exactly how `root` went missing from a freshly-added source.
//
// `root` is the absolute path the data actually lives at: on this machine for a local source, on
// the remote host for an SFTP one. It grants no reach the "add local dataset" form did not already
// have (that form accepts any absolute path), and it lets a client show a real path — the report does.
export function summarizeSource(source) {
  return {
    id: source.id,
    type: source.type,
    label: source.label,
    customLabel: source.customLabel ?? null,
    root: source.root ?? source.remoteRoot ?? null,
  }
}

export class SourceRegistry {
  #sources = new Map()

  // Generate a short, collision-resistant id (kept out of file paths' way).
  #nextId(type) {
    return `${type}-${crypto.randomBytes(6).toString('hex')}`
  }

  add(source, { type }) {
    const id = source.id || this.#nextId(type)
    source.id = id
    this.#sources.set(id, source)
    return source
  }

  get(id) {
    return this.#sources.get(id) ?? null
  }

  list() {
    return [...this.#sources.values()].map(summarizeSource)
  }

  async remove(id) {
    const source = this.#sources.get(id)
    if (!source) return false
    this.#sources.delete(id)
    try {
      await source.close?.()
    } catch {
      // Teardown is best-effort; never throw out of removal.
    }
    return true
  }

  async closeAll() {
    const ids = [...this.#sources.keys()]
    for (const id of ids) await this.remove(id)
  }
}
