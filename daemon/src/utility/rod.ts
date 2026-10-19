'use strict'
// Подручное (utility.ts): удочка — полёт поплавка, рывок за ванильный клиент, чей поплавок на ком, зачем тянуть, заброс и подсечка.
import * as gameClock from '../game-clock'
import * as edges from '../edges'
import { sleep } from '../movement'
import { EYE, TICK_MS, findItem, isPlayer, hpOf, onTickThen } from './common'
import { Vec3 } from './common'

// ================================================================ удочка

const ROD_G = 0.03
const ROD_DRAG = 0.92
// Полёт поплавка при наклоне p (вверх +) до горизонтали dx: высота и тики.
function rodFlight (p, dx) {
  const tn = Math.max(-5, Math.min(5, Math.tan(p)))
  const k = 0.6 / Math.hypot(1, tn) + 0.5
  let vh = k; let vy = tn * k
  let x = 0.3; let y = 0
  if (dx <= x) return { y: 0, ticks: 0 }
  for (let t = 1; t <= 80; t++) {
    vy -= ROD_G
    const nx = x + vh; const ny = y + vy
    if (nx >= dx) { const f = (dx - x) / (nx - x); return { y: y + (ny - y) * f, ticks: t - 1 + f } }
    x = nx; y = ny
    vh *= ROD_DRAG; vy *= ROD_DRAG
    if (vh < 0.02) return null
  }
  return null
}
// Наклон для попадания на высоту dy на дальности dx (низкая траектория).
function rodPitch (dx, dy) {
  const at = p => { const f = rodFlight(p, dx); return f ? f.y : -Infinity }
  let prev = null
  for (let deg = -40; deg <= 70; deg += 1) {
    const p = deg * Math.PI / 180
    if (at(p) >= dy) {
      if (prev === null) return { pitch: p, ticks: rodFlight(p, dx).ticks }
      let lo = prev; let hi = p
      for (let i = 0; i < 25; i++) { const m = (lo + hi) / 2; if (at(m) >= dy) hi = m; else lo = m }
      const f = rodFlight(hi, dx)
      return f ? { pitch: hi, ticks: f.ticks } : null
    }
    prev = p
  }
  return null
}
// Дальность, на которую вообще долетает (горизонт, наклон 25°): для плана.
const ROD_MAX = 11

// Честность (PVP-RESEARCH б.15): ванильный клиент по событию 31 поплавка,
// зацепившего его, сам прибавляет себе 0.1 × (владелец − поплавок). mineflayer —
// нет, и человек удочкой бота не сдёргивал. Один раз на бота, всегда.
function installRodPull (bot) {
  if (bot._ndRodPull) return bot._ndRodPull
  const R = { owners: new Map(), pulled: 0, last: null, mine: null }
  bot._ndRodPull = R
  const typeId = bot.registry.entitiesByName.fishing_bobber ? bot.registry.entitiesByName.fishing_bobber.id : -1
  try {
    bot._client.on('spawn_entity', (p) => {
      if (!p || p.type !== typeId) return
      R.owners.set(p.entityId, p.objectData)
      if (bot.entity && p.objectData === bot.entity.id) R.mine = { id: p.entityId, at: gameClock.now() }
      if (R.owners.size > 64) R.owners.delete(R.owners.keys().next().value)
    })
    bot._client.on('entity_status', (p) => {
      try {
        if (!p || p.entityStatus !== 31 || !bot.entity) return
        const hook = bot.entities[p.entityId]
        if (!hook || hook.name !== 'fishing_bobber') return
        if (hook.metadata[8] !== bot.entity.id + 1) return
        const owner = bot.entities[R.owners.get(p.entityId)]
        if (!owner || !owner.position) return
        const me = bot.entity.position
        const v = { x: (owner.position.x - me.x) * 0.1, y: (owner.position.y - (me.y + 0.8 * 1.8)) * 0.1, z: (owner.position.z - me.z) * 0.1 }
        bot.entity.velocity.x += v.x
        bot.entity.velocity.y += v.y
        bot.entity.velocity.z += v.z
        R.pulled++
        R.last = { at: gameClock.now(), v, from: owner.username || owner.name }
        bot.emit('nd_rodPulled', R.last)
      } catch {}
    })
  } catch {}
  return R
}

// Мой поплавок и кого он держит.
function myHook (bot) {
  const R = bot._ndRodPull
  if (!R || !R.mine) return null
  const e = bot.entities[R.mine.id]
  if (!e || e.isValid === false) return null
  const h = e.metadata ? e.metadata[8] : 0
  return { e, hooked: typeof h === 'number' && h > 0 ? h - 1 : null }
}

// Его поплавок зацепил меня: поплавок рядом (≤ 32 бл. от хозяина), метаданные зацепа = мой id + 1, хозяин — e.
function hookedBy (bot, e) {
  const R = bot._ndRodPull
  if (!R || !bot.entity || !e) return null
  for (const [hookId, ownerId] of R.owners) {
    if (ownerId !== e.id) continue
    const h = bot.entities[hookId]
    if (!h || h.isValid === false || !h.metadata) continue
    if (h.metadata[8] === bot.entity.id + 1) return h
  }
  return null
}

// Зачем тянуть (или null): со столба; через яму или в лаву между нами (прогон
// тела edges.knockRun со скоростью рывка); едока — к мечу.
function rodPlan (bot, e, { d, dy, sees, busy = {}, theyUp = false, vel = null, blocking = false }: any = {}) {
  if (!isPlayer(e) || !sees) return null
  if (!findItem(bot, i => i.name === 'fishing_rod')) return null
  if (d < 3.5 || d > ROD_MAX) return null
  const me = bot.entity.position
  const pull = new Vec3((me.x - e.position.x) * 0.1, (me.y - (e.position.y + 1.44)) * 0.1, (me.z - e.position.z) * 0.1)
  const cache = new Map()
  // Сдёрнуть со столба или уступа: он выше и в 0.4 от края, за которым 1.5+
  // вниз (порог «безопасного падения» 3 тут не годится: столб в 3 — тоже столб).
  if ((theyUp || dy > 1.8) && edges.clearance(bot, e.position, 0.6, new Map(), 1.5) < 0.4) return { why: 'удочкой со столба', pull }
  // В яму или лаву между нами: его полёт от рывка (он тянет назад — counter).
  try {
    if (edges.hazardAround(bot, e.position, 4, cache)) {
      const onGround = edges.support(bot, e.position, cache).drop <= 0.05
      const base = edges.stateOf(bot)
      const v = new Vec3(pull.x, onGround ? Math.max(pull.y, 0) : pull.y, pull.z)
      const r = edges.knockRun(bot, base, e.position, v, onGround, Math.atan2(-(me.x - e.position.x), -(me.z - e.position.z)), true, cache)
      if (r && r.fall) return { why: r.lava ? 'удочкой в лаву' : 'удочкой в яму', pull }
    }
  } catch {}
  // Ест или пьёт: медленный (×0.2), рывок подтащит его к мечу — добить в глоток.
  if (busy.consuming && busy.consuming.left > 700 && d > 4.5) return { why: 'удочкой подтащил едока', pull }
  // Тянет лук/арбалет на дистанции (s7b: удочка за 10 раундов — 4 раза): рывок сбивает его прицел и тащит к мечу.
  if (busy.drawing && d > 4.5) return { why: 'удочкой сдёрнул стрелка', pull }
  // Уходит (жемчужник, лучник, лечиться): его скорость от нас > 0.12 б/т — подтянуть и догнать (пользователь 06.10:
  // «удочкой притягивать и потом в комбо»). FishingHook.pullEntity: Δv = 0.1·(я − поплавок), javap 1.21.11.
  if (vel && d > 4.5) {
    const ax = (e.position.x - me.x) / d; const az = (e.position.z - me.z) / d
    if (vel.x * ax + vel.z * az > 0.12) return { why: 'удочкой подтянул убегающего', pull }
  }
  // Подлёт под удар: 4.5–7.5 бл., щит не поднят — подтяг и рывок со спринт-ударом (комбо продлевается рывком).
  if (!blocking && d >= 4.5 && d <= 7.5) return { why: 'удочкой подтянул под удар', pull }
  return null
}

// Заброс и подсечка. Прицел — по поплавку (своё движение не прибавляется),
// с упреждением его хода; поймали — сразу «использовать» ещё раз (рывок).
async function rodPull (bot, ctl, e, { velFn = () => ({ x: 0, y: 0, z: 0 }), maxMs = 1600 }: any = {}) {
  installRodPull(bot)
  const rod = findItem(bot, i => i.name === 'fishing_rod')
  if (!rod) return { ok: false, why: 'удочки нет' }
  try { await bot.equip(rod, 'hand') } catch (err) { return { ok: false, why: err.message } }
  if (!bot.heldItem || bot.heldItem.name !== 'fishing_rod') return { ok: false, why: 'не взял удочку' }
  const R = bot._ndRodPull
  R.mine = null
  const hp0 = hpOf(bot, e)
  const cast: any = await onTickThen(bot, () => {
    const eye = bot.entity.position.offset(0, EYE, 0)
    const v = velFn() || { x: 0, z: 0 }
    let ticks = 6
    let sol = null
    for (let i = 0; i < 3; i++) {
      const P = e.position.offset(v.x * ticks, 0.9, v.z * ticks)
      const dx = Math.hypot(P.x - eye.x, P.z - eye.z)
      const s = rodPitch(dx, P.y - eye.y)
      if (!s) return null
      sol = { yaw: Math.atan2(-(P.x - eye.x), -(P.z - eye.z)), pitch: s.pitch, ticks: s.ticks }
      ticks = s.ticks
    }
    return sol
  }, () => bot.activateItem())
  if (!cast) return { ok: false, why: 'не долетит' }
  const t0 = gameClock.now()
  let hooked = false
  while (!ctl.aborted && gameClock.now() - t0 < Math.min(maxMs, cast.ticks * 50 + 700)) {
    const h = myHook(bot)
    if (h && h.hooked === e.id) { hooked = true; break }
    await sleep(TICK_MS)
  }
  // Подсечка (или смотать пустой): второе «использовать» с удочкой в руке.
  // ND_DEBUG_ROD=1 (сцена try-utility): сразу за пакетом подсечки — /data его
  // Motion: сервер разбирает пакеты по порядку в одном тике, и ответ — скорость,
  // которую ему записал pullEntity (правда сервера, а не наш расчёт).
  let probe = null
  const onMsg = (m) => { const s = String(m); if (/has the following entity data/.test(s) && !probe) probe = s.replace(/^.*data: /, '') }
  const dbg = process.env.ND_DEBUG_ROD === '1' && hooked && e.username
  if (dbg) bot.on('messagestr', onMsg)
  try { bot.activateItem() } catch {}
  if (dbg) { try { bot.chat(`/data get entity ${e.username} Motion`) } catch {} }
  await sleep(dbg ? 400 : 120)
  if (dbg) bot.removeListener('messagestr', onMsg)
  const me = bot.entity.position
  const expect = hooked ? `${((me.x - e.position.x) * 0.1).toFixed(2)}, ${((me.y - e.position.y - 1.44) * 0.1).toFixed(2)}, ${((me.z - e.position.z) * 0.1).toFixed(2)}` : null
  return { ok: hooked, hooked, ticks: cast.ticks, pitchDeg: Math.round(cast.pitch * 1800 / Math.PI) / 10, hp0, probe, expect }
}

export { rodFlight, rodPitch, ROD_MAX, installRodPull, myHook, hookedBy, rodPlan, rodPull }
