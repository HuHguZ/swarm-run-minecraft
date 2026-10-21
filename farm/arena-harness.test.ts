'use strict'
import { REPO_ROOT } from '../daemon/src/paths'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import * as os from 'node:os'
import path = require('node:path')
import { spawnSync } from 'node:child_process'

test('duel runs the slot snapshot harness with the requested arena and swaps both fighters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neurodown-arena-'))
  const slash = value => value.replaceAll('\\', '/')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const git = process.platform === 'win32' ? spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0] : null
  // git.exe бывает и в Git\cmd, и в Git\mingw64\bin (PATH из git bash) — sh.exe лежит в Git\bin.
  const shell = git ? ['../bin/sh.exe', '../../bin/sh.exe'].map(p => path.resolve(path.dirname(git), p)).find(p => fs.existsSync(p)) ?? 'sh' : 'sh'
  try {
    for (const child of ['bin', 'farm/crystal', '.daemon-fixed/arena', 'daemon/arena']) fs.mkdirSync(path.join(dir, child), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, 'farm/crystal/duel.sh'), path.join(dir, 'farm/crystal/duel.sh'))
    fs.writeFileSync(path.join(dir, 'farm/slots.json'), JSON.stringify({ slots: { 30: { code: 'fixed' } } }))
    for (const child of ['.daemon-fixed', 'daemon']) fs.writeFileSync(path.join(dir, child, 'arena', 'arena.js'), '// fixture; never executed\n')
    // Let the snapshot lookup use Node; intercept arena execution before it can open sockets.
    const wrapper = path.join(dir, 'bin/node')
    fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "-e" ]; then exec ${quote(slash(process.execPath))} "$@"; fi\nprintf '%s\\n' "$PWD" "$@" "$ARENA_A" "$ARENA_B" "$ARENA_NAME_A" "$ARENA_NAME_B" "$ARENA_POS"\n`)
    fs.chmodSync(wrapper, 0o755)
    for (const swap of ['', '1']) {
      const result = spawnSync(shell, ['farm/crystal/duel.sh', '30', '5', 'test'], { cwd: dir, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, SWAP: swap, PAIR: '',
          ARENA_POS: '600 120 600', OUT: '', KIT: 'булава против щита', EXTRA: '' } })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      const lines = fs.readFileSync(path.join(dir, 'farm/crystal/test.out'), 'utf8').trim().split(/\r?\n/)
      assert.ok(lines[0].endsWith('/.daemon-fixed'), `harness must match the slot code: ${lines[0]}`)
      assert.deepEqual(lines.slice(1), ['arena/arena.js', '5', 'булава против щита', `ws://127.0.0.1:${swap ? 8930 : 8830}`,
        `ws://127.0.0.1:${swap ? 8830 : 8930}`, swap ? 'NeuroFarm30b' : 'NeuroFarm30', swap ? 'NeuroFarm30' : 'NeuroFarm30b', '600 120 600'])
    }
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(), 'neurodown-arena-')))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
