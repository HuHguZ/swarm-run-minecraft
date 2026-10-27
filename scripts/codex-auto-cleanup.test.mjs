import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// Execute only the real cleanup function; node is a shell fake, never the farm CLI.
const source = readFileSync(new URL('../run/codex-auto.sh', import.meta.url), 'utf8')
const farmdown = source.match(/^farmdown \(\) \{\r?\n[\s\S]*?^\}/m)?.[0]
const slotInit = source.match(/\bSLOT=\$\{CODEX_SLOT:-\d+\}/)?.[0]
assert.ok(farmdown, 'farmdown function must be extractable without starting the autorunner')
assert.ok(slotInit, 'cleanup requires the caller slot initialization')

for (const configuredSlot of ['', '28']) for (const keep of ['', '30', '31', '28', '29 31 28 30', '131 310 128 280']) {
  const slot = configuredSlot || '31'
  const dir = mkdtempSync(join(tmpdir(), 'codex-cleanup-test-'))
  try {
    const result = spawnSync('sh', ['-c', `
set -eu
L=.
${slotInit}
node () {
  printf '%s\\n' "$*" >> calls.log
  # If the old implementation enumerates slots, model the two foreign stands too.
  case "$1" in -e) printf '%s\\n' '29 30 31' ;; esac
}
${farmdown}
farmdown
`], { cwd: dir, env: { ...process.env, CODEX_SLOT: configuredSlot, CODEX_KEEP_SLOTS: keep, BASH_ENV: '', ENV: '' }, encoding: 'utf8', windowsHide: true })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    let calls = []
    try { calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const expected = keep.split(' ').includes(slot) ? [] : [`dist/farm/farm.js down ${slot}`]
    assert.deepEqual(calls, expected, `SLOT=${slot} KEEP=${JSON.stringify(keep)}: no enumeration, foreign slot or bside cleanup`)
  } finally {
    // Verify mkdtemp's sole target before recursive deletion, never the repo/farm.
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    assert.ok(basename(dir).startsWith('codex-cleanup-test-'))
    rmSync(dir, { recursive: true, force: true })
  }
}
console.log('PASS: cleanup only the caller slot (default31 or ideas28); exact KEEP tokens; no enumeration or bside calls (12 cases)')
