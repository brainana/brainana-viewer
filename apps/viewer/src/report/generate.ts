// Assembles a ReportData from the live viewer: file provenance, view state, the current readout,
// and per-bookmark screenshots. Everything it needs arrives through a narrow ReportContext of
// closures, so the dashboard keeps ownership of its own state and this module stays independent of
// the dashboard's internals.
import type { Bookmark, FileInfo, LocationReadout, PaneShots, ReportData, ViewState } from './model.ts'
import type { LoadedAsset } from '../niivue/multiView.ts'
import { describeHeader, describeMesh, type RawNiftiHeader } from './header.ts'
import { brainanaVersion, displayPath, distinctVersions, fetchGeneratedBy } from './provenance.ts'
import { capturePanes, nextFrame, type PaneTarget, MAIN_SHOT_WIDTH, POINT_SHOT_WIDTH } from './capture.ts'

export interface ReportContext {
  /** Authenticated fetch, used only for sidecar lookups. */
  apiFetch: (path: string) => Promise<Response>
  app: { name: string; version: string; buildId: string | null }
  /** Read at generation time — the subject can change while the dialog is open. */
  dataset: () => ReportData['dataset']
  loadedAssets: () => LoadedAsset[]
  currentReadout: () => LocationReadout | null
  viewState: () => ViewState
  /** The longitudinal fit behind an active change map; null when none is shown. */
  longitudinal: () => ReportData['longitudinal']
  /** The two panes, with their current visibility. */
  panes: () => { slices: PaneTarget; surface: PaneTarget }
  crosshair: () => [number, number, number] | null
  moveCrosshair: (mm: [number, number, number]) => void
}

export interface GenerateOptions {
  includeScreenshots: boolean
  /** Progress reporting for the dialog; called with a human-readable step. */
  onProgress?: (message: string) => void
}

/**
 * Which loaded assets earn a card in the report.
 *
 * The per-atlas volumes sampled for the readout are the SAME files as the atlas overlay, so listing
 * them again as "atlas (sampled)" only duplicated the section. Auxiliary assets that resolve to
 * neither a header nor a mesh (the morphometry .shape.gii layers) render as a bare role and path,
 * which tells a reader nothing.
 *
 * The base volume and the atlas overlay are always listed, detail or not: they are what the report
 * is fundamentally about, and a viewer that failed to expose a header for one of them must show up
 * as a card with no detail rather than as a silently missing file.
 */
function isListable(asset: LoadedAsset): boolean {
  if (asset.role.startsWith('atlas (sampled)')) return false
  if (asset.role.startsWith('base volume') || asset.role.startsWith('atlas overlay')) return true
  return Boolean(asset.hdr || asset.mesh)
}

/**
 * Describe the listable assets, and resolve the pipeline version across ALL of them.
 *
 * Provenance is gathered from every loaded asset, not just the listed ones: the sampled atlas
 * volumes carry the brainana sidecars, and dropping them from the list must not drop the version
 * from the report header. Lookups are keyed by URL so an atlas that is both overlaid and sampled is
 * fetched once, and each is best-effort (fetchGeneratedBy never rejects), so one slow or missing
 * file cannot hold up the rest.
 */
export async function collectFiles(ctx: ReportContext): Promise<{ files: FileInfo[]; pipelineVersions: string[] }> {
  const assets = ctx.loadedAssets()
  const urls = [...new Set(assets.map((asset) => asset.url).filter((url): url is string => Boolean(url)))]
  const resolved = await Promise.all(urls.map((url) => fetchGeneratedBy(ctx.apiFetch, url)))
  const byUrl = new Map(urls.map((url, i) => [url, resolved[i]]))

  const files = assets.filter(isListable).map((asset) => {
    const generatedBy = (asset.url && byUrl.get(asset.url)) || []
    return {
      role: asset.role,
      path: displayPath(asset.url),
      url: asset.url ?? '',
      generatedBy,
      brainanaVersion: brainanaVersion(generatedBy),
      header: describeHeader(asset.hdr as RawNiftiHeader | null),
      mesh: describeMesh(asset.mesh),
    }
  })
  return { files, pipelineVersions: distinctVersions([...byUrl.values()].map(brainanaVersion)) }
}

/**
 * Screenshot each bookmarked point by driving the crosshair there and capturing both panes.
 * The crosshair is restored afterwards even if a capture throws — the user must get their view
 * back. The camera is untouched (moving the crosshair does not move it), so every image in a
 * report shares one view configuration.
 */
export async function captureBookmarkShots(ctx: ReportContext, bookmarks: Bookmark[], onProgress?: (message: string) => void): Promise<Bookmark[]> {
  if (bookmarks.length === 0) return []
  const origin = ctx.crosshair()
  const out: Bookmark[] = []
  try {
    for (const [i, bookmark] of bookmarks.entries()) {
      onProgress?.(`Capturing point ${i + 1} of ${bookmarks.length}…`)
      ctx.moveCrosshair(bookmark.readout.mm)
      // One frame lets the move settle (and clears MultiView's re-entrancy guard) before the draw.
      await nextFrame()
      const { slices, surface } = ctx.panes()
      out.push({ ...bookmark, shots: capturePanes(slices, surface, POINT_SHOT_WIDTH) })
    }
    return out
  } finally {
    if (origin) {
      ctx.moveCrosshair(origin)
      await nextFrame()
    }
  }
}

/** Build the full report payload. */
export async function generateReport(ctx: ReportContext, bookmarks: Bookmark[], options: GenerateOptions): Promise<ReportData> {
  const { includeScreenshots, onProgress } = options
  onProgress?.('Reading file provenance…')
  const { files, pipelineVersions } = await collectFiles(ctx)

  // Screenshot the current view BEFORE visiting the bookmarks, so it shows what the user was
  // actually looking at when they pressed the button.
  let currentShots: PaneShots | null = null
  if (includeScreenshots) {
    onProgress?.('Capturing the current view…')
    const { slices, surface } = ctx.panes()
    currentShots = capturePanes(slices, surface, MAIN_SHOT_WIDTH)
  }

  const points = includeScreenshots ? await captureBookmarkShots(ctx, bookmarks, onProgress) : bookmarks
  onProgress?.('Building the document…')

  const notes: string[] = []
  if (!includeScreenshots) notes.push('Screenshots were not included in this report.')
  if (pipelineVersions.length === 0) {
    notes.push('No brainana sidecars were found beside the loaded files, so the pipeline version could not be determined.')
  }

  const longitudinal = ctx.longitudinal()
  const view = ctx.viewState()
  // Notes render at the very top of the document, so a reader who never scrolls to the
  // longitudinal section still sees the caveat. That is the point of putting it here rather than
  // only in the section it describes.
  if (view.longitudinal && !view.longitudinal.timeInterpretable) {
    notes.push(
      `The change map shown is in ${view.longitudinal.unit}. brainana fit it against scan order ` +
        `(time source: ${view.longitudinal.timeSource ?? 'unknown'}), not real elapsed time, so these ` +
        `values are a change per scan and cannot be read as change per year.`,
    )
  }
  if (longitudinal) {
    const worst = longitudinal.agreement.length ? longitudinal.agreement.reduce((a, b) => (a.dice <= b.dice ? a : b)) : null
    if (worst && worst.dice < 0.8) {
      notes.push(
        `Base segmentation agreement is low for ${worst.timepoint} (median Dice ${worst.dice.toFixed(2)}). ` +
          `The base template's surfaces deserve a closer look before these change maps are trusted.`,
      )
    }
    const skipped = Object.keys(longitudinal.skipped)
    if (skipped.length) notes.push(`${skipped.length} session(s) were excluded from the longitudinal fit: ${skipped.join(', ')}.`)
  }

  return {
    generatedAt: new Date().toISOString(),
    app: { ...ctx.app, userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent },
    dataset: ctx.dataset(),
    pipelineVersions,
    longitudinal,
    files,
    view,
    current: { readout: ctx.currentReadout(), shots: currentShots },
    bookmarks: points,
    notes,
  }
}

/** Default filename: identifies the subject and the moment, and sorts chronologically. */
export function reportFilename(data: ReportData): string {
  const safe = (v: string): string => v.replace(/[^A-Za-z0-9_-]+/g, '-')
  const subject = safe(data.dataset.subjectId ?? 'subject')
  // Include the scan: two reports from two timepoints of one animal are different documents and
  // must not collide in a downloads folder. The scan id already starts with the subject id, so
  // strip that prefix rather than repeating it.
  const scan = data.dataset.scan ? safe(data.dataset.scan.id.replace(new RegExp(`^${data.dataset.subjectId ?? ''}_?`), '')) : ''
  const stamp = data.generatedAt.slice(0, 19).replace(/[:T]/g, '-')
  return `brainana-report_${subject}${scan ? `_${scan}` : ''}_${stamp}.html`
}
