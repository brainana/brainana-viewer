// The report document itself: ReportData → one self-contained HTML string.
//
// Pure by design — no DOM, no fetch, no NiiVue — so it is unit-tested under the plain node runner
// and so the output can never depend on the machine that generated it. The document embeds its own
// stylesheet and its images as data URLs, carries no script, and references nothing over the
// network: a report must still read correctly years later on a machine with no viewer installed.
import type { AtlasReadout, FileInfo, HeaderInfo, LocationReadout, PaneShots, ReportData, ViewState } from './model.ts'
import { bookmarkName } from './bookmarks.ts'
import { formatResolution } from './header.ts'

const EM_DASH = '—'

/** Escape for both text and quoted-attribute contexts. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A number for display, or an em dash when it is missing/non-finite. Never prints "NaN". */
export function fmt(value: number | null | undefined, digits = 2, unit = ''): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH
  return `${value.toFixed(digits)}${unit}`
}

const text = (value: string | null | undefined): string => (value == null || value === '' ? EM_DASH : esc(value))

const intText = (value: number | null | undefined): string => (value == null || !Number.isFinite(value) ? EM_DASH : String(Math.round(value)))

/** `<dl>` of label/value rows. Values are pre-escaped HTML fragments. */
function dl(rows: Array<[string, string]>): string {
  if (rows.length === 0) return ''
  return `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
}

function table(headers: string[], rows: string[][], className = ''): string {
  const head = `<thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead>`
  const body = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>`
  // Wide tables scroll inside their own box so the page body never scrolls sideways.
  return `<div class="table-wrap"><table class="${esc(className)}">${head}${body}</table></div>`
}

function section(id: string, title: string, body: string): string {
  return `<section id="${esc(id)}"><h2>${esc(title)}</h2>${body}</section>`
}

const coords = (xyz: readonly number[] | null | undefined, digits = 2): string =>
  xyz ? xyz.map((v) => fmt(v, digits)).join(', ') : EM_DASH

/**
 * Coordinates with their axis names, so a triple of numbers is never ambiguous in isolation, and
 * with a visible divider between components — "X -22.42 Y 7.02 Z 9.11" ran together into one
 * unreadable string. The divider is a real character rather than a CSS border so it survives being
 * copied out of the report.
 */
function labelledCoords(values: readonly number[] | null | undefined, axes: readonly string[], digits: number): string {
  if (!values) return EM_DASH
  const parts = axes.map(
    (axis, i) => `<span class="coord-part"><span class="axis">${esc(axis)}</span>&nbsp;${digits === 0 ? intText(values[i]) : fmt(values[i], digits)}</span>`,
  )
  // Wrapped in a fixed column grid (see .coord): laid out inline, the world and voxel rows had
  // different component widths, so their dividers could not line up with each other.
  return `<span class="coord">${parts.join('<span class="sep">&nbsp;|&nbsp;</span>')}</span>`
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Header detail for one volume. Shape and voxel size are what a reader checks at a glance, so they
 * are always visible; the rest sits behind a native <details> (no script needed). The remaining
 * NIfTI fields — intent, scaling, cal range, qform/sform, units, byte order — are still parsed and
 * still travel in the embedded JSON payload, they are just not drawn: nobody reads them off a page.
 */
function headerBlock(info: HeaderInfo): string {
  const affine = info.affine
    .map((row) => `<tr>${row.map((v) => `<td>${esc(Number(v.toFixed(4)))}</td>`).join('')}</tr>`)
    .join('')
  const summary = dl([
    ['dims', info.dims.join(' × ')],
    ['resolution', esc(formatResolution(info))],
  ])
  const more: Array<[string, string]> = [
    ['n_dim', String(info.nDim)],
    ['frames', String(info.frames)],
    ['datatype', `${esc(info.datatype)} <span class="muted">(${info.bitpix} bit)</span>`],
  ]
  if (info.description) more.push(['description', esc(info.description)])
  // The affine is a row of the same list, not a block with its own label style: that made its label
  // a third treatment (small-caps) sitting beside plain dt labels, which reads as a different font.
  // As a dt it matches its peers by construction, and the matrix lands in the shared value column.
  more.push(['affine (voxel → world)', `<table class="matrix">${affine}</table>`])
  return `<div class="hdr">${summary}</div>
<details class="more"><summary>more</summary><div class="more-body">${dl(more)}</div></details>`
}

function filesSection(files: FileInfo[]): string {
  if (files.length === 0) return section('files', 'Source files', '<p class="empty">No files loaded.</p>')
  const blocks = files
    .map((file) => {
      const detail = file.header
        ? headerBlock(file.header)
        : file.mesh
          ? dl([
              ['vertices', file.mesh.vertices.toLocaleString('en-US')],
              ['faces', file.mesh.faces.toLocaleString('en-US')],
            ])
          : ''
      // The pipeline version is a property of the dataset, not of each file — it is reported once in
      // the document header rather than repeated on every card.
      return `<article class="file">
  <h3>${esc(file.role)}</h3>
  <p class="path">${esc(file.path)}</p>
  ${detail}
</article>`
    })
    .join('')
  return section('files', 'Source files', blocks)
}

function viewSection(view: ViewState): string {
  const rows: Array<[string, string]> = [
    ['layout', text(view.layout)],
    ['panes', `volume ${view.panes.volume ? 'shown' : 'hidden'} · surface ${view.panes.surface ? 'shown' : 'hidden'}`],
    ['hemispheres', [view.hemispheres.left ? 'left' : null, view.hemispheres.right ? 'right' : null].filter(Boolean).join(' + ') || 'none'],
    ['surface', text(view.surfaceKind)],
    ['base volume', text(view.baseVolume.label ?? view.baseVolume.key)],
    ['base window', view.baseVolume.window ? `${fmt(view.baseVolume.window.min, 3)} … ${fmt(view.baseVolume.window.max, 3)}` : EM_DASH],
    ['base clip', clipText(view.baseVolume.clip)],
    ['marker mode', text(view.markerMode)],
    ['camera', view.camera ? `azimuth ${fmt(view.camera.azimuth, 1)}° · elevation ${fmt(view.camera.elevation, 1)}° · scale ${fmt(view.camera.scale, 2)}` : EM_DASH],
  ]
  if (view.atlas) {
    rows.push([
      'atlas overlay',
      `${esc(view.atlas.name)} <span class="muted">(${view.atlas.continuous ? 'continuous' : 'parcellation'}, colormap ${esc(view.atlas.colormap)}, opacity ${fmt(view.atlas.opacity, 2)}${view.atlas.hiddenRois ? `, ${view.atlas.hiddenRois} ROI(s) hidden` : ''})</span>`,
    ])
    if (view.atlas.displayRange) rows.push(['atlas display range', `${fmt(view.atlas.displayRange.min, 3)} … ${fmt(view.atlas.displayRange.max, 3)}`])
    rows.push(['atlas clip', clipText(view.atlas.clip)])
  } else {
    rows.push(['atlas overlay', '<span class="muted">none</span>'])
  }
  rows.push([
    'morphology shading',
    view.morphology.metric === 'none'
      ? '<span class="muted">none</span>'
      : `${esc(view.morphology.metric)}${view.morphology.metric === 'curvature' ? ` · ${esc(view.morphology.curvatureStyle)}` : ''}${view.morphology.colormap ? ` <span class="muted">(colormap ${esc(view.morphology.colormap)})</span>` : ''}`,
  ])
  if (view.morphology.range) rows.push(['morphology range', `${fmt(view.morphology.range.min, 3)} … ${fmt(view.morphology.range.max, 3)}`])
  if (view.function) {
    rows.push([
      'function overlay',
      `${esc(view.function.kind)} · ${esc(view.function.mode)} <span class="muted">(colormap ${esc(view.function.colormap)}, opacity ${fmt(view.function.opacity, 2)}, brightness ${fmt(view.function.brightness, 2)})</span>`,
    ])
    rows.push(['F-stat threshold', fmt(view.function.threshold, 2)])
    if (view.function.displayRange) rows.push(['function display range', `${fmt(view.function.displayRange.min, 3)} … ${fmt(view.function.displayRange.max, 3)}`])
    rows.push(['function clip', clipText(view.function.clip)])
  } else {
    rows.push(['function overlay', '<span class="muted">none</span>'])
  }
  // Reference material rather than reading matter: collapsed, and last in the document.
  return section('view', 'View state', `<details class="more"><summary>show view state</summary><div class="more-body">${dl(rows)}</div></details>`)
}

function clipText(clip: { lo: number | null; hi: number | null } | null | undefined): string {
  if (!clip || (clip.lo == null && clip.hi == null)) return '<span class="muted">none</span>'
  return `${clip.lo == null ? '−∞' : fmt(clip.lo, 3)} … ${clip.hi == null ? '+∞' : fmt(clip.hi, 3)}`
}

function atlasTable(rows: AtlasReadout[]): string {
  if (rows.length === 0) return '<p class="empty">No atlases loaded.</p>'
  return table(
    ['atlas', 'id / value', 'region'],
    rows.map((row) => [
      esc(row.label),
      row.continuous ? fmt(row.value, 3) : intText(row.id),
      row.continuous
        ? '<span class="muted">continuous map</span>'
        : row.unknown
          ? '<span class="unknown">(unlabeled)</span>'
          : row.region
            ? `${row.shortName ? `<span class="short">${esc(row.shortName)}</span> · ` : ''}${esc(row.region)}`
            : EM_DASH,
    ]),
    'atlas-table',
  )
}

function readoutBlock(readout: LocationReadout): string {
  const location: Array<[string, string]> = [
    ['world (mm)', labelledCoords(readout.mm, ['X', 'Y', 'Z'], 2)],
    ['voxel', labelledCoords(readout.voxel, ['I', 'J', 'K'], 0)],
    ['hemisphere', text(readout.hemisphere)],
    ['nearest vertex', readout.vertex ? String(readout.vertex.index) : EM_DASH],
    ['vertex distance (mm)', readout.vertex ? fmt(readout.vertex.distanceMm) : EM_DASH],
  ]
  if (readout.overlay) location.push([`overlay (${readout.overlay.target})`, text(readout.overlay.value)])

  const morphology = readout.morphology
    ? dl([
        ['curvature', fmt(readout.morphology.curvature)],
        ['sulcal depth', fmt(readout.morphology.sulc)],
        ['thickness (mm)', fmt(readout.morphology.thickness)],
      ])
    : '<p class="empty">No surface loaded.</p>'

  let functional = '<p class="empty">No functional map loaded.</p>'
  if (readout.retinotopy) {
    const r = readout.retinotopy
    functional = dl([
      ['polar angle (rad)', fmt(r.polar)],
      ['polar F', fmt(r.polarF)],
      ['eccentricity (°)', fmt(r.eccentricity)],
      ['eccentricity F', fmt(r.eccentricityF)],
      ['visual X (°)', fmt(r.visualX)],
      ['visual Y (°)', fmt(r.visualY)],
      ['valid voxels', r.validVoxels == null ? EM_DASH : `${r.validVoxels} / ${r.possibleVoxels ?? EM_DASH} <span class="muted">(neighborhood ±${r.neighborhood})</span>`],
      ['local spread (°)', r.spreadDeg == null ? `${EM_DASH} <span class="muted">(no valid voxel here)</span>` : fmt(r.spreadDeg)],
    ])
  } else if (readout.somatotopy) {
    functional = dl([
      ['body position', fmt(readout.somatotopy.bodyPosition)],
      ['F', fmt(readout.somatotopy.fStat)],
    ])
  }

  const sub = (title: string, body: string): string => `<div class="readout-row"><h4>${esc(title)}</h4><div class="readout-body">${body}</div></div>`
  return `<div class="readout">
  ${sub('Location', dl(location))}
  ${sub('Atlas regions', atlasTable(readout.atlases))}
  ${sub('Morphometry', morphology)}
  ${sub('Function', functional)}
</div>`
}

/**
 * Equal-height thumbnails that enlarge on click.
 *
 * The enlargement is a pure-CSS `:target` lightbox — the thumbnail links to its own figure's id, and
 * CSS promotes the targeted figure to a full-viewport overlay. That keeps the document script-free
 * and embeds each image exactly once (a second copy for the "large" view would roughly double the
 * file). The backdrop is a close link pointing at `returnTo`, so dismissing the image returns the
 * reader to the section they were reading rather than jumping to the top of the document.
 */
function shotsBlock(shots: PaneShots | null, caption: string, idPrefix: string, returnTo: string, className = 'shots'): string {
  if (!shots) return ''
  const figure = (kind: string, label: string, src: string): string => {
    const id = `${idPrefix}-${kind}`
    return `<figure class="shot" id="${esc(id)}">
  <a class="shot-close" href="#${esc(returnTo)}" aria-label="close"></a>
  <a class="shot-open" href="#${esc(id)}"><img alt="${esc(caption)} — ${esc(label)}" src="${esc(src)}"></a>
  <figcaption>${esc(label)}</figcaption>
</figure>`
  }
  const figures: string[] = []
  if (shots.slices) figures.push(figure('slices', 'slice montage', shots.slices))
  if (shots.surface) figures.push(figure('surface', '3D surface', shots.surface))
  const note = shots.note ? `<p class="note">${esc(shots.note)}</p>` : ''
  if (figures.length === 0) return note || ''
  return `<div class="${esc(className)}">${figures.join('')}</div>${note}`
}

/** One location to report: the live crosshair, or a bookmarked point. */
interface LocationEntry {
  /** Anchor id fragment — also the lightbox close target for that entry's screenshots. */
  key: string
  /** Row label in the summary table ("current", "1", "2", …). */
  ordinal: string
  title: string
  readout: LocationReadout
  shots: PaneShots | null
  /** Which overlay was active; absent for the live crosshair, whose overlay is the view state. */
  overlay: string | null
}

/**
 * The crosshair and the bookmarked points are the same kind of thing, so they share one section:
 * one summary table led by the current location, then a detail card each in the same order.
 */
function locationsSection(data: ReportData): string {
  const entries: LocationEntry[] = []
  if (data.current.readout) {
    entries.push({ key: 'current', ordinal: 'current', title: 'Current location', readout: data.current.readout, shots: data.current.shots, overlay: null })
  }
  data.bookmarks.forEach((bookmark, i) => {
    const label = bookmark.label
    entries.push({
      key: String(i + 1),
      ordinal: String(i + 1),
      // Keep the ordinal AND the name: the dialog lets a point be renamed, and a report that showed
      // only the name would lose the numbering the summary table above refers to.
      title: label ? `Bookmarked #${i + 1} — ${label}` : bookmarkName(bookmark, i),
      readout: bookmark.readout,
      shots: bookmark.shots,
      overlay: bookmark.activeOverlay,
    })
  })

  if (entries.length === 0) return section('locations', 'Selected location', '<p class="empty">No location was selected.</p>')

  // "primary region" is the first atlas that actually resolves a name — a quick anatomical anchor
  // in the summary row, with the full per-atlas breakdown in each card below.
  const primary = (readout: LocationReadout): string => {
    const hit = readout.atlases.find((a) => a.region)
    return hit ? `${esc(hit.region!)} <span class="muted">(${esc(hit.label)})</span>` : EM_DASH
  }
  const summary = table(
    ['#', 'location', 'world X, Y, Z (mm)', 'voxel I, J, K', 'hemi', 'vertex', 'primary region'],
    entries.map((entry) => [
      esc(entry.ordinal),
      esc(entry.title),
      coords(entry.readout.mm),
      entry.readout.voxel ? entry.readout.voxel.map((v) => intText(v)).join(', ') : EM_DASH,
      text(entry.readout.hemisphere),
      entry.readout.vertex ? String(entry.readout.vertex.index) : EM_DASH,
      primary(entry.readout),
    ]),
    'summary-table',
  )
  const cards = entries
    .map((entry) => {
      const anchor = `location-${entry.key}`
      // The overlay active when a point was added explains why one point carries retinotopy values
      // and another does not; the capture time was noise, so it is no longer drawn (it stays in the
      // JSON payload).
      const stamp = entry.overlay ? `<p class="stamp">overlay at the time: ${esc(entry.overlay)}</p>` : ''
      return `<article class="point" id="${esc(anchor)}">
  <h3>${esc(entry.title)}</h3>
  ${stamp}
  ${shotsBlock(entry.shots, entry.title, `shot-${entry.key}`, anchor)}
  ${readoutBlock(entry.readout)}
</article>`
    })
    .join('')
  return section('locations', 'Selected location', `${summary}${cards}`)
}

/** ISO timestamp → "2026-09-01 14:32:05 UTC". Formatted here (not with toLocaleString) so the
 *  document reads the same wherever it is opened. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/**
 * The embedded machine-readable payload. Image data URLs are stripped: they are already in the
 * document as <img> sources, and keeping a second copy would roughly double the file size.
 */
export function jsonPayload(data: ReportData): string {
  const stripShots = (shots: PaneShots | null): PaneShots | null =>
    shots ? { slices: shots.slices ? '[embedded]' : null, surface: shots.surface ? '[embedded]' : null, note: shots.note } : null
  const lean: ReportData = {
    ...data,
    current: { ...data.current, shots: stripShots(data.current.shots) },
    bookmarks: data.bookmarks.map((b) => ({ ...b, shots: stripShots(b.shots) })),
  }
  // Escape the characters that could terminate the script element or break a JS parse, so the
  // payload is inert text no matter what a path or region name contains.
  return JSON.stringify(lean, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const STYLES = `
:root {
  --ink: #1b1a17; --muted: #6d675c; --line: #ddd8cd; --line-2: #ebe7de;
  --paper: #fbfaf7; --panel: #fff; --accent: #a86b12; --accent-soft: #fdf5e6;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 28px 64px; background: var(--paper); color: var(--ink);
  font: 15px/1.55 "Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main, header, footer { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 19px; margin: 0 0 14px; padding-bottom: 8px; border-bottom: 2px solid var(--line); }
h3 { font-size: 15px; margin: 0 0 2px; }
h4 { font-size: 12px; margin: 0 0 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--accent); }
section { margin: 32px 0; }
.subtitle { margin: 0 0 16px; font-size: 17px; color: var(--muted); }
.lead { margin: 0 0 16px; color: var(--muted); max-width: 70ch; }
.muted { color: var(--muted); }
.empty { color: var(--muted); font-style: italic; margin: 4px 0; }
dl { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 3px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; font-variant-numeric: tabular-nums; font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 4px 0 12px; font-size: 13px; }
th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line-2); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
td { font-variant-numeric: tabular-nums; }
.short { font-weight: 600; }
.unknown { color: var(--muted); font-style: italic; }
.file { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 14px 16px; margin-bottom: 12px; break-inside: avoid; }
.path, .prov { margin: 0 0 8px; font-size: 13px; }
.path { font-family: "IBM Plex Mono", ui-monospace, monospace; color: var(--muted); overflow-wrap: anywhere; }
.hdr { padding-top: 8px; border-top: 1px dashed var(--line); }
.matrix { width: auto; font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; }
.matrix td { border: none; padding: 1px 12px 1px 0; text-align: right; }
/* Native disclosure — the document stays script-free. */
details.more { margin-top: 8px; }
details.more > summary { cursor: pointer; width: max-content; font-size: 11px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--accent); }
.more-body { padding-top: 10px; }
/* One column of labelled rows: four columns forced every value to wrap. */
.readout { display: grid; grid-template-columns: 1fr; gap: 18px; }
.readout-row { min-width: 0; }
/* Indent a subsection's content behind a soft rule so the title reads as a container rather than as
   a sibling of the rows beneath it. */
.readout-body { padding-left: 14px; border-left: 2px solid var(--line-2); }
.readout-row dl { grid-template-columns: minmax(140px, max-content) 1fr; }
.readout-body > table, .readout-body .table-wrap > table { margin-top: 0; }
/* Key muted, value in tabular mono, divider fainter than either (theme.html .spec-mono).
   Both coordinate rows are dd's of the same dl column, so an identical explicit column grid puts
   their dividers — and their axis letters — at the same x positions. The tracks are sized to the
   CONTENT, not the container: 1fr divided the full dd width three ways, which aligned the dividers
   but flung the components hundreds of pixels apart. 9ch is the widest realistic component in this
   mono font (axis + space + "-100.00"); voxel indices are shorter, so both rows still compute the
   same track and stay aligned. max-content is the upper bound so a pathological value grows its own
   track instead of colliding with the divider — readability beats alignment in a case real data
   cannot produce. justify-content keeps the whole grid from stretching. */
.coord { display: grid; align-items: baseline; justify-content: start;
  grid-template-columns: minmax(9ch, max-content) auto minmax(9ch, max-content) auto minmax(9ch, max-content); }
.coord-part { white-space: nowrap; }
.axis { color: var(--muted); font-weight: 600; }
.sep { color: var(--line); }
.point { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 6px;
  background: var(--panel); padding: 14px 16px; margin-bottom: 14px; break-inside: avoid; }
.stamp { margin: 0 0 12px; font-size: 12px; color: var(--muted); }
/* Thumbnails share one height whatever each pane's aspect ratio is, so a row of them reads evenly. */
.shots { display: flex; flex-wrap: wrap; gap: 16px; margin: 0 0 20px; align-items: flex-start; }
.shots figure { margin: 0; }
.shots img { display: block; height: 280px; width: auto; max-width: 100%; object-fit: contain;
  border: 1px solid var(--line); border-radius: 4px; background: #000; }
figcaption { font-size: 11px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: .06em; }
.shot-open { display: block; cursor: zoom-in; }
/* Click-to-enlarge with no script: the thumbnail links to its own figure, which :target promotes to
   a full-viewport overlay. .shot-close is the backdrop; it points back at the enclosing section, so
   dismissing returns the reader to where they were instead of jumping to the top. */
.shot-close { display: none; }
.shot:target { position: fixed; inset: 0; z-index: 100; margin: 0; padding: 24px;
  background: rgba(12, 11, 9, .94); display: grid; place-items: center; }
.shot:target .shot-close { display: block; position: fixed; inset: 0; cursor: zoom-out; }
/* The image and caption sit ABOVE the close backdrop so they are visible, which also made them
   swallow the click: .shot-open's href is the figure that is already :target, so clicking the image
   re-targeted the same element and dismissed nothing. Taking them out of hit-testing lets every
   click reach the backdrop beneath — which is what the zoom-out cursor has always implied. */
.shot:target .shot-open,
.shot:target figcaption { position: relative; z-index: 1; pointer-events: none; }
.shot:target img { height: auto; width: auto; max-width: 94vw; max-height: 88vh; border-color: #444; }
.shot:target figcaption { text-align: center; color: #cfc7b6; }
/* A visible affordance, so dismissal is discoverable rather than folklore. */
.shot:target .shot-close::after { content: "×"; position: fixed; top: 14px; right: 22px;
  font-size: 30px; line-height: 1; color: #cfc7b6; }
.shot:target .shot-close:hover::after { color: #fff; }
.note { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
.notes { background: var(--accent-soft); border: 1px solid #eedcb6; border-radius: 6px; padding: 10px 16px; margin: 0 0 24px; }
.notes ul { margin: 0; padding-left: 18px; }
.notes li { font-size: 13px; }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
footer a { color: var(--accent); }
@media print {
  body { padding: 0; background: #fff; font-size: 11px; }
  section { break-inside: avoid-page; }
  h2 { break-after: avoid; }
  .shots img { border-color: #ccc; }
  /* A lightbox left open must not print as a full-page overlay swallowing the rest of the report. */
  .shot:target { position: static; padding: 0; background: none; display: block; }
  .shot:target .shot-close { display: none; }
  .shot:target img { height: 280px; max-width: 100%; }
}
`

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Absolute path of the subject directory. `sourceRoot` is absolute on whichever machine holds the
 * data — this one for a local dataset, the remote host for an SFTP one (the `dataset` row directly
 * below names that host). Falls back to the source-relative path when the server reports no root.
 */
export function subjectPath(data: ReportData): string | null {
  const { sourceRoot, relativePath } = data.dataset
  if (!sourceRoot) return relativePath
  if (!relativePath) return sourceRoot
  return `${sourceRoot.replace(/\/+$/, '')}/${relativePath}`
}

/** Build the complete report document. Self-contained: no network references, no script. */

// How each reconstruction stream reads in prose. A report outlives the viewer that made it, so
// "ses-002 (long)" on its own is not enough -- the reader years later needs to know a base-seeded
// reconstruction is in the subject's base space.
const SCAN_STREAM_NOTE: Record<string, string> = {
  cross: 'cross-sectional, in its own space',
  base: 'within-subject base template',
  long: 'base-seeded, in the base template\u2019s space',
}

function scanText(data: ReportData): string {
  const scan = data.dataset.scan
  if (!scan) return '<span class="muted">not recorded</span>'
  const note = SCAN_STREAM_NOTE[scan.stream]
  return `${esc(scan.label)}${note ? ` <span class="muted">(${esc(note)})</span>` : ''}`
}

// The longitudinal fit behind an active change map: what was fitted, over what, and -- first,
// because it governs how every number below reads -- whether the times were real elapsed time.
function longitudinalSection(data: ReportData): string {
  const fit = data.longitudinal
  const view = data.view.longitudinal
  if (!fit || !view) return ''
  const caveat = view.timeInterpretable
    ? ''
    : `<p class="warn"><strong>Rates are per scan, not per unit time.</strong> brainana fit this map against scan order (time source: ${esc(
        String(view.timeSource ?? 'unknown'),
      )}), so the values below are a change per scan and cannot be read as change per year.</p>`
  const timeRows = fit.timepoints.map((tp) => `<li>${esc(tp)} <span class="muted">t = ${esc(String(fit.times[tp] ?? '?'))}</span></li>`).join('')
  const summary = dl([
    ['map', `${esc(view.measure)} ${esc(view.statistic)}`],
    ['units', view.unit ? esc(view.unit) : '<span class="muted">unitless</span>'],
    ['time source', text(view.timeSource)],
    ['timepoints', String(fit.timepoints.length)],
    ['threshold', view.threshold > 0 ? `|change| \u2265 ${esc(view.threshold.toPrecision(3))}` : '<span class="muted">none</span>'],
  ])
  const roi = fit.roiRates.length
    ? `<h3>ROI fits</h3>
<table class="roi-rates"><thead><tr><th>roi</th><th>hemi</th><th>slope${view.unit ? ` (${esc(view.unit)})` : ''}</th><th>mean</th><th>spc</th><th>n</th></tr></thead><tbody>${fit.roiRates
        .map(
          (r) =>
            `<tr><td>${esc(r.roi)}</td><td>${esc(r.hemi)}</td><td class="num">${esc(fmt(r.slope, 4))}</td><td class="num">${esc(
              fmt(r.mean, 3),
            )}</td><td class="num">${esc(fmt(r.spc, 3))}</td><td class="num">${esc(String(r.nTimepoints))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
  const agreement = fit.agreement.length
    ? `<h3>Base segmentation agreement</h3><ul class="plain">${fit.agreement
        .map((a) => `<li>${esc(a.timepoint)} <span class="muted">median Dice ${esc(a.dice.toFixed(3))}</span></li>`)
        .join('')}</ul>`
    : ''
  return `<section>
<h2>Longitudinal change</h2>
${caveat}
${summary}
<h3>Timepoints</h3><ul class="plain">${timeRows}</ul>
${roi}
${agreement}
</section>`
}

export function buildReportHtml(data: ReportData): string {
  const subject = data.dataset.subjectLabel ?? data.dataset.subjectId ?? 'unknown subject'
  const title = `Brainana Viewer report — ${subject}`
  const versions = data.pipelineVersions.length ? data.pipelineVersions.map((v) => esc(v)).join(', ') : '<span class="muted">not recorded</span>'

  const meta = dl([
    ['generated', esc(formatTimestamp(data.generatedAt))],
    ['viewer', `${esc(data.app.name)} ${esc(data.app.version)}${data.app.buildId ? ` <span class="muted">(build ${esc(data.app.buildId)})</span>` : ''}`],
    ['brainana pipeline', versions],
    ['path', text(subjectPath(data))],
    ['dataset', `${text(data.dataset.sourceLabel)}${data.dataset.sourceType ? ` <span class="muted">(${esc(data.dataset.sourceType)})</span>` : ''}`],
    ['subject', text(data.dataset.subjectId)],
    ['session', text(data.dataset.session)],
    ['scan', scanText(data)],
  ])

  const notes = data.notes.length ? `<div class="notes"><ul>${data.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul></div>` : ''


  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Defence in depth. This document already carries no script and references nothing over the
     network, so today the policy forbids only what is already absent. The point is tomorrow: a
     report is the artifact meant to outlive the viewer, opened years later on a machine with no
     brainana installed, by someone with no idea what is inside it. default-src 'none' means that
     whatever it ends up containing, it cannot reach the network or execute. The two exceptions are
     exactly what the document needs: its screenshots are embedded data: URLs, and its stylesheet is
     inline. Note there is no script-src exception — inline script stays forbidden. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
<h1>Brainana Viewer report</h1>
<p class="subtitle">${esc(subject)}${data.dataset.session ? ` · ${esc(data.dataset.session)}` : ''}${
  data.dataset.scan && data.dataset.scan.stream !== 'cross' ? ` · ${esc(data.dataset.scan.label)}` : ''
}</p>
${meta}
</header>
<main>
${notes}
${filesSection(data.files)}
${locationsSection(data)}
${viewSection(data.view)}
${longitudinalSection(data)}
</main>
<footer>
<p>Generated by ${esc(data.app.name)} ${esc(data.app.version)} from output of the Brainana preprocessing pipeline. If you use these results in your research, please cite both the Brainana Viewer and the Brainana pipeline.</p>
</footer>
<script type="application/json" id="brainana-report-data">${jsonPayload(data)}</script>
</body>
</html>
`
}
