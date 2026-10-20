'use strict'
// Мост и спуск блоками (blockmoves.ts) — геометрия исполнителя: окно щелчка по грани опоры, клавиши и взгляд на тик,
// руль ступени спуска. Чистые функции; исполнитель — blockmoves/exec*.ts.
import { EYE } from './cells'

// ---------------------------------------------------------------- геометрия исполнителя
// s — насколько центр тела ушёл за плоскость боковой грани опоры (по ходу моста); 0 < s ≤ 0.3 — окно щелчка:
// глаза уже над пустотой (грань видна), а хитбокс ещё на опоре.
function geometry (pos, ref, dir) {
  const ax = dir.x ? 'x' : 'z'
  const sg = dir.x || dir.z
  const plane = ref[ax] + (sg > 0 ? 1 : 0)
  const lat = ax === 'x' ? 'z' : 'x'
  return { s: (pos[ax] - plane) * sg, off: pos[lat] - (ref[lat] + 0.5), ax, lat, plane }
}

// Клавиши и взгляд на тик: спиной по ходу моста («назад»), курс — на точку на оси моста впереди, взгляд — на
// центр боковой грани опоры. Окно — щёлкнуть после пакета этого тика.
function decide ({ pos, onGround, ref, dir, cellSolid, refSolid, pending, eye = EYE }: any) {
  const g = geometry(pos, ref, dir)
  // Лицом строго против хода (взгляд (−sin, −cos) = −dir), вбок — клавишей: «вправо» ведёт по (cos yaw, −sin yaw)
  // (prismarine-physics applyHeading). Тело, вошедшее в мост наискось, к оси подтягивается раньше края: иначе
  // pathfinder не засчитывает узел (|dz| > 0.35) и тело проезжает клетку (ферма 02.10, mv-gap-1 река: смещение 0.78).
  const yaw = Math.atan2(dir.x, dir.z)
  let strafe = null
  if (Math.abs(g.off) > 0.08) {
    const c = { x: 0, z: 0 }; c[g.lat] = -Math.sign(g.off)
    strafe = (Math.cos(yaw) * c.x - Math.sin(yaw) * c.z) > 0 ? 'right' : 'left'
  }
  const fx = g.ax === 'x' ? g.plane : ref.x + 0.5
  const fz = g.ax === 'z' ? g.plane : ref.z + 0.5
  const dy = (ref.y + 0.5) - (pos.y + eye)
  const pitch = Math.atan2(dy, Math.max(0.05, Math.hypot(fx - pos.x, fz - pos.z)))
  let place = false
  // Окно: глаза за гранью (s > 0), тело ещё на земле. Обычно это s ∈ (0, 0.3) — хитбокс 0.6 на опоре; дальше — только если
  // тело перенесли (fullStop pathfinder'а центрирует его в клетке без опоры, ревью Codex 02.10): поставить сейчас,
  // до следующего тика физики, — иначе падение.
  if (!cellSolid && !pending && refSolid && onGround && g.s > 1e-4 && g.s < 0.85 && Math.abs(g.off) < 0.75) place = true
  return { yaw, pitch, place, s: g.s, off: g.off, strafe }
}

function steerTo (bot, e, dest, sneak) {
  const ph = bot.physics || {}
  const onG = !!e.onGround
  const slip = ph.defaultSlipperiness ?? 0.6
  const inertia = onG ? slip * 0.91 : (ph.airborneInertia ?? 0.91)
  const base = onG ? (ph.playerSpeed ?? 0.1) * 0.1627714 / inertia ** 3 : (ph.airborneAcceleration ?? 0.02)
  const acc = base * 0.98 * (sneak ? (ph.sneakSpeed ?? 0.3) : 1)
  const dx = dest.x - e.position.x; const dz = dest.z - e.position.z
  const len = Math.hypot(dx, dz); const speed = Math.hypot(e.velocity.x, e.velocity.z)
  const want = Math.min(sneak ? 0.06 : 0.19, len * 0.5)
  const ax = (len ? dx / len * want / inertia : 0) - e.velocity.x
  const az = (len ? dz / len * want / inertia : 0) - e.velocity.z
  return { yaw: Math.atan2(-ax, -az), forward: Math.hypot(ax, az) > acc * 0.5 && !(len < 0.03 && speed < 0.015) }
}

export { geometry, decide, steerTo }
