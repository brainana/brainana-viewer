// Tiny typed state holder shared by the dashboard. It records the handful of fields a few code
// paths read back (current source/subject/volume/surface + layout); all other UI state is local
// to its component. An earlier observable Store/Channel/rafBatch design (selective per-key
// subscriptions + a high-frequency crosshair channel) was never subscribed to and was removed —
// the crosshair fans out directly via MultiView.onCrosshair instead.

export type Layout = 'grid' | 'row' | 'column'

export interface ViewerState {
  sourceId: string | null
  subjectId: string | null
  // Which of the subject's reconstructions is on screen. A subject has more than one only when
  // brainana ran at synthesis_level "session" or "session_longitudinal"; null before the first load
  // and on a manifest from a pre-v3 server.
  scanId: string | null
  scanStream: 'cross' | 'base' | 'long' | null
  volumeKey: string | null // manifest.volumes[].key of the base volume
  surfaceKind: string // pial | white | smoothwm | inflated | veryinflated | sphere
  layout: Layout
}

// Plain keyed state container — get/set/update only (no subscriptions; none were ever used).
export class Store<S extends object> {
  #state: S

  constructor(initial: S) {
    this.#state = { ...initial }
  }

  get<K extends keyof S>(key: K): S[K] {
    return this.#state[key]
  }

  set<K extends keyof S>(key: K, value: S[K]): void {
    this.#state[key] = value
  }

  update(patch: Partial<S>): void {
    Object.assign(this.#state, patch)
  }
}

export function createViewerStore(): { store: Store<ViewerState> } {
  return {
    store: new Store<ViewerState>({
      sourceId: null,
      subjectId: null,
      scanId: null,
      scanStream: null,
      volumeKey: null,
      surfaceKind: 'inflated',
      layout: 'column',
    }),
  }
}
