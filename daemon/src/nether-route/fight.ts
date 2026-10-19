'use strict'
// Ход по сетке Ада (nether-route.ts): угрозы на ходу — стрельба из укрытия, бой в яме, еда.
import { Vec3 } from 'vec3'
import * as NG from '../nether-grid'
import * as gameClock from '../game-clock'
import { C, log, sleep } from './base'
import { DIRS } from './plan'

const HOSTILE = new Set(['wither_skeleton', 'piglin_brute', 'hoglin', 'magma_cube', 'blaze', 'skeleton', 'zoglin'])

export function liveClass (bot, c) {
  const b = bot.blockAt(new Vec3(c[0], c[1], c[2]))
  if (!b) return C.UNKNOWN
  if (/lava/.test(b.name)) return C.LAVA
  return NG.classOfName(b.name)
}

// Иссушитель/брут виден в 9 бл. (на тронном зале их бывает по 2–3 — сид 6: на спуске на помост смерть за 2 с ×4) —
// сверху (тело выше на 2.6+ — его рамка удара не достаёт) луком, пока не убит/не ушёл; на одном уровне и не вплотную —
// столб в 3 блока и луком сверху. Нет лука или стрел — как было (бой вплотную в threatCheck).
export async function rangedClear (session, ctl, st, { radius = 9, maxMs = 25000, tower = true }: any = {}) {
  const bot = session.bot
  const { itemNamed }: typeof import('../items') = require('../items')
  const arrows = () => bot.inventory.items().filter(i => /arrow$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (!itemNamed(bot, 'bow') || arrows() === 0) return false
  const P: typeof import('../perception') = require('../perception')
  const seen = e => { try { return P.raySees(bot, P.eyePos(bot), e.position.offset(0, 1.6, 0)) } catch { return false } }
  const pick = () => (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e.position && e.isValid !== false && /^(wither_skeleton|piglin_brute)$/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < radius && seen(e))
    .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  let foe: any = pick()
  if (!foe) return false
  const t0 = gameClock.now()
  let towered = false
  st.ranged = (st.ranged || 0) + 1
  while (foe && !ctl.aborted && gameClock.now() - t0 < maxMs && (bot.health ?? 20) > 7) {
    const above = bot.entity.position.y - foe.position.y >= 2.6
    const d = foe.position.distanceTo(bot.entity.position)
    if (!above && tower && !towered && d > 3.2 && bot.entity.onGround) {
      const r = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, 3, { sneak: true }).catch(() => ({ ok: false }))
      towered = true
      log('столб от иссушителя', { foe: foe.name, ok: !!(r && r.ok), y: Math.round(bot.entity.position.y * 10) / 10 })
      continue
    }
    if (!above) return false
    bot.setControlState('sneak', true)
    const e: any = foe
    const r = await (require('../bow') as typeof import('../bow')).shoot(bot, e, { follow: false, mode: 'settle', point: () => e.position.offset(0, (e.height || 2.4) * 0.6, 0), shouldStop: () => !e.isValid }).catch(err => ({ shot: false, why: err.message }))
    if (!(r && r.shot)) await sleep(300)
    foe = pick()
  }
  bot.setControlState('sneak', false)
  log('сверху луком', { s: Math.round((gameClock.now() - t0) / 1000), left: !!foe, hp: Math.round(bot.health ?? 0) })
  return true
}

// Иссушитель вплотную — бой из ямы глубиной 2: рамка удара моба раздута только вширь (Mob.getAttackBoundingBox, 1.20.5+),
// иссушитель 2.4 в высоту с пола — тело с ногами на −2 он не достаёт, а меч снизу достаёт его ноги (s1c-A-5 06.10: столб не
// встал, «бой на ходу» 20 → 0 за 3 с: 18 ударами и 14 иссушением). Пол на −3 твёрдый, лавы рядом нет; потом столб 2 наверх.
export async function pitFight (session, ctl, st, foe) {
  const bot = session.bot
  const SL: typeof import('../sealed') = require('../sealed')
  const pick: typeof import('../pick') = require('../pick')
  for (let i = 0; i < 20 && !bot.entity.onGround && !ctl.aborted; i++) await sleep(50)
  const f = bot.entity.position.offset(0, 0.2, 0).floored()
  const firm = c => { const b = bot.blockAt(c); return !!b && b.boundingBox === 'block' && !/lava|water|fire|magma|spawner|bedrock|chest/.test(b.name) }
  const cells = [f.offset(0, -1, 0), f.offset(0, -2, 0)]
  if (![...cells, f.offset(0, -3, 0)].every(firm)) return false
  // Стенки твёрдые со всех сторон: яма с воздухом сбоку открыта удару (s1c-M-2 06.10 — то же у ямы ифритов).
  if (cells.some(c => DIRS.some(([x, z]) => { const b = bot.blockAt(c.offset(x, 0, z)); return !b || /lava/.test(b.name) || b.boundingBox !== 'block' }))) return false
  for (const c of cells) {
    let r = 'err'
    for (let k = 0; k < 3 && r !== 'ok' && r !== 'air' && !ctl.aborted; k++) r = await SL.digCell(bot, c).catch(e => 'err ' + e.message)
    if (r !== 'ok' && r !== 'air') { log('яма от иссушителя', { ok: false, why: r }); return false }
    for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleep(50)
  }
  for (let i = 0; i < 10 && bot.entity.position.y > f.y - 1.5; i++) await sleep(100)
  const t0 = gameClock.now()
  let swings = 0
  while (!ctl.aborted && gameClock.now() - t0 < 30000 && (bot.health ?? 0) > 3) {
    const e = bot.entities[foe.id]
    if (!e || e.isValid === false || e.position.distanceTo(bot.entity.position) > 8) break
    const sw = bot.inventory.items().find(i => /_sword$/.test(i.name))
    if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} }
    if (pick.canHit(bot, e) && gameClock.now() - (st.lastSwing || 0) > (require('../pvp') as typeof import('../pvp')).cooldownMs(bot.heldItem)) {
      try { await bot.lookAt(e.position.offset(0, 0.4, 0), true) } catch {}
      try { bot.attack(e); st.lastSwing = gameClock.now(); swings++ } catch {}
    }
    await sleep(100)
  }
  const left = !!(bot.entities[foe.id] && bot.entities[foe.id].isValid !== false)
  const up = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
  st.pits = (st.pits || 0) + 1
  log('яма от иссушителя', { ok: true, swings, left, s: Math.round((gameClock.now() - t0) / 1000), hp: Math.round(bot.health ?? 0), up: !!(up && up.ok) })
  return true
}

export async function threatCheck (session, ctl, st) {
  const bot = session.bot
  if (await rangedClear(session, ctl, st)) return true
  const me = bot.entity.position
  let foe = null
  for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
    if (!e || !e.position || e === bot.entity || e.isValid === false) continue
    const n = e.name
    if (!HOSTILE.has(n) && !(n === 'piglin' && st.piglinsAngry)) continue
    const d = e.position.distanceTo(me)
    if (d > 3.6) continue
    if (!foe || d < foe.d) foe = { e, d }
  }
  if (!foe) return false
  // Блейз: не гоняться (combat.fight бегал за летающим, удары вплотную сняли 13 хп: neF-B5f23-1 03.10) — один взмах,
  // если в досягаемости и виден, и дальше по пути.
  if (foe.e.name === 'blaze') {
    const pick: typeof import('../pick') = require('../pick')
    if (foe.d <= 3.2 && pick.canHit(bot, foe.e) && gameClock.now() - (st.lastSwing || 0) > 640) {
      const sw = bot.inventory.items().find(i => /_sword$/.test(i.name))
      if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} }
      try { await bot.lookAt(foe.e.position.offset(0, (foe.e.height || 1.8) * 0.6, 0), true) } catch {}
      try { bot.attack(foe.e); st.lastSwing = gameClock.now(); st.swings = (st.swings || 0) + 1 } catch {}
    }
    return false
  }
  // ND_BRUTE_HUNKER=1: брут/хоглин вплотную — не бой на земле (брут: 50 хп, 13 урона, D7c-24 03.10: «бой на ходу» ×3, смерть
  // за 2 с), а столб на 2: рамка удара раздута только вширь — ноги на +2 им не достать; сверху — мечом, пока не уйдёт/умрёт.
  // По умолчанию (s1c 06.10): «бой на ходу» с брутом — смерть за 2–3 удара (s1c-D-3/A-8: у входа в сокровищницу 4120…, 20 → 0 за
  // 2 с); столб 2 — по той же механике рамки удара (раздута только вширь). ND_BRUTE_HUNKER=0 — выкл.
  if (process.env.ND_BRUTE_HUNKER !== '0' && /^(piglin_brute|hoglin)$/.test(foe.e.name)) {
    const pick: typeof import('../pick') = require('../pick')
    const y0 = bot.entity.position.y
    const tw: Partial<Awaited<ReturnType<typeof import('../build').towerUp>>> = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, 2, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
    const up = bot.entity.position.y >= y0 + 1.9
    const t0 = gameClock.now()
    let swings = 0
    while (up && !ctl.aborted && gameClock.now() - t0 < 30000 && (bot.health ?? 0) > 4) {
      const e = bot.entities[foe.e.id]
      if (!e || e.isValid === false || e.position.distanceTo(bot.entity.position) > 10) break
      if (pick.canHit(bot, e) && gameClock.now() - (st.lastSwing || 0) > 640) {
        const sw = bot.inventory.items().find(i => /_sword$/.test(i.name))
        if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} }
        try { await bot.lookAt(e.position.offset(0, (e.height || 1.9) * 0.7, 0), true) } catch {}
        try { bot.attack(e); st.lastSwing = gameClock.now(); swings++ } catch {}
      }
      await sleep(100)
    }
    bot.setControlState('sneak', false)
    st.towers = (st.towers || 0) + 1
    log('столб от ' + foe.e.name, { up, placed: tw && tw.placed, swings, s: Math.round((gameClock.now() - t0) / 1000), left: !!(bot.entities[foe.e.id] && bot.entities[foe.e.id].isValid !== false), hp: Math.round(bot.health ?? 0) })
    if (up) return true
  }
  if (foe.e.name === 'wither_skeleton' && process.env.ND_WITHER_PIT !== '0' && await pitFight(session, ctl, st, foe.e).catch(() => false)) return true
  st.fights++
  const r = await (require('../combat') as typeof import('../combat')).fight(session, ctl, { target: '#' + foe.e.id, timeoutSeconds: 20, retreatAtHealth: 7, shield: 'always', clearArea: 0 }).catch(err => ({ error: err.message }))
  log('бой на ходу', { foe: foe.e.name, d: Math.round(foe.d * 10) / 10, hp: Math.round(bot.health ?? 0), killed: !!(r && (r.killed || (r.kills && r.kills.length))), error: r && r.error })
  return true
}

export async function eatIfLow (session, ctl) {
  const bot = session.bot
  if ((bot.food ?? 20) >= 14 && (bot.health ?? 20) >= 14) return
  if ((bot.food ?? 20) >= 20) return
  try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {}
}
