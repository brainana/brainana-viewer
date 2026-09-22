# Data contract: brainana outputs the Viewer reads

The Viewer is a **consumer** of a brainana derivatives tree. A local or remote `DataSource` serves
per-subject files, and the Viewer's manifest builder (`apps/viewer/server/manifest.mjs`, with scan
enumeration in `viewTargets.mjs`) discovers the on-disk layout and hands the browser a per-scan
manifest of URLs. This page documents which outputs each Viewer feature needs, how a subject's
reconstructions are enumerated, and the space-selection rule for overlays.

Supports brainana output from 1.x through 3.0.0.

Only a small subset of a brainana run is consumed. Everything not listed here (JSON/`.bib`/`.md`
sidecars, QC `figures/`, the `func/` BOLD series, `nextflow_reports/`, most FreeSurfer
intermediates) is ignored.

> **Concrete example.** [`datasets/demo_viewer/`](../datasets/demo_viewer/) is a committed,
> minimal real instance of this contract — the `sub-example` subject trimmed to exactly the
> files below (intermediates and the regenerable cache omitted). Use it to see the layout in
> practice or to launch the Viewer without your own data.

## Expected layout

brainana's `anat.synthesis_level` decides how many reconstructions a subject has and where they
live. All three shapes are handled, and one dataset can mix them — a subject whose raw data had no
sessions keeps a flat layout beside one that did.

```
<root>/
  sub-<id>/                              subject dir; name MUST start "sub-"
    anat/         OR  sub-<id>/ses-<n>/anat/     (flat OR BIDS session — both handled)
      <prefix>_space-T1w_desc-preproc_T1w[_brain].nii.gz    base anatomy
      <prefix>_from-*_to-*_mode-image_xfm.{nii.gz,mat}      transforms (see note)
      atlas_space-fsnative/   atlas_space-T1w/   atlas_space-scanner/
  fastsurfer/sub-<id>[_ses-<n>]/
    surf/          FreeSurfer surfaces + morphometry
    mri/*.mgz      selectable base volumes
```

Under `session_longitudinal` there is additionally a subject-level `anat/` holding the base-space
products, and two further kinds of reconstruction:

```
  sub-<id>/anat/
    sub-<id>_space-base_desc-brain_T1w.nii.gz              the base template
    atlas_space-base/       atlas_space-fsnative/          (both are BASE-mesh assets)
  fastsurfer/sub-<id>_base/            the within-subject template, and the change-map fits
  fastsurfer/sub-<id>_ses-<n>_long/    one per timepoint, in base space
```

A directory is treated as a subject only when its name starts `sub-` **and** an `anat/` directory is
found (flat, or under the first `ses-*`). The gate checks only that the directory **exists**, not its
contents — so any subject with an `anat/` (e.g. one holding `atlas_space-fsnative/`) is listed, and a
subject without a resolvable `anat/` is not.

## Scans: the unit the Viewer renders

A **scan** is one reconstruction, with the anat, atlas and recon directories that belong together.
Discovery is driven entirely by the tree; `nextflow_reports/config.yaml` is read only as a display
string, because it is absent from remote mirrors and partially-copied trees.

| stream | id | anat / atlas dir | recon | mesh |
|---|---|---|---|---|
| `cross` (flat) | `sub-X` | `sub-X/anat/` | `fastsurfer/sub-X/` | its own |
| `cross` (session) | `sub-X_ses-Y` | `sub-X/ses-Y/anat/` | `fastsurfer/sub-X_ses-Y/` | its own |
| `base` | `sub-X_base` | `sub-X/anat/` | `fastsurfer/sub-X_base/` | base |
| `long` | `sub-X_ses-Y_long` | `sub-X/anat/` | `fastsurfer/sub-X_ses-Y_long/` | base |

Requested with `GET /api/sources/:id/manifest/<subjectId>?scan=<id>`; omitted means the subject's
default, which is the **base template** where the subject has one and the first cross-sectional
scan otherwise. The base carries the change maps, and the change tab is hidden on a scan without
them, so defaulting to a cross-sectional session left the whole longitudinal feature invisible
until someone thought to change `ses`. The cost is real and accepted: a base is an unbiased average
rather than a scan of the animal, and the functional stream and the per-session surface atlases are
registered to the cross-sectional scans, so reaching those takes a `ses` switch. A subject with no
base template is unaffected, and so is every pre-v3 tree.

An id naming no reconstruction of that subject is a **404**, never a silent fallback to a
different scan. Ids are matched against the enumerated set and never parsed into a path.

Two shapes that look like edge cases and are not:

- **The recon directory collapses.** brainana names it `sub-X_ses-Y` only when the subject has
  several sessions with anatomy; with one it is `sub-X`, even though the anat sits under `ses-Y/`.
- **A `ses-*/anat/` does not imply a scan.** A session whose anat holds only T2w derivatives, with
  no reconstruction of its own, is not offered.

> ### `atlas_space-fsnative` means two different things
>
> At `sub-X/anat/` in a longitudinal tree it is the **base** mesh's projection; at
> `sub-X/ses-Y/anat/` it is that **session's cross-sectional** mesh. Same directory name, different
> meshes, and on the dev-test subject they have different vertex counts (11597 vs 11725).
>
> This is why there is **no cross-directory fallback** for surface overlays anywhere in the
> manifest builder: a mispaired overlay is an array of the wrong length, not a slightly-off
> picture. When a scan's own atlas directory is absent the surface overlay is `null`. The manifest
> also checks each overlay's `Dim0` against the mesh's vertex count and withholds a mismatch, with
> a line in the top-level `warnings` array.
>
> Volumes are safer: each affine maps its own grid into a shared world space, so NiiVue aligns them
> correctly even across grids. They are still grouped by scan, because base space and a session's
> space differ by that timepoint's rigid transform to the base.

## Feature → required (R) / optional (O) inputs

| Feature | Inputs |
|---|---|
| **Anatomical view** (slice base) | **R** at least one base volume. The default base is `fastsurfer/<sub>/mri/norm.mgz` (fsnative — same space as the surfaces); any `mri/*.mgz` is selectable. **O** the preprocessed T1w adds a "T1w (preproc)" option — first of `space-T1w_desc-preproc_T1w_brain.nii.gz` → `…_T1w.nii.gz` → `desc-preproc_T1w.nii.gz` → `desc-preproc_brain.nii.gz` → `space-scanner_T1w.nii.gz` — and becomes the base only when no `mri/*.mgz` exists. |
| **Cortical surfaces** | **R** `surf/{lh,rh}.pial` (prefers `.pial.surf.gii`). **O** `white`, `smoothwm`; server-derived `inflated`, `sphere`. |
| **Morphology shading** | **O** `surf/{lh,rh}.{curv,sulc,thickness}` (rendered via server-generated `.shape.gii`). |
| **Atlas overlay** | **R** per atlas: a volume `atlas-<name>_space-<space>_*.nii.gz`. Integer volumes are categorical parcellations; float scalar volumes (e.g. `CortHierarchy`) are rendered as a continuous colormap, not ROI labels. **O** `atlas-<name>.tsv` LUT (region names for report/legend, plus an optional `color` column — hex `#RRGGBB` or an RGB triple — honored over the procedural golden-angle color; without a LUT the atlas still renders with derived-ID colors). **O** surface pair `atlas-<name>_space-fsnative_hemi-{L,R}*.func.gii`. |
| **Retinotopy / somatotopy** | **R** 4-D map `atlas-retinotopy_space-<space>_*.nii.gz` (frames polar/polarF/eccentricity/eccentricityF) and `atlas-somatotopy_space-<space>_*.nii.gz` (frames phase/fstat). **O** the matching fsnative surface pair. Drives the functional report, F-threshold masking, and the visual-field plot. |
| **Longitudinal change maps** *(base scans only)* | **R** `fastsurfer/sub-X_base/surf/?h.long.<measure>-{rate,avg,spc}.mgh` — uncompressed MGH, per-vertex float32, for `thickness`, `area` and `curv`; converted server-side to `.shape.gii` beside the morphometry cache. **O** `stats/?h.long.roi-rates.csv` (the ROI table), `stats/long.change-stats.json` (timepoints and **`time_source`**), `scripts/base_segmentation_agreement.json` (per-timepoint Dice). |

Atlas names in the macaque pipeline: `ARM1`…`ARM6`, `D99`, `MacBNA`, `CortHierarchy` (continuous
scalar), `FuncNetwork`, plus the functional `retinotopy`/`somatotopy`. Discovery is generic — any
`atlas-<name>_space-*` volume is picked up — and atlases are ordered `ARM<n>` first (numeric), then
alphabetical.

## Overlay space-selection rule

The default slice base is the FreeSurfer conformed volume `norm.mgz`, which is in **fsnative**
space — the same space as the surfaces. Atlas and functional **volume** overlays are therefore
sourced to match that space so they are voxel-aligned to the base and need no resampling.

- The Viewer picks **one** atlas space directory per scan, in priority order
  **`atlas_space-fsnative` → `atlas_space-T1w` → `atlas_space-scanner`** (the first that contains an
  atlas label volume). A `base` or `long` scan prefers **`atlas_space-base`** ahead of those, and
  resolves all of them under the subject-level `anat/` rather than a session's.
- **All** volume-side assets — the atlas label volume, its `.tsv` LUT, and the retinotopy /
  somatotopy functional volumes — come from that single chosen directory. There is no per-file
  fallback to another space: if the chosen directory lacks a `.tsv`, the atlas simply renders with
  derived-ID colors, exactly as when a LUT is absent.
- The atlas **surface** overlay is the one exception: surface `func.gii` data exists only in
  fsnative space, so it is always read from `atlas_space-fsnative`, independent of which space the
  volume was chosen from (and is absent when that directory is not present) — from the scan's own
  `atlas_space-fsnative`, which for `base` and `long` is the subject-level one.

Because brainana emits atlases uniformly across all three spaces, current runs resolve to
`atlas_space-fsnative` and the overlays render without any transform. Older runs that predate the
fsnative backprojection fall back to `atlas_space-T1w` (then `atlas_space-scanner`) with identical
behavior to before.

> **Note — transforms.** The manifest still exposes a `transforms` block (scanner / template /
> NMT2Sym warps discovered from `*_mode-image_xfm.*`). It is retained for future imported-volume
> projection / ROI work and is not needed by the display path above.

## Minimal viewable subject

Two separate thresholds:

- **To appear** in the subject list: a `sub-*/` with an `anat/` directory (contents irrelevant).
- **To appear in the scan picker**: that reconstruction must have a base volume, an
  `atlas_space-*/` directory, or a `surf/` in a recon directory of its own.
- **To render a base volume**: at least one volume — normally `fastsurfer/<sub>/mri/norm.mgz`, else
  a preprocessed `*_T1w.nii.gz` in `anat/`.

In practice a subject with **`fastsurfer/` (surf + `mri/norm.mgz`) and `anat/atlas_space-fsnative/`**
is fully viewable — base volume, cortical surfaces, atlas overlays, and (if present) the retino/somato
maps — with **no** preprocessed `*_T1w.nii.gz` required. The T1w preproc only adds the "T1w (preproc)"
base-volume option. Everything beyond that first volume is additive.
