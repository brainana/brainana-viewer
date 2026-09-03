# Viewer HTML Report — Design

Date: 2026-09-01 · Status: approved · Path: architectural (brainstorming skill)

## Problem

The Viewer shows everything a user needs *while they look at it*: the bottom info panel samples the
crosshair on every move and renders four live columns (Coordinates, Atlas, Surface, Func Map) plus a
visual-field plot. None of it can leave the app. There is no way to record "here is the voxel I was
looking at, here is what every atlas calls it, here are its morphometry and retinotopy values, here
is where the data came from and which pipeline version produced it" — what a user needs for a lab
notebook, a figure caption, or a message to a collaborator.

## Solution

A **Generate report** button producing one self-contained HTML file.

Scope decisions (confirmed with the user during brainstorming):

- Covers the **current crosshair plus user-bookmarked points** (a collector + a summary table).
- Screenshots: **the live panes as displayed, plus a per-bookmark pair** (crosshair driven to each
  point, camera and crosshair restored afterwards).
- Destination: **a path-picker dialog with Download preselected**.
- File info covers **the files actually loaded into the scene** — their headers are already parsed
  in memory, so no extra fetching and no risk of documenting a file the user never saw.

## Report contents

1. **Header** — subject id/label, session, dataset (source label + `relativePath`), generation
   timestamp, Viewer version + build id, brainana pipeline version(s) detected.
2. **Source files (loaded)** — one row per asset in the scene: base volume, displayed surface pair,
   morphometry shape files, active atlas, every report-sampled atlas volume, loaded functional map.
   Each row carries role, path, and the brainana version from its JSON sidecar. Volumes expand to a
   full NIfTI header block (`n_dim`, dims, pixdims/resolution + units, datatype + bitpix, intent,
   `scl_slope`/`scl_inter`, `cal_min`/`cal_max`, qform/sform codes, the 4x4 affine, frames,
   endianness). Surfaces report vertex/face counts instead.
3. **View state** — layout, hemispheres shown, base window/clip, active atlas + colormap + opacity,
   morphology metric/style, function map + F-threshold/opacity/range, camera, marker mode.
4. **Current location** — mm, voxel I/J/K, hemisphere, nearest vertex + distance, every atlas's
   id/region/short name, curvature/sulcal depth/thickness, retinotopy (polar, eccentricity, their
   F-stats, visual X/Y, valid voxels, local spread) or somatotopy (body position, F).
5. **Bookmarked points** — summary table plus a detail card per point with full readout and images.
6. **Screenshots** — slice montage and 3D surface as displayed, base64-inlined.
7. **Footer** — citation block and generator stamp.
8. **Machine-readable copy** — the payload as
   `<script type="application/json" id="brainana-report-data">`, so a report can be re-parsed.

## Architecture

New feature directory `apps/viewer/src/report/`, split so the parts that are expensive to test
(DOM, WebGL, network) stay thin and the logic is pure:

| Module | Responsibility |
|---|---|
| `model.ts` | Types: `ReportData`, `LocationReadout`, `FileInfo`, `HeaderInfo`, `ViewState`, `Bookmark` |
| `collect.ts` | Sampling collectors over a `ReportContext` of accessors |
| `header.ts` | `NVImage.hdr` -> `HeaderInfo` (datatype names, units, affine, resolution) |
| `provenance.ts` | Sidecar URL derivation + `GeneratedBy` parsing (fetch injected) |
| `bookmarks.ts` | Session-scoped bookmark store |
| `html.ts` | `buildReportHtml(data)` — no DOM, no fetch |
| `capture.ts` | `capturePane(nv, canvas, maxWidth)` — draw then read, same task |
| `dialog.ts` | Destination picker, bookmark list, progress |

### Sampling separated from rendering

`updateAnatomyReport`, `updateSurfaceReport`, `updateFunctionReport` and `updateOverlayValue` in
`dashboard.ts` currently sample and render in the same function. Duplicating that sampling in the
report would guarantee drift, so `collect.ts` owns the sampling and the four panel updaters render
from the returned structs. One sampling path; the report provably matches what is on screen.

### Reuse

- `ServerExport.saveFile()` / `downloadBlob()` in `packages/core-client/exportDestination.ts` are
  fully built with server routes and had no frontend consumer — this is their first.
- `openFsPicker` (currently private to `dialogs/sources.ts`) takes an injectable `browse` function.
  Extracted to `ui/dialogs/fsPicker.ts` and reused for the save destination with an adapter over
  `ServerExport.listFolders()`.
- Existing `.overlay` / `.dialog` chrome, the `num()` formatter, and the atlas `byId` label maps.

Electron needs nothing extra: `core-desktop/main.mjs` loads the server URL, so desktop and browser
take the identical save path.

### Provenance without a server change

Every pipeline file has a JSON sidecar of the same basename carrying
`GeneratedBy: [{ Name: "brainana", Version: "1.3.0" }]`. Manifest URLs are
`/brainana-data/<sourceId>/<rel>` and `serveData` streams any contained path without extension
gating, so the client fetches `<basename>.json` directly. Lazy, loaded-files-only, zero cost on a
normal subject load. FreeSurfer-derived files have no sidecar; version renders as a dash.

### Screenshots

NiiVue does not set `preserveDrawingBuffer`, so the read must happen in the same task as the draw —
the pattern its own `saveScene` uses. `capturePane` calls `drawScene()` then immediately
`drawImage`s the GL canvas into a downscaled 2D scratch canvas (1400px main / 700px per-bookmark)
and returns a data URL. No `await` between draw and read.

Per-bookmark loop: move crosshair, await one animation frame (clearing `MultiView`'s `#syncing`
guard), capture both panes. Crosshair and camera are restored in a `finally`.

## Testing

Pure modules are unit-tested under the existing `scripts/run-tests.mjs` runner (Node >= 22.18 strips
types on import, as the existing `*_test.mjs` files already rely on): `report_header_test.mjs`,
`report_provenance_test.mjs`, `report_collect_test.mjs`, `report_bookmarks_test.mjs`,
`report_html_test.mjs`. The HTML test asserts self-containment (no external URLs), section
presence, escaping of hostile input, and that the embedded JSON round-trips.

End-to-end verification uses the in-repo `datasets/demo_viewer` subject, a real brainana output with
atlases, somatotopy, morphometry, and sidecars stamped `brainana 1.3.0`.

## Addendum (2026-09-03) — entry points moved to the left rail

The controls this spec placed in the top bar (`+ point`, the count badge, `report`) now live in a
`points` block docked below the `underlay` controls in the left rail (`.vol-rail`). The top bar's
`.tb-cell.report-controls` cell is gone.

Rationale: the toolbar slot could only show a count, so seeing, renaming, or removing a point meant
opening the modal — the only place the list was rendered. The rail is a full-height column, so the
list fits inline, and the export action can carry a label that says what it does.

What the rail adds beyond a relocation:

- A collapsible list (the previously-unused `.group` collapsible from `style.css`) with one row per
  point: ordinal, editable name, coordinate, and two buttons.
- **Jump back to a point** — `view.moveCrosshairToWorld(bookmark.readout.mm)`. That re-emits through
  `onCrosshair`, so the marker, coordinate editor and every info column follow. It restores the
  crosshair position only, not the view state the point was added under.
- **Remove** a point without opening the dialog.
- `report` became `generate report…` with a download icon, so it no longer reads like the view
  toggles it used to sit beside.

The rail is now split into two independently-hidden `.rail-block`s: a subject with no base volume
drops the underlay controls but keeps its points. The rail's own visibility tracks "a subject is
loaded" (`syncReportControls`) rather than "a base volume is loaded" (`syncVolumeControls`).

The store, the readout snapshot, the dialog and the generated HTML are unchanged. Bookmarks stay
session- and subject-scoped, still cleared on a subject switch.
