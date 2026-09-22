# Colormap Management

**Scope:** `apps/viewer` — how the Viewer chooses, stores, and applies colormaps for every colored
layer (base volume, morphology, functional maps, atlases), and how the **volume slices** and the
**3D surface** are kept color-consistent.
**Date:** 2026-07-18

> Companion to [technical-route.md](technical-route.md). This doc is the single reference for
> colormap behavior. If you touch coloring, read §7 (invariants) before editing.

---

## 1. Mental model

Three layers, in order:

1. **Registry** — the catalog of available colormaps (Brainana custom + NiiVue built-ins), each with
   a preview gradient and a sampled 256-entry RGBA LUT.
2. **Per-overlay state** — each overlay type (morphology / function / atlas) owns a small piece of
   dashboard state: which colormap key is active, its display window, and its clip.
3. **Apply** — one call per overlay pushes that state to **both** the volume slices and the 3D
   surface through a shared LUT/colortable path, so slices and mesh always match.

Two **rendering modes** exist underneath every colored overlay:

- **Ramp** (continuous): scalar values → a smooth colormap. Used by morphology, functional maps, and
  continuous atlases.
- **Labels** (categorical): integer ids → a per-id color table. Used by parcellation atlases.

The surface layer is *always* driven by a **256-entry categorical LUT** (NiiVue mesh `colormapLabel`),
even in ramp mode — a continuous colormap is sampled into 256 bins so the mesh and the slices derive
identical colors. Bin 0 is reserved **transparent** everywhere (the no-data / masked slot).

---

## 2. The registry

| Concern | Where | Notes |
|---|---|---|
| Custom Brainana colormaps (stops) | `niivue/colormaps.ts` | `ECCENTRICITY_STOPS`, `SOMATOTOPY_STOPS` (reversed eccentricity), `POLAR_STOPS` (cyclic wheel), `POLAR_LR_STOPS` (L/R split), `CURVATURE_BINARY`. Assembled into `COLORMAPS` and installed with `registerColormaps(nv)`. |
| matplotlib diverging maps | `niivue/colormaps.ts` | `DIVERGING_STOPS` — the twelve matplotlib diverging maps (`coolwarm`, `bwr`, `seismic`, `spectral`, `rdbu`, `rdylbu`, `rdylgn`, `rdgy`, `prgn`, `piyg`, `brbg`, `puor`), from matplotlib's own anchors. NiiVue ships only `blue2red`. They join `COLORMAPS`, so `registerColormaps(nv)` installs them too. |
| Reversed twins | `niivue/colormaps.ts` + `data/colormap.ts` | `reverseColormap(rgba)` / `registerReversed(nv, keys)` build a `<key>_r` for every map; `MultiView.registerReversedColormaps` installs them on **both** instances. Key helpers (`reversedKey`, `baseColormapKey`, `toggleReversedKey`, `isReversedKey`) are pure and live in `data/colormap.ts`. |
| Sampling to previews + LUTs | `niivue/colormaps.ts` | `buildColormapAssets(nv, keys)` samples each registered map once into `{ gradients, luts }`. `availableColormaps(nv)` lists what NiiVue knows. |
| Catalog metadata | `data/colormap.ts` | `ColormapInfo` (key/label/group), `BRAINANA_COLORMAPS`, `BUILTIN_COLORMAPS`, `COLORMAP_REGISTRY`, group ordering (`GROUP_ORDER`), `buildColormapRegistry(availableKeys)` (Brainana first, then whatever NiiVue reports), and preview helpers `gradientFromStops` / `gradientFromRgba`. |
| Runtime asset store | `ui/dashboard.ts` | `colormapLuts`, `colormapGradients`, `colormapInfos` — built once after the view exists (from `buildColormapAssets` + `buildColormapRegistry`) and handed to the color-display picker. Live fallback for an unsampled key: `view.colormapLut(name)` (`multiView.ts`). |

The Brainana keys you will see referenced: `brainana_polar_lr`, `brainana_polar_angle`,
`brainana_eccentricity`, `brainana_somatotopy`, `brainana_curvature`.

**Reversal rides in the key.** `viridis_r` is a real registered colormap, not a flag — so every
apply path (volume `setColormap`, native mesh `layer.colormap`, the sampled-LUT path), the report
and the session snapshot carry it with no extra plumbing. The split that makes this work: **`colormapInfos`
is what the picker LISTS (base maps only), `colormapGradients`/`colormapLuts` is what can be
RENDERED (both directions)**. `buildColormapRegistry` filters reversed keys out of the list, and the
colour dock's `reverse` toggle rewrites the active key through the *same* `onColormap` handler.

**A diverging map's neutral colour must sit at index 128.** `buildColormap` spaces stops evenly over
1..255, so that holds exactly when a map has an **odd** number of stops — which is why every entry in
`DIVERGING_STOPS` has one, and why `tests/colormaps_test.mjs` asserts it. Signed overlays pair these
with `symmetricRobustRange`, and it is that pairing that puts zero on the neutral colour.

---

## 3. Per-overlay reference

| Overlay | State (dashboard) | Default source | Volume apply | Surface apply | Reset |
|---|---|---|---|---|---|
| **Morphology** | `morphColormaps[metric]` (+ `morphRanges`, `morphSymmetric`, `morphClip`) | `MORPH_DEFAULT_COLORMAP` — **single source of truth**, defined in `multiView.ts`, imported by the dashboard | *(none — morphology is surface-only)* | `applyMorphologyDisplay()` → NiiVue **native mesh `layer.colormap`** string (`multiView.ts` `#morphColormap`, `#morphSpecs`) | per-metric via `MORPH_DEFAULT_COLORMAP` / `MORPH_DEFAULT_RANGE` / `MORPH_DEFAULT_SYMMETRIC` |
| **Function map** | `funcColormap: string \| null` (+ `funcCalMin/Max`, `funcClipLo/Hi`, `funcThreshold`, `funcOpacity`, `funcBrightness`) | per-mode `mode.colormap` in `data/functional.ts`; effective key = `funcColormapKey()` = override ?? mode default ?? `'gray'` | `applyFunctional(...)` (`multiView.ts`) — value remapped via `mapFunctionalDisplay` | `applyFunctionSurface()` → `setFunctionSurface(...)`; LUT from `surfaceLutFromColormap` (ramp) or `createFunctionalSurfaceLut` (retinotopy) | `funcColormap = null` (back to mode default) + natural range, no clip |
| **Atlas** | `atlasColormap: string \| null` (+ `atlasDisplayMin/Max`, `atlasClipLo/Hi`, `atlasContinuous`, `atlasDomain`) | categorical by default (`null`); continuous atlases → `CONTINUOUS_DEFAULT = 'magma'` | `applyAtlasColormap()`: ramp → `setAtlasContinuous`; labels → `setAtlasColortable(buildLabelColortable(...))` | ramp → `setAtlasSurfaceContinuous`; labels → `updateSurfaceOverlayTable(buildLabelColortable(...))` | `atlasContinuous ? CONTINUOUS_DEFAULT : null` + full range, no clip |

The **base volume** (underlay) is grayscale with an intensity window + optional value clip
(`setVolumeWindow` in `multiView.ts`); it is not a colormap overlay and is out of scope here except
that its window/clip share the same UI idiom.

### 3.1 Morphology
Surface-only continuous shading of `.shape.gii` data (curvature/sulc/thickness). Binary curvature is
a fixed 2-tone LUT (`brainana_curvature`) and is **not** overridable; continuous layers use
`#morphColormap(metric)` = display override ?? `MORPH_DEFAULT_COLORMAP[metric]`. Unlike func/atlas,
morphology recolors via NiiVue's **native mesh colormap** (a colormap *name* on the layer), not a
manually-sampled categorical LUT — it does not need bin-0 transparency or quantization.

### 3.2 Function maps (retinotopy / somatotopy)
Modes come from `functionalModes(kind, frames)` (`data/functional.ts`): retinotopy → `polar`
(`brainana_polar_lr`) + `eccentricity` (`brainana_eccentricity`); somatotopy → `bodyPosition`
(`brainana_somatotopy`).

- **Volume**: `cal_min`/`cal_max` are pinned to the map's *natural* range (keeps index-0 transparent
  for masking); the user **display window** (`funcCalMin/Max`) is applied as a **color remap**
  (`mapFunctionalDisplay`) so narrowing it changes contrast without hiding voxels.
- **Surface**: `quantizeFunctionalSurfaceValues(value, mode, range)` quantizes per-vertex values into
  bins 1..255. **`range` is the display window for maps that expose one (somatotopy), and `undefined`
  for retinotopy** (which keeps its fixed cyclic/natural domain). This is what makes the somatotopy
  surface track the slices when you drag display min/max — the surface `range` mirrors the volume's
  remap so both map a value's position within `[min,max]` to the same bin.
- **Masking**: F-threshold (`maskSurfaceBinsByF` / volume sentinel) then value clip
  (`maskSurfaceBinsByValue`) hide the same vertices/voxels on both sides.
- **Legend shape**: polar → wheel, eccentricity → rings, everything else → bar
  (`legendShapeForFunc`). Somatotopy's bar is anchored with anatomy ticks `foot / hand / face`.

### 3.3 Atlases
See §5.

---

## 4. Volume ↔ surface consistency

The cardinal rule: **a color change must recolor both the slices and the mesh, in one action**, or
they silently desync.

- **Function**: `applyFunctionColor()` is the single entry point — it calls `applyFunctional`
  (volume) **and** `applyFunctionSurface` (surface). Every mutation site (colormap, display range,
  clip, threshold, reset, map switch) calls it, so no caller has to remember to pair the two.
  Exactly **one** `applyFunctionSurface` pass per action (see the func-surface race in §7).
- **Atlas**: `applyAtlasColormap()` fans out to volume + surface in one call (ramp or labels).
- **Morphology**: surface-only, so `applyMorphologyDisplay()` is the single call — there is no volume
  side to keep in sync (documented, not a bug).

The **shared bridge** from "a continuous colormap" to "a mesh/volume categorical table" is
`MultiView.#surfaceColortableFromColormap(cmapLut)` = `#lutToColortable(surfaceLutFromColormap(cmapLut).lut)`,
used by the atlas volume, the atlas surface, and (via a pre-built LUT) the function surface — so all
three derive identical colors from the same colormap. Categorical atlases instead build their table
from authored/procedural ROI colors via `buildLabelColortable` (`data/atlas.ts`). Both feed the one
mesh choke point `#applyLabelLutAt`.

---

## 5. Atlas coloring in detail

### 5.1 Continuous vs categorical detection
Decided purely from the **voxel data**, not the atlas name or datatype, in
`#prepareAtlasLabelState` (`multiView.ts`):

- If **any** voxel is non-integer → **continuous** (`atlasIsContinuous()` true) → default colormap
  `CONTINUOUS_DEFAULT = 'magma'`, rendered as a ramp on both slices and surface.
- Else **categorical** → the per-ROI label table; `atlasColormap = null`.
- The value/id extent is `atlasValueRange()` (`atlasDomain`), used as the display/clip domain.

In the real pipeline output, ARM1–6, D99, MacBNA, and FuncNetwork are categorical; **CortHierarchy**
is the one continuous atlas (a 0–2 scalar) → magma.

### 5.2 The color policy — authored color always wins
Single source of truth: `labelColor(l, seed)` in `data/atlas.ts`:

```ts
return l.color ?? roiColor(l.id, l.region, seed)
```

- If a TSV row supplies a `color` cell (parsed by `parseAtlasTsv` → `AtlasLabel.color`, accepting
  `#RRGGBB`, `#RGB`, and `[r g b]` triples), that authored color is used.
- Otherwise a procedural golden-angle color (`roiColor`, `data/colors.ts`), which also carries the
  WM/CSF tissue special-cases (matched by TSV `region`, **not** atlas name).

This is deliberate and **not name-special-cased**. Consequences by design:

- **ARM4** and **FuncNetwork** ship a `color` column, so they render authored ROI colors.
- **ARM1/2/3/5/6** have no `color` column, so they render procedural colors — i.e. ARM4 looks
  different from its siblings. That is the policy working ("honor authored colors whenever present"),
  not a bug. Consistency here means *the rule* is uniform, not *the appearance*.

`buildLabelColortable(entries, { seed, hidden, clipNegative })` turns entries into the `{R,G,B,A,I}`
label colortable for slices and surface, honoring the hidden set (see §6.2).

### 5.3 The synthetic `labels` colormap key
The atlas colormap picker offers a synthetic entry keyed `LABELS_KEY = 'labels'`, **labelled `none`**
with a neutral swatch — a categorical atlas has no continuous colormap; its colors come from the
per-ROI label table (the ROI list). It is injected into `colormapInfos`/`colormapGradients` and
filtered out of the morphology/function pickers (they are ramp-only). `atlasColormap === null` **is**
labels mode; picking a real colormap switches the atlas to a continuous ramp; picking `none` switches
back. In labels mode the color-display panel collapses to just the picker ("none"): the **legend**
(`showLegend: false`), **display range** (`showDisplayRange: continuous`), and **clip**
(`clip: continuous ? 'range' : 'none'`) are all hidden, because a gradient bar / value window over
label ids is meaningless — the ROI list above is the legend and the visibility control. See §8 for the
planned cleanup.

---

## 6. Display range & clip

Both are exposed through the unified **color-display** panel (`ui/components/colorDisplay.ts`), driven
by `refreshColorDisplay()` which builds a `ColorDisplayTarget` per active overlay, and routed back via
`colorDisplayCallbacks` (`onColormap` / `onDisplayRange` / `onClipRange` / `onReset`).

Display range and clip belong to a **continuous colormap (ramp)**. They are shown only when the active
overlay renders as a ramp; they are **hidden in labels mode** (categorical atlas, colormap "none").

### 6.1 Display range (contrast window)
- **Morphology / continuous atlas / somatotopy**: editable min+max; remaps contrast, never hides.
- **Retinotopy** (polar/eccentricity): **hidden** — fixed cyclic domain (`showDisplayRange` is gated
  on `kind !== 'retinotopy'`).
- **Categorical atlas (labels mode)**: **hidden** (`showDisplayRange: continuous`) — colors come from
  the label table, not a ramp, so a display window is inert. It reappears if you pick a real colormap
  (which switches the categorical atlas to a continuous ramp of its label ids).

### 6.2 Clip (hide out-of-window)
- **Continuous overlays** (func, morphology, continuous atlas — including a categorical atlas forced to
  a ramp): voxels/vertices whose value is outside `[lo, hi]` are masked to the transparent bin
  (`maskSurfaceBinsByValue`, and the volume sentinel/quantizer).
- **Categorical atlas (labels mode)**: **no clip** (`clip: continuous ? 'range' : 'none'`) — hiding
  ROIs is done by the **ROI list** (search + per-ROI toggles + show/hide/invert), which is more precise
  than a numeric id window. (An earlier build folded an id-clip into the hidden set; that was removed
  in favor of the ROI list.)

### 6.3 Layout
The display and clip rows share one 3-column grid (`.display-clip-grid` in `style.css`: a `44px` label
gutter + two `1fr` columns for the min/max sides). The "display" / "clip" titles (`.dcg-label`) sit in
the left gutter with each control's `minSide` / `maxSide` (from `rangeControl`) aligned on the same
grid edges, so both rows line up and each is compact. A hidden side (`showDisplayRange === false`, or a
hidden clip) simply blanks its grid cells.

---

## 7. Invariants & gotchas (read before editing)

1. **Bin 0 is transparent, everywhere.** Every surface LUT reserves index 0 for masked/no-data
   vertices (`surfaceLutFromColormap`, `createFunctionalSurfaceLut`, `quantize*`). A layer that keeps
   its default `colormap: 'gray'` has bin 0 = **opaque black**, which blacks out the whole surface —
   which is exactly why `#applyLabelLutAt` must succeed (its failure is now logged via
   `console.warn`, not swallowed).
2. **Reversal must not move index 0.** `reverseColormap` flips entries 1..n-1 and leaves index 0
   exactly where it is. Index 0 is the reserved masked / no-data *slot*, not a colour — reversing it
   along with the rest would drop transparency into the middle of the ramp and paint the map's first
   colour onto every masked vertex.
3. **`makeLabelLut` clamps ids above `global_max`.** NiiVue builds the mesh LUT with
   `makeLabelLut(table, 255, layer.global_max)`; ids above `global_max` collapse to one color. For
   split-id atlases (e.g. MacBNA left ≤152 / right up to 304, D99) `#applyLabelLutAt` **forces** each
   layer's `global_max` to span the colortable so both hemispheres get the full LUT. Do not remove
   that.
4. **Never fire two concurrent `applyFunctionSurface()`.** The function surface layer inits with
   `colormap: 'gray'` and the transparent colortable is applied afterward; a second concurrent call
   can lose the race and leave the gray colormap (opaque black). `selectFunction` applies the surface
   exactly once (via `applyFunctionColor`); restore/override settings are threaded *through*
   `selectFunction(choice, preserve)`, never applied by a second pass.
5. **Volume `cal_min`/`cal_max` for func stay at the natural range.** Display windowing is a color
   remap (`mapFunctionalDisplay`), not a cal change — this keeps index-0 reserved for masking. The
   surface mirrors it via the `range` arg to `quantizeFunctionalSurfaceValues`.
6. **Same colormap → same colors on vol + surf.** Continuous overlays must both go through
   `#surfaceColortableFromColormap` (or the same sampled LUT) and the same `quantizeScalarToBins`
   quantization, or the mesh and slices drift apart.

---

## 8. Cookbook

- **Add a colormap**: add stops + a `COLORMAPS` entry in `niivue/colormaps.ts` (custom) or rely on a
  NiiVue built-in; add a `ColormapInfo` to `data/colormap.ts` so it shows in the picker with a group.
- **Add a diverging map**: add its stops to `DIVERGING_STOPS` (`niivue/colormaps.ts`) with an **odd**
  stop count so the neutral colour lands on index 128, and a `CURATED` row in `data/colormap.ts`
  grouping it `Diverging`. Take the stops from matplotlib rather than eyeballing them — an off-centre
  neutral reads as signal. Nothing else is needed: the reversed twin is derived automatically.
- **Reverse a colormap**: nothing to add. `registerReversedColormaps` builds a `<key>_r` for every
  map at startup, and the dock's toggle flips the active key. If a map should NOT be reversible,
  hide the toggle for that target with `ColorDisplayTarget.showReverse: false`.
- **Change a morphology default**: edit `MORPH_DEFAULT_COLORMAP` in `multiView.ts` (the only place).
- **Change a function map's default colormap**: edit `mode.colormap` in `functionalModes`
  (`data/functional.ts`).
- **Change the continuous-atlas default**: edit `CONTINUOUS_DEFAULT` in `ui/dashboard.ts`.
- **Make the somatotopy/atlas surface track a new control**: it already recolors via
  `applyFunctionColor` / `applyAtlasColormap`; ensure any new control calls those (never a bare
  `applyFunctional` or a second `applyFunctionSurface`).

---

## 9. Known cleanups (deferred)

These are code-smell, not user-facing bugs; deferred because they touch the live render path / picker
UI and warrant live verification:

- **`LABELS_KEY` as a synthetic global colormap.** Modeling categorical as a first-class *render
  mode* (instead of a fake colormap key injected into the shared registry and filtered out in three
  places) would remove the scatter. Behavior today is correct.
- **A unified `OverlayColorSpec` + single `applyColorFor(target)`.** Morphology/func/atlas still keep
  their own state shapes and default mechanisms; a single descriptor (key + render-mode + range +
  clip) with one apply/reset resolver would collapse the remaining per-type duplication.
