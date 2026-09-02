// Pipeline provenance for a loaded file.
//
// Every file the brainana pipeline writes has a JSON sidecar of the same basename carrying
// `GeneratedBy: [{ Name, Version }]`. The manifest does not surface these (they are irrelevant to
// rendering), but the data route streams any path contained in the source, so the sidecar can be
// fetched directly from the asset's own /brainana-data URL. That keeps provenance lazy — paid only
// when a report is generated, and only for the files actually loaded.
//
// FreeSurfer-derived files (norm.mgz, lh.pial, lh.curv) are not pipeline outputs and have no
// sidecar; they resolve to null rather than to a guessed path.

/** Extensions whose sidecar is `<basename>.json`. Longest first so `.surf.gii` wins over `.gii`. */
const SIDECAR_EXTENSIONS = ['.nii.gz', '.surf.gii', '.func.gii', '.shape.gii', '.label.gii', '.nii', '.gii']

export interface GeneratedByEntry {
  name: string
  version: string | null
}

/**
 * Sidecar URL for a data URL, or null when the file has no sidecar convention (an extensionless
 * FreeSurfer file, a .mgz, or an inlined `data:` LUT). Operates on the URL string: path segments
 * are percent-encoded per segment, and no extension character is ever encoded, so a suffix swap is
 * safe without decoding.
 */
export function sidecarUrl(dataUrl: string | null | undefined): string | null {
  if (!dataUrl || dataUrl.startsWith('data:')) return null
  const [pathPart] = dataUrl.split(/[?#]/, 1)
  const lower = pathPart.toLowerCase()
  for (const ext of SIDECAR_EXTENSIONS) {
    if (lower.endsWith(ext)) return `${pathPart.slice(0, pathPart.length - ext.length)}.json`
  }
  return null
}

// Scoped data URLs are /brainana-data/<sourceId>/<rel>, where a source id is `<type>-<12 hex>`.
// Matching that exact shape — not a bare `[^/]+` — is what separates a scoped URL from a legacy
// unscoped one; a loose segment match swallows the first real path segment of every legacy URL and
// leaves the legacy branch reachable only for single-segment paths. Mirrors SOURCE_ID_PATTERN in
// packages/core-server/dataSource.mjs, which the server's own routes are built from; the client
// cannot import it, so keep the two in step.
const SCOPED_DATA_RE = /^\/brainana-data\/[^/]+-[0-9a-f]{12}\/(.*)$/

/** Human-readable path for a /brainana-data URL: the source-relative path, percent-decoded. */
export function displayPath(dataUrl: string | null | undefined): string {
  if (!dataUrl) return '—'
  if (dataUrl.startsWith('data:')) return '(bundled with the app)'
  const scoped = dataUrl.match(SCOPED_DATA_RE)
  const legacy = dataUrl.match(/^\/brainana-data\/(.*)$/)
  const rel = scoped?.[1] ?? legacy?.[1]
  if (rel == null) return dataUrl
  return rel
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment // malformed escape — show it as-is rather than throwing mid-report
      }
    })
    .join('/')
}

/** Parse a sidecar body's `GeneratedBy` block. Tolerates the field being absent, a bare object
 *  instead of an array, or entries missing a version. */
export function parseGeneratedBy(sidecar: unknown): GeneratedByEntry[] {
  if (!sidecar || typeof sidecar !== 'object') return []
  const raw = (sidecar as { GeneratedBy?: unknown }).GeneratedBy
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: GeneratedByEntry[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { Name?: unknown; Version?: unknown }
    const name = typeof record.Name === 'string' ? record.Name : null
    if (!name) continue
    out.push({ name, version: typeof record.Version === 'string' ? record.Version : typeof record.Version === 'number' ? String(record.Version) : null })
  }
  return out
}

/** The brainana version among a `GeneratedBy` list, if the pipeline generated the file. */
export function brainanaVersion(entries: GeneratedByEntry[]): string | null {
  return entries.find((e) => e.name.toLowerCase() === 'brainana')?.version ?? null
}

export type SidecarFetch = (url: string) => Promise<Response>

/**
 * Fetch and parse one file's sidecar. Best-effort by contract: a missing sidecar, a non-2xx, a
 * malformed body, or a timeout all resolve to [] rather than rejecting, so one unreachable file
 * can never fail a report. `timeoutMs` bounds a slow SFTP-backed source.
 */
export async function fetchGeneratedBy(fetchFn: SidecarFetch, dataUrl: string, timeoutMs = 5000): Promise<GeneratedByEntry[]> {
  const url = sidecarUrl(dataUrl)
  if (!url) return []
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  try {
    const res = await Promise.race([fetchFn(url), timer])
    if (!res || !res.ok) return []
    return parseGeneratedBy(await res.json())
  } catch {
    return []
  }
}

/** Distinct brainana versions across a set of files, newest-looking last (natural sort). */
export function distinctVersions(versions: Array<string | null>): string[] {
  const seen = new Set<string>()
  for (const v of versions) if (v) seen.add(v)
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}
