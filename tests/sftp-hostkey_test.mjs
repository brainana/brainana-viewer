// End-to-end host-key verification through SftpClient (audit finding C1).
//
// The unit tests in known_hosts_test.mjs prove the trust DECISION; these prove it is actually
// enforced on a real ssh2 handshake against a real server whose real host key we control.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hasSsh2, startFakeSftpServer } from './fixtures/fakeSftpServer.mjs'

if (!hasSsh2) {
  console.log('  skip - ssh2 not installed (run `npm install`)')
  console.log('sftp-hostkey_test: skipped')
  process.exit(0)
}

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const { SftpClient } = await import('@brainana/core-server/sftpClient.mjs')

const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-hostkey-'))
const { server, port, clients, hostKey } = await startFakeSftpServer(remoteRoot)
const knownHostsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-knownhosts-'))
const knownHostsPath = path.join(knownHostsDir, 'known_hosts')

const connect = async (opts = {}) => {
  const client = new SftpClient({ host: '127.0.0.1', port, username: 'test', password: 'test', knownHostsPath, ...opts })
  try {
    await client.connect()
    return null
  } catch (error) {
    return error
  } finally {
    await client.close()
  }
}

try {
  // 1. First contact: nothing in known_hosts. This is the state EVERY user starts in, and the old
  //    behaviour was to connect anyway and send the password.
  await fsp.writeFile(knownHostsPath, '')
  const unknown = await connect()
  assert.ok(unknown, 'an unknown host key must refuse the connection')
  assert.match(unknown.message, /host key/i, 'the error names the host key as the reason')
  assert.match(unknown.message, /ssh-keyscan|known_hosts/i, 'the error tells the user how to proceed')
  ok('an unverified host is refused, with an actionable message')

  // 2. The host key is trusted: normal operation is unaffected.
  await fsp.writeFile(knownHostsPath, `[127.0.0.1]:${port} ${hostKey.type} ${hostKey.base64}\n`)
  assert.equal(await connect(), null, 'a known host key connects normally')
  ok('a host key present in known_hosts connects')

  // 3. THE ATTACK: known_hosts holds a different key for this host — someone is in the middle.
  const otherKey = `${hostKey.base64.slice(0, -4)}AAAA`
  await fsp.writeFile(knownHostsPath, `[127.0.0.1]:${port} ${hostKey.type} ${otherKey}\n`)
  const mismatch = await connect()
  assert.ok(mismatch, 'a changed host key must refuse the connection')
  assert.match(mismatch.message, /changed|mismatch/i, 'the error calls out that the key CHANGED')
  ok('a changed host key is refused and reported as a change, not first contact')

  // 4. A revoked key is refused even though it is the key the server really presents.
  await fsp.writeFile(knownHostsPath, `@revoked [127.0.0.1]:${port} ${hostKey.type} ${hostKey.base64}\n`)
  const revoked = await connect()
  assert.ok(revoked, 'a revoked host key must refuse the connection')
  assert.match(revoked.message, /revoked/i)
  ok('a @revoked host key is refused')

  // 5. A missing known_hosts file is first contact, not an accident that opens the gate.
  const missing = await connect({ knownHostsPath: path.join(knownHostsDir, 'does-not-exist') })
  assert.ok(missing, 'an absent known_hosts file must not mean "trust everything"')
  ok('an absent known_hosts file refuses rather than defaulting open')
} finally {
  for (const client of clients) client.end()
  await new Promise((resolve) => server.close(resolve))
  await fsp.rm(remoteRoot, { recursive: true, force: true })
  await fsp.rm(knownHostsDir, { recursive: true, force: true })
}

console.log(`\nsftp-hostkey_test: ${passed} checks passed`)
