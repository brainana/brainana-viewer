// Viewer-domain manifest builder + template discovery.
// Ported in behavior from server.mjs:369-503, with two deliberate changes:
//   1. `fileUrl` is INJECTED by the caller (the data source) instead of being a module
//      global, so manifest URLs can be source-scoped (/brainana-data/<sourceId>/<rel>).
//   2. The anat directory and the fastsurfer directory are resolved FLEXIBLY: a subject
//      may store anat directly (sub-*/anat) or under a BIDS session (sub-*/ses-*/anat),
//      and fastsurfer output may be keyed by subject or subject+session.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDerivedAssets } from './freesurfer.mjs'

// Bundled fallback atlas LUTs shipped with the app (apps/viewer/server/atlas_info/).
// These apply when a subject's own atlas dir has no per-atlas .tsv sidecar. The content is
// inlined as a data: URL so no extra server routes or security-boundary exceptions are needed.
// Results are memoized — bundled files never change at runtime and manifests rebuild per subject.
const BUNDLED_ATLAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'atlas_info')
const _bundledCache = new Map()
function bundledAtlasDataUrl(name) {
  if (_bundledCache.has(name)) return _bundledCache.get(name)
  let url = null
  try {
    const content = fs.readFileSync(path.join(BUNDLED_ATLAS_DIR, `atlas-${name}.tsv`), 'utf8')
    url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content)
  } catch {
    // No bundled LUT for this atlas name — labels stay null.
  }
  _bundledCache.set(name, url)
  return url
}

// Atlas display order: ARM<n> first (numeric), then D99, MacBNA, CortHierarchy, FuncNetwork,
// then everything else alphabetically. Both the right-panel picker and the bottom info panel
// consume manifest.atlases in arrival order, so this single sort controls both displays.
const ATLAS_TIER = ['d99', 'macbna', 'corthierarchy', 'funcnetwork']
function atlasTier(name) {
  const lower = name.toLowerCase()
  const armMatch = lower.match(/^arm(\d+)$/)
  if (armMatch) return { tier: 0, sub: Number(armMatch[1]) }
  const idx = ATLAS_TIER.indexOf(lower)
  return idx >= 0 ? { tier: idx + 1, sub: 0 } : { tier: ATLAS_TIER.length + 1, sub: 0 }
}

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
function filesIn(dir) {
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() || e.isSymbolicLink())
    .map((e) => path.join(dir, e.name))
}
function pick(files, patterns) {
  for (const pattern of patterns) {
    const found = files.find((f) => pattern.test(path.basename(f)))
    if (found) return found
  }
  return null
}

// The uncropped conform: same world frame and 1 mm lattice as the processed T1w, just a larger box,
// so it can be swapped in as the underlay with no resample. Absent for pre-2.1 runs and whenever
// anat.conform is disabled; the workflow also substitutes empty `.dummy` sentinels when the optional
// output is missing, hence the size guard (the .nii.gz pattern already rejects the .dummy name).
function pickFullFov(anatFiles) {
  const found = pick(anatFiles, [/_space-T1w_desc-conformFullFOV_T1w\.nii\.gz$/i])
  if (!found) return null
  try {
    if (fs.statSync(found).size === 0) return null
  } catch {
    return null
  }
  return found
}

// brainana records how far the box was expanded in the sidecar. 'no_expansion_needed' and 'fallback'
// mean the image is identical to the cropped one, which the UI explains rather than looking broken.
// Informational only: an unreadable sidecar yields null and the volume is still offered.
function fullFovStatus(niiPath) {
  try {
    const sidecar = niiPath.replace(/\.nii\.gz$/i, '.json')
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
    const status = parsed?.FullFOVPadding?.status
    return typeof status === 'string' ? status : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Flexible layout resolution (flat sub-*/anat OR sub-*/ses-*/anat)
// ---------------------------------------------------------------------------

// List immediate ses-* subdirectories, sorted numerically.
function sessionDirs(subjectDir) {
  if (!isDir(subjectDir)) return []
  return fs
    .readdirSync(subjectDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^ses-/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

// Resolve the anat directory for a subject. Returns { anatDir, session } or null.
// Prefers a flat sub-*/anat; otherwise the first ses-*/anat that exists.
export function resolveAnatDir(subjectDir) {
  const flat = path.join(subjectDir, 'anat')
  if (isDir(flat)) return { anatDir: flat, session: null }
  for (const ses of sessionDirs(subjectDir)) {
    const anat = path.join(subjectDir, ses, 'anat')
    if (isDir(anat)) return { anatDir: anat, session: ses }
  }
  return null
}

// True when a directory looks like a viewable subject (has anat, flat or session-nested).
export function isSubjectDir(subjectDir) {
  return path.basename(subjectDir).startsWith('sub-') && resolveAnatDir(subjectDir) != null
}

// Resolve the FreeSurfer/fastsurfer directory for a subject, tolerant of layout:
// fastsurfer/<sub>, fastsurfer/<sub>_<ses>, or fastsurfer/<sub>/<ses>. Prefers one
// that actually contains a surf/ directory.
function resolveFsDir(outputRoot, subjectId, session) {
  const base = path.join(outputRoot, 'fastsurfer')
  const candidates = [
    path.join(base, subjectId),
    session ? path.join(base, `${subjectId}_${session}`) : null,
    session ? path.join(base, subjectId, session) : null,
  ].filter(Boolean)
  const withSurf = candidates.find((c) => isDir(path.join(c, 'surf')))
  if (withSurf) return withSurf
  return candidates.find((c) => isDir(c)) ?? candidates[0]
}

// ---------------------------------------------------------------------------
// Template transform discovery (ported from server.mjs:369-421)
// ---------------------------------------------------------------------------

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function discoverTemplateTransforms(anatFiles) {
  const usable = anatFiles.filter((file) => /_mode-image_xfm\.nii(?:\.gz)?$/i.test(path.basename(file)))
  const byName = new Map()
  const pattern = /(?:^|_)from-([^_]+)_to-([^_]+)_mode-image_xfm\.nii(?:\.gz)?$/i
  for (const file of usable) {
    const match = path.basename(file).match(pattern)
    if (!match) continue
    const source = match[1]
    const destination = match[2]
    let template = null
    let direction = null
    if (destination.toLowerCase() === 't1w' && !['t1w', 'scanner'].includes(source.toLowerCase())) {
      template = source
      direction = 'importToT1w'
    } else if (source.toLowerCase() === 't1w' && !['t1w', 'scanner'].includes(destination.toLowerCase())) {
      template = destination
      direction = 'exportFromT1w'
    }
    if (!template) continue
    const key = template.toLowerCase()
    if (!byName.has(key)) byName.set(key, { name: template, importToT1w: null, exportFromT1w: null })
    const entry = byName.get(key)
    if (!entry[direction] || path.basename(file).localeCompare(path.basename(entry[direction]), undefined, { numeric: true }) < 0) entry[direction] = file
  }
  return byName
}
function findTemplateReference(anatFiles, template) {
  const escaped = escapeRegex(template)
  const candidates = anatFiles.filter((file) => {
    const name = path.basename(file)
    if (!new RegExp(`(?:^|_)space-${escaped}(?:_|$)`, 'i').test(name)) return false
    if (!/T1w\.nii(?:\.gz)?$/i.test(name)) return false
    if (/(?:^|_)(?:mask|dseg|probseg|atlas|label|xfm)(?:_|\.)/i.test(name)) return false
    return true
  })
  candidates.sort((a, b) => {
    const score = (f) => (/_desc-preproc_T1w\.nii(?:\.gz)?$/i.test(path.basename(f)) ? 0 : 1)
    return score(a) - score(b) || path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: 'base' })
  })
  return candidates[0] ?? null
}
function buildTemplateManifest(anatFiles, fileUrl) {
  const discovered = discoverTemplateTransforms(anatFiles)
  const result = {}
  for (const entry of [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))) {
    const reference = findTemplateReference(anatFiles, entry.name)
    result[entry.name] = {
      import: entry.importToT1w ? { enabled: true, transform: fileUrl(entry.importToT1w) } : { enabled: false, reason: `No from-${entry.name}_to-T1w NIfTI transform found` },
      export:
        entry.exportFromT1w && reference
          ? { enabled: true, transform: fileUrl(entry.exportFromT1w), reference: fileUrl(reference) }
          : { enabled: false, reason: !entry.exportFromT1w ? `No from-T1w_to-${entry.name} NIfTI transform found` : `No space-${entry.name} anatomical T1w reference found` },
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

// Build the per-subject manifest of /brainana-data URLs.
//   outputRoot — the data-source root
//   subjectDir — absolute path to the sub-* directory
//   fileUrl    — (absPath) => URL string | null, injected by the data source so URLs
//                are source-scoped; returns null for paths outside the root.
export function buildManifest({ outputRoot, subjectDir, fileUrl }) {
  const subjectId = path.basename(subjectDir)
  const resolved = resolveAnatDir(subjectDir)
  if (!resolved) throw new Error('Subject has no anat directory')
  const { anatDir: anat, session } = resolved
  const anatFiles = filesIn(anat)
  // Pick ONE atlas space directory, preferring the space that matches the display base. The default
  // slice base is the FreeSurfer norm.mgz (fsnative), so an fsnative-space atlas overlay is
  // voxel-aligned to it and needs no resample; T1w/scanner are ordered fallbacks for older runs.
  // ALL volume-side assets (label volume, .tsv LUT, retino/somato functional volumes) come from
  // this single chosen dir — no per-file cross-space fallback. (Surface .func.gii overlays are
  // fsnative-only by nature and are resolved separately below.)
  const fsnativeAtlas = path.join(anat, 'atlas_space-fsnative')
  const t1Atlas = path.join(anat, 'atlas_space-T1w')
  const scannerAtlas = path.join(anat, 'atlas_space-scanner')
  const hasAtlasVolume = (dir) => filesIn(dir).some((f) => /^atlas-[^_]+_space-.*\.nii\.gz$/i.test(path.basename(f)))
  const atlasDir = [fsnativeAtlas, t1Atlas, scannerAtlas].find(hasAtlasVolume) ?? t1Atlas
  const atlasFiles = filesIn(atlasDir)
  const anatomy = pick(anatFiles, [
    /space-T1w_desc-preproc_T1w_brain\.nii\.gz$/i,
    /space-T1w_desc-preproc_T1w\.nii\.gz$/i,
    /desc-preproc_T1w\.nii\.gz$/i,
    /desc-preproc_brain\.nii\.gz$/i,
    /space-scanner_T1w\.nii\.gz$/i,
  ])
  const fullFovNii = pickFullFov(anatFiles)
  const fsDir = resolveFsDir(outputRoot, subjectId, session)
  const surfDir = path.join(fsDir, 'surf')
  const derived = ensureDerivedAssets(outputRoot, subjectId, fsDir)

  // Selectable base volumes: the preprocessed T1w plus the FreeSurfer mri/*.mgz volumes.
  const mriDir = path.join(fsDir, 'mri')
  const volumes = []
  if (anatomy) volumes.push({ key: 'anat', label: 'T1w (preproc)', url: fileUrl(anatomy) })
  if (isDir(mriDir)) {
    for (const name of fs
      .readdirSync(mriDir)
      .filter((n) => /\.mgz$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) {
      volumes.push({ key: `mri/${name}`, label: name.replace(/\.mgz$/i, ''), url: fileUrl(path.join(mriDir, name)) })
    }
  }
  // Precomputed surface (fsnative) maps: per-hemisphere .func.gii projected by the pipeline —
  // no client-side volume→surface projection needed. Surface data only ever exists in fsnative
  // space, so these are always read from atlas_space-fsnative regardless of which space the atlas
  // VOLUME was chosen from above; null (no surface layer) when that dir is absent.
  const fsnativeFiles = filesIn(fsnativeAtlas)
  const surfacePairFor = (base) => {
    const l = pick(fsnativeFiles, [new RegExp(`${base}_space-fsnative_hemi-L.*\\.func\\.gii$`, 'i')])
    const r = pick(fsnativeFiles, [new RegExp(`${base}_space-fsnative_hemi-R.*\\.func\\.gii$`, 'i')])
    return l && r ? { left: fileUrl(l), right: fileUrl(r) } : null
  }

  // Each atlas: its label volume + the .tsv LUT sidecar (may be absent) + the precomputed surface
  // pair. Volume and LUT both come from the single chosen `atlasDir` (whatever space won above);
  // the surface pair is always fsnative. Discovery is generic: every `atlas-<name>_space-*` label
  // volume in that dir is picked up (no per-atlas special-casing), EXCEPT retinotopy/somatotopy
  // which are functional maps handled below.
  const FUNCTIONAL_ATLASES = new Set(['retinotopy', 'somatotopy'])
  const atlasEntryFor = (name) => {
    const base = `atlas-${name}`
    const volFile = pick(atlasFiles, [new RegExp(`^${escapeRegex(base)}_space-.*\\.nii\\.gz$`, 'i')])
    if (!volFile) return null
    const localLut = pick(atlasFiles, [new RegExp(`^${escapeRegex(base)}\\.tsv$`, 'i')])
    // Prefer the local sidecar; fall back to the bundled app LUT (a data: URL, no extra route).
    const labelsUrl = localLut ? fileUrl(localLut) : bundledAtlasDataUrl(name)
    return { name, label: name, volume: fileUrl(volFile), labels: labelsUrl, surface: surfacePairFor(base) }
  }
  // Collect distinct atlas names from the label volumes present on disk.
  const atlasNames = []
  const seenAtlas = new Set()
  for (const f of atlasFiles) {
    const m = path.basename(f).match(/^atlas-([^_]+)_space-[^_]*.*\.nii\.gz$/i)
    if (!m) continue
    const name = m[1]
    if (FUNCTIONAL_ATLASES.has(name.toLowerCase()) || seenAtlas.has(name)) continue
    seenAtlas.add(name)
    atlasNames.push(name)
  }
  atlasNames.sort((a, b) => {
    const la = atlasTier(a)
    const lb = atlasTier(b)
    if (la.tier !== lb.tier) return la.tier - lb.tier
    if (la.sub !== lb.sub) return la.sub - lb.sub
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  })
  const atlasList = atlasNames.map(atlasEntryFor).filter(Boolean)
  // Functional maps come from the same chosen atlasDir (matching whatever space the atlas volumes
  // use), so the retino/somato overlay is voxel-aligned to the base just like the atlases.
  const retino = pick(atlasFiles, [/^atlas-retinotopy_space-.*\.nii(?:\.gz)?$/i])
  const somato = pick(atlasFiles, [/^atlas-somatotopy_space-.*\.nii(?:\.gz)?$/i])
  const scannerReference = pick(anatFiles, [/space-scanner_T1w\.nii\.gz$/i])
  const scannerToT1w = pick(anatFiles, [/from-scanner_to-T1w_mode-image_xfm\.mat$/i])
  const templates = buildTemplateManifest(anatFiles, fileUrl)
  const surfacePair = (name, preferGii = false) => {
    const l = preferGii && exists(path.join(surfDir, `lh.${name}.surf.gii`)) ? path.join(surfDir, `lh.${name}.surf.gii`) : path.join(surfDir, `lh.${name}`)
    const r = preferGii && exists(path.join(surfDir, `rh.${name}.surf.gii`)) ? path.join(surfDir, `rh.${name}.surf.gii`) : path.join(surfDir, `rh.${name}`)
    return exists(l) && exists(r) ? { left: fileUrl(l), right: fileUrl(r) } : null
  }
  // Derived (server-generated) display surfaces: only emit when BOTH hemisphere files are
  // actually present on disk, so a stale/failed cache entry never becomes a phantom dropdown
  // option that 404s on load.
  const derivedPair = (kind) => {
    const l = derived.displaySurfaces?.[`lh.${kind}`]
    const r = derived.displaySurfaces?.[`rh.${kind}`]
    return l && r && exists(l) && exists(r) ? { left: fileUrl(l), right: fileUrl(r) } : null
  }
  return {
    id: subjectId,
    label: subjectId.replace(/^sub-/, ''),
    session,
    relativePath: path.relative(outputRoot, subjectDir),
    anatomy: fileUrl(anatomy),
    volumes,
    // Kept out of `volumes` on purpose: that list answers "which processed volume", while the fov
    // switch answers "which extent". One state, one control.
    fullFov: fullFovNii
      ? { url: fileUrl(fullFovNii), label: 'T1w (full FOV)', status: fullFovStatus(fullFovNii) }
      : null,
    // atlasList entries are already { name, label, volume, labels, surface } objects —
    // emit them directly; do NOT re-wrap in fileUrl (that would pass an object to path.relative).
    atlases: atlasList,
    function: {
      retinotopy: retino ? { combined: fileUrl(retino), frames: { polar: 0, polarF: 1, eccentricity: 2, eccentricityF: 3 }, surface: surfacePairFor('atlas-retinotopy') } : null,
      somatotopy: somato ? { combined: fileUrl(somato), frames: { phase: 0, fstat: 1 }, surface: surfacePairFor('atlas-somatotopy') } : null,
    },
    transforms: {
      scanner: scannerReference && scannerToT1w ? { reference: fileUrl(scannerReference), outputToT1wAffine: fileUrl(scannerToT1w) } : null,
      templates,
      nmt2sym: templates.NMT2Sym?.export?.enabled
        ? {
            reference: templates.NMT2Sym.export.reference,
            outputToT1wWarp: templates.NMT2Sym.export.transform,
            inputToT1wWarp: templates.NMT2Sym.import?.enabled ? templates.NMT2Sym.import.transform : null,
          }
        : null,
    },
    surfaces: {
      pial: surfacePair('pial', true),
      smoothwm: surfacePair('smoothwm'),
      inflated: derivedPair('inflated'),
      sphere: derivedPair('sphere'),
      white: surfacePair('white', true),
    },
    morphology: {
      raw: {
        curvature: { left: fileUrl(path.join(surfDir, 'lh.curv')), right: fileUrl(path.join(surfDir, 'rh.curv')) },
        sulc: { left: fileUrl(path.join(surfDir, 'lh.sulc')), right: fileUrl(path.join(surfDir, 'rh.sulc')) },
        thickness: { left: fileUrl(path.join(surfDir, 'lh.thickness')), right: fileUrl(path.join(surfDir, 'rh.thickness')) },
      },
      shape: {
        curvature: { left: fileUrl(derived.shapes?.['lh.curv']), right: fileUrl(derived.shapes?.['rh.curv']) },
        sulc: { left: fileUrl(derived.shapes?.['lh.sulc']), right: fileUrl(derived.shapes?.['rh.sulc']) },
        thickness: { left: fileUrl(derived.shapes?.['lh.thickness']), right: fileUrl(derived.shapes?.['rh.thickness']) },
      },
    },
    capabilities: {
      volume: Boolean(anatomy),
      surfaces: Boolean(surfacePair('pial', true)),
      atlases: atlasList.length > 0,
      retinotopy: Boolean(retino),
      somatotopy: Boolean(somato),
    },
  }
}

// The Viewer-domain manifest provider — the strategy a core DataSource is given so it can
// discover subjects and build manifests without core importing this (brainana-specific) module.
// A future Aligner/Editor supplies its own provider with the same shape.
export const viewerManifestProvider = { isSubjectDir, resolveAnatDir, buildManifest }
