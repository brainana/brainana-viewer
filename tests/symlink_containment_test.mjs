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

  // --- the reported root is the path the CALLER gave, not its canonical form -------------------
  // Containment has to compare canonical paths, but `root` is also the user-facing path: it is what
  // summarizeSource returns, what the sources dialog shows, and what the report prints. Resolving
  // symlinks for the security check must not rewrite it.
  //
  // This is exactly what broke macOS CI: /var is a symlink to /private/var, so realpath'ing the root
  // made a source opened at /var/folders/... report itself as /private/var/folders/... .
  {
    const realDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-symlink-real-'))
    await fsp.mkdir(path.join(realDir, 'sub-y', 'anat'), { recursive: true })
    await fsp.writeFile(path.join(realDir, 'sub-y', 'anat', 'v.nii.gz'), 'INSIDE')

    // A root reached THROUGH a symlink, the way /var/... is on macOS.
    const linkedRoot = path.join(os.tmpdir(), `brainana-symlink-alias-${process.pid}`)
    await fsp.rm(linkedRoot, { recursive: true, force: true })
    fs.symlinkSync(realDir, linkedRoot, 'dir')
    try {
      const linked = new LocalDataSource({ id: 'local-bbbbbbbbbbbb', root: linkedRoot, manifest: viewerManifestProvider })
      assert.equal(linked.root, linkedRoot, 'root reports the path it was given, not the resolved one')

      // ...and containment still works through it, in both directions.
      const opened = await linked.openFile('sub-y/anat/v.nii.gz')
      const chunks = []
      for await (const c of opened.stream) chunks.push(c)
      assert.equal(Buffer.concat(chunks).toString('utf8'), 'INSIDE', 'files under a symlinked root are still served')

      fs.symlinkSync(path.join(outside, 'secret.nii.gz'), path.join(realDir, 'escape.nii.gz'))
      await assert.rejects(async () => {
        const bad = await linked.openFile('escape.nii.gz')
        for await (const chunk of bad.stream) void chunk // drain
      }, /not found|outside/i, 'and an escape through a symlinked root is still refused')
      ok('a root reached through a symlink keeps its given path AND stays contained')
    } finally {
      await fsp.rm(linkedRoot, { recursive: true, force: true })
      await fsp.rm(realDir, { recursive: true, force: true })
    }
  }

  // --- writes must be contained too --------------------------------------------------------------
  // resolveWithin (used by saveFile/mkdir) is LEXICAL, like isWithin was. Reads were fixed above;
  // a write that escapes is strictly worse, since it creates files outside the root rather than
  // merely reading them.
  {
    const { Readable } = await import('node:stream')
    await assert.rejects(
      () => source.saveFile('escapedir/written.txt', Readable.from(['pwned']), { overwrite: true }),
      /not found|outside/i,
      'saveFile through a directory symlink that leaves the root is refused',
    )
    assert.equal(fs.existsSync(path.join(outside, 'secretdir', 'written.txt')), false, 'and nothing is written outside')
    ok('saveFile refuses to write through a symlink that leaves the root')

    await assert.rejects(() => source.mkdir('escapedir/newdir'), /not found|outside/i)
    assert.equal(fs.existsSync(path.join(outside, 'secretdir', 'newdir')), false)
    ok('mkdir refuses to create a directory outside the root')

    // Ordinary writes inside the root still work.
    const saved = await source.saveFile('sub-x/anat/exported.txt', Readable.from(['ok']), { overwrite: true })
    assert.equal(saved.path, 'sub-x/anat/exported.txt')
    assert.equal(fs.readFileSync(path.join(root, 'sub-x', 'anat', 'exported.txt'), 'utf8'), 'ok')
    ok('a normal write inside the root is unaffected')
  }

  await fsp.rm(root, { recursive: true, force: true })
  await fsp.rm(outside, { recursive: true, force: true })
}
console.log(`\nsymlink_containment: ${passed} checks passed`)
