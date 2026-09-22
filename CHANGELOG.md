# Changelog

All notable changes to Brainana Viewer are documented here.

## [Unreleased]

Support for brainana 3.0.0, whose `anat.synthesis_level` gives a subject more than one
reconstruction. Output from 1.x and 2.x is read exactly as before.

### Added

- **Scan picker** — a second dropdown beside the subject selector, listing that subject's
  reconstructions grouped cross-sectional / longitudinal. A subject has more than one only when
  brainana ran at `synthesis_level: "session"` or `"session_longitudinal"`; with one it stays
  visible but disabled.
- **Longitudinal change maps** — a `change` tab on base-template scans, showing the per-vertex
  rate, temporal mean and symmetrised percent change brainana fits across a subject's timepoints,
  for thickness, area and curvature. Includes a magnitude threshold and a per-ROI fits table.
  Signed maps get a window centred on zero and a *decrease / no change / increase* colorbar.
- **Time-source guardrails** — when `sessions.tsv` carries no `age` or `acq_time` column, brainana
  fits against scan order and the result is a change per **scan**, which looks exactly like a rate.
  The panel pins a note, and the statistic labels, colorbar, crosshair row, ROI table header and
  report all carry the denominator.
- **Twelve matplotlib diverging colormaps** — `coolwarm`, `bwr`, `seismic`, `Spectral`, `RdBu`,
  `RdYlBu`, `RdYlGn`, `RdGy`, `PRGn`, `PiYG`, `BrBG` and `PuOr`. Each has its neutral colour at the
  exact centre of the ramp, so a symmetric window puts zero on it.
- **Reverse toggle** beside the colormap picker, flipping any map end to end — sequential ones
  included, so `viridis` can run bright-to-dark without a second dropdown entry. The reversal is
  carried in the colormap key (`viridis_r`), so it survives into the report and a restored session.
- **The report names its scan**, in prose and in the filename, so two timepoints of one animal
  cannot collide. `base_segmentation_agreement.json` is included when a change map is shown.
- An MGH reader for the change maps, and a guard that withholds any surface overlay whose vertex
  count disagrees with the mesh it would be painted on.

### Changed

- **A longitudinal subject now opens on its base template**, not on a cross-sectional session — the
  change maps live only on the base, so the feature was previously invisible until someone thought
  to change `ses`. The trade-off is deliberate: a base is an unbiased average rather than a scan of
  the animal, and reaching the functional stream or the per-session surface atlases now takes a
  `ses` switch. Subjects without a base template are unaffected.
- **Datasets are addressed as `sub`, not `monkey`** — the dropdown, its placeholder, the empty state
  and the dataset dialog's continue button. The viewer reads BIDS trees, where the entity is `sub-`.
- **The remote-dataset form starts collapsed**, so the local-directory path stays on the first
  screen. It expands itself when a remote source is already registered.
- **Base-space anatomy is labelled `T1w (base template)`**, rather than sharing `T1w (preproc)`
  with a scan of the animal.
- **Bookmarked points are cleared on a scan switch**, as they are on a subject switch, and the
  empty state names what was cleared instead of the list silently emptying.
- **The crosshair is restored across a scan switch only when the two share a frame** — a base
  template and its base-seeded timepoints do; two cross-sectional sessions do not.
- The colormap swatch and the colorbar track are square: both sample a continuous ramp, and a
  diverging map is read by its extremes. Categorical ROI chips keep their rounded corners.
- The change tab separates its ROI fits table from the map controls with a border and a **ROI fits**
  title, matching the atlas legend.

#### Manifest API

- Gains `scan`, `scans`, `synthesisLevel`, `warnings` and `longitudinal`. `id`, `label` and
  `session` are unchanged, and a pre-v3 tree's manifest is otherwise byte-identical.
- `GET /manifest/<sub>` accepts `?scan=<id>`. An id naming no reconstruction of that subject is a
  **404**, never a silent fallback to a different scan.
- **Behaviour change for API consumers:** with no `?scan=`, a longitudinal subject's manifest now
  returns the base template where it previously returned a cross-sectional session. The shape is
  additive; the content of a default request is not.
- `Manifest.surfaces.veryinflated` dropped from the type — the server has never emitted it.

### Fixed

- **A `session_longitudinal` tree rendered nothing at all** — no anatomy, no surfaces, no atlases.
  Such a run publishes a subject-level `anat/` holding only `space-base` products, which anat
  resolution preferred over the sessions before failing to find a matching T1w.
- **Sessions after the first were unreachable.** Anat resolution took the first `ses-*/anat` and
  nothing in the UI said the others existed.
- **Remote datasets with a session-keyed reconstruction had no surfaces.** The SFTP mirror
  hardcoded `fastsurfer/<subjectId>`, which brainana only writes when a subject has one session
  with anatomy. Mirroring is now scoped to the reconstructions the selected scan needs, so a
  longitudinal subject's five recon trees are not all copied.
- **Two sessions of one subject shared a derived-asset cache directory**, a collision that survived
  a reload. Keyed by reconstruction now; a pre-v3 tree keeps its existing cache directory name.
- A session-keyed reconstruction now wins over a stale subject-keyed one when both exist.
- **The top bar broke its own controls apart in a narrow window** — most visibly the **CHANGE** tab
  dropping onto a second line under **ATLAS**, at the desktop app's *default* 1440px width. Whole
  control groups now wrap intact rather than splitting mid-group, and nothing is clipped or hidden
  at any width. Below 1460px the bar compacts; the marker `size` / `mode` micro-labels are clipped
  visually only, keeping their accessible names and gaining a tooltip.
- **Every colormap swatch showed a sliver of the wrong colour down each edge** — the map's last
  colour on its left edge and its first on the right. Latent since the picker was written, and only
  obvious once the diverging maps arrived.
- **Signed change maps were painted on a gray ramp.** The change tab asked for `bwr`, which NiiVue
  0.69 does not ship; it substituted a black-to-white ramp. Because that substitute is non-null, the
  panel's "show nothing rather than the wrong colours" guard never fired, so the map looked
  plausible while having no diverging midpoint at all.
- **"change", "rate of change" and "slope" were three names for one or two quantities.** The ROI
  table's column is now **rate** (the CSV's own `slope` moved to its tooltip), the threshold names
  the statistic and unit it masks (`|rate| ≥ (mm per year)`, `|% change| ≥`, `|mean| ≥ (mm)`), and
  the column matching the map on the surface is highlighted. The old fixed `|change| ≥` was
  outright wrong for the temporal mean, where thresholding hides thin cortex, not small change.
- **The ROI table silently stacked several FreeSurfer stats per ROI** — *thickness* listed every ROI
  twice (`ThickAvg` and `ThickStd`) with no way to tell them apart, and *area* mixed `SurfArea`
  (mm²) with `GrayVol` (mm³) in a single magnitude sort. It shows one stat at a time now,
  defaulting to the one whose vertex map is on the surface, with a `stat` picker for the rest.
- **The change panel opened describing a map it was not showing**, leaving the surface empty until
  you nudged a dropdown. It opens on **none** now, like the atlas and funcmap panels.
- **Long ROI names were unreadable** in a narrow change tab. The table scrolls sideways with its
  header now.
- **The change panel stacked stale empty-state copy on scan switches.** The copy now distinguishes
  "pick base template in `ses`" from a dataset with no longitudinal outputs at all.
- **Server errors no longer leak absolute filesystem paths.** A failure to write the derived-asset
  cache returned Node's error message verbatim, which embeds the path it failed on.
- The FOV tooltip no longer suggests reprocessing to get a full-FOV conform for a longitudinal
  reconstruction, which never has one.

## [1.0.0] — 2026-07-18

First public release of the Brainana Viewer as a cross-platform desktop app.

### Added
- **Core platform layer** (`packages/core-*`), tool-agnostic and reusable:
  - `runtime.mjs` — HTTP server factory that binds `127.0.0.1` and guards `/api/*`
    and data routes with a per-launch session token.
  - `security.mjs` — session token (timing-safe compare) + path containment helpers.
  - `dataSource.mjs` — `DataSource` interface + in-process source registry; the server
    starts **unbound** and holds `Map<sourceId, DataSource>`.
  - `localSource.mjs` — local filesystem data source.
  - `sftpSource.mjs` / `sftpClient.mjs` — non-blocking remote source over `ssh2`/SFTP
    (SFTP subsystem only; no code runs on the workstation), with an async cache.
  - `cache.mjs` — async remote-file cache (sha256 + size + mtime), atomic writes.
  - `export.mjs` — server-side save-list / mkdir / save-file, atomic temp + rename.
  - `packages/core-launcher/launch.mjs` — cross-platform launcher (free-port scan, token, open browser).
- **Viewer domain layer** (`apps/viewer/server/`): `manifest.mjs` + `freesurfer.mjs`, with
  flexible anat/fastsurfer discovery (flat `sub-*/anat` or session `sub-*/ses-*/anat`).
- **Source-scoped file URLs** (`/brainana-data/<sourceId>/<rel>`) enabling simultaneous
  multi-source loading; server binds loopback only and requires the session token.
- **Client platform layer** (`packages/core-client/`, TS): `runtimeClient` (token from meta tag →
  authed fetch), `sourceManager` (add/list/remove sources), `filesystemClient`
  (monkeys/manifest/browse per source), `sessionPersistence` (recents, no secrets),
  `exportDestination` (server-side export + ZIP fallback), `browserCapabilities` (WebGL2 gate).
- **In-app source chooser** (`apps/viewer/src/`): add local + remote sources and browse each
  source's subjects with a manifest summary, no relaunch. Vite build → `dist/`.
- `scripts/generate-version.mjs` — single source of version + build id.
- **Bundled demo dataset** (`datasets/demo_viewer/`): a trimmed `sub-example` derivatives
  tree (only Viewer-read files; FastSurfer intermediates and regenerable cache omitted) so
  the Viewer can be launched without preprocessing a subject. README, `dev_guideline.md`, and
  `data-contract.md` now point at it (`npm run server -- --output-dir datasets/demo_viewer`).
- CI skeleton (macOS/Linux/Windows matrix); headless tests for server, security, sftp,
  and the built frontend (token injection).
- **Desktop packaging + release pipeline**: electron-builder config
  (`apps/viewer/electron-builder.yml`) and a tag-triggered GitHub Actions release matrix
  (`.github/workflows/release.yml`) that builds Mac (Apple Silicon + Intel), Windows, and Linux
  installers and publishes them to a draft GitHub Release. Procedure: `docs/publishing.md`.

- **Phase 2 unified data path**: `packages/core-client` source manager + in-app source chooser
  (`apps/viewer/src/ui/dialogs/sources.ts`); simultaneous multi-source, source-scoped throughout.
- **Phase 3 NiiVue frontend (substantial)**: dual-instance `MultiView` renderer, surfaces,
  generic atlas overlays (ARM1-6, D99, MacBNA, FuncNetwork, and continuous scalar atlases such
  as CortHierarchy), retinotopy/somatotopy with F-threshold masking, morphology shading,
  yellow-marker modes, visual-field plot, and the unified Color-display section.
- **Generic atlas discovery + continuous atlases**: the manifest `atlases` field is now a flat
  array of `{name,label,volume,labels,surface}` built from every `atlas-<name>_space-*` label
  volume on disk (ARM ordered first), replacing the hardcoded `{charm,d99}` object. Float scalar
  atlases (e.g. CortHierarchy) are detected as non-parcellations and rendered with a continuous
  colormap over their nonzero value range on both the slices and the 3D mesh; atlas `.tsv`
  sidecars may carry an optional `color` column honored over the procedural golden-angle color.
- **Remote pre-add browse + source rename**: `POST /api/remote/connect`, `GET /api/remote/browse`,
  `POST /api/remote/disconnect` (a transient SSH/SFTP session for browsing a workstation before
  adding it — password sent once, never persisted) and `PATCH /api/sources/:id` to set a
  per-source `customLabel`.
- **Source dialog upgrades**: browse a remote host's folders before adding it, editable custom
  labels per source, a resizable dataset table, and saved remote connection profiles
  (host/port/user only; no passwords).
- **View preservation**: camera, active overlays (atlas/function/morphology), and display
  settings carry over when switching between subjects, so two monkeys compare 1:1.

### Known limitations
- **Unsigned installers** — no Apple Developer ID / Windows code-signing certificate yet, so
  macOS and Windows show a one-time "unidentified developer" prompt on first launch (see README).
- **Imported-volume surface projection & ROI generation** are staged and unit-tested in
  `packages/imaging-math/{projection,roiWarp}.ts` (a `projectionClient` + worker exists) but are
  not yet driven from any panel; snapshot/state/ZIP export UI is likewise not yet wired.
- The full **cross-browser / automated test matrix** (roadmap Phase 5) is still in progress; the
  desktop Electron build and the headless server/security/sftp/frontend tests are the current gate.
