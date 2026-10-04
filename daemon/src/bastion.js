'use strict'
// Бастион (mc_bastion): золото бастиона и бартер с пиглинами — путь
// спидраннеров под 1.21.11 (SPEEDRUN.md): золотые блоки (9 слитков каждый) и
// сундуки, потом слитки пиглинам — огнестойкость (зелья), жемчуг, обсидиан,
// нить (кровати на дракона), огненные заряды.
//
// Механика — исходники 1.21.11 (PiglinAi, Block.playerWillDestroy, ChestBlock,
// Sensor, TargetingConditions, LivingEntity.getVisibilityPercent), 2026-09-28:
//   * сломать блок из #guarded_by_piglins (gold_block, gilded_blackstone,
//     сундук, бочка, золотые руды, raw_gold_block, шалкеры, медные сундуки) —
//     злит пиглинов в коробке игрока, раздутой на 16, БЕЗ взгляда, но только
//     тех, у кого сейчас активность IDLE (PiglinAi.isIdle) и кто ближе
//     дальности цели: 16 × видимость игрока (TargetingConditions.test).
//     Крадучись видимость 0.8 — злятся только те, кто ближе 12.8.
//   * пиглин, который разглядывает золото (слиток в левой руке, 119 тиков),
//     в активности ADMIRE_ITEM — не IDLE, блок его не злит. Отсюда приём:
//     вручить слиток каждому, кто рядом, и ломать, пока они разглядывают —
//     слиток при этом не пропадает, это обычный бартер.
//   * малыши не нападают (StartAttacking только у взрослых); брут — не Piglin:
//     от блока не злится, но бьёт всегда (50 хп, 13 урона топором, топор
//     выбивает щит), золото его не успокаивает.
//   * открыть сундук/бочку — злит тех же, но только кто ВИДИТ (canSee).
//   * злость — 600 тиков (30 с). Ударить пиглина — злость расходится на
//     взрослых рядом (broadcastAngerTarget).
//   * золотой блок — iron_pickaxe и лучше (needs_iron_tool), 0.75 с железной.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { sleep, xyz } = require('./movement')
const { visibleOf, seesBlock } = require('./sight')
const { raySees, eyePos } = require('./perception')
const worlds = require('./worlds')
const BF = require('./barter-flow')

const PLACE = 'бастион (ад)'
const ADMIRE_MS = 119 * 50
const LOVED = /^(gold_ingot|gold_block|gilded_blackstone|golden_[a-z_]+|gold_ore|deepslate_gold_ore|nether_gold_ore|raw_gold|raw_gold_block|light_weighted_pressure_plate|bell|clock|glistering_melon_slice|enchanted_golden_apple)$/
const GOLD_ARMOR = ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots']
const ARMOR_DEST = { golden_helmet: 'head', golden_chestplate: 'torso', golden_leggings: 'legs', golden_boots: 'feet' }
const GOLD_PICK = /^(iron|diamond|netherite)_pickaxe$/
// Бартерный хлам: подобрать, чтобы не валялся под ногами (пиглин бросает к
// нам), и выбросить лишнее — место нужно жемчугу и зельям.
const JUNK_KEEP = { gravel: 8, soul_sand: 0, nether_brick: 0, quartz: 0, blackstone: 64, crying_obsidian: 8, dried_ghast: 0, netherrack: 64, basalt: 0, polished_blackstone_bricks: 0 }

// Время (ЧЧ:ММ:СС) — для разбора, куда ушли минуты этапа (dev-F 02.10).
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
// mob_flags бит 2 — «агрессивен»: у пиглина это ATTACK_TARGET (PiglinAi.updateActivity → setAggressive).
const aggressive = (bot, e) => ((Number(metaOf(bot, e, 'mob_flags')) || 0) & 4) !== 0
// Левая рука (equipment[1]): слиток или другое любимое — разглядывает.
const offhand = e => { const it = e && e.equipment && e.equipment[1]; return it ? it.name : null }
const admiring = e => LOVED.test(offhand(e) || '')

function mobs (bot, name, r, from = null) {
  const me = from || bot.entity.position
  return Object.values(bot.entities).filter(e => e && e.name === name && e.position && e.isValid !== false && e.position.distanceTo(me) <= r)
}
const seesMob = (bot, e) => raySees(bot, eyePos(bot), e.position.offset(0, (e.height || 1.9) * 0.6, 0))

// Кого разозлит сломанный сейчас охраняемый блок: взрослые пиглины, которые не
// разглядывают золото, ближе 16 × видимость (крадучись 12.8) от наших ног, и в
// коробке ±16 (getEntitiesOfClass). Запас 0.6 — на их шаг за время копки.
function angerSet (bot, feet = null, sneak = true) {
  const at = feet || bot.entity.position
  const R = (sneak ? 12.8 : 16) + 0.6
  return mobs(bot, 'piglin', 24, at).filter(e =>
    !isBaby(bot, e) && !admiring(e) && e.position.distanceTo(at) <= R &&
    Math.abs(e.position.x - at.x) <= 16.6 && Math.abs(e.position.z - at.z) <= 16.6 &&
    e.position.y + 1.95 >= at.y - 16 && e.position.y <= at.y + 17.8)
}

// Ближайший взрослый пиглин для бартера: сначала те, до кого дойти ногами
// (заливка walkable, 20 блоков), потом любой в r. { e, walk } — walk:false —
// дойти нельзя без копки.
function nearestTrader (bot, r = 48) {
  const { walkable } = require('./walkable')
  const me = bot.entity.position
  const list = mobs(bot, 'piglin', r).filter(e => !isBaby(bot, e) && !aggressive(bot, e)).sort((a, c) => a.position.distanceTo(me) - c.position.distanceTo(me))
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

// Ходьба с ответом на удар по дороге (nether.guarded) и со сроком.
// dig:false — только по готовому (без копки и подмостей): по бастиону ходят
// его мостами и лестницами. Прогон 5 лаборатории: обход точек обзора сквозь
// стены (208 кирпичей за вызов) кончился «tried to swim in lava».
async function walkGoal (session, ctl, goal, ms, { dig = true } = {}) {
  if (ctl.waitReflex) await ctl.waitReflex()
  const bot = session.bot
  const { guarded } = require('./nether')
  const mv = bot.pathfinder && bot.pathfinder.movements
  const was = mv ? { canDig: mv.canDig, scaf: mv.scafoldingBlocks } : null
  if (mv && !dig) { mv.canDig = false; mv.scafoldingBlocks = [] }
  // ND_GUARD=1: идёт ответ стража (столб/коробка) — сперва дождаться его, и ходьбу оборвать, если он начнётся.
  if (process.env.ND_GUARD !== '0') await require('./ne-guard').waitIdle(bot)
  return guarded(session, ctl, async sub => {
    const clock = () => require('./reflex-lock').clock(session)
    const until = clock() + ms
    let timer = null
    const stop = () => { try { bot.pathfinder.setGoal(null) } catch {} }
    sub.onAbort.push(stop)
    let watch = null
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        // Лава под шагом — сразу стоп и прыжок к полу (в Аду ведро не работает).
        new Promise((_resolve, reject) => { watch = setInterval(() => { if (session.reflex) return; if (clock() >= until) reject(new Error('время вышло')); else if (inLava(bot)) reject(new Error('лава')); else if (process.env.ND_GUARD !== '0' && process.env.ND_GUARD_REFLEX === '0' && require('./ne-guard').busy(bot)) reject(new Error('ответ стража')) }, 100) })
      ])
      // goto (mineflayer-pathfinder 2.4.5, lib/goto.js) «успешно» кончается и
      // на пустом пути — noPath с длиной 0: репетиция 3 — шесть «ok» подряд без
      // шага. Дошёл — только если цель правда достигнута.
      const f = bot.entity.position.floored()
      const reached = typeof goal.isEnd === 'function' ? goal.isEnd(f) : true
      return reached ? { ok: true } : { ok: false, error: 'пути нет (pathfinder: пустой путь)' }
    } catch (e) {
      if (e.message === 'лава') { stop(); await lavaEscape(bot) }
      return { ok: false, error: e.message }
    } finally {
      if (timer) clearTimeout(timer)
      if (watch) clearInterval(watch)
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
// Клетка выхода из лавы: не портал (перенос горящим — D6-32) и без лавы рядом по горизонтали (рамка не задевает).
function lavaFreeCell (bot, c) {
  for (const dy of [0, 1]) {
    const b = bot.blockAt(c.offset(0, dy, 0))
    if (b && /nether_portal/.test(b.name)) return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = bot.blockAt(c.offset(dx, dy, dz)); if (q && q.name === 'lava') return false }
  }
  return true
}

// Вон из лавы: прыжком к ближайшему твёрдому полу без лавы (как
// director.escapeFire; вода в Аду испаряется).
// minecraft-data 1.21.11 зовёт эффекты в PascalCase (FireResistance) — по snake_case там пусто, и «действует» всегда
// было «нет» (blaze.hasEffect, 29.09): огнестойкость пилась поверх действующей.
function effectOn (bot, name) {
  try {
    const pascal = String(name).split('_').map(q => q.charAt(0).toUpperCase() + q.slice(1)).join('')
    const eff = bot.registry.effectsByName[name] || bot.registry.effectsByName[pascal]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}
// Огнестойкость из рюкзака (зелье — выпить, взрывное — себе под ноги). null — нет зелья.
async function drinkFireRes (bot) {
  if (effectOn(bot, 'fire_resistance')) return 'уже'
  const { potionOf } = require('./pvp')
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

// В лаве глубоко (озеро y 24–31 у бастиона 105,87: pit-v2-14, pit-v3-7 30.09 — смерть «tried to swim in
// lava», ближней опоры в ±3 нет): огнестойкость, если есть, и вплавь вверх к ближней твёрдой опоре в ±6.
async function lavaEscapeDeep (bot) {
  const fr = await drinkFireRes(bot).catch(() => null)
  const t0 = Date.now()
  try {
    while (inLava(bot) && Date.now() - t0 < (fr === 'выпил' || fr === 'уже' ? 20000 : 5000)) {
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
  log('из лавы вплавь', { ok: !inLava(bot), fireRes: fr, hp: Math.round(bot.health ?? 0), ms: Date.now() - t0 })
  return !inLava(bot)
}

// Железная кирка из того, что есть: сырое железо — в печь (печь и доски у тела), самородки и блок — в
// слитки на верстаке, 3 слитка + 2 палки — кирка. true — кирка в рюкзаке.
async function makeIronPick (session, ctl) {
  const bot = session.bot
  const A = require('./actions')
  const C = require('./containers')
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

// Ожидание под присмотром (вместо слепого sleep): лава/огонь у ног — выйти, урон — прервать (D6-25 03.10: «жду место»
// 15 с ×2 на открытом, гаст поджёг — 11 ударов огнём стоя на месте, смерть). Возвращает причину обрыва или null.
async function waitWatched (session, ctl, ms) {
  const bot = session.bot
  const t0 = Date.now()
  let hp0 = bot.health ?? 20
  while (Date.now() - t0 < ms && !ctl.aborted) {
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
// Шаг из огня в соседнюю клетку без огня и лавы, с полом.
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
  const t0 = Date.now()
  while (Date.now() - t0 < 1500) {
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
  const t0 = Date.now()
  await sleep(500)
  while (Date.now() - t0 < 2500) {
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
  try { return await require('./actions').collectNearbyDrops(bot, ctl, { radius, timeoutMs: ms }) } catch { return 0 }
}

// Вручить слиток пиглину (правый клик, PiglinAi.mobInteract): только тому, кого
// видно и до чьей рамки 3 блока (pick.aim — честный прицел, как у клиента).
async function handIngot (session, ctl, pg, walkMs = 5000) {
  const bot = session.bot
  const pick = require('./pick')
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

// Одна выемка золотого блока: подойти, убедиться, что никто не разозлится
// (при нужде — вручить слитки тем, кто рядом), и сломать крадучись.
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
  if (!canReach(bot, pos)) { st.skip.set(key, Date.now() + 90000); return 'unreachable' }
  // Вплотную (общая грань с клеткой ног или головы — её мы сами открыли
  // штреком) — видим эту грань, даже если луч к центру блока идёт через соседний
  // (ферма 29.09: «hidden» у золота прямо у ног после штрека).
  const adjacentFace = () => {
    const f = bot.entity.position.floored()
    for (const c of [f, f.offset(0, 1, 0)]) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (c.offset(dx, dy, dz).equals(pos)) return true
    return false
  }
  if (!seesBlock(bot, b) && !adjacentFace()) { st.skip.set(key, Date.now() + 60000); return 'hidden' }
  const brute = mobs(bot, 'piglin_brute', 12).find(e => seesMob(bot, e))
  if (brute) { st.skip.set(key, Date.now() + 30000); return 'brute' }
  // Кого разозлит: вручить им слитки (не больше 4 на блок; каждый — бартер).
  // Кто до нас не дойдёт и не видит (мы в стене, в своей камере) — не в счёт.
  const reach0 = reachSet(bot)
  const dangerous = () => angerSet(bot).filter(e => threatens(bot, e, reach0))
  let angry = dangerous()
  let bribes = 0
  while (angry.length && !ctl.aborted && bribes < 4) {
    if (!countOf(bot, 'gold_ingot')) break
    if (angry.length > 3) break
    const pg = angry.sort((a, c) => a.position.distanceTo(bot.entity.position) - c.position.distanceTo(bot.entity.position))[0]
    if (pg.position.distanceTo(bot.entity.position) > 7 || !seesMob(bot, pg)) break
    const ok = await handIngot(session, ctl, pg, 4000)
    bribes++
    if (ok) { st.bribed++; st.traded++ }
    if (!canReach(bot, pos)) await walkGoal(session, ctl, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), 5000)
    angry = dangerous()
  }
  if (angry.length) {
    st.skip.set(key, Date.now() + 20000)
    st.lastBlocked = { at: key, piglins: angry.length, nearest: Math.round(Math.min(...angry.map(e => e.position.distanceTo(bot.entity.position)))) }
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
  if (!dug) { st.skip.set(key, Date.now() + 30000); return 'failed' }
  st.gold.delete(key)
  st.pred.delete(key)
  st.blocks++
  st.lastBreak = Date.now()
  // Блок — любимое пиглинов: подобрать раньше них.
  await pickUp(bot, ctl, 5, 3500)
  return 'dug'
}

// Сундук бастиона: открыть, только если ни один пиглин не видит (иначе злость).
async function lootChest (session, ctl, pos, st) {
  const bot = session.bot
  const S = require('./structures')
  const key = keyOf(pos)
  if (!canReach(bot, pos, 4.2)) {
    await walkGoal(session, ctl, new goals.GoalLookAtBlock(pos, bot.world, { reach: 3.8 }), 20000)
  }
  if (ctl.aborted) return 'aborted'
  if (!canReach(bot, pos, 4.4)) { st.skip.set(key, Date.now() + 90000); return 'unreachable' }
  const eyes = S.piglinsWatching(bot).filter(e => e.name === 'piglin' && !isBaby(bot, e) && !admiring(e))
  if (eyes.length) {
    // Разглядывающих не злит: вручить слитки смотрящим, если их двое-трое рядом.
    let bribes = 0
    for (const pg of eyes.slice(0, 3)) {
      if (!countOf(bot, 'gold_ingot') || pg.position.distanceTo(bot.entity.position) > 7) break
      if (await handIngot(session, ctl, pg, 4000)) { bribes++; st.traded++ }
    }
    const still = S.piglinsWatching(bot).filter(e => e.name === 'piglin' && !isBaby(bot, e) && !admiring(e))
    if (still.length) { st.skip.set(key, Date.now() + 25000); return 'watched' }
  }
  try {
    const r = await S.takeWorth(session, ctl, pos, { kind: 'bastion' })
    st.chests.push({ at: key, took: r.took || {}, stopped: r.stopped })
    if (r.stopped && /видят/.test(r.stopped)) { st.skip.set(key, Date.now() + 25000); return 'watched' }
    st.looted.add(key)
    return 'looted'
  } catch (e) {
    st.skip.set(key, Date.now() + 60000)
    st.chests.push({ at: key, error: e.message })
    return 'failed'
  }
}

// Слитки из блоков: верстак не нужен (1 блок → 9 слитков, сетка 2x2).
async function unpackGold (session, ctl, want) {
  const bot = session.bot
  const blocks = countOf(bot, 'gold_block')
  const have = countOf(bot, 'gold_ingot')
  if (!blocks || have >= want) return 0
  const n = Math.min(blocks, Math.ceil((want - have) / 9))
  try {
    await require('./actions').craft(session, ctl, { item: 'gold_ingot', count: n * 9 })
  } catch (e) { log('слитки', { error: e.message }) }
  return countOf(bot, 'gold_ingot') - have
}

function fireRes (bot) {
  let n = 0
  try {
    const { potionsOf } = require('./fightkit')
    const p = potionsOf(bot)
    n = (p.fire_resistance || 0) + (p.long_fire_resistance || 0) + (p.splash_fire_resistance || 0) + (p.splash_long_fire_resistance || 0)
  } catch {}
  return n
}

// Аварийный запас (pack.RESERVE, research/05-synthesis.md F.5): блоки стройки, кирка, еда — без них нет коробки
// аварийного отхода (survival.refuge). Выброс хлама бастиона не опускает их ниже запаса: keep(name, count) — можно ли
// выбросить эту стопку; да — запас уменьшается на неё (общий счёт на весь выброс).
function reserveKeeper (bot) {
  const pack = require('./pack')
  const left = pack.reserveLeft(bot)
  return (name, count) => {
    const kind = pack.reserveKind(bot, name)
    if (!kind) return true
    if (left[kind] - count < pack.RESERVE[kind]) return false
    left[kind] -= count
    return true
  }
}

// Выбросить бартерный хлам сверх нормы (гравий, песок душ, кирпич Ада…).
async function dropJunk (bot) {
  const tossed = []
  const spare = reserveKeeper(bot)
  for (const [name, keep] of Object.entries(JUNK_KEEP)) {
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

// Точки обзора вокруг бастиона: кольцо радиусов 14 и 26 по 8 сторонам —
// оттуда видно новые стены с золотом и сундуки. Посещённые не повторяются.
// По этажам сверху вниз: золото и сундуки бастиона — у его пола (y 33..50:
// сокровищница, мост, залы), а сверху, с крепостной стены, их не видно
// (репетиция на двойнике мира прохождения, 2026-09-28: 6 точек обзора на
// y 56..70 — ни одного золотого блока, а 22 лежали на y 33..50).
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

// Центр бастиона по видимому кирпичу чернокамня (не рентген: только то, что видно).
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

// Осмотр: видимые золотые блоки и сундуки (память этого вызова).
function survey (bot, st, goldR = 30) {
  const R = bot.registry.blocksByName
  const now = Date.now()
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

// Ближайшая цель, не отложенная: золото или сундук.
function nextTarget (bot, st, kinds = ['gold', 'chest']) {
  const now = Date.now()
  const me = bot.entity.position
  const brutes = mobs(bot, 'piglin_brute', 40)
  const cand = []
  if (kinds.includes('gold')) for (const [k, v] of st.gold) cand.push({ kind: 'gold', k, pos: v.pos })
  if (kinds.includes('chest')) for (const [k, v] of st.chestSeen) if (!st.looted.has(k)) cand.push({ kind: 'chest', k, pos: v.pos })
  return cand
    .filter(c => (st.skip.get(c.k) || 0) < now)
    // У брута — не ходить: он бьёт при любом золоте (если дойдёт до нас).
    .filter(c => !brutes.some(b => b.position.distanceTo(c.pos) < 10 && (seesMob(bot, b) || b.position.distanceTo(me) < 16)))
    .sort((a, c) => a.pos.distanceTo(me) - c.pos.distanceTo(me))[0] || null
}

// Брут (50 хп, 13 урона топором, топор выбивает щит; золото его не
// успокаивает) — на земле мечом не взять: лаборатория, прогон 3 — «slain by
// Piglin Brute» за 71 с, отход на 16 блоков не спас (он бегает не медленнее).
// Приём: столб в 2–3 блока. Удар моба — его коробка, раздутая на 0.83 только
// по горизонтали (Mob.getAttackBoundingBox): брут ростом 1.95 до ног на +2 не
// достаёт, а мы его мечом сверху достаём (3 блока от глаз). Бить по откату
// (железный меч — 0.625 с), пока не умрёт или не уйдёт; потом слезть.
async function bruteDefense (session, ctl, st, forced = null) {
  const bot = session.bot
  const pick = require('./pick')
  // Столб — только от того, кто идёт на нас: агрессивен (mob_flags бит 2 —
  // ATTACK_TARGET есть) и виден ближе 12, или уже в 5 блоках. Брут на другом
  // этаже, который нас не видит, — не повод: прогон 4 лаборатории простоял на
  // столбах 3×60 с без единого взмаха, и на бартер не осталось времени.
  const me0 = bot.entity.position
  // В своём закрытом штреке брут за стеной не страшен (нет луча — нет пути к нам): столба в штреке нет (потолок), а
  // «отхожу» pathfinder'ом выводил наружу (neF-R25-1 02.10: 40 вызовов «столба нет — отхожу» за секунду).
  if (!forced && inOwnTunnel(bot, st.sealedState) && !mobs(bot, 'piglin_brute', 12).some(e => seesMob(bot, e))) return false
  // Видит нас в своём штреке (пролом) — заложиться, а не столб.
  if (!forced && inOwnTunnel(bot, st.sealedState)) {
    const seer = mobs(bot, 'piglin_brute', 12).find(e => seesMob(bot, e))
    // ND_BRUTE_HUNKER=1: ход закрыт (пробоев нет), брут виден сквозь щель/неполный блок — пути к нам у него нет, и
    // закладывать нечего (D6-22 03.10: 19 раз «заложился» с n 0, exposed false — 13 мин стояния до конца этапа).
    if (seer && process.env.ND_BRUTE_HUNKER === '1' && seer.position.distanceTo(bot.entity.position) > 3.5 && !require('./sealed').exposure(bot, st.sealedState.own).length) return false
    if (seer && await hunker(session, ctl, st, 'брут видит в штреке', seer)) return true
  }
  const brute = forced || mobs(bot, 'piglin_brute', 12).find(e => {
    const d = e.position.distanceTo(me0)
    if (d < 6) return true
    if (!aggressive(bot, e) || !seesMob(bot, e)) return false
    // Идёт к нам: за последнюю секунду ближе на 1+ блок (st.bruteSeen — прошлые расстояния).
    const prev = st.bruteSeen.get(e.id)
    st.bruteSeen.set(e.id, { d, at: Date.now() })
    return prev && Date.now() - prev.at < 2500 && prev.d - d > 1
  })
  if (!brute) return false
  st.brutes++
  const t0 = Date.now()
  const base = bot.entity.position.floored()
  let pil = null
  try { pil = await require('./pearls').emergencyPillar(bot, ctl) } catch (e) { pil = { ok: false, why: e.message } }
  if (!pil || !pil.ok) {
    // Столба не вышло (потолок, лава) — уйти от него.
    // ND_GUARD=1: столба нет (потолок) — коробка из блоков вокруг тела (ne-guard.boxIn): отход pathfinder'ом брут догонял
    // (VR25-2 03.10: «столба нет — отхожу», смерть через 1 с); яма не годится — брут прыгает в ту же шахту (проба 03.10).
    if (process.env.ND_GUARD !== '0') {
      const G = require('./ne-guard')
      const bx = await G.boxIn(bot, brute).catch(e => ({ ok: false, why: e.message }))
      if (bx.ok) {
        const sat = await G.sit(session, ctl, 25000)
        log('брут: коробка вместо столба', { placed: bx.placed, sat, hp: Math.round(bot.health ?? 0) })
        return true
      }
      log('брут: коробки нет', { why: bx.why, left: bx.left })
    }
    const me = bot.entity.position
    const dx = me.x - brute.position.x
    const dz = me.z - brute.position.z
    const n = Math.hypot(dx, dz) || 1
    log('брут: столба нет — отхожу', { why: pil && pil.why })
    await walkGoal(session, ctl, new goals.GoalNearXZ(Math.round(me.x + dx / n * 16), Math.round(me.z + dz / n * 16), 3), 12000)
    return true
  }
  const sword = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, c) => (/netherite/.test(c.name) ? 4 : /diamond/.test(c.name) ? 3 : /iron/.test(c.name) ? 2 : 1) - (/netherite/.test(a.name) ? 4 : /diamond/.test(a.name) ? 3 : /iron/.test(a.name) ? 2 : 1))[0]
  let swings = 0
  let arrows = 0
  let lastSwing = 0
  let away = 0
  let close = 0
  while (!ctl.aborted && Date.now() - t0 < 60000) {
    const e = bot.entities[brute.id]
    if (!e || e.isValid === false) { st.fights.push('брут убит со столба'); break }
    const d = e.position.distanceTo(bot.entity.position)
    const flat = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
    if (flat < 4) close = Date.now()
    // Ушёл, или 12 с не подходит к столбу и не злится — слезть и дальше.
    if (d > 12) { if (!away) away = Date.now(); if (Date.now() - away > 6000) break } else away = 0
    if (Date.now() - Math.max(t0, close) > 12000 && !aggressive(bot, e)) break
    if (Date.now() - Math.max(t0, close) > 20000 && !arrows) break
    if (Date.now() - t0 > 45000 && !swings) break
    if ((bot.health ?? 20) < 6) break
    const below = e.position.y <= bot.entity.position.y - 1.5
    const a = below ? pick.aim(bot, e) : null
    if (a && a.point && Date.now() - lastSwing >= 650) {
      try {
        if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) await bot.equip(sword, 'hand')
        await bot.lookAt(a.point, true)
        bot.attack(e)
        swings++
        lastSwing = Date.now()
      } catch {}
    } else if (!a && flat >= 3 && d <= 20 && seesMob(bot, e) && bot.inventory.items().some(i => i.name === 'bow') && bot.inventory.items().some(i => /arrow$/.test(i.name))) {
      // Не под столбом — лук: брут до нас не достаёт, а стрела достаёт его.
      try {
        const r = await require('./bow').shoot(bot, e, { shouldStop: () => ctl.aborted || !bot.entities[brute.id] })
        if (r && r.shot) arrows++
      } catch {}
    }
    await sleep(100)
  }
  log('брут со столба', { swings, arrows, hp: Math.round(bot.health ?? 0), alive: !!bot.entities[brute.id], s: Math.round((Date.now() - t0) / 1000) })
  // Слезть: копать столб под собой (блоки назад в рюкзак).
  try { await require('./pearls').pillarDown(bot, ctl, session.mcData, base) } catch {}
  return true
}

// Под ударом в СВОЁМ закрытом штреке (злой пиглин/брут в проломе у золота): столб в штреке не встаёт (потолок над
// головой), а отход pathfinder'ом (bruteDefense «отхожу») ведёт во двор к ним же. Ответ — заложить клетки вокруг тела
// (sealBody + над головой): брут и пиглин сквозь блок не бьют, арбалет без луча не стреляет. Враг стоит в соседней
// клетке (её не заложить) — шаг вглубь своего штрека и заложиться там. Сидеть, пока злые рядом (≤ 25 с), потом штрек
// дальше: заложенные клетки — не свои (S.filled), план обойдёт пролом или откроет свою заплатку.
// neF-Pa22-1 02.10: 14 золотых блоков закрытым штреком за 3.5 мин, затем у пролома к двору 3 удара (20 → 14 → 7 → 0)
// за 3 с — тело доламывало золото, «slain by Piglin Brute».
const FOES_RE = /^(piglin_brute|hoglin|zoglin)$/
function foesNear (bot, r = 10) {
  return Object.values(bot.entities || {}).filter(e => e && e.position && e !== bot.entity &&
    (FOES_RE.test(e.name || '') || (/^piglin$/.test(e.name || '') && aggressive(bot, e))) && e.position.distanceTo(bot.entity.position) < r)
}
// Синоним для мест, где имя inOwnTunnel занято локальной переменной (bastion(): const inOwnTunnel — булево).
const ownTunnelAt = (bot, S) => inOwnTunnel(bot, S)
function inOwnTunnel (bot, S) {
  if (!S || !S.own || !S.own.size) return false
  const SL = require('./sealed')
  const f = bot.entity.position.floored()
  return S.own.has(SL.keyV(f)) || S.own.has(SL.keyV(f.offset(0, 1, 0)))
}
// Клетка золота касается чужого воздуха — ломка вскроет штрек во двор (брут увидит и придёт).
// ND_GOLD_FAST_SAFE (Codex ne-gold.md): строгий режим добычи. Флаг — параметр вызова bastion (кампания передаёт fastSafe,
// у демона env кампании нет) или env демона; ставится в начале каждого вызова bastion().
let FAST_SAFE = process.env.ND_GOLD_FAST_SAFE === '1'
function fullCover (b) {
  // Консервативно: один полный collision cube; сундук, ступени и гравий не кожух.
  return !!b && b.boundingBox === 'block' && !/^(gravel|sand|red_sand|.*concrete_powder)$/.test(b.name) &&
    Array.isArray(b.shapes) && b.shapes.some(q => q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1 && q[4] === 1 && q[5] === 1)
}
function goldExposes (bot, S, pos) {
  const SL = require('./sealed')
  for (const [dx, dy, dz] of SL.FACES) {
    const n = pos.offset(dx, dy, dz)
    if (S.own.has(SL.keyV(n))) continue
    const b = bot.blockAt(n)
    if (FAST_SAFE ? !fullCover(b) : (!b || b.boundingBox === 'empty' || /lava|water/.test(b.name))) return true
  }
  return false
}
async function hunker (session, ctl, st, why, attacker = null) {
  const bot = session.bot
  const SL = require('./sealed')
  const S = st.sealedState
  if (!inOwnTunnel(bot, S) || SL.fillerCount(bot) < 3) return false
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const t0 = Date.now()
  const seal = async () => {
    const r = await sealBody(bot, S)
    const top = bot.entity.position.floored().offset(0, 2, 0)
    const tb = bot.blockAt(top)
    if (tb && tb.boundingBox === 'empty' && !/lava|water/.test(tb.name) && await SL.fillCell(bot, top)) { S.own.delete(SL.keyV(top)); r.n++; (S.filled || (S.filled = new Set())).add(SL.keyV(top)) }
    return r
  }
  // В безопасном режиме сначала сохранить возможность отступления: sealBody закладывает и свой ход.
  let r = st.fastSafe ? { n: 0, left: [], risky: ['до заделки'] } : await seal()
  let stepped = false
  // Враг в соседней клетке (заложить нельзя) — шаг вглубь своего штрека, прочь от него, и заложиться снова.
  const foe = attacker || foesNear(bot, 4).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (r.risky.length && foe && foe.position.distanceTo(bot.entity.position) < 3.5) {
    const f = bot.entity.position.floored()
    const opts = []
    for (const [dx, dz] of SIDES4) {
      const c = f.offset(dx, 0, dz)
      const h = c.offset(0, 1, 0)
      const fl = c.offset(0, -1, 0)
      const bc = bot.blockAt(c); const bh = bot.blockAt(h); const bf = bot.blockAt(fl)
      if (!bc || !bh || !bf || bc.boundingBox !== 'empty' || bh.boundingBox !== 'empty' || bf.boundingBox !== 'block') continue
      if (!S.own.has(SL.keyV(c)) && !S.own.has(SL.keyV(h))) continue
      opts.push({ c, d: c.distanceTo(foe.position) })
    }
    opts.sort((a, b) => b.d - a.d)
    if (opts.length && opts[0].d > f.distanceTo(foe.position)) {
      const back = f
      stepped = await centerIn(bot, opts[0].c, 1500)
      if (stepped) {
        // Клетки, откуда ушли, — заложить (между нами и врагом).
        for (const v of [back.offset(0, 1, 0), back]) if (await SL.fillCell(bot, v)) { S.own.delete(SL.keyV(v)); (S.filled || (S.filled = new Set())).add(SL.keyV(v)) }
        r = await seal()
      }
    }
  }
  if (st.fastSafe && !stepped) r = await seal()
  S.exposed = SL.exposure(bot, S.own).length > 0
  st.hunkers = (st.hunkers || 0) + 1
  log('штрек: удар — заложился', { why, n: r.n, left: r.left.length, risky: r.risky.length, stepped, exposed: S.exposed, hp: Math.round(bot.health ?? 0), foe: foe ? foe.name : null })
  // Сидеть, пока злые рядом. Бьют и в кармане (враг уже внутри: R26 02.10 — пиглин в 0.3 бл., «заложился», 4 удара
  // за 4 с, 20 → 0) — не сидеть: бой с ближним (обычный пиглин — 16 хп, три удара железным мечом).
  let hp0 = bot.health ?? 20
  while (!ctl.aborted && Date.now() - t0 < 25000) {
    if (!foesNear(bot, 10).length && Date.now() - t0 > 4000) break
    const hp = bot.health ?? 20
    const inside = foesNear(bot, 2.2)[0]
    if (inside || hp <= hp0 - 3) {
      log('штрек: бьют в кармане — бой', { foe: inside ? inside.name : null, hp: Math.round(hp), was: Math.round(hp0) })
      return false
    }
    hp0 = Math.max(hp0, hp)
    if (hp < 16) await eatIfHungry(session, ctl)
    await sleep(400)
  }
  return true
}

// Вход в толщу с открытого места. Штрек (tunnel.js / sealedGold) не начинается, когда тело стоит на открытом: каждый
// первый ход касается чужого воздуха («куска нет … foreign 13», «со старта не войти» — neF-Pa24-1, Pa21-1 02.10:
// бастион в 60–110 бл. от портала, а подход штреком 0 шагов). Закопаться: три клетки вниз под собой, над головой —
// блок (опора — стенка шахты). Тело в замкнутом кармане 1×2 в толще; его клетки — свои (rememberOwn и S.own), и
// штрек начинается «из своего». Колонна годится, если три клетки — копаемый камень, под ними твёрдый пол, все стенки
// кармана (уровни ног, головы и пробки) твёрдые и ни одной жидкости рядом; нет такой под ногами — ближайшая в 6 бл.
function burrowColumn (bot, f) {
  const SL = require('./sealed')
  const cls = v => SL.classOf(bot.blockAt(v))
  const safe = FAST_SAFE
  const cover = v => !safe || fullCover(bot.blockAt(v))
  const c = [f.offset(0, -1, 0), f.offset(0, -2, 0), f.offset(0, -3, 0)]
  if (!c.every(v => cls(v) === SL.SOLID && cover(v))) return false
  const fl = cls(f.offset(0, -4, 0))
  if (!(fl === SL.SOLID || fl === SL.HARD || fl === SL.GUARD) || !cover(f.offset(0, -4, 0))) return false
  for (const v of c) {
    for (const [dx, dy, dz] of SL.FACES) {
      if (dx === 0 && dz === 0) continue
      const k = cls(v.offset(dx, dy, dz))
      if ((k !== SL.SOLID && k !== SL.HARD && k !== SL.GUARD && k !== SL.FALL) || !cover(v.offset(dx, dy, dz))) return false
    }
  }
  // Ни лавы, ни воды в клетке под полом и вокруг пола.
  for (const [dx, dz] of [[0, 0], ...SIDES4]) if (cls(f.offset(dx, -4, dz)) === SL.FLUID || cls(f.offset(dx, -5, dz)) === SL.FLUID) return false
  return true
}
async function burrow (session, ctl, st, why = '') {
  const bot = session.bot
  const SL = require('./sealed')
  if (SL.fillerCount(bot) < 2) return { ok: false, why: 'нечем заложить шахту' }
  if (!bot.entity.onGround) return { ok: false, why: 'не на земле' }
  const me = bot.entity.position.floored()
  // Уже в своём штреке/кармане — глубже не закапываться: штрек отсюда не начался не из-за открытого места, а повтор
  // спускал тело по 3 клетки за ход до самого дна Ада (neF-R21-1 02.10: тело на y 5, «пути нет» ×5000 ходов).
  const own0 = require('./tunnel').ownSet(session)
  if (own0.has(SL.keyV(me)) || own0.has(SL.keyV(me.offset(0, 1, 0))) || (st.sealedState && st.sealedState.own && st.sealedState.own.has(SL.keyV(me)))) return { ok: false, why: 'уже в своём штреке — закапываться глубже незачем' }
  if (me.y < 30) return { ok: false, why: `низко (y ${me.y}) — у дна Ада лава` }
  let f = burrowColumn(bot, me) ? me : null
  if (!f) {
    const cands = []
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        for (let dy = -3; dy <= 3; dy++) {
          const v = me.offset(dx, dy, dz)
          const b = bot.blockAt(v); const h = bot.blockAt(v.offset(0, 1, 0))
          if (!b || !h || b.boundingBox !== 'empty' || h.boundingBox !== 'empty' || /lava|water|fire/.test(b.name + h.name)) continue
          if (!burrowColumn(bot, v)) continue
          cands.push({ v, d: Math.abs(dx) + Math.abs(dz) + 2 * Math.abs(dy) })
        }
      }
    }
    cands.sort((a, b) => a.d - b.d)
    for (const c of cands.slice(0, 3)) {
      const w = await walkGoal(session, ctl, new goals.GoalBlock(c.v.x, c.v.y, c.v.z), 12000, { dig: false })
      const at = bot.entity.position.floored()
      if (at.equals(c.v) && burrowColumn(bot, at)) { f = at; break }
      log('закопаться: к колонне не дошёл', { to: xyz(c.v), at: xyz(at), ok: w && w.ok })
    }
    if (!f) return { ok: false, why: cands.length ? 'к колонне не дошёл' : 'колонны в толще рядом нет' }
  }
  const safe = FAST_SAFE
  if (safe) { try { bot.pathfinder.setGoal(null) } catch {} ; bot.clearControlStates() }
  const centered = await centerIn(bot, f, 1500)
  if (safe && (!centered || !burrowColumn(bot, f))) return { ok: false, why: 'колонна изменилась или не встал' }
  for (let i = 1; i <= 3; i++) {
    if (safe && (ctl.aborted || (bot.health ?? 20) <= 0)) return { ok: false, why: 'закопаться: прервано' }
    const v = f.offset(0, -i, 0)
    const r = await SL.digCell(bot, v)
    if (r !== 'ok' && r !== 'air') return { ok: false, why: `копка ${xyz(v).x},${xyz(v).y},${xyz(v).z}: ${r}` }
    for (let k = 0; k < 20 && bot.entity.position.y > v.y + 0.2; k++) await sleep(50)
  }
  for (let k = 0; k < 20 && !bot.entity.onGround; k++) await sleep(50)
  if (safe && (!bot.entity.onGround || bot.entity.position.distanceTo(f.offset(0.5, -3, 0.5)) > 0.25)) return { ok: false, why: 'не приземлился на дно шахты' }
  const top = f.offset(0, -1, 0)
  const sealed = await SL.fillCell(bot, top)
  if (safe && (!sealed || !fullCover(bot.blockAt(top)))) return { ok: false, why: 'пробка не закрыла шахту' }
  const cells = [f.offset(0, -3, 0), f.offset(0, -2, 0)].map(v => SL.keyV(v))
  try { require('./tunnel').rememberOwn(session, new Set(cells)) } catch {}
  if (st.sealedState && st.sealedState.own) for (const k of cells) st.sealedState.own.add(k)
  st.burrows = (st.burrows || 0) + 1
  log('закопался', { why, at: xyz(bot.entity.position.floored()), sealed, moved: !f.equals(me) })
  return { ok: sealed, sealed, at: xyz(bot.entity.position.floored()) }
}

// Сторож лавы вокруг долгого шага (штрек подхода: план — секунды, тело стоит): лава натекла к ногам — оборвать шаг и
// выбраться (neF-T26-1 02.10: лава у портала прибытия на 4-й с вызова bastion, тело 6 с горело на месте — смерть).
async function lavaWatched (bot, ctl, fn) {
  const sub = { aborted: false, onAbort: [] }
  const cut = () => { if (sub.aborted) return; sub.aborted = true; for (const f of sub.onAbort) { try { f() } catch {} } }
  ctl.onAbort && ctl.onAbort.push(cut)
  if (ctl.aborted) cut()
  const watch = setInterval(() => { if (ctl.aborted || inLava(bot)) cut() }, 100)
  let r
  try { r = await fn(sub) } finally { clearInterval(watch) }
  if (inLava(bot)) {
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    // Прыжок не вынес (D7-26 03.10: «из лавы» к клетке над лавой, «выбрался» с inLava true, смерть через 2 с) — вплавь.
    await lavaEscape(bot)
    if (inLava(bot)) await lavaEscapeDeep(bot)
    log('штрек оборван: лава у ног — выбрался', { hp: Math.round(bot.health ?? 0), inLava: inLava(bot) })
    if (r && typeof r === 'object') r = { ...r, ok: false, why: 'лава у ног' }
  }
  return r
}

// RPC ne_burrow (кампания: штрек по Аду не начался с открытого места — закопаться и снова штрек, а не «дальше пешком»).
async function burrowIntent (session, ctl, p = {}) {
  if (require('./worlds').worldOf(session.bot) !== 'the_nether') return { ok: false, why: 'закапываюсь только в Аду' }
  const st = {}
  return burrow(session, ctl, st, p.why || 'по просьбе')
}

// Кто-то нас бьёт (злой пиглин, магмовый куб, иссушитель) — ответить боем.
async function answerAttack (session, ctl, st) {
  const bot = session.bot
  const combat = require('./combat')
  const a = combat.liveAttacker(session)
  if (!a || !a.position || a.position.distanceTo(bot.entity.position) > 8) {
    // ND_BRUTE_HUNKER=1: брут ближе 9 бл., а ход вскрыт — заложиться до удара (D6-24 03.10: выход штреком после
    // бартера, брут — 3 удара за 2 с, 20 → 0; ответ на удар запаздывает). Не чаще раза в 8 с.
    const S = st.sealedState
    if (process.env.ND_BRUTE_HUNKER === '1' && S && S.exposed && Date.now() - (st.bruteHunkAt || 0) > 8000 && inOwnTunnel(bot, S)) {
      const b = mobs(bot, 'piglin_brute', 9).sort((x, y) => x.position.distanceTo(bot.entity.position) - y.position.distanceTo(bot.entity.position))[0]
      if (b) {
        st.bruteHunkAt = Date.now()
        st.preHunkers = (st.preHunkers || 0) + 1
        if (await hunker(session, ctl, st, `брут в ${b.position.distanceTo(bot.entity.position).toFixed(1)} бл.`, b)) return true
      }
    }
    return false
  }
  // В своём закрытом штреке — не бой и не столб: заложиться (hunker). Пиглин/брут/хоглин — у пролома к двору.
  // Обычный пиглин уже вплотную (≤ 2.5 бл.) — бой, а не заложиться: он в нашем ходу, клетку с ним не заложить.
  const close = a.position.distanceTo(bot.entity.position) < 2.5
  // Скелет (долина песка душ у бастиона) стреляет в наш ход: бой с ним из штрека — 25 с без удара (он ниже/за углом), 10
  // стрел за 27 с, 20 → 0 (neF-Sc26-2 02.10). Заложиться — луча нет, стрел нет.
  if (/^(piglin_brute|piglin|hoglin|zoglin|skeleton)$/.test(a.name || '') && !(a.name === 'piglin' && close) && inOwnTunnel(bot, st.sealedState) && await hunker(session, ctl, st, 'удар ' + a.name, a)) return true
  if (a.name === 'piglin_brute') { await bruteDefense(session, ctl, st, a); return true }
  if (process.env.ND_GUARD !== '0') {
    const G = require('./ne-guard')
    if (G.HIDE_FROM.test(a.name || '') || G.meleeFoes(bot, 6).length >= 3 || (bot.health ?? 20) < 9) {
      const rr = await G.react(session, ctl, { force: { e: a, why: 'удар ' + a.name }, onOwn: cells => { if (st.sealedState && st.sealedState.own) for (const k of cells) st.sealedState.own.add(k) } })
      st.fights.push(a.name + ': ' + (rr.how || 'ответ'))
      return true
    }
  }
  try {
    const f = await combat.fight(session, ctl, { target: '#' + a.id, timeoutSeconds: 25, retreatAtHealth: 6, clearArea: 0 })
    st.fights.push(`${a.name}${f && (f.killed || (f.kills && f.kills.length)) ? ' убит' : ''}`)
  } catch (e) { st.fights.push(`${a.name}: ${e.message}`) }
  return true
}

async function eatIfHungry (session, ctl) {
  const bot = session.bot
  if ((bot.food ?? 20) >= 16 && (bot.health ?? 20) >= 14) return
  if ((bot.food ?? 20) >= 20) return
  try { await require('./actions').eat(session, {}) } catch {}
}

async function barterRound (session, ctl, st, count, deadline) {
  const bot = session.bot
  const pearls = require('./pearls')
  const secs = Math.max(20, Math.min(180, Math.round((deadline - Date.now()) / 1000) - 5))
  const r = await pearls.barter(session, ctl, { count, timeoutSeconds: secs, force: !BF.enabled() })
  st.traded += r.spent || 0
  for (const [k, v] of Object.entries(r.gained || {})) st.gained[k] = (st.gained[k] || 0) + v
  st.barters.push({ spent: r.spent || 0, stopped: r.stopped, pearls: r.pearls || 0 })
  const tossed = await dropJunk(bot)
  if (tossed.length) st.tossed.push(...tossed)
  return r
}

// Где золото, по видимому: сундуки (якоря кусков) и базальт валов (голоса) →
// вал жилого бастиона → стены под ним (wall_base 12 золотых, connected_wall 5).
// Гипотеза A (вал на wall_base) весит 3, B — 1: над wall_base всегда
// ramparts_0, над connected_wall — ramparts_0/1/2 (пулы 1.21.11).
function predictGold (bot, radius = 56) {
  const bp = require('./bastion-pieces')
  const R = bot.registry.blocksByName
  const cids = [R.chest && R.chest.id, R.trapped_chest && R.trapped_chest.id, R.barrel && R.barrel.id].filter(Boolean)
  const chests = visibleOf(bot, cids, radius, { max: 40, rays: 3000 }).map(b => ({ pos: b.position, block: b }))
  const bids = ['basalt', 'polished_basalt'].map(n => R[n] && R[n].id).filter(Boolean)
  const basalt = visibleOf(bot, bids, radius, { max: 300, rays: 4000 })
  const byChest = bp.locate(bot, chests).found
  let byBasalt = []
  const debug = []
  try { byBasalt = bp.voteByBasalt(bot, basalt, undefined, { debug }) } catch (e) { log('голоса', { error: e.message }) }
  // Один и тот же вал узнаётся тремя шаблонами одной формы (units/ramparts_0,
  // bridge/rampart_1, hoglin_stable/ramparts_1) — считать его один раз, иначе
  // вал моста давал «жилой» стене score 13 (ферма, случайный мир, 29.09).
  const seenR = new Set()
  const ramparts = [...byChest.filter(c => bp.RAMPART_SHAPES.has(c.piece)), ...byBasalt].filter(c => {
    const k = `${c.r}|${c.t.x},${c.t.y},${c.t.z}`
    if (seenR.has(k)) return false
    seenR.add(k)
    return true
  })
  const walls = new Map()
  for (const rc of ramparts) {
    const h = bp.unitsWallsFromRampart(rc)
    if (!h) continue
    for (const [name, w] of [['A', 3], ['B', 1]]) {
      const wb = h[name].find(c => c.piece === 'units/walls/wall_base')
      const cw = h[name].find(c => c.piece === 'units/walls/connected_wall')
      const k = `${wb.r}|${wb.t.x},${wb.t.y},${wb.t.z}`
      const cur = walls.get(k) || { wall: wb, conn: cw, score: 0, from: [] }
      cur.score += w
      cur.from.push(`${rc.piece.split('/').pop()}:${name}`)
      walls.set(k, cur)
    }
  }
  for (const w of walls.values()) {
    const v = bp.verify(bot, w.wall, { radius: 40 })
    w.match = v.match
    w.miss = v.miss
    w.score += Math.max(0, v.match - 2 * v.miss) / 10
  }
  // Одна слабая гипотеза (один вал, score 3) на ферме давала стену на y −3 —
  // 17 копок в никуда. Брать стену при двух голосах валов или при подтверждении
  // глазами, и только на разумной высоте (над бедроком, рядом с нами).
  const bestWalls = [...walls.values()]
    // С вышки до y 86 стена под валом (y 31) — в 55 блоках ниже глаз; порог 40 отбрасывал верную
    // гипотезу (b2-15 30.09: вал ramparts_0 узнан, 29 голосов, match 48, miss 0 — стен 0, золота 0).
    .filter(w => w.wall.t.y >= 5 && w.wall.t.y <= 120 && Math.abs(w.wall.t.y - bot.entity.position.y) < 64)
    // Глаза против (видно много чужого на месте стены) — нет; иначе хватает
    // одного вала (A, 3) — неверную гипотезу снимут два промаха копки.
    .filter(w => !(w.match >= 8 && w.miss > 0.3 * w.match))
    .filter(w => w.score >= 3 || (w.match >= 10 && w.miss <= 0.2 * w.match))
    .sort((a, b) => b.score - a.score)
  const direct = byChest.filter(c => !bp.RAMPART_SHAPES.has(c.piece) && c.gold > 0)
  const gold = []
  const add = (c, src, rank) => { for (const v of bp.goldOf(c)) gold.push({ pos: v, piece: c.piece, src, rank, wall: c }) }
  if (bestWalls[0]) { add(bestWalls[0].wall, 'стена'); add(bestWalls[0].conn, 'стена') }
  for (const c of direct) add(c, 'сундук')
  // Все типы (dev-F 02.10): любой узнанный кусок таблицы START_REL (сундук, базальт якорей, видимое золото моста и
  // центра сокровищницы) → гипотеза старта; лучшая (голоса кусков, совпадения глазами) → куски с золотом по слотам.
  // Ранг 10+ — свой у каждого слота/варианта: промахи снимают только его (side_wall_0 вместо side_wall_1 у конюшен).
  let start = null
  try {
    const gids = [R.gold_block && R.gold_block.id].filter(Boolean)
    const dbgA = []
    const goldSeen = visibleOf(bot, gids, radius, { max: 60, rays: 3000 })
    const byAnchors = [
      ...bp.locate(bot, chests, { radius, debug: dbgA }).found,
      ...bp.voteBy(bot, basalt, bp.BASALT_ANCHORS, 'b', { debug: dbgA, radius }),
      ...(goldSeen.length >= 4 ? bp.voteBy(bot, goldSeen, bp.GOLD_ANCHORS, 'G', { minVotes: 4, minMatch: 10, debug: dbgA, radius }) : []),
      ...ramparts
    ]
    const hyp = new Map()
    const seenA = new Set()
    for (const c of byAnchors) {
      const ak = c.piece + '|' + c.r + '|' + c.t.x + ',' + c.t.y + ',' + c.t.z
      if (seenA.has(ak)) continue
      seenA.add(ak)
      for (const S of bp.startsFrom(c)) {
        const k = S.type + '|' + S.r + '|' + S.t.x + ',' + S.t.y + ',' + S.t.z
        const h = hyp.get(k) || { ...S, score: 0, from: [] }
        h.score += S.w * (1 + Math.max(0, (c.match || 0) - 2 * (c.miss || 0)) / 20)
        h.from.push(c.piece.split('/').pop())
        hyp.set(k, h)
      }
    }
    const hs = [...hyp.values()].filter(h => h.t.y >= 5 && h.t.y <= 120 && Math.abs(h.t.y - bot.entity.position.y) < 72).sort((a, b) => b.score - a.score)
    // Одна форма вала у трёх типов (units ramparts_0/1/2, bridge rampart_1, hoglin ramparts_1): тип решают ОСТАЛЬНЫЕ
    // куски гипотезы — их видимые клетки сверяются глазами (verify); у неверного типа на месте его стен — чужое.
    for (const h of hs.slice(0, 6)) {
      let chk = 0
      for (const sl of (bp.START_REL[h.type] || [])) {
        const [piece, p] = Object.entries(sl.v).sort((x, y) => y[1] - x[1])[0]
        if (p < 0.5) continue
        const [ox, oz] = bp.rot(h.r, sl.d[0], sl.d[2])
        const v = bp.verify(bot, { piece, r: (h.r + sl.dr) & 3, t: { x: h.t.x + ox, y: h.t.y + sl.d[1], z: h.t.z + oz } }, { radius, maxChecks: 160 })
        chk += v.match - 2 * v.miss
      }
      h.check = chk
      h.score += Math.max(-2, Math.min(3, chk / 25))
    }
    // Хоглины видны — конюшни (только этот тип их спавнит; бруты есть у всех): глазами, как человек узнаёт двор.
    const hoglins = Object.values(bot.entities).filter(e => e && e.name === 'hoglin' && e.position && e.position.distanceTo(bot.entity.position) < 48).length
    if (hoglins) for (const h of hs) if (h.type === 'hoglin_stable') h.score += 1.5
    hs.sort((a, b) => b.score - a.score)
    // До четырёх гипотез разом (одна форма вала у трёх типов — тип решит копка): ранг гипотезы i — 100·(i+1) у верных
    // кусков (p ≥ 0.85), +слот+1 у вариантов. Два промаха ранга 100·k снимают гипотезу целиком (sealedGold), три
    // золота подряд — снимают чужие гипотезы рядом.
    const picked = hs.filter(h => h.score >= 0.3).slice(0, 4)
    picked.forEach((h, i) => {
      const pcs = bp.goldPiecesFromStart(h).filter(g => g.p >= 0.3)
      for (const g of pcs) add(g, 'старт', 100 * (i + 1) + (g.p >= 0.85 ? 0 : g.slot + 1))
      h.pieces = pcs.map(g => g.piece.split('/').pop() + '@' + g.t.x + ',' + g.t.y + ',' + g.t.z + ' p' + g.p)
    })
    start = picked[0] || null
    if (start) start.all = picked.map(h => ({ type: h.type, r: h.r, t: h.t, score: Math.round(h.score * 10) / 10 }))
    if (debug) debug.unshift({ starts: hs.slice(0, 3).map(h => ({ type: h.type, r: h.r, t: h.t, score: Math.round(h.score * 10) / 10, check: h.check, from: h.from.slice(0, 4) })), anchors: byAnchors.length, goldSeen: goldSeen.length, tried: dbgA.sort((x, y) => y.match - x.match).slice(0, 8) })
  } catch (e) { log('старт', { error: e.message }) }
  return { chests: chests.length, basalt: basalt.length, ramparts: ramparts.length, walls: bestWalls.slice(0, 3), direct, gold, start, debug: debug.slice(0, 5) }
}

// Кто из пиглинов до нас дойдёт или достанет арбалетом: видит нас — да;
// стоит на клетке, куда мы сами дошли бы пешком (walkable, 24 блока), — да.
// В стене бастиона, в своём штреке и за стенкой — нет: разозлить его золотом
// не страшно (он до нас не доберётся), это приём спидраннеров «ломать из
// закрытой камеры».
function reachSet (bot) {
  const { walkable } = require('./walkable')
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

// Вышка-обзор (как спидраннер смотрит бастион сверху): столб по 6 блоков до +24
// (или до y 84, под потолок Ада не лезем), на каждом шаге — predictGold. С
// земли у края бастиона вал не узнаётся (ферма, 29.09: 7–34 базальта), с
// высоты 78 — узнаётся (81 базальт, 35 голосов, 62 совпадения из 62).
async function towerScan (session, ctl, st) {
  const bot = session.bot
  const { towerUp } = require('./build')
  // Над головой крыша (внутри бастиона вышка не росла: +0..+1, ферма 29.09) —
  // сначала к месту с небом: клетка в 20 блоках, где над головой больше воздуха.
  const headroom = p => { let n = 0; for (let y = 2; y <= 25; y++) { const b = bot.blockAt(p.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava/.test(b.name)) break; n++ } return n }
  // Лава рядом с местом вышки (в 3 блоках вбок, от 4 ниже до 3 выше ног): столб там кончался падением в
  // лаву (pit-v5-14 30.09: вышка у 93,41,91, спуск — «tried to swim in lava», pit-v5-16 — ожоги у 96,39,90).
  const lavaNear = p => {
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -4; dy <= 3; dy++) {
      const b = bot.blockAt(p.offset(dx, dy, dz)); if (b && b.name === 'lava') return true
    }
    return false
  }
  const here0 = bot.entity.position.floored()
  if (headroom(here0) < 14 || lavaNear(here0)) {
    const { walkable } = require('./walkable')
    let best = null
    for (const n of walkable(bot, bot.entity.position, { radius: 20, maxNodes: 3000 })) {
      const h = headroom(n.pos)
      if (h < 14 || lavaNear(n.pos)) continue
      const score = h - n.d * 0.3
      if (!best || score > best.score) best = { pos: n.pos, score, h }
    }
    if (best) await walkGoal(session, ctl, new goals.GoalBlock(best.pos.x, best.pos.y, best.pos.z), 25000, { dig: false })
  }
  // Вышка и штрек — из блоков стройки; после долгого пути по Аду их нет (trip2-9 30.09: вышка +0..+1,
  // «бастион не узнан»). Добрать незерака рядом.
  const SLf = require('./sealed')
  if (SLf.fillerCount(bot) < 24) {
    try { const g = await require('./edges').gatherBlocks(bot, ctl, { want: 40 - SLf.fillerCount(bot), maxMs: 40000, radius: 10 }); log('вышка: блоки', { got: g && g.got, have: SLf.fillerCount(bot) }) } catch {}
  }
  const base = bot.entity.position.floored()
  let pg = predictGold(bot)
  let steps = 0
  // Выше, пока гипотеза стен слабая: один вал (score 3, голос одного вала) давал стену не там —
  // pit-v2-8 30.09: вышку не строили вовсе (стена «уже есть»), 4 копки мимо, золота 1 блок.
  // «Уверенно» — стену подтвердили два вала (или сундук-часть с золотом): pit-v3-5 30.09 — вал один,
  // score 4, вышка встала на 3 блока, обе гипотезы мимо (4 копки), золота 0; из штрека новая вышка слепа.
  const sure = q => q.direct.length > 0 || (q.walls.length > 0 && q.walls[0].from.length >= 2) || (q.start && q.start.score >= 1)
  while (!ctl.aborted && !sure(pg) && steps < 5 && bot.entity.position.y < 84) {
    const y0 = bot.entity.position.y
    const up = await towerUp(bot, ctl, 6)
    // Потолок над головой (крона багрового гриба, уступ; ферма 29.09, sealed-1:
    // вышка «от 91,53,85 до 91,53,85») — сквозь него: копать над головой и
    // строить столб (build.digUp: лаву за потолком не вскрывает).
    if (!up.placed) {
      const { digUp } = require('./build')
      try { await digUp(bot, ctl, { blocks: 6, mcData: bot.registry, tower: true }) } catch {}
    }
    steps++
    pg = predictGold(bot)
    if (bot.entity.position.y < y0 + 0.9) break
  }
  const top = bot.entity.position.floored()
  // Слепая вышка (ни базальта, ни сундуков — столб в толще незерака): следующая — не отсюда.
  st.blindTower = !pg.basalt && !pg.chests && !(st.bricks && st.bricks.size)
  log('вышка', { from: xyz(base), to: xyz(top), blind: st.blindTower || undefined, basalt: pg.basalt, chests: pg.chests, walls: pg.walls.map(w => ({ at: xyz(w.wall.t), r: w.wall.r, score: Math.round(w.score), from: w.from.length })), direct: pg.direct.map(c => c.piece), gold: pg.gold.length, start: pg.start ? { type: pg.start.type, score: Math.round(pg.start.score * 10) / 10, pieces: pg.start.pieces } : undefined, votes: pg.debug && pg.debug[0] })
  // Две лучшие гипотезы стен (ранг 0 и 1): вал над connected_wall тоже бывает
  // ramparts_0, и с одним видимым валом ранг 0 ошибался (ферма, слот 11).
  // Не золото на месте предсказания — вся гипотеза этого ранга снимается.
  const bp = require('./bastion-pieces')
  pg.walls.slice(0, 2).forEach((w, rank) => {
    for (const c of [w.wall, w.conn]) {
      for (const v of bp.goldOf(c)) {
        const k = keyOf(v)
        if (!st.pred.has(k) && !st.gold.has(k)) st.pred.set(k, { pos: v, piece: c.piece, rank, wall: c })
      }
    }
  })
  for (const g of pg.gold.filter(x => x.src === 'сундук')) {
    const k = keyOf(g.pos)
    if (!st.pred.has(k) && !st.gold.has(k)) st.pred.set(k, { pos: g.pos, piece: g.piece, rank: 0 })
  }
  for (const g of pg.gold.filter(x => x.src === 'старт')) {
    const k = keyOf(g.pos)
    if (!st.pred.has(k) && !st.gold.has(k)) st.pred.set(k, { pos: g.pos, piece: g.piece, rank: g.rank, wall: g.wall })
  }
  if (pg.start) st.start = { type: pg.start.type, r: pg.start.r, t: pg.start.t, score: Math.round(pg.start.score * 10) / 10, pieces: pg.start.pieces }
  // С вышки видно золото и сундуки двора — их тоже в цели (закрытый штрек).
  try { survey(bot, st, 56) } catch {}
  const w0 = pg.walls[0]
  if (w0) for (const c of [w0.wall, w0.conn]) { const P = bp.lib()[c.piece]; for (const [x, y, z] of (P.chests || [])) { const v = bp.toWorld(c, x, y, z); const k = keyOf(v); if (!st.chestSeen.has(k) && !st.looted.has(k)) st.chestSeen.set(k, { pos: v, seen: Date.now(), pred: true }) } }
  // Вниз — свой столб из-под ног (блоки вернутся), не прыжком.
  for (let i = 0; i < 30 && !ctl.aborted; i++) {
    const f = bot.entity.position.floored()
    if (f.y <= base.y) break
    const below = bot.blockAt(f.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') { await sleep(300); continue }
    try { await bot.dig(below, true) } catch { break }
    await sleep(250)
  }
  return pg
}

// Свой штрек к клетке по шагу (как игрок копает к известной руде): pathfinder с
// копкой сквозь стену бастиона на ферме отвечал «Took to long to decide path»,
// «пустой путь» или стоял 60 с. Шаг — по оси с большим разрывом, по высоте —
// ступенькой (вниз — копать перед собой ниже ног, вверх — над головой). Не
// копать охраняемое (позолоченный, сундук — злит пиглинов), не вскрывать лаву и
// воду (сосед клетки — жидкость). Готово — стоим вплотную (GoalGetToBlock).
function nextToBlock (f, t) {
  const dx = f.x - t.x; const dy = f.y - t.y; const dz = f.z - t.z
  return Math.abs(dx) + Math.abs(dy < 0 ? dy + 1 : dy) + Math.abs(dz) === 1
}
// Брут идёт на нас (злой, видит, ближе 10) — бросить ходьбу и штрек: пусть
// основной цикл встретит его со столба (bruteDefense), а не общий бой по
// дороге (ферма 29.09: две смерти «slain by Piglin Brute» на подходе к стене).
function bruteComing (bot) {
  return mobs(bot, 'piglin_brute', 10).some(e => aggressive(bot, e) && seesMob(bot, e))
}
async function walkUnlessBrute (session, ctl, goal, ms, opts) {
  const bot = session.bot
  let hit = false
  const iv = setInterval(() => { if (bruteComing(bot)) { hit = true; try { bot.pathfinder.setGoal(null) } catch {} } }, 300)
  try {
    const w = await walkGoal(session, ctl, goal, ms, opts)
    return hit ? { ok: false, error: 'брут идёт' } : w
  } finally { clearInterval(iv) }
}
async function stepCell (bot, next, up) {
  const t0 = Date.now()
  try {
    while (Date.now() - t0 < 2500 && !bot.entity.position.floored().equals(next)) {
      await bot.lookAt(next.offset(0.5, 1.6, 0.5), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', !!up)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
  await sleep(200)
  return bot.entity.position.floored().equals(next)
}
async function tunnelTo (session, ctl, target, { maxSteps = 60 } = {}) {
  const bot = session.bot
  const GUARD = /^(gold_block|gilded_blackstone|chest|trapped_chest|barrel|raw_gold_block|gold_ore|nether_gold_ore|bedrock)$/
  const wet = c => {
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(c.offset(dx, dy, dz))
      if (b && /lava|water/.test(b.name)) return true
    }
    return false
  }
  const clearable = c => {
    const b = bot.blockAt(c)
    if (!b) return false
    if (b.boundingBox === 'empty') return !/lava|water/.test(b.name)
    if (GUARD.test(b.name)) return false
    return !wet(c)
  }
  // Пол под новой клеткой ног: воздух — упадём, до лавы — смерть. Ферма 29.09,
  // bastion-route-12: тело копало пол на y 37 и падало в море лавы (y ≤ 31).
  const landOk = c => {
    for (let d = 1; d <= 4; d++) {
      const b = bot.blockAt(c.offset(0, -d, 0))
      if (!b) return 'мир не прогружен'
      if (/lava|fire|magma/.test(b.name)) return `под ногами ${b.name}`
      if (b.boundingBox === 'block') return d <= 2 ? null : `обрыв ${d}`
    }
    return 'пропасть'
  }
  const dig = async c => {
    const b = bot.blockAt(c)
    if (!b || b.boundingBox === 'empty') return true
    try {
      const tools = require('./items')
      if (tools.equipBestTool) await tools.equipBestTool(bot, b)
      await Promise.race([bot.dig(b, true), sleep(5000).then(() => { throw new Error('копал слишком долго') })])
    } catch { return false }
    const now = bot.blockAt(c)
    return !now || now.boundingBox === 'empty'
  }
  let steps = 0
  for (; steps < maxSteps && !ctl.aborted; steps++) {
    if (inLava(bot)) { await lavaEscape(bot); return { ok: false, why: 'лава', steps } }
    if (bruteComing(bot)) return { ok: false, why: 'брут идёт', steps }
    const f = bot.entity.position.floored()
    if (nextToBlock(f, target)) return { ok: true, steps }
    const dx = Math.sign(target.x - f.x); const dz = Math.sign(target.z - f.z)
    const needDown = target.y < f.y - 0 && !(Math.abs(target.x - f.x) + Math.abs(target.z - f.z) === 0 && target.y === f.y - 1)
    const needUp = target.y > f.y + 1
    const sy = needDown ? -1 : needUp ? 1 : 0
    const opts = []
    const ax = Math.abs(target.x - f.x) >= Math.abs(target.z - f.z)
    if (dx || dz) {
      const first = ax && dx ? [dx, 0] : dz ? [0, dz] : [dx, 0]
      const second = first[0] ? (dz ? [0, dz] : null) : (dx ? [dx, 0] : null)
      for (const [hx, hz] of [first, second].filter(Boolean)) opts.push({ next: f.offset(hx, sy, hz), up: sy > 0 })
      // Вбок и прямо, если по высоте не пускает (ступенька упёрлась).
      if (sy) for (const [hx, hz] of [first, second].filter(Boolean)) opts.push({ next: f.offset(hx, 0, hz), up: false })
    }
    if (!dx && !dz && sy) opts.push({ next: f.offset(0, sy, 0), up: sy > 0, vertical: true })
    let moved = false
    const why = []
    for (const o of opts) {
      // Клетки: ноги и голова следующей, при подъёме — ещё над своей головой.
      const cells = [o.next, o.next.offset(0, 1, 0)]
      if (o.up) cells.push(f.offset(0, 2, 0))
      if (o.vertical && sy < 0) cells.length = 1 // вниз столбом: только под ногами
      const bad = cells.find(c => !clearable(c))
      if (bad) { const bb = bot.blockAt(bad); why.push(`${xyz(bad).x},${xyz(bad).y},${xyz(bad).z}:${bb ? bb.name : '?'}${bb && bb.boundingBox !== 'empty' && wet(bad) ? '+жидкость' : ''}`); continue }
      const land = landOk(o.next)
      if (land) { why.push(`${o.next.x},${o.next.y},${o.next.z}:${land}`); continue }
      // Цель — золото: не ломать его как проход (ломает takeGoldBlock).
      if (cells.some(c => c.equals(target))) continue
      let ok = true
      for (const c of cells) { if (!(await dig(c))) { ok = false; why.push(`не копается ${c.x},${c.y},${c.z}`); break } }
      if (!ok) continue
      if (o.vertical && sy < 0) { await sleep(500); moved = true; break }
      // Шаг сам (вперёд, при подъёме — с прыжком): pathfinder на шаг в
      // свежую клетку отвечал «пустой путь» (пол Ада min(40, y) и не только).
      const d0 = Math.abs(f.x - target.x) + Math.abs(f.y - target.y) + Math.abs(f.z - target.z)
      let okStep = await stepCell(bot, o.next, o.up)
      // Сам не шагнул (зацепился краем, ступень) — один ход pathfinder'ом с копкой
      // (пол Ада опущен обёрткой digToPredicted, иначе «пустой путь»).
      if (!okStep && bot.entity.position.floored().equals(f)) {
        const w1 = await walkGoal(session, ctl, new goals.GoalBlock(o.next.x, o.next.y, o.next.z), 3500, { dig: true })
        okStep = !!(w1 && w1.ok)
      }
      const g = bot.entity.position.floored()
      // Шагнул не ровно в клетку (сполз ниже, съехал вбок), но ближе к цели — тоже ход.
      if (okStep || (!g.equals(f) && Math.abs(g.x - target.x) + Math.abs(g.y - target.y) + Math.abs(g.z - target.z) < d0)) { moved = true; break }
      why.push(`не шагнул ${o.next.x},${o.next.y},${o.next.z}`)
    }
    if (!moved) return { ok: false, why: 'штрек упёрся: ' + (why.join('; ') || 'нет ходов'), steps, at: xyz(f) }
  }
  return { ok: nextToBlock(bot.entity.position.floored(), target), steps, why: steps >= maxSteps ? 'штрек длиннее лимита' : undefined }
}

// Подход к стене снаружи, не через двор бастиона: там бруты и хоглины (ферма
// 29.09, route-7: 5 из 6 — «slain by Piglin Brute» на подходе).
async function approachWallTop (session, ctl, wall) {
  const bot = session.bot
  const bp = require('./bastion-pieces')
  // Снаружи, у внешних граней стены (шаблон x=0 и z=15 — там не двор
  // бастиона): в мире прохождения к западной грани wall_base на y 40 примыкает
  // уступ незерака (срез фермы 29.09), и штрек оттуда к нижней камере — 8
  // блоков сквозь стену. Кромка поверху (z 0..2, над слоем 23) — запасная.
  // По 25 с на точку, две точки: на ферме (route-10) подход «застревал»
  // (pathfinder reset: stuck) по минуте на каждую из четырёх.
  for (const [x, y, z] of [[-3, 9, 10], [8, 9, 18]]) {
    const p = bp.toWorld(wall, x, y, z)
    const floor0 = bot._ndNetherFloor
    bot._ndNetherFloor = Math.max(32, p.y - 6)
    const pf = bot.pathfinder
    const th = pf && pf.thinkTimeout
    if (pf) pf.thinkTimeout = 12000
    let w
    try { w = await walkUnlessBrute(session, ctl, new goals.GoalNear(p.x, p.y, p.z, 3), 25000, { dig: true }) } finally { bot._ndNetherFloor = floor0; if (pf) pf.thinkTimeout = th }
    if (bot.entity.position.distanceTo(p.offset(0.5, 0, 0.5)) < 5) return { ok: true, top: p }
    if (w && /брут/.test(w.error || '')) return { ok: false, top: p, error: w.error }
  }
  // Кромка поверху (z 0..2 над слоем 23) не нашлась ни разу: pathfinder не
  // мостит 40+ блоков над двором («No path»). Не пробуем.
  return { ok: false, top: bp.toWorld(wall, 8, 24, 1), error: 'снаружи к стене не подошёл' }
}

// Вход в стену высоко над лавой (путь спидраннеров «сверху вниз», SPEEDRUN.md):
// жилая стена wall_base — сплошной чернокамень 16×24×16 с золотом внутри (y 3–4
// и 17–18 шаблона), над ней ещё ~7 блоков сплошного основания вала (срез фермы
// 29.09). Внутри такой толщи штрек закрыт со всех сторон: ни брутов, ни лавы.
// Ищем клетку «куда дойду ногами» (заливка, без копки), у которой сбоку
// чернокамень этой толщи, не ниже y стены + 13 (над морем лавы y ≤ 31 — 14+
// блоков), и под ней нет пустоты до лавы. Лучшая — ближе к цели и короче путь.
// Ферма 29.09: подход к низу стены (y 41) и через двор — 12 смертей «tried to
// swim in lava» и 8 от брутов из 22 прогонов.
async function approachWallSide (session, ctl, wall, target) {
  const bot = session.bot
  const bp = require('./bastion-pieces')
  const { walkable } = require('./walkable')
  const a = bp.toWorld(wall, 0, 0, 0)
  const b = bp.toWorld(wall, 15, 0, 15)
  const box = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z), y0: wall.t.y, y1: wall.t.y + 31 }
  const inBox = q => q.x >= box.x0 && q.x <= box.x1 && q.z >= box.z0 && q.z <= box.z1 && q.y >= box.y0 && q.y <= box.y1
  const stone = q => { const s = bot.blockAt(q); return !!s && s.boundingBox === 'block' && /blackstone|basalt/.test(s.name) }
  const overLava = q => {
    for (let d = 1; d <= 20; d++) {
      const s = bot.blockAt(q.offset(0, -d, 0))
      if (!s) return true
      if (/lava/.test(s.name)) return true
      if (s.boundingBox === 'block') return false
    }
    return true
  }
  const minY = wall.t.y + 13
  let best = null
  let nodes = 0
  for (const n of walkable(bot, bot.entity.position, { radius: 64, maxNodes: 16000 })) {
    nodes++
    const q = n.pos
    if (q.y < minY) continue
    let side = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const w = q.offset(dx, 0, dz)
      if (inBox(w) && stone(w) && stone(w.offset(0, 1, 0))) { side = w; break }
    }
    if (!side || overLava(q)) continue
    const score = n.d * 0.5 + q.distanceTo(target) * 1.5
    if (!best || score < best.score) best = { q, side, score, steps: n.d }
  }
  if (!best) {
    // Ногами (без копки) не подойти — бастион за морем лавы или за скалой
    // (ферма 29.09, bastion-high-1: со старта 72,63,79 заливка 64 блоков стены не
    // нашла). Тогда pathfinder с копкой к грани, ближней к нам, на высоте стены + 16:
    // над лавой шаг стоит 1000 (_ndLavaStrict), путь пойдёт сквозь незерак.
    const me = bot.entity.position
    const cx = Math.max(box.x0 - 1, Math.min(box.x1 + 1, Math.floor(me.x)))
    const cz = Math.max(box.z0 - 1, Math.min(box.z1 + 1, Math.floor(me.z)))
    const ey = wall.t.y + 16
    const entry = new Vec3(cx, ey, cz)
    log('вход в стену: копая', { to: xyz(entry), nodes })
    const pf = bot.pathfinder
    const th = pf && pf.thinkTimeout
    if (pf) pf.thinkTimeout = 12000
    let w
    try { w = await walkUnlessBrute(session, ctl, new goals.GoalNear(entry.x, entry.y, entry.z, 2), 60000, { dig: true }) } finally { if (pf) pf.thinkTimeout = th }
    const ok = bot.entity.position.distanceTo(entry.offset(0.5, 0, 0.5)) <= 3.5 && !overLava(bot.entity.position.floored())
    return { ok, top: entry, nodes, error: ok ? undefined : (w && w.error) || 'копая к стене не дошёл' }
  }
  log('вход в стену', { at: xyz(best.q), side: xyz(best.side), steps: best.steps, target: xyz(target), nodes })
  const w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(best.q.x, best.q.y, best.q.z), 40000, { dig: false })
  const ok = bot.entity.position.floored().distanceTo(best.q) <= 1.5
  return { ok, top: best.q, error: ok ? undefined : (w && w.error) || 'не дошёл' }
}

// К предсказанному золоту — штреком (pathfinder с копкой до соседней клетки),
// потом ломать, если там правда золото (видно глазами). Проход за спиной
// закрыть двумя блоками, если до нас могут дойти злые (крадёмся в стену).
async function digToPredicted (session, ctl, st, t) {
  const bot = session.bot
  // Пол Ада для pathfinder (worlds.tuneMovements: не ниже min(40, где стоишь))
  // — нижняя камера жилого бастиона на y 35: без этого «пути нет» к 9 из 12
  // блоков. Лава моря ниже 32, её обходят штрафы шага.
  const floor0 = bot._ndNetherFloor
  // Пол 32 (над морем лавы): к стенам ведут полы жилых блоков на y 35–40, и пол
  // min(40, y) с вышки (y 58) отрезал все пути. Обход мобов тоже выключен: с ним
  // у стен (пиглины, бруты, хоглины) pathfinder не находил пути вовсе, а без
  // него дошёл с вышки 74,58,78 до 74,39,102 за 13 с (слот 16, 29.09).
  bot._ndNetherFloor = 32
  bot._ndMobAvoidOnly = new Set(['piglin_brute', 'hoglin'])
  bot._ndLavaStrict = true
  try { return await digToPredictedBody(session, ctl, st, t) } finally { bot._ndNetherFloor = floor0; bot._ndMobAvoidOnly = null; bot._ndLavaStrict = false }
}
async function digToPredictedBody (session, ctl, st, t) {
  const bot = session.bot
  // Стена известна — сперва на её кромку поверху (один раз за вызов).
  const pr = st.pred.get(t.k)
  if (st.outside && pr && pr.wall && !st.onWall && (st.wallTries || 0) < 2) {
    st.wallTries = (st.wallTries || 0) + 1
    // high — вход в толщу стены высоко над лавой (approachWallSide), иначе
    // прежний подход к низу внешних граней.
    const a = st.high ? await approachWallSide(session, ctl, pr.wall, t.pos) : await approachWallTop(session, ctl, pr.wall)
    st.onWall = a.ok
    log('на кромку стены', { top: xyz(a.top), ok: a.ok, error: a.error, at: xyz(bot.entity.position.floored()) })
  }
  // Брут видит нас — сначала он (столб, удары сверху: bruteDefense), а не
  // общий бой по дороге («бой без победы» с брутом и хоглином на ферме).
  if (mobs(bot, 'piglin_brute', 16).some(e => seesMob(bot, e))) { try { await bruteDefense(session, ctl, st) } catch {} }
  // Издалека — pathfinder к цели на 5 блоков (он ходит по бастиону и копает
  // немного), потом свой штрек. Решение пути — до 12 с.
  // С кромки стены — сразу штрек вниз внутри стены, без спуска во двор.
  if (!st.onWall && t.pos.distanceTo(bot.entity.position) > 9) {
    const pf0 = bot.pathfinder
    const th0 = pf0 && pf0.thinkTimeout
    if (pf0) pf0.thinkTimeout = 12000
    try { await walkUnlessBrute(session, ctl, new goals.GoalNear(t.pos.x, t.pos.y, t.pos.z, 5), 45000, { dig: true }) } catch {} finally { if (pf0) pf0.thinkTimeout = th0 }
    if (bruteComing(bot)) return { walk: 'брут идёт', block: '?' }
  }
  // Сначала пешком (без копки) к ближайшей к цели клетке, куда можно дойти, и
  // только потом штрек: путь с копкой через весь бастион pathfinder не успевал
  // решить («Took to long to decide path»), а длинный вёл у лавы (ферма, 29.09).
  try {
    const { walkable } = require('./walkable')
    let stage = null
    let bestD = Infinity
    for (const n of walkable(bot, bot.entity.position, { radius: 40, maxNodes: 8000 })) {
      const d = n.pos.distanceTo(t.pos)
      if (d < bestD) { bestD = d; stage = n.pos }
    }
    if (!st.onWall && stage && stage.distanceTo(bot.entity.position) > 2 && bestD + 3 < t.pos.distanceTo(bot.entity.position)) {
      await walkGoal(session, ctl, new goals.GoalBlock(stage.x, stage.y, stage.z), 30000, { dig: false })
    }
  } catch {}
  const trail = []
  const samp = setInterval(() => { try { const f = bot.entity.position.floored(); const last = trail[trail.length - 1]; if (!last || !last.equals(f)) trail.push(f) } catch {} }, 200)
  let w
  // Свой штрек по шагу; упёрся — pathfinder с копкой (до 12 с на решение).
  let tun = null
  try {
    tun = await tunnelTo(session, ctl, t.pos)
    w = { ok: tun.ok, error: tun.why }
    // Из толщи стены (high) — только свой штрек: pathfinder с копкой уводил во двор.
    if (!tun.ok && !ctl.aborted && !(st.high && st.onWall)) {
      const pf = bot.pathfinder
      const think = pf && pf.thinkTimeout
      if (pf) pf.thinkTimeout = 12000
      try { w = await walkGoal(session, ctl, new goals.GoalGetToBlock(t.pos.x, t.pos.y, t.pos.z), 45000, { dig: true }) } finally { if (pf) pf.thinkTimeout = think }
    }
  } finally { clearInterval(samp) }
  const b = bot.blockAt(t.pos)
  const res = { walk: w && w.ok ? 'ok' : (w && w.error) || '?', block: b ? b.name : '?', tunnel: tun ? { ok: tun.ok, steps: tun.steps, why: tun.why } : undefined }
  if (!(w && w.ok)) { st.skip.set(t.k, Date.now() + 45000); st.predMiss = (st.predMiss || 0) + 1; return res }
  if (b && b.boundingBox === 'empty' && st.blocks > 0 && t.pos.distanceTo(bot.entity.position) < 3) {
    // Воздух на месте предсказанного — уже выкопан (с видимого списка), не промах.
    st.pred.delete(t.k)
    return { ...res, r: 'уже выкопан' }
  }
  if (!b || b.name !== 'gold_block') {
    // Видим клетку, а золота нет — гипотеза этого ранга неверна целиком.
    const rank = (st.pred.get(t.k) || {}).rank
    st.pred.delete(t.k)
    st.predWrong = (st.predWrong || 0) + 1
    // Два промаха одного ранга (процессор generic превращает 30% золота в
    // треснутый кирпич — один промах ещё не приговор).
    if (b && b.boundingBox === 'block' && seesBlock(bot, b)) {
      st.rankMiss = st.rankMiss || {}
      st.rankMiss[rank] = (st.rankMiss[rank] || 0) + 1
      if (st.rankMiss[rank] >= 2) for (const [k, v] of [...st.pred.entries()]) if (v.rank === rank || (rank >= 100 && rank % 100 === 0 && Math.floor((v.rank || 0) / 100) === rank / 100)) st.pred.delete(k)
    }
    return { ...res, r: 'не золото', rank }
  }
  // Злые дойдут по штреку — закрыть его за спиной (ноги и голова).
  const set = reachSet(bot)
  const pigs = angerSet(bot).filter(e => threatens(bot, e, set))
  if (pigs.length && trail.length >= 2) {
    const { placeBlockAt } = require('./build')
    const me = bot.entity.position.floored()
    const back = [...trail].reverse().find(c => !c.equals(me) && c.distanceTo(me) <= 1.5)
    if (back) {
      for (const c of [back, back.offset(0, 1, 0)]) { try { await placeBlockAt(bot, c, { timeoutMs: 1500 }) } catch {} }
      res.sealed = xyz(back)
    }
  }
  st.pred.delete(t.k)
  st.gold.set(t.k, { pos: t.pos.clone(), seen: Date.now() })
  res.r = await takeGoldBlock(session, ctl, t.pos, st)
  return res
}

// Золото по шаблону закрытым штреком (sealed.js): ни шагу по двору бастиона.
// Вход — клетка «куда дойду ногами» (или своя клетка штрека), дальше только
// сквозь твёрдое: наши клетки не касаются чужого воздуха, лавы и огня; вход
// за спиной засыпается. Злые от сломанного золота до нас не дойдут и не увидят,
// брут и хоглин — тоже; лава не натечёт (её соседей не вскрываем). Приём
// спидраннеров «копать к золоту сквозь стену», только без открытых клеток.
// ND_GOLD_ROUTE=1 (поток nether 03.10): закрытый штрек (sealedGold) кончился, а золото карты осталось («пути нет» к
// нему: сквозная D1 — взято 3–15 блоков из 21–26). К каждому оставшемуся — ход по сетке копии мира (nether-route,
// коробка бастиона — открытое втридорога) в клетку рядом с блоком, ломка, и если клетка золота вскрыла ход во двор —
// заделать её сразу (злость пиглинов — всем в 16 бл. без луча, ход должен остаться закрытым). Брут/хоглин в 12 бл. —
// это золото пропустить. Сундуки — как было (sealedGold).
async function routeGold (session, ctl, st, until) {
  const bot = session.bot
  const NR = require('./nether-route')
  const SL = require('./sealed')
  if (!NR.enabled() || !NR.gridOf(session)) return { tried: 0 }
  const out = { tried: 0, dug: 0, routeFails: 0, skipped: 0, sealed: 0 }
  const KG = [...st.pred.values()].map(v => v.pos).filter(Boolean)
  if (!KG.length) return out
  const xs = KG.map(q => q.x); const ys = KG.map(q => q.y); const zs = KG.map(q => q.z)
  const zone = [Math.min(...xs) - 12, Math.min(...ys) - 6, Math.min(...zs) - 12, Math.max(...xs) + 12, Math.max(...ys) + 8, Math.max(...zs) + 12]
  const tried = new Set()
  const home = bot.entity.position.floored()
  for (let n = 0; n < 40 && !ctl.aborted && Date.now() < until - 20000; n++) {
    if (st.fastSafe && st.stopMining && st.stopMining()) break
    // ND_GUARD=1: злой пиглин/брут бьёт — ответ до следующего золота (B0-31/B0-3 03.10: пиглин, разозлённый ломкой, 5 ударов
    // за 4 с, а тело ломало следующее золото по сетке).
    if (process.env.ND_GUARD !== '0') {
      const GD = require('./ne-guard')
      const h = GD.hot(bot)
      if (h) { const rr = await GD.react(session, ctl, { force: h, onOwn: cells => { if (st.sealedState && st.sealedState.own) for (const c of cells) st.sealedState.own.add(c) } }); out.guards = (out.guards || 0) + 1; log('золото по сетке: страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) }); if (rr.how === 'яма' || rr.how === 'столб') break; continue }
    }
    if ((bot.health ?? 20) < 10) { await eatIfHungry(session, ctl); if ((bot.health ?? 20) < 10) break }
    const me = bot.entity.position
    const left = [...st.pred.entries()].filter(([k, v]) => !tried.has(k) && v.pos).sort((a, b) => a[1].pos.distanceTo(me) - b[1].pos.distanceTo(me))
    if (!left.length) break
    const [k, v] = left[0]
    tried.add(k)
    const G = v.pos
    const b0 = bot.blockAt(G)
    if (b0 && b0.name !== 'gold_block') { st.pred.delete(k); continue }
    // Брут/хоглин рядом с этим золотом — пропустить (ломка злит, ход у двора); места брутов из копии мира — тоже.
    if ([...mobs(bot, 'piglin_brute', 40), ...mobs(bot, 'hoglin', 40)].some(e => e.position.distanceTo(G) < 12)) { out.skipped++; continue }
    if (NR.bruteSpots(session).some(b => Math.hypot(b[0] - G.x, b[2] - G.z) < 10 && Math.abs(b[1] - G.y) < 6)) { out.skipped++; out.bruteHome = (out.bruteHome || 0) + 1; continue }
    out.tried++
    const rr = await NR.routeTo(session, ctl, { x: G.x, y: G.y, z: G.z, r: 1, dy: 1, zone, zoneExpo: 14, abortNear: { re: /^(piglin_brute|hoglin)$/, r: 10 }, timeoutSeconds: Math.max(30, Math.min(180, Math.round((until - Date.now()) / 1000) - 20)) })
    if (!rr.ok) {
      out.routeFails++
      // Ход брошен из-за брута/хоглина рядом — всё золото по сетке бросить, а не следующее (D7e-25 03.10: три цели подряд
      // мимо того же брута, на третьей — удары, смерть).
      if (/рядом (piglin_brute|hoglin)/.test(rr.why || '')) { out.stopped = rr.why; break }
      continue
    }
    for (const c of (rr.own || [])) { if (st.sealedState && st.sealedState.own) st.sealedState.own.add(c) }
    const b1 = bot.blockAt(G)
    if (!b1 || b1.name !== 'gold_block') { st.pred.delete(k); continue }
    // Ломка золота злит всех пиглинов в 16 бл. без луча (PiglinAi.angerNearbyPiglins, requireLineOfSight=false). Клетка
    // золота у чужого воздуха (ход откроется во двор) и пиглин в 16 — не ломать (D7-23 03.10: «foreign» ×4 подряд, пиглин —
    // 4 удара за 3 с, 16 → 0). Кого разозлит — angerSet.
    {
      const ownS = (st.sealedState && st.sealedState.own) || new Set()
      const body = [bot.entity.position.floored(), bot.entity.position.floored().offset(0, 1, 0)]
      const openNext = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => {
        const q = G.offset(dx, dy, dz); const bq = bot.blockAt(q)
        return bq && bq.boundingBox === 'empty' && !ownS.has(`${q.x},${q.y},${q.z}`) && !body.some(v => v.equals(q))
      })
      if (openNext && angerSet(bot, null, !!bot.getControlState('sneak')).length) { out.skippedPig = (out.skippedPig || 0) + 1; continue }
    }
    const r = await SL.digCell(bot, G, { allowGuard: true }).catch(e => 'err ' + e.message)
    if (r !== 'ok' && r !== 'air') { log('золото по сетке: не сломал', { at: xyz(G), r }); continue }
    out.dug++
    // Ломка злит пиглинов на 30 с — отметка для ND_ANGER_SAFE (ревью Codex ne-deaths.md №2: золото по сетке её не ставило).
    st.lastBreak = Date.now()
    if (st.sealedState) st.sealedState.lastBreak = st.lastBreak
    st.pred.delete(k)
    st.blocks++
    // Клетка золота касается чужого воздуха — заделать (свой ход не вскрывать во двор).
    await sleep(250)
    const own = (st.sealedState && st.sealedState.own) || new Set()
    const foreign = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => {
      const q = G.offset(dx, dy, dz); const bq = bot.blockAt(q)
      return bq && bq.boundingBox === 'empty' && !own.has(`${q.x},${q.y},${q.z}`) && !(q.equals(bot.entity.position.floored()) || q.equals(bot.entity.position.floored().offset(0, 1, 0)))
    })
    if (foreign) { await pickUp(bot, ctl, 2, 1200).catch(() => null); if (await SL.fillCell(bot, G)) out.sealed++ }
    log('золото по сетке', { at: xyz(G), steps: rr.steps, foreign, left: st.pred.size, bag: countOf(bot, 'gold_block') })
  }
  // Назад, откуда начинали (свой закрытый ход после sealedGold): от последнего золота у двора план ямы для бартера
  // «пути нет» (6 узлов: кругом чужой воздух) — D6-21 03.10: 21 золотой блок, 6 мин без бартера.
  // Только недалеко и без брутов/хоглинов рядом: D7c-24 03.10 — назад 45 бл. (69 шагов, открытое ×5), брут на ходу,
  // «бой на ходу» с ним — смерть за 2 с.
  const homeD = bot.entity.position.floored().distanceTo(home)
  // ND_GOLD_BACK=1 (по умолчанию нет: D7b-32 03.10 — из начала хода «яма: пути нет» ×10, 15 золотых блоков без бартера).
  if (process.env.ND_GOLD_BACK === '1' && out.dug && !ctl.aborted && homeD > 1.5 && homeD <= 20 && ![...mobs(bot, 'piglin_brute', 24), ...mobs(bot, 'hoglin', 24)].length) {
    const back = await NR.routeTo(session, ctl, { x: home.x, y: home.y, z: home.z, r: 0, dy: 0, zone, zoneExpo: 14, abortNear: { re: '^(piglin_brute|hoglin)$', r: 12 }, timeoutSeconds: 60 }).catch(e => ({ ok: false, why: e.message }))
    out.back = back.ok ? 'да' : back.why
    for (const c of (back.own || [])) { if (st.sealedState && st.sealedState.own) st.sealedState.own.add(c) }
  }
  log('золото по сетке: итог', out)
  return out
}

async function sealedGold (session, ctl, st, until) {
  const bot = session.bot
  const SL = require('./sealed')
  const S = st.sealedState || (st.sealedState = { own: new Set(), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 })
  S.deadline = until
  S.onThreat = async () => { try { await answerAttack(session, ctl, st) } catch {} }
  // BonusGold обходит проверку цели; в этом эксперименте охраняемое копаем только здесь.
  if (st.fastSafe) S.noBonus = true
  let noPlan = 0
  while (!ctl.aborted && Date.now() < until - 10000) {
    if (st.fastSafe && st.stopMining && st.stopMining()) break
    if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); continue }
    // Злые пиглины у вскрытого хода (золото касалось двора): сперва ответить — neF-map23-3 02.10: 4 удара и стрела
    // за 5 с, тело планировало следующий ход, 20 → 0 хп («slain by Piglin»). Брут — bruteDefense (столб).
    if (await answerAttack(session, ctl, st)) continue
    // Штрек вскрыт, а брут/хоглин уже в 6 бл. — заложиться до удара (удар брута 7+, трёх хватает на 20 хп).
    if (S.exposed && inOwnTunnel(bot, S) && foesNear(bot, 6).some(e => FOES_RE.test(e.name || '')) && await hunker(session, ctl, st, 'враг у пролома')) continue
    if ((bot.health ?? 20) < 8) { await eatIfHungry(session, ctl); if ((bot.health ?? 20) < 8) { S.fails.push('хп'); break } }
    await eatIfHungry(session, ctl)
    // Кирки в штреке: каменные кончились — фильтр бастиона пускал железную на чернокамень и незерак, она стиралась, и
    // золото дальше «не ломается: долго» (neF-Q22-1 02.10: ни одной кирки, 98 чернокамня и 8 палок в рюкзаке). Каменные
    // — из камня рюкзака заранее; железной нет, а железо из сундуков есть — сделать её.
    // ND_GUARD=1: враг вплотную — не крафт (VR32-1 03.10: брут бил, пока тело делало каменные кирки, 20 → 0 за 5 с).
    if (process.env.ND_GUARD !== '0') {
      const G = require('./ne-guard')
      const h = G.hot(bot, { near: 5 })
      if (h) { const rr = await G.react(session, ctl, { force: h, onOwn: cells => { for (const k of cells) S.own.add(k) } }); S.exposed = SL.exposure(bot, S.own).length > 0; log('штрек: страж', { why: h.why, how: rr.how, hp: Math.round(bot.health ?? 0) }); continue }
    }
    {
      const TN = require('./tunnel')
      if (TN.lowPicks(bot) === 0) { const made = await TN.restockPicks(session, ctl, 3).catch(() => 0); log('штрек: каменные кирки', { made }) }
      if (!bot.inventory.items().some(i => GOLD_PICK.test(i.name)) && !st.chestsOnly) {
        const made = await makeIronPick(session, ctl).catch(() => false)
        log('штрек: железная кирка', { made, ingots: countOf(bot, 'iron_ingot'), nuggets: countOf(bot, 'iron_nugget') })
        if (!made) { S.fails.push('нет железной кирки'); break }
      }
      // Свои клетки тела после крафта (верстак мог сдвинуть тело на клетку).
      const bc = [bot.entity.position.floored(), bot.entity.position.floored().offset(0, 1, 0)]
      if (bc.some(v => S.own.has(SL.keyV(v)))) for (const v of bc) { const b = bot.blockAt(v); if (b && b.boundingBox === 'empty') S.own.add(SL.keyV(v)) }
    }
    // Предсказания, уже выкопанные попутно (штрек прошёл сквозь них), — снять.
    for (const [k, v] of [...st.pred.entries()]) { const b = bot.blockAt(v.pos); if (b && b.boundingBox === 'empty' && S.own.has(k)) st.pred.delete(k) }
    for (const [k, g] of st.gold) if (!st.pred.has(k) && !S.own.has(k)) st.pred.set(k, { pos: g.pos, piece: 'видно', rank: 0 })
    // Без железной кирки (st.chestsOnly) — только сундуки: золото ей не взять, а железо в сундуках есть.
    const preds = st.chestsOnly ? [] : [...st.pred.entries()].filter(([k]) => (st.skip.get(k) || 0) < Date.now())
    const chestsT = st.lootChests ? [...st.chestSeen.entries()].filter(([k]) => !st.looted.has(k) && (st.skip.get(k) || 0) < Date.now()).map(([k, v]) => ({ k, pos: v.pos, chest: true })) : []
    if (!preds.length && !chestsT.length) break
    const minRank = preds.length ? Math.min(...preds.map(([, v]) => v.rank || 0)) : 0
    const tg = [...preds.filter(([, v]) => (v.rank || 0) === minRank).map(([k, v]) => ({ k, pos: v.pos })), ...(minRank === 0 ? chestsT : [])]
    const view = SL.worldView(bot)
    const me = bot.entity.position.floored()
    let starts
    const inTunnel = S.own.has(SL.keyV(me)) && !S.exposed
    if (inTunnel) starts = [{ x: me.x, y: me.y, z: me.z, g: 0 }]
    else {
      // Из открытого: клетки заливки; у брута и хоглина (10 блоков) — дороже.
      const danger = [...mobs(bot, 'piglin_brute', 40), ...mobs(bot, 'hoglin', 40)].map(e => e.position)
      starts = []
      for (const n of SL.reachCells(view, bot.entity.position, { radius: 28, maxNodes: 5000 })) {
        if (S.badStarts && S.badStarts.has(SL.key(n.x, n.y, n.z))) continue
        let g = n.d * 4
        for (const d of danger) { const dd = d.distanceTo(new Vec3(n.x, n.y, n.z)); if (dd < 10) g += (10 - dd) * 4 }
        starts.push({ x: n.x, y: n.y, z: n.z, g })
      }
      if (S.own.has(SL.keyV(me))) starts.push({ x: me.x, y: me.y, z: me.z, g: 0 })
    }
    const tgGoals = tg.map(t => ({ t, rank: minRank, g: SL.adjacentGoal(t.pos, view.cls), h: SL.manhattan(t.pos) }))
    if (!st.predAll) st.predAll = [...st.pred.values()].map(v => ({ rank: v.rank || 0, pos: v.pos.clone() }))
    const xs = [...starts.map(s => s.x), ...tg.map(t => t.pos.x)]
    const ys = [...starts.map(s => s.y), ...tg.map(t => t.pos.y)]
    const zs = [...starts.map(s => s.z), ...tg.map(t => t.pos.z)]
    const box = { x0: Math.min(...xs) - 14, x1: Math.max(...xs) + 14, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 12), z0: Math.min(...zs) - 14, z1: Math.max(...zs) + 14 }
    const t0 = Date.now()
    const planO = {
      cls: view.cls, dig: view.dig, own: S.own, starts, box, maxNodes: inTunnel ? 60000 : 160000,
      goal: (x, y, z) => tgGoals.some(q => q.g(x, y, z)),
      h: (x, y, z) => Math.min(...tgGoals.map(q => q.h(x, y, z))),
      targets: new Set(tg.filter(t => !t.chest).map(t => t.k)), vup: SL.fillerCount(bot) >= 6
    }
    let r = await SL.plan(planO)
    // Вход из открытой пещеры: первая клетка в толще почти всегда касается воздуха пещеры сбоку (неровная стена), и
    // «снаружи» нет ни одного хода (neF-map26-2 02.10: starts 40, nodes 40, foreign 559 — бастион units в 33 бл.).
    // Второй план: вскрытие разрешено только у клеток в 2 бл. от стартовых (вход), дальше — закрыто; execute
    // засыпает клетки за спиной (sealBehind), пока штрек открыт.
    // То же у цели: золото моста и двора лежит в открытом (neF-basm24-2 02.10, мост: из своего штрека «пути нет» к 23
    // целям, foreign 41 тыс.) — вскрытие разрешено в 2 бл. от цели (как сама клетка золота: sealedGold её заделывает).
    let entryBreach = null
    // ND_ANGER_SAFE=1: золото сломано меньше 30 с назад (злость пиглинов — 600 тиков), злые в 16 — не вскрывать ход во двор,
    // а переждать заложившись (D7s9c-31 03.10: золото в закрытом ходе, следом «вход со вскрытием» — пиглины, смерть).
    if (!r.ok && st.breach && process.env.ND_ANGER_SAFE === '1' && st.lastBreak && Date.now() - st.lastBreak < 30000 && angerSet(bot, null, false).length) {
      log('штрек: злость после золота — вскрытие подожду', { s: Math.round((Date.now() - st.lastBreak) / 1000), n: angerSet(bot, null, false).length })
      await sealBody(bot, S).catch(() => null)
      while (!ctl.aborted && Date.now() - st.lastBreak < 31000) await sleep(500)
    }
    if (!r.ok && st.breach && (starts.length || tg.length)) {
      const near = new Set()
      const around = (p, dyLo, dyHi) => { for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.abs(dx) + Math.abs(dz) <= 2) for (let dy = dyLo; dy <= dyHi; dy++) near.add(SL.key(p.x + dx, p.y + dy, p.z + dz)) }
      if (!inTunnel) for (const st0 of starts.slice().sort((a, b) => a.g - b.g).slice(0, 300)) around(st0, -1, 3)
      for (const t of tg) if (!t.chest) around(t.pos, -2, 2)
      entryBreach = ck => near.has(ck)
      const r2 = await SL.plan({ ...planO, breachOk: (ck) => entryBreach(ck), breachCost: 8 })
      log('штрек: вход из открытого со вскрытием', { ok: r2.ok, nodes: r2.nodes, why: r2.ok ? undefined : r2.why, starts: starts.length, from: inTunnel ? 'штрек' : 'снаружи' })
      if (r2.ok) r = r2
      else entryBreach = null
    }
    S.plans++
    S.planMs += Date.now() - t0
    // Снаружи пути нет (все входы касаются чужого воздуха) — закопаться и планировать из своего кармана.
    if (!r.ok && !inTunnel && (st.burrowsSG || 0) < 2 && process.env.ND_BURROW !== '0') {
      st.burrowsSG = (st.burrowsSG || 0) + 1
      const bw = await burrow(session, ctl, st, 'штрек к золоту снаружи не начался')
      if (bw.ok) { S.exposed = SL.exposure(bot, S.own).length > 0; continue }
      log('закопаться не вышло', { why: bw.why })
    }
    if (!r.ok) {
      log('штрек: пути нет', { targets: tg.length, rank: minRank, nodes: r.nodes, why: r.why, from: inTunnel ? 'штрек' : 'снаружи', ms: Date.now() - t0 })
      // Нет пути ни к одной цели этого ранга — отложить их; из штрека попробовать снаружи.
      for (const t of tg) st.skip.set(t.k, Date.now() + 10 * 60000)
      if (++noPlan >= 3) break
      continue
    }
    log('штрек: план', { from: r.start, moves: r.path.length, dig: r.path.reduce((n, m) => n + m.clear.length, 0), cost: Math.round(r.cost), nodes: r.nodes, ms: Date.now() - t0 })
    // Вход из открытого — сперва дойти ногами (без копки) до клетки входа.
    if (!inTunnel && !(me.x === r.start.x && me.y === r.start.y && me.z === r.start.z)) {
      S.walks++
      // Пол Ада для pathfinder (worlds: не ниже min(40, где стоишь)) — опустить до входа, иначе «пустой путь».
      const floor0 = bot._ndNetherFloor
      bot._ndNetherFloor = Math.min(floor0 ?? 40, r.start.y - 2)
      let w
      try { w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(r.start.x, r.start.y, r.start.z), 30000, { dig: false }) } finally { bot._ndNetherFloor = floor0 }
      const f = bot.entity.position.floored()
      if (!(f.x === r.start.x && f.y === r.start.y && f.z === r.start.z)) {
        // Этот вход ногами не взять — в следующих планах его нет (sealed booth-1: 15 раз «пустой путь» к одной клетке).
        (S.badStarts || (S.badStarts = new Set())).add(SL.key(r.start.x, r.start.y, r.start.z))
        S.fails.push(`ко входу: ${(w && w.error) || 'не дошёл'}`); if (S.fails.length > 14) break
        // Пешком не выйти ни к одной клетке входа (тело в яме после спуска со столба, у злых пиглинов
        // обход мобов не даёт пути: pit-v3-12 30.09 — 15 раз «пустой путь», золота 0) — штрек отсюда:
        // клетки тела — свои, открытость отмечена (execute закладывает за собой).
        S.walkFails = (S.walkFails || 0) + 1
        if (S.walkFails >= 2) { for (const v of [f, f.offset(0, 1, 0)]) S.own.add(SL.keyV(v)); S.exposed = true }
        continue
      }
      S.exposed = true
    }
    if (!inTunnel) S.entry = { x: r.start.x, y: r.start.y, z: r.start.z }
    const prevBreach = S.breachOk
    if (entryBreach) S.breachOk = (k, nk) => entryBreach(k) || !!(prevBreach && prevBreach(k, nk))
    let ex
    try { ex = await SL.execute(session, ctl, r.path, S) } finally { if (entryBreach) S.breachOk = prevBreach }
    if (!ex.ok) {
      S.fails.push(ex.why)
      log('штрек: стоп', { why: ex.why, done: ex.done, of: r.path.length, at: xyz(bot.entity.position.floored()) })
      if (S.fails.length > 14) break
      continue
    }
    const f = bot.entity.position.floored()
    const hit = tgGoals.find(q => q.g(f.x, f.y, f.z))
    if (!hit) continue
    const t = hit.t
    if (t.chest) {
      // Сундук из штрека: нас не видит никто — открыть не злит (ChestBlock: злит видящих).
      let took = null
      try { took = await require('./structures').takeWorth(session, ctl, t.pos, { kind: 'bastion' }) } catch (e) { took = { error: e.message } }
      st.looted.add(t.k)
      st.chests.push({ at: t.k, took: (took && took.took) || {}, stopped: took && (took.stopped || took.error) })
      log('штрек: сундук', { at: t.k, took: took && took.took, stopped: took && (took.stopped || took.error) })
      continue
    }
    const b = bot.blockAt(t.pos)
    // Штрек прошёл сквозь цель (золото взято по пути) — не промах.
    if (b && b.boundingBox === 'empty' && S.own.has(t.k)) { st.pred.delete(t.k); continue }
    if (!b || b.name !== 'gold_block') {
      // Стоим вплотную и видим: не золото — промах гипотезы этого ранга.
      const rank = (st.pred.get(t.k) || {}).rank
      st.pred.delete(t.k)
      st.predWrong = (st.predWrong || 0) + 1
      if (b && b.boundingBox === 'block') {
        st.rankMiss = st.rankMiss || {}
        st.rankMiss[rank] = (st.rankMiss[rank] || 0) + 1
        if (st.rankMiss[rank] >= 2) for (const [k, v] of [...st.pred.entries()]) if (v.rank === rank || (rank >= 100 && rank % 100 === 0 && Math.floor((v.rank || 0) / 100) === rank / 100)) st.pred.delete(k)
      }
      log('штрек: не золото', { at: t.k, block: b ? b.name : '?', rank })
      continue
    }
    // Ломка золота на глазах у пиглина злит всех в 16 бл. (PiglinAi.angerNearbyPiglins с проверкой луча) — штрек открыт
    // (вскрытие у цели/входа, золото у двора): видят — не ломать сейчас, цель отложить (neF-mB23-1 02.10: 12 блоков
    // при exposed:true, затем арбалеты злых пиглинов, «shot by Piglin»; neF-map23-3 — то же мечами).
    const opens = goldExposes(bot, S, t.pos)
    // Ломка gold_block: requireLineOfSight=false. До изоляции мобов не вскрываем двор,
    // даже если сейчас их закрывает само золото. Без LOS-фильтра, с запасом на движение.
    // Окно 1×1: над и под клеткой золота — полные чужие блоки (не наш ход): взрослый моб (1.95 высоты) в пролом не
    // войдёт, удар через клетку не достаёт (1.43 по оси), заплатка — сразу. Тогда злость обычных пиглинов не страшна;
    // нельзя только при брутах/хоглинах в 12 бл. и хп < 16. Без этого строгий режим не брал золото вовсе: 10–14 мобов в
    // 18 бл. у любого золота двора (neF-Sb24/Sb25/Sc21 02.10 — 0–5 блоков).
    const upC = t.pos.offset(0, 1, 0); const dnC = t.pos.offset(0, -1, 0)
    const win1 = fullCover(bot.blockAt(upC)) && !S.own.has(SL.keyV(upC)) && fullCover(bot.blockAt(dnC)) && !S.own.has(SL.keyV(dnC))
    const strongNear = [...mobs(bot, 'piglin_brute', 12), ...mobs(bot, 'hoglin', 12), ...mobs(bot, 'zoglin', 12)]
    const windowOk = win1 && !strongNear.length && (bot.health ?? 20) >= 16
    const exposedFoes = st.fastSafe && opens && !windowOk ? [
      ...mobs(bot, 'piglin', 18).filter(e => !isBaby(bot, e)),
      ...mobs(bot, 'piglin_brute', 18), ...mobs(bot, 'hoglin', 18), ...mobs(bot, 'zoglin', 18)
    ] : []
    if (st.fastSafe && opens && windowOk) log('штрек: золото окном 1×1 — ломаю и сразу заделываю', { at: t.k, piglins: mobs(bot, 'piglin', 18).length })
    if (exposedFoes.length || (st.fastSafe && opens && SL.fillerCount(bot) < 3)) {
      st.skip.set(t.k, Date.now() + 600000)
      log('штрек: небезопасное вскрытие — пропустил', { at: t.k, foes: exposedFoes.length })
      continue
    }
    // ND_ANGER_SAFE=1: свой ход сам открыт во двор (вход «из открытого со вскрытием»), а ломка злит всех пиглинов в 16
    // (angerSet) — сперва заложиться, не вышло — не ломать (D7c-25 03.10: золото при exposed true и 9 пиглинах рядом —
    // 4 удара за 2 с, смерть на 3-й мин).
    if (process.env.ND_ANGER_SAFE === '1' && SL.exposure(bot, S.own).length && angerSet(bot, null, true).length) {
      await sealBody(bot, S).catch(() => null)
      S.exposed = SL.exposure(bot, S.own).length > 0
      if (S.exposed) {
        st.skip.set(t.k, Date.now() + 60000)
        log('штрек: ход открыт, пиглины в 16 — золото отложил', { at: t.k, n: angerSet(bot, null, true).length })
        continue
      }
    }
    const watchers = st.fastSafe ? [] : mobs(bot, 'piglin', 16).filter(p => seesMob(bot, p))
    if (watchers.length) { st.skip.set(t.k, Date.now() + 20000); log('штрек: золото — видят пиглины, отложил', { at: t.k, n: watchers.length, exposed: S.exposed }); await sleep(500); continue }
    // Ломка вскроет штрек во двор, а брут рядом (сквозь стены он не видит — но пролом увидит): отложить (neF-Pa22-1).
    // Только бруты, которые ВИДЯТ клетку золота (луч от глаз брута до неё): после ломки они смотрят в пролом. Брут за
    // стенами пролома не увидит — ломать и сразу заделать (Q24 02.10: 4 брута в 16 бл. за стенами — «отложил» по кругу).
    const brutes = mobs(bot, 'piglin_brute', 16).filter(e => raySees(bot, e.position.offset(0, (e.height || 1.95) * 0.92, 0), t.pos.offset(0.5, 0.5, 0.5)))
    if (brutes.length && goldExposes(bot, S, t.pos)) { st.skip.set(t.k, Date.now() + 30000); log('штрек: золото у двора, брут рядом — отложил', { at: t.k, n: brutes.length, d: Math.round(Math.min(...brutes.map(e => e.position.distanceTo(t.pos)))) }); await sleep(500); continue }
    const had = countOf(bot, 'gold_block')
    bot.setControlState('sneak', true)
    let dr
    try { dr = await SL.digCell(bot, t.pos, { allowGuard: true }) } finally { bot.setControlState('sneak', false) }
    if (dr !== 'ok') { st.skip.set(t.k, Date.now() + 60000); log('штрек: золото не ломается', { at: t.k, r: dr }); continue }
    S.own.add(t.k)
    st.pred.delete(t.k)
    st.blocks++
    st.lastBreak = Date.now()
    // Гипотеза подтверждена (3 золота на местах шаблона) — соседние гипотезы
    // других рангов (та же стена со сдвигом на блок) снять.
    const rk = hit.rank ?? 0
    st.rankHit = st.rankHit || {}
    st.rankHit[rk] = (st.rankHit[rk] || 0) + 1
    if (st.rankHit[rk] >= 3) {
      const mine = [...(st.predAll || [])].filter(q => q.rank === rk)
      for (const [k, v] of [...st.pred.entries()]) if (v.rank !== rk && mine.some(q => q.pos.distanceTo(v.pos) <= 2.5)) st.pred.delete(k)
    }
    // До ожидания подбора закрыть отверстие. PickUp с pathfinder здесь не нужен.
    if (st.fastSafe && opens) {
      const closed = await SL.fillCell(bot, t.pos)
      if (!closed || !fullCover(bot.blockAt(t.pos))) {
        await hunker(session, ctl, st, 'золото: заплатка не встала')
        S.fails.push('золото: заплатка не встала'); break
      }
      S.own.delete(t.k); S.fills++; (S.filled || (S.filled = new Set())).add(t.k)
      S.exposed = SL.exposure(bot, S.own).length > 0
    }
    for (let i = 0; i < 15 && countOf(bot, 'gold_block') <= had; i++) await sleep(100)
    if (countOf(bot, 'gold_block') <= had && !st.fastSafe) await pickUp(bot, ctl, 3, 2500)
    // Золото касалось чужого воздуха — закрыть его клетку.
    if (SL.exposure(bot, S.own).length) {
      if (await SL.fillCell(bot, t.pos)) { S.own.delete(t.k); S.fills++; (S.filled || (S.filled = new Set())).add(t.k) }
      S.exposed = SL.exposure(bot, S.own).length > 0
    }
    log('штрек: золото', { at: t.k, blocks: countOf(bot, 'gold_block'), left: st.pred.size, hp: Math.round(bot.health ?? 0), exposed: S.exposed })
  }
  st.blocks += S.goldPassed + S.bonusBlocks
  S.goldPassed = 0
  S.bonusBlocks = 0
  return S
}

// ------------------------------------------------------------------ окно бартера
//
// Торговое окно (вместо ямы спидраннеров): тело в своём штреке на уровне пола
// пиглинов, между нами и ними один блок стены C, над ним окно W 1×1 на высоте
// головы (C+1), над окном и по бокам — твёрдое. Пиглин, брут, хоглин (все
// выше блока) в окно не пролезут; их удар не достаёт: центры не ближе 1.6
// блока, а рамка удара — 1.43 (Mob.getAttackBoundingBox: 0.3 + 0.828, и наши
// 0.3). Луч глаз в глаз (1.79 и 1.62 над полом) идёт сквозь окно — пиглин нас
// видит (NEAREST_VISIBLE_PLAYER) и бросает добычу к нам: BehaviorUtils.throwItem
// целит в наши ноги + 1 из своих глаз − 0.3 со скоростью 0.3 — от пиглина в 2–3
// блоках предмет влетает в окно и падает у нас (расчёт полёта, 29.09). В яме
// на 2 ниже пола (ферма pit-1: 97 слитков из рук, жемчуг 0) добыча ложилась
// снаружи, дальше досягаемости подбора.
// Брут у окна нас не достаёт, а мы его — мечом сквозь окно (досягаемость 3).
const SIDES4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// Типы урона в пакете damage_event — номер в реестре 1.21.11 (как dragon.js DAMAGE_TYPES).
const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out',
  'ender_pearl', 'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks',
  'fly_into_wall', 'freeze', 'generic', 'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava',
  'lightning_bolt', 'mace_smash', 'magic', 'mob_attack', 'mob_attack_no_aggro', 'mob_projectile', 'on_fire',
  'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom', 'spear', 'spit', 'stalagmite',
  'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']
function boothAt (view, own, O, d) {
  const SL = require('./sealed')
  const c = (x, y, z) => view.cls(x, y, z)
  const stand = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD || k === SL.FALL
  const firm = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD
  if (c(O.x, O.y, O.z) !== SL.AIR || c(O.x, O.y + 1, O.z) !== SL.AIR || !stand(c(O.x, O.y - 1, O.z))) return null
  const C = { x: O.x - d[0], y: O.y, z: O.z - d[1] }
  const W = { x: C.x, y: C.y + 1, z: C.z }
  const F = { x: O.x - 2 * d[0], y: O.y, z: O.z - 2 * d[1] }
  if (!firm(c(C.x, C.y, C.z))) return null
  if (c(W.x, W.y, W.z) !== SL.SOLID) return null
  if (!firm(c(W.x, W.y + 1, W.z))) return null
  const px = d[1]; const pz = d[0]
  if (!firm(c(W.x + px, W.y, W.z + pz)) || !firm(c(W.x - px, W.y, W.z - pz))) return null
  const cellOk = (x, y, z) => { const k = c(x, y, z); return k === SL.SOLID || (k === SL.AIR && own.has(SL.key(x, y, z))) }
  if (!cellOk(F.x, F.y, F.z) || !cellOk(F.x, F.y + 1, F.z)) return null
  if (!stand(c(F.x, F.y - 1, F.z))) return null
  // Широкое окно: ещё по клетке окна слева и справа (W±p) и ниши на высоте головы (F+1±p) —
  // пиглин сбоку тоже видит нас и добыча от него влетает (booth-2: окно 1×1 ловило
  // только пиглина прямо напротив, у остальных добыча ложилась снаружи). Всё высотой в
  // блок: ни один моб не войдёт, а их удар не достаёт (по оси d центры не ближе 1.6).
  const wide = [1, -1].every(sg => {
    const q = (base, k = 1) => ({ x: base.x + sg * px * k, y: base.y, z: base.z + sg * pz * k })
    const Cs = q(C); const Ws = q(W); const Hs = q({ x: F.x, y: F.y + 1, z: F.z })
    return firm(c(Cs.x, Cs.y, Cs.z)) && c(Ws.x, Ws.y, Ws.z) === SL.SOLID && firm(c(Ws.x, Ws.y + 1, Ws.z)) &&
      firm(c(W.x + sg * px * 2, W.y, W.z + sg * pz * 2)) &&
      cellOk(Hs.x, Hs.y, Hs.z) && firm(c(Hs.x, Hs.y - 1, Hs.z)) && firm(c(Hs.x, Hs.y + 1, Hs.z)) &&
      firm(c(F.x + sg * px * 2, F.y + 1, F.z + sg * pz * 2)) && firm(c(Hs.x - d[0], Hs.y, Hs.z - d[1]))
  })
  return { O, C, W, F, d, p: [px, pz], wide }
}

// Места окна: пол рядом со взрослыми пиглинами (не брутами), стена в блок.
function boothCandidates (bot, view, own, radius = 40) {
  const me = bot.entity.position
  const pigs = mobs(bot, 'piglin', radius).filter(e => !isBaby(bot, e))
  const seen = new Set()
  const out = []
  for (const pg of pigs) {
    const p = pg.position.floored()
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = 0; dy <= 0; dy++) {
          const O = { x: p.x + dx, y: p.y + dy, z: p.z + dz }
          for (const d of SIDES4) {
            const k = `${O.x},${O.y},${O.z}|${d}`
            if (seen.has(k)) continue
            seen.add(k)
            const b = boothAt(view, own, O, d)
            if (!b) continue
            const center = new Vec3(O.x + 0.5, O.y, O.z + 0.5)
            // Пиглины на том же полу, что O: окно на высоте их ног + 1 (booth-1: пол комнаты на блок выше O — добыча била в стену над окном).
            b.pigs = pigs.filter(e => e.position.distanceTo(center) <= 7 && Math.abs(e.position.y - O.y) < 0.6).length
            b.brutes = mobs(bot, 'piglin_brute', 7, center).length
            b.d0 = center.distanceTo(me)
            out.push(b)
          }
        }
      }
    }
  }
  return out.filter(b => b.pigs >= 2).sort((a, b) => (Number(b.wide) - Number(a.wide)) || (b.pigs - a.pigs) || (a.d0 - b.d0))
}

const lastGoldBreak = st => Math.max(st.lastBreak || 0, (st.sealedState && st.sealedState.lastBreak) || 0)
// Своим штреком к клетке F за стеной, потом вскрыть окно W.
async function digBooth (session, ctl, st, until) {
  const bot = session.bot
  const SL = require('./sealed')
  const S = st.sealedState
  if (!S) return null
  S.deadline = until
  S.noBonus = true // руда золота Ада злит пиглинов — у окна её не трогать
  for (let tries = 0; tries < 3 && !ctl.aborted && Date.now() < until - 20000; tries++) {
    const view = SL.worldView(bot)
    const cands = boothCandidates(bot, view, S.own).slice(0, 16)
    if (!cands.length) { log('окно: места у пиглинов нет', { pigs: mobs(bot, 'piglin', 40).length }); return null }
    const me = bot.entity.position.floored()
    const goalMap = new Map(cands.map(b => [SL.key(b.F.x, b.F.y, b.F.z), b]))
    const xs = [me.x, ...cands.map(b => b.F.x)]; const ys = [me.y, ...cands.map(b => b.F.y)]; const zs = [me.z, ...cands.map(b => b.F.z)]
    const box = { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 8), z0: Math.min(...zs) - 10, z1: Math.max(...zs) + 10 }
    const hs = cands.map(b => b.F)
    const r = await SL.plan({
      cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 80000, vup: SL.fillerCount(bot) >= 6, breachOk: tradeBreach(S),
      starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
      goal: (x, y, z) => goalMap.has(SL.key(x, y, z)),
      h: (x, y, z) => Math.min(...hs.map(t => Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z)))
    })
    if (!r.ok) { log('окно: пути нет', { cands: cands.length, nodes: r.nodes, why: r.why }); return null }
    const last = r.path.length ? r.path[r.path.length - 1].to : me
    const bo = goalMap.get(SL.key(last.x, last.y, last.z))
    log('окно: план', { at: bo.F, window: bo.W, wide: bo.wide, pigs: bo.pigs, brutes: bo.brutes, moves: r.path.length })
    const ex = await tradeExecute(session, ctl, r.path, S)
    if (!ex.ok) { S.fails.push('окно: ' + ex.why); continue }
    // Окно вскрывать, когда злость от золота остыла (600 тиков): злой арбалетчик стреляет в окно.
    for (let w = 0; w < 40 && Date.now() - lastGoldBreak(st) < 33000 && !ctl.aborted; w++) await sleep(1000)
    const Wv = new Vec3(bo.W.x, bo.W.y, bo.W.z)
    if (bo.wide) {
      // Сперва ниши у головы (закрыто), потом боковые окна и среднее.
      const [px, pz] = bo.p
      for (const sg of [1, -1]) { const r0 = await SL.digCell(bot, new Vec3(bo.F.x + sg * px, bo.F.y + 1, bo.F.z + sg * pz)); if (r0 === 'ok' || r0 === 'air') S.own.add(SL.key(bo.F.x + sg * px, bo.F.y + 1, bo.F.z + sg * pz)) }
      for (const sg of [1, -1]) await SL.digCell(bot, Wv.offset(sg * px, 0, sg * pz))
    }
    const dr = await SL.digCell(bot, Wv)
    if (dr !== 'ok' && dr !== 'air') { S.fails.push('окно: ' + dr); continue }
    S.exposed = true
    bo.at = xyz(bot.entity.position.floored())
    return bo
  }
  return null
}

// ------------------------------------------------------------------ яма со ртом
//
// Яма бартера: тело на 2 ниже пола пиглинов, прямо под ртом M — нижним блоком стены
// у их пола (M соседствует с клеткой пола O); над ртом R — стена, крыша. Пиглин (1.95)
// в рот высотой 1 не пролезет и к нам не упадёт; удар не достаёт (рамка удара моба
// растёт только вбок, а мы на 2 ниже). Бросок пиглина целит в наши ноги + 1
// (BehaviorUtils.throwItem) — добыча влетает в рот и падает на нас.
// Опыт в клетке 29.09 (booth-test, 3 пиглина, 96 слитков): яма — в рюкзаке ~97% сделок,
// на земле 0; окно на уровне головы с подоконником — ~40%, остальное снаружи у стены.
// Расчёт полёта (drops.js) объясняет: сквозь окно в стене долетает лишь бросок пиглина
// в 1.8–3.6 блока строго напротив, а в яму — бросок любого, кто нас видит.
function pitAt (view, own, O, d) {
  const SL = require('./sealed')
  const c = (x, y, z) => view.cls(x, y, z)
  const stand = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD || k === SL.FALL
  const firm = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD
  const mineK = (x, y, z) => own.has(SL.key(x, y, z))
  if (c(O.x, O.y, O.z) !== SL.AIR || c(O.x, O.y + 1, O.z) !== SL.AIR || !firm(c(O.x, O.y - 1, O.z))) return null
  const M = { x: O.x - d[0], y: O.y, z: O.z - d[1] }
  const R = { x: M.x, y: M.y + 1, z: M.z }
  const H = { x: M.x, y: M.y - 1, z: M.z }
  const P = { x: M.x, y: M.y - 2, z: M.z }
  if (c(M.x, M.y, M.z) !== SL.SOLID || !firm(c(R.x, R.y, R.z))) return null
  const px = d[1]; const pz = d[0]
  // Рот открыт только к O: по бокам и сзади — твёрдое (или наш штрек).
  for (const [x, y, z] of [[M.x + px, M.y, M.z + pz], [M.x - px, M.y, M.z - pz], [M.x - d[0], M.y, M.z - d[1]]]) {
    if (!firm(c(x, y, z)) && !mineK(x, y, z)) return null
  }
  const cellOk = (x, y, z) => { const k = c(x, y, z); return k === SL.SOLID || (k === SL.AIR && mineK(x, y, z)) }
  if (!cellOk(H.x, H.y, H.z) || !cellOk(P.x, P.y, P.z) || !stand(c(P.x, P.y - 1, P.z))) return null
  // Свалка хлама: столб сбоку — у головы (Dh), у ног (D1) и под ней (D2). Брошенное почти
  // горизонтально влетает в столб на высоте головы, бьётся о дальнюю стенку и падает в D2 —
  // на 1 ниже ног, откуда назад не подбирается (рамка подбора ниже ног — на 0.5). Без Dh
  // бросок в D1 шёл сквозь узкое окно по высоте: pit-ind 29.09 — прицела не нашлось ни разу,
  // хлам не выбрасывался, рюкзак забился, и добыча (с жемчугом) лежала у ног неподобранной.
  // Копать можно, только если вокруг твёрдое или наше (закрытый штрек не вскрывается).
  const sealedOk = (x, y, z, ours) => SL.FACES.every(([fx, fy, fz]) => {
    const k = SL.key(x + fx, y + fy, z + fz)
    if (mineK(x + fx, y + fy, z + fz) || ours.includes(k)) return true
    const n = c(x + fx, y + fy, z + fz)
    return n === SL.SOLID || n === SL.HARD || n === SL.GUARD
  })
  let dump = null
  for (const sg of [1, -1]) {
    const D1 = { x: P.x + sg * px, y: P.y, z: P.z + sg * pz }
    const D2 = { x: D1.x, y: D1.y - 1, z: D1.z }
    const Dh = { x: D1.x, y: D1.y + 1, z: D1.z }
    const cells = [Dh, D1, D2]
    const ours = [SL.key(P.x, P.y, P.z), SL.key(H.x, H.y, H.z), ...cells.map(q => SL.key(q.x, q.y, q.z))]
    if (cells.every(q => cellOk(q.x, q.y, q.z) && sealedOk(q.x, q.y, q.z, ours))) { dump = { Dh, D1, D2 }; break }
  }
  return { kind: 'pit', O, M, R, H, P, d, p: [px, pz], dump, F: P, W: M, C: H, sill: true }
}

function pitCandidates (bot, view, own, radius = 40) {
  const me = bot.entity.position
  const pigs = mobs(bot, 'piglin', radius).filter(e => !isBaby(bot, e))
  const seen = new Set()
  const out = []
  for (const pg of pigs) {
    const p = pg.position.floored()
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const O = { x: p.x + dx, y: p.y, z: p.z + dz }
        for (const d of SIDES4) {
          const k = `${O.x},${O.y},${O.z}|${d}`
          if (seen.has(k)) continue
          seen.add(k)
          const b = pitAt(view, own, O, d)
          if (!b) continue
          const center = new Vec3(O.x + 0.5, O.y, O.z + 0.5)
          b.pigs = pigs.filter(e => e.position.distanceTo(center) <= 7 && Math.abs(e.position.y - O.y) < 0.6).length
          b.brutes = mobs(bot, 'piglin_brute', 7, center).length
          b.d0 = center.distanceTo(me)
          out.push(b)
        }
      }
    }
  }
  const pre = out.filter(b => b.pigs >= (BF.enabled() ? 1 : 2) && (!BF.enabled() || !b.brutes)).sort((a, b) => (Number(!!b.dump) - Number(!!a.dump)) || (b.pigs - a.pigs) || (a.d0 - b.d0)).slice(0, 24)
  // Место улова: сколько клеток пола у рта, откуда пиглин нас видит, до него дотянемся, и его
  // бросок (расчёт полёта) ляжет к нам. pit-real 29.09: рот у тесной лестницы — 70–89% добычи.
  for (const b of pre) b.catch = catchScore(bot, b)
  return pre.filter(b => b.catch >= 2).sort((a, b) => (Number(!!b.dump) - Number(!!a.dump)) || (b.catch - a.catch) || (b.pigs - a.pigs) || (a.d0 - b.d0))
}

// Луч без блоков (формы коллизии) — шагом 0.05.
function rayClear (getBlock, a, b) {
  const n = Math.ceil(a.distanceTo(b) / 0.05)
  for (let i = 1; i < n; i++) {
    const t = i / n
    const x = a.x + (b.x - a.x) * t; const y = a.y + (b.y - a.y) * t; const z = a.z + (b.z - a.z) * t
    const bl = getBlock(Math.floor(x), Math.floor(y), Math.floor(z))
    if (!bl) return false
    for (const sh of bl.shapes || []) {
      const lx = x - Math.floor(x); const ly = y - Math.floor(y); const lz = z - Math.floor(z)
      if (lx > sh[0] && lx < sh[3] && ly > sh[1] && ly < sh[4] && lz > sh[2] && lz < sh[5]) return false
    }
  }
  return true
}

function catchScore (bot, bo) {
  const base = require('./drops').blockGetter(bot)
  const openK = new Set([bo.M, bo.H, bo.P].map(c => `${c.x},${c.y},${c.z}`))
  const AIRB = { name: 'air', shapes: [], boundingBox: 'empty' }
  const getBlock = (x, y, z) => openK.has(`${x},${y},${z}`) ? AIRB : base(x, y, z)
  const feet = new Vec3(bo.P.x + 0.5, bo.P.y, bo.P.z + 0.5)
  const eye = feet.offset(0, 1.62, 0)
  const empty = q => q && q.boundingBox === 'empty' && !/lava|water|fire/.test(q.name)
  let n = 0
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const x = bo.M.x + dx; const z = bo.M.z + dz; const y = bo.M.y
      if (openK.has(`${x},${y},${z}`) || Math.hypot(dx, dz) > 3.2) continue
      const f = getBlock(x, y - 1, z)
      if (!empty(getBlock(x, y, z)) || !empty(getBlock(x, y + 1, z)) || !f || f.boundingBox !== 'block') continue
      const from = new Vec3(x + 0.5, y, z + 0.5)
      if (!rayClear(getBlock, from.offset(0, PIGLIN_EYE, 0), eye)) continue
      if (throwLands(bot, from, feet, getBlock).ok) n++
    }
  }
  return n
}

// ------------------------------------------------------------------ ловушка торговцев
//
// Камера-ловушка (B5, «containment» спидраннеров): перед ртом — яма в полу пиглинов глубиной 2
// (клетки C0 — ноги пиглина, C1 — над ней, вровень с полом; вторая клетка C2 — дальше по d).
// Пиглин, пошедший за брошенным слитком, спрыгивает в неё и выбраться не может (прыжок < 2).
// Рот M — на уровне пола камеры (C0 − d), над ним R — блок пола пиглинов, он остаётся: в рот
// высотой 1 никто не пролезет. Тело на 2 ниже пола камеры (ноги Y0 − 4): удар не достаёт (рамка
// удара моба растёт только вбок). Расчёт (trapsim 30.09): из C0 и C2 пиглин видит нас и его бросок
// долетает в 100% точек клетки; боковые клетки — нет (закрыты боками рта), их не копаем.
function trapAt (view, own, O, d) {
  const SL = require('./sealed')
  const c = (x, y, z) => view.cls(x, y, z)
  const stand = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD || k === SL.FALL
  const firm = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD
  const mineK = (x, y, z) => own.has(SL.key(x, y, z))
  const solidDig = (x, y, z) => c(x, y, z) === SL.SOLID && !mineK(x, y, z)
  const cellOk = (x, y, z) => { const k = c(x, y, z); return k === SL.SOLID || (k === SL.AIR && mineK(x, y, z)) }
  // O — клетка пола пиглинов (их ноги), под ней будет камера.
  if (c(O.x, O.y, O.z) !== SL.AIR || c(O.x, O.y + 1, O.z) !== SL.AIR) return null
  const px = d[1]; const pz = d[0]
  const cell = (b, k = 1) => ({ x: b.x + d[0] * k, y: b.y, z: b.z + d[1] * k })
  const up = (b, k = 1) => ({ x: b.x, y: b.y + k, z: b.z })
  // Камера в клетке q (ноги пиглина q.y = O.y − 2): оба блока копаются, пол держит, бока твёрдые.
  const roomOk = q => {
    const q1 = up(q)
    if (!solidDig(q.x, q.y, q.z) || !solidDig(q1.x, q1.y, q1.z) || !stand(c(q.x, q.y - 1, q.z))) return false
    for (const [sx, sz] of [[px, pz], [-px, -pz]]) for (const y of [q.y, q1.y]) if (!firm(c(q.x + sx, y, q.z + sz))) return false
    return true
  }
  const C0 = { x: O.x, y: O.y - 2, z: O.z }
  if (!roomOk(C0)) return null
  const M = cell(C0, -1)
  const R = up(M)
  const H = up(M, -1)
  const P = up(M, -2)
  if (!solidDig(M.x, M.y, M.z) || !firm(c(R.x, R.y, R.z))) return null
  for (const [x, y, z] of [[M.x + px, M.y, M.z + pz], [M.x - px, M.y, M.z - pz]]) if (!firm(c(x, y, z)) && !mineK(x, y, z)) return null
  // Строим, стоя ногами в H (голова в M): P под ногами — твёрдый, его копаем последним и падаем
  // в него. Грани P — наше или твёрдое (закрытый штрек не вскрывается), под P — опора.
  if (!cellOk(H.x, H.y, H.z) || !solidDig(P.x, P.y, P.z) || !stand(c(P.x, P.y - 1, P.z))) return null
  for (const [x, y, z] of [[P.x + px, P.y, P.z + pz], [P.x - px, P.y, P.z - pz], [P.x + d[0], P.y, P.z + d[1]], [P.x - d[0], P.y, P.z - d[1]]]) if (!firm(c(x, y, z)) && !mineK(x, y, z)) return null
  // Дальняя клетка C2 — вторая камера (торговец за слитком прыгает туда: она дальше нашей рамки).
  const C2c = cell(C0)
  const O2 = cell(O)
  const C2 = (c(O2.x, O2.y, O2.z) === SL.AIR && c(O2.x, O2.y + 1, O2.z) === SL.AIR && roomOk(C2c) &&
    firm(c(C2c.x + d[0], C2c.y, C2c.z + d[1])) && firm(c(C2c.x + d[0], C2c.y + 1, C2c.z + d[1]))) ? C2c : null
  // Без C2 задняя стенка C0 должна быть твёрдой (иначе камера открыта вбок, пиглин уйдёт).
  if (!C2 && (!firm(c(C0.x + d[0], C0.y, C0.z + d[1])) || !firm(c(C0.x + d[0], C0.y + 1, C0.z + d[1])))) return null
  // Свалка — как у ямы: столб сбоку от тела.
  const sealedOk = (x, y, z, ours) => SL.FACES.every(([fx, fy, fz]) => {
    const k = SL.key(x + fx, y + fy, z + fz)
    if (mineK(x + fx, y + fy, z + fz) || ours.includes(k)) return true
    const n = c(x + fx, y + fy, z + fz)
    return n === SL.SOLID || n === SL.HARD || n === SL.GUARD
  })
  let dump = null
  for (const sg of [1, -1]) {
    const D1 = { x: P.x + sg * px, y: P.y, z: P.z + sg * pz }
    const cells = [up(D1), D1, up(D1, -1)]
    const ours = [SL.key(P.x, P.y, P.z), SL.key(H.x, H.y, H.z), ...cells.map(q => SL.key(q.x, q.y, q.z))]
    if (cells.every(q => cellOk(q.x, q.y, q.z) && sealedOk(q.x, q.y, q.z, ours))) { dump = { Dh: cells[0], D1, D2: cells[2] }; break }
  }
  return { kind: 'trap', O: C0, C0, C1: up(C0), C2, M, R, H, P, d, p: [px, pz], dump, F: P, W: M, C: H, sill: true }
}

function trapCandidates (bot, view, own, radius = 40) {
  const me = bot.entity.position
  const pigs = mobs(bot, 'piglin', radius).filter(e => !isBaby(bot, e))
  const seen = new Set()
  const out = []
  for (const pg of pigs) {
    const p = pg.position.floored()
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const O = { x: p.x + dx, y: p.y, z: p.z + dz }
        for (const d of SIDES4) {
          const k = O.x + ',' + O.y + ',' + O.z + '|' + d
          if (seen.has(k)) continue
          seen.add(k)
          const b = trapAt(view, own, O, d)
          if (!b) continue
          const center = new Vec3(O.x + 0.5, O.y, O.z + 0.5)
          b.pigs = pigs.filter(e => e.position.distanceTo(center) <= 10 && Math.abs(e.position.y - O.y) < 0.6).length
          b.brutes = mobs(bot, 'piglin_brute', 8, center).length
          b.d0 = center.distanceTo(me)
          out.push(b)
        }
      }
    }
  }
  return out.filter(b => b.pigs >= 1).sort((a, b) => (Number(!!b.C2) - Number(!!a.C2)) || (Number(!!b.dump) - Number(!!a.dump)) || (a.brutes - b.brutes) || (b.pigs - a.pigs) || (a.d0 - b.d0))
}

// Своим штреком к ногам P под ртом ловушки, свалка, центр клетки; потом рот и камера сквозь рот.
async function digTrap (session, ctl, st, until) {
  const bot = session.bot
  const SL = require('./sealed')
  const S = st.sealedState
  if (!S) return null
  S.deadline = until
  S.noBonus = true
  for (let tries = 0; tries < 3 && !ctl.aborted && Date.now() < until - 20000; tries++) {
    const view = SL.worldView(bot)
    const cands = trapCandidates(bot, view, S.own).slice(0, 16)
    if (!cands.length) { log('ловушка: места нет', { pigs: mobs(bot, 'piglin', 40).length }); return null }
    const me = bot.entity.position.floored()
    // Цель пути — ноги в H (голова в клетке рта M): отсюда видно камеру и можно бросить приманку.
    const goalMap = new Map(cands.map(b => [SL.key(b.H.x, b.H.y, b.H.z), b]))
    const xs = [me.x, ...cands.map(b => b.H.x)]; const ys = [me.y, ...cands.map(b => b.H.y)]; const zs = [me.z, ...cands.map(b => b.H.z)]
    const box = { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 8), z0: Math.min(...zs) - 10, z1: Math.max(...zs) + 10 }
    const hs = cands.map(b => b.H)
    const r = await SL.plan({
      cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 80000, vup: SL.fillerCount(bot) >= 6,
      starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
      goal: (x, y, z) => goalMap.has(SL.key(x, y, z)),
      h: (x, y, z) => Math.min(...hs.map(t => Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z)))
    })
    if (!r.ok) { log('ловушка: пути нет', { cands: cands.length, nodes: r.nodes, why: r.why }); return null }
    const last = r.path.length ? r.path[r.path.length - 1].to : me
    const bo = goalMap.get(SL.key(last.x, last.y, last.z))
    log('ловушка: план', { feet: bo.P, mouth: bo.M, room: bo.C0, room2: bo.C2, dump: !!bo.dump, pigs: bo.pigs, brutes: bo.brutes, moves: r.path.length })
    st.doing = 'ловушка: путь'
    const ex = await SL.execute(session, ctl, r.path, S)
    if (!ex.ok) { S.fails.push('ловушка: ' + ex.why); continue }
    const built = await buildTrap(session, ctl, st, bo, S)
    if (!built) continue
    return built
  }
  return null
}

// Постройка ловушки, стоя ногами в H (голова в клетке рта M): камера C0/C2, приманка в C2,
// вскрыть C1, выкопать P под собой и упасть в него, свалка. S — состояние штрека (own, fails).
async function buildTrap (session, ctl, st, bo, S) {
  const bot = session.bot
  const SL = require('./sealed')
  const step = what => {
    const f = bot.entity.position
    const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
    log('ловушка: шаг', { what, hp: Math.round(bot.health ?? 0), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], under: nm(f.offset(0, -0.5, 0)) })
  }
  step('дошёл')
  if (!(await centerIn(bot, bo.H))) { S.fails.push('ловушка: не встал в центр'); step('не в центре'); return null }
  st.doing = 'ловушка: жду злость'
  for (let w = 0; w < 40 && Date.now() - lastGoldBreak(st) < 33000 && !ctl.aborted; w++) await sleep(1000)
  // Камера, пока всё закрыто (над ней ещё пол пиглинов): низ C0, дальняя C2.
  st.doing = 'ловушка: камера'
  let bad = null
  const dig = async q => { const dr = await SL.digCell(bot, new Vec3(q.x, q.y, q.z)); if (dr !== 'ok' && dr !== 'air') bad = q.x + ',' + q.y + ',' + q.z + ': ' + dr; return !bad }
  if (!(await dig(bo.C0))) { S.fails.push('ловушка: ' + bad); return null }
  if (bo.C2 && !(await dig(bo.C2))) { bo.C2 = null; bad = null }
  // Вскрыть: сперва дальнюю (C2 над ней), приманку туда, потом ближнюю (C1) — и сразу вниз: пиглин
  // в C0 рядом с нашей головой, пока мы стоим в H, достал бы ударом.
  st.doing = 'ловушка: вскрыть'
  if (bo.C2 && !(await dig({ x: bo.C2.x, y: bo.C2.y + 1, z: bo.C2.z }))) { bo.C2 = null; bad = null }
  const aim = bo.C2 && countOf(bot, 'gold_ingot') > 0 ? baitAim(bot, bo) : null
  if (aim) {
    try { await bot.lookAt(aim, true); await sleep(80); await bot.toss(bot.registry.itemsByName.gold_ingot.id, null, 1); bo.baited = 1 } catch {}
  }
  if (!(await dig(bo.C1))) { S.fails.push('ловушка: ' + bad); return null }
  // Вниз: копаем P под ногами и падаем в него — теперь на 2 ниже пола камеры.
  st.doing = 'ловушка: вниз'
  if (!(await dig(bo.P))) { S.fails.push('ловушка: ' + bad); return null }
  S.own.add(SL.key(bo.P.x, bo.P.y, bo.P.z))
  for (let i = 0; i < 20 && bot.entity.position.y > bo.P.y + 0.1; i++) await sleep(50)
  step('внизу')
  if (bo.dump) {
    st.doing = 'ловушка: свалка'
    let ok = true
    for (const q of [bo.dump.Dh, bo.dump.D1, bo.dump.D2]) {
      const dr = await SL.digCell(bot, new Vec3(q.x, q.y, q.z))
      if (dr === 'ok' || dr === 'air') S.own.add(SL.key(q.x, q.y, q.z)); else { ok = false; break }
    }
    if (!ok) bo.dump = null
    await centerIn(bot, bo.P)
    step('свалка')
  }
  st.doing = 'ловушка: замкнуть'
  bo.sealed = await sealBody(bot, S, bo.dump ? [bo.dump.Dh, bo.dump.D1, bo.dump.D2] : [], [bo.M])
  await centerIn(bot, bo.P)
  step('замкнул ' + JSON.stringify(bo.sealed))
  if (bo.sealed.risky && bo.sealed.risky.length) { S.fails.push('ловушка: угол открыт наружу'); return null }
  st.doing = 'ловушка: торг'
  S.exposed = true
  bo.at = xyz(bot.entity.position.floored())
  return bo
}

// Прицел приманки: слиток при любом разбросе Player.drop (±0.1 по вертикали) ложится в дальнюю
// клетку камеры C2 (ближняя C0 — в нашей рамке подбора, оттуда слиток вернётся к нам).
function baitAim (bot, bo) {
  const T = bo.C2
  const gb = require('./drops').blockGetter(bot)
  for (const hy of [1.0, 0.8, 1.3, 0.6, 1.6]) {
    for (const far of [0.6, 0.8, 0.4, 0.95]) {
      const aim = new Vec3(T.x + 0.5 + bo.d[0] * (far - 0.5), T.y + hy, T.z + 0.5 + bo.d[1] * (far - 0.5))
      const ok = [-0.1, 0, 0.1].every(dvy => { const at = tossLands(bot, aim, gb, dvy); return Math.floor(at.x) === T.x && Math.floor(at.z) === T.z && Math.floor(at.y) === T.y })
      if (ok) return aim
    }
  }
  return null
}

// Встать в центр клетки c (ноги): короткие шаги взглядом по горизонту, пока центр тела не в
// 0.15 от центра клетки. Проверка — клетка ног совпадает с c.
// Замкнуть тело перед торгом. Моб бьёт рамкой, раздутой на 0.83 только вбок (Mob.getAttackBoundingBox,
// 1.21.11): с пола пиглинов (на 2 выше ног) не достать, а из соседней клетки на нашем уровне — достать,
// и из угловой тоже (сквозь угол стены). pit-tick-1 и -11 30.09: брут пришёл к яме нашим же штреком и
// убил за 3 удара. Закладываем: соседей клеток ног и головы по граням и по углам (сперва угловые —
// их видно сквозь ещё открытые грани), и соседей по граням у клеток свалки (столб свалки высотой 3 —
// в нём брут встанет рядом с нами). keep — свалка (остаётся открытой), open — рот ловушки.
// Воздух от клетки k (без тела, свалки, рта) — замкнутый карман (< limit клеток) или выход наружу.
function pocketOpen (bot, k, skip, limit = 300) {
  const [x0, y0, z0] = k.split(',').map(Number)
  const seen = new Set([k])
  const q = [[x0, y0, z0]]
  // Моб, уже стоящий в закрытом кармане, — тоже угроза (ревью Codex 30.09: pocketOpen видел только блоки).
  const foes = Object.values(bot.entities).filter(e => e && e.position && /^(piglin_brute|hoglin|zoglin|piglin|zombified_piglin|wither_skeleton|magma_cube|blaze)$/.test(e.name || '') && e.position.distanceTo(new Vec3(x0, y0, z0)) < 12)
    .map(e => Math.floor(e.position.x) + ',' + Math.floor(e.position.y) + ',' + Math.floor(e.position.z))
  for (let i = 0; i < q.length; i++) {
    if (seen.size > limit) return true
    if (foes.includes(q[i].join(','))) return true
    const [x, y, z] = q[i]
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nk = (x + dx) + ',' + (y + dy) + ',' + (z + dz)
      if (seen.has(nk) || skip.has(nk)) continue
      const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz))
      if (!b) return true
      if (b.boundingBox !== 'empty') continue
      seen.add(nk)
      q.push([x + dx, y + dy, z + dz])
    }
  }
  return false
}

async function sealBody (bot, S, keep = [], open = [], mouth = null) {
  const SL = require('./sealed')
  const f = bot.entity.position.floored()
  const body = [f, f.offset(0, 1, 0)]
  const K = q => SL.key(q.x, q.y, q.z)
  const inside = new Set([...body, ...keep, ...open].map(K))
  const want = new Map()
  const add = (q, pri) => {
    const k = K(q)
    if (inside.has(k) || want.has(k)) return
    const b = bot.blockAt(q)
    if (!b || b.boundingBox !== 'empty' || /lava|water/.test(b.name)) return
    want.set(k, { q, pri })
  }
  for (const c of body) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) add(c.offset(dx, 0, dz), dx && dz ? 2 : 1)
  for (const c of keep) for (const [dx, dy, dz] of SL.FACES) add(new Vec3(c.x + dx, c.y + dy, c.z + dz), 0)
  // Бока и зад рта (клетка над головой): наш штрек рядом со ртом давал бруту луч сквозь угол
  // (pit-v4-3 30.09: брут в угловой клетке на уровне головы, rel [0.94, 1, −1], два удара, хп 20→5).
  if (mouth) for (const [dx, dz] of [[mouth.d[1], mouth.d[0]], [-mouth.d[1], -mouth.d[0]], [-mouth.d[0], -mouth.d[1]]]) add(new Vec3(mouth.M.x + dx, mouth.M.y, mouth.M.z + dz), 1)
  let n = 0
  const left = []
  for (const { q } of [...want.values()].sort((a, b) => b.pri - a.pri)) {
    if (await SL.fillCell(bot, q)) {
      S.own.delete(K(q)); n++
      if (FAST_SAFE) (S.filled || (S.filled = new Set())).add(K(q))
    } else left.push(K(q))
  }
  // Незаложенное — опасно, только если оттуда воздухом можно выйти наружу (туда придёт брут).
  const skip = new Set([...body, ...keep, ...open].map(K))
  if (mouth) skip.add(K(mouth.M))
  const risky = left.filter(k => pocketOpen(bot, k, skip))
  return { n, left, risky, breaches: SL.exposure(bot, S.own).length }
}

async function centerIn (bot, c, ms = 2500) {
  const tx = c.x + 0.5; const tz = c.z + 0.5
  const until = Date.now() + ms
  try {
    while (Date.now() < until) {
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

// Своим штреком к клетке ног P под будущим ртом, свалка сбоку, потом вскрыть рот M.
// Бартер после открытой выработки (разбор Codex 02.10, codex-lab/ne-tools/barter-audit-*): своё тело заперто своими же
// заплатками (клетки золота, заделанные после вскрытия чужого воздуха), а планировщик не вскрывает клетку у чужого воздуха —
// «яма: пути нет», nodes 1. Свою заплатку можно открыть обратно (как exitTunnel), чужой воздух — по-прежнему нельзя.
function tradeBreach (S, extra = () => false) {
  return (ck, nk) => !!(S.filled && S.filled.has(ck)) || extra(ck, nk)
}
async function tradeExecute (session, ctl, path, S, local = null) {
  const SL = require('./sealed')
  const prevOpen = S.openOk; const prevBreach = S.breachOk
  S.openOk = local
  S.breachOk = tradeBreach(S, (ck, nk) => !!(local && local.has(nk)))
  S.exposed = SL.exposure(session.bot, S.own).length > 0
  try { return await SL.execute(session, ctl, path, S) } finally { S.openOk = prevOpen; S.breachOk = prevBreach }
}

async function digPit (session, ctl, st, until) {
  const bot = session.bot
  const SL = require('./sealed')
  const S = st.sealedState
  if (!S) return null
  S.deadline = until
  S.noBonus = true
  // Снаружи (второй вызов кампании: тело вышло штреком к входу) — сперва ко входу своего штрека:
  // план ямы идёт от тела, а снаружи кругом чужой воздух — «яма: пути нет» (camp2-9 30.09: 123 слитка
  // в рюкзаке, два сухих захода, бастион «выработан»).
  { const me0 = bot.entity.position.floored()
    if (!S.own.has(SL.keyV(me0)) && S.entry && Math.hypot(S.entry.x - me0.x, S.entry.z - me0.z) + Math.abs(S.entry.y - me0.y) > 1) {
      const w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(S.entry.x, S.entry.y, S.entry.z), 30000, { dig: false })
      log('яма: ко входу штрека', { entry: S.entry, ok: !!(w && w.ok), at: xyz(bot.entity.position.floored()) })
      S.exposed = true
    } }
  for (let tries = 0; tries < 3 && !ctl.aborted && Date.now() < until - 20000; tries++) {
    const view = SL.worldView(bot)
    const cands = pitCandidates(bot, view, S.own, BF.enabled() ? 64 : 40).filter(b => !(S.badPits && S.badPits.has(SL.key(b.M.x, b.M.y, b.M.z)))).slice(0, 16)
    if (!cands.length) { log('яма: места у пиглинов нет', { pigs: mobs(bot, 'piglin', 40).length }); return null }
    const me = bot.entity.position.floored()
    const goalMap = new Map(cands.map(b => [SL.key(b.P.x, b.P.y, b.P.z), b]))
    const xs = [me.x, ...cands.map(b => b.P.x)]; const ys = [me.y, ...cands.map(b => b.P.y)]; const zs = [me.z, ...cands.map(b => b.P.z)]
    const box = { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 8), z0: Math.min(...zs) - 10, z1: Math.max(...zs) + 10 }
    const hs = cands.map(b => b.P)
    const pitPlan = extra => SL.plan({
      cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 80000, vup: SL.fillerCount(bot) >= 6, breachOk: tradeBreach(S),
      starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
      goal: (x, y, z) => goalMap.has(SL.key(x, y, z)),
      h: (x, y, z) => Math.min(...hs.map(t => Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z))),
      ...extra
    })
    let r = await pitPlan({})
    // Тело в «чужом» кармане (ни одного хода со старта: кругом воздух не из своих) — пройти и вскрыть можно
    // только этот карман (localAir), дальше — как всегда (main 30.09: 9 золотых блоков, «яма: пути нет» ×6).
    let local = null
    if (!r.ok && r.nodes <= 1) {
      local = SL.localAir(bot)
      if (local) {
        r = await pitPlan({ openOk: local, breachOk: tradeBreach(S, (ck, nk) => local.has(nk)) })
        log('яма: старт из чужого кармана', { cells: local.size, ok: r.ok, nodes: r.nodes })
        if (!r.ok) local = null
      }
    }
    // Тело на открытой выработке (золото моста/двора: свои клетки, но кругом чужой воздух) — ни хода отсюда, и карман
    // не помог. Старт — из любой своей клетки, связанной с телом своим воздухом (штрек подхода закрыт): дойти туда
    // ногами без копки и оттуда — яма (ферма 02.10 neF-bas-2, мост: 10 золотых блоков, «яма: пути нет» ×6, бартера нет).
    if (!r.ok && r.nodes <= 1 && S.own.size > 2) {
      const seen = new Set([SL.keyV(me)])
      const q = [{ v: me, d: 0 }]
      const starts = []
      for (let i = 0; i < q.length && q.length < 800; i++) {
        const { v, d } = q[i]
        for (const [dx, dy, dz] of SL.FACES) {
          const n = v.offset(dx, dy, dz)
          const nk = SL.keyV(n)
          if (seen.has(nk) || !S.own.has(nk)) continue
          const b = bot.blockAt(n)
          if (!b || b.boundingBox !== 'empty' || /lava|fire/.test(b.name)) continue
          seen.add(nk)
          q.push({ v: n, d: d + 1 })
          const fl = bot.blockAt(n.offset(0, -1, 0))
          if (fl && fl.boundingBox === 'block') starts.push({ x: n.x, y: n.y, z: n.z, g: (d + 1) * 2 })
        }
      }
      if (starts.length) {
        const r2 = await pitPlan({ starts })
        log('яма: старт из своего штрека', { own: S.own.size, starts: starts.length, ok: r2.ok, nodes: r2.nodes, start: r2.start })
        if (r2.ok && r2.start && !(r2.start.x === me.x && r2.start.y === me.y && r2.start.z === me.z)) {
          const w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(r2.start.x, r2.start.y, r2.start.z), 30000, { dig: false })
          const f = bot.entity.position.floored()
          if (f.x === r2.start.x && f.y === r2.start.y && f.z === r2.start.z) r = r2
          else log('яма: к старту не дошёл', { start: r2.start, at: xyz(f), error: w && w.error })
        } else if (r2.ok) r = r2
      }
    }
    if (!r.ok) { log('яма: пути нет', { cands: cands.length, nodes: r.nodes, why: r.why }); return null }
    const last = r.path.length ? r.path[r.path.length - 1].to : me
    const bo = goalMap.get(SL.key(last.x, last.y, last.z))
    log('яма: план', { feet: bo.P, mouth: bo.M, dump: !!bo.dump, catch: bo.catch, pigs: bo.pigs, brutes: bo.brutes, moves: r.path.length })
    st.doing = 'яма: путь'
    S.exposed = SL.exposure(bot, S.own).length > 0
    const ex = await tradeExecute(session, ctl, r.path, S, local)
    if (!ex.ok) { S.fails.push('яма: ' + ex.why); continue }
    const step = what => {
      const f = bot.entity.position
      const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
      log('яма: шаг', { what, hp: Math.round(bot.health ?? 0), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], under: nm(f.offset(0, -0.5, 0)), inP: Math.floor(f.x) === bo.P.x && Math.floor(f.y) === bo.P.y && Math.floor(f.z) === bo.P.z })
    }
    step('дошёл')
    if (bo.dump) {
      st.doing = 'яма: свалка'
      let ok = true
      for (const c of [bo.dump.Dh, bo.dump.D1, bo.dump.D2]) {
        const dr = await SL.digCell(bot, new Vec3(c.x, c.y, c.z))
        if (dr === 'ok' || dr === 'air') S.own.add(SL.key(c.x, c.y, c.z)); else { ok = false; break }
      }
      if (!ok) bo.dump = null
      step('свалка')
    }
    // Тело — в центр своей клетки: рядом открыт столб свалки, и с края в него съехать.
    if (!(await centerIn(bot, bo.P))) { S.fails.push('яма: не встал в центр'); step('не в центре'); continue }
    st.doing = 'яма: замкнуть'
    bo.sealed = await sealBody(bot, S, bo.dump ? [bo.dump.Dh, bo.dump.D1, bo.dump.D2] : [], [], bo)
    await centerIn(bot, bo.P)
    step('замкнул ' + JSON.stringify(bo.sealed))
    if (bo.sealed.risky.length) { (S.badPits || (S.badPits = new Set())).add(SL.key(bo.M.x, bo.M.y, bo.M.z)); S.fails.push('яма: угол открыт наружу'); continue }
    // Рот вскрывать, когда злость от золота остыла (600 тиков): злой арбалетчик стреляет в рот.
    st.doing = 'яма: жду злость'
    for (let w = 0; w < 40 && Date.now() - lastGoldBreak(st) < 33000 && !ctl.aborted; w++) await sleep(1000)
    st.doing = 'яма: рот'
    const mr = await SL.digCell(bot, new Vec3(bo.M.x, bo.M.y, bo.M.z))
    if (mr !== 'ok' && mr !== 'air') { S.fails.push('яма: рот ' + mr); continue }
    step('рот')
    st.doing = 'яма: торг'
    S.exposed = true
    bo.at = xyz(bot.entity.position.floored())
    return bo
  }
  return null
}

// Bounded movement to a different observed group or mapped floor; grid execution still checks live blocks.
async function moveBarterSite (session, ctl, st, p, until) {
  const NR = require('./nether-route'); const SL = require('./sealed'); const bot = session.bot
  if (!NR.enabled() || !NR.gridOf(session) || !st.sealedState || ctl.aborted || Date.now() > until - 20000 || (st.flowMoves || 0) >= 3) return false
  if ((bot.health ?? 20) < 16 || SL.fillerCount(bot) < 16) return false
  // Cool down behind cover, never at the open courtyard. The subsequent route is guarded and bounded.
  if (Date.now() - lastGoldBreak(st) < 33000) {
    if (!inOwnTunnel(bot, st.sealedState)) return false
    const why = await waitWatched(session, ctl, Math.min(33000, lastGoldBreak(st) + 33000 - Date.now()))
    if (why || ctl.aborted) return false
  }
  const view = SL.worldView(bot); const me = bot.entity.position
  const seen = st.flowVisited || (st.flowVisited = new Set())
  const pits = pitCandidates(bot, view, st.sealedState.own, 64)
    .filter(b => !b.brutes && !(st.sealedState.badPits && st.sealedState.badPits.has(SL.key(b.M.x, b.M.y, b.M.z))))
  const targets = pits.map(b => ({ ...b.P, r: 0, dy: 0, source: 'яма', pigs: b.pigs }))
  // Only the current bastion's known chest floors; no blind random walk and no outside-grid fallback.
  if (!targets.length) for (const [x, y, z] of p.knownChests || []) targets.push({ x, y, z, r: 4, dy: 1, source: 'этаж по карте' })
  for (const target of targets) {
    const key = `${target.x},${target.y},${target.z}`
    if (seen.has(key) || Math.hypot(target.x - me.x, target.z - me.z) < 6 && Math.abs(target.y - me.y) < 3) continue
    seen.add(key); st.flowMoves = (st.flowMoves || 0) + 1
    const sec = Math.min(60, Math.floor((until - Date.now()) / 1000))
    if (sec < 20) return false
    const rr = await NR.routeTo(session, ctl, { ...target, timeoutSeconds: sec, ironOk: false, zoneExpo: 14,
      abortNear: { re: '^(piglin_brute|hoglin)$', r: 10 } }).catch(e => ({ ok: false, why: e.message }))
    for (const k of rr.own || []) st.sealedState.own.add(k)
    log('бартер: смена места', { target, ok: rr.ok, why: rr.why, seconds: rr.s, moves: st.flowMoves })
    if (rr.ok) return true
    // A failed route can leave the body exposed; close up before giving the hands back.
    await burrow(session, ctl, st, 'бартер: смена места не вышла').catch(() => null)
    return false
  }
  return false
}

function distToBox (p, e) {
  const w = (e.width || 0.6) / 2
  const h = e.height || 1.95
  const dx = Math.max(e.position.x - w - p.x, 0, p.x - (e.position.x + w))
  const dy = Math.max(e.position.y - p.y, 0, p.y - (e.position.y + h))
  const dz = Math.max(e.position.z - w - p.z, 0, p.z - (e.position.z + w))
  return Math.hypot(dx, dy, dz)
}

// Вручить без шагов: только видимому пиглину в досягаемости (pick.aim — луч
// из глаз до рамки, как у клиента).
async function handNoWalk (bot, pg) {
  const pick = require('./pick')
  if (!bot.entities[pg.id] || admiring(pg)) return false
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

// Бросок в окно: взгляд в центр окна — слиток вылетает на высоте головы и
// ложится у пиглинов в 2–2.5 блока от нас (за стеной), дальше досягаемости подбора.
// Из ямы — сквозь рот: взгляд на его наружную грань (слиток ложится у рта, там его и
// берёт пиглин, и разглядывает на месте — его бросок к нам попадает в яму).
const pitLike = bo => bo.kind === 'pit' || bo.kind === 'trap'

// Сводка двух заходов торга (вторая яма после «яма не работает»): счёт — сумма, доставка — пересчёт.
function mergeTrades (a, b) {
  const sum = (x, y) => (x || 0) + (y || 0)
  const addMap = (x, y) => { const o = { ...(x || {}) }; for (const [k, v] of Object.entries(y || {})) o[k] = (o[k] || 0) + v; return o }
  const out = { ...b }
  for (const k of ['handed', 'tossed', 'hits', 'tossHeld', 'unseen', 'wontLand', 'seconds', 'pearls', 'spent', 'throwsN', 'lureBad', 'unheld']) out[k] = sum(a[k], b[k])
  for (const k of ['thrown', 'got', 'junked', 'dumped', 'lyingOutside']) out[k] = addMap(a[k], b[k])
  out.ingots0 = a.ingots0
  out.lyingWhere = [...(a.lyingWhere || []), ...(b.lyingWhere || [])]
  const th = Object.values(out.thrown || {}).reduce((m, v) => m + v, 0)
  if (a.delivery !== undefined || b.delivery !== undefined) out.delivery = th ? ((a.delivery || 0) * Object.values(a.thrown || {}).reduce((m, v) => m + v, 0) + (b.delivery || 0) * Object.values(b.thrown || {}).reduce((m, v) => m + v, 0)) / th : undefined
  out.pits = 2
  return out
}
function aimOut (bo) {
  // Ловушка: слиток — на пол дальней клетки камеры (дальше нашей рамки подбора): пиглин за ним
  // спрыгнет в камеру и останется в ней.
  if (bo.kind === 'trap') { const T = bo.C2 || bo.C0; return new Vec3(T.x + 0.5, T.y + 0.15, T.z + 0.5) }
  if (bo.kind === 'pit') return new Vec3(bo.M.x + 0.5 + bo.d[0] * 0.6, bo.M.y + 0.45, bo.M.z + 0.5 + bo.d[1] * 0.6)
  return new Vec3(bo.W.x + 0.5 + bo.d[0] * 0.5, bo.W.y + 0.55, bo.W.z + 0.5 + bo.d[1] * 0.5)
}
async function tossOut (bot, bo, name, count = 1, aim = null) {
  const it = itemNamed(bot, name)
  if (!it) return false
  try {
    await bot.lookAt(aim || aimOut(bo), true)
    await sleep(80) // взгляд уходит на сервер следующим тиком, бросок — сразу
    await bot.toss(it.type, null, Math.min(count, it.count))
    return true
  } catch { return false }
}

// Брут или хоглин у окна: мечом сквозь окно — он нас не достаёт.
const WEAPON_RANK = n => n.startsWith('netherite') ? 5 : n.startsWith('diamond') ? 4 : n.startsWith('iron') ? 3 : n.startsWith('stone') ? 2 : 1
async function hitThroughWindow (bot) {
  const pick = require('./pick')
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const t = [...mobs(bot, 'piglin_brute', 5), ...mobs(bot, 'hoglin', 5), ...mobs(bot, 'zoglin', 5)].filter(e => distToBox(eye, e) <= 2.9)[0]
  if (!t) return false
  const a = pick.aim(bot, t)
  if (!a || !a.point) return false
  const sword = bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((x, y) => WEAPON_RANK(y.name) - WEAPON_RANK(x.name))[0]
  try {
    if (sword && (!bot.heldItem || bot.heldItem.type !== sword.type)) await bot.equip(sword, 'hand')
    await bot.lookAt(a.point, true)
    bot.attack(t)
  } catch { return false }
  await sleep(650)
  return true
}

// Хлам бартера и копки — в окно (взгляд в окно, как у броска слитка).
const JUNK_OUT = { gravel: 0, soul_sand: 8, soul_soil: 0, nether_brick: 0, quartz: 0, crying_obsidian: 8, dried_ghast: 0, leather: 0, iron_nugget: 64, magma_block: 0, nether_wart_block: 0, warped_wart_block: 0, crimson_fungus: 0, warped_fungus: 0, crimson_roots: 0, warped_roots: 0, basalt: 0, polished_basalt: 0, smooth_basalt: 0, polished_blackstone_bricks: 16, cracked_polished_blackstone_bricks: 0, polished_blackstone: 0, chiseled_polished_blackstone: 0, blackstone: 32, netherrack: 32, glowstone_dust: 0, magma_cream: 0, cobblestone: 32 }
// Прицел в свалку ямы: брошенное должно лечь в D2 (на 1 ниже ног — назад не подберётся)
// при любом разбросе броска (Player.drop: ±0.1 по вертикали). Иначе — не бросать: pit-real
// 29.09 бросал «в свалку», а оно ложилось у ног и возвращалось — тысячи бросков по кругу.
function dumpAim (bot, bo) {
  if (!bo.dump) return null
  const { D1, D2 } = bo.dump
  const getBlock = require('./drops').blockGetter(bot)
  const px = D1.x - bo.P.x; const pz = D1.z - bo.P.z
  for (const far of [0.9, 0.7, 0.5, 0.3]) {
    for (const hy of [1.3, 1.1, 1.5, 0.9, 0.6]) {
      const aim = new Vec3(bo.P.x + 0.5 + px * (0.5 + far), D1.y + hy, bo.P.z + 0.5 + pz * (0.5 + far))
      const ok = [-0.1, 0, 0.1].every(dvy => {
        const at = tossLands(bot, aim, getBlock, dvy)
        return Math.floor(at.x) === D2.x && Math.floor(at.z) === D2.z && at.y < bo.P.y - 0.5
      })
      if (ok) return aim
    }
  }
  return null
}

// Что оставить в рюкзаке у ямы (всё прочее — в свалку): золото, жемчуг, очи и стержни,
// зелья, обсидиан (портал), нить и шерсть (кровати), стрелы и лук, огненные заряды,
// снаряжение, еда, до 64 блоков стройки (заливка штрека). Координатор 30.09: в полный
// рюкзак добыча не идёт — у ног лежала пачка из 4 жемчуга.
// iron_nugget/iron_block — железная кирка из слитков (B0-21 03.10: самородки бартера ушли в свалку ямы, железной кирки не стало —
// «за железом наверх» на 17-й мин, золото бастиона брошено).
const PIT_KEEP = /^(iron_nugget|iron_block|raw_iron|gold_ingot|gold_block|gold_nugget|raw_gold|ender_pearl|ender_eye|blaze_rod|blaze_powder|potion|splash_potion|obsidian|string|[a-z_]*wool|[a-z_]+_bed|spectral_arrow|arrow|bow|crossbow|fire_charge|flint_and_steel|shield|[a-z_]*bucket|crafting_table|iron_ingot|ancient_debris|netherite_[a-z_]+|diamond|[a-z_]+_(pickaxe|axe|shovel|sword|hoe)|iron_(helmet|chestplate|leggings)|diamond_(helmet|chestplate|leggings|boots)|golden_(helmet|chestplate|leggings|boots)|cooked_[a-z_]+|bread|apple|golden_apple|enchanted_golden_apple|golden_carrot|carrot|baked_potato|beef|porkchop|mutton|chicken|rabbit|cod|salmon|melon_slice|sweet_berries|dried_kelp|torch|stick|[a-z_]+_planks|[a-z_]+_log|oak_boat|[a-z_]+_boat)$/
// Блоков стройки — до 128: 64 на штрек и ещё 64 на Край (агент дракона, ~65 боёв: мост и столбы у
// клеток съедают 64, и бот копал эндерняк посреди боя). Сперва те, что годятся дракону (dragon.js
// FILLER_RE: незерак, чернокамень, булыжник…), потом прочие по величине стопки.
const PIT_FILL_KEEP = 128
const END_FILLER = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone)$/
function pitJunk (bot) {
  const SL = require('./sealed')
  const out = []
  let fill = 0
  const items = bot.inventory.items().slice().sort((a, b) => (Number(END_FILLER.test(b.name)) - Number(END_FILLER.test(a.name))) || (b.count - a.count))
  const goldArmor = /^golden_(helmet|chestplate|leggings|boots)$/
  let spareGold = 0
  for (const it of items) {
    if (SL.FILL_NAMES && SL.FILL_NAMES.includes(it.name)) { if (fill < PIT_FILL_KEEP) { fill += it.count; continue } out.push(it); continue }
    if (goldArmor.test(it.name)) { if (spareGold++ < 1) continue; out.push(it); continue } // одна запасная золотая вещь
    if (PIT_KEEP.test(it.name)) continue
    out.push(it)
  }
  // Аварийный запас (pack.RESERVE) — не в свалку, даже если это «хлам» ямы (кирпич Ада, картошка).
  const spare = reserveKeeper(bot)
  return out.filter(it => spare(it.name, it.count))
}

async function junkOut (bot, bo, tally = null) {
  // Яма без свалки: хлам — наружу сквозь рот, прицелом приманки (ляжет на пол пиглинов ≥1.6 от нас;
  // вернувшийся подберётся и уйдёт следующим разом). pit-v2-3 30.09: свалки нет, хлам не выбрасывался,
  // рюкзак полон — добыча (и 5 жемчужин) лежала у ног неподобранной, доставка 45%.
  if (bo.kind === 'pit' && !bo.dump) {
    if (!bo.lureAims) bo.lureAims = pitLures(bot, bo)
    if (!bo.lureAims.length) return 0
    bo.dumpAim = bo.lureAims[0].aim
  } else if (pitLike(bo) && !bo.dump) return 0
  if (pitLike(bo)) {
    const aim = bo.dumpAim || (bo.dumpAim = dumpAim(bot, bo))
    if (!aim) return 0
    let n = 0
    for (const it of pitJunk(bot)) {
      try {
        await bot.lookAt(aim, true)
        await sleep(80) // взгляд уходит на сервер следующим тиком, бросок — сразу
        await bot.tossStack(it)
        n++
        if (tally) tally[it.name] = (tally[it.name] || 0) + it.count
      } catch {}
    }
    return n
  }
  const aim = bo.kind === 'pit'
    ? (bo.dumpAim || (bo.dumpAim = dumpAim(bot, bo)))
    : new Vec3(bo.W.x + 0.5 + bo.d[0] * 0.5, bo.W.y + 0.55, bo.W.z + 0.5 + bo.d[1] * 0.5)
  if (!aim) return 0
  let n = 0
  const spare = reserveKeeper(bot)
  for (const [name, keep] of Object.entries(JUNK_OUT)) {
    let have = countOf(bot, name)
    for (const it of bot.inventory.items().filter(i => i.name === name).sort((a, c) => a.count - c.count)) {
      if (have - it.count < keep) break
      if (!spare(name, it.count)) break
      try {
        await bot.lookAt(aim, true)
        await sleep(80) // взгляд уходит на сервер следующим тиком, бросок — сразу
        await bot.tossStack(it)
        have -= it.count
        n++
        if (tally) tally[name] = (tally[name] || 0) + it.count
      } catch {}
    }
  }
  return n
}

async function makeSill (bot, bo) {
  const SL = require('./sealed')
  const { placeBlockAt } = require('./build')
  const C = new Vec3(bo.C.x, bo.C.y, bo.C.z)
  const b = bot.blockAt(C)
  if (b && b.name === 'soul_sand') return true
  if (b && b.boundingBox !== 'empty') { const r = await SL.digCell(bot, C); if (r !== 'ok' && r !== 'air') return false }
  for (let i = 0; i < 3; i++) {
    try { const r = await placeBlockAt(bot, C, { item: 'soul_sand', timeoutMs: 1500 }); if (r && r.ok) return true } catch {}
    await sleep(200)
  }
  // Не встал — закрыть проём обратно чем есть (иначе он высотой 2).
  await SL.fillCell(bot, C)
  return false
}

// Куда ляжет бросок пиглина, стоящего ногами в from (BehaviorUtils.throwItem: из глаз − 0.3,
// скорость 0.3 на «наши ноги + 1» от его ног), и попадёт ли он в рамку подбора — в полёте
// после задержки подбора (10 тиков) или там, где ляжет. Физика — drops.js.
const PIGLIN_EYE = 1.79
function throwLands (bot, from, feet = bot.entity.position, getBlock = null) {
  const drops = require('./drops')
  getBlock = getBlock || drops.blockGetter(bot)
  const t = { x: feet.x - from.x, y: feet.y + 1 - from.y, z: feet.z - from.z }
  const L = Math.hypot(t.x, t.y, t.z) || 1
  const s = { id: 0, age: 0, x: from.x, y: from.y + PIGLIN_EYE - 0.3, z: from.z, vx: 0.3 * t.x / L, vy: 0.3 * t.y / L, vz: 0.3 * t.z / L, onGround: false }
  for (let i = 0; i < 80; i++) {
    drops.stepItem(getBlock, s)
    if (i >= 10 && drops.inPickup(feet, s, 0.05)) return { ok: true, at: s, tick: i }
    if (s.onGround && Math.abs(s.vx) + Math.abs(s.vz) < 0.005) break
  }
  return { ok: drops.inPickup(feet, s, 0.05), at: s }
}

// Клетки пола пиглинов (уровень ног fy), связанные с (x,z) ходьбой по ровному (4 стороны). Приманка
// в закутке, куда пиглин не пройдёт, лежит без толку (pit-v3-1 30.09: 44 слитка в одной точке, ни одного
// броска пиглина, 520 с).
function floorRegion (gb, x0, z0, fy, max = 800) {
  // Ходьба пиглина: по ровному и ступенькой ±1 (лестницы, плиты бастиона); ключи «x,z» на уровнях fy−2..fy+2.
  const ok = (x, y, z) => {
    const f = gb(x, y, z); const h = gb(x, y + 1, z); const u = gb(x, y - 1, z)
    return f && f.boundingBox === 'empty' && !/lava|fire/.test(f.name) && h && h.boundingBox === 'empty' && u && u.boundingBox === 'block'
  }
  const seen = new Set()
  const cells = new Set()
  if (!ok(x0, fy, z0)) return cells
  const q = [[x0, fy, z0]]
  seen.add(x0 + ',' + fy + ',' + z0)
  cells.add(x0 + ',' + z0)
  for (let i = 0; i < q.length && seen.size < max; i++) {
    const [x, y, z] = q[i]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1]) {
        const ny = y + dy
        if (ny < fy - 2 || ny > fy + 2) continue
        const k = (x + dx) + ',' + ny + ',' + (z + dz)
        if (seen.has(k) || !ok(x + dx, ny, z + dz)) continue
        // Ступенька вверх — нужна голова над собой; вниз — над клеткой спуска.
        if (dy === 1) { const hh = gb(x, y + 2, z); if (!hh || hh.boundingBox !== 'empty') continue }
        seen.add(k)
        cells.add((x + dx) + ',' + (z + dz))
        q.push([x + dx, ny, z + dz])
        break
      }
    }
  }
  return cells
}

// Приманка из ямы: перебор прицелов сквозь рот. Годен прицел, при котором слиток при любом разбросе
// Player.drop (±0.1 вверх) ложится на пол пиглинов дальше нашей рамки подбора (≥1.6 от нас), иначе он
// вернётся к нам. Оценка 0..9 — из скольких точек вокруг места (пиглин берёт предмет с шага: его
// рамка подбора раздута на блок вбок) его бросок долетит к нам; худшая из трёх посадок, по точкам,
// где пиглин может стоять. Считается раз на яму: геометрия не меняется.
function pitLures (bot, bo, gb = null) {
  gb = gb || require('./drops').blockGetter(bot)
  const me = bot.entity.position
  const eye = me.offset(0, 1.62, 0)
  const d = bo.d; const pp = [d[1], d[0]]
  const fy = bo.M.y
  const Mx = bo.M.x + 0.5; const Mz = bo.M.z + 0.5
  const standable = (x, z) => {
    const f = gb(Math.floor(x), fy, Math.floor(z)); const h = gb(Math.floor(x), fy + 1, Math.floor(z)); const u = gb(Math.floor(x), fy - 1, Math.floor(z))
    return f && f.boundingBox === 'empty' && h && h.boundingBox === 'empty' && u && u.boundingBox === 'block'
  }
  // Где пиглин стоит, подняв предмет: Mob.aiStep берёт предмет, попавший в его рамку, раздутую на (1,0,1)
  // (ITEM_PICKUP_REACH) — центр пиглина в 0..1.3 от предмета, со стороны подхода; брошенный нами слиток
  // 2 с на задержке — пришедший раньше стоит прямо на нём. Точки: центр, круг 0.7 и круг 1.2.
  const pts = [[0, 0], ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(k => [0.7, 1.2].map(r => [r * Math.cos(k * Math.PI / 4 + (r > 1 ? Math.PI / 8 : 0)), r * Math.sin(k * Math.PI / 4 + (r > 1 ? Math.PI / 8 : 0))]))]
  const out = []
  for (const a of [0.5, 0.7, 0.9, 1.2, 1.6, 2.2]) {
    for (const h of [0.1, 0.3, 0.5, 0.7, 0.9, 1.2, 1.6]) {
      for (const l of [-0.3, -0.15, 0, 0.15, 0.3]) {
        const aim = new Vec3(Mx + d[0] * a + pp[0] * l, fy + h, Mz + d[1] * a + pp[1] * l)
        // Разброс по вертикали у Player.drop — (rand − rand)·0.1, треугольный: веса выборок ~ плотности.
        // Не долетевший слиток просто вернётся к нам (2 с), поэтому нужна лишь доля удачных ≥ 0.6.
        let pl = 0; let score = 9; let at = null
        for (const [dvy, w] of [[0, 1], [-0.04, 0.6], [0.04, 0.6], [-0.08, 0.2], [0.08, 0.2]]) {
          const q = tossLands(bot, aim, gb, dvy)
          if (!(q.onGround && Math.abs(q.y - fy) < 0.3 && Math.hypot(q.x - me.x, q.z - me.z) >= 1.6)) continue
          pl += w / 2.6
          if (!at) at = q
          let ok = 0; let n = 0
          for (const [dx, dz] of pts) {
            if (!standable(q.x + dx, q.z + dz)) continue
            n++
            // Бросок к нам — только если пиглин нас видит (PiglinAi.throwItems: NEAREST_VISIBLE_PLAYER,
            // луч глаз→глаз), иначе в случайную сторону (pit-v2 30.09: приманки с оценкой 9 без этой
            // проверки — доставка 45–51% в заходах с 45–61 приманкой).
            const from = new Vec3(q.x + dx, fy, q.z + dz)
            if (!rayClear(gb, from.offset(0, PIGLIN_EYE, 0), eye)) continue
            if (throwLands(bot, from, me, gb).ok) ok++
          }
          score = Math.min(score, n ? Math.floor(9 * ok / n) : 0)
        }
        if (pl < 0.6 || !at) continue
        out.push({ aim, score, pl: +pl.toFixed(2), at })
      }
    }
  }
  out.sort((x, y) => y.score - x.score || y.pl - x.pl || Math.hypot(x.at.x - Mx, x.at.z - Mz) - Math.hypot(y.at.x - Mx, y.at.z - Mz))
  return out
}

// Не держать золото в руке между сделками: пиглин, видящий игрока с золотом в руке, только
// смотрит на него и не подходит (PiglinAi 1.21.11: SetWalkTargetFromLookTarget в простое — лишь при
// doesntSeeAnyPlayerHoldingLovedItem); без золота в руке он иногда идёт к нам (до 3 блоков).
async function unholdGold (bot) {
  const h = bot.heldItem
  if (!h || !LOVED.test(h.name)) return false
  for (let i = 0; i < 9; i++) if (!bot.inventory.slots[36 + i]) { bot.setQuickBarSlot(i); return true }
  const items = bot.inventory.items().filter(it => !LOVED.test(it.name))
  const alt = items.find(it => /pickaxe|sword|_axe|shovel/.test(it.name)) || items[0]
  if (alt) { try { await bot.equip(alt, 'hand'); return true } catch {} }
  return false
}

// Где ляжет наш слиток, брошенный взглядом в aim (Player.drop: из глаз − 0.3, 0.3 по взгляду
// и +0.1 вверх).
function tossLands (bot, aim, getBlock = null, dvy = 0) {
  const drops = require('./drops')
  getBlock = getBlock || drops.blockGetter(bot)
  const me = bot.entity.position
  const eye = me.offset(0, 1.62, 0)
  const dx = aim.x - eye.x; const dy = aim.y - eye.y; const dz = aim.z - eye.z
  const h = Math.hypot(dx, dz) || 1e-6
  const pitch = Math.atan2(dy, h)
  const s = { id: 0, age: 0, x: me.x, y: eye.y - 0.3, z: me.z, vx: 0.3 * Math.cos(pitch) * dx / h, vy: 0.3 * Math.sin(pitch) + 0.1 + dvy, vz: 0.3 * Math.cos(pitch) * dz / h, onGround: false }
  for (let i = 0; i < 80; i++) { drops.stepItem(getBlock, s); if (s.onGround && Math.abs(s.vx) + Math.abs(s.vz) < 0.005) break }
  return s
}

async function boothTrade (session, ctl, st, bo, until, { keep = 8, done = () => false } = {}) {
  const bot = session.bot
  const t0 = Date.now()
  let lastToss = 0
  let lures = null
  let lastLure = null
  let idleSince = Date.now()
  const r = { handed: 0, tossed: 0, hits: 0, pearls0: countOf(bot, 'ender_pearl'), ingots0: countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block'), waitedAnger: 0, junked: {}, bag0: Object.fromEntries(bot.inventory.items().reduce((m, i) => m.set(i.name, (m.get(i.name) || 0) + i.count), new Map())) }
  const O = new Vec3(bo.O.x + 0.5, bo.O.y, bo.O.z + 0.5)
  // Журнал бросков: предмет, появившийся у глаз взрослого пиглина (BehaviorUtils.throwItem:
  // из глаз − 0.3), — добыча сделки. Доставка = пришло в рюкзак / брошено (по штукам),
  // а не доля от матожидания таблицы (ревью Codex 29.09).
  const throws = new Map()
  const itemType = bot.registry.entitiesByName.item && bot.registry.entitiesByName.item.id
  const handedAt = new Map()
  const busyUntil = new Map()
  if (BF.enabled()) { try { require('./ne-guard').attach(session) } catch {} }
  const badCells = new Map()
  const onSpawn = p => {
    if (p.type !== itemType) return
    const pg = mobs(bot, 'piglin', 24).find(e => !isBaby(bot, e) && Math.hypot(e.position.x - p.x, e.position.z - p.z) < 0.35 && Math.abs(e.position.y + 1.79 - 0.3 - p.y) < 0.15)
    if (!pg) return
    // Чья сделка: вручённая нами (в 12 с до броска) или приманка; где стоял пиглин относительно нас.
    const me = bot.entity.position
    const src = handedAt.has(pg.id) && Date.now() - handedAt.get(pg.id) < 12000 ? 'hand' : 'lure'
    throws.set(p.entityId, { t: Date.now(), src, cell: Math.floor(pg.position.x) + ',' + Math.floor(pg.position.y) + ',' + Math.floor(pg.position.z), rel: [+(pg.position.x - me.x).toFixed(1), +(pg.position.y - me.y).toFixed(1), +(pg.position.z - me.z).toFixed(1)] })
  }
  const onCollect = (collector, collected) => {
    if (!collector || collector !== bot.entity || !collected) return
    const t = throws.get(collected.id)
    if (t) t.got = true
  }
  bot.on('playerCollect', onCollect)
  const onMeta = p => {
    const t = throws.get(p.entityId)
    if (!t || t.name) return
    try { const it = bot.entities[p.entityId] && bot.entities[p.entityId].getDroppedItem(); if (it) { t.name = it.name; t.count = it.count } } catch {}
  }
  bot._client.on('spawn_entity', onSpawn)
  bot._client.on('entity_metadata', onMeta)
  // Перед торгом — место в рюкзаке: штрек набил его чернокамнем, гравием, добычей сундуков.
  if (pitLike(bo)) await junkOut(bot, bo, r.junked)
  try {
  while (!ctl.aborted && Date.now() < until - 3000) {
    if (done()) { r.stopped = 'цель'; break }
    if (BF.enabled()) {
      const G = require('./ne-guard')
      // Guard may move the body while a trade loop is waiting. Never reuse the old mouth.
      if (G.busy(bot) || G.hot(bot)) { await G.react(session, ctl); r.stopped = 'страж изменил место'; break }
      if (bot.entity.position.distanceTo(new Vec3(bo.F.x + 0.5, bo.F.y, bo.F.z + 0.5)) > 0.9) { r.stopped = 'ушёл из места бартера'; break }
    }
    if ((bot.health ?? 20) < 12) await eatIfHungry(session, ctl)
    if ((bot.health ?? 20) < 8) { r.stopped = `хп ${Math.round(bot.health)}`; break }
    // Брут у окна — мечом, пока стоит (злость пиглинов от удара — 30 с, переждём).
    // Бить брута сквозь окно — только по параметру: каждый удар злит пиглинов на 30 с (broadcastAngerTarget),
    // booth-1: 23 удара — 337 с ожидания; до нас брут и так не достаёт.
    if (st.hitBrutes && await hitThroughWindow(bot)) { r.hits++; st.lastBreak = Date.now(); idleSince = Date.now(); continue }
    const cool = lastGoldBreak(st) + 33000 - Date.now()
    if (cool > 0) { r.waitedAnger += Math.min(cool, 1000); await sleep(Math.min(cool, 1000)); continue }
    if (countOf(bot, 'gold_ingot') - keep < 1) {
      // Место под слитки: хлам — в окно (брошенное под ноги подберётся назад через 2 с).
      if (countOf(bot, 'gold_block') && bot.inventory.emptySlotCount() < 2) await junkOut(bot, bo, r.junked)
      if (countOf(bot, 'gold_block')) await unpackGold(session, ctl, keep + 18)
      if (countOf(bot, 'gold_ingot') - keep < 1) { r.stopped = countOf(bot, 'gold_block') ? 'блоки не распаковались' : 'слитки кончились'; break }
    }
    // Рюкзак почти полон — хлам в свалку: в полный рюкзак добыча не идёт и копится у ног.
    if (bot.inventory.emptySlotCount() < 3) await junkOut(bot, bo, r.junked)
    // Подоконник из песка душ: блок стены под окном (C) меняем на песок душ (высота 0.875).
    // Проём становится 0.875..2 над полом — моб (1.95) не пролезет и не встанет на песок
    // (над ним 1.125), а добыча, упавшая на подоконник, в нашей досягаемости подбора (C
    // вплотную). Песок душ даёт сам бартер (вес 40 из 469).
    if (!bo.sill && countOf(bot, 'soul_sand') > 0 && !mobs(bot, 'piglin_brute', 4, O).length && !mobs(bot, 'hoglin', 4, O).length) {
      bo.sill = await makeSill(bot, bo)
      r.sill = bo.sill
    }
    // Броски старше 4 с: не подобран, а лежит — клетка, откуда пиглин бросал, плохая (модель полёта там
    // врёт: ступенька/плита у рта; pit-v5-3 30.09 — 193 предмета вручённых сделок, дошло 56, пиглин
    // стоял на 1 выше наших ног в 1.8 от нас). Туда больше не вручать; доставка ниже половины после
    // 10 бросков — яма не доносит, копать другую.
    if (pitLike(bo)) {
      let n = 0; let got = 0
      for (const [id, t] of throws) {
        if (!t.eval && Date.now() - t.t > 4000) {
          t.eval = true
          if (!t.got && bot.entities[id] && t.cell && t.src === 'hand') { badCells.set(t.cell, (badCells.get(t.cell) || 0) + 1); r.badCells = badCells.size }
        }
        if (t.eval) { n++; if (t.got) got++ }
      }
      if (n >= 10 && got / n < 0.5) { r.stopped = 'яма не доносит'; break }
    }
    // Золото в руке держим только на миг вручения: с ним в руке пиглин к нам не подходит.
    if (await unholdGold(bot)) r.unheld = (r.unheld || 0) + 1
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const pigs = mobs(bot, 'piglin', 16).filter(e => !isBaby(bot, e) && !aggressive(bot, e) && !admiring(e) && (!BF.enabled() || BF.ready(bot, e, busyUntil)))
      .sort((a, b) => distToBox(eye, a) - distToBox(eye, b))
    let handed = false
    // Вручать тому, кто видит нас глаз в глаз сквозь окно: только он бросит добычу к нам
    // (NEAREST_VISIBLE_PLAYER), и она пройдёт окно. Пиглин сбоку от окна 1×1 луча не имеет —
    // booth-2/3: его добыча ложилась снаружи (жемчуг 0–2 на 140 слитков).
    const eyeSees = pg => raySees(bot, eye, pg.position.offset(0, (pg.height || 1.95) * 0.92, 0))
    const getBlock = pitLike(bo) ? require('./drops').blockGetter(bot) : null
    for (const pg of pigs) {
      if (distToBox(eye, pg) > 2.9) break
      // Яма: вручать только тому, кто нас видит и чей бросок (расчёт полёта) ляжет к нам —
      // иначе добыча остаётся у рта (pit-real 29.09: без этого в рюкзаке 70–89% сделок).
      if (pitLike(bo) || BF.enabled()) {
        if ((badCells.get(Math.floor(pg.position.x) + ',' + Math.floor(pg.position.y) + ',' + Math.floor(pg.position.z)) || 0) >= 2) { r.badCellSkip = (r.badCellSkip || 0) + 1; continue }
        if (!eyeSees(pg)) { r.unseen = (r.unseen || 0) + 1; continue }
        if (!throwLands(bot, pg.position, bot.entity.position, getBlock).ok) { r.wontLand = (r.wontLand || 0) + 1; continue }
      } else if (!eyeSees(pg) && Date.now() - (r.lastSeenHand || t0) < 15000) { r.unseen = (r.unseen || 0) + 1; continue }
      if (await handNoWalk(bot, pg)) {
        handedAt.set(pg.id, Date.now())
        if (BF.enabled()) busyUntil.set(pg.id, Date.now() + BF.ADMIRE_MS + 150)
        r.handed++; st.traded++; handed = true; idleSince = Date.now(); r.lastHandT = Date.now(); if (eyeSees(pg)) r.lastSeenHand = Date.now()
        // Кривая жемчуга по сделкам (опыты: последовательность бартера у мира одна — random_sequence).
        if (r.handed % 32 === 0) { r.curve = r.curve || []; r.curve.push([r.handed + r.tossed, countOf(bot, 'ender_pearl')]) }
        break
      }
    }
    if (!handed) {
      const near = pigs.filter(e => e.position.distanceTo(O) <= 8)
      const lying = Object.values(bot.entities).filter(e => e.name === 'item' && e.position && e.position.distanceTo(O) < 3 &&
        (() => { try { const d = e.getDroppedItem && e.getDroppedItem(); return d && d.name === 'gold_ingot' } catch { return false } })()).length
      // Брошенный слиток лежит и его не берут дольше 10 с — бросить ещё (booth-3: 2 слитка легли, торг встал).
      // Из ямы слиток бросаем, только если он ляжет дальше нашей рамки подбора (иначе вернётся
      // к нам — pit-real2 29.09: 106 бросков по кругу) и пиглин, подняв его с шага (рамка подбора
      // моба — на блок вбок), бросит добычу к нам из любой точки рядом (9 точек: место и круг 0.8).
      let tossOk = !pitLike(bo)
      let lureAim = null
      let pendingLure = null
      if (bo.kind === 'trap') {
        // Манить в камеру: в ней нет свободного взрослого и слиток там не лежит; слиток ляжет в
        // клетку камеры дальше нашей рамки подбора (иначе вернётся к нам через 2 с).
        const inTrap = e => [bo.C0, bo.C2].filter(Boolean).some(T => Math.floor(e.position.x) === T.x && Math.floor(e.position.z) === T.z && Math.abs(e.position.y - T.y) < 0.6)
        const caught = mobs(bot, 'piglin', 8).filter(e => !isBaby(bot, e) && inTrap(e))
        const baitThere = Object.values(bot.entities).some(e => e.name === 'item' && e.position && inTrap(e) && (() => { try { const d = e.getDroppedItem(); return d && d.name === 'gold_ingot' } catch { return false } })())
        const at = tossLands(bot, aimOut(bo))
        const me0 = bot.entity.position
        tossOk = !caught.length && !baitThere && inTrap({ position: new Vec3(at.x, at.y, at.z) }) && Math.hypot(at.x - me0.x, at.z - me0.z) >= 1.6
        if (!tossOk) r.tossHeld = (r.tossHeld || 0) + 1
        r.caught = Math.max(r.caught || 0, caught.length)
      } else if (bo.kind === 'pit') {
        // Прицелы приманки — раз на яму; порог оценки снижается, пока сделок нет: лучше приманка,
        // чей бросок долетит из 5 точек из 9, чем 120 с простоя (pit-tick 30.09: 387 удержаний, 0 сделок).
        if (!lures) { const t1 = Date.now(); lures = bo.lureAims || (bo.lureAims = pitLures(bot, bo)); r.lureBest = lures.length ? lures[0].score : -1; r.lureMs = Date.now() - t1 }
        let lastTrade = Math.max(t0, r.lastHandT || 0)
        for (const t of throws.values()) if (t.t > lastTrade) lastTrade = t.t
        const quiet = Date.now() - lastTrade
        // Сделка с приманки доходит хуже вручённой (pit-v4 30.09: руки 93–95%, приманки 11 из 26): манить,
        // только когда 30 с не было ни одной сделки, и не больше 12 приманок на яму.
        const need = r.tossed >= 12 ? 99 : quiet > 70000 ? 3 : quiet > 50000 ? 5 : quiet > 30000 ? 7 : 99
        // Прошлую приманку не взяли за 25 с (лежит у места посадки) — это место не годится.
        if (lastLure && Date.now() - lastLure.t > 25000 && !lastLure.L.bad) {
          const still = Object.values(bot.entities).some(e => e.name === 'item' && e.position && Math.hypot(e.position.x - lastLure.L.at.x, e.position.z - lastLure.L.at.z) < 1 && Math.abs(e.position.y - lastLure.L.at.y) < 1 &&
            (() => { try { const d = e.getDroppedItem(); return d && d.name === 'gold_ingot' } catch { return false } })())
          if (still) { lastLure.L.bad = true; r.lureBad = (r.lureBad || 0) + 1 }
        }
        const gbl = require('./drops').blockGetter(bot)
        const adults = mobs(bot, 'piglin', 16).filter(e => !isBaby(bot, e) && !aggressive(bot, e))
        const L = lures.find(x => {
          if (x.bad || x.score < need) return false
          if (!x.region) x.region = floorRegion(gbl, Math.floor(x.at.x), Math.floor(x.at.z), bo.M.y)
          return adults.some(e => Math.abs(e.position.y - bo.M.y) < 1.1 && x.region.has(Math.floor(e.position.x) + ',' + Math.floor(e.position.z)))
        })
        tossOk = !!L
        lureAim = L ? L.aim : null
        if (L) { r.lureScores = [...(r.lureScores || []).slice(-40), L.score]; pendingLure = L }
        if (!tossOk) r.tossHeld = (r.tossHeld || 0) + 1
      }
      if (tossOk && near.length && (lying < 1 || Date.now() - lastToss > 10000) && Date.now() - lastToss > 2500) {
        if (await tossOut(bot, bo, 'gold_ingot', 1, lureAim)) { r.tossed++; st.traded++; lastToss = Date.now(); if (!BF.enabled()) idleSince = Date.now(); if (pendingLure) lastLure = { L: pendingLure, t: Date.now() } }
      }
    }
    // Яма не работает — не жечь золото: приманки не берут или 150 с ни одного броска пиглина.
    // Вызывающий копает другую яму (pit-v3-1 30.09: 50 приманок, 0 сделок за 520 с).
    if (bo.kind === 'pit' && !throws.size && (r.tossed >= 8 || Date.now() - t0 > (BF.enabled() ? 45000 : 150000))) { r.stopped = 'яма не работает'; break }
    // Из ямы вручаем только тем, чей бросок долетит, — ждать их дольше.
    const idleMax = BF.enabled() ? 30000 : pitLike(bo) ? 120000 : 60000
    if (Date.now() - idleSince > idleMax) { r.stopped = `пиглины не подходят ${idleMax / 1000} с`; break }
    await sleep(300)
  }
  // Последние сделки: добыча разглядывающих прилетит через ~6 с.
  for (let i = 0; i < 16 && !ctl.aborted && Date.now() < until; i++) {
    if (!mobs(bot, 'piglin', 12).some(e => admiring(e))) break
    await sleep(500)
  }
  await sleep(2500) // задержка подбора и полёт последних бросков
  } finally { bot._client.removeListener('spawn_entity', onSpawn); bot._client.removeListener('entity_metadata', onMeta); bot.removeListener('playerCollect', onCollect) }
  const thrown = {}
  for (const t of throws.values()) if (t.name) thrown[t.name] = (thrown[t.name] || 0) + t.count
  r.thrown = thrown
  r.throwsN = throws.size
  // Доставка по источнику сделки (штуки): вручённые и приманки; где стоял пиглин у недошедших.
  const bySrc = {}
  const missed = []
  for (const t of throws.values()) {
    const b = bySrc[t.src || '?'] || (bySrc[t.src || '?'] = { n: 0, got: 0 })
    b.n += t.count || 1
    if (t.got) b.got += t.count || 1
    else if (missed.length < 30) missed.push([t.src === 'hand' ? 'h' : 'l', t.name || '?', ...(t.rel || [])])
  }
  r.bySrc = bySrc
  r.missed = missed
  r.seconds = Math.round((Date.now() - t0) / 1000)
  r.pearls = countOf(bot, 'ender_pearl') - r.pearls0
  r.spent = r.ingots0 - countOf(bot, 'gold_ingot') - 9 * countOf(bot, 'gold_block')
  const out = {}
  const dumped = {}
  const where = []
  const ref = pitLike(bo) ? bo.M : bo.W
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'item' || !e.position || e.position.distanceTo(O) > 10) continue
    const inDump = bo.dump && Math.floor(e.position.x) === bo.dump.D2.x && Math.floor(e.position.z) === bo.dump.D2.z && e.position.y < bo.P.y
    try {
      const d = e.getDroppedItem && e.getDroppedItem()
      if (!d) continue
      const m = inDump ? dumped : out
      m[d.name] = (m[d.name] || 0) + d.count
      // Где лежит (от рта/окна): решать, чем добирать — подкопом снизу или вылазкой.
      if (!inDump && where.length < 40) where.push([d.name, d.count, +(e.position.x - ref.x - 0.5).toFixed(1), +(e.position.y - ref.y).toFixed(1), +(e.position.z - ref.z - 0.5).toFixed(1)])
    } catch {}
  }
  r.lyingWhere = where.length ? where : undefined
  r.lyingOutside = Object.keys(out).length ? out : undefined
  r.dumped = Object.keys(dumped).length ? dumped : undefined
  // Сколько добычи пришло в рюкзак (с выброшенным в свалку) — для счёта сделок.
  const bag1 = bot.inventory.items().reduce((m, i) => m.set(i.name, (m.get(i.name) || 0) + i.count), new Map())
  const got = {}
  for (const [n, c] of bag1) { const d = c - (r.bag0[n] || 0) + (r.junked[n] || 0); if (d > 0 && n !== 'gold_ingot' && n !== 'gold_block') got[n] = d }
  for (const [n, c] of Object.entries(r.junked)) if (!bag1.has(n) && c - (r.bag0[n] || 0) > 0) got[n] = c - (r.bag0[n] || 0)
  r.got = got
  delete r.bag0
  let tSum = 0; let dSum = 0
  for (const [n, c] of Object.entries(r.thrown || {})) { tSum += c; dSum += Math.min(c, got[n] || 0) }
  // Доставка по штукам: что из брошенного пиглинами пришло к нам (с выброшенным в свалку).
  r.delivery = tSum ? +(dSum / tSum).toFixed(3) : undefined
  return r
}

// Выход штреком назад ко входу (клетке снаружи, откуда вошли): засыпанные клетки
// входа копаются, их соседи — открытый мир (openOk/breachOk только для них).
async function exitTunnel (session, ctl, st, until) {
  const bot = session.bot
  const SL = require('./sealed')
  const S = st.sealedState
  if (!S || !S.entry) return { ok: false, why: 'входа нет' }
  const E = S.entry
  const ek = [SL.key(E.x, E.y, E.z), SL.key(E.x, E.y + 1, E.z)]
  const me = bot.entity.position.floored()
  if (me.x === E.x && me.y === E.y && me.z === E.z) return { ok: true }
  const view = SL.worldView(bot)
  // Коробка — весь свой штрек (он уходит в сторону от прямой вход–тело; в booth-1 коробка по двум точкам резала его: «пути назад нет»).
  const pts = [me, E, ...[...S.own].map(k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z } })]
  const box = { x0: Math.min(...pts.map(q => q.x)) - 4, x1: Math.max(...pts.map(q => q.x)) + 4, y0: Math.max(5, Math.min(...pts.map(q => q.y)) - 4), y1: Math.min(120, Math.max(...pts.map(q => q.y)) + 4), z0: Math.min(...pts.map(q => q.z)) - 4, z1: Math.max(...pts.map(q => q.z)) + 4 }
  const openOk = new Set(ek)
  const r = await SL.plan({
    cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 120000, vup: SL.fillerCount(bot) >= 6, openOk,
    starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
    goal: (x, y, z) => x === E.x && y === E.y && z === E.z,
    h: (x, y, z) => Math.abs(x - E.x) + Math.abs(y - E.y) + Math.abs(z - E.z),
    breachOk: ck => openOk.has(ck) || !!(S.filled && S.filled.has(ck))
  })
  if (!r.ok) return { ok: false, why: 'пути назад нет', nodes: r.nodes }
  S.deadline = until
  S.openOk = openOk
  // Засыпанное нами (вход, клетки за спиной) — копать назад можно, хоть оно и касается открытого.
  S.breachOk = ck => openOk.has(ck) || !!(S.filled && S.filled.has(ck))
  let ex
  try { ex = await SL.execute(session, ctl, r.path, S) } finally { S.openOk = null; S.breachOk = null }
  return { ok: ex.ok, why: ex.why, moves: r.path.length }
}

// Видимые сундуки и узнанные по ним куски с золотом (bastion-pieces.js).
function scanPieces (bot, radius = 48) {
  const pg = predictGold(bot, Math.max(radius, 56))
  const walls = pg.walls.map(w => ({ wall: w.wall.t, r: w.wall.r, score: Math.round(w.score * 10) / 10, match: w.match, miss: w.miss, from: w.from }))
  const R = bot.registry.blocksByName
  const cids = [R.chest && R.chest.id, R.trapped_chest && R.trapped_chest.id, R.barrel && R.barrel.id].filter(Boolean)
  const chests = visibleOf(bot, cids, radius, { max: 40, rays: 3000 }).map(b => ({ pos: b.position, block: b }))
  const bp = require('./bastion-pieces')
  const loc = bp.locate(bot, chests)
  const props = b => { try { return b.getProperties() || {} } catch { return {} } }
  return {
    at: xyz(bot.entity.position.floored()),
    chests: chests.map(c => [c.pos.x, c.pos.y, c.pos.z, props(c.block).facing, props(c.block).type]),
    candidates: loc.candidates,
    found: loc.found.map(f => ({ piece: f.piece, type: bp.typeOf(f), r: f.r, t: f.t, match: f.match, miss: f.miss, gold: f.gold })),
    basalt: pg.basalt,
    ramparts: pg.ramparts,
    walls,
    gold: pg.gold.map(g => [g.pos.x, g.pos.y, g.pos.z]),
    votes: pg.debug
  }
}

const MEMO = new Map()

// ------------------------------------------------------------------ намерение
//
// p.mode: 'auto' (по умолчанию) — дойти до бастиона из памяти, золото и
// сундуки, потом бартер до цели; 'gold' — только золото и сундуки; 'barter' —
// только обмен того, что есть. Цели: pearls (жемчуг, по умолчанию 12),
// fireRes (зелья огнестойкости, 3), keep (слитков оставить себе, 8 — на
// золотое яблоко или шлем).
function exitReserveReady (bot, p = {}) {
  return process.env.ND_EXIT_KIT === '0' || !(p.obsidian >= 10) || require('./nether').exitKit(bot).ready
}

async function bastion (session, ctl, p = {}) {
  const bot = session.bot
  try { require('./ne-guard').swatInstall(bot) } catch {}
  try { require('./ne-guard').attach(session) } catch {}
  FAST_SAFE = p.fastSafe === true || process.env.ND_GOLD_FAST_SAFE === '1'
  const t0 = Date.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 400, 30, 1800) * 1000 - 5000
  const mode = p.mode || 'auto'
  const wantPearls = p.pearls ?? 12
  const wantFire = p.fireRes ?? 3
  // Обсидиан на раму выхода у крепости Края (кампания ND_SH_NETHER: 10 на раму) — тоже цель бартера (вес 40/469, по 1).
  const wantObs = p.obsidian ?? 0
  // Слитки про запас не держим: без золотой брони на теле bastion не идёт (wearGold ниже), а
  // 8 оставленных — это 8 сделок, ~0.5 жемчуга (ревью Codex 29.09: 153 → 145 обменов).
  const keep = p.keep ?? 0
  const st = {
    gold: new Map(), chestSeen: new Map(), skip: new Map(), looted: new Set(),
    blocks: 0, bribed: 0, traded: 0, chests: [], fights: [], barters: [], gained: {}, tossed: [], brutes: 0,
    visited: new Set(), lastBlocked: null, bruteSeen: new Map(), bricks: new Map(), been: [],
    pred: new Map(), towered: 0, predWrong: 0, predMiss: 0,
    // outside — подход к стене снаружи (внешние грани шаблона): на ферме пока
    // не лучше подхода через двор, поэтому по параметру (route-10/11 против 6).
    outside: !!p.outside || !!p.high,
    high: !!p.high,
    // sealed — золото закрытым штреком (sealedGold), без обхода двора.
    sealed: p.sealed !== false,
    fastSafe: FAST_SAFE,
    // breach — второй план закрытого штрека со вскрытием у входа и у целей (ND_SEALED_BREACH=1 у кампании; 02.10, мерка идёт)
    breach: !!p.breach || process.env.ND_SEALED_BREACH === '1',
    lootChests: p.chests !== false,
    hitBrutes: !!p.hitBrutes
  }
  const out = (stopped = null) => {
    const d = {
      mode,
      seconds: Math.round((Date.now() - t0) / 1000),
      goldBlocksDug: st.blocks,
      bribed: st.bribed,
      ingotsTraded: st.traded,
      chests: st.chests,
      gained: st.gained,
      bag: { gold_ingot: countOf(bot, 'gold_ingot'), gold_block: countOf(bot, 'gold_block'), ender_pearl: countOf(bot, 'ender_pearl'), fire_res: fireRes(bot), obsidian: countOf(bot, 'obsidian'), string: countOf(bot, 'string'), fire_charge: countOf(bot, 'fire_charge') },
      goldSeenLeft: [...st.gold.keys()].length,
      predLeft: st.pred.size,
      ...(st.fastSafe ? { knownGoldLeft: (p.knownGold || []).filter(a => {
        const b = bot.blockAt(new Vec3(...a)); return !b || b.name === 'gold_block'
      }).length } : {}),
      predWrong: st.predWrong || undefined,
      predMiss: st.predMiss || undefined,
      towered: st.towered || undefined,
      sealed: st.sealedState ? { dug: st.sealedState.dug, moves: st.sealedState.moves, fills: st.sealedState.fills, ores: st.sealedState.ores, plans: st.sealedState.plans, planMs: st.sealedState.planMs, walks: st.sealedState.walks, exposed: st.sealedState.exposed, fails: st.sealedState.fails.slice(-6) } : undefined,
      goldNuggets: countOf(bot, 'gold_nugget') || undefined,
      pit: st.pit || undefined,
      pitTrade: st.pitTrade || undefined,
      barterRetry: BF.enabled() && st.barterRetry ? st.barterRetry : undefined,
      hurts: st.hurts && st.hurts.length ? st.hurts : undefined,
      exit: st.exit || undefined,
      fights: st.fights.length ? st.fights : undefined,
      brutesAvoided: st.brutes || undefined,
      tossed: st.tossed.length ? st.tossed : undefined,
      lastBlocked: st.lastBlocked || undefined
    }
    if (stopped) d.stopped = stopped
    d.note = `Золотых блоков ${st.blocks}, сундуков ${st.chests.filter(c => !c.error && !c.stopped).length}, слитков пиглинам ${st.traded}. ` +
      `В рюкзаке: жемчуг ${d.bag.ender_pearl}, огнестойкость ${d.bag.fire_res}, слитков ${d.bag.gold_ingot} (+${d.bag.gold_block} блоков), обсидиан ${d.bag.obsidian}, нить ${d.bag.string}.`
    if (st.ironNeed) d.need = { what: 'iron_pickaxe', count: 1, have: 0 }
    return d
  }

  if (worlds.worldOf(bot) !== 'the_nether') return out('бастионы — в Аду; сначала mc_portal mode=enter')
  // scan — только посмотреть: видимые сундуки и узнанные по ним куски (сцены).
  if (mode === 'scan') return { ...out(), scan: scanPieces(bot, p.radius || 48) }
  // goto — отладка подхода pathfinder'ом (noMob — без обхода мобов, floor — пол Ада).
  if (mode === 'goto') {
    const f0 = bot._ndNetherFloor
    bot._ndNoMobAvoid = !!p.noMob
    if (p.floor) bot._ndNetherFloor = p.floor
    const pf = bot.pathfinder
    const th = pf && pf.thinkTimeout
    if (pf) pf.thinkTimeout = p.think || 12000
    const t0g = Date.now()
    let w
    try { w = await walkGoal(session, ctl, new goals.GoalNear(p.tx, p.ty, p.tz, p.range ?? 1), (p.seconds || 45) * 1000, { dig: !!p.dig }) } finally { bot._ndNoMobAvoid = false; bot._ndNetherFloor = f0; if (pf) pf.thinkTimeout = th }
    return { ...out(), goto: { ...w, s: Math.round((Date.now() - t0g) / 1000), at: xyz(bot.entity.position.floored()) } }
  }
  // booth — отладка окна бартера: тело уже стоит в клетке F, окно — F+d+1 (dx,dz), пиглины за ним (сцены).
  if (mode === 'trap') {
    // Отладка ловушки (сцены): ноги в H, пол пиглинов (их ноги) — на 3 выше наших ног, камера по d.
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const px = d[1]; const pz = d[0]
    const M = { x: f.x, y: f.y + 1, z: f.z }
    const C0 = { x: M.x + d[0], y: M.y, z: M.z + d[1] }
    const C2 = { x: C0.x + d[0], y: C0.y, z: C0.z + d[1] }
    const P = { x: f.x, y: f.y - 1, z: f.z }
    const bo = { kind: 'trap', O: C0, C0, C1: { x: C0.x, y: C0.y + 1, z: C0.z }, C2, M, R: { x: M.x, y: M.y + 1, z: M.z }, H: xyz(f), P, d, p: [px, pz], dump: null, F: P, W: M, C: xyz(f), sill: true }
    if (p.dump) bo.dump = { Dh: { x: f.x + px, y: f.y, z: f.z + pz }, D1: { x: P.x + px, y: P.y, z: P.z + pz }, D2: { x: P.x + px, y: P.y - 1, z: P.z + pz } }
    const S = { own: new Set([require('./sealed').key(f.x, f.y, f.z), require('./sealed').key(M.x, M.y, M.z)]), fails: [], deadline: Date.now() + 600000 }
    const built = await buildTrap(session, ctl, st, bo, S)
    if (!built) return { ...out('ловушка не построилась: ' + S.fails.join('; ')), trap: bo }
    const r = await boothTrade(session, ctl, st, built, Date.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r, trap: { baited: built.baited, C2: !!built.C2 } }
  }
  if (mode === 'pit') {
    // Отладка ямы (сцены): тело уже в яме, рот над головой (P+2), пиглины по d.
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const M = { x: f.x, y: f.y + 2, z: f.z }
    const bo = { kind: 'pit', P: xyz(f), H: { x: f.x, y: f.y + 1, z: f.z }, M, R: { x: M.x, y: M.y + 1, z: M.z }, O: { x: M.x + d[0], y: M.y, z: M.z + d[1] }, d, p: [d[1], d[0]], dump: null, F: xyz(f), W: M, C: { x: f.x, y: f.y + 1, z: f.z }, sill: true }
    if (p.dump) bo.dump = { Dh: { x: f.x + d[1], y: f.y + 1, z: f.z + d[0] }, D1: { x: f.x + d[1], y: f.y, z: f.z + d[0] }, D2: { x: f.x + d[1], y: f.y - 1, z: f.z + d[0] } }
    const r = await boothTrade(session, ctl, st, bo, Date.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r }
  }
  if (mode === 'booth') {
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const bo = { F: xyz(f), C: { x: f.x + d[0], y: f.y, z: f.z + d[1] }, W: { x: f.x + d[0], y: f.y + 1, z: f.z + d[1] }, O: { x: f.x + 2 * d[0], y: f.y, z: f.z + 2 * d[1] }, d, sill: p.sill === false }
    const r = await boothTrade(session, ctl, st, bo, Date.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r }
  }
  // tunnel — отладка своего штрека к клетке tx,ty,tz (сцены).
  if (mode === 'tunnel') return { ...out(), tunnel: await tunnelTo(session, ctl, new Vec3(p.tx, p.ty, p.tz), { maxSteps: p.maxSteps || 60 }) }
  if (!(await wearGold(bot))) {
    return { ...out('без золотой брони пиглины нападают сами (PiglinAi.isWearingSafeArmor: хватит одной вещи) — золотой шлем: 5 слитков'), need: { what: 'golden_helmet', count: 1, have: 0 } }
  }
  const needPick = mode !== 'barter' && !bot.inventory.items().some(i => GOLD_PICK.test(i.name))
  // Кирка сломалась, а золото в рюкзаке есть (≥ 18 слитков с блоками) — не выходить с ним: торговать
  // (яму копают и каменные кирки). Ферма 30.09, кампания: после первого бастиона 10–12 блоков золота
  // в рюкзаке и «БЛОКЕР: нет доступного шага» из-за этой проверки.
  const goldHave = countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block')
  // Нет железной кирки и золота мало — сперва сундуки бастиона (закрытым штреком, каменными кирками):
  // в bastion_other железо — слитки 1–6 или блок (2 из 20 каждое, 2 броска) и самородки 2–8 (1 из 13,
  // 3–4 броска): железо в сундуке с вероятностью ≈ 0.5, в двух ≈ 0.77. Основному не хватает 2 самородков
  // (есть 2 сырого железа и 7 самородков). Не вышло — кампания идёт за железом наверх.
  if (needPick && !(st.sealed && goldHave >= 18) && !(st.sealed && p.chestsFirst !== false)) return { ...out('золотой блок ломается только железной киркой и лучше (needs_iron_tool)'), need: { what: 'iron_pickaxe', count: 1, have: 0 } }
  if (needPick && goldHave >= 18) { st.noPick = true; log('бастион: железной кирки нет — только торг', { gold: goldHave }) } else if (needPick) { st.chestsOnly = true; log('бастион: железной кирки нет — сперва сундуки (железо)', { ironIngots: countOf(bot, 'iron_ingot'), raw: countOf(bot, 'raw_iron'), nuggets: countOf(bot, 'iron_nugget') }) }

  const places = (session.journal.state && session.journal.state.places) || {}
  const rec = p.x !== undefined ? { x: p.x, y: p.y ?? 64, z: p.z } : places[PLACE]
  if (!rec && mode !== 'barter') return out('бастион не знаю: mc_fortress в Аду записывает его («бастион (ад)»), когда видит кирпич чернокамня')
  // Память между вызовами (кампания зовёт bastion несколько раз): узнанные стены,
  // штрек, вход, выкопанное — по месту бастиона, час. Иначе второй вызов снова
  // строил бы вышку и шёл к уже выкопанным клеткам.
  const memoKey = rec ? `${Math.round(rec.x)},${Math.round(rec.z)}` : null
  const memo = memoKey && MEMO.get(memoKey)
  if (st.sealed && memo && Date.now() - memo.t < 3600e3) {
    for (const [k, v] of memo.pred) if (!memo.mined.has(k)) st.pred.set(k, { ...v, pos: new Vec3(v.pos.x, v.pos.y, v.pos.z) })
    st.towered = 2
    st.sealedState = { own: memo.own, filled: memo.filled, exposed: memo.exposed, entry: memo.entry, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
    if (!st.pred.size) st.sealedDone = true
  }
  if (st.noPick && st.sealed) {
    if (!st.sealedState) st.sealedState = { own: new Set(), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
    st.pred.clear()
    st.sealedDone = true
    st.towered = Math.max(st.towered || 0, 3)
  }
  const memoSave = () => {
    if (!memoKey || !st.sealed || !st.sealedState) return
    const old = memo || { pred: new Map(), mined: new Set() }
    for (const [k, v] of st.pred) old.pred.set(k, { rank: v.rank, piece: v.piece, pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z } })
    for (const [k] of old.pred) if (!st.pred.has(k)) { const b = bot.blockAt(new Vec3(...k.split(',').map(Number))); if (b && b.name !== 'gold_block') old.mined.add(k) }
    MEMO.set(memoKey, { pred: old.pred, mined: old.mined, own: st.sealedState.own, filled: st.sealedState.filled, exposed: st.sealedState.exposed, entry: st.sealedState.entry, t: Date.now() })
  }

  const done = () => countOf(bot, 'ender_pearl') >= wantPearls && fireRes(bot) >= wantFire && countOf(bot, 'obsidian') >= wantObs && exitReserveReady(bot, p)
  const spare = () => countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') - keep
  // Сколько слитков нужно на цели (таблица бартера 1.21.11): жемчуг 0.064 на
  // слиток (вес 10 из 469, по 2–4), огнестойкость 16/469 = 0.034 (зелье и
  // взрывное). Больше 240 не копать — спидраннер не выносит бастион целиком.
  const goldTarget = () => p.gold ?? Math.min(BF.enabled() ? 480 : 240, Math.max(
    BF.enabled() ? BF.pearlBudget(wantPearls - countOf(bot, 'ender_pearl')) : Math.ceil(Math.max(0, wantPearls - countOf(bot, 'ender_pearl')) / 0.064),
    Math.ceil(Math.max(0, wantFire - fireRes(bot)) / 0.034),
    Math.ceil(Math.max(0, wantObs - countOf(bot, 'obsidian')) / (40 / 469)),
    // Нет огня: 34 сделки дают >=95% хотя бы одного fire_charge (40/469).
    !exitReserveReady(bot, p) && !require('./nether').exitKit(bot).lighter ? 34 : 0))
  st.stopMining = () => mode !== 'gold' && spare() >= (BF.enabled() ? Math.min(144, goldTarget()) : goldTarget())
  if (BF.enabled()) st.fastSafe = true
  // Золоту — не больше 60% вызова: остальное — бартер (прогон 2 лаборатории
  // ходил по точкам обзора все 500 с, и на обмен не осталось ни секунды).
  let goldPhaseEnd = mode === 'gold' ? deadline : t0 + (deadline - t0) * 0.6
  let barterNext = 0
  const piglinsAround = () => mobs(bot, 'piglin', 16).filter(e => !isBaby(bot, e) && seesMob(bot, e))
  const tryBarter = async (force = false) => {
    if (mode === 'gold' || done() || Date.now() < barterNext) return false
    if (!force && spare() < 24) return false
    if (countOf(bot, 'gold_ingot') - keep < 8 && countOf(bot, 'gold_block')) await unpackGold(session, ctl, keep + 27)
    const can = countOf(bot, 'gold_ingot') - keep
    if (can <= 0 || !piglinsAround().length) return false
    const r = await barterRound(session, ctl, st, Math.min(can, 24), deadline)
    log('бартер', { spent: r.spent, handed: r.handed, thrown: r.thrown, stopped: r.stopped, gained: r.gained, s: r.seconds })
    barterNext = Date.now() + (r.spent > 0 ? 1500 : 20000)
    if (!(r.spent > 0)) st.lastBarter = r.stopped || 'пиглины не берут'
    return r.spent > 0
  }

  // Кто и чем бьёт (damage_event: тип урона из реестра 1.21.11, причина) — с позицией, хп и
  // блоками вокруг: урон 20→5 за секунды у свалки ямы (pit-dump 30.09) остался без объяснения.
  st.hurts = []
  let lastHp = bot.health ?? 20
  const onDmg = pk => {
    if (!pk || pk.entityId !== bot.entity.id || st.hurts.length >= 40) return
    const f = bot.entity.position
    const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
    const cause = id => { const e = bot.entities[id]; return e ? (e.name || e.username || e.type) : (id >= 0 ? '#' + id : null) }
    const src = bot.entities[(pk.sourceCauseId ?? 0) - 1]
    const rel = src && src.position ? [+(src.position.x - f.x).toFixed(2), +(src.position.y - f.y).toFixed(2), +(src.position.z - f.z).toFixed(2)] : null
    const rec = { t: Math.round((Date.now() - t0) / 1000), type: DAMAGE_TYPES[pk.sourceTypeId] || pk.sourceTypeId, by: cause((pk.sourceCauseId ?? 0) - 1), rel, hpBefore: Math.round(lastHp), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], feet: nm(f), under: nm(f.offset(0, -0.5, 0)), head: nm(f.offset(0, 1.6, 0)), doing: st.doing || null }
    st.hurts.push(rec)
    log('урон', rec)
  }
  const onHp = () => { lastHp = bot.health ?? lastHp }
  bot._client.on('damage_event', onDmg)
  const toolFilter0 = bot._ndToolFilter
  bot._ndToolFilter = require('./tunnel').makeToolFilter(bot, false)
  bot.on('health', onHp)
  try {
    // Дойти до бастиона (издалека — отрезками по Аду).
    // Повторный вызов у этого бастиона (память штрека за час) и тело в своём штреке — никакого подхода:
    // «подход» к точке бастиона уводил тело из ямы через открытый бастион (camp-11 30.09: брут, 3 удара).
    const inOwnTunnel = !!(st.sealedState && st.sealedState.own && st.sealedState.own.has(`${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)}`))
    const nearMemo = !!memo && bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    if (inOwnTunnel || nearMemo) log('подход не нужен', { inOwnTunnel, nearMemo })
    // Золото бастиона известно (карта копии этого мира — разрешено пользователем 30.09): цель подхода — гуще
    // всего золото (стена в толще кирпича), а не ближний блок двора в открытом (chain3: 5 смертей от брутов
    // во дворе у 81–88,33,102–106). Подход и проверка «дошёл» — по одной цели.
    const KG0 = (p.knownGold || []).map(([x, y, z]) => ({ x, y, z }))
    const me00 = bot.entity.position
    const dens0 = g => KG0.filter(q => Math.abs(q.x - g.x) + Math.abs(q.y - g.y) + Math.abs(q.z - g.z) <= 6).length
    const nearG0 = KG0.length ? KG0.reduce((a, b) => (dens0(b) > dens0(a) || (dens0(b) === dens0(a) && Math.hypot(b.x - me00.x, b.z - me00.z) < Math.hypot(a.x - me00.x, a.z - me00.z))) ? b : a) : null
    const needApproach = () => nearG0
      ? Math.hypot(nearG0.x - bot.entity.position.x, nearG0.z - bot.entity.position.z) > 12 || Math.abs(nearG0.y - bot.entity.position.y) > 8
      : bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) > 40
    if (mode !== 'barter' && rec && !inOwnTunnel && !nearMemo && needApproach()) {
      const { walkToward } = require('./nether')
      // Подход по Аду — со строгим обходом лавы (session: шаг над обрывом к лаве — 1000, у лавы — 200):
      // pit-v2-14 и trip-9 30.09 — тело на подходе упало в лавовое озеро (y 24–31), одна смерть.
      const strict0 = bot._ndLavaStrict
      // Восстановить и при исключении из питья/штрека — во внешнем finally (ревью Codex 30.09).
      if (st.lavaStrict0 === undefined) st.lavaStrict0 = strict0
      bot._ndLavaStrict = true
      // Дальний путь (второй бастион): огнестойкость на дорогу, если зелий хватает (≥2 — одно остаётся).
      if ((p.tripSeconds || 0) > 0 && fireRes(bot) >= 2) { const fr = await drinkFireRes(bot).catch(() => null); log('в путь: огнестойкость', { fr, left: fireRes(bot) }) }
      // Издалека (второй бастион) — не в центр, а к краю: в 28 блоках не доходя, по горизонтали. У центра
      // тело оказывалось под валами бастиона, и вышка не росла (trip2-9 30.09: «вышка +1», «не узнан» ×2);
      // с края (b2-15 — старт в 31 блоке) вал виден и стены узнаются.
      const me0 = bot.entity.position
      const far0 = Math.hypot(rec.x - me0.x, rec.z - me0.z)
      // Место обзора (vantage) из памяти — там вал бастиона виден с вышки (b2-15 30.09: 642,59,269 → стены
      // узнаны, 17 блоков); с края по прямой вышка слепла в толще незерака (trip2-11: basalt 0 ×3).
      const V = p.vantage || (rec && rec.vantage) || null
      // Золото бастиона известно (карта копии этого мира — разрешено пользователем 30.09): штрек — прямо к
      // ближнему золотому блоку, без вышки и места обзора (подход к месту обзора у 104,43,96 — хоглины и
      // лава: chain2 30.09, «tried to swim in lava to escape Hoglin»).
      const nearG = nearG0
      const goal = nearG ? { x: nearG.x, y: nearG.y, z: nearG.z } : V ? { x: V.x, y: V.y ?? rec.y, z: V.z } : far0 > 200 ? { x: rec.x - (rec.x - me0.x) / far0 * 28, y: rec.y, z: rec.z - (rec.z - me0.z) / far0 * 28 } : rec
      // Сторож лавы: в лаве — оборвать ходьбу (свой ctl), выбраться, идти дальше.
      const walk = async (ms, to = null) => {
        const sub = { aborted: false, onAbort: [] }
        const cut = () => { if (sub.aborted) return; sub.aborted = true; for (const fn of sub.onAbort) { try { fn() } catch {} } }
        const watch = setInterval(() => { if (ctl.aborted || inLava(bot)) cut() }, 100)
        try { await walkToward(session, sub, to || goal, Math.min(deadline, Date.now() + ms), to ? { range: 8, xz: true } : goal === rec || V ? { range: V ? 4 : 6 } : { range: 6, xz: true }) } finally { clearInterval(watch) }
        if (inLava(bot)) { try { bot.pathfinder.setGoal(null) } catch {} ; if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); st.lavaEscapes = (st.lavaEscapes || 0) + 1; return true }
        return false
      }
      // Штреком (tunnel.js), если далеко: пешком по Аду тело гибло (лавовое озеро у 103,31,80 — 4 смерти;
      // падения и лава по дороге ко второму бастиону — trip*, ~4 из 9). Не вышло штреком — пешком, как раньше.
      // (route-точки по карте убраны: pit-v6 30.09 — 13 смертей из 13, путь лёг через лавовое море.)
      const far1 = Math.hypot(goal.x - me0.x, goal.z - me0.z)
      // ND_NE_ROUTE=1 и сетка копии мира есть — к гуще золота одним планом (nether-route): мосты/спрыгивания по дороге,
      // у бастиона (коробка известного золота ± 12) открытое втридорога — сквозь стены. Клетки хода — «свои» для
      // sealedGold, дальше как после штрека. Не вышло — прежний штрек (tunnel.js).
      let routed = false
      const NR = require('./nether-route')
      if (nearG && NR.enabled() && NR.gridOf(session) && !ctl.aborted && (far1 > 12 || Math.abs(goal.y - me0.y) > 8)) {
        const xs = KG0.map(q => q.x); const ys = KG0.map(q => q.y); const zs = KG0.map(q => q.z)
        const zone = [Math.min(...xs) - 12, Math.min(...ys) - 6, Math.min(...zs) - 12, Math.max(...xs) + 12, Math.max(...ys) + 8, Math.max(...zs) + 12]
        const rStart = bot.entity.position.floored()
        const rr = await lavaWatched(bot, ctl, sub => NR.routeTo(session, sub, { x: goal.x, y: goal.y, z: goal.z, r: 4, dy: 3, zone, zoneExpo: 5, timeoutSeconds: Math.max(60, Math.min(600, Math.round((deadline - Date.now()) / 1000) - 300)) }))
        log('к бастиону по сетке', { ok: rr.ok, why: rr.why, steps: rr.steps, dug: rr.dug, placed: rr.placed, plans: rr.plans, s: rr.seconds, at: rr.at })
        if (rr.ok) {
          routed = true
          st.tunnel = { ok: true, route: true, steps: rr.steps, dug: rr.dug, at: rr.at }
          st.sealedState = { own: rr.own, exposed: false, entry: { x: rStart.x, y: rStart.y, z: rStart.z }, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
          try { require('./tunnel').rememberOwn(session, [...rr.own]) } catch {}
        }
      }
      if (!routed && (far1 > 40 || (nearG && (far1 > 12 || Math.abs(goal.y - me0.y) > 8))) && p.tunnel !== false) {
        const { tunnelTo } = require('./tunnel')
        // Вход штрека подхода — клетка, откуда он начат: без него exitTunnel отвечал «входа нет», и после бастиона тело
        // оставалось в своём штреке под лавовым морем (neF-mB26-1 02.10: y 21, все шаги к спавнеру и порталу — на месте).
        let tStart = bot.entity.position.floored()
        const tOpts = () => ({ band: p.band ?? 40, radius: nearG ? 10 : 5, noBreachNear: rec ? { x: rec.x, z: rec.z, r: 48 } : null, deadline: Math.min(deadline - 240000, Date.now() + 90000 + far1 * 3000), log: (w, d) => log(w, d) })
        let tr = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts()))
        // Штрек не начался (тело на открытом, «со старта не войти»): закопаться и снова.
        if (!tr.ok && !tr.segs && (tr.dug || 0) < 8 && !ctl.aborted && process.env.ND_BURROW !== '0') {
          const bw = await burrow(session, ctl, st, 'штрек к бастиону не начался')
          if (bw.ok) { tStart = bot.entity.position.floored(); tr = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts())) } else log('закопаться не вышло', { why: bw.why })
        }
        st.tunnel = { ok: tr.ok, why: tr.why, segs: tr.segs, breach: tr.breach, detours: tr.detours, dug: tr.dug, crafted: tr.crafted, at: tr.at }
        log('штрек к бастиону', st.tunnel)
        // Дальше — тем же закрытым штреком: его клетки — «свои» для sealedGold (без «ко входу» пешком).
        if (nearG && tr.own && tr.own.size) st.sealedState = { own: tr.own, exposed: !!tr.exposed, entry: { x: tStart.x, y: tStart.y, z: tStart.z }, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
        // Известное золото, а штрек встал далеко («пути нет»: лавовые озёра по дороге — neF-map26-1 02.10: 145 бл. до
        // бастиона, dug 405, и «до бастиона не дошёл» без шага пешком): пешком (строгий обход лавы) к точке в 40 бл.
        // не доходя до золота, оттуда штрек ещё раз. Во двор пешком не входим — последние 40 бл. только штреком.
        for (let k = 0; k < 2 && nearG && !tr.ok && !ctl.aborted && Date.now() < deadline - 300000; k++) {
          const me1 = bot.entity.position
          const d1 = Math.hypot(nearG.x - me1.x, nearG.z - me1.z)
          if (d1 <= 60) break
          const mid = { x: Math.round(nearG.x - (nearG.x - me1.x) / d1 * 40), y: Math.round(me1.y), z: Math.round(nearG.z - (nearG.z - me1.z) / d1 * 40) }
          // Пешком по Аду — только под огнестойкостью (есть зелье — выпить): без неё подход ногами кончался лавой и
          // падениями (neF-Sb25-1 02.10: ко второму бастиону — лавовое море на y 29; Pa21/Sb21 — обрыв 42 бл. к лаве).
          // Строгий режим (fastSafe) без зелья — не идти: бастион кончится неудачей, а не смертью.
          if (st.fastSafe && !effectOn(bot, 'fire_resistance')) {
            if (fireRes(bot) >= 1) { const d = await drinkFireRes(bot).catch(e => e.message); for (let q = 0; q < 30 && !effectOn(bot, 'fire_resistance'); q++) await sleep(100); log('подход пешком: огнестойкость', { d, left: fireRes(bot) }) }
            // Без зелья — только недалеко (≤ 110 бл., строгий обход лавы): иначе тело стоит у портала весь прогон
            // (neF-T24-1 02.10: штрек и закопаться не начались на тонкой корке у портала, 84 бл. до золота).
            if (!effectOn(bot, 'fire_resistance') && d1 > 110) { log('подход пешком без огнестойкости — не иду', { left: Math.round(d1) }); break }
          }
          await walk(150000, mid)
          const d2 = Math.hypot(nearG.x - bot.entity.position.x, nearG.z - bot.entity.position.z)
          log('подход пешком к штреку', { k, from: { x: Math.round(me1.x), y: Math.round(me1.y), z: Math.round(me1.z) }, to: mid, left: Math.round(d2), was: Math.round(d1) })
          if (d2 > d1 - 16 && k > 0) break
          let tStart2 = bot.entity.position.floored()
          const tOpts2 = () => ({ band: p.band ?? 40, radius: 10, noBreachNear: rec ? { x: rec.x, z: rec.z, r: 48 } : null, deadline: Math.min(deadline - 240000, Date.now() + 90000 + d2 * 3000), log: (w, d) => log(w, d) })
          let tr2 = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts2()))
          if (!tr2.ok && !tr2.segs && (tr2.dug || 0) < 8 && !ctl.aborted && process.env.ND_BURROW !== '0') {
            const bw = await burrow(session, ctl, st, 'штрек после подхода не начался')
            if (bw.ok) { tStart2 = bot.entity.position.floored(); tr2 = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts2())) } else log('закопаться не вышло', { why: bw.why })
          }
          st.tunnel = { ok: tr2.ok, why: tr2.why, segs: tr2.segs, breach: tr2.breach, detours: tr2.detours, dug: tr2.dug, crafted: tr2.crafted, at: tr2.at, walked: k + 1 }
          log('штрек к бастиону', st.tunnel)
          if (tr2.own && tr2.own.size) st.sealedState = { own: tr2.own, exposed: !!tr2.exposed, entry: { x: tStart2.x, y: tStart2.y, z: tStart2.z }, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
          if (tr2.ok) break
        }
      }
      try {
        const left = () => goal === rec ? bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) : Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z)
        let again = !nearG && left() > (goal === rec ? 40 : 12) ? await walk(180000 + (p.tripSeconds || 0) * 1000) : false
        // Второй заход (бой по дороге, обрыв: booth-2 — «не дошёл: 76 блоков» за 38 с; вынырнули из лавы).
        for (let k = 0; k < 3 && !nearG && !ctl.aborted && (again || left() > (goal === rec ? 48 : 20)) && Date.now() < deadline - 300000; k++) {
          if ((bot.health ?? 20) < 12) await eatIfHungry(session, ctl)
          again = await walk(150000)
        }
      } finally { bot._ndLavaStrict = strict0 }
      const leftNow = nearG0 ? Math.hypot(nearG0.x - bot.entity.position.x, nearG0.z - bot.entity.position.z) : bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z))
      // Известное золото: штрек довёл на ~50 блоков, а дальше закрытого пути нет (вокруг двор и лава) —
      // дальше обычный закрытый штрек бастиона (sealedGold: вход по «reachCells» и штрек к стене; chain5 30.09:
      // план к стене 89,36,140 от 92,47,88 — 12 тыс. узлов, путь только через короткий вход снаружи).
      if (nearG0 ? leftNow > 72 : leftNow > 48) return out(`до бастиона не дошёл: ${Math.round(leftNow)} блоков`)
    }
    if ((p.knownGold || []).length && !st.knownLoaded) {
      st.knownLoaded = true
      for (const [x, y, z] of p.knownGold) { const v = new Vec3(x, y, z); const b = bot.blockAt(v); if (b && b.name !== 'gold_block' && b.boundingBox === 'empty') continue; const k = keyOf(v); if (!st.pred.has(k)) st.pred.set(k, { pos: v, piece: 'память', rank: 0 }) }
      for (const [x, y, z] of (p.knownChests || [])) { const v = new Vec3(x, y, z); const k = keyOf(v); if (!st.chestSeen.has(k) && !st.looted.has(k)) st.chestSeen.set(k, { pos: v, seen: Date.now(), pred: true }) }
      st.towered = 3
      log('бастион по памяти', { gold: st.pred.size, chests: st.chestSeen.size })
    }
    const center = rec ? centerGuess(bot, rec) : bot.entity.position.floored()
    const points = rec ? vantagePoints(center, center.box) : []
    log('план обзора', { center: { x: center.x, y: center.y, z: center.z }, box: center.box, points: points.length })
    let idle = 0
    let vantage = 0
    let barterWalks = 0
    while (!ctl.aborted && Date.now() < deadline - 12000) {
      if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); continue }
      if ((bot.health ?? 20) < 8) return out(`хп ${Math.round(bot.health)} — ухожу лечиться`)
      await eatIfHungry(session, ctl)
      if (await answerAttack(session, ctl, st)) continue
      if (await bruteDefense(session, ctl, st)) continue
      if (mode !== 'gold' && done()) break
      // Закрытый путь: после золота — торговое окно из штрека, потом штреком назад.
      if (st.sealed && st.sealedState && st.sealedDone && !st.pitDone) {
        st.pitDone = true
        if (mode !== 'gold' && !done() && (spare() > 0 || countOf(bot, 'gold_block'))) {
          // Яма со ртом (добыча падает к нам); не вышла — окно в стене.
          // Ловушка торговцев (пиглины заперты перед ртом) → яма со ртом → окно в стене.
          // Ловушка — только по p.trade='trap': из ямы ноги на 4 ниже пола, глаза ниже рта, и бросок
          // слитка-приманки в камеру не выходит изо рта (расчёт tossLands) — манить надо сверху (не сделано).
          // Места у пиглинов нет (все на открытом полу, без стены под рот) — ждать в штреке и
          // искать снова: пиглины бродят (pit-tick 30.09: 3 из 16 заходов встали на «ни ямы, ни окна»).
          let bo = null
          for (let tryN = 0; tryN < (BF.enabled() ? 2 : 6) && !bo && !ctl.aborted && Date.now() < deadline - 90000; tryN++) {
            if (tryN && BF.enabled()) {
              if (!(await moveBarterSite(session, ctl, st, p, deadline - 60000))) break
            }
            if (tryN && !BF.enabled()) {
              // Тело стоит не в своём ходе (ход по сетке к золоту кончился у двора: план ямы — «пути нет», 9 узлов:
              // D2-21 03.10 — 19 золотых блоков в рюкзаке, бартера не было вовсе) — закопаться в толщу и искать снова.
              if (tryN <= 2 && process.env.ND_GOLD_ROUTE === '1' && !ownTunnelAt(bot, st.sealedState)) {
                const bw = await burrow(session, ctl, st, 'бартер: места нет').catch(e => ({ ok: false, why: e.message }))
                log('бартер: закопался', { ok: bw && bw.ok, why: bw && bw.why })
                if (bw && bw.ok) continue
              }
              st.doing = 'жду место'; log('бартер: места нет — жду', { try: tryN, pigs: mobs(bot, 'piglin', 40).length })
              const w = await waitWatched(session, ctl, 15000)
              if (w) log('бартер: ждать не вышло', { why: w, hp: Math.round(bot.health ?? 0) })
            }
            bo = p.trade === 'trap' ? await digTrap(session, ctl, st, deadline - 30000) : null
            if (!bo && p.trade !== 'booth') bo = await digPit(session, ctl, st, deadline - 30000)
            // Окно — только по просьбе (trade:'booth' или boothFallback): доставка у окна 0–41% (pit-v2-1
            // 30.09: 41 слиток — один бросок пиглина). Ямы нет — золото остаётся в рюкзаке до другого места.
            if (!bo && ((!BF.enabled() && tryN >= 1 && p.boothFallback !== false) || p.trade === 'booth')) bo = await digBooth(session, ctl, st, deadline - 30000)
          }
          if (bo) {
            st.pit = { kind: bo.kind || 'booth', at: bo.F, window: bo.W, dump: !!bo.dump, catch: bo.catch, pigs: bo.pigs, brutes: bo.brutes, sealed: bo.sealed, baited: bo.baited }
            st.pitTrade = await boothTrade(session, ctl, st, bo, deadline - 40000, { keep, done })
            log(bo.kind === 'trap' ? 'ловушка: бартер' : bo.kind === 'pit' ? 'яма: бартер' : 'окно: бартер', st.pitTrade)
            // Яма не работает (приманки не берут, нет бросков) — другая яма, до двух раз.
            // «Не подходят» — и после частичной торговли: пиглины ушли в другой зал, а золото осталось
            // (pit-v7 30.09: 5 из 9 торговавших заходов встали так, золото в рюкзаке).
            const notWorking = t => t && (t.stopped === 'яма не работает' || t.stopped === 'яма не доносит' || /не подходят|страж изменил место|ушёл из места/.test(t.stopped || ''))
            for (let k = 0; k < 2 && bo.kind === 'pit' && notWorking(st.pitTrade) && countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') >= 18 && !ctl.aborted && Date.now() < deadline - 150000; k++) {
              const S2 = st.sealedState
              ;(S2.badPits || (S2.badPits = new Set())).add(require('./sealed').key(bo.M.x, bo.M.y, bo.M.z))
              log('яма не работает — другая', { at: bo.P, tossed: st.pitTrade.tossed, seconds: st.pitTrade.seconds })
              if (BF.enabled() && !(await moveBarterSite(session, ctl, st, p, deadline - 60000))) break
              const bo2 = await digPit(session, ctl, st, deadline - 30000)
              if (!bo2) break
              bo = bo2
              st.pits = [...(st.pits || [st.pit]), { kind: bo.kind, at: bo.F, catch: bo.catch, pigs: bo.pigs, sealed: bo.sealed }]
              const r2 = await boothTrade(session, ctl, st, bo, deadline - 40000, { keep, done })
              log('яма: бартер', r2)
              st.pitTrade = mergeTrades(st.pitTrade, r2)
            }
          } else {
            st.lastBarter = 'ни ямы, ни окна'
            if (BF.enabled()) st.barterRetry = 'нет защищённого места у торговцев'
            // ND_OPEN_BARTER=1: ни ямы, ни окна, а золото есть — бартер на открытом, как у спидраннеров (золотая броня, брутов и
            // хоглинов в 24 нет): D7b-32 03.10 — 15 золотых блоков, 0 сделок, бастион «выработан».
            if (!BF.enabled() && process.env.ND_OPEN_BARTER === '1' && !ctl.aborted && goldWorn(bot) && countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') >= 9 &&
              ![...mobs(bot, 'piglin_brute', 24), ...mobs(bot, 'hoglin', 24)].length && Date.now() < deadline - 60000) {
              await unpackGold(session, ctl, 9 * countOf(bot, 'gold_block') + countOf(bot, 'gold_ingot'))
              const n = countOf(bot, 'gold_ingot')
              const ob = await barterRound(session, ctl, st, n, deadline - 40000).catch(e => ({ error: e.message }))
              st.lastBarter = 'на открытом'
              log('бартер на открытом', { ingots: n, spent: ob && ob.spent, pearls: ob && ob.pearls, stopped: ob && (ob.stopped || ob.error) })
            }
          }
          // ND_PEARL_PICK=1: жемчуг, брошенный мимо ямы (D6-21 03.10: 108 слитков, брошено 4 жемчуга, доставка 0.58 — в
          // рюкзаке 0), — ходом по сетке (двор втридорога, брут в 10 — бросить) к каждому в 14 бл. и подобрать.
          if (bo && process.env.ND_PEARL_PICK === '1' && !ctl.aborted) {
            const NR = require('./nether-route')
            const isPearl = e => { try { const d = e.getDroppedItem && e.getDroppedItem(); return !!d && d.name === 'ender_pearl' } catch { return false } }
            const pk = { seen: 0, went: 0, got: 0 }
            const p0 = countOf(bot, 'ender_pearl')
            for (let k = 0; k < 5 && NR.enabled() && NR.gridOf(session) && !ctl.aborted && Date.now() < deadline - 60000; k++) {
              const me = bot.entity.position
              const its = Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(me) < 14 && e.position.distanceTo(me) > 1.3).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
              if (!k) pk.seen = its.length
              if (!its.length || mobs(bot, 'piglin_brute', 16).length) break
              const g = its[0].position.floored()
              pk.went++
              const rr = await NR.routeTo(session, ctl, { x: g.x, y: g.y, z: g.z, r: 1, dy: 1, zones: undefined, zoneExpo: 14, abortNear: { re: '^(piglin_brute|hoglin)$', r: 10 }, timeoutSeconds: 45 }).catch(e => ({ ok: false, why: e.message }))
              for (const c of (rr.own || [])) { if (st.sealedState && st.sealedState.own) st.sealedState.own.add(c) }
              await pickUp(bot, ctl, 3, 2500)
              if (!rr.ok) break
            }
            pk.got = countOf(bot, 'ender_pearl') - p0
            if (pk.seen || pk.went) log('жемчуг мимо ямы', pk)
          }
        }
        // Лечиться — здесь, в замкнутой яме/штреке, а не снаружи: кампания после захода с хп 6 искала
        // нору в Аду, нора не закрылась — «БЛОКЕР», тело отключено (ферма 30.09, camp-10).
        if ((bot.health ?? 20) < 14 && !ctl.aborted) {
          const h0 = Math.round(bot.health ?? 0)
          const until2 = Math.min(deadline - 20000, Date.now() + 120000)
          while ((bot.health ?? 20) < 16 && Date.now() < until2 && !ctl.aborted && !inLava(bot)) {
            if ((bot.food ?? 20) < 18) await eatIfHungry(session, ctl)
            if ((bot.food ?? 20) < 18 && (bot.food ?? 20) < 20 && !bot.inventory.items().some(i => /cooked|bread|apple|carrot|potato|melon_slice|stew|porkchop|beef|mutton|chicken|rabbit|cod|salmon/.test(i.name))) break
            await sleep(2000)
          }
          st.healed = { from: h0, to: Math.round(bot.health ?? 0) }
          log('лечусь в штреке', st.healed)
        }
        // Выходить — только подлечившись (хп ≥ 14); иначе остаться в замкнутом штреке: следующий вызов
        // продолжит отсюда (ревью Codex 30.09: выход при хп 7 после неудачного лечения).
        if (p.exit !== false && (!BF.enabled() || done()) && (bot.health ?? 20) >= 14 && exitReserveReady(bot, p)) { st.exit = await exitTunnel(session, ctl, st, deadline); log('выход', st.exit) } else if (p.exit !== false && (!BF.enabled() || done())) { st.exit = { ok: false, why: !exitReserveReady(bot, p) ? 'набор на выход не готов (обсидиан/огонь) — остаюсь в штреке' : `лечение не завершилось (хп ${Math.round(bot.health ?? 0)}) — остаюсь в штреке` }; log('выход', st.exit) }
        if (BF.enabled() && mode !== 'gold' && !done() && !ctl.aborted) {
          if (spare() < 18 && st.pred.size && !st.noPick && Date.now() < deadline - 60000) {
            st.pitDone = false; st.sealedDone = false
            log('бартер: следующий пакет золота', { left: st.pred.size, pearls: countOf(bot, 'ender_pearl') })
            continue
          }
          if (spare() >= 18) st.barterRetry = 'сменить место у торговцев с сохранённым золотом'
        }
        break
      }
      // Бартер между делом: слитков много и пиглины рядом — сделки идут, пока
      // копаем (и разглядывающие золото не злятся от следующего блока).
      if (!st.sealed || !st.sealedState) { if (await tryBarter()) continue }
      const goldOver = mode === 'barter' || spare() >= goldTarget() || Date.now() > goldPhaseEnd
      if (goldOver) {
        if (mode === 'gold') break
        // Злость пиглинов от сломанного золота — 600 тиков (30 с): торговать,
        // когда остынут, а до того сидеть там, где копал (они до нас не доходят).
        if (Date.now() - (st.lastBreak || 0) < 33000) { await sleep(2000); continue }
        if (spare() <= 0) break
        if (await tryBarter(true)) continue
        // Пиглинов в 16 не видно — к ближайшему известному (до 48 блоков).
        const tr = nearestTrader(bot, 48)
        if (!tr || barterWalks >= 8) { st.lastBarter = st.lastBarter || 'пиглинов рядом нет'; break }
        barterWalks++
        const pg = tr.e
        await walkGoal(session, ctl, new goals.GoalNear(pg.position.x, pg.position.y, pg.position.z, 3), 15000, { dig: !tr.walk })
        barterNext = 0
        continue
      }
      // Закрытый штрек (sealed): вышка-обзор → золото по шаблону сквозь твёрдое.
      if (st.sealed && mode !== 'barter' && !st.sealedDone) {
        if (!st.pred.size && !st.gold.size && st.towered < 3) {
          // Вторая и третья вышка — ближе к видимому кирпичу бастиона (с первой вала не видно: booth-3, «basalt 0»).
          if (st.towered > 0) {
            survey(bot, st)
            const br = [...st.bricks.values()]
            const me0 = bot.entity.position
            const aim = br.length ? br.reduce((a, q) => a.plus(q), new Vec3(0, 0, 0)).scaled(1 / br.length) : new Vec3(rec.x, me0.y, rec.z)
            const dir = new Vec3(aim.x - me0.x, 0, aim.z - me0.z)
            const len = Math.hypot(dir.x, dir.z) || 1
            const step = Math.min(24, len)
            const tgt = new Vec3(me0.x + dir.x / len * step, me0.y, me0.z + dir.z / len * step)
            // После слепой вышки — с копкой: пешком из толщи не выйти (pit-v3-16 30.09: три вышки на одном месте).
            await walkUnlessBrute(session, ctl, new goals.GoalNear(tgt.x, tgt.y, tgt.z, 4), 25000, { dig: !!st.blindTower })
          }
          st.towered++
          await towerScan(session, ctl, st)
          continue
        }
        if (st.chestsOnly) {
          await sealedGold(session, ctl, st, Math.max(Date.now() + 60000, deadline - 300000))
          const made = await makeIronPick(session, ctl)
          log('железная кирка из сундуков', { made, ingots: countOf(bot, 'iron_ingot'), raw: countOf(bot, 'raw_iron'), nuggets: countOf(bot, 'iron_nugget'), blocks: countOf(bot, 'iron_block') })
          st.chestsOnly = false
          if (!made) { st.ironNeed = true; break }
          continue
        }
        if (st.pred.size || st.gold.size) {
          await sealedGold(session, ctl, st, mode === 'gold' ? deadline : Math.max(Date.now() + 60000, deadline - 240000))
          // Золото карты осталось — ходом по сетке к каждому (ND_GOLD_ROUTE=1).
          if (process.env.ND_GOLD_ROUTE === '1' && st.pred.size && !ctl.aborted) st.routeGold = await routeGold(session, ctl, st, mode === 'gold' ? deadline : Math.max(Date.now() + 60000, deadline - 200000))
          st.sealedDone = true
          goldPhaseEnd = Date.now()
          continue
        }
        // Бастион не узнан — в закрытом режиме не бродить по двору (старый обход: booth-3, две смерти в лаве).
        st.sealedDone = true
        st.notRecognized = true
        break
      }
      survey(bot, st)
      const t = nextTarget(bot, st)
      // Целей не видно, а слитков на бартер хватает — к пиглинам (они в 32
      // блоках слышны), а не бродить по точкам обзора.
      if (!t && mode !== 'gold' && spare() >= 24 && barterWalks < 6) {
        const tr0 = nearestTrader(bot, 32)
        if (tr0) {
          barterWalks++
          const pg0 = tr0.e
          await walkGoal(session, ctl, new goals.GoalNear(pg0.position.x, pg0.position.y, pg0.position.z, 3), 15000, { dig: !tr0.walk })
          barterNext = 0
          if (await tryBarter(true)) continue
        }
      }
      if (t) {
        idle = 0
        const r = t.kind === 'gold' ? await takeGoldBlock(session, ctl, t.pos, st) : await lootChest(session, ctl, t.pos, st)
        log(t.kind, { at: t.k, r, hp: Math.round(bot.health ?? 0), ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') })
        // Слитки на подкуп — из первого же блока.
        if (r === 'piglins' && !countOf(bot, 'gold_ingot') && countOf(bot, 'gold_block')) await unpackGold(session, ctl, 9)
        continue
      }
      // Видимых целей нет — узнать бастион сверху (вышка) и идти к золоту по
      // шаблону: предсказанные блоки в стенах (жилой: 17 золотых в двух стенах).
      if (!st.pred.size && st.towered < 2 && mode !== 'barter') {
        st.towered++
        await towerScan(session, ctl, st)
        continue
      }
      const pt = [...st.pred.entries()].filter(([k]) => (st.skip.get(k) || 0) < Date.now())
        .map(([k, v]) => ({ k, pos: v.pos, rank: v.rank || 0, d: v.pos.distanceTo(bot.entity.position) })).sort((a, c) => (a.rank - c.rank) || (a.d - c.d))[0]
      if (pt) {
        idle = 0
        const r = await digToPredicted(session, ctl, st, pt)
        log('к золоту по шаблону', { at: pt.k, ...r, left: st.pred.size, hp: Math.round(bot.health ?? 0), blocks: countOf(bot, 'gold_block') })
        continue
      }
      // Отложенные есть — подождать, пока пиглины разойдутся (или раздать слитки).
      const waiting = [...st.gold.keys()].some(k => (st.skip.get(k) || 0) >= Date.now())
      if (waiting && idle < 3) {
        idle++
        if (!countOf(bot, 'gold_ingot') && countOf(bot, 'gold_block')) await unpackGold(session, ctl, 9)
        await sleep(3000)
        continue
      }
      // Точка обзора: ближайшая непосещённая; восемь — и хватит искать.
      const me = bot.entity.position
      // Граница обхода: видимый кирпич бастиона вдали от того, где уже стоял
      // (12+ блоков), ниже — лучше (золото и сундуки у пола), ближе — лучше.
      // Точка из памяти — первый увиденный кирпич, край бастиона: кольцо
      // вокруг него ходило по одному углу (репетиция 2: 8 точек, 0 золота).
      st.been.push(me.clone())
      const bricks = [...st.bricks.values()]
      const minY = bricks.length ? Math.min(...bricks.map(b => b.y)) : me.y
      let next = null
      let best = Infinity
      for (const b of bricks) {
        if (st.been.some(v => v.distanceTo(b) < 12)) continue
        if (st.visited.has(keyOf(b))) continue
        const score = b.distanceTo(me) + 1.5 * (b.y - minY)
        if (score < best) { best = score; next = b }
      }
      if (!next) next = points.filter(q => !st.visited.has(keyOf(q))).sort((a, c) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(c.x - me.x, c.z - me.z))[0] || null
      if (!next || vantage >= 16) { goldPhaseEnd = Date.now(); if (mode === 'gold') break; continue }
      st.visited.add(keyOf(next))
      vantage++
      idle = 0
      // Сквозь стены бастиона — можно (чернокамень; охраняемое pathfinder не
      // ломает, лава под шагом — прыжок к полу).
      const w = await walkGoal(session, ctl, new goals.GoalNear(next.x, next.y + 1, next.z, 3), 20000, { dig: true })
      log('обзор', { to: xyz(next), ok: w && w.ok, at: xyz(bot.entity.position.floored()), gold: st.gold.size, chests: st.chestSeen.size, bricks: st.bricks.size })
    }
    // Добыча бартера, что легла дальше руки (за уступом, в яме) — собрать с копкой.
    // Не в закрытом штреке: pathfinder с копкой прорубал стену к добыче у окна —
    // после сцены в пролом входил брут (booth-1, pit-1: «slain by Piglin Brute» через 2–4 мин).
    if (!st.sealedState) await pickUp(bot, ctl, 10, 20000)
    const tossed = await dropJunk(bot)
    if (tossed.length) st.tossed.push(...tossed)
  } finally {
    try { bot.setControlState('sneak', false) } catch {}
    bot._client.removeListener('damage_event', onDmg)
    bot.removeListener('health', onHp)
    bot._ndToolFilter = toolFilter0
    if (st.lavaStrict0 !== undefined) bot._ndLavaStrict = st.lavaStrict0
    // Свои клетки бастиона (штрек к золоту и сундукам, яма) — в общую память штреков (и на диск): обратный путь
    // к порталу идёт по ним, а не вскрытием двора (разбор Codex 30.09: 2 смерти на обратном штреке у бастиона).
    try { if (st.sealedState && st.sealedState.own) require('./tunnel').rememberOwn(session, st.sealedState.own) } catch {}
  }
  try { memoSave() } catch {}
  const leftGold = [...st.gold.keys()].length
  // Золото по памяти (карта копии мира), до которого не нашлось пути, — не «кончилось»: neF-Pa25-1 02.10 — 4 блока,
  // «штрек: пути нет» к 26 целям, и кампания пометила бастион выработанным при 24 известных.
  const memLeft = [...st.pred.values()].filter(v => v.piece === 'память').length
  let stopped = null
  if (ctl.aborted) stopped = 'прервано'
  else if (st.notRecognized) stopped = 'бастион не узнан с вышек (стены с золотом по шаблону не видны) — в закрытом режиме по двору не хожу'
  else if (done()) stopped = null
  else if (spare() <= 0 && leftGold === 0 && memLeft > 0) stopped = `золото по памяти осталось (${memLeft}), пути к нему нет${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  else if (spare() <= 0 && leftGold === 0) stopped = `золото кончилось: видимых блоков больше нет${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  else if (Date.now() >= deadline - 20000) stopped = 'время вышло — позови ещё раз, продолжу'
  else if (st.lastBarter) stopped = `бартер встал: ${st.lastBarter}`
  return out(stopped)
}

module.exports = { exitReserveReady, handNoWalk, moveBarterSite, makeIronPick, burrowColumn, goldExposes, burrow, burrowIntent, bastion, angerSet, admiring, goldWorn, wearGold, PLACE, pitAt, trapAt, baitAim, dumpAim, tossLands, throwLands, pitLures, unholdGold, sealBody, pitJunk, dropJunk }
