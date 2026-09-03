// Unit tests for core-server/runtime.mjs browseDir: the folder-picker backing the "Add local
// dataset" dialog. Uses a temp fixture and an injected homedir (browseDir defaults to the home
// dir for empty/relative input). Exercises the drive/filesystem-root parent case that differs
// across platforms.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { browseDir } from '@brainana/core-server/runtime.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-browse-'))
  try {
    await fsp.mkdir(path.join(root, 'beta'))
    await fsp.mkdir(path.join(root, 'alpha'))
    await fsp.mkdir(path.join(root, '.hidden'))
    await fsp.writeFile(path.join(root, 'a-file.txt'), 'x')

    const listed = browseDir(root)
    assert.deepEqual(listed.entries.map((e) => e.name), ['alpha', 'beta'], 'lists dirs only, natural-sorted, dotfiles skipped')
    assert.ok(listed.entries.every((e) => e.isDir), 'every entry is a directory')
    assert.equal(listed.path, path.resolve(root), 'echoes the resolved path')
    assert.equal(listed.parent, path.dirname(path.resolve(root)), 'parent points one level up')
    ok('browseDir lists subdirectories only, sorted, dotfiles hidden')

    // Filesystem root: parent must be null so the picker cannot loop "up" forever. path.parse
    // gives the root for the host ('/' on POSIX, e.g. 'C:\\' on Windows).
    const fsRoot = path.parse(path.resolve(root)).root
    assert.equal(browseDir(fsRoot).parent, null, 'filesystem root reports parent: null')
    ok('browseDir returns parent:null at the filesystem root (no infinite up-navigation)')

    // Empty or non-absolute input falls back to the (injected) home directory.
    const fromHome = browseDir('', { homedir: root })
    assert.equal(fromHome.path, path.resolve(root), 'empty path defaults to homedir')
    assert.equal(browseDir('relative/not/absolute', { homedir: root }).path, path.resolve(root), 'relative path defaults to homedir')
    ok('browseDir defaults empty/relative input to the home directory')

    // Error surface: nonexistent -> 404, a file (not a dir) -> 400.
    const missing = path.join(root, 'does-not-exist')
    assert.throws(() => browseDir(missing), (e) => e.statusCode === 404, 'nonexistent path is 404')
    assert.throws(() => browseDir(path.join(root, 'a-file.txt')), (e) => e.statusCode === 400, 'a file is 400 (not a directory)')
    ok('browseDir maps missing->404 and not-a-directory->400')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }

  console.log(`browse_test: ${passed} checks passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
