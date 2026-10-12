// Tool-agnostic Electron main process. Owns the `app` lifecycle ONLY; it knows nothing about
// manifests/FreeSurfer/domain — the app (apps/<tool>/desktop.mjs) injects its identity + manifest
// provider, exactly like apps/<tool>/launch.mjs does for the browser launcher.
//
// The whole desktop story is: reuse `bootServer()` (token → free loopback port → core server),
// then load its URL in a BrowserWindow instead of opening the system browser. The server
// templates the session token into index.html + sets a loopback cookie, so the window
// authenticates exactly like a browser — no frontend changes.
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { bootServer } from '@brainana/core-launcher/launch.mjs'
import { createMainWindow } from './window.mjs'
import { applyAppMenu } from './menu.mjs'
import { isInternalUrl } from './navigation.mjs'
import { createPreferenceStore } from './preferenceStore.mjs'

// GPU switches must be set BEFORE app is ready. Chromium blocklists some Linux GPU/driver combos
// and can silently drop WebGL2 to SwiftShader; NiiVue hard-requires WebGL2 (gated in
// browserCapabilities.ts), so we opt out of the blocklist. We deliberately do NOT call
// app.disableHardwareAcceleration() — that would kill WebGL2. If a specific box still fails,
// `--use-gl=angle` / `--use-angle=gl` is the documented escape hatch.
app.commandLine.appendSwitch('ignore-gpu-blocklist')

export async function runDesktop(options = {}) {
  // preferenceKeys: the localStorage-style keys the app persists through the desktop bridge (see
  // preferenceStore.mjs). Empty = no preload, no IPC. settingsMenu: add a "Settings…" menu item
  // that asks the renderer to open its settings (the app owns the dialog).
  const { appLabel = 'Brainana', preferenceKeys = [], settingsMenu = false } = options

  // One window, one server. A second launch focuses the existing window instead of minting a
  // second token on a second port.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let server = null
  let preferences = null
  let flushed = false

  // Tear down the loopback server exactly once (its 'close' handler runs registry.closeAll(),
  // which drops any open SFTP connections). Guarded so before-quit + window-all-closed don't
  // double-close.
  let closing = false
  const closeServer = () => {
    if (closing || !server) return
    closing = true
    server.close()
  }

  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  // Single-window viewer: quitting when the window closes (all platforms) keeps the server tied
  // to the window's lifetime — no orphaned loopback server/port. This intentionally overrides the
  // macOS "stay resident" convention; a headless data server with no window would be surprising.
  app.on('window-all-closed', () => {
    closeServer()
    app.quit()
  })

  // Hold the quit until queued preference writes reach disk. window-all-closed also lands here,
  // because app.quit() emits before-quit.
  app.on('before-quit', (event) => {
    closeServer()
    if (!preferences || flushed) return
    event.preventDefault()
    flushed = true
    void preferences
      .flush()
      .catch((err) => console.error('Preferences could not be flushed:', err.message))
      .finally(() => app.quit())
  })

  try {
    await app.whenReady()
    // Replace Electron's noisy default menu with a curated one (global; set once after ready).
    applyAppMenu(appLabel, { settings: settingsMenu })
    const boot = await bootServer(options)
    server = boot.server
    if (preferenceKeys.length) preferences = createPreferenceStore(path.join(app.getPath('userData'), 'preferences'), preferenceKeys)
    const win = createMainWindow(boot.url, { appLabel, preload: Boolean(preferences) })
    if (preferences) handlePreferenceIpc(win, boot.url, preferences)
  } catch (error) {
    console.error(`${appLabel} failed to start:`, error)
    closeServer()
    app.quit()
    process.exitCode = 1
  }
}

// Only the app's own top frame, on the app's own origin, may read or write preferences.
function handlePreferenceIpc(win, appUrl, store) {
  const verify = (event) => {
    const frame = event.senderFrame
    if (event.sender !== win.webContents || !frame || frame !== win.webContents.mainFrame || !isInternalUrl(appUrl, frame.url)) {
      throw new Error('Untrusted preferences request')
    }
  }
  ipcMain.handle('brainana:preferences-read', async (event) => {
    verify(event)
    return { keys: store.keys(), values: await store.readAll() }
  })
  ipcMain.handle('brainana:preferences-write', async (event, key, value) => {
    verify(event)
    await store.write(key, value)
  })
}
