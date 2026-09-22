// Unit tests for the report document builder (apps/viewer/src/report/html.ts).
// The report must be self-contained, must escape everything it interpolates, and must never
// print a raw NaN where a measurement is missing.
import assert from 'node:assert/strict'
import { buildReportHtml, esc, fmt, jsonPayload, formatTimestamp } from '../apps/viewer/src/report/html.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

const readout = (over = {}) => ({
  mm: [3.25, -42.5, 18],
  voxel: [128, 96, 110],
  hemisphere: 'left',
  vertex: { index: 45231, hemi: 0, distanceMm: 0.8123 },
  atlases: [
    { name: 'D99', label: 'D99', continuous: false, value: null, id: 7, region: 'area V1', shortName: 'V1', unknown: false },
    { name: 'MacBNA', label: 'MacBNA', continuous: false, value: null, id: 304, region: null, shortName: null, unknown: true },
    { name: 'CortHierarchy', label: 'CortHierarchy', continuous: true, value: 0.4213, id: null, region: null, shortName: null, unknown: false },
  ],
  morphology: { curvature: -0.21, sulc: 3.4, thickness: 2.05 },
  retinotopy: {
    polar: 1.2, polarF: 9.1, eccentricity: 4.3, eccentricityF: 8.2,
    visualX: 1.55, visualY: 4.01, validVoxels: 21, possibleVoxels: 27, spreadDeg: 0.83, neighborhood: 1,
  },
  somatotopy: null,
  overlay: { target: 'atlas', label: 'D99', value: '7' },
  ...over,
})

const header = {
  nDim: 3, dims: [256, 256, 256], frames: 1, resolution: [0.5, 0.5, 0.5], spatialUnit: 'mm', timeUnit: 's',
  datatype: 'UINT8', datatypeCode: 2, bitpix: 8, intent: 'NONE', intentCode: 0,
  sclSlope: 1, sclInter: 0, calMin: 0, calMax: 255, qformCode: 1, sformCode: 1,
  affine: [[-0.5, 0, 0, 64], [0, 0.5, 0, -64], [0, 0, 0.5, -32], [0, 0, 0, 1]],
  littleEndian: true, description: 'FreeSurfer norm',
}

const data = () => ({
  generatedAt: '2026-09-01T14:32:05.000Z',
  app: { name: 'brainana-viewer', version: '1.0.0', buildId: 'v1.0.0-6-g15ff2af', userAgent: 'test' },
  dataset: {
    sourceId: 'src1', sourceLabel: 'demo_viewer', sourceType: 'local', sourceRoot: '/data/demo_viewer',
    subjectId: 'sub-example', subjectLabel: 'example', session: 'ses-001', relativePath: 'sub-example',
    scan: { id: 'sub-example_ses-001', stream: 'cross', session: 'ses-001', label: 'ses-001' },
    synthesisLevel: 'session',
  },
  longitudinal: null,
  pipelineVersions: ['1.3.0'],
  files: [
    { role: 'base volume', path: 'fastsurfer/sub-example/mri/norm.mgz', url: '/brainana-data/src1/x', brainanaVersion: null, generatedBy: [], header, mesh: null },
    {
      role: 'atlas overlay: D99', path: 'sub-example/ses-001/anat/atlas_space-fsnative/atlas-D99.nii.gz', url: '/brainana-data/src1/y',
      brainanaVersion: '1.3.0', generatedBy: [{ name: 'brainana', version: '1.3.0' }], header, mesh: null,
    },
    { role: 'surface (left)', path: 'fastsurfer/sub-example/surf/lh.pial', url: '/brainana-data/src1/z', brainanaVersion: null, generatedBy: [], header: null, mesh: { vertices: 143562, faces: 287120 } },
  ],
  view: {
    layout: 'column', surfaceKind: 'inflated',
    panes: { volume: true, surface: true }, hemispheres: { left: true, right: false },
    baseVolume: { key: 'mri/norm.mgz', label: 'norm', window: { min: 0, max: 255 }, clip: { lo: null, hi: null } },
    atlas: { name: 'D99', colormap: 'labels', opacity: 0.7, continuous: false, displayRange: null, clip: { lo: null, hi: null }, hiddenRois: 2 },
    morphology: { metric: 'curvature', curvatureStyle: 'binary', colormap: null, range: null, clip: null },
    function: { kind: 'retinotopy', mode: 'Polar angle', threshold: 3.5, opacity: 1, brightness: 1, colormap: 'brainana_polar', displayRange: null, clip: { lo: null, hi: null } },
    longitudinal: null,
    camera: { azimuth: 90, elevation: 15, scale: 1.4 },
    markerMode: 'nearest vertex',
  },
  current: { readout: readout(), shots: { slices: PNG, surface: PNG, note: null } },
  bookmarks: [
    { id: 'bm-1', label: null, addedAt: '2026-09-01T14:30:00.000Z', activeOverlay: 'atlas · D99', readout: readout(), shots: { slices: PNG, surface: null, note: 'surface pane was hidden' } },
    { id: 'bm-2', label: 'V1 border', addedAt: '2026-09-01T14:31:00.000Z', activeOverlay: 'none', readout: readout({ retinotopy: null, somatotopy: { bodyPosition: 63.5, fStat: 8.2 } }), shots: null },
  ],
  notes: ['The surface pane was hidden, so no surface screenshot was taken.'],
})

const html = buildReportHtml(data())

// --- self-containment: the whole point of a report is that it still opens years later, offline ---
assert.equal(/(?:src|href)\s*=\s*["']https?:/i.test(html), false, 'no remote src/href')
assert.equal(/(?:src|href)\s*=\s*["']\/\//.test(html), false, 'no protocol-relative reference')
assert.equal(/@import/i.test(html), false, 'no CSS @import')
assert.equal(/url\(\s*["']?https?:/i.test(html), false, 'no remote CSS url()')
assert.equal(/<link\b/i.test(html), false, 'no external stylesheet link')
assert.ok(html.includes('<style>'), 'the stylesheet is inlined')
assert.ok(html.includes(`src="${PNG}"`), 'images are embedded as data URLs')
ok('the document references nothing over the network')

// The only script is the inert JSON payload — a report must not execute anything.
const scripts = html.match(/<script\b[^>]*>/gi) ?? []
assert.equal(scripts.length, 1, 'exactly one script element')
assert.match(scripts[0], /type="application\/json"/, 'and it is the inert JSON payload')
// Click-to-enlarge is a :target lightbox precisely so this stays true.
assert.ok(html.includes('.shot:target'), 'enlargement is CSS-only')
assert.ok(html.includes('href="#shot-current-slices"'), 'a thumbnail links to its own figure')
assert.ok(html.includes('class="shot-close" href="#location-current"'), 'closing returns to the enclosing card')
// The previous assertions checked only that the anchors EXIST, which is why an un-dismissable
// lightbox shipped: the image sat above the close backdrop and its href pointed at the figure that
// was already :target, so clicking it re-targeted the same element and closed nothing. The image and
// caption must therefore be out of hit-testing while enlarged, so a click reaches the backdrop.
const targetRules = [...html.matchAll(/\.shot:target[^{]*\{[^}]*\}/g)].map((m) => m[0])
const noHits = targetRules.find((rule) => rule.includes('.shot-open') && rule.includes('pointer-events'))
assert.ok(noHits, 'the enlarged image does not swallow the dismissing click')
assert.match(noHits, /pointer-events:\s*none/)
assert.ok(noHits.includes('figcaption'), 'nor does the caption')
// And the backdrop that receives the click is the one that navigates away from the target.
assert.ok(targetRules.some((rule) => rule.includes('.shot-close') && /inset:\s*0/.test(rule)), 'the close backdrop covers the overlay')
assert.ok(html.includes('.shot:target .shot-close::after'), 'a visible close affordance is rendered')
ok('an enlarged screenshot can be dismissed by clicking it')
assert.equal((html.match(new RegExp(PNG.slice(-16), 'g')) ?? []).length, 3, 'each image is embedded exactly once')
// One preview size for every shot: the .shots-small modifier became dead once all cards started
// rendering through the same path, and a dead modifier is a size that silently stops applying.
assert.equal(html.includes('shots-small'), false, 'no size modifier — every preview renders at one size')
assert.match(html.match(/\.shots img \{[^}]*\}/s)[0], /height:\s*280px/, 'previews render at the enlarged size')
assert.equal(/\son\w+\s*=/i.test(html), false, 'no inline event handler attributes')
ok('the document carries no executable script and enlarges images with CSS alone')

// --- structure ---
assert.ok(html.startsWith('<!doctype html>'))
assert.ok(html.includes('<title>Brainana Viewer report — example</title>'))
for (const id of ['files', 'view', 'locations']) {
  assert.ok(html.includes(`id="${id}"`), `section ${id} is present`)
}
assert.equal(html.includes('id="screenshots"'), false, 'screenshots are folded into the sections they illustrate')
assert.equal(html.includes('id="bookmarks"'), false, 'bookmarks are merged into the locations section')
ok('every section is present with a stable id')

// Order: files → selected locations → view state. View state is reference material and must not sit
// between the reader and the readouts.
const order = ['id="files"', 'id="locations"', 'id="view"'].map((needle) => html.indexOf(needle))
assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections appear in reading order, view state last')
ok('sections appear in reading order')

// --- the crosshair and the bookmarks are one list, current first ---
const locations = html.slice(html.indexOf('id="locations"'), html.indexOf('id="view"'))
assert.equal((locations.match(/<h2>/g) ?? []).length, 1, 'one section, not two')
assert.ok(locations.includes('>Selected location</h2>'))
const cards = [...locations.matchAll(/<article class="point" id="location-([^"]+)"/g)].map((m) => m[1])
assert.deepEqual(cards, ['current', '1', '2'], 'the current location leads, then each bookmark in order')
assert.ok(locations.includes('<h3>Current location</h3>'))
assert.ok(locations.includes('<h3>Bookmarked #1</h3>'), 'an unnamed point is named by its ordinal')
assert.ok(locations.includes('<h3>Bookmarked #2 — V1 border</h3>'), 'a renamed point keeps its ordinal too')
const rowOrdinals = [...locations.slice(0, locations.indexOf('<article')).matchAll(/<tr><td>([^<]*)<\/td>/g)].map((m) => m[1])
assert.deepEqual(rowOrdinals, ['current', '1', '2'], 'the summary table is led by the current location')
ok('the current location and the bookmarks form one list, current first')

// Within each card the images lead the numbers they illustrate.
for (const key of ['current', '1']) {
  const card = locations.slice(locations.indexOf(`id="location-${key}"`))
  assert.ok(card.indexOf(`shot-${key}-slices`) < card.indexOf('>Location<'), `shots precede the readout for ${key}`)
}
ok('screenshots lead each location card')

// The capture time was noise; the overlay that was active is what explains the readouts.
assert.equal(/added \d{4}-/.test(html), false, 'no "added <timestamp>" stamp')
assert.ok(html.includes('overlay at the time: atlas · D99'), 'the overlay context is kept')
assert.equal(locations.slice(0, locations.indexOf('id="location-1"')).includes('overlay at the time'), false,
  'the live crosshair has no "at the time" — its overlay is the view state')
ok('the added-timestamp is gone while the overlay context stays')

// --- provenance and header detail reach the page ---
assert.ok(html.includes('>brainana pipeline</dt><dd>1.3.0</dd>'), 'the pipeline version is reported once, in the header')
assert.equal(html.includes('no pipeline sidecar'), false, 'no per-file provenance line')
// Counted in the rendered body only — the JSON payload legitimately keeps per-file provenance.
const body = html.slice(0, html.indexOf('<script'))
assert.equal((body.match(/1\.3\.0/g) ?? []).length, 1, 'and it is not repeated on every file card')
assert.ok(html.includes('256 × 256 × 256'), 'dims')
assert.ok(html.includes('0.5³ mm'), 'resolution')
assert.ok(html.includes('UINT8'), 'datatype name')
assert.ok(html.includes('143,562'), 'surface vertex count')
ok('the pipeline version is stated once and header/mesh detail is rendered')

// Shape and voxel size are always visible; everything else is behind a native disclosure.
const card = html.slice(html.indexOf('id="files"'), html.indexOf('id="current"'))
assert.ok(card.indexOf('<dt>dims</dt>') < card.indexOf('<details'), 'dims is visible, not inside the disclosure')
assert.ok(card.indexOf('<dt>resolution</dt>') < card.indexOf('<details'), 'resolution is visible too')
assert.ok(card.includes('<summary>more</summary>'), 'the rest is behind a "more" disclosure')
assert.ok(card.indexOf('<details') < card.indexOf('<dt>n_dim</dt>'), 'n_dim is inside the disclosure')
ok('file cards show dims and resolution, with the rest behind a disclosure')

// The affine used to carry its own small-caps label style — a third label treatment sitting beside
// plain dt labels, which reads as a different font. It is now a row of the same list.
assert.ok(html.includes('<dt>affine (voxel → world)</dt><dd><table class="matrix">'), 'the affine is a dt/dd row like its peers')
assert.equal(html.includes('affine-label'), false, 'its bespoke label style is gone')
assert.equal(/\.affine \{/.test(html), false, 'and so is its wrapper rule')
ok('the affine label is an ordinary dt, matching the labels beside it')

// Fields nobody reads off a page are no longer DRAWN — checked against the rendered body, since
// they legitimately survive in the JSON payload (asserted below).
for (const dropped of ['scl_slope', 'cal_min', 'qform', 'time unit', 'byte order', 'little-endian', '<dt>intent</dt>']) {
  assert.equal(body.includes(dropped), false, `${dropped} is not rendered`)
}
ok('the unread NIfTI fields are no longer rendered')


// --- readouts ---
const viewSection = html.slice(html.indexOf('id="view"'))
assert.ok(viewSection.includes('<summary>show view state</summary>'), 'view state is collapsed by default')
assert.ok(viewSection.indexOf('<details') < viewSection.indexOf('>layout</dt>'), 'its rows sit inside the disclosure')
ok('view state is collapsed at the bottom of the document')

// --- readout layering: a subsection title must not render like the dt labels beneath it ---
assert.ok(/h4 \{[^}]*color: var\(--accent\)/.test(html), 'titles take the accent colour, dt labels stay muted')
assert.ok(/dt \{[^}]*color: var\(--muted\)/.test(html))
assert.ok(html.includes('<h4>Location</h4><div class="readout-body">'), 'subsection content is wrapped for indenting')
assert.ok(/\.readout-body \{[^}]*padding-left/.test(html), 'and is indented behind a rule')
ok('subsection titles are distinguished by colour and their content is indented')

// --- readouts ---
assert.ok(html.includes('area V1'), 'a resolved region name')
assert.ok(html.includes('(unlabeled)'), 'an id with no LUT entry is called out')
assert.ok(html.includes('0.421'), 'a continuous atlas value')
assert.ok(html.includes('<span class="axis">X</span>&nbsp;3.25'), 'world coordinates are axis-labelled')
assert.ok(html.includes('<span class="axis">Z</span>&nbsp;18.00'))
assert.ok(html.includes('<span class="axis">I</span>&nbsp;128'), 'voxel coordinates are axis-labelled')
// A visible divider between components — the three values ran together without one. It is a real
// character, not a CSS border, so it survives being copied out of the report.
assert.ok(
  html.includes(
    '<span class="coord-part"><span class="axis">X</span>&nbsp;3.25</span>' +
      '<span class="sep">&nbsp;|&nbsp;</span>' +
      '<span class="coord-part"><span class="axis">Y</span>&nbsp;-42.50</span>',
  ),
  'components are separated by a real divider character',
)
// The padding is inside the span, not a CSS margin: a margin looks right on screen but collapses
// when the row is copied out of the report.
assert.ok(/\.sep \{[^}]*color:/.test(html), 'the divider is styled fainter than the values')
// Laid out inline the two rows had different component widths, so their dividers could not line up.
// Each row is a grid with the SAME explicit columns, which is what puts them at the same x.
assert.ok(html.includes('<dd><span class="coord">'), 'each coordinate row is a grid container')
assert.equal((html.match(/<span class="coord-part">/g) ?? []).length % 3, 0, 'every component is its own grid item')
const coordRule = html.match(/\.coord \{[^}]*\}/s)[0]
assert.match(coordRule, /display:\s*grid/)
// Three identical component tracks with the dividers between them — identical is what makes the
// world and voxel rows line up with each other.
const tracks = coordRule.match(/grid-template-columns:([^;]*)/)[1].trim()
assert.match(tracks, /^(\S+(?: \S+)*) auto \1 auto \1$/, 'three identical component tracks, dividers between')
// Sized to the CONTENT, not the container: 1fr split the full dd width three ways, which aligned the
// dividers but flung the components hundreds of pixels apart.
assert.equal(/\b1fr\b/.test(tracks), false, 'no stretch track — that is what produced the wide gaps')
assert.match(coordRule, /justify-content:\s*start/, 'and the grid does not stretch to fill the row')
ok('both coordinate rows share one content-sized column grid, so dividers align without wide gaps')
assert.ok(html.includes('45231'), 'the nearest vertex index')
assert.ok(html.includes('21 / 27'), 'valid voxels over the neighborhood denominator')
ok('atlas, vertex and retinotopy readouts are rendered')

// --- the header names the real path on disk, above the dataset it belongs to ---
assert.ok(html.includes('<dd>/data/demo_viewer/sub-example</dd>'), 'the path is absolute, not dataset-relative')
assert.ok(html.indexOf('<dt>path</dt>') < html.indexOf('<dt>dataset</dt>'), 'path sits above dataset')
ok('the header reports the absolute path, above the dataset row')

// --- bookmarks (naming and ordering are asserted with the merged list above) ---
assert.ok(html.includes('surface pane was hidden'), 'a missing screenshot is explained, not silently absent')
assert.ok(html.includes('body position'), 'a somatotopy point renders its own readout')
assert.equal(html.includes('Readouts were captured when each point'), false, 'no bookmarks lead paragraph')
assert.equal(html.includes('This document is self-contained'), false, 'no footer self-description')
assert.equal(html.includes('The files currently loaded into the scene'), false, 'no source-files lead paragraph')
ok('bookmarks render with ordinals, labels, provenance of their readouts and capture notes')

// --- escaping: paths and labels are attacker-controlled text as far as this module is concerned ---
const hostile = data()
hostile.dataset.subjectLabel = '<script>alert(1)</script>'
hostile.files[0].path = 'sub-"><img src=x onerror=alert(1)>/anat.nii.gz'
hostile.bookmarks[0].label = "O'Brien & <b>bold</b>"
hostile.notes = ['</script><script>alert(2)</script>']
const escaped = buildReportHtml(hostile)
assert.equal(escaped.includes('<script>alert(1)</script>'), false, 'no injected script element')
assert.equal(escaped.includes('<img src=x'), false, 'no injected img element')
assert.equal((escaped.match(/<script\b[^>]*>/gi) ?? []).length, 1, 'still exactly one script element')
assert.ok(escaped.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the hostile label is shown as text')
assert.ok(escaped.includes('O&#39;Brien &amp; &lt;b&gt;bold&lt;/b&gt;'), 'quotes and ampersands are escaped')
ok('hostile paths, labels and notes are escaped into text')

// The JSON payload must not be able to close its own script element.
assert.equal(/<\/script>/i.test(jsonPayload(hostile)), false, 'the payload cannot terminate the script element')
ok('the embedded payload cannot break out of its script element')

// --- embedded payload round-trips and omits duplicate image bytes ---
const raw = html.slice(html.indexOf('id="brainana-report-data">') + 'id="brainana-report-data">'.length, html.lastIndexOf('</script>'))
const parsed = JSON.parse(raw)
assert.equal(parsed.dataset.subjectId, 'sub-example')
assert.equal(parsed.bookmarks.length, 2)
assert.equal(parsed.current.readout.atlases[0].region, 'area V1')
assert.equal(parsed.current.shots.slices, '[embedded]', 'image bytes are not duplicated into the payload')
assert.equal(parsed.bookmarks[0].shots.surface, null, 'a missing image stays missing in the payload')
assert.equal(parsed.bookmarks[0].shots.note, 'surface pane was hidden')
assert.equal(raw.includes(PNG.slice(-20)), false, 'no base64 image data inside the payload')
// The fields the page stopped drawing are still parsed and still travel in the payload, so a script
// reading the report back loses nothing.
const parsedHeader = parsed.files[0].header
for (const kept of ['intentCode', 'sclSlope', 'sclInter', 'calMin', 'calMax', 'qformCode', 'sformCode', 'timeUnit', 'littleEndian']) {
  assert.ok(kept in parsedHeader, `${kept} survives in the payload`)
}
assert.equal(parsedHeader.qformCode, 1)
assert.equal(parsedHeader.littleEndian, true)
ok('the embedded JSON payload round-trips, keeps the undrawn header fields, and duplicates no image bytes')

// --- missing data must read as missing, never as a number ---
const sparse = data()
sparse.current.readout = readout({
  voxel: null,
  vertex: null,
  atlases: [],
  morphology: { curvature: NaN, sulc: Infinity, thickness: -Infinity },
  retinotopy: { polar: NaN, polarF: NaN, eccentricity: NaN, eccentricityF: NaN, visualX: NaN, visualY: NaN, validVoxels: 0, possibleVoxels: 27, spreadDeg: null, neighborhood: 2 },
  overlay: null,
})
sparse.current.shots = null
sparse.bookmarks = []
sparse.files = []
sparse.pipelineVersions = []
sparse.view.atlas = null
sparse.view.function = null
const sparseHtml = buildReportHtml(sparse)
assert.equal(/NaN|Infinity/.test(sparseHtml), false, 'no raw NaN/Infinity anywhere in the document')
assert.ok(sparseHtml.includes('—'), 'missing measurements render as an em dash')
assert.ok(sparseHtml.includes('no valid voxel here'), 'an undefined spread is explained rather than shown as 0')
assert.ok(sparseHtml.includes('No atlases loaded.'))
assert.ok(sparseHtml.includes('No files loaded.'))
assert.ok(sparseHtml.includes('not recorded'), 'an unknown pipeline version says so')
assert.equal(sparseHtml.includes('class="shot"'), false, 'no figures when there are no images')
ok('absent data renders as explicit "missing", never as NaN or a misleading zero')

// A report with no location selected at all must still be a valid document.
const bare = data()
bare.current = { readout: null, shots: null }
const bareHtml = buildReportHtml(bare)
// No crosshair, but bookmarks still stand on their own — the section must not claim emptiness.
assert.equal(bareHtml.includes('No location was selected.'), false)
assert.ok(bareHtml.includes('id="location-1"'), 'the bookmarks are still reported')
assert.equal(bareHtml.includes('id="location-current"'), false, 'and no empty current card is invented')
assert.ok(bareHtml.startsWith('<!doctype html>') && bareHtml.trimEnd().endsWith('</html>'))

// Nothing selected and nothing bookmarked: then, and only then, the section says so.
const nothing = data()
nothing.current = { readout: null, shots: null }
nothing.bookmarks = []
const nothingHtml = buildReportHtml(nothing)
assert.ok(nothingHtml.includes('No location was selected.'))
assert.ok(nothingHtml.startsWith('<!doctype html>') && nothingHtml.trimEnd().endsWith('</html>'))
ok('a report with no crosshair still reports its bookmarks, and an empty one says so')

// --- helpers ---
assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
assert.equal(esc(null), '')
assert.equal(fmt(1.005, 2), '1.00')
assert.equal(fmt(NaN), '—')
assert.equal(fmt(null), '—')
assert.equal(fmt(undefined), '—')
assert.equal(fmt(2.5, 1, ' mm'), '2.5 mm')
ok('esc and fmt handle null, non-finite and markup input')

// Timestamps are formatted in UTC so the document reads identically wherever it is opened.
assert.equal(formatTimestamp('2026-09-01T14:32:05.000Z'), '2026-09-01 14:32:05 UTC')
assert.equal(formatTimestamp('not a date'), 'not a date', 'an unparseable stamp is passed through')
ok('timestamps are rendered in UTC, independent of the reader’s locale')

// --- which reconstruction the report came from ---------------------------------------------
// A subject can have several, two of them look alike on screen, and a report outlives the viewer
// that made it -- so a report that does not name its scan cannot be checked against the data later.
{
  const longScan = data()
  longScan.dataset.scan = { id: 'sub-example_ses-002_long', stream: 'long', session: 'ses-002', label: 'ses-002 (long)' }
  const out = buildReportHtml(longScan)
  assert.ok(out.includes('ses-002 (long)'), 'the scan label appears')
  assert.match(out, /base template/i, 'and the stream is explained in prose, not left as an opaque suffix')
  // Escaped like everything else the report interpolates.
  const evil = data()
  evil.dataset.scan = { id: 'x', stream: 'cross', session: null, label: '<img src=x onerror=alert(1)>' }
  assert.equal(buildReportHtml(evil).includes('<img src=x'), false, 'the scan label is escaped')
  ok('the report names the reconstruction it came from, and escapes it')
}

// --- the longitudinal section ------------------------------------------------------------------
assert.equal(/<h2>Longitudinal change<\/h2>/.test(html), false, 'absent when no change map was shown')
{
  const d = data()
  d.dataset.scan = { id: 'sub-example_base', stream: 'base', session: null, label: 'base template' }
  d.view.longitudinal = {
    measure: 'thickness', statistic: 'rate', colormap: 'bwr',
    displayRange: { min: -0.2, max: 0.2 }, threshold: 0.05, opacity: 1,
    unit: 'mm per scan', timeSource: 'session label', timeInterpretable: false,
  }
  d.longitudinal = {
    timepoints: ['sub-example_ses-001_long', 'sub-example_ses-002_long'],
    times: { 'sub-example_ses-001_long': 1, 'sub-example_ses-002_long': 2 },
    timeSource: 'session label', timeInterpretable: false, skipped: {},
    roiRates: [{ roi: 'V1', hemi: 'L', measure: 'ThickAvg', slope: -0.0123, mean: 2.5, spc: -0.5, nTimepoints: 2 }],
    agreement: [{ timepoint: 'sub-example_ses-001', dice: 0.72 }],
  }
  const out = buildReportHtml(d)
  assert.match(out, /<h2>Longitudinal change<\/h2>/)
  // The caveat must be IN the section, and the unit must travel with the numbers.
  assert.match(out, /per scan, not per unit time/i, 'the section leads with the caveat')
  assert.ok(out.includes('mm per scan'), 'the unit is stated')
  assert.ok(out.includes('V1'), 'the ROI table renders')
  assert.ok(out.includes('0.72'), 'the base agreement renders')
  // The report speaks the same vocabulary as the panel that produced it: one word per quantity.
  // "slope" was the CSV's name for what the UI calls the rate, and shipping both read as two things.
  assert.match(out, /<th>rate/, 'the rate column is not called "slope"')
  assert.equal(/<th>slope/.test(out), false, 'no stale "slope" header')
  assert.match(out, /<th>% change<\/th>/, 'the percent-change column is spelled out, not "spc"')
  // The table is scoped to ONE FreeSurfer stat, so it has to say which.
  assert.match(out, /ROI fits\s*<span class="muted">\(ThickAvg\)<\/span>/, 'the ROI table names its stat')
  // The threshold names the statistic it masks, as the panel's slider does.
  assert.match(out, /\|rate\| \u2265/, 'the threshold names the statistic')
  assert.equal(/\|change\| \u2265/.test(out), false, 'the generic "|change|" label is gone')
  ok('the longitudinal section states the fit, its caveat and its ROI table')

  const good = data()
  good.dataset.scan = d.dataset.scan
  good.view.longitudinal = { ...d.view.longitudinal, unit: 'mm per year', timeSource: 'age', timeInterpretable: true }
  good.longitudinal = { ...d.longitudinal, timeSource: 'age', timeInterpretable: true }
  const goodOut = buildReportHtml(good)
  assert.equal(/per scan, not per unit time/i.test(goodOut), false, 'no caveat when the fit used real time')
  assert.ok(goodOut.includes('mm per year'))
  ok('a fit against real elapsed time carries no per-scan caveat')
}

console.log(`\nreport_html_test: ${passed} checks passed`)

// --- L10: the exported report declares a restrictive CSP --------------------------------------
// The document already carries no script and references nothing over the network, so this is
// defence in depth — but a report is the artifact meant to outlive the viewer, opened years later
// by someone who has no idea what is or is not inside it. One meta tag is cheap insurance that it
// cannot be made to reach the network or execute anything, whatever it ends up containing.
{
  const doc = buildReportHtml(data())
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(doc)
  assert.ok(csp, 'the report declares a Content-Security-Policy meta tag')
  const policy = csp[1]
  assert.match(policy, /default-src 'none'/, 'nothing is allowed by default')
  assert.match(policy, /img-src[^;]*data:/, 'the embedded data: screenshots are allowed')
  assert.match(policy, /style-src[^;]*'unsafe-inline'/, 'the inline stylesheet is allowed')
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(policy), 'inline script is NOT allowed')
  // The tag has to precede the content it governs.
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<style>'), 'the policy is declared before the stylesheet')
  ok('the report carries a restrictive CSP that still permits its own data: images and inline CSS')
}

