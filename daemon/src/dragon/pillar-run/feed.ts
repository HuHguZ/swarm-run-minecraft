'use strict'
// Бой с драконом (dragon/pillar-run.ts): поток пакетов дракона: тики пакетов и последний удар по дракону.
const { gameClock, dbg, phaseOf, PHASE, SITTING, sitFix }: typeof import('../dig-down-to') = require('../dig-down-to')
const { r1, podiumTop }: typeof import('../fall-guard') = require('../fall-guard')
const { landingForecast, simClone }: typeof import('../evade-raw') = require('../evade-raw')
const { yRotOf, DAMAGE_TYPES, readVarIntAt, lpVec3At, r3 }: typeof import('../ts-plan') = require('../ts-plan')

let lastDragonHit = 0

// Серверные тики пакетов дракона (750 TPS, s5 06.10). Отметка t — игровые мс клиента в миг разбора: на 750 тиках/с пакеты
// приходят пачками (половина промежутков 0, остальные 50…1000 при настоящих 150), и прогноз снижения брал число тиков
// между пакетами и миг прохода головы из этих отметок — щелчок кровати −4…+2 тика (DragonLab, s5-c1). Тиков между
// пакетами — по пути (смещение / скорость за тик), миг — по пакету, разобранному без задержки (меньшее t − tick·50
// за последние 15 пакетов, ~45 тиков: ошибка числа тиков не копится): tt — отметка без задержки разбора.
function feedTicks (list, r) {
  const prev = list[list.length - 1]
  // фактический темп сервера (s5-c3: по заказанным 750 при настоящих ~700 якорь за 45 тиков уезжал на 4–6 тиков раньше)
  const sn = gameClock.snapshot()
  const tickMs = 1000 / (sn?.effectiveRate || sn?.tickRate || 20)
  if (!prev || prev.id !== r.id || prev.tick == null) { r.tick = 0; r.n = null; r.tt = r.t; r.ttMono = sn?.lockstep ? null : r.mono; return }
  const byStamp = Math.max(1, Math.round((r.t - prev.t) / 50))
  const vs = [prev, r].filter(q => q.vx != null).map(q => Math.hypot(q.vx, q.vy, q.vz))
  const sp = vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : 0
  const d = Math.hypot(r.x - prev.x, r.y - prev.y, r.z - prev.z)
  r.n = sp > 0.2 && d > 0.05 ? Math.max(1, Math.min(6, Math.round(d / sp))) : byStamp
  r.tick = prev.tick + r.n
  let off = r.t - r.tick * 50
  let offMono = r.mono != null ? r.mono - r.tick * tickMs : null
  for (let i = list.length - 1, k = 0; i >= 0 && k < 15 && list[i].id === r.id && list[i].tick != null; i--, k++) {
    off = Math.min(off, list[i].t - list[i].tick * 50)
    if (offMono != null && list[i].mono != null && k < 5) offMono = Math.min(offMono, list[i].mono - list[i].tick * tickMs)
  }
  // на 20 тиках отметки разбора точны (50 мс на тик), и +1 тик clickLead выверен по ним (an-pilltiming); якорь — только
  // на ускоренных (s5-e22: якорь на 20 сдвигал щелчок на 1–2 тика раньше, урон p50 45 вместо 52)
  r.tt = !sn?.lockstep && (sn?.effectiveRate || sn?.tickRate || 20) > 100 ? r.tick * 50 + off : r.t
  // то же в монотонных мс реального времени: часы клиента на 750 скачут (догоняют сервер рывком, стоят впереди него),
  // щелчок по ним уходит раньше/позже на тики — миг щелчка считать по ровным часам (clickBedAt untilMono)
  r.ttMono = !sn?.lockstep && offMono != null ? r.tick * tickMs + offMono : null
}

function makeDragonFeed (bot) {
  const onHit = pk => {
    if (!pk || !bot.entity || pk.entityId !== bot.entity.id) return
    const src = bot.entities[pk.sourceCauseId - 1]
    if (DAMAGE_TYPES[pk.sourceTypeId] === 'mob_attack' && src && src.name === 'ender_dragon') lastDragonHit = gameClock.now()
  }
  bot._client.on('damage_event', onHit)
  const list = []
  let vel = null
  // Снижение — прогноз посадки (по двум последним пакетам со скоростью).
  const refresh = id => {
    const r = list[list.length - 1]
    if (!r || r.id !== id || r.ph !== PHASE.LANDING || r.vx == null) return
    try { const f = landingForecast(feed, podiumTop(bot)); if (f) feed.fc = { ...f, id } } catch (err) { dbg('forecast', err.message) }
  }
  const onVel = buf => {
    try {
      let off = 0; let id
      ;[, off] = readVarIntAt(buf, off)
      ;[id, off] = readVarIntAt(buf, off)
      const e = bot.entities[id]
      if (!e || e.name !== 'ender_dragon') return
      vel = { t: gameClock.now(), id, ...lpVec3At(buf, off) }
      const last = list[list.length - 1]
      if (last && last.id === id && vel.t - last.t < 25 && last.vx == null) { last.vx = vel.x; last.vy = vel.y; last.vz = vel.z; refresh(id) }
    } catch {}
  }
  const onMoved = e => {
    if (!e || e.name !== 'ender_dragon') return
    const t = gameClock.now()
    const last = list[list.length - 1]
    const p = e.position
    if (last && last.id === e.id && t - last.t < 25 && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.z - p.z) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) { last.yRot = yRotOf(e.yaw); return }
    const r: any = { t, wallMs: gameClock.wall.now(), mono: gameClock.wall.monotonic(), id: e.id, x: p.x, y: p.y, z: p.z, yRot: yRotOf(e.yaw), ph: phaseOf(bot, e), vx: null, vy: null, vz: null }
    if (vel && vel.id === e.id && t - vel.t < 25) { r.vx = vel.x; r.vy = vel.y; r.vz = vel.z }
    feedTicks(list, r)
    list.push(r)
    if (list.length > 40) list.shift()
    refresh(e.id)
  }
  // Сел (метаданные фазы; сидящий не двигается — пакетов движения нет): угол головы
  // по последнему прогнозу — yRotA заморожен.
  const onUpd = e => {
    if (!e || e.name !== 'ender_dragon') return
    const ph = phaseOf(bot, e)
    const last = list[list.length - 1]
    if (last && last.id === e.id && gameClock.now() - last.t < 25) last.ph = ph
    const f = feed.fc
    if (!SITTING.has(ph) || !f || f.id !== e.id || gameClock.now() - f.t > 700 || feed.fixed === f.t) return
    feed.fixed = f.t
    sitFix.set(e.id, { yRotA: f.yRotA, yaw: e.yaw, t: gameClock.now(), head: f.head, sit: simClone(f.sit), pos: e.position.clone(), pushes: [], me: bot.entity && bot.entity.position.clone() })
    if (feed.onSit) feed.onSit({ pred: [r3(f.sit.x), r3(f.sit.y), r3(f.sit.z), r1(f.sit.yRot)], act: [r3(e.position.x), r3(e.position.y), r3(e.position.z), r1(yRotOf(e.yaw))], yRotA: r1(f.yRotA), n: f.n, late: gameClock.now() - f.t, head: [r1(f.head.x), r1(f.head.y), r1(f.head.z)] })
  }
  const feed = { list, fc: null, fixed: null, onSit: null, close () { bot._client.removeListener('raw.entity_velocity', onVel); bot.removeListener('entityMoved', onMoved); bot.removeListener('entityUpdate', onUpd); bot._client.removeListener('damage_event', onHit) } }
  bot._client.on('raw.entity_velocity', onVel)
  bot.on('entityMoved', onMoved)
  bot.on('entityUpdate', onUpd)
  return feed
}

export {
  lastDragonHit, feedTicks, makeDragonFeed
}
