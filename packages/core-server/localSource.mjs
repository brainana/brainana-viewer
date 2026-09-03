// LocalDataSource — a DataSource backed by a local filesystem root.
// Reuses the ported directory/import/manifest logic from the intact server.mjs; the only
// structural change is that everything hangs off an instance root + source-scoped URLs.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { contentTypeFor, parseRange } from './dataSource.mjs'
import { isWithin, isWithinReal, isWritableWithinReal, cleanRelative, resolveWithin } from './security.mjs'
import { writeStreamAtomic } from './export.mjs'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

export class LocalDataSource {
  type = 'local'

  // Canonical form of `root`, used only for containment checks. See the constructor.
  #realRoot

  constructor({ id, root, label, customLabel, manifest } = {}) {
    if (!root) throw new Error('LocalDataSource requires a root path')
    // The domain manifest provider ({ isSubjectDir, buildManifest, ... }) is injected so core
    // never imports a tool's domain. Required: a missing provider is always a bug, so fail loud.
    if (!manifest) throw new Error('LocalDataSource requires a manifest provider')
    const resolved = path.resolve(root)
    if (!exists(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`)
    }
    // `root` and `#realRoot` are deliberately two different things, because they answer two
    // different questions.
    //
    //   root      — the path the CALLER gave. It is user-facing: summarizeSource returns it, the
    //               sources dialog shows it, the report prints it. It must stay what was chosen.
    //   #realRoot — the same directory with symlinks resolved. Containment compares canonical
    //               against canonical, which is the whole point of isWithinReal.
    //
    // Collapsing them broke macOS, where /var is a symlink to /private/var: a source opened at
    // /var/folders/... reported itself as /private/var/folders/... . Resolved ONCE here, so each
    // request pays a single extra syscall rather than one per byte range.
    this.id = id
    this.root = resolved
    this.#realRoot = fs.realpathSync(resolved)
    this.label = label || path.basename(resolved) || resolved
    // User-editable display name, overriding `label` in pickers when set. Null = fall back to
    // `label`. Held in RAM only (see PATCH /api/sources/:id); lost on server restart.
    this.customLabel = customLabel ?? null
    this.manifest = manifest
  }

  // Absolute path → source-scoped /brainana-data/<id>/<encoded rel> URL (or null if outside).
  fileUrl(absPath) {
    if (!absPath) return null
    if (!isWithin(this.root, absPath)) return null
    const relative = path.relative(this.root, absPath)
    const encoded = relative.split(path.sep).map(encodeURIComponent).join('/')
    return `/brainana-data/${this.id}/${encoded}`
  }

  async listMonkeys() {
    if (!exists(this.root)) return []
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('sub-') && this.manifest.isSubjectDir(path.join(this.root, e.name)))
      .map((e) => ({ id: e.name, label: e.name.replace(/^sub-/, ''), relativePath: e.name }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }))
  }

  async buildManifest(subjectId) {
    const clean = cleanRelative(subjectId)
    const subjectDir = path.resolve(this.root, clean)
    if (!isWithin(this.root, subjectDir) || !this.manifest.isSubjectDir(subjectDir)) {
      throw Object.assign(new Error('Monkey not found'), { statusCode: 404 })
    }
    return this.manifest.buildManifest({ outputRoot: this.root, subjectDir, fileUrl: (p) => this.fileUrl(p) })
  }

  async listDirectories(rel = '') {
    const current = path.resolve(this.root, rel || '.')
    if (!isWithin(this.root, current) || !isWithinReal(this.#realRoot, current) || !exists(current) || !fs.statSync(current).isDirectory()) {
      throw new Error('Directory not found inside the configured root')
    }
    const relative = path.relative(this.root, current)
    const parent = relative ? path.dirname(relative) : null
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const abs = path.join(current, entry.name)
        return { name: entry.name, path: path.relative(this.root, abs), isMonkey: entry.name.startsWith('sub-') && this.manifest.isSubjectDir(abs) }
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    return {
      path: relative,
      displayPath: relative ? `/${relative.split(path.sep).join('/')}` : '/',
      parent: parent === '.' ? '' : parent,
      selectable: this.manifest.isSubjectDir(current),
      entries,
    }
  }

  async listImportFiles(rel = '', query = '') {
    const current = path.resolve(this.root, rel || '.')
    if (!isWithin(this.root, current) || !isWithinReal(this.#realRoot, current) || !exists(current) || !fs.statSync(current).isDirectory()) throw new Error('Directory not found inside the configured root')
    const relative = path.relative(this.root, current)
    const parent = relative ? path.dirname(relative) : null
    const needle = String(query || '').trim().toLowerCase()
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .filter((entry) => entry.isDirectory() || /\.nii(?:\.gz)?$/i.test(entry.name))
      .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
      .map((entry) => {
        const abs = path.join(current, entry.name)
        const isDirectory = entry.isDirectory()
        return { name: entry.name, path: path.relative(this.root, abs), isDirectory, size: isDirectory ? null : fs.statSync(abs).size, url: isDirectory ? null : this.fileUrl(abs) }
      })
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    return { path: relative, displayPath: relative ? `/${relative.split(path.sep).join('/')}` : '/', parent: parent === '.' ? '' : parent, entries }
  }

  #resolveFile(rel) {
    const clean = cleanRelative(rel)
    const abs = path.resolve(this.root, ...clean.split('/').filter(Boolean))
    // Lexical check first (cheap, rejects the obvious), then the real-path check that a symlink
    // cannot lie its way past.
    if (!isWithin(this.root, abs) || !isWithinReal(this.#realRoot, abs)) {
      throw Object.assign(new Error('File not found'), { statusCode: 404 })
    }
    return abs
  }

  // Open a file for serving, honoring an optional HTTP Range header.
  // Returns { total, contentType, start, end, partial, stream }.
  async openFile(rel, rangeHeader) {
    const abs = this.#resolveFile(rel)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      throw Object.assign(new Error('File not found'), { statusCode: 404 })
    }
    if (!stat.isFile()) throw Object.assign(new Error('File not found'), { statusCode: 404 })
    const total = stat.size
    const contentType = contentTypeFor(abs)
    const range = parseRange(rangeHeader, total)
    if (range) {
      return { total, contentType, start: range.start, end: range.end, partial: true, stream: fs.createReadStream(abs, { start: range.start, end: range.end }) }
    }
    return { total, contentType, start: 0, end: total - 1, partial: false, stream: fs.createReadStream(abs) }
  }

  // ---- server-side export ----

  // resolveWithin is lexical, so it stops `..` but not a symlinked directory pointing out of the
  // root. For a WRITE that matters more than for a read: it would create files outside the root
  // rather than merely serve them.
  #assertWritable(resolved) {
    if (!isWritableWithinReal(this.#realRoot, resolved)) {
      throw Object.assign(new Error('Path is outside the configured root'), { statusCode: 400 })
    }
  }

  async saveList(rel = '') {
    const { clean, resolved } = resolveWithin(this.root, rel)
    this.#assertWritable(resolved)
    if (!exists(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Folder not found')
    const entries = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.brainana-viewer-cache')
      .map((entry) => ({ name: entry.name, path: [clean, entry.name].filter(Boolean).join('/') }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    return { path: clean, entries }
  }

  async mkdir(rel) {
    const { clean, resolved } = resolveWithin(this.root, rel)
    if (!clean) throw new Error('A folder name is required')
    this.#assertWritable(resolved)
    await fsp.mkdir(resolved, { recursive: false })
    return { path: clean }
  }

  async saveFile(rel, readable, { overwrite = false } = {}) {
    const { clean, resolved } = resolveWithin(this.root, rel)
    if (!clean) throw new Error('A filename is required')
    this.#assertWritable(resolved)
    const result = await writeStreamAtomic(readable, resolved, overwrite)
    if (result.exists) return { exists: true, path: clean }
    return { exists: false, path: clean, bytes: result.bytes }
  }

  async close() {
    // Local sources hold no external resources.
  }
}
