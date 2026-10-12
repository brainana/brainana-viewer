// Renderer bridge for desktop preferences. Attached only when the app declares preference keys
// (see main.mjs). Sandbox-compatible CommonJS: it may require nothing but 'electron', and exposes
// three narrow functions through contextBridge — never ipcRenderer itself or the IPC event.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('brainanaPreferences', {
  readAll: () => ipcRenderer.invoke('brainana:preferences-read'),
  write: (key, value) => ipcRenderer.invoke('brainana:preferences-write', key, value),
  onSettings: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('brainana:settings-open', listener)
    return () => ipcRenderer.removeListener('brainana:settings-open', listener)
  },
})
