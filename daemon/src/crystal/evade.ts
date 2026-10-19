'use strict'
// Кристаллы (crystal.ts): уклонение ценой — щит, укрытие, блок между против «стоять»; защита от якоря во время еды.

import * as pick from '../pick'
import { EYE, HIT_R, PLACE_R, TICK, ANCHOR_P, r1, crystalBox, boxDist, hitAim } from './geometry'
import { effHp } from './scoring'
import type { CrystalDeps, CrystalState } from './state'

function createEvasion (S: CrystalState, deps: CrystalDeps) {
  const { bot, st, enemy, guard, anchorsAt, myEye, foeVisible, anchorSeen, cellKey, hurtAt, coverSpot, wallSpot } = S
  const { gameClock, boom, CX2 } = deps
  function hasShield () { return !!bot.inventory.items().find(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield') }
  // Щит одной стороной: направление на худший кристалл; кого конус (≤ 85°, запас к 90) не берёт — урон идёт.
  function shieldPlan (threats, dMe, cache) {
    if (!hasShield()) return null
    const me = bot.entity.position
    const worst = threats.slice().sort((a, b) => b.t.me - a.t.me)[0]
    const yaw = Math.atan2(-(worst.c.position.x - me.x), -(worst.c.position.z - me.z))
    const dm: typeof import('../pvp/damage-model') = require('../pvp/damage-model')
    const open = threats.filter(th => dm.shieldAngle(yaw, me, th.c.position) > 85)
    const inHand = (bot.heldItem && bot.heldItem.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')
    const use = guard && !guard.failure() ? guard.nativeUse() : null
    const usedTicks = use?.useConfirmed ? Math.max(0, use.confirmedTicks ?? 0) : 0
    // LivingEntity.getItemBlockingWith: пять тиков текущего use, не каждого плана.
    // Готовность — native ACK/age из общего щита; клиентские тики её не ускоряют.
    const ready = !!guard?.blocking()
    const turn = threats.some(th => dm.shieldAngle(bot.entity.yaw ?? 0, me, th.c.position) > 85 && !open.includes(th)) ? 1 : 0
    const ticks = ready ? turn : Math.max(0, dm.SHIELD_DELAY_TICKS - usedTicks) + (inHand ? 1 : 2)
    return { yaw, dmg: open.length ? hurtAt(open, me, dMe, cache) : 0, ticks }
  }
  // Прикрыт от его кристаллов (лучей к телу почти нет, при полной видимости было бы ≥ 4): его кристалл в прицеле
  // и мне от него ≤ 1.5 — сбить первым (угроза снята); иначе — держать укрытие (не выходить в ближний бой) до 3 с.
  function coverHold (threats, { dMe, myEff, cache, eye, now, far = true }: any) {
    const open = Math.max(...threats.map(th => th.t.meMax ?? th.t.me))
    const here = hurtAt(threats, bot.entity.position, dMe, cache)
    if (!(open >= 4 && here <= Math.max(1.5, open * 0.35))) { S.coverSince = null; return null }
    for (const th of threats) {
      if (th.cell) continue
      const aim = hitAim(bot, th.c.position, eye)
      if (aim && th.t.me <= 1.5 && Math.max(th.t.me, th.t.meMax ?? th.t.me) < myEff - 3) return { kind: 'defuse', c: th.c, t: th.t, aim, why: 'clear', note: `сбил его кристалл из-за укрытия (мне ${r1(th.t.me)})` }
    }
    if (S.coverSince == null) S.coverSince = now
    if (now - S.coverSince > 3000 || !far) return null
    st.coverHolds = (st.coverHolds || 0) + 1
    return { kind: 'hold', note: '' }
  }
  function evade (threats, { dMe, myEff, cache, foe, delayTicks = 0, finishTicks = null, finishGain = 0, count = true }: any) {
    const me = bot.entity.position
    const now0 = hurtAt(threats, me, dMe, cache)
    if (now0 < 2.5) return null
    // Когда подрыв: он достаёт кристалл рукой или лук в руке — в любой из ближайших 6 тиков; ни того, ни другого —
    // ему отойти и натянуть лук (crystal.place-shoot: отход до 1.3 с + натяжение 0.55–0.9 с) — между 20 и 45 тиками,
    // тогда и укрытие ищется дальше (6 бл.: бегом 0.26 б/т за 20 т — 5 бл.).
    const reachNow = !!foe && threats.some(th => boxDist(foe.position.offset(0, EYE, 0), th.cell ? { minX: th.cell.x, minY: th.cell.y, minZ: th.cell.z, maxX: th.cell.x + 1, maxY: th.cell.y + 1, maxZ: th.cell.z + 1 } : crystalBox(th.c.position)) <= (th.cell ? PLACE_R : HIT_R + 0.4))
    const hisBowNow = !!foe && foe.equipment && foe.equipment[0] && /^(bow|crossbow)$/.test(foe.equipment[0].name)
    const haz = reachNow || hisBowNow ? { lo: 0, hi: 6 } : { lo: 20, hi: 45 }
    const expected = (ticks, dmg) => { const p = Math.max(0, Math.min(1, (ticks - haz.lo) / (haz.hi - haz.lo))); return p * now0 + (1 - p) * dmg }
    const stay = finishTicks == null ? now0 : expected(finishTicks, Math.max(0, now0 - finishGain))
    const exp = o => expected(o.ticks + delayTicks, o.dmg) + (o.stall || 0)
    const opts = []
    const t0s = gameClock.now()
    // Щит подряд — не запрет, а цена (S7d, «гибкость вместо правил»): после 1.5 с подряд каждая секунда под щитом
    // стоит ~1.5 хп ожидаемого (пока стою — не бью, он заходит за спину или берёт топор: s7c1 р.3 — 75 щитов, ничья).
    // Укрытие или блок дешевле — уйдёт к ним; другого нет — щит остаётся.
    const sh = shieldPlan(threats, dMe, cache)
    const streakS = t0s - S.shieldLastEnd < 600 ? (t0s - S.shieldStreakAt) / 1000 : 0
    if (sh) opts.push({ kind: 'shield', yaw: sh.yaw, threats, dmg: sh.dmg, ticks: sh.ticks, stall: Math.max(0, streakS - 1.5) * 1.5 })
    const cv = coverSpot(threats, dMe, cache, haz.lo >= 20 ? 6 : 3, haz)
    if (cv && cv.dmg < now0) opts.push({ kind: 'cover', to: cv.pos, threats, dmg: cv.dmg, ticks: cv.ticks })
    const wl = wallSpot(threats, dMe, cache)
    if (wl && wl.dmg < now0) opts.push({ kind: 'wall', cells: wl.cells, threats, dmg: wl.dmg, ticks: wl.ticks })
    let best = null
    for (const o of opts) { o.exp = exp(o); if (!best || o.exp < best.exp) best = o }
    if (count) st.evadePlans = (st.evadePlans || 0) + 1
    if (!best || best.exp > stay - 1.5) return null
    const what = best.kind === 'shield' ? 'щит лицом к его кристаллу' : best.kind === 'cover' ? 'в укрытие от его кристалла' : `блок между мной и его кристаллом (${best.cells.length})`
    best.note = `${what}: ${r1(now0)} → ${r1(best.dmg)} (ожидаемо ${r1(best.exp)}, из ${r1(myEff)})`
    best.now = now0
    return best
  }

  // A local observation for the eat poll. Unknown collision cells are not free paths;
  // for blast rays they contribute no cover, so unknown exposure is an upper bound.
  // Fixed voxel samples must precede blockAt: a hidden block's shape cannot pick its own observation rays.
  function eatDefenseCache () {
    const cells = new Map()
    const view = Object.create(bot)
    view.entities = { [bot.entity.id]: bot.entity }
    for (const e of (Object.values(bot.entities) as any[])) {
      if (e?.position && e.isValid !== false && foeVisible(e)) view.entities[e.id] = e
    }
    view.blockAt = pos => {
      const cell = pos.floored(); const key = cellKey(cell)
      if (cells.has(key)) return cells.get(key)
      const eye = myEye()
      const points = [[.5, .5, .5]]
      for (const x of [.05, .95]) for (const y of [.05, .95]) for (const z of [.05, .95]) points.push([x, y, z])
      const seen = points.some(([x, y, z]) => {
        const d = cell.offset(x, y, z).minus(eye); const len = d.norm()
        const hit = len > 0 ? pick.blockOnRay(bot, eye, d.scaled(1 / len), len, /glass|_pane$|^barrier$|^iron_bars$/) : null
        return !hit || hit.pos.equals(cell)
      })
      const b = seen ? bot.blockAt(cell, false) : null
      cells.set(key, b); return b
    }
    return Object.assign(new Map(), { world: view })
  }

  function eatAnchorDefense (item, leftMs, noticed, reactMs) {
    const foe = enemy()
    if (!CX2 || !foe?.position || foe.isValid === false) return null
    const me = bot.entity.position; const dMe = boom.defenseOf(bot, bot.entity)
    const threats = []
    for (const a of anchorsAt.values()) {
      if (a.mine || a.pos.distanceTo(me) > 8 || !anchorSeen(a) || !(a.charges > 0)) continue
      const center = a.pos.offset(.5, .5, .5)
      const dmg = boom.blast(bot, center, ANCHOR_P, me, { def: dMe, seen: 1 }).dmg
      threats.push({ c: { position: center, id: 'a' + cellKey(a.pos), isValid: true }, t: { me: dmg }, power: ANCHOR_P, cell: a.pos, charges: a.charges })
    }
    if (!threats.length) { noticed.at = null; return null }
    const now = gameClock.now()
    if (noticed.at == null) noticed.at = now
    const delay = Math.max(0, (reactMs || 0) - (now - noticed.at))
    // Consumables + AbsorptionMobEffect (1.21.11, combat-calc-javap): absorption I / IV.
    // Count the absorption granted on completion; do not credit future regeneration ticks.
    const absorption = Math.max(0, effHp(bot, bot.entity) - (bot.health ?? 20))
    const gain = Math.max(0, (item === 'enchanted_golden_apple' ? 16 : item === 'golden_apple' ? 4 : 0) - absorption)
    const defense = evade(threats, { dMe, myEff: effHp(bot, bot.entity), cache: eatDefenseCache(), foe,
      delayTicks: Math.ceil(delay / TICK), finishTicks: Math.ceil(leftMs / TICK), finishGain: gain, count: false })
    return delay > 0 ? null : defense
  }
  return { hasShield, shieldPlan, coverHold, evade, eatDefenseCache, eatAnchorDefense }
}

export { createEvasion }
