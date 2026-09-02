// The report dialog: review the bookmarked points, choose whether to include screenshots, pick a
// destination, and generate. Download is preselected — it is the destination that works the same in
// every runtime — with "save into the dataset" available for keeping the report beside the data
// (including on a remote SFTP source, which the server-side export path handles identically).
import { h, field, errorText } from '@brainana/ui/dom.ts'
import { ServerExport, downloadBlob } from '@brainana/core-client/exportDestination.ts'
import type { RuntimeClient } from '@brainana/core-client/runtimeClient.ts'
import { openFsPicker } from '../ui/dialogs/fsPicker.ts'
import { BookmarkStore, bookmarkName } from './bookmarks.ts'
import { buildReportHtml } from './html.ts'
import { generateReport, reportFilename, type ReportContext } from './generate.ts'

export interface ReportDialogDeps {
  client: RuntimeClient
  context: ReportContext
  bookmarks: BookmarkStore
  /** Null for a subject loaded without a source scope — the dataset destination is then unusable. */
  sourceId: string | null
  sourceLabel: string | null
}

// Above this many points the capture loop is long and the file large enough to warn about.
const MANY_POINTS = 20

/** Default name at dialog-open time; regenerated per report by reportFilename() if left untouched. */
function defaultFilename(subjectId: string | null): string {
  const subject = (subjectId ?? 'subject').replace(/[^A-Za-z0-9_-]+/g, '-')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `brainana-report_${subject}_${stamp}.html`
}

export function mountReportDialog(deps: ReportDialogDeps): void {
  const { client, context, bookmarks, sourceId, sourceLabel } = deps
  const exporter = new ServerExport(client)

  const overlay = h('div', { class: 'overlay' })
  let unsubscribe: () => void = () => {}
  let busy = false
  const close = (): void => {
    // Never close mid-capture: the crosshair restore runs after the loop, and tearing the dialog
    // down first would leave the user with no indication that the view is still being driven.
    if (busy) return
    unsubscribe()
    overlay.remove()
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  // --- bookmark list ---
  const pointList = h('div', { class: 'report-points' })
  // Ids of the rows currently in the DOM. A rename emits like any other change, but rebuilding on one
  // would detach that row's "remove" button between mousedown and mouseup — the blur that commits the
  // edit fires first — so the click would never land. Rebuild only when the rows themselves change;
  // null forces the first render.
  let renderedIds: string[] | null = null
  const renderPoints = (): void => {
    const items = bookmarks.list()
    const ids = items.map((b) => b.id)
    if (renderedIds && renderedIds.length === ids.length && renderedIds.every((id, i) => id === ids[i])) return
    renderedIds = ids
    pointList.innerHTML = ''
    if (items.length === 0) {
      pointList.append(h('p', { class: 'muted' }, ['No points bookmarked. Close this dialog and use “+ point” to add the current crosshair.']))
      return
    }
    items.forEach((bookmark, i) => {
      const name = h('input', { type: 'text', class: 'grow', value: bookmark.label ?? '', placeholder: bookmarkName(bookmark, i) }) as HTMLInputElement
      name.addEventListener('change', () => bookmarks.rename(bookmark.id, name.value))
      const remove = h('button', { type: 'button', class: 'ghost sm', title: 'Remove this point' }, ['remove'])
      remove.addEventListener('click', () => bookmarks.remove(bookmark.id))
      const mm = bookmark.readout.mm.map((v) => v.toFixed(1)).join(', ')
      pointList.append(h('div', { class: 'report-point-row' }, [h('span', { class: 'report-point-n' }, [`${i + 1}`]), name, h('span', { class: 'report-point-mm' }, [mm]), remove]))
    })
  }

  // --- options ---
  const shotsCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  shotsCheck.checked = true
  const summary = h('p', { class: 'muted' })
  const warn = h('p', { class: 'msg' })

  const refreshSummary = (): void => {
    const count = bookmarks.count()
    // Two panes for the current view plus two per point — the number that drives both the wait and
    // the file size, so it is worth stating before the user commits.
    const images = shotsCheck.checked ? 2 + count * 2 : 0
    summary.textContent = `${count} bookmarked point${count === 1 ? '' : 's'} · ${images} screenshot${images === 1 ? '' : 's'}`
    warn.textContent =
      shotsCheck.checked && count > MANY_POINTS ? `${count} points means ${images} images: generation will take a moment and the file will be large.` : ''
  }
  shotsCheck.addEventListener('change', refreshSummary)

  // --- destination ---
  const dlRadio = h('input', { type: 'radio', name: 'report-destination', value: 'download' }) as HTMLInputElement
  dlRadio.checked = true // download is the default: it behaves identically in browser and desktop
  const dsRadio = h('input', { type: 'radio', name: 'report-destination', value: 'dataset' }) as HTMLInputElement
  dsRadio.disabled = !sourceId
  const folderText = h('span', { class: 'report-folder' }, [sourceLabel ?? 'dataset root'])
  let folder = '' // source-relative; '' is the source root
  const chooseBtn = h('button', { type: 'button', class: 'ghost sm' }, ['choose folder…'])
  const filename = h('input', { type: 'text', class: 'grow', value: defaultFilename(context.dataset().subjectId) }) as HTMLInputElement
  const datasetRow = h('div', { class: 'report-dest-detail' }, [h('div', { class: 'row' }, [folderText, h('span', { class: 'spacer' }), chooseBtn])])
  // The file name names the download too, so it stays visible for both destinations; only the
  // dataset-only folder row is toggled.
  const filenameRow = h('div', { class: 'report-filename' }, [field('file name', filename)])

  const syncDestination = (): void => {
    datasetRow.hidden = !dsRadio.checked
  }
  dlRadio.addEventListener('change', syncDestination)
  dsRadio.addEventListener('change', syncDestination)
  syncDestination()

  chooseBtn.addEventListener('click', () => {
    if (!sourceId) return
    openFsPicker({
      title: 'choose a folder in the dataset',
      start: folder,
      rootLabel: sourceLabel ?? 'dataset',
      browse: (path) => exporter.listFolders(sourceId, path),
      onPick: (picked) => {
        folder = picked
        resetOverwrite()
        folderText.textContent = picked ? `${sourceLabel ?? 'dataset'}/${picked}` : (sourceLabel ?? 'dataset root')
      },
    })
  })

  // --- generate ---
  const msg = h('span', { class: 'msg' })
  const cancelBtn = h('button', { type: 'button', class: 'ghost' }, ['cancel'])
  cancelBtn.addEventListener('click', close)
  const generateBtn = h('button', { type: 'button', class: 'primary' }, ['generate']) as HTMLButtonElement
  // Set when the server refuses to clobber an existing file; the next click replaces it.
  let overwrite = false
  // Any edit to the destination path invalidates that arming: the refusal named one file, and
  // silently replacing a DIFFERENT one is data loss.
  const resetOverwrite = (): void => {
    if (!overwrite) return
    overwrite = false
    generateBtn.textContent = 'generate'
    msg.textContent = ''
    msg.className = 'msg'
  }
  filename.addEventListener('input', resetOverwrite)

  const setBusy = (on: boolean): void => {
    busy = on
    generateBtn.disabled = on
    cancelBtn.disabled = on
    chooseBtn.disabled = on
  }
  const progress = (step: string): void => {
    msg.textContent = step
    msg.className = 'msg'
  }
  const fail = (error: unknown): void => {
    msg.textContent = errorText(error)
    msg.className = 'msg error'
  }

  generateBtn.addEventListener('click', () => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const data = await generateReport(context, bookmarks.list(), { includeScreenshots: shotsCheck.checked, onProgress: progress })
        const blob = new Blob([buildReportHtml(data)], { type: 'text/html;charset=utf-8' })
        if (dlRadio.checked || !sourceId) {
          downloadBlob(blob, filename.value.trim() || reportFilename(data))
          msg.textContent = 'Report downloaded.'
          msg.className = 'msg'
          setBusy(false)
          return
        }
        const name = filename.value.trim() || reportFilename(data)
        const rel = folder ? `${folder}/${name}` : name
        const result = await exporter.saveFile(sourceId, rel, blob, overwrite)
        if (result.exists) {
          // Refused rather than clobbered: arm the next click to replace, and say so plainly.
          overwrite = true
          generateBtn.textContent = 'replace'
          msg.textContent = `${rel} already exists. Click “replace” to overwrite it, or change the file name.`
          msg.className = 'msg error'
          setBusy(false)
          return
        }
        overwrite = false
        generateBtn.textContent = 'generate'
        msg.textContent = `Saved to ${result.path ?? rel}.`
        msg.className = 'msg'
        setBusy(false)
      } catch (error) {
        fail(error)
        setBusy(false)
      }
    })()
  })

  const closeBtn = h('button', { type: 'button', class: 'ghost' }, ['close'])
  closeBtn.addEventListener('click', close)

  const dialog = h('div', { class: 'dialog report-dialog' }, [
    h('div', { class: 'dialog-head' }, [h('h2', {}, ['Generate report']), h('span', { class: 'spacer' }), closeBtn]),
    summary,
    h('h3', {}, ['Bookmarked points']),
    pointList,
    h('h3', {}, ['Contents']),
    h('label', { class: 'field inline' }, [shotsCheck, h('span', {}, ['include screenshots of the current view and each point'])]),
    warn,
    h('h3', {}, ['Destination']),
    h('label', { class: 'field inline' }, [dlRadio, h('span', {}, ['download'])]),
    h('label', { class: 'field inline' }, [dsRadio, h('span', {}, [sourceId ? 'save into the dataset' : 'save into the dataset (no dataset open)'])]),
    datasetRow,
    filenameRow,
    h('div', { class: 'dialog-foot' }, [msg, h('span', { class: 'spacer' }), cancelBtn, generateBtn]),
  ])

  overlay.append(dialog)
  document.body.append(overlay)
  unsubscribe = bookmarks.subscribe(() => {
    renderPoints()
    refreshSummary()
  })
}
