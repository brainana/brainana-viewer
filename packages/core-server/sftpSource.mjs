// SftpDataSource — a DataSource backed by a remote workstation over ssh2/SFTP.
//
// It keeps the old adapter's shape (a lazily-populated local mirror + on-demand fetch)
// but is non-blocking (async ssh2 instead of spawnSync) and remote-OS-agnostic (SFTP
// subsystem only — no GNU find/stat), addressing finding R4. No code runs on the remote.
//
// Data primitives (listMonkeys / listDirectories / listImportFiles / openFile / save*)
// go straight over SFTP + the async cache. buildManifest materialises the subject into
// the local mirror (placeholders + real surface binaries), then runs the SAME injected
// manifest provider as LocalDataSource so the domain logic is written once and core never
// imports a tool's domain module.
import fs from 'node:fs'
import path from 'node:path'
import { contentTypeFor, parseRange } from './dataSource.mjs'
import { cleanRelative, isWithin } from './security.mjs'
import { RemoteFileCache } from './cache.mjs'
import { SftpClient } from './sftpClient.mjs'

// FreeSurfer surface/morphology files that must be present as REAL bytes locally so
// ensureDerivedAssets can parse them (everything else is served on demand).
const SURF_FILES = new Set([
  'lh.pial', 'rh.pial', 'lh.pial.surf.gii', 'rh.pial.surf.gii',
  'lh.white', 'rh.white', 'lh.white.surf.gii', 'rh.white.surf.gii',
  'lh.smoothwm', 'rh.smoothwm', 'lh.inflated', 'rh.inflated',
  'lh.sphere', 'rh.sphere', 'lh.curv', 'rh.curv', 'lh.sulc', 'rh.sulc',
  'lh.thickness', 'rh.thickness',
])

// Longitudinal change maps: the server PARSES these (MGH -> GIFTI), so a sparse placeholder has no
// bytes to read. The ROI-rate CSVs beside them are deliberately NOT here -- they are handed to the
// client as URLs and fetched on demand like any other data file.
const LONG_MAP_RE = /^(lh|rh)\.long\..+\.mgh$/i

// Recon subtrees that are pure noise, and expensive: a base template carries all four. Skipping
// them cuts the listing round-trips, which are what a slow link actually pays for.
const RECON_NOISE_DIRS = new Set(['tmp', 'trash', 'touch', 'bak'])

// Does the manifest provider need to READ this file's bytes, as opposed to merely see that it
// exists at its true size?
function needsRealBytes(name, size) {
  return SURF_FILES.has(name) || LONG_MAP_RE.test(name) || isReadableSidecar(name, size)
}

// Sidecars the manifest provider READS rather than merely lists (brainana writes a .json beside
// each output; buildManifest parses e.g. FullFOVPadding.status out of it). A sparse placeholder has
// no bytes to parse, so these are fetched for real — they are metadata, measured in hundreds of
// bytes. The cap is a guard against a pathological file, not a real expectation.
const SIDECAR_MAX_BYTES = 1024 * 1024
const isReadableSidecar = (name, size) => /\.json$/i.test(name) && size > 0 && size <= SIDECAR_MAX_BYTES

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

export class SftpDataSource {
  type = 'remote'

  constructor({ id, label, customLabel, connection, remoteRoot, cacheRoot, manifest } = {}) {
    if (!connection) throw new Error('SftpDataSource requires connection details')
    if (!remoteRoot) throw new Error('SftpDataSource requires a remoteRoot')
    if (!cacheRoot) throw new Error('SftpDataSource requires a cacheRoot')
    // Injected domain manifest provider (same contract as LocalDataSource). Required — a
    // missing provider is always a bug, so fail loud rather than silently list no subjects.
    if (!manifest) throw new Error('SftpDataSource requires a manifest provider')
    this.id = id
    this.manifest = manifest
    this.label = label || `${connection.username}@${connection.host}:${remoteRoot}`
    // User-editable display name overriding `label` in pickers when set (null = use `label`).
    this.customLabel = customLabel ?? null
    this.remoteRoot = String(remoteRoot).replace(/\/+$/, '') || '/'
    this.client = new SftpClient(connection)
    this.mirrorRoot = path.join(cacheRoot, 'mirror')
    this.cache = new RemoteFileCache({ cacheRoot, namespace: `${connection.host}\0${this.remoteRoot}` })
    this.placeholders = new Map() // mirrorAbs -> remote relative path
    this.#monkeyCache = null
    fs.mkdirSync(this.mirrorRoot, { recursive: true })
    this.#loadPlaceholders()
  }

  // ---- placeholder registry ----
  //
  // Placeholders are sparse stand-ins that make the mirror LOOK like the remote tree so the injected
  // manifest provider can glob it. They must be distinguishable from files materialised for real —
  // and the mirror outlives the process (it lives in the on-disk cache), so a RAM-only Map meant a
  // later session mistook every placeholder for a real file and served its empty bytes as data.
  // Persisting the set alongside the files it describes is what makes the mirror self-describing.
  //
  // Dot-prefixed so the directory listings (which skip dotfiles) and the manifest's filename
  // patterns never see it.
  #registryPath() {
    return path.join(this.mirrorRoot, '.brainana-placeholders.json')
  }

  #loadPlaceholders() {
    try {
      const listed = JSON.parse(fs.readFileSync(this.#registryPath(), 'utf8'))
      if (!Array.isArray(listed)) return
      for (const rel of listed) {
        try {
          this.placeholders.set(this.#mirrorAbs(rel), rel)
        } catch {
          // A path that no longer cleans (renamed remote, edited file) is simply dropped.
        }
      }
    } catch {
      // Absent or corrupt registry: start empty. Every placeholder is then re-registered by the
      // next #materialize, and until then openFile fetches from the remote — slow, never wrong.
    }
  }

  #savePlaceholders() {
    try {
      fs.writeFileSync(this.#registryPath(), JSON.stringify([...this.placeholders.values()]))
    } catch {
      // Best-effort: a read-only cache dir costs a re-fetch, not correctness.
    }
  }

  #monkeyCache

  async open() {
    await this.client.connect()
    return this
  }

  // ---- path helpers ----
  #remoteAbs(rel) {
    const clean = cleanRelative(rel)
    return clean ? `${this.remoteRoot}/${clean}` : this.remoteRoot
  }
  #mirrorAbs(rel) {
    const clean = cleanRelative(rel)
    const abs = path.resolve(this.mirrorRoot, ...clean.split('/').filter(Boolean))
    if (!isWithin(this.mirrorRoot, abs)) throw new Error('Mirror path outside cache')
    return abs
  }

  // Mirror-absolute path → source-scoped URL.
  fileUrl(absPath) {
    if (!absPath) return null
    if (!isWithin(this.mirrorRoot, absPath)) return null
    const relative = path.relative(this.mirrorRoot, absPath)
    const encoded = relative.split(path.sep).map(encodeURIComponent).join('/')
    return `/brainana-data/${this.id}/${encoded}`
  }

  // ---- discovery ----
  async listMonkeys() {
    if (this.#monkeyCache) return this.#monkeyCache
    const entries = await this.client.list(this.remoteRoot)
    const monkeys = []
    for (const entry of entries) {
      if (entry.type !== 'directory' || !entry.name.startsWith('sub-')) continue
      if (await this.#remoteIsSubject(entry.name)) {
        monkeys.push({ id: entry.name, label: entry.name.replace(/^sub-/, ''), relativePath: entry.name })
      }
    }
    monkeys.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }))
    this.#monkeyCache = monkeys
    return monkeys
  }

  // A remote sub-* is a subject if it has anat directly or under a ses-*.
  async #remoteIsSubject(subjectId) {
    if (await this.client.exists(`${this.#remoteAbs(subjectId)}/anat`)) return true
    const sub = await this.client.list(this.#remoteAbs(subjectId)).catch(() => [])
    for (const e of sub) {
      if (e.type === 'directory' && /^ses-/.test(e.name) && (await this.client.exists(`${this.#remoteAbs(subjectId)}/${e.name}/anat`))) return true
    }
    return false
  }

  async listDirectories(rel = '') {
    const clean = cleanRelative(rel)
    const entries = (await this.client.list(this.#remoteAbs(clean)))
      .filter((e) => e.type === 'directory' && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: [clean, e.name].filter(Boolean).join('/'), isMonkey: e.name.startsWith('sub-') }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const parent = clean ? path.posix.dirname(clean) : null
    return {
      path: clean,
      displayPath: clean ? `/${clean}` : '/',
      parent: parent === '.' ? '' : parent,
      selectable: clean ? path.posix.basename(clean).startsWith('sub-') && (await this.#remoteIsSubject(clean)) : false,
      entries,
    }
  }

  async listImportFiles(rel = '', query = '') {
    const clean = cleanRelative(rel)
    const needle = String(query || '').trim().toLowerCase()
    const entries = (await this.client.list(this.#remoteAbs(clean)))
      .filter((e) => !e.name.startsWith('.') && (e.type === 'directory' || /\.nii(?:\.gz)?$/i.test(e.name)))
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .map((e) => {
        const p = [clean, e.name].filter(Boolean).join('/')
        const isDirectory = e.type === 'directory'
        return { name: e.name, path: p, isDirectory, size: isDirectory ? null : e.size, url: isDirectory ? null : `/brainana-data/${this.id}/${p.split('/').map(encodeURIComponent).join('/')}` }
      })
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const parent = clean ? path.posix.dirname(clean) : null
    return { path: clean, displayPath: clean ? `/${clean}` : '/', parent: parent === '.' ? '' : parent, entries }
  }

  // ---- file serving ----
  async openFile(rel, rangeHeader) {
    const clean = cleanRelative(rel)
    const mirrorAbs = this.#mirrorAbs(clean)
    // Derived assets and materialised surface binaries live as REAL files in the mirror.
    if (exists(mirrorAbs) && !this.placeholders.has(mirrorAbs) && fs.statSync(mirrorAbs).isFile()) {
      const total = fs.statSync(mirrorAbs).size
      const range = parseRange(rangeHeader, total)
      const opts = range ? { start: range.start, end: range.end } : {}
      return {
        total,
        contentType: contentTypeFor(mirrorAbs),
        start: range ? range.start : 0,
        end: range ? range.end : total - 1,
        partial: Boolean(range),
        stream: fs.createReadStream(mirrorAbs, opts),
      }
    }
    // Otherwise fetch the remote file (cached by size+mtime) and serve the cached copy.
    const remoteAbs = this.#remoteAbs(clean)
    const info = await this.client.stat(remoteAbs)
    if (!info.isFile) throw Object.assign(new Error('File not found'), { statusCode: 404 })
    const cached = await this.cache.ensure(clean, info, (tmp) => this.client.fastGet(remoteAbs, tmp))
    const total = fs.statSync(cached).size
    const range = parseRange(rangeHeader, total)
    const opts = range ? { start: range.start, end: range.end } : {}
    return {
      total,
      contentType: contentTypeFor(remoteAbs),
      start: range ? range.start : 0,
      end: range ? range.end : total - 1,
      partial: Boolean(range),
      stream: fs.createReadStream(cached, opts),
    }
  }

  // ---- manifest via materialisation ----
  async #listRemoteRecursive(rel, maxDepth, skipDirs = new Set()) {
    const out = []
    const walk = async (currentRel, depth) => {
      if (depth < 0) return
      const list = await this.client.list(this.#remoteAbs(currentRel)).catch(() => [])
      for (const e of list) {
        if (e.name.startsWith('.')) continue
        if (e.type === 'directory' && skipDirs.has(e.name)) continue
        const childRel = [currentRel, e.name].filter(Boolean).join('/')
        out.push({ ...e, relativePath: childRel })
        if (e.type === 'directory') await walk(childRel, depth - 1)
      }
    }
    await walk(cleanRelative(rel), maxDepth)
    return out
  }

  // Pull a remote file into the mirror as REAL bytes (via the cache) and de-register any
  // placeholder standing in for it, so openFile serves the mirror copy directly.
  async #materializeFile(rel, size, mtimeMs) {
    const mirrorAbs = this.#mirrorAbs(rel)
    try {
      const cached = await this.cache.ensure(rel, { size, mtimeMs }, (tmp) => this.client.fastGet(this.#remoteAbs(rel), tmp))
      fs.mkdirSync(path.dirname(mirrorAbs), { recursive: true })
      fs.copyFileSync(cached, mirrorAbs)
      this.placeholders.delete(mirrorAbs) // now a real file
    } catch {
      // A sidecar that will not transfer must not fail the whole subject: fall back to a
      // placeholder, and the provider treats it as "status unknown" exactly as it does locally.
      this.#addPlaceholder(rel, 'file', size)
    }
  }

  #addPlaceholder(rel, type, size = 0) {
    const abs = this.#mirrorAbs(rel)
    if (type === 'directory') {
      fs.mkdirSync(abs, { recursive: true })
      return
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    // Never rewrite a file that was materialised for real (a surface binary read by
    // ensureDerivedAssets); only placeholders and not-yet-created files are sized.
    if (exists(abs) && !this.placeholders.has(abs)) return
    // Sized to the remote length: no bytes cross the wire and none are stored, but the manifest
    // provider's size-based rules work on a remote source exactly as they do on a local one.
    // Without this every zero-length placeholder looked like brainana's `.dummy` sentinel, so
    // the provider dropped the file — which is what hid the full-FOV conform on every SFTP source.
    //
    // Use writeFileSync(flag:'ax') + truncateSync instead of open('a') + ftruncateSync:
    // Windows does not allow ftruncate on an append-mode fd (EPERM, errno -4048); truncateSync
    // opens with the right flags internally and works on all platforms.
    if (!exists(abs)) fs.writeFileSync(abs, Buffer.alloc(0), { flag: 'ax' })
    fs.truncateSync(abs, size)
    this.placeholders.set(abs, rel)
  }

  async #materialize(subjectId, targetId = null) {
    const clean = cleanRelative(subjectId)
    // Mirror the subject subtree (anat + any ses-*/anat) as placeholders.
    const subjectEntries = await this.#listRemoteRecursive(clean, 5)
    this.#addPlaceholder(clean, 'directory')
    for (const e of subjectEntries) {
      if (e.type === 'directory') {
        this.#addPlaceholder(e.relativePath, 'directory')
        continue
      }
      if (isReadableSidecar(e.name, e.size)) {
        await this.#materializeFile(e.relativePath, e.size, e.mtimeMs)
        continue
      }
      this.#addPlaceholder(e.relativePath, 'file', e.size)
    }

    // Pass 2 -- the recon SKELETON. One listing of fastsurfer/, then directory placeholders for
    // every recon belonging to this subject. No file bytes and no recursion: this exists purely so
    // the manifest provider can SEE which reconstructions are present, which is what it enumerates
    // targets from. Before v3 this step hardcoded `fastsurfer/<sub>` and returned early when it
    // was absent, so a session-keyed recon tree yielded no surfaces at all on a remote source.
    //
    // The `surf`/`mri`/`stats`/`scripts` placeholders are load-bearing, not decoration:
    // resolveFsDir prefers a candidate containing surf/, and without them it falls through to its
    // "first directory that exists" branch and can pick the wrong recon -- which renders the wrong
    // brain with no error anywhere.
    const reconNames = (await this.client.list(this.#remoteAbs('fastsurfer')).catch(() => []))
      .filter((e) => e.type === 'directory' && (e.name === clean || e.name.startsWith(`${clean}_`)))
      .map((e) => e.name)
    if (!reconNames.length) {
      this.#savePlaceholders()
      return
    }
    this.#addPlaceholder('fastsurfer', 'directory')
    for (const name of reconNames) {
      this.#addPlaceholder(`fastsurfer/${name}`, 'directory')
      for (const sub of ['surf', 'mri', 'stats', 'scripts', 'label']) {
        if (await this.client.exists(this.#remoteAbs(`fastsurfer/${name}/${sub}`))) {
          this.#addPlaceholder(`fastsurfer/${name}/${sub}`, 'directory')
        }
      }
    }

    // Pass 3 -- ask the DOMAIN which recon trees this target actually needs, and fetch only those.
    // A longitudinal subject has up to five recons; mirroring all of them would be a serious
    // regression on a slow link, and at most two are ever needed at once.
    const subjectDir = this.#mirrorAbs(clean)
    let needed = []
    try {
      const targets = this.manifest.listViewTargets({ outputRoot: this.mirrorRoot, subjectDir })
      const chosen = targets.find((t) => t.id === targetId) ?? targets.find((t) => t.isDefault) ?? targets[0]
      needed = [chosen?.fsDir, chosen?.baseDir]
        .filter(Boolean)
        .map((abs) => path.relative(this.mirrorRoot, abs).split(path.sep).join('/'))
    } catch {
      // No provider support (or an unreadable skeleton): fall back to the subject-keyed recon,
      // which is what this did before targets existed.
      needed = [`fastsurfer/${clean}`]
    }
    for (const fsRel of [...new Set(needed)]) {
      if (!(await this.client.exists(this.#remoteAbs(fsRel)))) continue
      const fsEntries = await this.#listRemoteRecursive(fsRel, 3, RECON_NOISE_DIRS)
      this.#addPlaceholder(fsRel, 'directory')
      for (const e of fsEntries) {
        if (e.type === 'directory') {
          this.#addPlaceholder(e.relativePath, 'directory')
          continue
        }
        if (needsRealBytes(e.name, e.size)) {
          await this.#materializeFile(e.relativePath, e.size, e.mtimeMs)
        } else {
          this.#addPlaceholder(e.relativePath, 'file', e.size)
        }
      }
    }
    // One write per materialise, not per file.
    this.#savePlaceholders()
  }

  async buildManifest(subjectId, { target = null } = {}) {
    const clean = cleanRelative(subjectId)
    if (!(await this.#remoteIsSubject(clean))) throw Object.assign(new Error('Monkey not found'), { statusCode: 404 })
    await this.#materialize(clean, target)
    const subjectDir = this.#mirrorAbs(clean)
    if (!this.manifest.isSubjectDir(subjectDir) || !this.manifest.resolveAnatDir(subjectDir)) throw Object.assign(new Error('Monkey not found'), { statusCode: 404 })
    return this.manifest.buildManifest({ outputRoot: this.mirrorRoot, subjectDir, fileUrl: (p) => this.fileUrl(p), targetId: target })
  }

  // ---- server-side export (over SFTP) ----
  async saveList(rel = '') {
    const clean = cleanRelative(rel)
    const entries = (await this.client.list(this.#remoteAbs(clean)))
      .filter((e) => e.type === 'directory' && e.name !== '.brainana-viewer-cache')
      .map((e) => ({ name: e.name, path: [clean, e.name].filter(Boolean).join('/') }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    return { path: clean, entries }
  }

  async mkdir(rel) {
    const clean = cleanRelative(rel)
    if (!clean) throw new Error('A folder name is required')
    await this.client.mkdir(this.#remoteAbs(clean))
    return { path: clean }
  }

  async saveFile(rel, readable, { overwrite = false } = {}) {
    const clean = cleanRelative(rel)
    if (!clean) throw new Error('A filename is required')
    const result = await this.client.uploadStream(readable, this.#remoteAbs(clean), { overwrite })
    if (result.exists) return { exists: true, path: clean }
    return { exists: false, path: clean, bytes: result.bytes }
  }

  async close() {
    await this.client.close()
  }
}
