# Layout density — the control-panel tightness contract

_Status: decided & applied (2026-07-16). Companion to `theme.html` (color + type theme); this doc
owns spacing / sizing / tightness. Applies to `apps/viewer` and any future brainana tool that
consumes `@brainana/ui`._

## Why this exists

The side/info control panels grew organically and drifted into **noisy, inconsistent tightness**:
three different row-gap values (3 / 8 / 10px, some tokenized, some hardcoded), three numeric-box
specs (56 / 66 / 36px with different paddings), tall selects (~30px) sitting next to short number
boxes, and four different section-header treatments. The root cause was **inconsistent application**
of the existing `--sp-*` / `--fs-*` scales — dozens of value-equal literals shadowing tokens that
already existed — plus a **specificity bug**: the compact number-box classes (`.slider-num`,
`.range-num`, `.coord-num`) were out-ranked by the generic `input[type=number]` rule (an attribute
selector out-specifies a bare class), so their tight padding never took effect and the boxes
rendered tall.

## The decision

**Density: "compact & unified."** One control height, one row gap, applied everywhere via tokens.
The **Coordinates** read-out is the tightness reference and is preserved exactly as-is (users
approved its look). We did **not** go "maximum tight" — interactive controls stay comfortably
clickable.

**Headers: two roles, each internally consistent.**
- **Panel titles** (`atlas` / `morphology` / `func map`, `.side-panel-head`) stay **prominent bold**
  (weight 700, ~13px) and are CSS-uppercased (`text-transform: uppercase`) — distinguished from
  sub-headers by weight/color, not by case. Only their spacing was normalized.
- **Sub-headers** (`COLOR DISPLAY`, the info-column `h3`s, collapsible `group-head`) are unified to
  **one muted small-caps spec**: `font-size: var(--fs-sm)` · `font-weight: 700` ·
  `letter-spacing: .06em` · `text-transform: uppercase` · `color: var(--muted)`.

## The tokens (in `packages/ui/theme.css`)

The single place to re-tune panel tightness:

| Token | Value | Meaning |
|-------|-------|---------|
| `--ctl-h` | `20px` | Height of every interactive control: **buttons** (`.primary/.ghost/.panel-btn/.chip`), `select`, text/number input, `.cmap-trigger`, the slider/range number boxes, and `.legend-row`. |
| `--row-gap` | `var(--sp-2)` (6px) | Vertical gap between control rows within a section / group / panel. |
| `--field-gap` | `var(--sp-1)` (4px) | Gap between a stacked field's label and its control. |
| `--num-w` | `56px` | Width of the small numeric boxes beside sliders / ranges. |
| `--r-xs` | `3px` | Micro radius: swatches, colorbar track, zebra rows (folds four hardcoded `3px`). |

## Rules for future work

1. **Never hardcode a value that equals a token.** Use `--sp-*` for spacing, `--fs-*` for font
   size, `--r-*` for radius, and the density tokens above for control geometry. `11px` → `--fs-sm`,
   `8px` → `--sp-3`, `3px` radius → `--r-xs`, etc.
2. **Interactive controls are `--ctl-h` tall — including buttons.** A select, the number box beside
   it, and a button must all line up. Selects/inputs are height-driven by the generic rule; **buttons
   (`.primary/.ghost/.panel-btn/.chip`) are made height-driven too** — `display: inline-flex` +
   `align-items/justify-content: center` + `height: var(--ctl-h)` + `line-height: 1`, with vertical
   padding `0` (horizontal padding is per-button). This is essential: without it, buttons inherit the
   `body` `line-height: 1.5` and render *taller* than selects, and the text sits loosely. The toolbar
   uses the same `--ctl-h` (it no longer forces `height: auto`); it stays dense via its tighter
   *horizontal* padding + `--fs-1` font, not a different height.
3. **Compact control classes need `input.<class>` specificity.** A bare `.slider-num` loses to
   `input[type=number]`. Write `input.slider-num` / `input.range-num` so the override actually wins.
4. **Coordinates is frozen.** `input.coord-num` is pinned above the generic rule so the unified
   height never grows it. Treat the Coordinates read-out as the tightness reference, not a thing to
   restyle.
5. **Row spacing is `--row-gap`, label→control is `--field-gap`.** Don't reintroduce bespoke 3 / 8 /
   10px gaps.
6. **Section headers pick one of the two roles above** — a bold panel title or a muted small-caps
   sub-header. No third treatment.

## Exceptions (intentional, documented)

- **Info bottom panel is left at its own density.** It's a read-out area (label:value `dl`s, atlas
  rows, the coordinate editor) that reads well as-is, so the control tightening does **not** apply
  there. It's excluded automatically: its only interactive controls — `input.coord-num` (pinned
  17px) and `.neighborhood-control select` (`height: auto`) — don't use `--ctl-h`, so retuning that
  token can't reach them. Keep it that way: don't wire info-panel controls to `--ctl-h`.
- **Toolbar** shares `--ctl-h` but stays dense via tighter *horizontal* padding + `--fs-1` font (not
  a shorter height).
- **`.neighborhood-control select`** (the tiny 3×3×3 picker) stays smaller than `--ctl-h`.
- **`.view-btn` / `.layout-btn`** (segmented view + montage groups) keep their own approved sizing.
- **Montage layout buttons** carry fixed-height SVG glyphs (`.layout-btn svg { height: 15px }`,
  tunable) instead of stretching to button width, so they read at the same scale as the text view
  buttons.
- **`.legend-row` height** equals `--ctl-h`; the virtual-scroll `ROW_H` constant in
  `apps/viewer/src/ui/roiLegend.ts` must be kept in sync with it manually.

## Toolbar wrapping contract

_Added 2026-09-21, replacing the original single 2-row × N-column grid._

The top bar is a **wrapping row of clusters**, not one grid. Each `.tb-group` is a self-contained
two-row grid (brand · sub/ses · vol/surf · montage/views · hemi/marker · category tabs), separated
from its neighbour by a leading hairline drawn as `border-inline-start` on the group.

1. **Clusters are atomic.** `.tb-cell` is `flex-wrap: nowrap` + `white-space: nowrap` and no longer
   carries `min-width: 0`. When the window is too narrow, a **whole cluster** drops to the next bar
   row. A button group is never split across lines and nothing is ever clipped — the old behaviour
   (grid tracks shrinking below content, cells re-wrapping internally) is what put `CHANGE` on its
   own line under `ATLAS` at the default 1440px window.
2. **Two tuning knobs, both on `.toolbar`:** `--tb-gap` (cluster separation, also the groups'
   internal column gap and the hairline's leading padding) and `--tb-mode-w` (the marker
   placement-mode select). `--tb-pad-y` exists so the hairlines can bleed into the bar's vertical
   padding and read full-height; it is not a spacing token and is not reusable elsewhere.
3. **One width tier**, `@media (max-width: 1460px)`: `--tb-gap` → `--sp-4`, `--tb-mode-w` → 96px,
   and the marker cluster's `size` / `mode` micro-labels are **clipped, never `display: none`** —
   the text stays inside the wrapping `<label>`, so the accessible name is unchanged. Both fields
   also carry a `title` set in `dashboard.ts`. Do not extend this tier to labels that name a
   *choice* (`sub`, `ses`, `vol`, `surf`, `FOV`, `LH`/`RH`).
4. **Category tabs are a 2×2 block** (`.tb-tabs`), filling both bar rows. That cluster's second row
   used to sit empty while four tabs fought for width in the first.
5. **Wrapped-row hairlines are tagged from JS.** CSS cannot see a flex wrap boundary, so a
   `ResizeObserver` in `dashboard.ts` toggles `.tb-row-start` on each group that begins a bar row,
   and the stylesheet drops its leading hairline there. If a cluster is added or reordered, nothing
   needs updating — the observer walks `.tb-group` by `offsetTop`.
6. **Row alignment across clusters is by `1fr 1fr`, not `auto auto`.** Each cluster is stretched to
   the tallest one on its bar row (`.toolbar { align-items: stretch }`), so equal fractions give
   every cluster the same two row heights. With `auto` tracks each cluster would size its rows to
   its own contents and the bar's two lines of controls would drift apart — the single grid used to
   guarantee that alignment for free.
7. **`packages/core-desktop/window.mjs` `minWidth` is not load-bearing** for the bar any more. The
   toolbar stays usable well below 960px; don't raise the window minimum to fix a layout problem.

## Out of scope (potential follow-ups)

Internal **canvas** rendering constants are not DOM tightness and were left alone:
`legend.ts` (`size = 120`) and `visualFieldPlot.ts` canvas font sizes. (The `.icon-btn` in the
Datasets dialog was previously a 34px square taller than its row; it is now height-driven to `--ctl-h`
like every other control, so it lines up with the inputs and buttons beside it.)
