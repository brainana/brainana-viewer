// Viewer-domain enumeration of a subject's VIEW TARGETS ("scans").
//
// brainana's `anat.synthesis_level` decides how many reconstructions a subject has and where they
// live. Before v3.0.0 there was exactly one per subject, so the manifest builder could resolve "the"
// anat dir and be done. There are now three shapes:
//
//   subject              sub-X/anat/            + fastsurfer/sub-X/
//   session              sub-X/ses-Y/anat/      + fastsurfer/sub-X_ses-Y/
//   session_longitudinal  ... the above, PLUS   + fastsurfer/sub-X_base/
//                        sub-X/anat/ (space-base) + fastsurfer/sub-X_ses-Y_long/
//
// A ViewTarget is the unit the viewer actually renders: one reconstruction, with the anat directory,
// atlas directory and recon directory that belong together. Everything downstream reads a target
// rather than re-deriving paths, so the pairing rules live here and only here.
//
// INVARIANT — enumeration uses NAMES, SIZES and DIRECTORY STRUCTURE ONLY, never file contents.
// That is what lets the same code run against a sparse SFTP mirror, where most files are
// zero-byte placeholders sized to the remote length (see core-server/sftpSource.mjs).
import fs from 'node:fs'
import path from 'node:path'

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
function filesIn(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch {
    return []
  }
}
function dirsIn(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

// Base-volume candidates, in preference order. The first five are the pre-v3 chain and are matched
// for every stream; the `space-base` entry is APPENDED (never prepended) so no existing tree
// changes behaviour, and is only offered to the base/long streams whose anat dir is the
// subject-level one holding brainana's `space-base` products.
const ANATOMY_PATTERNS = [
  /space-T1w_desc-preproc_T1w_brain\.nii\.gz$/i,
  /space-T1w_desc-preproc_T1w\.nii\.gz$/i,
  /desc-preproc_T1w\.nii\.gz$/i,
  /desc-preproc_brain\.nii\.gz$/i,
  /space-scanner_T1w\.nii\.gz$/i,
]
const BASE_ANATOMY_PATTERN = /_space-base_desc-brain_T1w\.nii\.gz$/i

// Which atlas space directory a stream's VOLUME overlays come from, in priority order.
// `cross` is exactly the pre-v3 list. base/long prefer `atlas_space-base`; their anat dir is the
// subject-level one, whose `atlas_space-fsnative` is the BASE mesh's projection (same affine as
// fastsurfer/sub-X_base/mri/norm.mgz), NOT any session's.
export const ATLAS_SPACE_ORDER = {
  cross: ['fsnative', 'T1w', 'scanner'],
  base: ['base', 'fsnative', 'T1w', 'scanner'],
  long: ['base', 'fsnative', 'T1w', 'scanner'],
}

// The base-volume patterns that apply to a stream, in preference order.
export function anatomyPatterns(stream = 'cross') {
  return stream === 'cross' ? ANATOMY_PATTERNS : [...ANATOMY_PATTERNS, BASE_ANATOMY_PATTERN]
}

export function pickAnatomy(anatFileNames, stream = 'cross') {
  const patterns = anatomyPatterns(stream)
  for (const pattern of patterns) {
    const found = anatFileNames.find((name) => pattern.test(name))
    if (found) return found
  }
  return null
}

// List immediate ses-* subdirectories, sorted naturally.
export function sessionDirs(subjectDir) {
  return dirsIn(subjectDir)
    .filter((name) => /^ses-/.test(name))
    .sort(naturalSort)
}

function hasAtlasVolume(dir) {
  return filesIn(dir).some((name) => /^atlas-[^_]+_space-.*\.nii\.gz$/i.test(name))
}
function hasAtlasSpaceDir(anatDir) {
  return dirsIn(anatDir).some((name) => /^atlas_space-/.test(name) && hasAtlasVolume(path.join(anatDir, name)))
}

// Is there enough here to be worth offering as a scan? Deliberately generous — three independent
// ways to qualify — so this can never drop a subject that rendered before v3. It exists to exclude
// the real case of a session whose anat/ holds only T2w derivatives and has no reconstruction
// (sub-032309m/ses-002 in the dev-test dataset), which would otherwise be an empty scan entry.
//
// `reconDir` must be a recon that BELONGS to the thing being tested. For a session that means a
// session-specific tree, never resolveFsDir's fallback to the subject-level `fastsurfer/<sub>`:
// in a subject-level (synthesis_level "subject") tree every session resolves to that one recon, so
// the fallback would make every session look viewable and mint an empty target per session.
function looksViewable(anatDir, reconDir, stream) {
  return (
    pickAnatomy(filesIn(anatDir), stream) != null ||
    hasAtlasSpaceDir(anatDir) ||
    (reconDir != null && isDir(path.join(reconDir, 'surf')))
  )
}

// The recon tree named for THIS session, or null. Unlike resolveFsDir this never falls back to the
// subject-level tree, so it can be used as evidence that a session is its own reconstruction.
function sessionSpecificFsDir(outputRoot, subjectId, session) {
  const base = path.join(outputRoot, 'fastsurfer')
  for (const dir of [path.join(base, `${subjectId}_${session}`), path.join(base, subjectId, session)]) {
    if (isDir(dir)) return dir
  }
  return null
}

// Resolve the FreeSurfer/fastsurfer directory for a cross-sectional reconstruction.
//
// Session-keyed is tried FIRST: brainana names the recon `sub-X_ses-Y` when the subject has several
// sessions with anatomy, but collapses it to `sub-X` when only one does (steps/anatomical.py), so
// both spellings are legitimate for a session-layout subject. Trying `sub-X` first — as this did
// before v3 — picks the wrong tree whenever a stale subject-level recon sits beside a session one.
export function resolveFsDir(outputRoot, subjectId, session) {
  const base = path.join(outputRoot, 'fastsurfer')
  const candidates = (
    session
      ? [path.join(base, `${subjectId}_${session}`), path.join(base, subjectId, session), path.join(base, subjectId)]
      : [path.join(base, subjectId)]
  ).filter(Boolean)
  const withSurf = candidates.find((c) => isDir(path.join(c, 'surf')))
  if (withSurf) return withSurf
  return candidates.find((c) => isDir(c)) ?? candidates[0]
}

export function resolveBaseDir(outputRoot, subjectId) {
  const dir = path.join(outputRoot, 'fastsurfer', `${subjectId}_base`)
  return isDir(dir) ? dir : null
}
export function resolveLongDir(outputRoot, subjectId, session) {
  const dir = path.join(outputRoot, 'fastsurfer', `${subjectId}_${session}_long`)
  return isDir(dir) ? dir : null
}

// The timepoints brainana actually fitted, as recorded by the base build. Names only — the file is
// a newline-separated list of cross-sectional recon ids. Used to notice a `_long` tree whose
// session directory carries no anat of its own.
function baseTimepointSessions(baseDir, subjectId) {
  if (!baseDir) return []
  let text = ''
  try {
    text = fs.readFileSync(path.join(baseDir, 'scripts', 'base-tps'), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const match = line.trim().match(new RegExp(`^${subjectId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}_(ses-[A-Za-z0-9]+)$`))
    if (match) out.push(match[1])
  }
  return out
}

export function summarizeTarget(target) {
  return {
    id: target.id,
    subjectId: target.subjectId,
    session: target.session,
    stream: target.stream,
    label: target.label,
    isDefault: target.isDefault,
  }
}

// Enumerate every reconstruction of one subject. Order: cross-sectional (natural session order),
// then the base template, then the base-seeded timepoints.
//
// The DEFAULT is the first cross-sectional target, never the base: a base template is an unbiased
// average of the subject's sessions, not a scan of the animal, so landing there by default would
// make the viewer's opening view a synthetic image. It also keeps every pre-v3 tree resolving
// exactly as it did before.
export function listViewTargets({ outputRoot, subjectDir }) {
  const subjectId = path.basename(subjectDir)
  const flatAnat = path.join(subjectDir, 'anat')
  const baseDir = resolveBaseDir(outputRoot, subjectId)
  const targets = []

  // --- cross-sectional ---------------------------------------------------
  // A flat sub-X/anat is the subject-level (or pre-v3) layout -- UNLESS this subject has a base
  // template, in which case the flat anat holds only the `space-base` products and the real
  // cross-sectional anat lives under the sessions.
  if (isDir(flatAnat) && !baseDir) {
    const fsDir = resolveFsDir(outputRoot, subjectId, null)
    if (looksViewable(flatAnat, fsDir, 'cross')) {
      targets.push({
        id: subjectId,
        subjectId,
        session: null,
        stream: 'cross',
        label: 'subject',
        anatDir: flatAnat,
        atlasAnatDir: flatAnat,
        fsDir,
        baseDir: null,
      })
    }
  }
  const sessions = sessionDirs(subjectDir)
  for (const session of sessions) {
    const anatDir = path.join(subjectDir, session, 'anat')
    if (!isDir(anatDir)) continue
    const fsDir = resolveFsDir(outputRoot, subjectId, session)
    if (!looksViewable(anatDir, sessionSpecificFsDir(outputRoot, subjectId, session), 'cross')) continue
    targets.push({
      id: `${subjectId}_${session}`,
      subjectId,
      session,
      stream: 'cross',
      label: session,
      anatDir,
      atlasAnatDir: anatDir,
      fsDir,
      baseDir: null,
    })
  }

  // --- longitudinal ------------------------------------------------------
  // Base and base-seeded targets share ONE anat dir: the subject-level one. It carries the
  // `space-base` volumes, `atlas_space-base/`, and an `atlas_space-fsnative/` that is the BASE
  // mesh's projection. A session's own atlas dirs belong to its cross-sectional mesh, which has a
  // different vertex count, and are deliberately not reachable from here.
  if (baseDir && isDir(flatAnat)) {
    targets.push({
      id: `${subjectId}_base`,
      subjectId,
      session: null,
      stream: 'base',
      label: 'base template',
      anatDir: flatAnat,
      atlasAnatDir: flatAnat,
      fsDir: baseDir,
      baseDir,
    })
    const longSessions = [...new Set([...sessions, ...baseTimepointSessions(baseDir, subjectId)])].sort(naturalSort)
    for (const session of longSessions) {
      const fsDir = resolveLongDir(outputRoot, subjectId, session)
      if (!fsDir) continue
      targets.push({
        id: `${subjectId}_${session}_long`,
        subjectId,
        session,
        stream: 'long',
        // The underlay is this timepoint's own intensities resampled into base space -- the point
        // of a long target is to see THAT session, on the shared mesh.
        label: `${session} (long)`,
        anatDir: flatAnat,
        atlasAnatDir: flatAnat,
        fsDir,
        baseDir,
      })
    }
  }

  const defaultTarget = targets.find((t) => t.stream === 'cross') ?? targets[0]
  for (const t of targets) t.isDefault = t === defaultTarget
  return targets
}

// Resolve a client-supplied target id. The id is matched against the ENUMERATED set and never
// parsed into a path: every directory a target carries was produced by readdirSync here, so no
// client string can reach the filesystem. An unknown id yields null and the caller 404s.
export function resolveViewTarget({ outputRoot, subjectDir, targetId }) {
  const targets = listViewTargets({ outputRoot, subjectDir })
  if (!targets.length) return { targets, target: null }
  const target = targetId ? targets.find((t) => t.id === targetId) ?? null : targets.find((t) => t.isDefault) ?? targets[0]
  return { targets, target }
}
