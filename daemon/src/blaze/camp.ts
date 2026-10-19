'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../movement'
import { countOf, itemNamed } from '../items'
import { canUseRanged } from '../play-policy'
import { log, reachTo, ents, isRod, lavaNear, liveBlazes, bystanderOnLine, arrowsHave } from './targets'
import { hasEffect, drinkFireResistance } from './potions'
import { collectRods, makeTrack, walkNear } from './approach'
import { aimFrac } from './radar'

// ND_BLAZE_HOLE=1 — «яма у спавнера»: в клетке помоста вплотную к спавнеру выкопать 2 вниз и стоять в яме 1×1. Рамка удара
// иссушителя (2.4 в высоту, раздута только вширь — Mob.getAttackBoundingBox) с помоста не достаёт тело с ногами на −2
// (B5f22/B6f22/B11f31 03.10 — иссушители на помосте убивали за 16 с); блейз без луча к цели летит к ней
// (BlazeAttackGoal: lastSeen < 5 → setWantedPosition) и над ямой — в досягаемости меча снизу; стержень убитого над
// ямой падает в яму — подбирается сам. Нет убийств 75 с — выйти (столб из блоков под себя) и дальше по-старому.
async function holeCamp (session, ctl, { spawner, want, deadline, dead, setPhase, out, equipSword, shield, frLeft }: any) {
  const bot = session.bot
  const pick: typeof import('../pick') = require('../pick')
  const SL: typeof import('../sealed') = require('../sealed')
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
    const NR: typeof import('../nether-route') = require('../nether-route')
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
      const NR: typeof import('../nether-route') = require('../nether-route')
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
    const up = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, 1, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
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
    if (((bot.food ?? 20) <= 18 || ((bot.health ?? 20) < 14 && (bot.food ?? 20) < 20)) && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6)) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} ; await equipSword() }
    if ((bot.health ?? 20) < 7) { out.stopped = `хп ${Math.round(bot.health ?? 0)} в яме`; break }
    if (dead.size > kills0) { kills0 = dead.size; lastKill = gameClock.now() }
    const now = gameClock.now()
    const blazes = liveBlazes(bot, dead, 12)
    if (now - lastLog > 5000 && bot.inventory.emptySlotCount() < 3) { try { await (require('../nether-route') as typeof import('../nether-route')).makeRoom(bot, 5) } catch {} }
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
    const r = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    log('яма у спавнера: вышел', { ok: !!(r && r.ok), y: Math.round(bot.entity.position.y * 10) / 10 })
  }
  return { ok: true }
}

// Бой «у самого спавнера» под огнестойкостью (ND_BLAZE_CAMP=1, поток nether 03.10). Под зельем шар блейза не жжёт
// вовсе (fireball в #is_fire, LivingEntity.hurt), опасен только удар вплотную (6, в железе ~3.4 — BlazeAttackGoal).
// Блейзы спавнера появляются в ±4 от него и по высоте −1..+1 (BaseSpawner spawnRange 4) — стоять у самого спавнера.
// Иссушители спавнятся на кирпиче помоста и бьют вплотную (neF-B5f22-1 03.10: 3 блейза за 16 с, потом два иссушителя
// — 18 урона ударами и 6 иссушением за 16 с, смерть). Поэтому — столб в 3 блока на помосте: рамка удара моба — его
// рамка, раздутая по горизонтали (Mob.getAttackBoundingBox, 1.20.5+), по высоте — нет; иссушитель 2.4 в высоту, ноги
// тела на +3 — не достаёт. С вершины: меч по блейзам в досягаемости, лук по дальним. Стержни падают на помост — слезть
// (шаг со столба, 3 блока без урона), собрать, снова столб; иссушитель на помосте — сперва его луком сверху.
async function campSpawner (session, ctl, { spawner, want, deadline, dead, setPhase = () => {}, p = {} }: any) {
  const bot = session.bot
  const pick: typeof import('../pick') = require('../pick')
  const { potionOf }: typeof import('../pvp') = require('../pvp')
  const frLeft = () => bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
  let base = bot.entity.position.floored()
  const PILLAR = 3
  // Помост тронного зала — ноги на высоте спавнера (MonsterThrone: спавнер на помосте). «Наверху» — ноги на +2.6 и выше.
  const floorY = spawner ? spawner.y : base.y
  const out: any = { swings: 0, drinks: 0, picks: 0, fights: 0, shots: 0, towers: 0, descents: 0, wsShots: 0, rods0: countOf(bot, 'blaze_rod'), stopped: null, post: xyz(base) }
  const t0 = gameClock.now()
  let lastSwing = 0
  let lastLog = 0
  let lastAct = gameClock.now()
  let post = base
  const noShot = new Map()
  const swordOf = () => bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, b) => ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(b.name.split('_')[0]) - ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(a.name.split('_')[0]))[0]
  const equipSword = async () => { const sw = swordOf(); if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} } }
  const OTHER = /^(wither_skeleton|magma_cube|piglin_brute|hoglin|skeleton|zoglin)$/
  const fillers = () => { try { return (require('../sealed') as typeof import('../sealed')).fillerCount(bot) } catch { return 0 } }
  // Щит между взмахами: блейз вплотную бьёт раз в 20 тиков (6, в железе ~3.4 — и под огнестойкостью: удар не огонь;
  // neF-B5f31-1 03.10 — у спавнера 20 → 7 хп ударами за полторы минуты, смерть). Щит к нему, взмах — когда меч готов.
  let guard = null
  try { guard = (require('../combat') as typeof import('../combat')).makeShield(session, ctl, { shield: 'always' }) } catch {}
  let shieldOn = false
  const shield = async (on, face = null) => {
    if (!guard) return
    if (on && face) { try { await bot.lookAt(face, true) } catch {} }
    if (on && !shieldOn) { shieldOn = true; try { await guard.raise(true) } catch {} } else if (!on && shieldOn) { shieldOn = false; try { await guard.raise(false) } catch {} }
  }
  const onTop = () => bot.entity.position.y >= floorY + PILLAR - 0.4
  const bowReady = () => itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p)
  let climbFailAt = 0
  // Стенки «чашки» на вершине: блок у опоры (сбоку от верхнего блока столба) и на нём — у ног. Отдача удара блейза
  // скидывала тело со столба 1×1 к иссушителям (B8f23 03.10: дважды за 3 мин), а голова над стенками — бой как был.
  const cup = async () => {
    const { placeBlockAt }: typeof import('../build') = require('../build')
    const f = bot.entity.position.floored()
    let placed = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (ctl.aborted || fillers() < 2) break
      for (const dy of [-1, 0]) {
        const c = f.offset(dx, dy, dz)
        const b = bot.blockAt(c)
        if (!b || b.boundingBox === 'block') continue
        const r = await placeBlockAt(bot, c, { timeoutMs: 1200 }).catch(() => null)
        if (r && r.ok && !r.already) placed++
        else if (dy === -1) break
      }
    }
    return placed
  }
  const climb = async () => {
    if (onTop()) return true
    if (p.campPillar === false || fillers() < PILLAR) return false
    if (gameClock.now() - climbFailAt < 6000) return false
    // Столб — с пола у спавнера (помост, ступени, стенка: ±2 от уровня помоста — B11f31 03.10 стоял на +1 и столб
    // не строился, иссушитель убил).
    if (Math.abs(bot.entity.position.y - floorY) > 2.2 || !bot.entity.onGround) return false
    setPhase('лагерь: столб')
    post = bot.entity.position.floored()
    const r: Partial<Awaited<ReturnType<typeof import('../build').towerUp>>> = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, PILLAR, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    out.towers++
    let walls = 0
    if (onTop()) { bot.setControlState('sneak', true); walls = await cup() } else climbFailAt = gameClock.now()
    log('лагерь: столб', { ok: !!(r && r.ok), placed: r && r.placed, walls, reason: r && r.reason, y: Math.round(bot.entity.position.y * 10) / 10, post: xyz(post) })
    await equipSword()
    setPhase('лагерь у спавнера')
    return onTop()
  }
  // Лук по цели (блейз или иссушитель): точка — середина рамки с упреждением.
  const shootAt = async (e, frac = 0.55) => {
    const track = makeTrack(e)
    track.update()
    const r = await (require('../bow') as typeof import('../bow')).shoot(bot, e, {
      velFn: () => { track.update(); return track.vel() },
      point: t => { track.update(); const v = track.vel(); return e.position.offset(v.x * t, (e.height || 1.8) * frac + v.y * t, v.z * t) },
      follow: false,
      mode: 'settle',
      shouldStop: () => !e.isValid || liveBlazes(bot, dead, 6).some(b => reachTo(bot, b) <= 2.6)
    }).catch(err => ({ shot: false, why: err.message }))
    await equipSword()
    return r || { shot: false }
  }
  // Слезть со столба на помост: шаг в соседнюю клетку помоста (пол на уровне основания столба).
  let descWhy = ''
  const descend = async () => {
    descWhy = ''
    const f = bot.entity.position.floored()
    if (f.y - floorY > 5) { descWhy = 'высоко'; return false }
    const cells = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => new Vec3(f.x + dx, floorY, f.z + dz)).filter(c => {
      const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0))
      if (!a || !b || !u) return false
      if (a.boundingBox !== 'empty' || b.boundingBox !== 'empty' || u.boundingBox !== 'block' || /lava|fire|magma/.test(u.name)) return false
      // Столб над ней до нашей высоты — свободен.
      for (let y = c.y + 2; y <= f.y + 1; y++) { const q = bot.blockAt(new Vec3(c.x, y, c.z)); if (!q || q.boundingBox !== 'empty') return false }
      return !(spawner && c.x === spawner.x && c.z === spawner.z)
    })
    // Стенки чашки: в выбранную сторону — снести блок у ног и опору под ним (свои блоки, видно вплотную).
    const SL: typeof import('../sealed') = require('../sealed')
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let c = cells[0]
    if (!c) {
      for (const [dx, dz] of dirs) {
        const w0 = f.offset(dx, 0, dz); const w1 = f.offset(dx, -1, dz)
        const land = new Vec3(f.x + dx, floorY, f.z + dz)
        const u = bot.blockAt(land.offset(0, -1, 0)); const a = bot.blockAt(land)
        if (!u || u.boundingBox !== 'block' || /lava|fire|magma/.test(u.name) || !a || a.boundingBox !== 'empty') continue
        let clear = true
        for (let y = floorY + 1; y < f.y - 1; y++) { const q = bot.blockAt(new Vec3(land.x, y, land.z)); if (!q || q.boundingBox !== 'empty') { clear = false; break } }
        if (!clear) continue
        const r0 = await SL.digCell(bot, w0).catch(e => 'err ' + e.message)
        const r1 = await SL.digCell(bot, w1).catch(e => 'err ' + e.message)
        const b0 = bot.blockAt(w0); const b1 = bot.blockAt(w1)
        if (b0 && b0.boundingBox === 'empty' && b1 && b1.boundingBox === 'empty') { c = land; break }
        descWhy = `стенка ${xyz(w0)}: ${r0}/${r1}`
      }
    }
    if (!c) {
      // Шагнуть некуда (стоим над краем зала, у забора: B10f21 03.10 — 30 с наверху, 0 ударов) — копать вниз под собой:
      // свой блок/забор/стенку, по 1 клетке, пока ноги не у помоста (под колонной — твёрдое, без лавы).
      setPhase('лагерь: вниз копкой')
      bot.setControlState('sneak', false)
      for (let k = 0; k < 5 && !ctl.aborted && bot.entity.position.y >= floorY + 1.5; k++) {
        const g0 = bot.entity.position.floored()
        let landY = null
        for (let y = g0.y - 2; y >= floorY - 2; y--) { const q = bot.blockAt(new Vec3(g0.x, y, g0.z)); if (!q) break; if (/lava|fire/.test(q.name)) { landY = null; break } if (q.boundingBox === 'block') { landY = y; break } }
        if (landY == null || g0.y - 1 - landY > 4) { descWhy = `под собой пусто/лава (land ${landY})`; return false }
        const r = await SL.digCell(bot, g0.offset(0, -1, 0)).catch(() => 'err')
        if (r !== 'ok' && r !== 'air') { descWhy = 'копка вниз: ' + r; return false }
        for (let i = 0; i < 30 && !bot.entity.onGround; i++) await sleep(50)
        await sleep(150)
      }
      out.descents++
      if (bot.entity.position.y < floorY + 2.6) base = bot.entity.position.floored()
      return bot.entity.position.y < floorY + 2.6
    }
    setPhase('лагерь: вниз')
    bot.setControlState('sneak', false)
    const tx = c.x + 0.5; const tz = c.z + 0.5
    try {
      for (let i = 0; i < 30 && !ctl.aborted; i++) {
        const q = bot.entity.position
        if (Math.floor(q.x) === c.x && Math.floor(q.z) === c.z) break
        await bot.lookAt(new Vec3(tx, q.y + 1.6, tz), true).catch(() => {})
        bot.setControlState('forward', true)
        await sleep(50)
      }
    } finally { bot.setControlState('forward', false) }
    for (let i = 0; i < 40 && !bot.entity.onGround; i++) await sleep(50)
    out.descents++
    if (bot.entity.position.y < floorY + 1) base = bot.entity.position.floored()
    else descWhy = `шагнул к ${xyz(c)}, а стою на ${Math.round(bot.entity.position.y * 10) / 10}`
    return bot.entity.position.y < floorY + 1
  }
  // Основное место — на помосте у спавнера (блейзы появляются в ±4 и по высоте −1..+1 — там их и бить: B5f23 03.10,
  // на полу 14 убийств за 278 с; со столба +3 — 0–6 за 5–6 мин, B9f21/B9f23: блейз с лучом к цели не подлетает,
  // BlazeAttackGoal только стреляет). Столб с чашкой — укрытие от иссушителя (он не достаёт ноги на +3): забраться,
  // луком его сверху, слезть.
  // Место под стержни (рюкзак, набитый незераком после хода, не подбирал стержень в 1 бл.: B16f21 03.10).
  try { await (require('../nether-route') as typeof import('../nether-route')).makeRoom(bot, 6) } catch {}
  await equipSword()
  // Яма у спавнера (ND_BLAZE_HOLE=1): сверху — сперва вниз, потом яма; вышло мало — дальше гибрид как был.
  if (process.env.ND_BLAZE_HOLE === '1' && spawner) {
    if (onTop()) await descend()
    if (!onTop()) {
      out.want = want
      const hr = await holeCamp(session, ctl, { spawner, want, deadline, dead, setPhase, out, equipSword, shield, frLeft })
      out.holeResult = hr && hr.why
      // Остались в яме (время/без убийств/мало хп при живой огнестойкости) — лагерь на столбе не начинать, вернуть управление.
      if (bot.entity.position.y < floorY - 0.5 && out.hole && out.stopped !== 'набрал') { out.inHole = true; out.stopped = out.stopped || 'время вышло'; out.rods = countOf(bot, 'blaze_rod'); out.seconds = Math.round((gameClock.now() - t0) / 1000); out.kills = dead.size; log('лагерь итог', out); return out }
    }
  }
  let up = onTop()
  setPhase('лагерь у спавнера')
  const WS = /^(wither_skeleton|piglin_brute|hoglin|zoglin)$/
  while (!ctl.aborted && gameClock.now() < deadline) {
    const have = countOf(bot, 'blaze_rod')
    if (have >= want) { out.stopped = 'набрал'; break }
    if (!hasEffect(bot, 'fire_resistance')) {
      if (frLeft() > 0) {
        const d = await drinkFireResistance(bot).catch(e => e.message)
        out.drinks++
        for (let i = 0; i < 40 && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
        log('лагерь: огнестойкость', { d, left: frLeft(), on: hasEffect(bot, 'fire_resistance') })
        await equipSword()
        // Не подействовало (глоток прерван ударом/пакет эффекта запоздал: B17c21 03.10) — ещё раз, потом выход.
        if (!hasEffect(bot, 'fire_resistance')) { out.frMiss = (out.frMiss || 0) + 1; if (out.frMiss >= 3) { out.stopped = 'зелье не подействовало'; break } }
        continue
      }
      out.stopped = 'огнестойкость кончилась, зелий нет'
      break
    }
    // Сытость ≥ 19 — быстрое лечение (FoodData); есть, когда вплотную никого.
    if (((bot.food ?? 20) <= 18 || ((bot.health ?? 20) < 14 && (bot.food ?? 20) < 20)) && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6)) {
      try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {}
      await equipSword()
    }
    if ((bot.health ?? 20) < 7) { out.stopped = `хп ${Math.round(bot.health ?? 0)} — лагерь бросаю`; break }
    up = onTop()
    if (up !== !!bot.getControlState('sneak')) bot.setControlState('sneak', up)
    const me = bot.entity.position
    const now = gameClock.now()
    const blazes = liveBlazes(bot, dead, 20)
    const others = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.position && e.isValid !== false && OTHER.test(e.name || '') && e.position.distanceTo(me) < 12)
    // Иссушитель/брут рядом на уровне помоста (по горизонтали ≤ 8, по высоте ≤ 3) — угроза ближнего боя.
    // Только видимые (луч от глаз до груди): за стенами крепости иссушители есть всегда (B11f21 — наверху без спуска).
    const vis = e => { try { return (require('../perception') as typeof import('../perception')).raySees(bot, (require('../perception') as typeof import('../perception')).eyePos(bot), e.position.offset(0, (e.height || 1.8) * 0.6, 0)) } catch { return true } }
    const melee = others.filter((e : any) => WS.test(e.name) && Math.hypot(e.position.x - me.x, e.position.z - me.z) <= 8 && Math.abs(e.position.y - floorY) <= 3 && vis(e))
    if (now - lastLog > 5000 && bot.inventory.emptySlotCount() < 3) { try { await (require('../nether-route') as typeof import('../nether-route')).makeRoom(bot, 5) } catch {} }
    if (now - lastLog > 5000) { lastLog = now; log('лагерь', { t: Math.round((now - t0) / 1000), hp: Math.round(bot.health ?? 0), up, rods: have, blazes: blazes.length, ws: melee.length, swings: out.swings, shots: out.shots, picks: out.picks, kills: dead.size }) }
    if (!up && melee.length) {
      // Наверх (столб с чашкой); не вышло — бой.
      if (await climb()) { lastAct = gameClock.now(); continue }
      const foe: any = melee.filter(e => pick.canHit(bot, e, { range: 6 })).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
      if (foe && now - (noShot.get('f' + foe.id) || 0) > 5000) {
        out.fights++
        setPhase('лагерь: бой ' + foe.name)
        const tf = gameClock.now()
        const r = await (require('../combat') as typeof import('../combat')).fight(session, ctl, { target: '#' + foe.id, timeoutSeconds: 20, retreatAtHealth: 7, shield: 'always', clearArea: 0 }).catch(e => ({ error: e.message }))
        log('лагерь: чужой', { name: foe.name, killed: !!(r && (r.killed || (r.kills && r.kills.length))), hp: Math.round(bot.health ?? 0), ms: gameClock.now() - tf })
        if (gameClock.now() - tf < 1500) { noShot.set('f' + foe.id, gameClock.now()); await sleep(250) }
        await equipSword()
        setPhase('лагерь у спавнера')
        continue
      }
    }
    // Наверху и иссушитель внизу — луком его (сверху он не достаёт).
    if (up && melee.length) {
      const ws: any = melee.filter((e : any) => now - (noShot.get(e.id) || 0) > 2000).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
      if (ws && bowReady()) {
        setPhase('лагерь: лук по ' + ws.name)
        const r = await shootAt(ws, 0.6)
        if (r.shot) { out.wsShots++; lastAct = gameClock.now() } else noShot.set(ws.id, gameClock.now())
        if (onTop()) bot.setControlState('sneak', true)
        continue
      }
    }
    // Меч по блейзу в досягаемости; щит к ближнему между взмахами.
    const inReach = blazes.filter(e => reachTo(bot, e) <= 3.0 && pick.canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))
    if (inReach.length) {
      const e: any = inReach[0]
      if (now - lastSwing >= 640) {
        await shield(false)
        try { await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.6, 0), true) } catch {}
        try { bot.attack(e); lastSwing = gameClock.now(); out.swings++; lastAct = gameClock.now() } catch {}
        await sleep(60)
      }
      if (reachTo(bot, e) <= 2.4) await shield(true, e.position.offset(0, (e.height || 1.8) * 0.6, 0))
      await sleep(50)
      continue
    }
    if (shieldOn) await shield(false)
    // Наверху, иссушителей рядом нет — вниз, к спавнеру (там блейзы).
    if (up && !melee.length && !others.some((e : any) => WS.test(e.name) && e.position.distanceTo(me) < 10 && vis(e)) && now - (noShot.get('down') || 0) > 5000) {
      if (await descend()) { lastAct = gameClock.now(); continue }
      noShot.set('down', gameClock.now())
      log('лагерь: слезть не вышло', { at: xyz(bot.entity.position), floorY, why: descWhy })
    }
    // Стержни рядом на помосте — подобрать сразу (под зельем шары не страшны).
    if (!up && now - (noShot.get('rods') || 0) > 10000) {
      const rodsNear = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && isRod(e) && e.position.distanceTo(me) <= 7 && e.position.y >= floorY - 2.5 && !lavaNear(bot, e.position, 1))
      if (rodsNear.length) {
        setPhase('лагерь: стержни')
        const r0 = countOf(bot, 'blaze_rod')
        await collectRods(bot, ctl, 7, 4000)
        // Не прибавилось — эти стержни недостижимы (под спавнером, за забором): 10 с не пробовать (B13f21: 32 захода, 0).
        if (countOf(bot, 'blaze_rod') > r0) out.picks++
        else noShot.set('rods', gameClock.now())
        lastAct = gameClock.now()
        await equipSword()
        setPhase('лагерь у спавнера')
        continue
      }
    }
    // Блейз над помостом в 6 бл. и на высоте досягаемости — подойти под него по помосту (меч, а не лук: стержень
    // упадёт рядом; блейз с лучом сам не подлетает — BlazeAttackGoal).
    if (!up) {
      const chase: any = blazes.filter((e : any) => Math.hypot(e.position.x - me.x, e.position.z - me.z) <= 6 && e.position.y >= floorY - 1 && e.position.y <= floorY + 2.2 && now - (noShot.get('c' + e.id) || 0) > 4000)
        .map((e : any) => ({ e, c: new Vec3(Math.floor(e.position.x), floorY, Math.floor(e.position.z)) }))
        .filter(({ c }: any) => { const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0)); return a && b && u && a.boundingBox === 'empty' && b.boundingBox === 'empty' && u.boundingBox === 'block' && !/lava|fire|magma/.test(u.name) })
        .sort((a: any, b: any) => a.e.position.distanceTo(me) - b.e.position.distanceTo(me))[0]
      if (chase) {
        setPhase('лагерь: к блейзу')
        const w = await walkNear(bot, ctl, chase.c, 1, 2500)
        if (!w || !w.ok) noShot.set('c' + chase.e.id, gameClock.now())
        setPhase('лагерь у спавнера')
        continue
      }
    }
    // Дальние блейзы над помостом — луком (стержень упадёт на помост).
    const overFloor = e => !spawner || Math.hypot(e.position.x - spawner.x - 0.5, e.position.z - spawner.z - 0.5) <= 3.5
    const target: any = bowReady() ? blazes.filter((e : any) => { const d = e.position.distanceTo(me); return d >= 3.2 && d <= 16 && overFloor(e) && now - (noShot.get(e.id) || 0) > 2500 && aimFrac(bot, e) !== null && !bystanderOnLine(bot, e) }).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] : null
    if (target) {
      setPhase('лагерь: лук')
      const r = await shootAt(target, aimFrac(bot, target) ?? 0.55)
      if (r.shot) { out.shots++; lastAct = gameClock.now() } else noShot.set(target.id, gameClock.now())
      if (onTop()) bot.setControlState('sneak', true)
      setPhase('лагерь у спавнера')
      continue
    }
    // Внизу — вплотную к спавнеру (соседняя клетка помоста): новые блейзы появляются в ±4 от него — ближе к мечу.
    if (!up && spawner && Math.hypot(bot.entity.position.x - spawner.x - 0.5, bot.entity.position.z - spawner.z - 0.5) > 1.9 && now - (noShot.get('hug') || 0) > 8000) {
      const hug = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => new Vec3(spawner.x + dx, floorY, spawner.z + dz)).filter(c => {
        const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0))
        return a && b && u && a.boundingBox === 'empty' && b.boundingBox === 'empty' && u.boundingBox === 'block' && !/lava|fire|magma/.test(u.name)
      }).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
      if (hug) { const w = await walkNear(bot, ctl, hug, 0, 3000); if (!w || !w.ok) noShot.set('hug', gameClock.now()); else base = hug }
      else noShot.set('hug', gameClock.now())
      continue
    }
    await sleep(120)
  }
  try { await shield(false) } catch {}
  bot.setControlState('sneak', false)
  out.rods = countOf(bot, 'blaze_rod') - out.rods0
  out.seconds = Math.round((gameClock.now() - t0) / 1000)
  out.kills = dead.size
  if (!out.stopped) out.stopped = ctl.aborted ? 'прервано' : 'время вышло'
  log('лагерь итог', out)
  return out
}

export { campSpawner }
