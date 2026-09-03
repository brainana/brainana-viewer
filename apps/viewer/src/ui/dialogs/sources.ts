// Sources dialog: add a local folder or a remote SSH/SFTP workstation, list and remove
// sources. Multi-source is held server-side; this just drives /api/sources.
import type { RuntimeClient } from '@brainana/core-client/runtimeClient.ts'
import type { SourceManager, SourceSummary } from '@brainana/core-client/sourceManager.ts'
import type { FilesystemClient, SshHost } from '@brainana/core-client/filesystemClient.ts'
import { loadRecent, rememberLocal, loadProfiles, rememberProfile, forgetProfile } from '@brainana/core-client/sessionPersistence.ts'
import { h, field, errorText, asyncHandler } from '@brainana/ui/dom.ts'
import { openFsPicker, FOLDER_SVG } from './fsPicker.ts'

interface Deps {
  client: RuntimeClient
  sources: SourceManager
  files: FilesystemClient
}

// Dataset-table column widths (px) for the fixed-layout resizable columns. Held at module scope so
// drags survive the table rebuilds fired on every registry change, and persist across reopens of
// the dialog within a page session (not written to storage — matches the panel resizers). The
// `actions` column has no entry: it flexes to absorb the remainder.
const MIN_COL = 48
const datasetColW = { type: 72, name: 240, label: 130 }
type ColKey = keyof typeof datasetColW

// One entry in the remote-connect recall dropdown: a saved profile (removable) or a host parsed from
// ~/.ssh/config (not removable). `host` is the address to connect to (a profile's host, or an ssh
// config entry's HostName falling back to its alias).
interface RecallEntry {
  host: string
  username?: string
  port?: number
  removable: boolean
}

// `onDone` fires when the user clicks the next-step "continue, choose a monkey" button (after at
// least one dataset exists): the dialog closes and the caller can steer focus to the monkey picker.
export function mountSourcesDialog(deps: Deps, onChanged: () => void, onDone?: () => void): void {
  const { sources, files } = deps
  const recents = loadRecent()

  // A live pre-add SFTP browse session, kept open across multiple dataset adds and torn down on
  // disconnect or when the dialog closes. Declared before `close` so teardown can reach it.
  let remoteToken: string | null = null
  const teardownRemote = (): void => {
    const token = remoteToken
    remoteToken = null
    if (token) files.disconnectRemote(token).catch(() => {})
  }

  // Assigned once the registry subscription is wired; declared here so `close` can unsubscribe.
  let unsub: () => void = () => {}

  const overlay = h('div', { class: 'overlay' })
  const close = (): void => {
    teardownRemote()
    unsub()
    overlay.remove()
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  // Header dismiss: a plain "close" that always just closes. The next-step primary action lives in
  // the footer (`continueBtn`), enabled once a dataset exists.
  const closeBtn = h('button', { type: 'button', class: 'ghost' }, ['close'])
  closeBtn.addEventListener('click', close)

  let hasSources = false
  const continueBtn = h('button', { type: 'button', class: 'primary' }, ['continue, choose a monkey'])
  continueBtn.disabled = true
  continueBtn.addEventListener('click', () => {
    close()
    if (hasSources) onDone?.()
  })

  // Wire a header grip so dragging it resizes the column to its left. Mirrors the dashboard's
  // `.info-vresizer` idiom: measure the header cell's left edge, clamp, write the live <col> width.
  const attachGrip = (grip: HTMLElement, th: HTMLElement, col: HTMLTableColElement, key: ColKey): void => {
    let dragging = false
    grip.addEventListener('pointerdown', (e) => {
      dragging = true
      grip.setPointerCapture(e.pointerId)
      e.preventDefault()
      e.stopPropagation()
    })
    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const w = Math.max(MIN_COL, Math.round(e.clientX - th.getBoundingClientRect().left))
      datasetColW[key] = w
      col.style.width = `${w}px`
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        grip.releasePointerCapture(e.pointerId)
      } catch {
        // capture may already be gone
      }
    }
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  }

  const buildDatasetTable = (items: SourceSummary[]): HTMLTableElement => {
    // Fixed layout + explicit <col> widths make the columns resizable; `actions` (last) flexes.
    const mkCol = (key: ColKey): HTMLTableColElement => {
      const col = h('col') as HTMLTableColElement
      col.style.width = `${datasetColW[key]}px`
      return col
    }
    const colType = mkCol('type')
    const colName = mkCol('name')
    const colLabel = mkCol('label')
    const mkTh = (text: string, col: HTMLTableColElement, key: ColKey): HTMLTableCellElement => {
      const th = h('th', {}, [text]) as HTMLTableCellElement
      const grip = h('span', { class: 'col-grip', ariaHidden: 'true' })
      attachGrip(grip, th, col, key)
      th.append(grip)
      return th
    }
    const body = h('tbody')
    for (const s of items) {
      // Editable custom label. Commit on `change` (fires on blur/Enter) rather than `input` so the
      // emit-driven table rebuild in the subscription can't interrupt typing. On failure revert.
      const labelInput = h('input', { type: 'text', class: 'label-input', value: s.customLabel ?? '', placeholder: 'custom name…' }) as HTMLInputElement
      labelInput.addEventListener('change', () => {
        const next = labelInput.value.trim()
        sources.setLabel(s.id, next || null).catch(() => {
          labelInput.value = s.customLabel ?? ''
        })
      })
      const remove = h('button', { type: 'button', class: 'ghost sm' }, ['remove'])
      remove.addEventListener(
        'click',
        asyncHandler(async () => {
          await sources.remove(s.id)
          onChanged()
        }),
      )
      body.append(
        h('tr', {}, [
          h('td', {}, [h('span', { class: `badge ${s.type}` }, [s.type])]),
          h('td', {}, [h('span', { class: 'ds-name', title: s.label }, [s.label])]),
          h('td', {}, [labelInput]),
          h('td', { class: 'ds-actions' }, [remove]),
        ]),
      )
    }
    return h('table', { class: 'dataset-table' }, [
      h('colgroup', {}, [colType, colName, colLabel, h('col')]),
      h('thead', {}, [h('tr', {}, [mkTh('type', colType, 'type'), mkTh('name', colName, 'name'), mkTh('label', colLabel, 'label'), h('th', {}, [''])])]),
      body,
    ])
  }

  const list = h('div', { class: 'source-list' })
  const renderList = (items: SourceSummary[]): void => {
    list.innerHTML = ''
    list.append(items.length === 0 ? h('p', { class: 'muted' }, ['No datasets yet.']) : buildDatasetTable(items))
    hasSources = items.length > 0
    continueBtn.disabled = !hasSources
  }
  unsub = sources.subscribe(renderList)

  // local form
  const localPath = h('input', { type: 'text', placeholder: '/path/to/brainana/output', class: 'grow' }) as HTMLInputElement
  const localRecent = recents.find((r) => r.type === 'local')
  if (localRecent) localPath.value = localRecent.path
  // Folder-icon button that opens the server-side directory picker; the chosen path is written
  // straight back into the input. Inline SVG since the viewer has no shared icon set.
  const browseBtn = h('button', {
    type: 'button',
    class: 'icon-btn',
    title: 'Browse folders',
    ariaLabel: 'Browse folders',
    innerHTML: FOLDER_SVG,
  })
  browseBtn.addEventListener('click', () => {
    openFsPicker({
      title: 'choose folder',
      start: localPath.value.trim(),
      browse: (p) => files.browseFs(p),
      onPick: (chosen) => {
        localPath.value = chosen
      },
    })
  })
  const localBtn = h('button', { type: 'button', class: 'primary' }, ['add'])
  const localMsg = h('span', { class: 'msg' })
  localBtn.addEventListener(
    'click',
    asyncHandler(async () => {
      if (!localPath.value.trim()) return
      localBtn.disabled = true
      localMsg.textContent = ''
      try {
        const spec = { type: 'local' as const, path: localPath.value.trim() }
        await sources.add(spec)
        rememberLocal(spec)
        localMsg.textContent = '✓ added'
        localMsg.className = 'msg ok'
        onChanged()
      } catch (err) {
        localMsg.textContent = errorText(err)
        localMsg.className = 'msg error'
      } finally {
        localBtn.disabled = false
      }
    }),
  )

  // remote form
  const rHost = h('input', { type: 'text', placeholder: 'host' }) as HTMLInputElement
  const rUser = h('input', { type: 'text', placeholder: 'user' }) as HTMLInputElement
  const rPort = h('input', { type: 'text', placeholder: '22', class: 'port-input', inputMode: 'numeric', ariaLabel: 'port' }) as HTMLInputElement
  const rPass = h('input', { type: 'password', placeholder: 'password' }) as HTMLInputElement
  const remoteMsg = h('span', { class: 'msg' })

  // Build the (secret-carrying) connection object from the fields. Blank/invalid port → undefined,
  // so the server/SftpClient falls back to 22. The fields stay populated (just disabled) while
  // connected, so this still yields the password on repeat adds.
  const buildConnection = () => {
    const portNum = rPort.value.trim() ? Number(rPort.value.trim()) : NaN
    return {
      host: rHost.value.trim(),
      username: rUser.value.trim(),
      port: Number.isFinite(portNum) ? portNum : undefined,
      password: rPass.value || undefined,
    }
  }

  // Recall dropdown: saved connection profiles (host/port/user only — passwords are never persisted)
  // plus concrete hosts read from ~/.ssh/config. Profiles auto-save on a successful Connect; loading
  // an entry fills the fields. Only profiles are removable.
  const profileSelect = h('select', { class: 'grow', ariaLabel: 'Saved connections' }) as HTMLSelectElement
  const loadBtn = h('button', { type: 'button', class: 'ghost sm' }, ['load'])
  const removeProfileBtn = h('button', { type: 'button', class: 'ghost sm' }, ['remove'])
  let sshHostsCache: SshHost[] = []
  let recallEntries: RecallEntry[] = []
  const selectedEntry = (): RecallEntry | undefined => recallEntries[Number(profileSelect.value)]
  const updateRemoveEnabled = (): void => {
    const e = selectedEntry()
    removeProfileBtn.disabled = remoteToken !== null || !e || !e.removable
  }
  const renderRecall = (): void => {
    const profiles = loadProfiles()
    recallEntries = []
    profileSelect.innerHTML = ''
    const seen = new Set<string>()
    const keyOf = (host: string, user?: string, port?: number): string => `${user ?? ''}@${host}:${port ?? 22}`

    const profileGroup = h('optgroup', { label: 'recent' }) as HTMLOptGroupElement
    for (const p of profiles) {
      seen.add(keyOf(p.host, p.username, p.port))
      const idx = recallEntries.length
      recallEntries.push({ host: p.host, username: p.username, port: p.port, removable: true })
      profileGroup.append(h('option', { value: String(idx) }, [`${p.username}@${p.host}:${p.port ?? 22}`]))
    }

    const sshGroup = h('optgroup', { label: 'ssh config' }) as HTMLOptGroupElement
    for (const sh of sshHostsCache) {
      const addr = sh.hostName || sh.host
      const key = keyOf(addr, sh.user, sh.port)
      if (seen.has(key)) continue // a saved profile already covers this host
      seen.add(key)
      const idx = recallEntries.length
      recallEntries.push({ host: addr, username: sh.user, port: sh.port, removable: false })
      sshGroup.append(h('option', { value: String(idx) }, [sh.user ? `${sh.user}@${sh.host}` : sh.host]))
    }

    const empty = recallEntries.length === 0
    if (empty) {
      profileSelect.append(h('option', { value: '' }, ['(none saved yet)']))
    } else {
      if (profileGroup.childElementCount) profileSelect.append(profileGroup)
      if (sshGroup.childElementCount) profileSelect.append(sshGroup)
    }
    profileSelect.disabled = empty || remoteToken !== null
    loadBtn.disabled = empty || remoteToken !== null
    updateRemoveEnabled()
  }
  profileSelect.addEventListener('change', updateRemoveEnabled)
  loadBtn.addEventListener('click', () => {
    const e = selectedEntry()
    if (!e) return
    rHost.value = e.host
    rUser.value = e.username ?? ''
    rPort.value = e.port ? String(e.port) : ''
    rPass.value = '' // never stored — user re-enters
    rPass.focus()
  })
  removeProfileBtn.addEventListener('click', () => {
    const e = selectedEntry()
    if (!e || !e.removable) return
    forgetProfile({ host: e.host, port: e.port, username: e.username ?? '' })
    renderRecall()
  })
  // Prefill from the most recent profile.
  const [firstProfile] = loadProfiles()
  if (firstProfile) {
    rHost.value = firstProfile.host
    rUser.value = firstProfile.username
    rPort.value = firstProfile.port ? String(firstProfile.port) : ''
  }
  renderRecall()
  // Pull ~/.ssh/config hosts in the background; re-render the dropdown when they arrive.
  files
    .sshHosts()
    .then((hosts) => {
      sshHostsCache = hosts
      renderRecall()
    })
    .catch(() => {}) // no config / unreadable → profiles-only

  const connectBtn = h('button', { type: 'button', class: 'primary' }, ['connect'])
  const disconnectBtn = h('button', { type: 'button', class: 'ghost sm' }, ['disconnect'])
  const connBanner = h('span', { class: 'msg ok conn-banner' })

  // The repeatable add row (mirrors the local one): browse remote dirs into the path field, then add.
  // Shown only while connected.
  const remoteBrowseBtn = h('button', {
    type: 'button',
    class: 'icon-btn',
    title: 'Browse remote folders',
    ariaLabel: 'Browse remote folders',
    innerHTML: FOLDER_SVG,
  })
  const remotePath = h('input', { type: 'text', placeholder: '/remote/path/to/dataset', class: 'grow' }) as HTMLInputElement
  const remoteAddBtn = h('button', { type: 'button', class: 'primary' }, ['add'])
  const remoteAddRow = h('div', { class: 'row' }, [remotePath, remoteBrowseBtn, remoteAddBtn])
  // Add/validation status sits directly under the add row it refers to (not up in the connect row).
  const remoteAddMsg = h('span', { class: 'msg' })

  // Toggle the connected vs disconnected layout. Connection fields lock while connected so the open
  // session's identity can't drift from what add uses.
  const setConnected = (connected: boolean): void => {
    for (const input of [rHost, rUser, rPort, rPass]) input.disabled = connected
    connectBtn.style.display = connected ? 'none' : ''
    disconnectBtn.style.display = connected ? '' : 'none'
    remoteAddRow.style.display = connected ? '' : 'none'
    connBanner.style.display = connected ? '' : 'none'
    remoteAddMsg.style.display = connected ? '' : 'none'
    profileSelect.disabled = connected || recallEntries.length === 0
    loadBtn.disabled = connected || recallEntries.length === 0
    updateRemoveEnabled()
  }

  // Add a remote dataset on the open connection. Leaves the connection open so more can be added;
  // the server rejects (atomically) a root with no subjects, surfaced inline here.
  const addRemote = async (remoteRoot: string): Promise<void> => {
    remoteAddMsg.textContent = 'adding…'
    remoteAddMsg.className = 'msg'
    try {
      await sources.add({ type: 'remote', connection: buildConnection(), remoteRoot, cacheRoot: '' })
      remoteAddMsg.textContent = '✓ added'
      remoteAddMsg.className = 'msg ok'
      onChanged()
    } catch (err) {
      remoteAddMsg.textContent = errorText(err)
      remoteAddMsg.className = 'msg error'
    }
  }

  remoteBrowseBtn.addEventListener('click', () => {
    if (!remoteToken) return
    const token = remoteToken
    openFsPicker({
      title: 'choose remote folder',
      start: remotePath.value.trim(),
      browse: (p) => files.browseRemote(token, p),
      // Write the chosen path into the field (no auto-add); the connection persists after the picker.
      onPick: (abs) => {
        remotePath.value = abs
      },
    })
  })
  remoteAddBtn.addEventListener(
    'click',
    asyncHandler(async () => {
      const root = remotePath.value.trim()
      if (!root || !remoteToken) return
      remoteAddBtn.disabled = true
      await addRemote(root)
      remoteAddBtn.disabled = false
    }),
  )

  connectBtn.addEventListener(
    'click',
    asyncHandler(async () => {
      if (!rHost.value.trim() || !rUser.value.trim()) return
      connectBtn.disabled = true
      remoteMsg.textContent = 'connecting…'
      remoteMsg.className = 'msg'
      try {
        const connection = buildConnection()
        const { token } = await files.connectRemote(connection)
        remoteToken = token
        // Remember the connection (no path, no password) as soon as it succeeds, and surface it.
        rememberProfile({ host: connection.host, port: connection.port, username: connection.username })
        renderRecall()
        remoteMsg.textContent = ''
        remoteMsg.className = 'msg'
        remoteAddMsg.textContent = ''
        remoteAddMsg.className = 'msg'
        connBanner.textContent = `connected to ${connection.username}@${connection.host}`
        setConnected(true)
        remotePath.focus()
      } catch (err) {
        remoteMsg.textContent = errorText(err)
        remoteMsg.className = 'msg error'
      } finally {
        connectBtn.disabled = false
      }
    }),
  )
  disconnectBtn.addEventListener('click', () => {
    teardownRemote()
    rPass.value = ''
    remotePath.value = ''
    remoteMsg.textContent = ''
    remoteMsg.className = 'msg'
    remoteAddMsg.textContent = ''
    remoteAddMsg.className = 'msg'
    setConnected(false)
    renderRecall() // re-enable recall now that we're disconnected
  })

  // Port shares a row with host but must stay narrow rather than flex like the other fields.
  const portField = field('port', rPort)
  portField.classList.add('port-field')

  const dialog = h('div', { class: 'dialog' }, [
    h('div', { class: 'dialog-head' }, [h('h2', {}, ['datasets']), h('span', { class: 'spacer' }), closeBtn]),
    list,
    h('div', { class: 'source-forms' }, [
      h('div', { class: 'source-form' }, [
        h('h3', {}, ['local dataset']),
        h('div', { class: 'row' }, [localPath, browseBtn, localBtn]),
        localMsg,
      ]),
      h('div', { class: 'source-form' }, [
        h('h3', {}, ['remote dataset (SSH/SFTP)']),
        // Top recall: reload a saved connection or a ~/.ssh/config host into the fields below.
        h('div', { class: 'row conn-recall' }, [h('span', { class: 'muted' }, ['recent']), profileSelect, loadBtn, removeProfileBtn]),
        // Fields in a 2-column grid: host (wide) + port (narrow); then user + password (equal).
        h('div', { class: 'row' }, [field('host', rHost), portField]),
        h('div', { class: 'row' }, [field('user', rUser), field('password', rPass)]),
        // Connect/disconnect action, status message to its left.
        h('div', { class: 'row' }, [remoteMsg, h('span', { class: 'spacer' }), connectBtn, disconnectBtn]),
        connBanner,
        remoteAddRow,
        remoteAddMsg,
      ]),
    ]),
    h('div', { class: 'dialog-foot' }, [h('span', { class: 'spacer' }), continueBtn]),
  ])
  setConnected(false) // start disconnected: hide disconnect/add-row/banner
  overlay.append(dialog)
  document.body.append(overlay)
}

