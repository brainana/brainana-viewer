// Screenshot capture for the report.
//
// NiiVue creates its WebGL2 context WITHOUT `preserveDrawingBuffer`, so the drawing buffer is only
// readable in the same task as the draw — the constraint NiiVue's own `saveScene` works within
// (drawScene(), then read, with nothing in between). Every capture here follows that shape: no
// `await`, no promise, nothing that could yield between the draw and the read, or the image comes
// back blank or torn.
import type { PaneShots } from './model.ts'

/** The bit of a Niivue instance a capture needs. */
export interface DrawableScene {
  drawScene: () => void
}

/** Resolve after the next animation frame — used BETWEEN captures, never inside one. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}

/**
 * Redraw a pane and return it as a PNG data URL, downscaled so `maxWidth` bounds the long edge.
 * Returns null when the pane is not renderable — a hidden pane has a zero-sized canvas, and a lost
 * GL context throws — so callers can note the omission rather than embedding a blank image.
 */
export function capturePane(scene: DrawableScene, canvas: HTMLCanvasElement, maxWidth: number): string | null {
  const width = canvas.width
  const height = canvas.height
  if (!width || !height) return null // hidden pane: nothing was ever rendered into it
  const scale = Math.min(1, maxWidth / width)
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(width * scale))
  out.height = Math.max(1, Math.round(height * scale))
  const ctx = out.getContext('2d')
  if (!ctx) return null
  try {
    // ---- nothing may yield between these two lines (see the file header) ----
    scene.drawScene()
    ctx.drawImage(canvas, 0, 0, out.width, out.height)
    // ------------------------------------------------------------------------
    const url = out.toDataURL('image/png')
    // A canvas that produced nothing yields the 6-byte "data:," placeholder; treat that as failure
    // rather than embedding an <img> that renders as a broken icon.
    return url && url.length > 32 ? url : null
  } catch {
    return null
  }
}

export interface PaneTarget {
  scene: DrawableScene
  canvas: HTMLCanvasElement
  /** False when the user has hidden this pane — recorded as a note instead of a failed capture. */
  visible: boolean
}

/** Capture both panes, explaining in `note` whichever image is absent and why. */
export function capturePanes(slices: PaneTarget, surface: PaneTarget, maxWidth: number): PaneShots {
  const shot = (target: PaneTarget): string | null => (target.visible ? capturePane(target.scene, target.canvas, maxWidth) : null)
  const slicesUrl = shot(slices)
  const surfaceUrl = shot(surface)
  const reasons: string[] = []
  if (!slicesUrl) reasons.push(slices.visible ? 'the slice montage could not be captured' : 'the volume pane was hidden')
  if (!surfaceUrl) reasons.push(surface.visible ? 'the 3D surface could not be captured' : 'the surface pane was hidden')
  return {
    slices: slicesUrl,
    surface: surfaceUrl,
    // Sentence-cased so it reads as prose under the figures in the report.
    note: reasons.length ? `No screenshot: ${reasons.join('; ')}.` : null,
  }
}

/**
 * Long-edge caps. Every shot is now displayed at the same inline size, so these differ only for the
 * lightbox: enlarging fills nearly the whole viewport, where a small capture goes soft. 1000 is the
 * middle ground for bookmarks — clearly better enlarged than 700, at about half the file-size cost
 * of matching the current view (a report can hold many bookmarks, and each carries two images).
 */
export const MAIN_SHOT_WIDTH = 1400
export const POINT_SHOT_WIDTH = 1000
