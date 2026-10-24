import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'

test('из проигрышной общей ямы выбираемся; успешным считается подтверждённый выход', async () => {
  const file = resolve(__dirname, '../src/pvp/turn-hazards.js'), mod = { exports: {} as any }
  const req = stubRequire(file, {
    './rules': { HIT_REACH: 3.2 }, './turn': { NEXT: 'next' }, './potions': { findItem: () => null }
  }, {}, { fallback: () => ({}) })
  runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })
    (req, mod, mod.exports, file, dirname(file))
  for (const v of [
    { own: true, both: true, hp: 1.2, r: 2, ok: true, climb: true },
    { own: true, both: true, hp: 20, r: 2, ok: true, climb: false },
    { own: true, both: false, hp: 1.2, r: 2, ok: true, climb: true },
    { own: true, both: false, hp: 20, r: 2, ok: true, climb: false },
    { own: true, both: false, hp: 20, r: 5, ok: true, climb: true },
    { own: true, both: true, hp: 1.2, r: 2, ok: false, climb: true },
    { own: true, both: true, hp: 10, r: 2, safe: true, ok: true, climb: false },
    { own: false, both: true, hp: 1.2, r: 2, ok: true, climb: false }
  ]) {
    const pit = { depth: 3, rimY: 139 }; let calls = 0
    const ctx = { myPit: v.own ? pit : null, theirPit: v.both ? pit : null, prof: { player: true },
      ready: () => false, climbOut: async p => { calls++; assert.equal(p, pit); return v.ok } }
    const result = await mod.exports.pitTurn(ctx, { hp: v.hp, r: v.r, safety: { threshold: 15 }, safeMedical: !!v.safe })
    assert.equal(calls, +v.climb, JSON.stringify(v))
    assert.equal(result, v.climb && v.ok ? 'next' : undefined, JSON.stringify(v))
  }
})
