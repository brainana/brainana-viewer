// Folder picker overlay, shared by the Datasets dialog (browsing the server filesystem, local or
// remote) and the report's save destination (browsing inside a data source). It knows nothing about
// either: the caller injects a `browse` function returning {path, entries}, so any directory-listing
// backend can drive it.
import { h, errorText, dismissOnBackdrop } from '@brainana/ui/dom.ts'

// Folder glyph reused by the Browse buttons and by each folder row in the picker (no shared icon set).
export const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'

/** The listing shape the picker needs: the folder it is showing plus its immediate subfolders.
 *  Structurally satisfied by BrowseListing (which carries extra fields the picker ignores). */
export interface PickerListing {
  path: string
  entries: Array<{ name: string; path: string }>
}

export interface FsPickerOptions {
  title: string
  start: string
  // Directory lister — the server filesystem (browseFs/browseRemote) or a data source's own tree.
  // Empty path lets the backend default to its natural root (home directory, or the source root).
  browse: (path: string) => Promise<PickerListing>
  // Name for the root crumb. Defaults to '/' (an absolute filesystem); a source-relative picker
  // passes the dataset name, since its paths have no leading slash to show.
  rootLabel?: string
  onPick: (absPath: string) => void
  onClose?: () => void
}

// An overlay layered over its opener: navigate directories and pick one. Seeds from `start` when
// valid; otherwise the backend falls back to its own root. `onPick` gets the chosen path, in
// whatever space `browse` works in; `onClose` fires exactly once when the picker is dismissed (used
// to free a remote browse connection).
export function openFsPicker({ title, start, browse, onPick, onClose, rootLabel = '/' }: FsPickerOptions): void {
  const overlay = h('div', { class: 'overlay' })
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    overlay.remove()
    onClose?.()
  }
  dismissOnBackdrop(overlay, close)

  let current = ''
  // A source-relative picker represents its root as the empty string, so "has a folder loaded"
  // cannot be inferred from `current` being truthy — track it explicitly or the root is unpickable.
  let loaded = false
  const crumb = h('nav', { class: 'fs-crumb', ariaLabel: 'Current path' })
  const listEl = h('div', { class: 'fs-list' })
  const msg = h('span', { class: 'msg' })
  const useBtn = h('button', { type: 'button', class: 'primary' }, ['use this folder'])
  useBtn.addEventListener('click', () => {
    if (loaded) onPick(current)
    close()
  })

  // Render the absolute path as clickable ancestor segments (standard file-chooser breadcrumb).
  // Each segment except the last navigates to that ancestor; the last marks the current folder.
  const renderCrumb = (absPath: string): void => {
    crumb.innerHTML = ''
    // An absolute picker navigates by absolute path; a source-relative one must keep its
    // segments relative, or the backend would reject the leading slash as outside the source.
    const absolute = rootLabel === '/'
    const segs: Array<{ label: string; path: string }> = [{ label: absolute ? '/' : rootLabel, path: absolute ? '/' : '' }]
    let acc = ''
    for (const part of absPath.split('/').filter(Boolean)) {
      acc = absolute ? `${acc}/${part}` : acc ? `${acc}/${part}` : part
      segs.push({ label: part, path: acc })
    }
    segs.forEach((seg, i) => {
      if (i > 0) crumb.append(h('span', { class: 'fs-sep' }, ['›']))
      const isCurrent = i === segs.length - 1
      const btn = h('button', { type: 'button', class: `fs-seg${isCurrent ? ' current' : ''}` }, [seg.label])
      if (!isCurrent) btn.addEventListener('click', () => void load(seg.path))
      crumb.append(btn)
    })
  }

  const load = async (abs: string): Promise<void> => {
    msg.textContent = ''
    msg.className = 'msg'
    listEl.classList.add('loading')
    let listing: PickerListing
    try {
      listing = await browse(abs)
    } catch (err) {
      // On a bad seed path, retry once at the backend's own root (home, or the source root) so the
      // picker still opens.
      if (abs) return void load('')
      msg.textContent = errorText(err)
      msg.className = 'msg error'
      listEl.classList.remove('loading')
      return
    }
    current = listing.path
    loaded = true
    renderCrumb(listing.path)
    useBtn.disabled = false
    listEl.innerHTML = ''
    if (listing.entries.length === 0) {
      listEl.append(h('p', { class: 'muted' }, ['No sub-folders here.']))
    }
    for (const entry of listing.entries) {
      const row = h('button', { type: 'button', class: 'fs-entry' }, [
        h('span', { class: 'fs-ico', innerHTML: FOLDER_SVG }),
        h('span', { class: 'fs-name' }, [entry.name]),
      ])
      row.addEventListener('click', () => void load(entry.path))
      listEl.append(row)
    }
    listEl.classList.remove('loading')
  }

  const closeBtn = h('button', { type: 'button', class: 'ghost' }, ['cancel'])
  closeBtn.addEventListener('click', close)

  const dialog = h('div', { class: 'dialog fs-picker' }, [
    h('div', { class: 'dialog-head' }, [h('h2', {}, [title]), h('span', { class: 'spacer' }), closeBtn]),
    crumb,
    listEl,
    h('div', { class: 'row' }, [msg, h('span', { class: 'spacer' }), useBtn]),
  ])
  overlay.append(dialog)
  document.body.append(overlay)
  void load(start)
}
