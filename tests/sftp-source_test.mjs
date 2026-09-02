// SFTP data-source test (plan §9): stand up an in-process, fs-backed fake SFTP server and
// round-trip through SftpDataSource. Skips (exit 0) when `ssh2` is not installed so the
// suite stays green in environments without the optional dependency.
//
// The fake server now lives in fixtures/fakeSftpServer.mjs, shared with sftp-hostkey_test.mjs so
// both exercise the same double. Since host-key verification became mandatory (audit C1), this
// test must record the double's real host key in a known_hosts file like any other server.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hasSsh2, startFakeSftpServer } from './fixtures/fakeSftpServer.mjs'

if (!hasSsh2) {
  console.log('  skip - ssh2 not installed (run `npm install`)')
  console.log('sftp-source_test: skipped')
  process.exit(0)
}


// Windows can't delete a directory that still holds an open file handle (EBUSY/EPERM), and
// the SFTP server/cache may not have released every fd the instant close() returns. Retry a
// few times with a short backoff so teardown is reliable across platforms.
async function rmWithRetry(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 10 || (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'ENOTEMPTY')) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

async function main() {
  const { SftpDataSource } = await import('@brainana/core-server/sftpSource.mjs')
  const { viewerManifestProvider } = await import('../apps/viewer/server/manifest.mjs')

  const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-remote-'))
  const cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-cache-'))
  // Seed a subject with anat + a fastsurfer surf dir.
  await fsp.mkdir(path.join(remoteRoot, 'sub-r1', 'anat'), { recursive: true })
  await fsp.writeFile(path.join(remoteRoot, 'sub-r1', 'anat', 'sub-r1_space-T1w_desc-preproc_T1w.nii.gz'), Buffer.from('REMOTE-VOLUME-BYTES-9876543210'))

  const { server, port, clients, hostKey } = await startFakeSftpServer(remoteRoot)

  // Trust this server's key, exactly as a user would after their first `ssh` to it. Written to a
  // temp file rather than the real ~/.ssh/known_hosts so the suite never touches the developer's.
  const knownHostsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-knownhosts-'))
  const knownHostsPath = path.join(knownHostsDir, 'known_hosts')
  await fsp.writeFile(knownHostsPath, `[127.0.0.1]:${port} ${hostKey.type} ${hostKey.base64}\n`)

  const source = new SftpDataSource({
    id: 'remote-aaaaaaaaaaaa',
    connection: { host: '127.0.0.1', port, username: 'test', password: 'test', knownHostsPath },
    remoteRoot,
    cacheRoot,
    manifest: viewerManifestProvider,
  })

  try {
    await source.open()
    ok('SftpDataSource connects to the fake SFTP server')

    const monkeys = await source.listMonkeys()
    assert.deepEqual(monkeys.map((m) => m.id), ['sub-r1'])
    ok('listMonkeys finds the remote subject')

    const dirs = await source.listDirectories('')
    assert.ok(dirs.entries.some((e) => e.name === 'sub-r1' && e.isMonkey))
    ok('listDirectories lists remote entries')

    // openFile streams remote bytes (via cache) with range support.
    const opened = await source.openFile('sub-r1/anat/sub-r1_space-T1w_desc-preproc_T1w.nii.gz', 'bytes=0-5')
    const chunks = []
    for await (const c of opened.stream) chunks.push(c)
    assert.equal(opened.partial, true)
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'REMOTE')
    ok('openFile serves a remote byte range through the cache')

    // saveFile uploads over SFTP atomically.
    const { Readable } = await import('node:stream')
    const saved = await source.saveFile('sub-r1/roi/new.txt', Readable.from(['roi-data']), { overwrite: false })
    assert.equal(saved.exists, false)
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'sub-r1', 'roi', 'new.txt'), 'utf8'), 'roi-data')
    ok('saveFile uploads over SFTP and refuses to clobber')

    const clobber = await source.saveFile('sub-r1/roi/new.txt', Readable.from(['x']), { overwrite: false })
    assert.equal(clobber.exists, true)
    ok('saveFile returns exists=true without overwrite')
  } finally {
    await source.close()
    // Force any lingering server-side connections shut, then await the close callback, so no
    // open socket/fd keeps the event loop alive (Windows would otherwise hang, then SIGKILL).
    for (const client of clients) client.end()
    await new Promise((resolve) => server.close(resolve))
    await rmWithRetry(remoteRoot)
    await rmWithRetry(cacheRoot)
    await rmWithRetry(knownHostsDir)
  }

  console.log(`sftp-source_test: ${passed} checks passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
