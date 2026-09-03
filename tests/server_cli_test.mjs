// Unit tests for the headless server CLI's token resolution (audit finding M1).
//
// `runServerCli` used to default `token` to null, and createTokenGuard(null) disables the guard
// entirely — so `npm run server` served every /api and /brainana-data route unauthenticated. The
// safe default is inverted here: authentication is on unless the operator explicitly opts out.
import assert from 'node:assert/strict'
import { resolveServerToken } from '@brainana/core-server/main.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// An explicitly supplied token is used verbatim — scripts that pin a token keep working.
assert.equal(resolveServerToken({ tokenArg: 'explicit-token', envToken: 'env-token', noToken: false }), 'explicit-token')
ok('--token wins over the environment')

assert.equal(resolveServerToken({ tokenArg: null, envToken: 'env-token', noToken: false }), 'env-token')
ok('BRAINANA_TOKEN is used when no --token flag is given')

// The default: no flag, no env — a token is MINTED, not skipped.
const generated = resolveServerToken({ tokenArg: null, envToken: null, noToken: false })
assert.equal(typeof generated, 'string')
assert.equal(generated.length, 64, 'a freshly minted 32-byte hex token')
ok('with neither flag nor env, a session token is generated rather than disabled')

const second = resolveServerToken({ tokenArg: null, envToken: null, noToken: false })
assert.notEqual(generated, second, 'each launch mints its own token')
ok('generated tokens are per-launch, not a constant')

// Disabling the guard stays possible, but only as a deliberate, named choice.
assert.equal(resolveServerToken({ tokenArg: null, envToken: null, noToken: true }), null)
ok('--no-token explicitly disables the guard')

// An explicit opt-out beats a stale env var, so `--no-token` always means what it says.
assert.equal(resolveServerToken({ tokenArg: null, envToken: 'env-token', noToken: true }), null)
ok('--no-token overrides an inherited BRAINANA_TOKEN')

console.log(`\nserver_cli: ${passed} checks passed`)
