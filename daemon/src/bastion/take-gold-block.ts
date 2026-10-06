
const gameClock = require('.././game-clock')

const { goals } = require('mineflayer-pathfinder')

const { Vec3 } = require('vec3')

const { sleep, xyz } = require('.././movement')

const { visibleOf, seesBlock } = require('.././sight')

const { raySees, eyePos } = require('.././perception')

const worlds = require('.././worlds')

const BF = require('.././barter-flow')

const PLACE = 'бастион (ад)'

const ADMIRE_MS = 119 * 50

const LOVED = /^(gold_ingot|gold_block|gilded_blackstone|golden_[a-z_]+|gold_ore|deepslate_gold_ore|nether_gold_ore|raw_gold|raw_gold_block|light_weighted_pressure_plate|bell|clock|glistering_melon_slice|enchanted_golden_apple)$/

const GOLD_ARMOR = ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots']

const ARMOR_DEST = { golden_helmet: 'head', golden_chestplate: 'torso', golden_leggings: 'legs', golden_boots: 'feet' }

const GOLD_PICK = /^(iron|diamond|netherite)_pickaxe$/

const JUNK_KEEP = { gravel: 8, soul_sand: 0, nether_brick: 0, quartz: 0, blackstone: 64, crying_obsidian: 8, dried_ghast: 0, netherrack: 64, basalt: 0, polished_blackstone_bricks: 0 }

const log = (what, o) => console.log('[bastion]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

const keyOf = p => `${p.x},${p.y},${p.z}`

const countOf = (bot, name) => bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)

const itemNamed = (bot, name) => bot.inventory.items().find(i => i.name === name) || null

function metaOf (bot, e, key) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys.indexOf(key)
    return i >= 0 ? e.metadata[i] : undefined
  } catch { return undefined }
}

const isBaby = (bot, e) => !!metaOf(bot, e, 'baby')

const aggressive = (bot, e) => ((Number(metaOf(bot, e, 'mob_flags')) || 0) & 4) !== 0

const offhand = e => { const it = e && e.equipment && e.equipment[1]; return it ? it.name : null }

const admiring = e => LOVED.test(offhand(e) || '')

function mobs (bot, name, r, from = null) {
  const me = from || bot.entity.position
  return (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === name && e.position && e.isValid !== false && e.position.distanceTo(me) <= r)
}

const seesMob = (bot, e) => raySees(bot, eyePos(bot), e.position.offset(0, (e.height || 1.9) * 0.6, 0))

function angerSet (bot, feet = null, sneak = true) {
  const at = feet || bot.entity.position
  const R = (sneak ? 12.8 : 16) + 0.6
  return mobs(bot, 'piglin', 24, at).filter((e : any) =>
    !isBaby(bot, e) && !admiring(e) && e.position.distanceTo(at) <= R &&
    Math.abs(e.position.x - at.x) <= 16.6 && Math.abs(e.position.z - at.z) <= 16.6 &&
    e.position.y + 1.95 >= at.y - 16 && e.position.y <= at.y + 17.8)
}

function nearestTrader (bot, r = 48) {
  const { walkable } = require('.././walkable')
  const me = bot.entity.position
  const list = mobs(bot, 'piglin', r).filter(e => !isBaby(bot, e) && !aggressive(bot, e)).sort((a: any, c: any) => a.position.distanceTo(me) - c.position.distanceTo(me))
  if (!list.length) return null
  const set = new Set()
  try { for (const n of walkable(bot, me, { radius: 20, maxNodes: 3000 })) set.add(`${n.pos.x},${n.pos.y},${n.pos.z}`) } catch {}
  const ok = e => { const f = e.position.floored(); for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) if (set.has(`${f.x + dx},${f.y + dy},${f.z + dz}`)) return true; return false }
  const w = list.find(ok)
  return w ? { e: w, walk: true } : { e: list[0], walk: false }
}

function goldWorn (bot) {
  return [5, 6, 7, 8].some(s => bot.inventory.slots[s] && /^golden_(helmet|chestplate|leggings|boots)$/.test(bot.inventory.slots[s].name))
}

async function wearGold (bot) {
  if (goldWorn(bot)) return true
  const spare = GOLD_ARMOR.map(n => itemNamed(bot, n)).find(Boolean)
  if (!spare) return false
  try { await bot.equip(spare, ARMOR_DEST[spare.name]) } catch { return false }
  return goldWorn(bot)
}

function canReach (bot, pos, reach = 4.4) {
  const eye = bot.entity.position.offset(0, bot.getControlState && bot.getControlState('sneak') ? 1.27 : 1.62, 0)
  return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5).distanceTo(eye) <= reach
}

async function walkGoal (session, ctl, goal, ms, { dig = true }: any = {}) {
  if (ctl.waitReflex) await ctl.waitReflex()
  const bot = session.bot
  const { guarded } = require('.././nether')
  const mv = bot.pathfinder && bot.pathfinder.movements
  const was = mv ? { canDig: mv.canDig, scaf: mv.scafoldingBlocks } : null
  if (mv && !dig) { mv.canDig = false; mv.scafoldingBlocks = [] }
  // ND_GUARD=1: идёт ответ стража (столб/коробка) — сперва дождаться его, и ходьбу оборвать, если он начнётся.
  if (process.env.ND_GUARD !== '0') await require('.././ne-guard').waitIdle(bot)
  return guarded(session, ctl, async sub => {
    const clock = () => require('.././reflex-lock').clock(session)
    const until = clock() + ms
    let timer = null
    const stop = () => { try { bot.pathfinder.setGoal(null) } catch {} }
    sub.onAbort.push(stop)
    let watch = null
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        // Лава под шагом — сразу стоп и прыжок к полу (в Аду ведро не работает).
        new Promise<any>((_resolve, reject) => { watch = gameClock.setInterval(() => { if (session.reflex) return; if (clock() >= until) reject(new Error('время вышло')); else if (inLava(bot)) reject(new Error('лава')); else if (process.env.ND_GUARD !== '0' && process.env.ND_GUARD_REFLEX === '0' && require('.././ne-guard').busy(bot)) reject(new Error('ответ стража')) }, 100) })
      ])
      // goto (mineflayer-pathfinder 2.4.5, lib/goto.js) «успешно» кончается и
      const f = bot.entity.position.floored()
      const reached = typeof goal.isEnd === 'function' ? goal.isEnd(f) : true
      return reached ? { ok: true } : { ok: false, error: 'пути нет (pathfinder: пустой путь)' }
    } catch (e) {
      if (e.message === 'лава') { stop(); await lavaEscape(bot) }
      return { ok: false, error: e.message }
    } finally {
      if (timer) gameClock.clearTimeout(timer)
      if (watch) gameClock.clearInterval(watch)
      stop()
      if (mv && !dig && was) { mv.canDig = was.canDig; mv.scafoldingBlocks = was.scaf }
    }
  })
}

function inLava (bot) {
  if (bot.entity && bot.entity.isInLava) return true
  // Рамка тела (±0.3), а не клетка ног: D6-32 03.10 — тело в клетке портала на x −3.16, рамка в лаве на x −3, «выбрался»,
  // а горело 4 с до переноса назад и смерти.
  const p = bot.entity.position
  for (const x of new Set([Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)])) {
    for (const z of new Set([Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)])) {
      for (const y of new Set([Math.floor(p.y), Math.floor(p.y + 1)])) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.name === 'lava') return true }
    }
  }
  return false
}

function lavaFreeCell (bot, c) {
  for (const dy of [0, 1]) {
    const b = bot.blockAt(c.offset(0, dy, 0))
    if (b && /nether_portal/.test(b.name)) return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = bot.blockAt(c.offset(dx, dy, dz)); if (q && q.name === 'lava') return false }
  }
  return true
}

function effectOn (bot, name) {
  try {
    const pascal = String(name).split('_').map(q => q.charAt(0).toUpperCase() + q.slice(1)).join('')
    const eff = bot.registry.effectsByName[name] || bot.registry.effectsByName[pascal]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}

async function drinkFireRes (bot) {
  if (effectOn(bot, 'fire_resistance')) return 'уже'
  const { potionOf } = require('.././pvp')
  const pot = bot.inventory.items().find(i => i.name === 'potion' && /fire_resistance$/.test(potionOf(i) || ''))
  const splash = pot ? null : bot.inventory.items().find(i => i.name === 'splash_potion' && /fire_resistance$/.test(potionOf(i) || ''))
  if (!pot && !splash) return null
  try {
    await bot.equip(pot || splash, 'hand')
    if (pot) await bot.consume()
    else { await bot.look(bot.entity.yaw, -Math.PI / 2, true); bot.activateItem(); await sleep(250); bot.deactivateItem() }
    return 'выпил'
  } catch (e) { return 'не вышло: ' + e.message }
}

async function lavaEscapeDeep (bot) {
  const fr = await drinkFireRes(bot).catch(() => null)
  const t0 = gameClock.now()
  try {
    while (inLava(bot) && gameClock.now() - t0 < (fr === 'выпил' || fr === 'уже' ? 20000 : 5000)) {
      const me = bot.entity.position.floored()
      let best = null
      for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
          for (let dy = -1; dy <= 4; dy++) {
            const c = me.offset(dx, dy, dz)
            const b = bot.blockAt(c); const fl = bot.blockAt(c.offset(0, -1, 0)); const h = bot.blockAt(c.offset(0, 1, 0))
            if (!b || !fl || !h || b.name === 'lava' || b.boundingBox !== 'empty' || fl.boundingBox !== 'block' || h.name === 'lava' || h.boundingBox !== 'empty') continue
            if (!lavaFreeCell(bot, c)) continue
            const dd = Math.hypot(dx, dz) + Math.max(0, dy) * 0.5
            if (!best || dd < best.dd) best = { c, dd }
          }
        }
      }
      if (best) await bot.lookAt(best.c.offset(0.5, 1, 0.5), true).catch(() => {})
      bot.setControlState('jump', true)
      bot.setControlState('forward', !!best)
      await sleep(150)
    }
  } finally { bot.clearControlStates() }
  log('из лавы вплавь', { ok: !inLava(bot), fireRes: fr, hp: Math.round(bot.health ?? 0), ms: gameClock.now() - t0 })
  return !inLava(bot)
}

async function makeIronPick (session, ctl) {
  const bot = session.bot
  const A = require('.././actions')
  const C = require('.././containers')
  const has = n => countOf(bot, n)
  const pick = () => bot.inventory.items().some(i => GOLD_PICK.test(i.name))
  if (pick()) return true
  const total = () => has('iron_ingot') + has('raw_iron') + 9 * has('iron_block') + Math.floor(has('iron_nugget') / 9)
  if (total() < 3) return false
  try {
    if (has('iron_ingot') + 9 * has('iron_block') + Math.floor(has('iron_nugget') / 9) < 3 && has('raw_iron')) {
      const fuel = bot.inventory.items().find(i => /_planks$/.test(i.name)) ? bot.inventory.items().find(i => /_planks$/.test(i.name)).name : null
      await C.smelt(session, ctl, { item: 'raw_iron', count: has('raw_iron'), ...(fuel ? { fuel } : {}), timeoutSeconds: 90 })
    }
    if (has('iron_ingot') < 3 && has('iron_block')) await A.craft(session, ctl, { item: 'iron_ingot', count: 9 })
    if (has('iron_ingot') < 3 && has('iron_nugget') >= 9) await A.craft(session, ctl, { item: 'iron_ingot', count: Math.floor(has('iron_nugget') / 9) })
    if (has('stick') < 2 && bot.inventory.items().some(i => /_planks$/.test(i.name))) await A.craft(session, ctl, { item: 'stick', count: 4 })
    if (has('iron_ingot') >= 3 && has('stick') >= 2) await A.craft(session, ctl, { item: 'iron_pickaxe', count: 1 })
  } catch (e) { log('железная кирка: не вышло', { error: e.message }) }
  return pick()
}

async function waitWatched (session, ctl, ms) {
  const bot = session.bot
  const t0 = gameClock.now()
  let hp0 = bot.health ?? 20
  while (gameClock.now() - t0 < ms && !ctl.aborted) {
    const f = bot.blockAt(bot.entity.position.floored())
    if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); return 'лава' }
    if (f && /fire/.test(f.name)) { await fireStep(bot); return 'огонь' }
    const hp = bot.health ?? 20
    if (hp < hp0 - 1.5) return 'урон'
    hp0 = Math.max(hp0, hp)
    await sleep(250)
  }
  return null
}

async function fireStep (bot) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1, -1]) {
    if (!dx && !dz) continue
    const c = me.offset(dx, dy, dz)
    const b = bot.blockAt(c); const h = bot.blockAt(c.offset(0, 1, 0)); const fl = bot.blockAt(c.offset(0, -1, 0))
    if (!b || !h || !fl || b.boundingBox !== 'empty' || h.boundingBox !== 'empty' || fl.boundingBox !== 'block' || /fire|lava|portal/.test(b.name + h.name) || /magma/.test(fl.name)) continue
    if (!lavaFreeCell(bot, c)) continue
    const d = Math.hypot(dx, dz) + Math.abs(dy)
    if (!best || d < best.d) best = { c, d }
  }
  if (!best) return false
  try { await bot.lookAt(best.c.offset(0.5, 1, 0.5), true) } catch {}
  bot.setControlState('forward', true)
  if (best.c.y > me.y) bot.setControlState('jump', true)
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1500) {
    const p = bot.entity.position
    if (Math.hypot(p.x - best.c.x - 0.5, p.z - best.c.z - 0.5) < 0.35) break
    await sleep(60)
  }
  bot.clearControlStates()
  log('из огня', { to: xyz(best.c), hp: Math.round(bot.health ?? 0) })
  return true
}

async function lavaEscape (bot) {
  const me = bot.entity.position.floored()
  let best = null
  let near = null
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (const dy of [0, 1, -1]) {
        const c = me.offset(dx, dy, dz)
        const b = bot.blockAt(c)
        const f = bot.blockAt(c.offset(0, -1, 0))
        const h = bot.blockAt(c.offset(0, 1, 0))
        if (!b || !f || b.name === 'lava' || b.boundingBox !== 'empty' || f.boundingBox !== 'block' || (h && h.name === 'lava') || /nether_portal/.test(b.name + (h ? h.name : ''))) continue
        const dd = Math.hypot(dx, dz)
        if (!near || dd < near.dd) near = { c, dd }
        if (!lavaFreeCell(bot, c)) continue
        if (!best || dd < best.dd) best = { c, dd }
      }
    }
  }
  best = best || near
  if (!best) { await sleep(100); return false }
  try { await bot.lookAt(best.c.offset(0.5, 1, 0.5), true) } catch {}
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)
  // До центра клетки: рамка целиком вне лавы (раньше 0.9 с — и стоп, рамка могла остаться в лаве).
  const t0 = gameClock.now()
  await sleep(500)
  while (gameClock.now() - t0 < 2500) {
    const p = bot.entity.position
    if (!inLava(bot) && bot.entity.onGround && Math.hypot(p.x - best.c.x - 0.5, p.z - best.c.z - 0.5) < 0.3) break
    try { await bot.lookAt(best.c.offset(0.5, 1, 0.5), true) } catch {}
    await sleep(80)
  }
  bot.clearControlStates()
  log('из лавы', { to: xyz(best.c), hp: Math.round(bot.health ?? 0), ok: !inLava(bot) })
  return !inLava(bot)
}

async function pickUp (bot, ctl, radius = 6, ms = 5000) {
  try { return await require('.././actions').collectNearbyDrops(bot, ctl, { radius, timeoutMs: ms }) } catch { return 0 }
}

async function handIngot (session, ctl, pg, walkMs = 5000) {
  const bot = session.bot
  const pick = require('.././pick')
  if (!pg || !bot.entities[pg.id] || admiring(pg)) return false
  if (pg.position.distanceTo(bot.entity.position) > 2.6) {
    await walkGoal(session, ctl, new goals.GoalNear(pg.position.x, pg.position.y, pg.position.z, 1.5), walkMs)
  }
  if (ctl.aborted || !bot.entities[pg.id]) return false
  const a = pick.aim(bot, pg)
  if (!a || !a.point) return false
  const ingot = itemNamed(bot, 'gold_ingot')
  if (!ingot) return false
  const had = countOf(bot, 'gold_ingot')
  try {
    await bot.equip(ingot, 'hand')
    await bot.lookAt(a.point, true)
    await bot.activateEntity(pg)
  } catch { return false }
  for (let i = 0; i < 8 && countOf(bot, 'gold_ingot') >= had; i++) await sleep(60)
  return countOf(bot, 'gold_ingot') < had
}

async function takeGoldBlock (session, ctl, pos, st) {
  const bot = session.bot
  const key = keyOf(pos)
  if (!canReach(bot, pos)) {
    await walkGoal(session, ctl, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), 20000)
    if (!canReach(bot, pos)) await walkGoal(session, ctl, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 15000)
  }
  if (ctl.aborted) return 'aborted'
  let b = bot.blockAt(pos)
  if (!b || b.name !== 'gold_block') { st.gold.delete(key); return 'gone' }
  if (!canReach(bot, pos)) { st.skip.set(key, gameClock.now() + 90000); return 'unreachable' }
  // Вплотную (общая грань с клеткой ног или головы — её мы сами открыли
  const adjacentFace = () => {
    const f = bot.entity.position.floored()
    for (const c of [f, f.offset(0, 1, 0)]) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (c.offset(dx, dy, dz).equals(pos)) return true
    return false
  }
  if (!seesBlock(bot, b) && !adjacentFace()) { st.skip.set(key, gameClock.now() + 60000); return 'hidden' }
  const brute = mobs(bot, 'piglin_brute', 12).find(e => seesMob(bot, e))
  if (brute) { st.skip.set(key, gameClock.now() + 30000); return 'brute' }
  // Кого разозлит: вручить им слитки (не больше 4 на блок; каждый — бартер).
  // Кто до нас не дойдёт и не видит (мы в стене, в своей камере) — не в счёт.
  const reach0 = reachSet(bot)
  const dangerous = () => angerSet(bot).filter(e => threatens(bot, e, reach0))
  let angry = dangerous()
  let bribes = 0
  while (angry.length && !ctl.aborted && bribes < 4) {
    if (!countOf(bot, 'gold_ingot')) break
    if (angry.length > 3) break
    const pg: any = angry.sort((a: any, c: any) => a.position.distanceTo(bot.entity.position) - c.position.distanceTo(bot.entity.position))[0]
    if (pg.position.distanceTo(bot.entity.position) > 7 || !seesMob(bot, pg)) break
    const ok = await handIngot(session, ctl, pg, 4000)
    bribes++
    if (ok) { st.bribed++; st.traded++ }
    if (!canReach(bot, pos)) await walkGoal(session, ctl, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), 5000)
    angry = dangerous()
  }
  if (angry.length) {
    st.skip.set(key, gameClock.now() + 20000)
    st.lastBlocked = { at: key, piglins: angry.length, nearest: Math.round(Math.min(...angry.map((e : any) => e.position.distanceTo(bot.entity.position)))) }
    return 'piglins'
  }
  // Кирка — железная и лучше (золотой блок — needs_iron_tool).
  const pickItem = bot.inventory.items().filter(i => GOLD_PICK.test(i.name)).sort((a, c) => (c.name.startsWith('netherite') ? 3 : c.name.startsWith('diamond') ? 2 : 1) - (a.name.startsWith('netherite') ? 3 : a.name.startsWith('diamond') ? 2 : 1))[0]
  if (!pickItem) return 'nopick'
  b = bot.blockAt(pos)
  if (!b || b.name !== 'gold_block') { st.gold.delete(key); return 'gone' }
  bot.setControlState('sneak', true)
  let dug = false
  try {
    await bot.equip(pickItem, 'hand')
    // Последняя проверка — прямо перед ударом: пока шли, мог подойти другой.
    if (dangerous().length) return 'piglins'
    await Promise.race([bot.dig(b, true), sleep(6000).then(() => { throw new Error('копал слишком долго') })])
    const now = bot.blockAt(pos)
    dug = !now || now.name !== 'gold_block'
  } catch (e) {
    log('копка', { at: key, error: e.message })
  } finally {
    bot.setControlState('sneak', false)
  }
  if (!dug) { st.skip.set(key, gameClock.now() + 30000); return 'failed' }
  st.gold.delete(key)
  st.pred.delete(key)
  st.blocks++
  st.lastBreak = gameClock.now()
  // Блок — любимое пиглинов: подобрать раньше них.
  await pickUp(bot, ctl, 5, 3500)
  return 'dug'
}

async function lootChest (session, ctl, pos, st) {
  const bot = session.bot
  const S = require('.././structures')
  const key = keyOf(pos)
  if (!canReach(bot, pos, 4.2)) {
    await walkGoal(session, ctl, new goals.GoalLookAtBlock(pos, bot.world, { reach: 3.8 }), 20000)
  }
  if (ctl.aborted) return 'aborted'
  if (!canReach(bot, pos, 4.4)) { st.skip.set(key, gameClock.now() + 90000); return 'unreachable' }
  const eyes = S.piglinsWatching(bot).filter(e => e.name === 'piglin' && !isBaby(bot, e) && !admiring(e))
  if (eyes.length) {
    // Разглядывающих не злит: вручить слитки смотрящим, если их двое-трое рядом.
    let bribes = 0
    for (const pg of eyes.slice(0, 3)) {
      if (!countOf(bot, 'gold_ingot') || pg.position.distanceTo(bot.entity.position) > 7) break
      if (await handIngot(session, ctl, pg, 4000)) { bribes++; st.traded++ }
    }
    const still = S.piglinsWatching(bot).filter(e => e.name === 'piglin' && !isBaby(bot, e) && !admiring(e))
    if (still.length) { st.skip.set(key, gameClock.now() + 25000); return 'watched' }
  }
  try {
    const r = await S.takeWorth(session, ctl, pos, { kind: 'bastion' })
    st.chests.push({ at: key, took: r.took || {}, stopped: r.stopped })
    if (r.stopped && /видят/.test(r.stopped)) { st.skip.set(key, gameClock.now() + 25000); return 'watched' }
    if (require('./mining-cycle').confirmedChestLoot(r, pos, ctl.aborted)) {
      st.looted.add(key)
      return 'looted'
    }
    st.skip.set(key, gameClock.now() + 60000)
    return ctl.aborted ? 'aborted' : 'partial'
  } catch (e) {
    st.skip.set(key, gameClock.now() + 60000)
    st.chests.push({ at: key, error: e.message })
    return 'failed'
  }
}

async function unpackGold (session, ctl, want) {
  const bot = session.bot
  const blocks = countOf(bot, 'gold_block')
  const have = countOf(bot, 'gold_ingot')
  if (!blocks || have >= want) return 0
  const n = Math.min(blocks, Math.ceil((want - have) / 9))
  try {
    await require('.././actions').craft(session, ctl, { item: 'gold_ingot', count: n * 9 })
  } catch (e) { log('слитки', { error: e.message }) }
  return countOf(bot, 'gold_ingot') - have
}

function fireRes (bot) {
  let n = 0
  try {
    const { potionsOf } = require('.././fightkit')
    const p = potionsOf(bot)
    n = (p.fire_resistance || 0) + (p.long_fire_resistance || 0) + (p.splash_fire_resistance || 0) + (p.splash_long_fire_resistance || 0)
  } catch {}
  return n
}

function reserveKeeper (bot) {
  const pack = require('.././pack')
  const left = pack.reserveLeft(bot)
  return (name, count) => {
    const kind = pack.reserveKind(bot, name)
    if (!kind) return true
    if (left[kind] - count < pack.RESERVE[kind]) return false
    left[kind] -= count
    return true
  }
}

async function dropJunk (bot) {
  const tossed = []
  const spare = reserveKeeper(bot)
  for (const [name, keep] of (Object.entries(JUNK_KEEP) as [string, any][])) {
    let have = countOf(bot, name)
    if (have <= keep) continue
    for (const it of bot.inventory.items().filter(i => i.name === name).sort((a, c) => a.count - c.count)) {
      if (have - it.count < keep) break
      if (!spare(name, it.count)) break
      try { await bot.tossStack(it); have -= it.count; tossed.push(`${name}×${it.count}`) } catch {}
    }
  }
  return tossed
}

function vantagePoints (center, box = null) {
  const out = []
  const top = box ? box.maxY : center.y + 8
  const bottom = box ? box.minY + 3 : center.y - 12
  const levels = []
  for (let y = top; y >= bottom; y -= 10) levels.push(y)
  if (!levels.length || levels[levels.length - 1] > bottom + 4) levels.push(bottom)
  for (const y of levels) {
    for (const r of [8, 18]) {
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2 + (r === 18 ? Math.PI / 4 : 0) + (y % 2 ? Math.PI / 8 : 0)
        out.push({ x: Math.round(center.x + r * Math.cos(a)), y, z: Math.round(center.z + r * Math.sin(a)) })
      }
    }
  }
  return out
}

function centerGuess (bot, fallback) {
  const R = bot.registry.blocksByName
  const ids = ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'gilded_blackstone', 'gold_block', 'chiseled_polished_blackstone']
    .map(n => R[n]).filter(Boolean).map(b => b.id)
  const seen = visibleOf(bot, ids, 48, { max: 120, rays: 1600 })
  if (seen.length < 12) return { ...fallback, box: null }
  const c = seen.reduce((a, b) => ({ x: a.x + b.position.x, y: a.y + b.position.y, z: a.z + b.position.z }), { x: 0, y: 0, z: 0 })
  const ys = seen.map(b => b.position.y)
  return { x: Math.round(c.x / seen.length), y: Math.round(c.y / seen.length), z: Math.round(c.z / seen.length), box: { minY: Math.min(...ys), maxY: Math.max(...ys) } }
}

function survey (bot, st, goldR = 30) {
  const R = bot.registry.blocksByName
  const now = gameClock.now()
  for (const b of visibleOf(bot, [R.gold_block.id], goldR, { max: 40, rays: 2500 })) {
    const k = keyOf(b.position)
    if (!st.gold.has(k)) st.gold.set(k, { pos: b.position.clone(), seen: now })
  }
  // Видимые блоки самого бастиона — карта для обхода (куда ещё не ходил).
  const bids = ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'gilded_blackstone', 'chiseled_polished_blackstone', 'polished_blackstone']
    .map(n => R[n]).filter(Boolean).map(b => b.id)
  for (const b of visibleOf(bot, bids, 40, { max: 160, rays: 1600 })) {
    const k = keyOf(b.position)
    if (!st.bricks.has(k)) st.bricks.set(k, b.position.clone())
  }
  const cids = [R.chest && R.chest.id, R.barrel && R.barrel.id, R.trapped_chest && R.trapped_chest.id].filter(Boolean)
  for (const b of visibleOf(bot, cids, 26, { max: 16, rays: 800 })) {
    const k = keyOf(b.position)
    if (!st.looted.has(k) && !st.chestSeen.has(k)) st.chestSeen.set(k, { pos: b.position.clone(), seen: now })
  }
}

function nextTarget (bot, st, kinds = ['gold', 'chest']) {
  const now = gameClock.now()
  const me = bot.entity.position
  const brutes = mobs(bot, 'piglin_brute', 40)
  const cand = []
  if (kinds.includes('gold')) for (const [k, v] of st.gold) cand.push({ kind: 'gold', k, pos: v.pos })
  if (kinds.includes('chest')) for (const [k, v] of st.chestSeen) if (!st.looted.has(k)) cand.push({ kind: 'chest', k, pos: v.pos })
  return cand
    .filter(c => (st.skip.get(c.k) || 0) < now)
    // У брута — не ходить: он бьёт при любом золоте (если дойдёт до нас).
    .filter(c => !brutes.some((b : any) => b.position.distanceTo(c.pos) < 10 && (seesMob(bot, b) || b.position.distanceTo(me) < 16)))
    .sort((a, c) => a.pos.distanceTo(me) - c.pos.distanceTo(me))[0] || null
}

function inOwnTunnel (bot, S) {
  if (!S || !S.own || !S.own.size) return false
  const SL = require('.././sealed')
  const f = bot.entity.position.floored()
  return S.own.has(SL.keyV(f)) || S.own.has(SL.keyV(f.offset(0, 1, 0)))
}

function fullCover (b) {
  // Консервативно: один полный collision cube; сундук, ступени и гравий не кожух.
  return !!b && b.boundingBox === 'block' && !/^(gravel|sand|red_sand|.*concrete_powder)$/.test(b.name) &&
    Array.isArray(b.shapes) && b.shapes.some(q => q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1 && q[4] === 1 && q[5] === 1)
}

function reachSet (bot) {
  const { walkable } = require('.././walkable')
  const set = new Set()
  try { for (const n of walkable(bot, bot.entity.position, { radius: 24, maxNodes: 5000 })) set.add(keyOf(n.pos)) } catch {}
  return set
}

function threatens (bot, e, set) {
  if (seesMob(bot, e)) return true
  const f = e.position.floored()
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (set.has(`${f.x + dx},${f.y + dy},${f.z + dz}`)) return true
  return false
}

const SIDES4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]

async function centerIn (bot, c, ms = 2500) {
  const tx = c.x + 0.5; const tz = c.z + 0.5
  const until = gameClock.now() + ms
  try {
    while (gameClock.now() < until) {
      const p = bot.entity.position
      const dx = tx - p.x; const dz = tz - p.z
      if (Math.hypot(dx, dz) < 0.15) break
      await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
      bot.setControlState('sneak', true) // с края не сойти
      bot.setControlState('forward', true)
      await sleep(50)
      bot.setControlState('forward', false)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('sneak', false) }
  const f = bot.entity.position.floored()
  return f.x === c.x && f.y === c.y && f.z === c.z
}

module.exports = { gameClock, goals, Vec3, sleep, xyz, visibleOf, seesBlock, raySees, eyePos, worlds, BF, PLACE, ADMIRE_MS, LOVED, GOLD_ARMOR, ARMOR_DEST, GOLD_PICK, JUNK_KEEP, log, clamp, keyOf, countOf, itemNamed, metaOf, isBaby, aggressive, offhand, admiring, mobs, seesMob, angerSet, nearestTrader, goldWorn, wearGold, canReach, walkGoal, inLava, lavaFreeCell, effectOn, drinkFireRes, lavaEscapeDeep, makeIronPick, waitWatched, fireStep, lavaEscape, pickUp, handIngot, takeGoldBlock, lootChest, unpackGold, fireRes, reserveKeeper, dropJunk, vantagePoints, centerGuess, survey, nextTarget, inOwnTunnel, fullCover, reachSet, threatens, SIDES4, centerIn }
