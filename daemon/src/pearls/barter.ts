'use strict'
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { itemNamed, countOf, countItems, diffItems } from '../items'
import * as worlds from '../worlds'
import * as BF from '../barter-flow'
import { clamp, meta, seesMob, walkTo, pickUp } from './common'

const GOLD_ARMOR = ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots']
const ARMOR_SLOT = { golden_helmet: 5, golden_chestplate: 6, golden_leggings: 7, golden_boots: 8 }
const DEST = { golden_helmet: 'head', golden_chestplate: 'torso', golden_leggings: 'legs', golden_boots: 'feet' }
const ADMIRE_MS = 119 * 50

// ------------------------------------------------------------------ barter

function wornGold (bot) {
  for (const n of GOLD_ARMOR) {
    const it = bot.inventory.slots[ARMOR_SLOT[n]]
    if (it && it.name === n) return n
  }
  return null
}

// Кто в бастионе опасен при любом золоте (исходники 1.21.11, 2026-09-26):
//   * piglin_brute — золото его не успокаивает, бьёт всегда (13 урона на normal);
//   * hoglin — враждебен всегда.
// И что злит самих пиглинов (PiglinAi.angerNearbyPiglins, ANGER_DURATION 600
// тиков = 30 с): открыть сундук/бочку — тех, кто ВИДИТ (canSee), в ±16;
// сломать блок из #guarded_by_piglins (gold_block, gilded_blackstone, сундук,
// бочка, золотая руда, raw_gold_block) — ВСЕХ в ±16 без проверки взгляда
// (Block.playerWillDestroy → angerNearbyPiglins(…, false)); ударить пиглина.
function bastionThreats (bot) {
  const me = bot.entity.position
  const out = []
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || !e.position || e.isValid === false) continue
    const d = e.position.distanceTo(me)
    if (e.name === 'piglin_brute' && d <= 20 && seesMob(bot, e)) out.push({ name: e.name, dist: Math.round(d) })
    else if (e.name === 'hoglin' && d <= 12 && seesMob(bot, e)) out.push({ name: e.name, dist: Math.round(d) })
  }
  return out
}

// Клетки, куда дойти ногами (radius 20), и «стоит ли пиглин на такой»: ±1 по
// горизонтали и высоте от его ног.
function reachCells (bot) {
  const { walkable }: typeof import('../walkable') = require('../walkable')
  const set = new Set()
  try { for (const n of walkable(bot, bot.entity.position, { radius: 20, maxNodes: 3000 })) set.add(`${n.pos.x},${n.pos.y},${n.pos.z}`) } catch {}
  return set
}
function reachable (set, pos) {
  const f = pos.floored()
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
    if (set.has(`${f.x + dx},${f.y + dy},${f.z + dz}`)) return true
  }
  return false
}

async function barter (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 180, 20, 600) * 1000 - 4000
  if (worlds.worldOf(bot) !== 'the_nether') {
    return { mode: 'barter', traded: 0, stopped: 'пиглины живут в Аду; в верхнем мире они через 15 с становятся зомби-пиглинами — бартер только там' }
  }
  // Золото на теле — иначе пиглин нападает сам, едва увидит.
  let gold = wornGold(bot)
  if (!gold) {
    const spare = GOLD_ARMOR.map(n => itemNamed(bot, n)).find(Boolean)
    if (!spare) {
      return {
        mode: 'barter',
        traded: 0,
        need: { what: 'golden_helmet', count: 1, have: 0 },
        stopped: 'без золотой брони пиглины нападают сами (PiglinAi.isWearingSafeArmor: хватит одной вещи). Шлем: 5 золотых слитков на верстаке'
      }
    }
    try { await bot.equip(spare, DEST[spare.name]) } catch (e) { return { mode: 'barter', traded: 0, stopped: `не надел ${spare.name}: ${e.message}` } }
    gold = spare.name
  }
  const threats0 = bastionThreats(bot)
  if (threats0.length && !p.force) {
    return { mode: 'barter', traded: 0, threats: threats0, stopped: `рядом ${threats0.map(t => `${t.name} в ${t.dist}`).join(', ')} — эти бьют при любом золоте; отойти от них (или force:true)` }
  }
  const ingots0 = countOf(bot, 'gold_ingot')
  if (!ingots0) return { mode: 'barter', traded: 0, need: { what: 'gold_ingot', count: Math.max(1, p.count ?? 8), have: 0 }, stopped: 'слитков золота нет — меняют только gold_ingot' }
  const toTrade = Math.min(ingots0, Math.max(1, p.count ?? ingots0))
  const before = countItems(bot)
  const hp0 = Math.round(bot.health ?? 20)
  const busy = new Map() // пиглин -> когда вернётся к сделке
  let thrown = 0
  let handed = 0
  let picked = 0
  let stopped = null
  let nobodySince = 0
  const tosses = []
  if (BF.enabled()) { try { (require('../ne-guard') as typeof import('../ne-guard')).attach(session) } catch {} }

  // Счёт по рюкзаку, а не по броскам: пиглин, занятый прошлым слитком, новый
  // не берёт, и подбор добычи возвращает его нам (первый прогон: брошено 6,
  // в рюкзаке снова 2). Такой слиток бросается ещё раз.
  const spent = () => ingots0 - countOf(bot, 'gold_ingot')
  while (!ctl.aborted && gameClock.now() < deadline && spent() < toTrade && thrown < toTrade * 3) {
    const me = bot.entity.position
    if (BF.enabled()) {
      const G: typeof import('../ne-guard') = require('../ne-guard')
      if (G.busy(bot) || G.hot(bot)) { await G.react(session, ctl); stopped = 'страж прервал бартер'; break }
    }
    // Только те, до кого дойти ногами (заливка walkable): в бастионе пиглины
    // за стенами и на других этажах — к ним walkTo не доходил, слиток летел
    // броском, и его никто не брал (лаборатория бастиона, 2026-09-28: 188 с,
    // 20 бросков, 3 сделки). И не «рукой через стену»: пиглин в загоне за
    // стеной взял 17 слитков, а добыча легла у его ног в загоне (прогон 9).
    const reach = reachCells(bot)
    const piglins = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'piglin' && e.position && e.isValid !== false &&
      !meta(bot, e, 'baby') && e.position.distanceTo(me) <= 16 && seesMob(bot, e) && (busy.get(e.id) || 0) < gameClock.now() &&
      reachable(reach, e.position) && (!BF.enabled() || BF.ready(bot, e, busy)))
      .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
    if (!piglins.length) {
      const anyone = (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'piglin' && e.position && e.position.distanceTo(me) <= 16)
      if (!anyone) { stopped = 'взрослых пиглинов в 16 блоках не вижу'; break }
      // Есть, но ни до кого не дойти (за стеной, на другом этаже), а сделок в
      // работе нет — не ждать до конца срока (лаборатория: 176 с впустую).
      if (!nobodySince) nobodySince = gameClock.now()
      const trading = [...busy.values()].some(t => t > gameClock.now() && t - gameClock.now() < ADMIRE_MS + 1600)
      if (!trading && gameClock.now() - nobodySince > 10000) { stopped = 'пиглины рядом есть, но ни до одного не дойти (стены, другой этаж)'; break }
      // Все заняты разглядыванием — собрать то, что уже бросили к нам.
      const loot = (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(me) <= 8)
      if (loot && !BF.enabled()) picked += await pickUp(bot, ctl, 8, 2500)
      else await sleep(500)
      continue
    }
    nobodySince = 0
    const pg: any = piglins[0]
    const threats = bastionThreats(bot)
    if (threats.length && !p.force) { stopped = `подошли ${threats.map(t => `${t.name} в ${t.dist}`).join(', ')} — бросаю сделки`; break }
    const ingot = itemNamed(bot, 'gold_ingot')
    if (!ingot) break
    // Вручить (по умолчанию): PiglinAi.mobInteract — правый клик слитком по
    // взрослому, который ничего не разглядывает (canAdmire), кладёт слиток
    // ему в левую руку сразу: без полёта, без 40 тиков задержки подбора
    // брошенного и без малыша, который перехватит слиток и оставит себе.
    // Досягаемость по сущности — 3 блока (entity_interaction_range).
    if (p.how !== 'toss') {
      if (pg.position.distanceTo(bot.entity.position) > 2.6) {
        await walkTo(bot, ctl, pg.position.floored(), 1, Math.min(8000, deadline - gameClock.now()))
      }
      if (pg.isValid !== false && bot.entities[pg.id] && pg.position.distanceTo(bot.entity.position) <= 3.2) {
        const had = countOf(bot, 'gold_ingot')
        try {
          await bot.equip(ingot, 'hand')
          const aim = BF.enabled() ? (require('../pick') as typeof import('../pick')).aim(bot, pg) : null
          if (BF.enabled() && (!aim || !aim.point)) { busy.set(pg.id, gameClock.now() + 1000); continue }
          await bot.lookAt(aim ? aim.point : pg.position.offset(0, 1.2, 0), true)
          await bot.activateEntity(pg)
        } catch (e) { stopped = `слиток не вручил: ${e.message}`; break }
        await sleep(350)
        if (countOf(bot, 'gold_ingot') < had) {
          thrown++
          handed++
          tosses.push({ piglin: pg.id, handed: true })
          busy.set(pg.id, gameClock.now() + ADMIRE_MS + (BF.enabled() ? 150 : 1500))
        } else {
          // Не взял: уже держит золото или злой — к следующему.
          busy.set(pg.id, gameClock.now() + 4000)
        }
        if (BF.enabled() || piglins.length > 1) continue
        await sleep(ADMIRE_MS)
        picked += await pickUp(bot, ctl, 8, 4000)
        continue
      }
    }
    if (BF.enabled() && p.how !== 'toss') { busy.set(pg.id, gameClock.now() + 1000); continue }
    // Бросок: не подошёл на 3 блока (стена, лава) или how:'toss'. Пиглин идёт
    // за предметом только ближе 9 — и только если дойдёт до него: дальше 6
    // блоков не бросать (слиток лежал, пиглин стоял за стеной).
    if (p.how !== 'toss' && pg.position.distanceTo(bot.entity.position) > 6) { busy.set(pg.id, gameClock.now() + 8000); continue }
    if (pg.position.distanceTo(bot.entity.position) > 4) {
      await walkTo(bot, ctl, pg.position.floored(), 3, Math.min(10000, deadline - gameClock.now()))
    }
    try {
      await bot.lookAt(pg.position.offset(0, 0.2, 0), true)
      await bot.toss(ingot.type, null, 1)
      thrown++
      tosses.push({ piglin: pg.id, dist: Math.round(pg.position.distanceTo(bot.entity.position) * 10) / 10 })
      busy.set(pg.id, gameClock.now() + ADMIRE_MS + 1500)
    } catch (e) {
      stopped = `слиток не бросил: ${e.message}`
      break
    }
    await sleep(700)
    // Пиглинов несколько — следующему можно бросать, пока этот разглядывает.
    if (piglins.length > 1) continue
    // Один — ждать его сделки и подобрать то, что он бросил к нам.
    await sleep(ADMIRE_MS)
    picked += await pickUp(bot, ctl, 8, 4000)
  }
  // Последние сделки ещё идут — дождаться и подобрать.
  if (thrown && !ctl.aborted) {
    await sleep(Math.min(ADMIRE_MS + 1500, Math.max(0, deadline - gameClock.now())))
    picked += await pickUp(bot, ctl, 8, 6000)
  }
  const got = diffItems(before, countItems(bot))
  const gained: any = {}
  for (const [k, v] of ((Object.entries(got) as [string, any][]) as any)) if (v > 0) gained[k] = v
  const pearls = gained.ender_pearl || 0
  const detail: any = {
    mode: 'barter',
    wearing: gold,
    thrown,
    handed,
    spent: spent(),
    ingotsLeft: countOf(bot, 'gold_ingot'),
    gained,
    pearls,
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    tosses: tosses.slice(-8),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (stopped) detail.stopped = stopped
  detail.note = `Отдал ${detail.spent} слитк(ов) (бросков ${thrown}), выменял: ${(Object.entries(gained) as [string, any][]).map(([k, v]) => `${k}×${v}`).join(', ') || 'ничего не подобрал'}. ` +
    `Жемчуга ${pearls} — игра даёт его в 2.1% сделок (2–4 шт.), ~15 слитков на жемчужину; эндермены выгоднее.`
  return detail
}

export { barter }
