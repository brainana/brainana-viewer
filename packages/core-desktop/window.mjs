// Builds the single hardened BrowserWindow. Kept separate from lifecycle (main.mjs) so future
// tools (Aligner, Editor) reuse identical window hardening. The window is just a locked-down
// Chromium CLIENT of the loopback server — it needs no Node access (the backend IS the HTTP
// server), so we keep contextIsolation on, nodeIntegration off, sandbox on.
import { BrowserWindow, shell } from 'electron'
import { isInternalUrl } from './navigation.mjs'

export function createMainWindow(url, { appLabel = 'Brainana' } = {}) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: appLabel,
    backgroundColor: '#0b0d10', // avoid a white flash before the SPA paints
    show: false,
    // Hide the in-window menu bar (Linux/Windows) while keeping the menu installed, so its
    // accelerators (Quit, Copy/Paste, Reload, DevTools, Zoom, Fullscreen) still work. Alt
    // momentarily reveals the bar. No-op on macOS, where the menu lives in the system bar.
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // ---- Navigation policy -------------------------------------------------------------------
  // Hardening the renderer says nothing about where the window may GO. Both guards below are
  // needed: setWindowOpenHandler covers window.open and target=_blank (which would otherwise get a
  // NEW window whose webPreferences we never chose), will-navigate covers the current window being
  // driven elsewhere by a link or a script. Most of what this app renders is derived from data
  // fetched off a remote host, so neither path is hypothetical.

  // Never open a second Electron window. A genuinely external link is handed to the user's real
  // browser, where it belongs and where it is sandboxed by someone else; anything else is dropped.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isInternalUrl(url, target)) {
      // openExternal on an arbitrary string is itself a hazard (file:, and on Windows shell verbs),
      // so only ordinary web URLs are forwarded. Everything else is silently denied.
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    }
    return { action: 'deny' }
  })

  // Keep the window itself pinned to the app's own loopback origin.
  win.webContents.on('will-navigate', (event, target) => {
    if (!isInternalUrl(url, target)) event.preventDefault()
  })

  // Show only once the first paint is ready (no blank/white window on slow first load).
  win.once('ready-to-show', () => win.show())
  void win.loadURL(url)
  return win
}
