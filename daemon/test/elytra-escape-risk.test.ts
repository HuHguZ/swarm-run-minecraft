import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { transpiledSource } from './source-fixture'
import { stubRequire } from './stub-require'

test('уход на элитрах выбирается по цене размена даже без лечения', () => {
  const file = resolve(__dirname, '../src/elytra.js')
  const variants = [
    { hp: 1.2, threshold: 15, rockets: 47, room: 8, escape: true },
    { hp: 1.2, threshold: 15, rockets: 47, room: 8, flying: true, escape: true },
    { hp: 10, threshold: 18, rockets: 47, room: 8, escape: true },
    { hp: 10, threshold: 8, rockets: 47, room: 8, escape: false },
    { hp: 10, threshold: 18, rockets: 47, room: 8, safe: true, escape: false },
    { hp: 1.2, threshold: 15, rockets: 47, room: 3, escape: false },
    { hp: 1.2, threshold: 15, rockets: 0, room: 8, escape: false }
  ]
  for (const v of variants) {
    const bot = { entity: { position: {}, onGround: !v.flying, elytraFlying: !!v.flying } }
    const foe = { position: {} }
    Object.defineProperty(foe, 'health', { get () { throw Error('точное хп человека недоступно') } })
    const req = stubRequire(file, {
      './game-clock': { now: () => 1000 }, './elytra/consts': { ON: true },
      './elytra/physics': { worldOf: () => ({}), headroom: () => v.room },
      './elytra/kit': { hasElytra: () => true, kit: () => ({ elytra: true, rockets: v.rockets }) },
      './elytra/install': { install: () => {} },
      './elytra/track': { track: () => ({}), gliding: e => !!e.elytraFlying },
      './combat/aerial-executor': { createAerialCombat: () => ({ decide: () => ({ selected: null }) }) },
      './combat/aerial-lance': { lancePlan: () => false }, './elytra/dive': { divePlan: () => false }
    }, {}, { fallback: () => ({}) })
    const mod = { exports: {} as any }
    runInThisContext(`(function(require,module,exports,__filename,__dirname){${transpiledSource(file)}\n})`, { filename: file })
      (req, mod, mod.exports, file, dirname(file))
    const sky = mod.exports.create(bot, { enemy: () => foe })
    const plan = sky.decide({ hp: v.hp, healAt: 8, heal: !!v.safe, eatSafe: true,
      safety: { threshold: v.threshold }, safeMedical: !!v.safe })
    assert.equal(plan?.kind === 'escape', v.escape, JSON.stringify(v))
  }
})
