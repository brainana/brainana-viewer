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
import { ensureDerivedAssets, giftiDim0, surfaceVertexCount } from './freesurfer.mjs'
import {
  ATLAS_SPACE_ORDER,
  anatomyPatterns,
  listViewTargets,
  resolveViewTarget,
  sessionDirs,
  summarizeTarget,
} from './viewTargets.mjs'

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

// brainana records the run's synthesis level only in the effective config it writes beside the
// outputs. Read as a display string ONLY -- target enumeration is driven entirely by the tree,
// because this file is absent from SFTP mirrors and from partially-copied trees, and gating
// behaviour on it would add a way to be wrong about a tree that is right there on disk.
// A targeted line match rather than a YAML parse: the repo has no YAML dependency and this is one
// scalar under a known key.
const SYNTHESIS_LEVELS = new Set(['subject', 'session', 'session_longitudinal'])
function readSynthesisLevel(outputRoot) {
  try {
    const text = fs.readFileSync(path.join(outputRoot, 'nextflow_reports', 'config.yaml'), 'utf8')
    const match = text.match(/^\s{2}synthesis_level:\s*["']?([A-Za-z_]+)["']?\s*$/m)
    return match && SYNTHESIS_LEVELS.has(match[1]) ? match[1] : null
  } catch {
    return null
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// The longitudinal block for a base/long target. Everything is discovered by globbing the base
// recon.
//
// NOTE: long.change-stats.json also carries `vertex_outputs` and `roi_tables` maps -- do NOT use
// them. Their values are container-relative ("work/sub-X_base/surf/...") and unresolvable from the
// host. The files are found on disk instead.
function buildLongitudinal({ target, derived, fileUrl }) {
  const baseDir = target.baseDir
  if (!baseDir) return null
  // Change maps are offered on the BASE target only. They are one fit across the subject's
  // timepoints, so showing them while a single timepoint is on screen invites reading them as that
  // timepoint's rate, which is not a thing. A _long target still gets the timepoint/time-source
  // context below, just no maps.
  const offerMaps = target.stream === 'base'
  const stats = readJson(path.join(baseDir, 'stats', 'long.change-stats.json')) ?? {}
  const agreementFile = path.join(baseDir, 'scripts', 'base_segmentation_agreement.json')
  const roiFile = (hemi) => path.join(baseDir, 'stats', `${hemi}.long.roi-rates.csv`)
  const changeMaps = []
  for (const key of offerMaps ? Object.keys(derived.longMaps ?? {}) : []) {
    if (!key.startsWith('lh.')) continue
    const suffix = key.slice(3)
    const right = derived.longMaps[`rh.${suffix}`]
    if (!right) continue // both hemispheres or nothing: a half-pair becomes a 404ing UI option
    const [measure, stat] = suffix.split('-')
    changeMaps.push({
      key: suffix,
      measure,
      stat,
      // rate and spc are signed and want a diverging colormap centred on zero; avg is the plain
      // temporal mean of the measure.
      signed: stat === 'rate' || stat === 'spc',
      left: fileUrl(derived.longMaps[key]),
      right: fileUrl(right),
      range: derived.longRanges?.[key] ?? null,
    })
  }
  changeMaps.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' }))
  return {
    stream: target.stream,
    baseSubjectId: stats.base_subject_id ?? `${target.subjectId}_base`,
    timepoints: Array.isArray(stats.timepoints) ? stats.timepoints : [],
    times: stats.times && typeof stats.times === 'object' ? stats.times : {},
    // Load-bearing for the UI: when this is not a real time column the fitted rate is per scan,
    // not per unit time, and a rate is not interpretable without knowing which.
    timeSource: typeof stats.time_source === 'string' ? stats.time_source : null,
    skipped: stats.skipped && typeof stats.skipped === 'object' ? stats.skipped : {},
    ordinalTimeFallback: Array.isArray(stats.ordinal_time_fallback) ? stats.ordinal_time_fallback : [],
    // Change maps are fitted on the base mesh and published only in the base recon; a _long tree
    // shares the mesh but carries none of its own.
    changeMaps,
    roiRates: {
      left: offerMaps && exists(roiFile('lh')) ? fileUrl(roiFile('lh')) : null,
      right: offerMaps && exists(roiFile('rh')) ? fileUrl(roiFile('rh')) : null,
    },
    agreement: exists(agreementFile) ? fileUrl(agreementFile) : null,
  }
}

// Build the per-subject manifest of /brainana-data URLs.
//   outputRoot — the data-source root
//   subjectDir — absolute path to the sub-* directory
//   fileUrl    — (absPath) => URL string | null, injected by the data source so URLs
//                are source-scoped; returns null for paths outside the root.
export function buildManifest({ outputRoot, subjectDir, fileUrl, targetId = null }) {
  const subjectId = path.basename(subjectDir)
  const { targets, target } = resolveViewTarget({ outputRoot, subjectDir, targetId })
  if (!target) {
    // An id that names no reconstruction of this subject. Resolving it to the default instead
    // would silently show a different scan than the one asked for.
    const reason = targetId ? `Unknown scan '${targetId}' for ${subjectId}` : 'Subject has no viewable reconstruction'
    throw Object.assign(new Error(reason), { statusCode: 404 })
  }
  const session = target.session
  const anat = target.anatDir
  const anatFiles = filesIn(anat)
  const warnings = []
  // Pick ONE atlas space directory, preferring the space that matches the display base. The default
  // slice base is the FreeSurfer norm.mgz (fsnative), so an fsnative-space atlas overlay is
  // voxel-aligned to it and needs no resample; T1w/scanner are ordered fallbacks for older runs.
  // ALL volume-side assets (label volume, .tsv LUT, retino/somato functional volumes) come from
  // this single chosen dir — no per-file cross-space fallback. (Surface .func.gii overlays are
  // fsnative-only by nature and are resolved separately below.)
  // The atlas directories all hang off the TARGET's atlas anat dir: the session's own anat for a
  // cross-sectional scan, the subject-level anat for base/long (whose atlas_space-fsnative is the
  // BASE mesh's projection, not any session's). Priority is per stream -- base/long prefer
  // atlas_space-base, which is the frame their volumes and surfaces are in.
  const atlasSpaceDir = (space) => path.join(target.atlasAnatDir, `atlas_space-${space}`)
  const fsnativeAtlas = atlasSpaceDir('fsnative')
  const hasAtlasVolume = (dir) => filesIn(dir).some((f) => /^atlas-[^_]+_space-.*\.nii\.gz$/i.test(path.basename(f)))
  const spaceOrder = ATLAS_SPACE_ORDER[target.stream] ?? ATLAS_SPACE_ORDER.cross
  const atlasDir = spaceOrder.map(atlasSpaceDir).find(hasAtlasVolume) ?? atlasSpaceDir('T1w')
  const atlasFiles = filesIn(atlasDir)
  const anatomy = pick(anatFiles, anatomyPatterns(target.stream))
  const fullFovNii = pickFullFov(anatFiles)
  const fsDir = target.fsDir
  const surfDir = path.join(fsDir, 'surf')
  // Cache per RECONSTRUCTION, not per subject: two sessions of one subject have different meshes.
  // Derived from fsDir so a pre-v3 tree (fastsurfer/sub-X) keeps its existing cache directory
  // name -- which is what stops the committed datasets/demo_viewer cache from being orphaned.
  const fsRel = path.relative(path.join(outputRoot, 'fastsurfer'), fsDir)
  const cacheKey = fsRel && !fsRel.startsWith('..') ? fsRel.split(path.sep).join('_') : subjectId
  const derived = ensureDerivedAssets(outputRoot, fsDir, { cacheKey, baseDir: target.baseDir })

  // Selectable base volumes: the preprocessed T1w plus the FreeSurfer mri/*.mgz volumes.
  const mriDir = path.join(fsDir, 'mri')
  const volumes = []
  // The base/long streams' anat dir holds the base template, not a preprocessed scan of the
  // animal -- label it for what it is so it is not mistaken for this timepoint's own image.
  const anatomyLabel = /_space-base_desc-brain_T1w\.nii\.gz$/i.test(anatomy ?? '') ? 'T1w (base template)' : 'T1w (preproc)'
  if (anatomy) volumes.push({ key: 'anat', label: anatomyLabel, url: fileUrl(anatomy) })
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
  // Vertex counts of this target's own mesh, read from a fixed-size header. A subject's base and
  // cross-sectional reconstructions have DIFFERENT vertex counts (11597 vs 11725 on the dev-test
  // subject), so an overlay from the wrong reconstruction is not a subtle misalignment -- it is an
  // array of the wrong length. There is deliberately no cross-directory fallback anywhere in this
  // function; this guard catches the remaining case of a stale overlay beside a re-run recon.
  const meshVertices = { lh: surfaceVertexCount(surfDir, 'lh'), rh: surfaceVertexCount(surfDir, 'rh') }
  const vertexMismatch = (file, hemi) => {
    const expected = meshVertices[hemi]
    if (expected == null) return false
    const actual = giftiDim0(file)
    return actual != null && actual !== expected
  }
  const surfacePairFor = (base) => {
    const l = pick(fsnativeFiles, [new RegExp(`${base}_space-fsnative_hemi-L.*\\.func\\.gii$`, 'i')])
    const r = pick(fsnativeFiles, [new RegExp(`${base}_space-fsnative_hemi-R.*\\.func\\.gii$`, 'i')])
    if (!l || !r) return null
    if (vertexMismatch(l, 'lh') || vertexMismatch(r, 'rh')) {
      warnings.push(`${base}: surface overlay vertex count does not match this reconstruction's mesh; overlay hidden`)
      return null
    }
    return { left: fileUrl(l), right: fileUrl(r) }
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
    // Kept for every existing consumer (the report header, the dashboard's dataset block). For a
    // pre-v3 tree this is the same value it always was.
    session,
    // Which reconstruction this manifest describes, and the full roster for this subject so the
    // scan picker can be populated without a second request.
    scan: summarizeTarget(target),
    scans: targets.map(summarizeTarget),
    synthesisLevel: readSynthesisLevel(outputRoot),
    warnings,
    longitudinal: buildLongitudinal({ target, derived, fileUrl }),
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
export const viewerManifestProvider = { isSubjectDir, resolveAnatDir, buildManifest, listViewTargets }
