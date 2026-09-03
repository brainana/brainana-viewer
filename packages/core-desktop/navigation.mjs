// Navigation policy for the desktop window. Pure and Electron-free so it is unit-testable; the
// wiring that enforces it lives in window.mjs.
//
// The window is already a hardened Chromium client (contextIsolation on, nodeIntegration off,
// sandbox on), but hardening the RENDERER says nothing about where the window may navigate. Without
// a policy, a link — in a report, an atlas description, anything derived from data fetched off a
// remote SFTP host — could move the window off the app, or open a second window whose webPreferences
// we never chose. "The content is ours" is not an assumption this app gets to make: most of what it
// renders came from somewhere else.

/**
 * True when `target` is the app's own loopback server: same scheme, host AND port.
 *
 * Port matters as much as host here. The session token is minted per launch and scoped to one
 * port, so a second server on 127.0.0.1:5174 is a different trust domain despite the shared host —
 * treating loopback as one origin would be the same mistake as trusting any Host header.
 *
 * Anything unparseable (including the non-hierarchical schemes that carry no origin at all —
 * javascript:, data:, about:) is external, so the caller denies it.
 */
export function isInternalUrl(appUrl, target) {
  const appOrigin = originOf(appUrl)
  if (!appOrigin) return false // no usable app origin: deny rather than allow everything
  return originOf(target) === appOrigin
}

function originOf(value) {
  if (typeof value !== 'string' || value === '') return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  // `new URL('javascript:alert(1)')` parses, but its origin is the string "null" — as it is for
  // data: and about:. Reject those explicitly rather than letting two "null" origins compare equal.
  if (url.origin === 'null' || !url.origin) return null
  return url.origin
}
