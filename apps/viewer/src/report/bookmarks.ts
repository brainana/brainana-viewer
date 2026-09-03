// Bookmarked locations for the report.
//
// A bookmark snapshots its READOUT at add time: the values are intrinsic to the location, and
// snapshotting means a point added while retinotopy was overlaid keeps its retinotopy numbers even
// after the user switches to somatotopy. Screenshots are NOT stored here — those are taken at
// generation time so every image in a report shares one view configuration.
//
// Session-scoped and in-memory: the coordinates are subject-space, so the store is cleared when the
// subject changes rather than persisted.
import type { Bookmark, LocationReadout } from './model.ts'

export interface NewBookmark {
  readout: LocationReadout
  /** Human description of the overlay active at add time, explaining which readouts are populated. */
  activeOverlay: string
  label?: string | null
  addedAt?: string
}

type Listener = (items: Bookmark[]) => void

export class BookmarkStore {
  #items: Bookmark[] = []
  #listeners = new Set<Listener>()
  // Monotonic, never reused — a removed point's id must not be handed to a later one, or a pending
  // remove could delete the wrong row.
  #seq = 0

  /** Subscribe to changes; fires immediately with the current list. Returns an unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    listener(this.list())
    return () => this.#listeners.delete(listener)
  }

  #emit(): void {
    const snapshot = this.list()
    for (const listener of this.#listeners) listener(snapshot)
  }

  /** Defensive copy: callers render from this and must not be able to mutate the store. */
  list(): Bookmark[] {
    return [...this.#items]
  }

  count(): number {
    return this.#items.length
  }

  add(entry: NewBookmark): Bookmark {
    const bookmark: Bookmark = {
      id: `bm-${++this.#seq}`,
      label: entry.label ?? null,
      addedAt: entry.addedAt ?? new Date().toISOString(),
      activeOverlay: entry.activeOverlay,
      readout: entry.readout,
      shots: null,
    }
    this.#items.push(bookmark)
    this.#emit()
    return bookmark
  }

  /** Remove by id. Silently ignores an unknown id (a double-click on a row already removed). */
  remove(id: string): void {
    const next = this.#items.filter((b) => b.id !== id)
    if (next.length === this.#items.length) return
    this.#items = next
    this.#emit()
  }

  rename(id: string, label: string | null): void {
    const item = this.#items.find((b) => b.id === id)
    if (!item) return
    // An empty/whitespace name is a request to fall back to the ordinal, not a blank label.
    item.label = label && label.trim() ? label.trim() : null
    this.#emit()
  }

  clear(): void {
    if (this.#items.length === 0) return
    this.#items = []
    this.#emit()
  }
}

/** Display name for a bookmark: its own label, else its 1-based position. */
export function bookmarkName(bookmark: Bookmark, index: number): string {
  return bookmark.label ?? `Bookmarked #${index + 1}`
}

/**
 * True when `ids` is the same sequence as `prev` (`null` — nothing rendered yet — is never equal).
 *
 * Callers that render a bookmark list rebuild it only when this returns false. A rename emits like
 * any other change, but rebuilding on one would detach the edited row's buttons between mousedown
 * and mouseup — the blur that commits the edit fires first — so the click would never land.
 */
export function sameBookmarkIds(prev: string[] | null, ids: string[]): boolean {
  if (!prev || prev.length !== ids.length) return false
  return prev.every((id, i) => id === ids[i])
}
