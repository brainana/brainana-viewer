// Custom LUTs registered on both NiiVue instances (v1.2.25 fidelity):
//  - eccentricity 0-10: red → blue ramp
//  - somatotopy: the SAME ramp REVERSED (blue at 0 → red at 100) — the v1.2.22 fix
//  - polar angle: a cyclic hue wheel
//  - curvature: binary light/dark gray (sulci/gyri)
// The color stops are exported so the legends (P5) can be drawn from the same source of truth.
import type { Niivue } from '@niivue/niivue'
import { hslToRgb, type RGB } from '../data/colors.ts'
import { gradientFromRgba } from '../data/colormap.ts'

export interface NiiColormap {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
}

// Build a NiiVue colormap from color stops: index 0 is transparent, stops spaced 1..255.
export function buildColormap(stops: RGB[]): NiiColormap {
  const R = [0]
  const G = [0]
  const B = [0]
  const A = [0]
  const I = [0]
  const n = stops.length
  for (let k = 0; k < n; k++) {
    const idx = n === 1 ? 255 : 1 + Math.round((k * 254) / (n - 1))
    R.push(stops[k][0])
    G.push(stops[k][1])
    B.push(stops[k][2])
    A.push(255)
    I.push(idx)
  }
  return { R, G, B, A, I }
}

// Eccentricity ramp: red → orange → yellow → green → cyan → blue.
export const ECCENTRICITY_STOPS: RGB[] = [
  [204, 16, 51],
  [233, 86, 20],
  [245, 160, 20],
  [247, 220, 30],
  [150, 210, 40],
  [40, 200, 90],
  [30, 190, 200],
  [20, 90, 230],
  [0, 0, 255],
]

// Somatotopy = eccentricity reversed → blue at 0, red at 100.
export const SOMATOTOPY_STOPS: RGB[] = [...ECCENTRICITY_STOPS].reverse()

// Polar-angle wheel: cyclic hue, starting at green (the smooth rainbow — the default).
export const POLAR_STOPS: RGB[] = Array.from({ length: 17 }, (_, k) => hslToRgb((120 + k * 22.5) % 360, 0.85, 0.5))

// Alternative polar map that SEPARATES the left/right visual hemifields (green at both meridians,
// blue on one side, red on the other) — the previous surface look, kept as a selectable option.
export const POLAR_LR_STOPS: RGB[] = [
  [0, 255, 0],
  [0, 0, 255],
  [0, 255, 0],
  [255, 0, 0],
  [0, 255, 0],
]

// Binary curvature: light gray for concave (sulci), dark gray for convex (gyri).
export const CURVATURE_BINARY: NiiColormap = {
  R: [214, 214, 72, 72],
  G: [214, 214, 72, 72],
  B: [214, 214, 72, 72],
  A: [255, 255, 255, 255],
  I: [0, 127, 128, 255],
}

// --- matplotlib diverging maps ---------------------------------------------------------------
// NiiVue 0.69 ships exactly one diverging map (blue2red), so signed quantities had nowhere sensible
// to land -- and the change tab's `bwr` default silently fell through to NiiVue's black-to-white
// gray ramp, which is not diverging at all. These stop tables are matplotlib 3.8's own, so the maps
// match the reference at https://matplotlib.org/stable/users/explain/colors/colormaps.html: the nine
// ColorBrewer maps are its 11 published anchors, bwr 3, seismic 5, and coolwarm 33 samples of
// Moreland's table.
//
// buildColormap spaces stops evenly over 1..255, which is how matplotlib spaces these anchors too --
// so every map's neutral middle anchor lands exactly on index 128 and a symmetric window (see
// symmetricRobustRange) puts zero on the neutral colour. Keep the counts ODD for that reason.
const DIVERGING_STOPS: Record<string, RGB[]> = {
  // PiYG (11)
  piyg: [[142, 1, 82], [197, 27, 125], [222, 119, 174], [241, 182, 218], [253, 224, 239], [247, 247, 247],
    [230, 245, 208], [184, 225, 134], [127, 188, 65], [77, 146, 33], [39, 100, 25]],
  // PRGn (11)
  prgn: [[64, 0, 75], [118, 42, 131], [153, 112, 171], [194, 165, 207], [231, 212, 232], [247, 247, 247],
    [217, 240, 211], [166, 219, 160], [90, 174, 97], [27, 120, 55], [0, 68, 27]],
  // BrBG (11)
  brbg: [[84, 48, 5], [140, 81, 10], [191, 129, 45], [223, 194, 125], [246, 232, 195], [245, 245, 245],
    [199, 234, 229], [128, 205, 193], [53, 151, 143], [1, 102, 94], [0, 60, 48]],
  // PuOr (11)
  puor: [[127, 59, 8], [179, 88, 6], [224, 130, 20], [253, 184, 99], [254, 224, 182], [247, 247, 247],
    [216, 218, 235], [178, 171, 210], [128, 115, 172], [84, 39, 136], [45, 0, 75]],
  // RdGy (11)
  rdgy: [[103, 0, 31], [178, 24, 43], [214, 96, 77], [244, 165, 130], [253, 219, 199], [255, 255, 255],
    [224, 224, 224], [186, 186, 186], [135, 135, 135], [77, 77, 77], [26, 26, 26]],
  // RdBu (11)
  rdbu: [[103, 0, 31], [178, 24, 43], [214, 96, 77], [244, 165, 130], [253, 219, 199], [247, 247, 247],
    [209, 229, 240], [146, 197, 222], [67, 147, 195], [33, 102, 172], [5, 48, 97]],
  // RdYlBu (11)
  rdylbu: [[165, 0, 38], [215, 48, 39], [244, 109, 67], [253, 174, 97], [254, 224, 144], [255, 255, 191],
    [224, 243, 248], [171, 217, 233], [116, 173, 209], [69, 117, 180], [49, 54, 149]],
  // RdYlGn (11)
  rdylgn: [[165, 0, 38], [215, 48, 39], [244, 109, 67], [253, 174, 97], [254, 224, 139], [255, 255, 191],
    [217, 239, 139], [166, 217, 106], [102, 189, 99], [26, 152, 80], [0, 104, 55]],
  // Spectral (11)
  spectral: [[158, 1, 66], [213, 62, 79], [244, 109, 67], [253, 174, 97], [254, 224, 139], [255, 255, 191],
    [230, 245, 152], [171, 221, 164], [102, 194, 165], [50, 136, 189], [94, 79, 162]],
  // coolwarm (33)
  coolwarm: [[59, 76, 192], [68, 90, 204], [78, 104, 216], [88, 117, 225], [98, 130, 234], [108, 143, 241],
    [119, 154, 247], [130, 166, 251], [141, 176, 254], [152, 185, 255], [163, 194, 254], [174, 201, 252],
    [185, 208, 249], [195, 213, 244], [204, 217, 237], [213, 219, 229], [221, 220, 220], [229, 216, 209],
    [236, 211, 197], [241, 204, 184], [245, 196, 172], [247, 186, 159], [247, 176, 147], [246, 165, 134],
    [244, 152, 122], [240, 139, 110], [235, 125, 98], [228, 110, 86], [221, 95, 75], [212, 78, 65],
    [202, 59, 55], [190, 36, 46], [180, 4, 38]],
  // bwr (3)
  bwr: [[0, 0, 255], [255, 255, 255], [255, 0, 0]],
  // seismic (5)
  seismic: [[0, 0, 76], [0, 0, 255], [255, 255, 255], [255, 0, 0], [128, 0, 0]],
}

export const COLORMAPS: Record<string, NiiColormap> = {
  brainana_eccentricity: buildColormap(ECCENTRICITY_STOPS),
  brainana_somatotopy: buildColormap(SOMATOTOPY_STOPS),
  brainana_polar_angle: buildColormap(POLAR_STOPS),
  brainana_polar_lr: buildColormap(POLAR_LR_STOPS),
  brainana_curvature: CURVATURE_BINARY,
  ...Object.fromEntries(Object.entries(DIVERGING_STOPS).map(([key, stops]) => [key, buildColormap(stops)])),
}

export function registerColormaps(nv: Niivue): void {
  for (const [name, cmap] of Object.entries(COLORMAPS)) {
    try {
      nv.addColormap(name, cmap)
    } catch {
      // colormap may already be registered
    }
  }
}

/**
 * Flip a sampled RGBA LUT end-to-end into a colormap table.
 *
 * Index 0 is left exactly where it is. Everywhere in this app it is the reserved masked / no-data
 * slot (docs/colormap-management.md §7.1) — a slot, not a colour — so reversing it would move
 * transparency into the middle of the ramp and paint the map's first colour onto masked vertices.
 * Only 1..n-1 are reversed, alpha included, since a built-in's alpha ramps with its colours.
 */
export function reverseColormap(rgba: ArrayLike<number>): NiiColormap | null {
  const n = Math.floor(rgba.length / 4)
  if (n < 3) return null
  const R: number[] = []
  const G: number[] = []
  const B: number[] = []
  const A: number[] = []
  const I: number[] = []
  const push = (src: number, idx: number): void => {
    const o = src * 4
    R.push(rgba[o])
    G.push(rgba[o + 1])
    B.push(rgba[o + 2])
    A.push(rgba[o + 3])
    I.push(idx)
  }
  push(0, 0)
  for (let k = 1; k < n; k++) push(n - k, 1 + Math.round(((k - 1) * 254) / (n - 2)))
  return { R, G, B, A, I }
}

/**
 * Register a reversed twin (`<key>_r`) for each map, so the colour dock's reverse toggle can simply
 * rewrite the active key. Must run on BOTH NiiVue instances, like registerColormaps — a map the
 * surface knows and the slices do not would desync the two (docs §4).
 */
export function registerReversed(nv: Niivue, keys: string[]): string[] {
  const created: string[] = []
  for (const key of keys) {
    if (key.endsWith('_r')) continue
    try {
      const rgba = (nv as unknown as { colormap: (id: string) => ArrayLike<number> }).colormap(key)
      if (!rgba || rgba.length < 12) continue
      const table = reverseColormap(rgba)
      if (table) {
        nv.addColormap(`${key}_r`, table)
        created.push(key)
      }
    } catch {
      // A map NiiVue cannot sample gets no reversed twin, and is left out of the returned list so
      // the caller can hide the toggle for it. Asking NiiVue for an unregistered key does NOT
      // throw -- it silently substitutes `gray`, which would read as a deliberate colour choice.
    }
  }
  return created
}

// Sample each colormap's flat RGBA LUT once and derive both the CSS gradient preview and the raw
// LUT (kept for the legend wheel/rings + the surface categorical LUT, which need actual colors).
export interface ColormapAssets {
  gradients: Record<string, string>
  luts: Record<string, Uint8ClampedArray>
}
export function buildColormapAssets(nv: Niivue, keys: string[]): ColormapAssets {
  const gradients: Record<string, string> = {}
  const luts: Record<string, Uint8ClampedArray> = {}
  for (const key of keys) {
    try {
      const rgba = (nv as unknown as { colormap: (id: string) => ArrayLike<number> }).colormap(key)
      if (rgba && rgba.length >= 4) {
        luts[key] = rgba instanceof Uint8ClampedArray ? rgba : Uint8ClampedArray.from(rgba as ArrayLike<number>)
        gradients[key] = gradientFromRgba(rgba)
      } else {
        gradients[key] = GRAY_GRADIENT
      }
    } catch {
      gradients[key] = GRAY_GRADIENT
    }
  }
  return { gradients, luts }
}

// All colormap names NiiVue offers (built-ins + any custom maps registered on this instance).
export function availableColormaps(nv: Niivue): string[] {
  try {
    const names = (nv as unknown as { colormaps: () => string[] }).colormaps()
    return Array.isArray(names) ? names : []
  } catch {
    return []
  }
}

const GRAY_GRADIENT = 'linear-gradient(90deg, rgb(20,18,13), rgb(236,230,216))'
