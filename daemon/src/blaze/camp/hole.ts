'use strict'
// Лагерь у спавнера — яма у спавнера (ND_BLAZE_HOLE=1): holeCamp. Лагерь на столбе — blaze/camp.ts и соседние части.
import * as gameClock from '../../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../../movement'
import { countOf } from '../../items'
import { log, reachTo, liveBlazes } from '../targets'
import { hasEffect, drinkFireResistance } from '../potions'
import { walkNear } from '../approach'

// ND_BLAZE_HOLE=1 — «яма у спавнера»: в клетке помоста вплотную к спавнеру выкопать 2 вниз и стоять в яме 1×1. Рамка удара
// иссушителя (2.4 в высоту, раздута только вширь — Mob.getAttackBoundingBox) с помоста не достаёт тело с ногами на −2
// (B5f22/B6f22/B11f31 03.10 — иссушители на помосте убивали за 16 с); блейз без луча к цели летит к ней
// (BlazeAttackGoal: lastSeen < 5 → setWantedPosition) и над ямой — в досягаемости меча снизу; стержень убитого над
// ямой падает в яму — подбирается сам. Нет убийств 75 с — выйти (столб из блоков под себя) и дальше по-старому.
async function holeCamp (session, ctl, { spawner, want, deadline, dead, setPhase, out, equipSword, shield, frLeft }: any) {
  const bot = session.bot
  const pick: typeof import('../../pick') = require('../../pick')
  const SL: typeof import('../../sealed') = require('../../sealed')
  const floorY = spawner.y
  const solid = b => !!b && b.boundingBox === 'block'
  const hot = b => !!b && /lava|fire|magma/.test(b.name)
  // Клетка ямы: соседняя со спавнером клетка помоста, под ней 3 твёрдых (два копаем, на третьем стоим), без лавы рядом.
  const cand = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => new Vec3(spawner.x + dx, floorY, spawner.z + dz)).filter(c => {
    const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0))
    if (!a || !b || a.boundingBox !== 'empty' || b.boundingBox !== 'empty') return false
    for (const dy of [-1, -2, -3]) { const q = bot.blockAt(c.offset(0, dy, 0)); if (!solid(q) || hot(q)) return false }
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [-1, -2]) { const q = bot.blockAt(c.offset(x, dy, z)); if (!q || /lava/.test(q.name)) return false }
    return true
  }).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  if (!cand.length) { log('яма у спавнера: места нет', {}); return { ok: false, why: 'места нет' } }
  // Клетка — ближняя к телу; стоим уже в такой (в 1 бл. от спавнера) — копать здесь.
  const here = bot.entity.position.floored()
  let H = cand.find(c => c.equals(here)) || cand[0]
  setPhase('яма у спавнера')
  // Блейз вплотную — сперва бить (удар раз в секунду по 3.4 — пока копал, B13f31 03.10: смерть за 6 с).
  let lastSwing0 = 0
  const fightClose = async (ms = 4000) => {
    const t1 = gameClock.now()
    while (gameClock.now() - t1 < ms && !ctl.aborted) {
      const close: any = liveBlazes(bot, dead, 6).filter(e => reachTo(bot, e) <= 3.0 && pick.canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
      if (!close) return
      if (gameClock.now() - lastSwing0 >= 640) {
        await shield(false)
        try { await bot.lookAt(close.position.offset(0, (close.height || 1.8) * 0.5, 0), true) } catch {}
        try { bot.attack(close); lastSwing0 = gameClock.now(); out.swings++ } catch {}
        await sleep(60)
      }
      await shield(true, close.position.offset(0, (close.height || 1.8) * 0.5, 0))
      await sleep(80)
    }
    await shield(false)
  }
  // Снизу (тело ниже помоста — подход по сетке кончился под ним, s1-post14/15/18 06.10: y66 при помосте y68) — сразу в дно ямы
  // ходом сквозь кирпич: по помосту под ифритами не идти, выкапывать нечего.
  const atBottom = () => { const f = bot.entity.position.floored(); return f.x === H.x && f.z === H.z && f.y === floorY - 2 }
  if (!atBottom() && bot.entity.position.y < floorY - 0.5) {
    await fightClose()
    const NR: typeof import('../../nether-route') = require('../../nether-route')
    if (NR.enabled() && NR.gridOf(session)) {
      const rb = await NR.routeTo(session, ctl, { x: H.x, y: floorY - 2, z: H.z, r: 0, dy: 0, ironOk: true, timeoutSeconds: 40 }).catch(e => ({ ok: false, why: e.message }))
      log('яма у спавнера: снизу в дно', { ok: rb.ok, why: rb.why, at: xyz(bot.entity.position), bottom: atBottom() })
    }
  }
  if (!atBottom() && !bot.entity.position.floored().equals(H)) {
    await fightClose()
    // Соседняя клетка — шагом (walkNear с допуском 0 не входил в клетку рядом: B14f31 03.10 «не дошёл» за 1 бл.).
    if (bot.entity.position.floored().distanceTo(H) <= 1.5) await SL.stepMove(bot, ctl, { kind: 'flat', to: H }).catch(() => null)
    else {
      // Дальше соседней — ходом по сетке точно в клетку (walkNear не входил: B14f21 — «не дошёл» за 3 бл.).
      const NR: typeof import('../../nether-route') = require('../../nether-route')
      if (NR.enabled() && NR.gridOf(session)) await NR.routeTo(session, ctl, { x: H.x, y: H.y, z: H.z, r: 0, dy: 0, ironOk: true, timeoutSeconds: 30 }).catch(() => null)
      else await walkNear(bot, ctl, H, 0, 5000)
    }
    if (!bot.entity.position.floored().equals(H) && bot.entity.position.floored().distanceTo(H) <= 1.5) await SL.stepMove(bot, ctl, { kind: 'flat', to: H }).catch(() => null)
  }
  if (!atBottom() && !bot.entity.position.floored().equals(H)) {
    const alt = cand.find(c => c.equals(bot.entity.position.floored()))
    if (!alt) { log('яма у спавнера: не дошёл', { to: xyz(H), at: xyz(bot.entity.position) }); return { ok: false, why: 'не дошёл' } }
    H = alt
  }
  for (const dy of atBottom() ? [] : [-1, -2]) {
    await fightClose()
    let r = await SL.digCell(bot, H.offset(0, dy, 0)).catch(e => 'err ' + e.message)
    if (r !== 'ok' && r !== 'air') { await fightClose(); r = await SL.digCell(bot, H.offset(0, dy, 0)).catch(e => 'err ' + e.message) }
    if (r !== 'ok' && r !== 'air') { log('яма у спавнера: копка', { r, cell: xyz(H.offset(0, dy, 0)), block: (bot.blockAt(H.offset(0, dy, 0)) || {}).name, held: bot.heldItem && bot.heldItem.name }); return { ok: false, why: 'копка ' + r } }
    for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleep(50)
    await sleep(150)
  }
  const inHole = () => bot.entity.position.y < floorY - (process.env.ND_BLAZE_HOLE_DEPTH === '1' && out.hole ? 0.5 : 1.5)
  for (let i = 0; i < 10 && !inHole(); i++) await sleep(100)
  if (!inHole()) { log('яма у спавнера: не в яме', { at: xyz(bot.entity.position), y: Math.round(bot.entity.position.y * 10) / 10, H: xyz(H), below: [-1, -2, -3].map(dy => { const b = bot.blockAt(H.offset(0, dy, 0)); return b ? b.name : '?' }) }); return { ok: false, why: 'не в яме' } }
  out.hole = xyz(H)
  // ND_BLAZE_HOLE_DEPTH=1: из дна (−2) подняться на блок — глаза над полом помоста: ифриты у спавнера (пол..+2) видны и в
  // досягаемости меча, стержни с соседних клеток пола подбираются; в яме −2 они висели в 4–6 бл. вне досягаемости
  // (s1-post24/25hole 06.10: 150 с без убийств, 0 убийств).
  if (process.env.ND_BLAZE_HOLE_DEPTH === '1') {
    const up = await (require('../../build') as typeof import('../../build')).towerUp(bot, ctl, 1, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    out.holeDepth = Math.round((floorY - bot.entity.position.y) * 10) / 10
    log('яма у спавнера: глубина 1', { ok: !!(up && up.ok), y: Math.round(bot.entity.position.y * 10) / 10 })
  }
  log('яма у спавнера', { at: xyz(H), y: Math.round(bot.entity.position.y * 10) / 10 })
  await equipSword()
  let lastSwing = 0
  let lastKill = gameClock.now()
  let kills0 = dead.size
  let lastLog = 0
  while (!ctl.aborted && gameClock.now() < deadline) {
    if (countOf(bot, 'blaze_rod') >= out.want) { out.stopped = 'набрал'; break }
    if (!hasEffect(bot, 'fire_resistance')) {
      if (frLeft() > 0) { await drinkFireResistance(bot).catch(() => null); out.drinks++; for (let i = 0; i < 20 && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100); await equipSword(); continue }
      // В яме без зелья шары летят только сверху (видно — значит, и бьём) — продолжать, пока хп держится.
    }
    // Сытость ≥ 19 — быстрое лечение (FoodData: при 20 и насыщении — 1 хп за 10 тиков); есть, когда вплотную никого.
    if (((bot.food ?? 20) <= 18 || ((bot.health ?? 20) < 14 && (bot.food ?? 20) < 20)) && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6)) { try { await (require('../../actions') as typeof import('../../actions')).eat(session, {}) } catch {} ; await equipSword() }
    if ((bot.health ?? 20) < 7) { out.stopped = `хп ${Math.round(bot.health ?? 0)} в яме`; break }
    if (dead.size > kills0) { kills0 = dead.size; lastKill = gameClock.now() }
    const now = gameClock.now()
    const blazes = liveBlazes(bot, dead, 12)
    if (now - lastLog > 5000 && bot.inventory.emptySlotCount() < 3) { try { await (require('../../nether-route') as typeof import('../../nether-route')).makeRoom(bot, 5) } catch {} }
    if (now - lastLog > 5000) { lastLog = now; log('яма', { t: Math.round((now - lastKill) / 1000), hp: Math.round(bot.health ?? 0), rods: countOf(bot, 'blaze_rod'), blazes: blazes.length, near: blazes.filter((e : any) => e.position.distanceTo(bot.entity.position) < 4).length, swings: out.swings, kills: dead.size }) }
    const inReach = blazes.filter(e => reachTo(bot, e) <= 3.0 && pick.canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))
    if (inReach.length) {
      const e: any = inReach[0]
      if (now - lastSwing >= 640) {
        await shield(false)
        try { await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.5, 0), true) } catch {}
        try { bot.attack(e); lastSwing = gameClock.now(); out.swings++ } catch {}
        await sleep(60)
      }
      if (reachTo(bot, e) <= 2.4) await shield(true, e.position.offset(0, (e.height || 1.8) * 0.5, 0))
      await sleep(50)
      continue
    }
    await shield(false)
    // Под огнестойкостью ждать волну дольше: спавнер — раз в 10–40 с по 1–4, ифриты висят в 4–6 бл. и подлетают не сразу; выход из
    // ямы под ними — уход с безопасного места (s1-post21hole 06.10: «75 с без убийств» → бой по-старому → смерть после навыка).
    if (now - lastKill > (hasEffect(bot, 'fire_resistance') ? 150000 : 75000)) { out.stopped = `в яме ${hasEffect(bot, 'fire_resistance') ? 150 : 75} с без убийств`; break }
    await sleep(100)
  }
  // Выйти: столб из блоков под себя (2), до уровня помоста — только когда набрал или огнестойкости больше нет. По времени/без
  // убийств/на малом хп — остаться в яме: следующий вызов blaze продолжит отсюда (atBottom), а наверху между вызовами ифриты
  // добивали тело (s1-post21hole/22hole 06.10: вышел из ямы по времени — смерть до следующего вызова).
  const frAny = hasEffect(bot, 'fire_resistance') || frLeft() > 0
  if (inHole() && !ctl.aborted && (bot.health ?? 0) > 0 && (out.stopped === 'набрал' || !frAny)) {
    const r = await (require('../../build') as typeof import('../../build')).towerUp(bot, ctl, 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    log('яма у спавнера: вышел', { ok: !!(r && r.ok), y: Math.round(bot.entity.position.y * 10) / 10 })
  }
  return { ok: true }
}

export { holeCamp }
