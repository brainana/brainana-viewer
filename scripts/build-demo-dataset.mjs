#!/usr/bin/env node
// Rebuild datasets/demo_viewer from a full brainana output tree.
//
// The demo is a COMMITTED, minimal real instance of the data contract — every file the Viewer
// reads for one cross-sectional subject, and nothing else. It lives in git, so every byte is
// permanent: the trim is what keeps the repo from carrying a 1.4 GB pipeline run.
//
// Until this script existed the tree had been hand-trimmed once and the rules survived only as
// prose, which meant the next person had to re-derive them from a directory listing. The three
// rules below ARE the selection; docs/data-contract.md points here rather than restating them.
//
// Usage:
//   node scripts/build-demo-dataset.mjs --from <brainana-output-root>
//   node scripts/build-demo-dataset.mjs --from <root> --subject sub-example   # if several exist
//   node scripts/build-demo-dataset.mjs --from <root> --dry-run
//
// Re-running against an already-built tree is a no-op (`git status` stays clean) — that property
// is what proves the script still encodes what is committed, so the verification step relies on it.
import { readdirSync, existsSync, statSync, mkdirSync, copyFileSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'datasets', 'demo_viewer')

// Hand-written, describes the dataset for someone who sparse-checks it out. Not derived from any
// pipeline output, so the rebuild must never clobber it.
const PRESERVE = new Set(['README.md'])

// Rule 3: the surface geometry + morphometry the Viewer reads. The extensionless FreeSurfer
// binaries drive the 3D panes; the .surf.gii pair is what NiiVue loads directly. `smoothwm` and
// `sphere` are kept because they are selectable surfaces, not intermediates.
const SURF_STEMS = ['curv', 'inflated', 'pial', 'smoothwm', 'sphere', 'sulc', 'thickness', 'white']
const SURF_GII = ['pial.surf.gii', 'white.surf.gii']
// Rule 2: the two selectable base volumes. norm.mgz is the default underlay when a subject's
// anat/ carries no preprocessed T1w, which is exactly this trimmed tree's shape.
const MRI_FILES = ['T1.mgz', 'norm.mgz']

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const dryRun = process.argv.includes('--dry-run')
const from = arg('--from')
if (!from) {
  console.error('build-demo-dataset: missing --from <brainana-output-root>')
  console.error('  e.g. node scripts/build-demo-dataset.mjs --from /data/brainana_out/preprocessed')
  process.exit(1)
}
const src = path.resolve(from)

const dirsIn = (p) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [])

// --- resolve the subject and session ----------------------------------------------------------
// Discovered from the tree rather than hard-coded, so this works for a future demo subject. A
// source with several subjects must name one: silently picking the first would make the committed
// dataset depend on readdir order.
if (!existsSync(path.join(src, 'fastsurfer'))) {
  console.error(`build-demo-dataset: ${src} has no fastsurfer/ — is this a brainana output root?`)
  process.exit(1)
}
const subjects = dirsIn(src).filter((n) => n.startsWith('sub-'))
const wanted = arg('--subject')
if (wanted && !subjects.includes(wanted)) {
  console.error(`build-demo-dataset: subject "${wanted}" not found. Available: ${subjects.join(', ') || '(none)'}`)
  process.exit(1)
}
if (!wanted && subjects.length !== 1) {
  console.error(`build-demo-dataset: ${subjects.length} subjects found — pass --subject. Available: ${subjects.join(', ') || '(none)'}`)
  process.exit(1)
}
const subject = wanted ?? subjects[0]

// The atlas directory can sit under a session or directly under the subject (a flat, pre-session
// tree). Take whichever holds atlas_space-fsnative; that directory IS the surface-overlay source.
const ATLAS_DIR = 'atlas_space-fsnative'
const candidates = [
  ...dirsIn(path.join(src, subject)).filter((n) => n.startsWith('ses-')).map((ses) => ({ ses, dir: path.join(src, subject, ses, 'anat', ATLAS_DIR) })),
  { ses: null, dir: path.join(src, subject, 'anat', ATLAS_DIR) },
].filter((c) => existsSync(c.dir))
if (!candidates.length) {
  console.error(`build-demo-dataset: no ${ATLAS_DIR}/ under ${subject} — nothing to build a demo from.`)
  process.exit(1)
}
if (candidates.length > 1) {
  console.error(`build-demo-dataset: ${subject} has ${ATLAS_DIR}/ in several places (${candidates.map((c) => c.ses ?? 'flat').join(', ')}).`)
  console.error('  The demo is deliberately ONE reconstruction; trim the source or extend this script.')
  process.exit(1)
}
const { ses, dir: atlasSrc } = candidates[0]

// brainana names the recon dir after the session only when a subject has several with anatomy.
const fsDir = [ses && `${subject}_${ses}`, subject].filter(Boolean).map((n) => path.join(src, 'fastsurfer', n)).find(existsSync)
if (!fsDir) {
  console.error(`build-demo-dataset: no fastsurfer recon for ${subject}${ses ? ` / ${ses}` : ''}`)
  process.exit(1)
}

// --- build the copy list ----------------------------------------------------------------------
const anatRel = path.join(subject, ...(ses ? [ses] : []), 'anat', ATLAS_DIR)
const fsRel = path.join('fastsurfer', path.basename(fsDir))
const jobs = []
const want = (absFrom, rel) => {
  if (!existsSync(absFrom)) return
  jobs.push({ from: absFrom, rel })
}

// Rule 1 — the whole atlas directory: label volumes, their .func.gii surface projections, the .tsv
// LUTs, and the .json/.bib/.md sidecars the report reads for provenance and citations.
for (const name of readdirSync(atlasSrc, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()) {
  want(path.join(atlasSrc, name), path.join(anatRel, name))
}
// Rule 2 — selectable base volumes.
for (const name of MRI_FILES) want(path.join(fsDir, 'mri', name), path.join(fsRel, 'mri', name))
// Rule 3 — surfaces and morphometry.
for (const hemi of ['lh', 'rh']) {
  for (const stem of SURF_STEMS) want(path.join(fsDir, 'surf', `${hemi}.${stem}`), path.join(fsRel, 'surf', `${hemi}.${stem}`))
  for (const stem of SURF_GII) want(path.join(fsDir, 'surf', `${hemi}.${stem}`), path.join(fsRel, 'surf', `${hemi}.${stem}`))
}

const missing = []
for (const name of MRI_FILES) if (!existsSync(path.join(fsDir, 'mri', name))) missing.push(`mri/${name}`)
for (const hemi of ['lh', 'rh']) for (const stem of [...SURF_STEMS, ...SURF_GII]) {
  if (!existsSync(path.join(fsDir, 'surf', `${hemi}.${stem}`))) missing.push(`surf/${hemi}.${stem}`)
}

const bytes = jobs.reduce((n, j) => n + statSync(j.from).size, 0)
console.log(`build-demo-dataset: ${subject}${ses ? ` / ${ses}` : ''} from ${src}`)
console.log(`  recon   ${path.basename(fsDir)}`)
console.log(`  files   ${jobs.length}  (${(bytes / 1048576).toFixed(1)} MB)`)
if (missing.length) console.log(`  MISSING ${missing.length}: ${missing.join(', ')}`)

// The version the Viewer will report for this dataset. Two tests pin it (see DEMO_BRAINANA_VERSION
// in tests/report_provenance_test.mjs and tests/report_sidecar_e2e_test.mjs) — print it so a swap
// that moves the pipeline version is impossible to miss.
const d99 = jobs.find((j) => /^atlas-D99_.*\.json$/.test(path.basename(j.rel)))
if (d99) {
  try {
    const gen = JSON.parse(readFileSync(d99.from, 'utf8')).GeneratedBy
    const v = (Array.isArray(gen) ? gen : [gen]).find((g) => g?.Name === 'brainana')?.Version
    if (v) console.log(`  brainana ${v}   <- tests pin this as DEMO_BRAINANA_VERSION`)
  } catch {
    // Provenance is a nicety here; a malformed sidecar must not stop the rebuild.
  }
}

if (dryRun) {
  console.log('  (dry run — nothing written)')
  process.exit(0)
}

// --- write ------------------------------------------------------------------------------------
// Replace rather than merge: a file that the rules no longer select must disappear, or the tree
// slowly accumulates leftovers from older pipeline versions that nothing would ever notice.
if (existsSync(dest)) {
  for (const entry of readdirSync(dest)) {
    if (PRESERVE.has(entry)) continue
    rmSync(path.join(dest, entry), { recursive: true, force: true })
  }
}
for (const job of jobs) {
  const out = path.join(dest, job.rel)
  mkdirSync(path.dirname(out), { recursive: true })
  copyFileSync(job.from, out)
}
console.log(`  wrote   datasets/demo_viewer (${PRESERVE.size} preserved: ${[...PRESERVE].join(', ')})`)
