// Viewer desktop entry (`npm run dev:desktop` / packaged app). Composition root: it hands the
// generic, tool-agnostic Electron shell the Viewer's identity + domain manifest provider. This is
// the ONLY place the Viewer domain meets the desktop platform — packages/core-* stay domain-free.
// Structurally identical to apps/viewer/launch.mjs (the browser entry); only the shell differs.
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '@brainana/core-desktop/main.mjs'
import { viewerManifestProvider } from './server/manifest.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, 'dist')
const distRoot = fs.existsSync(dist) ? dist : null

runDesktop({
  manifestProvider: viewerManifestProvider,
  appLabel: 'Brainana Viewer',
  cacheApp: 'BrainanaViewer',
  distRoot,
  preferredPort: 5173,
  // Everything the Viewer remembers between launches. The desktop shell persists exactly these keys
  // in files under userData (the loopback port, and so localStorage, can change per launch).
  // tests/preference_keys_test.mjs checks this list against the keys the code actually uses.
  preferenceKeys: [
    'brainana.recentSources.v1',
    'brainana.remoteProfiles.v1',
    'brainana.fovMode.v1',
    'brainana.viewer.preferences.v1',
    'brainana.viewer.panels.v1',
  ],
  settingsMenu: true,
}).catch((error) => {
  console.error('Desktop launch failed:', error)
  process.exit(1)
})
