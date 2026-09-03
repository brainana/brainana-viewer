// Shared test double: an in-process, fs-backed SFTP server.
//
// Extracted from sftp-source_test.mjs so the host-key tests exercise the SAME server rather than a
// second, subtly different one. `hostKey` is returned alongside the port because host-key
// verification tests need to write the server's real public key into a known_hosts file.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

let ssh2 = null
try {
  ssh2 = (await import('ssh2')).default
} catch {
  ssh2 = null
}

/** True when the optional `ssh2` dependency is installed; tests skip cleanly when it is not. */
export const hasSsh2 = ssh2 != null

// ---------------------------------------------------------------------------
// Minimal fs-backed SFTP server (test double). Maps SFTP ops onto a temp dir.
// ---------------------------------------------------------------------------
export function startFakeSftpServer(rootDir) {
  const { Server } = ssh2
  const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })

  // Our client always sends absolute remote paths (remoteRoot is absolute), so serve the
  // real fs directly; relative paths (if any) resolve under rootDir. Test double only.
  const toLocal = (p) => (path.isAbsolute(p) ? p : path.join(rootDir, p))

  const clients = []
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.push(client)
    // A client that REJECTS our host key disconnects mid-handshake, which the server side surfaces
    // as an error event. Unhandled, that would crash the test process via the harness — so swallow
    // it: for these tests a refused handshake is the expected outcome, not a fault.
    client.on('error', () => {})
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map()
          let counter = 0
          const newHandle = (obj) => {
            const id = counter++
            handles.set(id, obj)
            const buf = Buffer.alloc(4)
            buf.writeUInt32BE(id, 0)
            return buf
          }
          const attrsFor = (st) => ({ mode: st.mode, size: st.size, uid: st.uid, gid: st.gid, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) })

          sftp.on('REALPATH', (reqid, p) => {
            const abs = path.posix.normalize(p.startsWith('/') ? p : `/${p}`)
            sftp.name(reqid, [{ filename: abs, longname: abs, attrs: {} }])
          })
          sftp.on('STAT', statHandler)
          sftp.on('LSTAT', statHandler)
          function statHandler(reqid, p) {
            try {
              sftp.attrs(reqid, attrsFor(fs.statSync(toLocal(p))))
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          }
          sftp.on('OPENDIR', (reqid, p) => {
            try {
              const names = fs.readdirSync(toLocal(p))
              sftp.handle(reqid, newHandle({ type: 'dir', dir: p, names, read: false }))
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          })
          sftp.on('READDIR', (reqid, handle) => {
            const h = handles.get(handle.readUInt32BE(0))
            if (!h || h.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (h.read) return sftp.status(reqid, STATUS_CODE.EOF)
            h.read = true
            const list = h.names.map((name) => {
              const st = fs.statSync(path.join(toLocal(h.dir), name))
              return { filename: name, longname: name, attrs: attrsFor(st) }
            })
            sftp.name(reqid, list)
          })
          sftp.on('OPEN', (reqid, filename, flags, _attrs) => {
            let mode = 'r'
            if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.APPEND ? 'a' : 'w'
            try {
              const fd = fs.openSync(toLocal(filename), mode)
              sftp.handle(reqid, newHandle({ type: 'file', fd }))
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          })
          sftp.on('READ', (reqid, handle, offset, length) => {
            const h = handles.get(handle.readUInt32BE(0))
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            const buf = Buffer.alloc(length)
            const bytes = fs.readSync(h.fd, buf, 0, length, offset)
            if (bytes <= 0) return sftp.status(reqid, STATUS_CODE.EOF)
            sftp.data(reqid, buf.subarray(0, bytes))
          })
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const h = handles.get(handle.readUInt32BE(0))
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            fs.writeSync(h.fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('MKDIR', (reqid, p) => {
            try {
              fs.mkdirSync(toLocal(p), { recursive: true })
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('RENAME', (reqid, from, to) => {
            try {
              fs.renameSync(toLocal(from), toLocal(to))
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('REMOVE', (reqid, p) => {
            try {
              fs.rmSync(toLocal(p), { force: true })
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('FSTAT', (reqid, handle) => {
            const h = handles.get(handle.readUInt32BE(0))
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            sftp.attrs(reqid, attrsFor(fs.fstatSync(h.fd)))
          })
          sftp.on('CLOSE', (reqid, handle) => {
            const id = handle.readUInt32BE(0)
            const h = handles.get(id)
            if (h?.type === 'file') fs.closeSync(h.fd)
            handles.delete(id)
            sftp.status(reqid, STATUS_CODE.OK)
          })
        })
      })
    })
  })

  // The server's public host key in SSH wire format — base64 of this is exactly what known_hosts
  // stores and exactly what ssh2 hands to hostVerifier, so host-key tests can write a real entry.
  const hostKeyBlob = ssh2.utils.parseKey(privateKey).getPublicSSH()
  const hostKey = { type: ssh2.utils.parseKey(privateKey).type, base64: hostKeyBlob.toString('base64') }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, clients, hostKey }))
  })
}
