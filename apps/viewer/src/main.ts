// App bootstrap. Gate on WebGL2 (hard requirement), then mount the single-screen dashboard.
import { detectCapabilities, isSupported } from '@brainana/core-client/browserCapabilities.ts'
import { RuntimeClient } from '@brainana/core-client/runtimeClient.ts'
import { SourceManager } from '@brainana/core-client/sourceManager.ts'
import { FilesystemClient } from '@brainana/core-client/filesystemClient.ts'
import { initializePreferenceStorage } from '@brainana/core-client/preferenceStorage.ts'
import { mountDashboard } from './ui/dashboard.ts'
import { loadPreferences } from './settings/preferences.ts'
import '@brainana/ui/theme.css' // shared design tokens + fonts — must load before viewer layout
import './style.css'

function showUnsupported(root: HTMLElement, messages: string[]): void {
  root.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'gate'
  const heading = document.createElement('h1')
  heading.textContent = 'Browser not supported'
  box.appendChild(heading)
  for (const m of messages) {
    const p = document.createElement('p')
    p.textContent = m
    box.appendChild(p)
  }
  root.appendChild(box)
}

async function main(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app')
  if (!root) return

  const caps = detectCapabilities()
  if (!isSupported(caps)) {
    showUnsupported(root, caps.messages)
    return
  }

  // Desktop preferences load asynchronously once; everything after reads them synchronously.
  await initializePreferenceStorage()
  loadPreferences()
  const client = new RuntimeClient()
  const sources = new SourceManager(client)
  const files = new FilesystemClient(client)
  mountDashboard(root, { client, sources, files })
}

main().catch((err: unknown) => console.error('Viewer failed to start:', err))
