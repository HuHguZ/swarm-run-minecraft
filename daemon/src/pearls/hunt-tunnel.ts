'use strict'
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { countOf, missingHarvestTool, bestWeapon } from '../items'
import { SWING_MS, clamp, log, meta, ents, walkTo, CARDINAL, digCell, stepInto } from './common'
import { clearRay, eyesSeen, reachTo, lavaAround } from './aim'
import { trappedEm } from './shelter'

// ------------------------------------------------------------ hunt: штрек
// Штрек 1x2 в стене (style: 'tunnel', по умолчанию). Лаборатория 2026-09-27:
// дуэли в открытую — 4 смерти из 4 за 1.5–3 мин (второй злой, пиглины), нора
// «шахта + штрек» — злые к шахте не идут (путь к нам не строится). Здесь путь
// есть: вход штрека — клетка S на земле (над ней 3 блока воздуха), мы — в
// двух клетках вглубь, штрек высотой 2. Эндермен (2.9) в штрек не влезает и
// встаёт в S; его удар (коробка +0.83 по горизонтали) до нас не достаёт
// (1.13 < 1.7), наш меч до его коробки — 1.7 от глаз. Злим взглядом из штрека.
function tunnelSpot (bot, mcData, feet) {
  const solid = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'block' }
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  const lava = bot.registry.blocksByName.lava.id
  if (!solid(feet.offset(0, -1, 0)) || !air(feet) || !air(feet.offset(0, 1, 0)) || !air(feet.offset(0, 2, 0))) return null
  for (const [dx, dz] of CARDINAL) {
    let ok = true
    for (let k = 1; k <= 3 && ok; k++) {
      const c = feet.offset(dx * k, 0, dz * k)
      // Пол, ноги, голова — в стене; над головой — потолок (штрек высотой 2).
      if (!solid(c.offset(0, -1, 0)) || !solid(c.offset(0, 2, 0))) ok = false
      if (k <= 2) for (const q of [c, c.offset(0, 1, 0)]) { const b = bot.blockAt(q); if (!b || (b.boundingBox === 'block' && missingHarvestTool(bot, b, mcData))) ok = false }
    }
    if (!ok) continue
    let hot = false
    for (let x = -2; x <= 2 && !hot; x++) for (let y = -1; y <= 3 && !hot; y++) for (let z = -2; z <= 2 && !hot; z++) {
      const b = bot.blockAt(feet.offset(dx * 2 + x, y, dz * 2 + z))
      if (b && (b.type === lava || /water/.test(b.name))) hot = true
    }
    if (hot) continue
    return { mouth: feet, dir: [dx, dz] }
  }
  return null
}

async function digTunnel (bot, ctl, mcData, { radius = 28, exclude = [] }: any = {}) {
  const { walkable }: typeof import('../walkable') = require('../walkable')
  // Место — где от входа видно больше всего глаз эндерменов в 8..24 (лес
  // закрывает обзор: штрек 1 в лесу за 3 минуты не увидел ни одного).
  let spot = null
  {
    const ems = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false)
    let best = null
    let checked = 0
    for (const x of walkable(bot, bot.entity.position, { radius, maxNodes: 8000 })) {
      if (exclude.some(m => m.distanceTo(x.pos) < 8)) continue
      const sp = tunnelSpot(bot, mcData, x.pos)
      if (!sp) continue
      if (++checked > 160) break
      const eye = x.pos.offset(0.5, 1.62, 0.5)
      let seen = 0
      for (const e of (ems as any)) { const d = e.position.distanceTo(eye); if (d >= 6 && d <= 32 && !trappedEm(bot, e) && clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++ }
      const score = seen * 10 - x.d * 0.2
      if (!best || score > best.score) best = { pos: x.pos, seen, score }
    }
    if (best) log('место штрека', { at: xyz(best.pos), eyesSeen: best.seen, checked })
    if (best && best.pos.equals(bot.entity.position.floored())) spot = tunnelSpot(bot, mcData, best.pos)
    var n = best ? { pos: best.pos } : null
  }
  if (!spot) {
    if (!n) return { ok: false, why: 'стены для штрека (2 блока высотой, потолок, без лавы) рядом нет' }
    await walkTo(bot, ctl, n.pos, 0, 20000)
    if (!bot.entity.position.floored().equals(n.pos)) await stepInto(bot, n.pos)
    spot = tunnelSpot(bot, mcData, bot.entity.position.floored())
    if (!spot) return { ok: false, why: 'до места штрека не дошёл' }
  }
  const [dx, dz] = spot.dir
  const c1 = spot.mouth.offset(dx, 0, dz)
  const c2 = spot.mouth.offset(2 * dx, 0, 2 * dz)
  for (const c of [c1.offset(0, 1, 0), c1, c2.offset(0, 1, 0), c2]) {
    const err = await digCell(bot, mcData, c)
    if (err) return { ok: false, why: err }
  }
  if (!(await stepInto(bot, c1)) || !(await stepInto(bot, c2))) return { ok: false, why: 'в штрек не шагнул' }
  try { await bot.lookAt(spot.mouth.offset(0.5, 1.2, 0.5), true) } catch {}
  return { ok: true, mouth: spot.mouth, c1, stand: c2, dir: spot.dir }
}

// ------------------------------------------------------------ будка
// Штрек без стены: 1x2 из булыжника на месте с обзором (прогоны 54–55: у
// стен в лесу глаз почти не видно — 1 убийство за 7 мин). Мы в c2 (P), c1 —
// перед нами, вход S — ещё дальше, на нём встаёт эндермен (рост 2.9 в c1 под
// крышей высотой 2 не лезет). Стены на ноги и голову у c2 и c1, задняя — в 3
// блока (опора крыши), задние углы (иначе удар по диагонали сзади: его коробка
// удара +0.83 по горизонтали достаёт соседнюю клетку наискосок), крыша над c2
// и c1. До 17 блоков. Из c2 до S — 2 блока: он не достаёт, меч достаёт (1.7).
function safeGround (bot, f) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      let depth = 0
      for (let dy = -1; dy >= -5; dy--) {
        const b = bot.blockAt(f.offset(dx, dy, dz))
        if (!b) break
        if (/lava/.test(b.name)) return false
        if (b.boundingBox === 'block') break
        depth++
      }
      if (depth > 3) return false
    }
  }
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 1; dy++) { const b = bot.blockAt(f.offset(dx, dy, dz)); if (b && /lava/.test(b.name)) return false }
  return true
}
function boothSite (bot, P, d) {
  const [dx, dz] = d
  const sx = -dz; const sz = dx
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/water|lava|fire/.test(b.name) }
  const solid = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'block' }
  const c1 = P.offset(dx, 0, dz)
  const S = P.offset(2 * dx, 0, 2 * dz)
  if (!solid(P.offset(0, -1, 0)) || !solid(c1.offset(0, -1, 0)) || !solid(S.offset(0, -1, 0))) return null
  for (const c of [P, c1]) if (!air(c) || !air(c.offset(0, 1, 0))) return null
  if (!air(S) || !air(S.offset(0, 1, 0)) || !air(S.offset(0, 2, 0))) return null
  const back = P.offset(-dx, 0, -dz)
  const corners = [back.offset(sx, 0, sz), back.offset(-sx, 0, -sz)]
  const sides2 = [P.offset(sx, 0, sz), P.offset(-sx, 0, -sz)]
  const sides1 = [c1.offset(sx, 0, sz), c1.offset(-sx, 0, -sz)]
  const order = []
  for (const w of corners) order.push(w, w.offset(0, 1, 0))
  order.push(back, back.offset(0, 1, 0), back.offset(0, 2, 0))
  for (const w of sides2) order.push(w, w.offset(0, 1, 0))
  for (const w of sides1) order.push(w, w.offset(0, 1, 0))
  order.push(P.offset(0, 2, 0), c1.offset(0, 2, 0))
  let need = 0
  for (const c of order) {
    const b = bot.blockAt(c)
    if (!b || /water|lava/.test(b.name)) return null
    if (b.boundingBox !== 'block') need++
  }
  return { P, c1, S, dir: d, order, need, critical: [back, back.offset(0, 1, 0), ...sides2, ...sides2.map(w => w.offset(0, 1, 0)), ...sides1, ...sides1.map(w => w.offset(0, 1, 0)), ...corners, P.offset(0, 2, 0), c1.offset(0, 2, 0)] }
}
function boothPlan (bot, { radius = 32, exclude = [] }: any = {}) {
  const { walkable }: typeof import('../walkable') = require('../walkable')
  const ems = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !trappedEm(bot, e))
  const nodes = walkable(bot, bot.entity.position, { radius, maxNodes: 6000 })
  let best = null
  let checked = 0
  for (let i = 0; i < nodes.length && checked < 300; i += 2) {
    const n = nodes[i]
    if (exclude.some(m => m.distanceTo(n.pos) < 8)) continue
    for (const d of CARDINAL) {
      const site = boothSite(bot, n.pos, d)
      if (!site) continue
      if (!safeGround(bot, n.pos)) break
      checked++
      const eye = site.S.offset(0.5, 1.62, 0.5)
      let seen = 0
      for (const e of (ems as any)) { const dd = e.position.distanceTo(eye); if (dd >= 6 && dd <= 32 && clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++ }
      const score = seen * 10 - n.d * 0.3 - site.need * 0.5
      if (!best || score > best.score) best = { ...site, seen, score, steps: n.d, checked }
    }
  }
  return best
}
async function buildBooth (bot, ctl, mcData, { radius = 32, exclude = [] }: any = {}) {
  const { placeBlockAt, FILLER }: typeof import('../build') = require('../build')
  const plan = boothPlan(bot, { radius, exclude })
  if (!plan) return { ok: false, why: 'места под будку (ровно, S на 3 воздуха, без лавы и обрыва) нет' }
  log('место будки', { at: xyz(plan.P), dir: plan.dir, seen: plan.seen, need: plan.need, steps: plan.steps })
  const have = bot.inventory.items().filter(i => FILLER.includes(i.name) && !/sand|gravel/.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (plan.need > have) return { ok: false, why: `на будку нужно ${plan.need} блоков, есть ${have}` }
  await walkTo(bot, ctl, plan.P, 0, 20000)
  if (!bot.entity.position.floored().equals(plan.P)) await stepInto(bot, plan.P)
  if (!bot.entity.position.floored().equals(plan.P)) return { ok: false, why: 'до места будки не дошёл' }
  try { await (require('../fortify') as typeof import('../fortify')).centerInCell(bot, 700) } catch {}
  let placed = 0
  const failed = []
  for (const c of plan.order) {
    if (ctl.aborted) break
    const b = bot.blockAt(c)
    if (b && b.boundingBox === 'block') continue
    if (b && b.name !== 'air' && b.name !== 'cave_air') { try { await bot.dig(b) } catch {} }
    let r = null
    for (let k = 0; k < 2 && !(r && r.ok); k++) r = await placeBlockAt(bot, c, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
    if (r && r.ok) { if (!r.already) placed++ } else failed.push(`${c.x},${c.y},${c.z}:${r ? r.reason : '?'}`)
  }
  const holes = plan.critical.filter(c => { const b = bot.blockAt(c); return !b || b.boundingBox !== 'block' })
  if (holes.length) return { ok: false, why: `будка не достроена: дыр ${holes.length}`, failed: failed.slice(0, 4), placed }
  try { await bot.lookAt(plan.S.offset(0.5, 1.2, 0.5), true) } catch {}
  return { ok: true, mouth: plan.S, c1: plan.c1, stand: plan.P, dir: plan.dir, booth: true, placed, seen: plan.seen }
}

async function huntTunnel (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const rounds = []
  const dead = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || !e.position || e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
  }
  const onGone = e => onDead(e, 'gone')
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  let stopped = null
  let tun = null
  let kills = 0
  let aggros = 0
  let drops = 0
  let moves = 0
  const mouths = []
  const skip = new Map() // не разозлился — до
  const angrySince = new Map() // злой с
  const ignore = new Map() // злой, но не идёт — до
  const weapon = bestWeapon(bot)
  const isPearl = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'ender_pearl' } catch { return false } }
  const endermen = () => ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id))
  const skipped = e => (skip.get(e.id) || 0) > gameClock.now()
  const ignored = e => (ignore.get(e.id) || 0) > gameClock.now()
  // Злые, что ещё идут к нам. В штреке их можно ждать сколько угодно: у входа
  // встаёт только один (рост 2.9 в штрек 1x2 не лезет), бьём его из глубины.
  const pending = () => endermen().filter((e : any) => meta(bot, e, 'creepy') && !ignored(e) && e.position.distanceTo(bot.entity.position) < 40)
  const nearMouth = r => endermen().some((e : any) => meta(bot, e, 'creepy') && !ignored(e) && e.position.distanceTo(tun.mouth.offset(0.5, 0, 0.5)) < r)
  const stare = async (target, ms) => {
    const tS = gameClock.now()
    while (!ctl.aborted && gameClock.now() - tS < ms && !meta(bot, target, 'creepy') && target.isValid !== false) {
      if (eyesSeen(bot, target)) await bot.lookAt(target.position.offset(0, 2.55, 0), true).catch(() => {})
      await sleep(100)
    }
    const ok = !!meta(bot, target, 'creepy')
    if (ok) aggros++
    else skip.set(target.id, gameClock.now() + 30000)
    return ok
  }
  const targetsFrom = (me, max = 32) => endermen().filter(e => !skipped(e) && !meta(bot, e, 'creepy') && !trappedEm(bot, e))
    .filter((e : any) => { const d = e.position.distanceTo(me); return d >= 6 && d <= max })
    .filter(e => eyesSeen(bot, e))
    .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
  const home = async () => {
    const f = bot.entity.position.floored()
    if (f.equals(tun.stand)) return
    if (!f.equals(tun.c1) && !f.equals(tun.mouth)) await walkTo(bot, ctl, tun.mouth, 0, 8000)
    if (!bot.entity.position.floored().equals(tun.c1)) await stepInto(bot, tun.c1)
    await stepInto(bot, tun.stand)
    try { await bot.lookAt(tun.mouth.offset(0.5, 0.8, 0.5), true) } catch {}
  }
  // Лут падает там, где он умер (у входа): шаг в c1 подбирает всё у входа
  // (подбор — коробка тела +1). Откатился дальше — дойти, если злых нет.
  const collect = async (at) => {
    const items = () => (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(at) < 8 && !lavaAround(bot, e.position))
    await sleep(900)
    let seen = items()
    if (!seen.length) { await sleep(1200); seen = items() }
    const res: any = { drop: seen.length }
    if (!seen.length) return res
    drops++
    const had = countOf(bot, 'ender_pearl')
    if (!endermen().some(e => reachTo(bot, e) <= 3.2)) { await stepInto(bot, tun.c1); await sleep(700) }
    for (const it of (items() as any)) {
      if (countOf(bot, 'ender_pearl') > had || nearMouth(10) || ctl.aborted) break
      await walkTo(bot, ctl, it.position.floored(), 0, 5000)
      await sleep(400)
    }
    res.got = countOf(bot, 'ender_pearl') - had
    await home()
    return res
  }
  let lastChance = gameClock.now()
  try {
    // Будка на месте с обзором; не вышла — штрек в стене.
    tun = p.booth === false ? { ok: false } : await buildBooth(bot, ctl, mcData, { radius: 32 })
    if (!tun.ok) { log('будка', tun); tun = await digTunnel(bot, ctl, mcData, { radius: 40 }) }
    log('штрек', tun.ok ? { mouth: xyz(tun.mouth), stand: xyz(tun.stand), booth: !!tun.booth, seen: tun.seen, placed: tun.placed } : tun)
    if (!tun.ok) { stopped = tun.why; tun = null }
    while (tun && !ctl.aborted) {
      if (countOf(bot, 'ender_pearl') >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      if (!bot.entity.position.floored().equals(tun.stand)) await home()
      const all = endermen()
      // Злой 25 с и не у входа — застрял: не ждать его.
      for (const e of (all as any)) {
        if (!meta(bot, e, 'creepy')) { angrySince.delete(e.id); continue }
        if (!angrySince.has(e.id)) angrySince.set(e.id, gameClock.now())
        else if (gameClock.now() - angrySince.get(e.id) > 25000 && reachTo(bot, e) > 3.2) ignore.set(e.id, gameClock.now() + 60000)
      }
      // 1. У входа — бить в тело (в глаза не смотреть: ближе 4 — телепорт).
      const near: any = all.filter(e => reachTo(bot, e) <= 3.0).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
      if (near) {
        if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
        const r: any = { id: near.id, t: Math.round((gameClock.now() - t0) / 1000), swings: 0 }
        const hpA = bot.health ?? 20
        let last = 0
        const tA = gameClock.now()
        while (!ctl.aborted && gameClock.now() - tA < 20000 && near.isValid !== false && !dead.has(near.id)) {
          if (reachTo(bot, near) > 3.2) { await sleep(100); if (gameClock.now() - tA > 6000) break; continue }
          try { await bot.lookAt(near.position.offset(0, 1.0, 0), true) } catch {}
          if (gameClock.now() - last >= SWING_MS) { try { bot.attack(near); r.swings++; last = gameClock.now() } catch {} }
          await sleep(60)
        }
        await sleep(200)
        r.killed = dead.has(near.id)
        r.hpLost = Math.round((hpA - (bot.health ?? 20)) * 10) / 10
        if (r.killed) {
          kills++
          Object.assign(r, await collect(near.position.clone()))
        } else skip.set(near.id, gameClock.now() + 20000)
        r.pearls = countOf(bot, 'ender_pearl')
        rounds.push(r)
        log('штрек: бой', r)
        continue
      }
      if ((bot.food ?? 20) <= 16) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} }
      // 2. Злых в пути трое и больше — ждать их у входа.
      if (pending().length >= 3) { await sleep(300); continue }
      // 3. Злить отсюда (из глубины видно узко).
      const here = targetsFrom(bot.entity.position)
      if (here.length) {
        lastChance = gameClock.now()
        await stare(here[0], 5000)
        try { await bot.lookAt(tun.mouth.offset(0.5, 0.8, 0.5), true) } catch {}
        continue
      }
      // 3б. Глаз не видно (искажённый лес: грибы и лозы — на ферме 60–80
      // эндерменов в 48 блоках и 0 видимых глаз): разозлить УДАРОМ спокойного у
      // входа (удар злит без взгляда и без телепорта — EnderMan.hurtServer) и
      // сразу назад в штрек: злой идёт за нами к входу, внутрь (рост 2.9 в
      // 1x2) не лезет, бьём его из глубины. На земле дуэль с двумя-тремя злыми
      // стоила смерти в 4 прогонах из 5.
      if (!nearMouth(10) && !pending().length && p.poke !== false) {
        const mouthC = tun.mouth.offset(0.5, 0, 0.5)
        const pool = endermen()
        const calm: any = pool.filter((e : any) => !meta(bot, e, 'creepy') && !skipped(e) && !trappedEm(bot, e) && e.position.distanceTo(mouthC) <= 14 &&
          Math.abs(e.position.y - mouthC.y) <= 3 && !pool.some((o : any) => o !== e && o.position.distanceTo(e.position) < 4))
          .sort((a: any, b: any) => a.position.distanceTo(mouthC) - b.position.distanceTo(mouthC))[0]
        if (calm) {
          const pk: any = { id: calm.id, from: Math.round(calm.position.distanceTo(mouthC)) }
          await stepInto(bot, tun.c1)
          await stepInto(bot, tun.mouth)
          const pick: typeof import('../pick') = require('../pick')
          const cap = () => { if (bot.entity && bot.entity.pitch > -0.45) bot.entity.pitch = -0.45 }
          bot.on('physicsTick', cap)
          bot._ndNoMobAvoid = true
          const tP = gameClock.now()
          try {
            while (!ctl.aborted && gameClock.now() - tP < 9000 && calm.isValid !== false && bot.entities[calm.id] && !meta(bot, calm, 'creepy')) {
              if (reachTo(bot, calm) <= 2.9) {
                const a = pick.aim(bot, calm)
                if (a && a.point) {
                  if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
                  try { await bot.lookAt(calm.position.offset(0, 0.6, 0), true) } catch {}
                  try { bot.attack(calm); pk.hit = true } catch {}
                  break
                }
              }
              await walkTo(bot, ctl, calm.position.floored(), 1, 2500)
            }
          } finally {
            bot._ndNoMobAvoid = false
            bot.removeListener('physicsTick', cap)
          }
          await home()
          pk.angry = !!meta(bot, calm, 'creepy')
          pk.s = Math.round((gameClock.now() - tP) / 1000)
          log('штрек: удар-вызов', pk)
          if (pk.angry) { aggros++; lastChance = gameClock.now() } else skip.set(calm.id, gameClock.now() + 30000)
          continue
        }
      }
      // 4. Выйти ко входу (злых у входа в 10 нет): злить до двух подряд, назад.
      if (!nearMouth(10)) {
        await stepInto(bot, tun.c1)
        await stepInto(bot, tun.mouth)
        const out = targetsFrom(bot.entity.position)
        if (out.length) lastChance = gameClock.now()
        let n = 0
        for (const t of out.slice(0, 4)) {
          if (n >= 2 || nearMouth(8) || ctl.aborted) break
          if (!eyesSeen(bot, t)) continue
          if (await stare(t, 4000)) n++
        }
        if (n) log('штрек: разозлил у входа', { n, seen: out.length })
        await stepInto(bot, tun.c1)
        await stepInto(bot, tun.stand)
        try { await bot.lookAt(tun.mouth.offset(0.5, 0.8, 0.5), true) } catch {}
        if (!n) await sleep(700)
      } else await sleep(300)
      // 5. Две минуты некого злить — новый штрек в 40 блоках (до 3 раз).
      if (gameClock.now() - lastChance > 120000 && !pending().length && moves < 3) {
        moves++
        mouths.push(tun.mouth)
        const old = tun
        await stepInto(bot, tun.c1)
        await stepInto(bot, tun.mouth)
        let t2: any = p.booth === false ? { ok: false } : await buildBooth(bot, ctl, mcData, { radius: 32, exclude: mouths })
        if (!t2.ok) t2 = await digTunnel(bot, ctl, mcData, { radius: 40, exclude: mouths })
        log('штрек: новое место', t2.ok ? { mouth: xyz(t2.mouth), n: moves } : t2)
        if (t2.ok) tun = t2
        else { tun = old; await home() }
        lastChance = gameClock.now()
      }
    }
  } finally {
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
  }
  // Из штрека — наружу (к входу).
  if (tun) { await stepInto(bot, tun.c1).catch(() => false); await stepInto(bot, tun.mouth).catch(() => false) }
  const pearls = countOf(bot, 'ender_pearl')
  const secs = Math.round((gameClock.now() - t0) / 1000)
  const detail: any = {
    mode: 'hunt',
    style: 'штрек',
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills,
    aggros,
    drops,
    moves,
    killsPerHour: secs ? Math.round(kills * 3600 / secs) : 0,
    pearlsPer10min: secs ? Math.round((pearls - pearls0) * 6000 / secs) / 10 : 0,
    rounds: rounds.slice(-10),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    seconds: secs
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills})`
  }
  detail.note = `Жемчуг +${detail.pearls.gained}, убито ${kills} (разозлил ${aggros}, выпало ${drops}) за ${secs} с (штрек 1x2 в стене).`
  return detail
}

export { huntTunnel }
