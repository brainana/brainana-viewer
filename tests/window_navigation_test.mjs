// Navigation policy for the desktop BrowserWindow (audit finding L11).
//
// The window is a locked-down Chromium client of the loopback server: contextIsolation on,
// nodeIntegration off, sandbox on. What was missing is a limit on where it may GO. Nothing pinned
// it to the loopback origin, and nothing stopped a link from spawning a second, unhardened window.
// The data it renders comes from remote SFTP hosts, so "the content is ours" is not an assumption
// worth resting on.
//
// The policy is pure and lives here; window.mjs is the (untestable) Electron wiring around it.
import assert from 'node:assert/strict'
import { isInternalUrl } from '@brainana/core-desktop/navigation.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const APP = 'http://127.0.0.1:5173/'

// The app's own origin is the only place the window may navigate.
for (const good of ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173/index.html', 'http://127.0.0.1:5173/brainana-data/local-abc/sub-x/anat/t1.nii.gz', 'http://127.0.0.1:5173/api/runtime?x=1#frag']) {
  assert.equal(isInternalUrl(APP, good), true, `${good} is internal`)
}
ok('same-origin paths on the app server are internal')

// A different port is a different server, even on loopback — the token is per-launch and per-port.
assert.equal(isInternalUrl(APP, 'http://127.0.0.1:5174/'), false, 'another loopback port is external')
// Same host, wrong scheme.
assert.equal(isInternalUrl(APP, 'https://127.0.0.1:5173/'), false, 'https to the http origin is external')
ok('a different port or scheme is external, not merely a different path')

for (const bad of [
  'https://example.com/',
  'http://evil.com:5173/',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'about:blank',
  'chrome://settings',
  '',
  'not a url',
  null,
  undefined,
]) {
  assert.equal(isInternalUrl(APP, bad), false, `${JSON.stringify(bad)} is external`)
}
ok('remote origins, file/javascript/data/about/chrome schemes and junk are all external')

// A malformed app URL must not accidentally make everything internal.
assert.equal(isInternalUrl('', 'http://127.0.0.1:5173/'), false)
assert.equal(isInternalUrl(null, 'http://127.0.0.1:5173/'), false)
ok('an unusable app URL denies rather than allows')

console.log(`\nwindow_navigation: ${passed} checks passed`)
