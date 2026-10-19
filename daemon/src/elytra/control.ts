'use strict'
// Элитры (elytra.ts): управление — выбор взгляда перебором и цена прогона.
const { EYE, REACH, SAFE_FALL, LAND_FD, yawTo, wrap }: typeof import('./consts') = require('./consts')
const { fallStep, rollout, reachFromBox }: typeof import('./physics') = require('./physics')

// ---------------------------------------------------------------- управление

const PITCHES = [-1.3, -1.0, -0.75, -0.55, -0.38, -0.22, -0.1, 0, 0.12, 0.28, 0.45, 0.7, 0.95]
const YAW_OFF = [0, 0.12, -0.12, 0.3, -0.3, 0.55, -0.55, 0.9, -0.9, 1.35, -1.35, 2.0, -2.0, Math.PI]

// Выбор взгляда на этот тик: перебор (yaw, pitch), каждый — прогон H тиков
// своей физикой, цена — по цели. goal:
//  { kind: 'point', at: Vec3 | (t)→Vec3, minY, maxY, away: Vec3, awayR, speedMin }
//  { kind: 'land', at: Vec3 (точка пола), away: Vec3 }
//  { kind: 'strike', at: (t)→Vec3, within }
function choose (W, st, goal, { H = 18, rocketNow = false }: any = {}) {
  const at = typeof goal.at === 'function' ? goal.at : () => goal.at
  const tgt0 = at(0)
  const hs0 = Math.hypot(st.v.x, st.v.z)
  const bearing = yawTo(st.p, tgt0)
  const heading = hs0 > 0.2 ? Math.atan2(-st.v.x, -st.v.z) : bearing
  const yaws = new Set()
  for (const o of YAW_OFF) { yaws.add(wrap(bearing + o)); if (Math.abs(o) <= 0.9) yaws.add(wrap(heading + o)) }
  const boost = Math.max(0, st.boost || 0) + (rocketNow ? 26 : 0)
  let best = null
  for (const yaw of yaws) {
    for (const pitch of goal.pitches || PITCHES) {
      const r = rollout(W, st.p, st.v, yaw, pitch, boost, H, { fd: st.fd, keepPath: goal.kind === 'strike' || !!goal.reach, arena: goal.arena })
      if (r.kind === 'outside') continue
      const c = cost(W, st, goal, at, r, yaw, pitch)
      if (!best || c < best.c) best = { c, yaw, pitch, r }
    }
  }
  return best
}

function cost (W, st, goal, at, r, yaw, pitch) {
  let c = 0
  const end = r.p
  // Удар о стену — самое дорогое: урон ×, и полёт кончается.
  if (r.kind === 'wall') c += 400 + r.dmg * 40 + (18 - r.t) * 10
  if (r.kind === 'ceil') c += 60 + (18 - r.t) * 3
  if (goal.kind === 'land') {
    if (r.kind === 'floor') {
      // Сели: высота падения по правилам сервера, пустота/лава под точкой.
      const fall = Math.max(0, r.fd - SAFE_FALL)
      c += fall * 60
      const f = W.floorBelow(r.p.x, r.p.y + 0.5, r.p.z, 3)
      if (!f || f.lava) c += 5000
      c += Math.hypot(r.p.x - goal.at.x, r.p.z - goal.at.z) * 1.5
      if (goal.away) c -= Math.min(20, Math.hypot(r.p.x - goal.away.x, r.p.z - goal.away.z)) * 0.5
      // Край рядом: скольжение после касания (трение 0.546) — до ~2 блоков.
      if (goal.edge && goal.edge(r.p)) c += 300
      c += r.t * 0.3
    } else {
      // Не сели за горизонт: ближе к точке и ниже, но не в пустоту.
      c += Math.hypot(end.x - goal.at.x, end.z - goal.at.z) * 1.5 + Math.max(0, end.y - goal.at.y) * 2 + 20
      // Высота падения в конце прогона (S7d): спуск пике копит её (офлайн landsim — до 17–29 бл. к выходу у пола), и
      // любой обрыв полёта на спуске — смерть. LAND_FD (ND_LAND_FD, по умолчанию 2) за блок сверх безопасных 3.
      c += Math.max(0, r.fd - SAFE_FALL) * LAND_FD
      const f = W.floorBelow(end.x, end.y, end.z, 30)
      if (!f) c += 80
    }
    return c
  }
  // Пике: пол после точки свапа — не беда (дальше свободное падение и удар).
  if (r.kind === 'floor' && goal.kind !== 'strike') c += 300 + Math.max(0, r.fd - SAFE_FALL) * 60 + (18 - r.t) * 8
  if (goal.kind === 'strike') {
    // Пике: в какой первый тик прогона свап на нагрудник даёт удар — свободное
    // падение с этой точки (fallStep) входит в его руку за 1–3 тика выше его
    // головы, а высота падения к этому тику уже > 1.8 (MaceItem.canSmashAttack
    // > 1.5). Нет такого — насколько близко пройдём.
    const path = r.path || []
    const foot = goal.foot || ((t) => at(t))
    let first = null
    let bestD = Infinity
    for (let t = 0; t < path.length && !first; t++) {
      const s = path[t]
      const f0 = foot(t + 1)
      const d0 = Math.hypot(s.x - f0.x, s.y - f0.y, s.z - f0.z)
      if (d0 < bestD) bestD = d0
      if (s.fd < 1.8 || s.vy > -0.45) continue
      const q = { x: s.x, y: s.y, z: s.z }; const w = { x: s.vx, y: s.vy, z: s.vz }
      for (let k = 1; k <= 3; k++) {
        fallStep(q, w)
        const fk = foot(t + 1 + k)
        if (q.y < fk.y + 0.6) break
        const rr = reachFromBox({ x: q.x, y: q.y + EYE, z: q.z }, fk, 0.6, 1.8)
        if (rr <= REACH - 0.3) { first = { t, k, fd: s.fd + (s.y - q.y) }; break }
      }
    }
    if (first) c += first.t + first.k * 0.5 - Math.min(10, first.fd) * 0.8
    else c += 60 + bestD * 4 + (r.kind === 'floor' ? 300 + (18 - r.t) * 8 : 0)
    return c
  }
  // point: к точке, в коридоре высот, подальше от него, не сваливаться.
  // reach — важно пройти через точку (ближе всего за прогон), а не где конец.
  const tgt = at(r.t)
  if (goal.reach && r.path && r.path.length) {
    let bestD = Infinity; let bestT = 0
    for (let t = 0; t < r.path.length; t++) {
      const q = r.path[t]
      // Цель на ТОМ ЖЕ тике, что и точка пути (ревью Codex: раньше — его место в конце прогона для всех точек).
      const tt = at(t + 1)
      const d = Math.hypot(q.x - tt.x, q.y - tt.y, q.z - tt.z)
      if (d < bestD) { bestD = d; bestT = t }
    }
    c += bestD + bestT * 0.15
  } else c += Math.hypot(end.x - tgt.x, end.y - tgt.y, end.z - tgt.z)
  if (goal.minY != null && end.y < goal.minY) c += (goal.minY - end.y) * 4
  if (goal.maxY != null && end.y > goal.maxY) c += (end.y - goal.maxY) * 4
  if (goal.gap != null && r.minFloorGap < goal.gap) c += (goal.gap - r.minFloorGap) * 10
  const hs = Math.hypot(r.v.x, r.v.z)
  if (goal.speedMin != null && hs < goal.speedMin) c += (goal.speedMin - hs) * 30
  if (goal.away) {
    const dd = Math.hypot(end.x - goal.away.x, end.z - goal.away.z)
    if (dd < (goal.awayR || 8)) c += ((goal.awayR || 8) - dd) * 4
  }
  // Резкий крен без нужды — дрожь взгляда: чуть дороже.
  c += Math.abs(pitch) * 0.5
  return c
}

export {
  PITCHES, YAW_OFF, choose, cost
}
