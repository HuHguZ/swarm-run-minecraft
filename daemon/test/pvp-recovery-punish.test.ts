import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createRecovery } from '../src/pvp/recovery'
const Vec3 = require('vec3')
const clock = require('../src/game-clock')
const tempo = require('../src/tempo')
const ranged = require('../src/ranged')
const { transformSync } = require('esbuild')

function callerBlocks () {
  const source = readFileSync(resolve(__dirname, '../src/pvp.ts'), 'utf8')
  let medicalAt = source.indexOf("    if (safety.action === 'recover' && safeMedical")
  const flagAt = source.lastIndexOf('    let punishAfterRecovery = false', medicalAt)
  if (flagAt >= medicalAt - 80 && flagAt >= 0) medicalAt = flagAt
  const medicalEnd = source.indexOf('    const their = usingItem', medicalAt)
  const crystalAt = source.indexOf("    if (prof.player && blockName(bot, me.floored()) !== 'cobweb'")
  const crystalEnd = source.indexOf("    if (ready('dressMid')", crystalAt)
  const rebuffAt = source.lastIndexOf('\n', source.indexOf("ready('rebuff')", crystalEnd)) + 1
  const rebuffEnd = source.indexOf('    if (prof.player && duo.active())', rebuffAt)
  const healAt = source.lastIndexOf('\n', source.indexOf("&& ready('heal'))", rebuffEnd)) + 1
  const healEnd = source.indexOf('    const canHeal =', healAt)
  for (const [start, end] of [[medicalAt, medicalEnd], [crystalAt, crystalEnd], [rebuffAt, rebuffEnd], [healAt, healEnd]]) {
    assert.ok(start >= 0 && end > start, 'the actual ordered caller block is present')
  }
  return { medical: source.slice(medicalAt, medicalEnd), crystal: source.slice(crystalAt, crystalEnd),
    rebuff: source.slice(rebuffAt, rebuffEnd), heal: source.slice(healAt, healEnd) }
}

const turn = () => new Promise<void>(done => setImmediate(done))
function world () {
  const game = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const step = async (n = 1) => { for (let i = 0; i < n; i++) { game.advanceTicks(1); await turn() } }
  const finish = async <T>(pending: Promise<T>) => {
    let done = false; let result: T; let error
    pending.then(value => { done = true; result = value }, e => { done = true; error = e })
    await turn()
    for (let i = 0; !done && i < 160; i++) await step()
    assert.ok(done, 'actual recovery must return within the bounded poll')
    if (error) throw error
    return result!
  }
  return { game, step, finish, close: () => game.dispose() }
}

function fighter (game, { d = 22, dy = 5, loaded = false, arrows = false, bow = false, quickCharge = null, harm = false }: any = {}) {
  const potion = { name: 'potion', count: 3, slot: 9 }
  const sword = { name: 'diamond_sword', count: 1, slot: 36 }
  const shield = { name: 'shield', count: 1, slot: 45 }
  const items: any[] = [potion, sword, shield]
  const crossbow = { name: 'crossbow', count: 1, slot: 37 }
  if (loaded || quickCharge !== null) items.push(crossbow)
  if (arrows) items.push({ name: 'arrow', count: 12, slot: 38 })
  if (bow) items.push({ name: 'bow', count: 1, slot: 39 })
  if (harm) items.push({ name: 'splash_potion', count: 1, slot: 40 })
  const slots: any[] = []; for (const item of items) slots[item.slot] = item
  const entity: any = { id: 2, isValid: true, position: new Vec3(d, dy, 0), height: 1.8, width: .6 }
  Object.defineProperty(entity, 'health', { get () { throw new Error('exact enemy HP is telemetry only') } })
  let activeAt = Infinity; let consumeTimer; let starts = 0; let lowers = 0; let observed: any = () => null
  let visible = true; let ray = true; let approachable = true; let unsafe = false
  const messages: string[] = []; const effects = new Set<string>()
  const bot: any = { health: 15, food: 20, heldItem: sword, controlState: {},
    entity: { id: 1, position: new Vec3(0, 0, 0), onGround: true, height: 1.8 },
    inventory: { slots, items: () => items.filter(item => item.count > 0) },
    async equip (item, hand) { if (hand === 'off-hand') slots[45] = item; else this.heldItem = item },
    activateItem () { starts++; activeAt = game.now(); consumeTimer = game.setTimeout(() => {
      potion.count--; bot.health = Math.min(20, bot.health + 4); effects.add('strength'); activeAt = Infinity
    }, 1600) },
    deactivateItem () { lowers++; activeAt = Infinity; game.clearTimeout(consumeTimer) }
  }
  const ctx: any = {
    bot, entity, prof: { player: true }, ctl: { aborted: false }, session: {}, EYE: 1.62, HIT_REACH: 2.9, TICK_MS: 50,
    gameClock: game, tempo, st: { healed: [], eatPunish: { swaps: 0 } }, FIX: true, weapon: sword, nextReady: 0,
    tt: { state: () => ({ consuming: observed() }), reactMs: 150, safe: () => ({ ok: !unsafe }),
      guard: () => () => unsafe, noteConsume () {}, stats: { refused: 0, aborted: 0 } },
    countOf: (_bot, name) => items.reduce((n, item) => n + (item.name === name ? item.count : 0), 0),
    findItem: (_bot, pred) => items.find(item => item.count > 0 && pred(item)),
    edges: { falling: () => false }, fortSealed: () => false, maceNow: () => false,
    keyDir: (_bot, key) => key, stepSafe: () => approachable,
    set: (key, value) => { bot.controlState[key] = value }, used: what => messages.push(what),
    sleep: ms => game.sleep(ms), reachFrom: tempo.reachFrom, seesNow: () => visible, raySees: () => ray,
    rangedAllowed: () => true, ranged: { ...ranged, crossbows: () => items.includes(crossbow)
      ? [{ item: crossbow, info: { loaded, quickCharge: quickCharge || 0, ammo: loaded ? 'arrow' : null } }] : [] },
    potionOf: item => item.name === 'splash_potion' ? 'strong_harming' : 'strength', potionRole: () => 'buff', hasEffect: (_bot, name) => effects.has(name),
    throwMod: require('../src/throw'), pick: require('../src/pick'),
    cooldownMs: () => 625, ready: () => true, rest () {}, coverForDrink: async () => {},
    holdItem: async item => { bot.heldItem = item; return true }, holdWeapon: async () => { bot.heldItem = sword }
  }
  const recovery = createRecovery(ctx); Object.assign(ctx, recovery)
  return { ctx, bot, entity, potion, shield, recovery, messages, effects,
    activeAt: () => activeAt, starts: () => starts, lowers: () => lowers,
    observe: fn => { observed = fn }, visible: value => { visible = value }, ray: value => { ray = value },
    approach: value => { approachable = value }, unsafe: value => { unsafe = value },
    consume: (options = {}) => recovery.consumeItem(potion, null, options) }
}

test('both distant buff users complete their real consume polls when neither can punish', async () => {
  const w = world(); const a = fighter(w.game); const b = fighter(w.game)
  // Packet observation is delayed one tick. Both uses can begin before the other's metadata arrives.
  for (const [me, other] of [[a, b], [b, a]]) me.observe(() => w.game.now() - other.activeAt() >= 50
    ? { since: other.activeAt(), left: Math.max(0, 1600 - (w.game.now() - other.activeAt())) } : null)
  try {
    assert.deepEqual(await w.finish(Promise.all([a.consume({ buff: true }), b.consume({ buff: true })])), [true, true])
    for (const f of [a, b]) {
      assert.equal(f.potion.count, 2); assert.equal(f.ctx.st.eatPunish.swaps, 0)
      assert.equal(f.ctx.session.eating, false); assert.equal(f.bot.inventory.slots[45], f.shield)
      assert.equal(f.bot.controlState.back, false); assert.equal(f.lowers(), 1)
    }
  } finally { w.close() }
})

test('buffUp does not reject useful food just because the unreachable opponent is drinking', async () => {
  const w = world(); const f = fighter(w.game)
  f.observe(() => ({ since: w.game.now() - 150, left: 1200 }))
  try {
    assert.equal(f.recovery.punishable(), null)
    await w.finish(f.recovery.buffUp())
    assert.equal(f.potion.count, 2); assert.ok(f.effects.has('strength'))
    assert.equal(f.ctx.st.eatPunish.skips || 0, 0)
  } finally { w.close() }
})

test('finishing a nearly completed potion preserves both recovery and a real loaded-crossbow window', async () => {
  const w = world(); const f = fighter(w.game, { loaded: true, arrows: true })
  try {
    const pending = f.consume(); await turn(); await w.step(27)
    f.observe(() => ({ since: w.game.now() - 150, left: 1400 }))
    assert.equal(await w.finish(pending), true)
    assert.equal(f.potion.count, 2); assert.equal(f.ctx.st.eatPunish.swaps, 0)
  } finally { w.close() }
})

test('real early punish interruption cleans up before notification and the same duel can resume recovery', async () => {
  const w = world(); const f = fighter(w.game, { loaded: true, arrows: true }); let yields = 0
  try {
    const pending = f.consume({ onPunish: () => { assert.equal(f.ctx.session.eating, false); assert.equal(f.activeAt(), Infinity); yields++ } })
    await turn(); await w.step(6)
    const since = w.game.now() - 150
    f.observe(() => ({ since, left: Math.max(0, 1000 - (w.game.now() - since)) }))
    assert.equal(await w.finish(pending), false); assert.equal(yields, 1)
    assert.equal(f.potion.count, 3); assert.equal(f.ctx.st.eatPunish.swaps, 1)
    assert.equal(f.ctx.session.eating, false); assert.equal(f.bot.inventory.slots[45], f.shield)
    f.observe(() => null)
    assert.equal(await w.finish(f.consume()), true); assert.equal(f.potion.count, 2)
    assert.equal(f.ctx.ctl.aborted, false)
  } finally { w.close() }
})

test('a closed melee line and an expired bow draw are not executable punish windows', () => {
  const w = world()
  try {
    const hidden = fighter(w.game, { d: 4, dy: 0 })
    hidden.observe(() => ({ since: w.game.now() - 150, left: 1000 })); hidden.ray(false)
    assert.equal(hidden.recovery.punishable(), null)
    const lateBow = fighter(w.game, { bow: true, arrows: true })
    lateBow.observe(() => ({ since: w.game.now() - 150, left: 1000 }))
    assert.equal(lateBow.recovery.punishable(), null, 'draw plus flight cannot arrive before his consume ends')
    const loaded = fighter(w.game, { loaded: true })
    loaded.observe(() => ({ since: w.game.now() - 150, left: 1000 }))
    assert.equal(loaded.recovery.punishable()?.kind, 'crossbow', 'already loaded arrow does not need a spare stack')
  } finally { w.close() }
})

test('punish timing uses actual charge, movement, cooldown and throwable mechanics', () => {
  const w = world()
  try {
    const observe = (f, left = 1000) => f.observe(() => ({ since: w.game.now() - 150, left }))
    const slow = fighter(w.game, { arrows: true, quickCharge: 0 }); observe(slow)
    assert.equal(slow.recovery.punishable(), null, 'unenchanted charge cannot fit the remaining second')
    const fast = fighter(w.game, { arrows: true, quickCharge: 3 }); observe(fast)
    assert.equal(fast.recovery.punishable()?.kind, 'crossbow')
    const walk = fighter(w.game, { d: 8, dy: 0 }); observe(walk)
    assert.equal(walk.recovery.punishable()?.kind, 'rush')
    walk.bot.food = 6
    assert.equal(walk.recovery.punishable(), null, 'no sprint at this hunger, so the rush no longer fits')
    const cooldown = fighter(w.game, { d: 3, dy: 0 }); observe(cooldown)
    cooldown.ctx.nextReady = w.game.now() + 1100
    assert.equal(cooldown.recovery.punishable(), null)
    cooldown.ctx.nextReady = 0; observe(cooldown, 200)
    assert.equal(cooldown.recovery.punishable()?.kind, 'rush', 'a ready nearby hit still fits a short genuine window')
    const potion = fighter(w.game, { d: 5.5, dy: -1.5, harm: true }); observe(potion, 1600); potion.approach(false)
    assert.equal(potion.recovery.punishable()?.kind, 'harm', 'the known blocked step keeps the ranged splash alternative')
  } finally { w.close() }
})

test('actual medical caller reaches attack after a punish yield and respects abort or death during cleanup', async () => {
  const { medical } = callerBlocks()
  for (const outcome of ['attack', 'abort', 'death']) {
  const w = world(); const f = fighter(w.game, { loaded: true, arrows: true }); let attacks = 0
  const context: any = { safety: { action: 'recover' }, safeMedical: true, medical: f.potion,
    bot: f.bot, ctl: f.ctx.ctl, st: f.ctx.st, pathTo () {}, pathing: false, clear () {}, guard: null,
    holdItem: f.ctx.holdItem, useAt: async () => true, holdWeapon: async () => {
      await f.ctx.holdWeapon()
      if (outcome === 'abort') f.ctx.ctl.aborted = true
      if (outcome === 'death') f.bot.health = 0
    }, sleep: f.ctx.sleep,
    drink: f.recovery.drink, pvpSkills: f.recovery, punishable: f.recovery.punishable, TICK_MS: 50,
    attack () { assert.equal(f.activeAt(), Infinity); assert.equal(f.bot.inventory.slots[45], f.shield); attacks++ } }
  try {
    const pending = runInNewContext(`(async () => { for (let attempt = 0; attempt < 2 && !ctl.aborted && bot.health > 0; attempt++) { ${medical}; attack(); break } })()`, context)
    await turn(); await w.step(6)
    f.observe(() => ({ since: w.game.now() - 150, left: 850 }))
    await w.finish(pending)
    assert.equal(attacks, outcome === 'attack' ? 1 : 0, 'only a live, un-aborted caller may enter its attacking continuation')
    assert.equal(f.starts(), 1); assert.equal(f.potion.count, 3)
  } finally { w.close() }
  }
})

test('actual ordered medical, crystal, rebuff and heal callers reserve one attack pass without suppressing defense', async () => {
  const blocks = callerBlocks()
  const script = transformSync(`(async () => { for (let pass = 0; pass < 1 && !ctl.aborted && bot.health > 0; pass++) {
    ${blocks.medical}\n${blocks.crystal}\n${blocks.rebuff}\n${blocks.heal}
    attack()
  } })()`, { loader: 'ts', target: 'node22' }).code
  for (const alternative of ['crystal-eat', 'rebuff', 'heal', 'defense']) {
    const w = world(); const f = fighter(w.game, { loaded: true, arrows: true })
    const seen = { attacks: 0, crystalEat: 0, buffs: 0, heals: 0, defenses: 0 }
    const context: any = {
      bot: f.bot, ctl: f.ctx.ctl, st: f.ctx.st, prof: { player: true }, me: f.bot.entity.position,
      entity: f.entity, safety: { action: 'recover' }, safeMedical: true, medical: f.potion,
      pathTo () {}, pathing: false, clear () {}, guard: null, aim: 'target', perch: null, fort: null,
      holdItem: f.ctx.holdItem, holdWeapon: f.ctx.holdWeapon, sleep: f.ctx.sleep, TICK_MS: 50,
      drink: async (item, what, abortIf, options) => { const value = await f.recovery.drink(item, what, abortIf, options); f.observe(() => null); return value },
      pvpSkills: f.recovery, punishable: f.recovery.punishable, tempo, tt: f.ctx.tt, FIX: true,
      ready: key => key === 'crystal' || (alternative === 'rebuff' && key === 'rebuff') || (alternative === 'heal' && key === 'heal'),
      rest () {}, blockName: () => 'air', track: { vel: () => ({ x: 0, y: 0, z: 0 }) }, pressing: false,
      GRAPH: false, gp: null, after: () => true, style: { reactMs: 150 }, noticed: {},
      heldName: () => f.bot.heldItem.name, switched () {}, stepSafe: () => true, maceNow: () => false,
      gameClock: { wall: { now: () => w.game.now() } }, used () {}, noteExchange () {},
      cx: { engaged: () => alternative === 'crystal-eat' || alternative === 'defense',
        plan: () => ({ kind: alternative === 'defense' ? 'dodge' : 'eat' }),
        run: async (_ctl, action) => { assert.equal(f.activeAt(), Infinity); if (action.kind === 'eat') seen.crystalEat++; else seen.defenses++; return { ok: true } } },
      hasEffect: () => false, findItem: f.ctx.findItem, potionOf: f.ctx.potionOf, fortSealed: () => false,
      buffUp: async () => { seen.buffs++; await f.recovery.buffUp() },
      hp: 15, healAt: 16, archer: false, calmHeal: true, theirR: 22, busyFoe: false,
      findPotion: () => ({ name: 'splash_potion', count: 1 }),
      useAt: async () => { seen.heals++; return true },
      attack: () => { assert.equal(f.activeAt(), Infinity); assert.equal(f.bot.inventory.slots[45], f.shield); seen.attacks++ }
    }
    try {
      const pending = runInNewContext(script, context)
      await turn(); await w.step(6)
      f.observe(() => ({ since: w.game.now() - 150, left: 850 }))
      await w.finish(pending)
      assert.deepEqual(seen, { attacks: alternative === 'defense' ? 0 : 1, crystalEat: 0, buffs: 0, heals: 0, defenses: alternative === 'defense' ? 1 : 0 }, alternative)
      assert.equal(f.starts(), 1); assert.equal(f.potion.count, 3)
      if (alternative !== 'defense') {
        context.safeMedical = false
        await w.finish(runInNewContext(script, context))
        assert.equal(seen.crystalEat + seen.buffs + seen.heals, 1, 'the next pass can recover again without a cooldown')
      }
    } finally { w.close() }
  }
})
