// Path containment must survive symlinks (audit finding M4).
//
// isWithin() compares paths LEXICALLY — it never calls realpath — so a symlink INSIDE a data root
// that points outside it passed containment and was then followed by readdir/createReadStream.
// cleanRelative already blocks `..` in the URL, so this is the remaining way out of the root, and
// it matters wherever datasets are rsync'd or shared between accounts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalDataSource } from '@brainana/core-server/localSource.mjs'
import { viewerManifestProvider } from '../apps/viewer/server/manifest.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-symlink-root-'))
const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-symlink-outside-'))
await fsp.writeFile(path.join(outside, 'secret.nii.gz'), 'SECRET-OUTSIDE-THE-ROOT')
await fsp.mkdir(path.join(outside, 'secretdir'), { recursive: true })
await fsp.mkdir(path.join(root, 'sub-x', 'anat'), { recursive: true })
await fsp.writeFile(path.join(root, 'sub-x', 'anat', 'real.nii.gz'), 'LEGITIMATE-DATA')

// Windows needs elevation (or developer mode) to create symlinks; skip rather than fail there.
try {
  fs.symlinkSync(path.join(outside, 'secret.nii.gz'), path.join(root, 'escape.nii.gz'))
  fs.symlinkSync(path.join(outside, 'secretdir'), path.join(root, 'escapedir'), 'dir')
  fs.symlinkSync(path.join(root, 'sub-x', 'anat', 'real.nii.gz'), path.join(root, 'inside-link.nii.gz'))
} catch {
  console.log('  skip - symlinks not creatable on this platform')
  console.log('symlink_containment_test: skipped')
  process.exit(0)
}

const source = new LocalDataSource({ id: 'local-aaaaaaaaaaaa', root, manifest: viewerManifestProvider })

const readAll = async (rel) => {
  const opened = await source.openFile(rel)
  const chunks = []
  for await (const c of opened.stream) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

try {
  // A symlinked FILE whose target is outside the root must not be served.
  await assert.rejects(() => readAll('escape.nii.gz'), /not found|outside/i, 'a symlink escaping the root is refused')
  ok('openFile refuses a symlink whose target leaves the root')

  // A symlinked DIRECTORY escaping the root must not be listable.
  await assert.rejects(() => source.listDirectories('escapedir'), /not found|outside/i)
  ok('listDirectories refuses a directory symlink that leaves the root')
  await assert.rejects(() => source.listImportFiles('escapedir'), /not found|outside/i)
  ok('listImportFiles refuses a directory symlink that leaves the root')

  // Symlinks that stay inside the root are legitimate and must keep working — datasets use them.
  assert.equal(await readAll('inside-link.nii.gz'), 'LEGITIMATE-DATA')
  ok('a symlink pointing INSIDE the root is still served')

  // And ordinary files are untouched.
  assert.equal(await readAll('sub-x/anat/real.nii.gz'), 'LEGITIMATE-DATA')
  ok('ordinary files are unaffected')
} finally {
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.rm(outside, { recursive: true, force: true })
}

console.log(`\nsymlink_containment: ${passed} checks passed`)
