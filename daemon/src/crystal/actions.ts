'use strict'
// Кристаллы (crystal.ts): действия — хотбар, установка и удар, стрела, отход и шаг в укрытие, размен на миг
// удара, обсидиан вокруг ног.

import * as pick from '../pick'
import { P, EYE, TICK, SIDES, shieldUpOf, crystalBox, solidB, baseFree, centerOf, pickBlockers, faceFor, hitAim, losClear } from './geometry'
import { effHp, landed, worthHit } from './scoring'
import type { CrystalDeps, CrystalState } from './state'

// ------------------------------------------------------------ действия

function createActions (S: CrystalState, deps: CrystalDeps) {
  const { bot, st, enemy, noteAttack, hisHp, mine, fail, inWin } = S
  const { gameClock, boom, sleep, trade, CX2 } = deps
  async function toHotbar (name) {
    for (let i = 0; i < 9; i++) { const s = bot.inventory.slots[36 + i]; if (s && s.name === name) return i }
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it || bot.currentWindow) return -1
    let dest = -1
    for (let i = 0; i < 9; i++) if (i !== bot.quickBarSlot && !bot.inventory.slots[36 + i]) { dest = i; break }
    const KEEP = /_sword$|_axe$|^bow$|^totem_of_undying$|golden_apple$|^end_crystal$|^obsidian$/
    if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && !KEEP.test(s.name)) { dest = i; break } }
    if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && s.name !== 'totem_of_undying' && !/_sword$/.test(s.name)) { dest = i; break } }
    if (dest < 0) return -1
    try { await bot.moveSlotItem(it.slot, 36 + dest) } catch { return -1 }
    const s = bot.inventory.slots[36 + dest]
    return s && s.name === name ? dest : -1
  }

  function waitSpawn (at, ms = 450) {
    return new Promise<any>(resolve => {
      const on = (e) => { if (e && e.name === 'end_crystal' && e.position && e.position.distanceTo(at) < 0.3) done(e) }
      const t = gameClock.setTimeout(() => done(null), ms)
      function done (e) { gameClock.clearTimeout(t); bot.removeListener('entitySpawn', on); resolve(e) }
      bot.on('entitySpawn', on)
    })
  }

  // Кристалл на base: взгляд в видимую точку грани, пакет, ждать сущность.
  async function place (base, f) {
    const idx = await toHotbar('end_crystal')
    if (idx < 0) { fail('кристалла нет в хотбаре'); return null }
    if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
    const eye = bot.entity.position.offset(0, EYE, 0)
    // Прицел мог уйти за тик (он сдвинулся, мы сдвинулись) — перепроверить.
    const ff = faceFor(bot, base, eye, pickBlockers(bot, eye)) || null
    if (!ff) { fail('грань не видно'); return null }
    if (!baseFree(bot, base)) { fail('столб занят'); return null }
    // Второй, независимый луч (world.raycast) не согласен — не ставить: сквозь
    // стену пользователь считает читом. Счёт отказов — wallPlace (0 = лучи
    // согласны всегда); поставленного сквозь стену нет по построению.
    if (!losClear(bot, eye, ff.pt, { expectBlock: base })) { st.wallPlace++; fail('второй луч: грань за блоком'); return null }
    const block = bot.blockAt(base, false)
    if (!block) return null
    const w = waitSpawn(centerOf(base))
    try {
      await bot._genericPlace(block, ff.face, { forceLook: true, delta: ff.pt.minus(base), swingArm: 'right' })
    } catch (e) { fail('клик: ' + e.message); return null }
    const c: any = await w
    if (!c) { fail('кристалл не появился'); return null }
    mine.set(c.id, { at: gameClock.now(), base })
    st.placed++
    return c
  }

  async function hit (c) {
    const eye = pick.eyeOf(bot)
    const pt = hitAim(bot, c.position, eye)
    if (!pt) { fail('кристалл не в прицеле'); return false }
    if (!losClear(bot, eye, pt)) { st.wallHit++; fail('второй луч: кристалл за блоком'); return false }
    await bot.lookAt(pt, true).catch(() => {})
    const before = bot._ndBlockedHits || 0
    const fw = CX2 && noteAttack ? freshWorth(c.position) : null
    try { bot.attack(c) } catch { return false }
    if ((bot._ndBlockedHits || 0) > before) { fail('сторож прицела'); return false }
    noteBlast(fw)
    const rec = mine.get(c.id) || { at: gameClock.now() }
    rec.hitAt = gameClock.now()
    mine.set(c.id, rec)
    st.hits++
    return true
  }
  // Оценке его хп — урон моего подрыва интервалом (прогноз лучей ±): damage_event с причиной «я» его вычтет.
  function noteBlast (fw, projectile = false) {
    if (!fw || !fw.t || !noteAttack || !(fw.land > 0.3)) return
    try { noteAttack({ min: fw.land * 0.75, max: fw.land * 1.2 + 0.5, mean: fw.land, raw: fw.t.himRaw }, { projectile }) } catch {}
  }



  async function backOff (ctl, from, { ms = 900, until = null, stepSafe = null }: any = {}) {
    const t0 = gameClock.now()
    const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
    try {
      while (gameClock.now() - t0 < ms && !ctl.aborted) {
        if (until && until()) break
        const me = bot.entity.position
        const yaw = Math.atan2(-(me.x - from.x), -(me.z - from.z))
        await bot.look(yaw, 0, true).catch(() => {})
        const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
        let ok = !stepSafe || stepSafe(fwd)
        let side = null
        if (!ok && stepSafe) {
          for (const [k2, sgn] of ([['left', 1], ['right', -1]] as any)) {
            const d = { x: -Math.sin(yaw + sgn * Math.PI / 2), z: -Math.cos(yaw + sgn * Math.PI / 2) }
            if (stepSafe(d)) { side = k2; break }
          }
        }
        set('forward', ok); set('sprint', ok && (bot.food ?? 20) > 6); set('left', side === 'left'); set('right', side === 'right')
        // Блок на пути (окружение) — прыжок.
        const ahead = me.offset(fwd.x * 0.8, 0.2, fwd.z * 0.8).floored()
        const b = bot.blockAt(ahead, false)
        set('jump', ok && solidB(b))
        await sleep(TICK)
      }
    } finally { for (const k of ['forward', 'sprint', 'back', 'left', 'right', 'jump']) set(k, false) }
  }

  // К точке to бегом по прямой (укрытие в 1–3 клетках): ступень — прыжком; у края — stepSafe.
  async function moveTo (ctl, to, { ms = 900, until = null, stepSafe = null }: any = {}) {
    const t0 = gameClock.now()
    const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
    try {
      while (gameClock.now() - t0 < ms && !ctl.aborted) {
        if (until && until()) break
        const me = bot.entity.position
        const dx = to.x - me.x; const dz = to.z - me.z
        const h = Math.hypot(dx, dz)
        if (h < 0.22 && Math.abs(me.y - to.y) < 0.6) break
        const yaw = Math.atan2(-dx, -dz)
        await bot.look(yaw, 0, true).catch(() => {})
        const fwd = { x: dx / h, z: dz / h }
        const ok = !stepSafe || stepSafe(fwd) || to.y < me.y - 0.5
        set('forward', ok); set('sprint', ok && h > 0.8 && (bot.food ?? 20) > 6)
        set('jump', ok && to.y > me.y + 0.5 && h < 1.6)
        if (!ok) break
        await sleep(TICK)
      }
    } finally { for (const k of ['forward', 'sprint', 'jump']) set(k, false) }
  }

  // Стрела летит, пока тянем лук, моё здоровье меняется (его кристалл, его
  // удар): перед спуском снова «не хлопнуть свой тотем своим кристаллом» —
  // иначе натяжение бросить (прогон b3: поставил при 18 хп, отходя получил его
  // кристалл до 4 — и своя стрела хлопнула свой тотем).
  // Размен заново на момент удара: хп, поглощение, броня (ломается), его и моё
  // место, его окно — план устарел за await (постановка, взгляд, смена слота).
  S.lastPress = false
  // airCell — клетка, которая до взрыва исчезнет (якорь: removeBlock раньше
  // explode) — лучам не преграда.
  function freshWorth (center, { power = P, airCell = null }: any = {}) {
    const foe = enemy()
    if (!foe || !foe.position || foe.isValid === false || !bot.entity) return { ok: false }
    const dMe = boom.defenseOf(bot, bot.entity)
    const dHim = boom.defenseOf(bot, foe)
    const cache = new Map()
    if (airCell) cache.set(`${airCell.x},${airCell.y},${airCell.z}`, null)
    const t = trade(bot, center, foe, bot.entity, dHim, dMe, cache, { power, himShield: CX2 && shieldUpOf(bot, foe) })
    const eqF = foe.equipment || []
    const hisTotem = !!((eqF[0] && eqF[0].name === 'totem_of_undying') || (eqF[1] && eqF[1].name === 'totem_of_undying'))
    const land = landed(t, inWin(S.hisWin), dHim)
    const ok = worthHit(t, { myEff: effHp(bot, bot.entity), hisEff: hisHp(foe), hisLand: land, press: S.lastPress, hisTotem })
    return { ok, t, land }
  }

  // Другой кристалл на прямой к цели раньше неё — стрела возьмёт его (ревью
  // Codex: «стрела в безопасный дальний кристалл попадёт в опасный ближний»).
  function crystalInLine (c) {
    const eye = bot.entity.position.offset(0, EYE, 0)
    const to = c.position.offset(0, 1, 0)
    const d = to.minus(eye)
    const len = d.norm()
    if (len < 1e-3) return null
    const dir = d.scaled(1 / len)
    const cb = crystalBox(c.position)
    const tT = pick.rayBox(eye, dir, { x: cb.minX, y: cb.minY, z: cb.minZ }, { x: cb.maxX, y: cb.maxY, z: cb.maxZ }, len) ?? len
    let best = null; let bestT = Infinity
    for (const e of ((Object.values(bot.entities) as any[]) as any)) {
      if (!e || e.name !== 'end_crystal' || e.id === c.id || !e.position || e.isValid === false) continue
      const b = crystalBox(e.position)
      const t = pick.rayBox(eye, dir, { x: b.minX, y: b.minY, z: b.minZ }, { x: b.maxX, y: b.maxY, z: b.maxZ }, len)
      if (t != null && t < tT - 0.05 && t < bestT) { best = e; bestT = t }
    }
    return best
  }

  async function shoot (ctl, c, ctx) {
    const selfRisk = () => { try { return boom.blast(bot, c.position, P, bot.entity.position, { def: boom.defenseOf(bot, bot.entity), seen: 1 }).dmg >= effHp(bot, bot.entity) - 4.5 } catch { return true } }
    const lineRisk = () => { try { const o = crystalInLine(c); return !!(o && !freshWorth(o.position).ok) } catch { return true } }
    if (selfRisk()) { fail('выстрел: себе смертельно'); return false }
    const other = crystalInLine(c)
    if (other) {
      // Ближний кристалл на линии — выстрел достанется ему; стрелять, только если
      // и его взрыв мне не опасен (по полной видимости) и ему выгоден.
      const fw = freshWorth(other.position)
      if (!fw.ok) { fail('выстрел: на линии другой кристалл'); return false }
      c = other
    }
    const r = await boom.shootAt(bot, ctl, c, { anyBow: true, drawMs: c.position.distanceTo(bot.entity.position) > 10 ? 900 : 550, shouldStop: () => (ctx.stop && ctx.stop()) || selfRisk() || lineRisk() }).catch(e => ({ shot: false, why: e.message }))
    if (r && r.shot) {
      if (CX2 && noteAttack) noteBlast(freshWorth(c.position), true)
      const rec = mine.get(c.id) || { at: gameClock.now() }
      rec.hitAt = gameClock.now() + 400 // стрела летит
      mine.set(c.id, rec)
      st.shots++
      return true
    }
    fail('выстрел: ' + ((r && r.why) || '?'))
    return false
  }

  async function doSurround (ctl, foe) {
    const fortify: typeof import('../fortify') = require('../fortify')
    const { placeBlockAt } = deps
    await fortify.centerInCell(bot, 450)
    const cell = fortify.feetCell(bot)
    const toward = foe && foe.position ? foe.position : null
    const order = SIDES.slice().sort((a, b) => toward ? (b.x * (toward.x - cell.x - 0.5) + b.z * (toward.z - cell.z - 0.5)) - (a.x * (toward.x - cell.x - 0.5) + a.z * (toward.z - cell.z - 0.5)) : 0)
    let placed = 0
    for (const s of order) {
      if (ctl.aborted) break
      const p = cell.plus(s)
      const b = bot.blockAt(p, false)
      if (solidB(b)) continue
      try {
        const r = await placeBlockAt(bot, p, { item: 'obsidian', honest: true, timeoutMs: 450 })
        if (r && r.ok && !r.already) placed++
      } catch {}
    }
    return placed
  }
  return { toHotbar, waitSpawn, place, hit, noteBlast, backOff, moveTo, freshWorth, crystalInLine, shoot, doSurround }
}

export { createActions }
