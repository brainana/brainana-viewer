// Scan selection: grouping, defaults, and the "is this the same space?" question.
//
// A scan is one reconstruction of a subject (see types.ts ScanSummary). brainana v3.0.0 gives a
// subject up to three kinds at once, and the differences between them are not visible on screen —
// two reconstructions of the same animal look alike and are in different frames with different
// meshes. These are the rules that keep that straight; they live here rather than in dashboard.ts
// because dashboard.ts has no test environment.
import type { Manifest, ScanStream, ScanSummary } from '../types'

/** Scans split the way the picker groups them. */
export function groupScans(scans: ScanSummary[]): { cross: ScanSummary[]; longitudinal: ScanSummary[] } {
  return {
    cross: scans.filter((s) => s.stream === 'cross'),
    longitudinal: scans.filter((s) => s.stream !== 'cross'),
  }
}

/**
 * The scan to land on when nothing else is asked for.
 *
 * Always a cross-sectional one where there is any, never the base template: a base is an unbiased
 * average of the subject's sessions, not a scan of the animal, so opening on it would make the
 * viewer's default view a synthetic image. It is also what the functional stream and the
 * per-session surface atlases are registered to, so it is the scan where most features work.
 */
export function defaultScan(scans: ScanSummary[]): ScanSummary | null {
  if (!scans.length) return null
  // A cross-sectional scan outranks the server's own `isDefault` flag. The rule is cheap to state
  // and the consequence of getting it wrong is silent -- the viewer would open on a plausible
  // brain that is nobody's actual scan -- so it does not rely on the other side to hold it.
  const cross = scans.filter((s) => s.stream === 'cross')
  if (cross.length) return cross.find((s) => s.isDefault) ?? cross[0]
  return scans.find((s) => s.isDefault) ?? scans[0]
}

/**
 * Carry a scan choice across a subject switch: the same id if the new subject has it, else the
 * same stream (first session of it), else that subject's default. Returning the default rather
 * than null means a switch never lands on nothing.
 */
export function matchScan(scans: ScanSummary[], wantId: string | null, wantStream: ScanStream | null = null): ScanSummary | null {
  if (!scans.length) return null
  const exact = wantId ? scans.find((s) => s.id === wantId) : null
  if (exact) return exact
  const sameStream = wantStream ? scans.find((s) => s.stream === wantStream) : null
  return sameStream ?? defaultScan(scans)
}

/**
 * Are two scans in the same world frame, on the same mesh?
 *
 * `base` and every `long` scan of one subject are: a base-seeded reconstruction lives in base
 * space and inherits the base's vertex numbering, which is the entire point of the longitudinal
 * stream. Two `cross` scans of the same subject are NOT — each session has its own fsnative frame
 * and its own mesh.
 *
 * Used to decide whether a crosshair position may be carried across a scan switch. Restoring an mm
 * coordinate into a different frame lands it somewhere subtly, silently wrong, which is worse than
 * not restoring it at all.
 */
export function sameSpace(a: ScanSummary | null, b: ScanSummary | null): boolean {
  if (!a || !b) return false
  if (a.subjectId !== b.subjectId) return false
  if (a.id === b.id) return true
  const shared = (s: ScanSummary) => s.stream === 'base' || s.stream === 'long'
  return shared(a) && shared(b)
}

/** Does this subject have anything to choose between? */
export function hasChoice(scans: ScanSummary[]): boolean {
  return scans.length > 1
}

/** Hover text for one scan option, explaining what the stream means. */
export function scanTooltip(scan: ScanSummary): string {
  if (scan.stream === 'base') {
    return 'Unbiased within-subject template, averaged across this animal’s sessions. Carries the change maps.'
  }
  if (scan.stream === 'long') {
    return `${scan.session ?? 'This session'} reconstructed in the base template’s space, sharing its vertex numbering.`
  }
  return 'Independently reconstructed, in its own space. Functional maps and per-session atlases use these.'
}

/** Hover text for the picker itself. */
export function scanPickerTooltip(manifest: Manifest | null): string {
  if (!manifest || !hasChoice(manifest.scans)) return 'This subject has a single reconstruction.'
  return 'Which reconstruction to view. Cross-sectional scans each have their own space and mesh; longitudinal ones share the base template’s.'
}
