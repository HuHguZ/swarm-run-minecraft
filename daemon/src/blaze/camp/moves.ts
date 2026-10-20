'use strict'
// Лагерь у спавнера (campSpawner) — ходы тела: столб с чашкой, лук по цели, спуск со столба на помост.
import * as gameClock from '../../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../../movement'
import { log, reachTo, liveBlazes } from '../targets'
import { makeTrack } from '../approach'
import { type CampState, PILLAR } from './state'

// Стенки «чашки» на вершине: блок у опоры (сбоку от верхнего блока столба) и на нём — у ног. Отдача удара блейза
// скидывала тело со столба 1×1 к иссушителям (B8f23 03.10: дважды за 3 мин), а голова над стенками — бой как был.
export async function campCup (cs: CampState) {
  const { bot, ctl } = cs
  const { placeBlockAt }: typeof import('../../build') = require('../../build')
  const f = bot.entity.position.floored()
  let placed = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (ctl.aborted || cs.fillers() < 2) break
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

export async function campClimb (cs: CampState) {
  const { bot, ctl, p, setPhase } = cs
  if (cs.onTop()) return true
  if (p.campPillar === false || cs.fillers() < PILLAR) return false
  if (gameClock.now() - cs.climbFailAt < 6000) return false
  // Столб — с пола у спавнера (помост, ступени, стенка: ±2 от уровня помоста — B11f31 03.10 стоял на +1 и столб
  // не строился, иссушитель убил).
  if (Math.abs(bot.entity.position.y - cs.floorY) > 2.2 || !bot.entity.onGround) return false
  setPhase('лагерь: столб')
  cs.post = bot.entity.position.floored()
  const r: Partial<Awaited<ReturnType<typeof import('../../build').towerUp>>> = await (require('../../build') as typeof import('../../build')).towerUp(bot, ctl, PILLAR, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
  cs.out.towers++
  let walls = 0
  if (cs.onTop()) { bot.setControlState('sneak', true); walls = await campCup(cs) } else cs.climbFailAt = gameClock.now()
  log('лагерь: столб', { ok: !!(r && r.ok), placed: r && r.placed, walls, reason: r && r.reason, y: Math.round(bot.entity.position.y * 10) / 10, post: xyz(cs.post) })
  await cs.equipSword()
  setPhase('лагерь у спавнера')
  return cs.onTop()
}

// Лук по цели (блейз или иссушитель): точка — середина рамки с упреждением.
export async function campShoot (cs: CampState, e, frac = 0.55) {
  const { bot, dead } = cs
  const track = makeTrack(e)
  track.update()
  const r = await (require('../../bow') as typeof import('../../bow')).shoot(bot, e, {
    velFn: () => { track.update(); return track.vel() },
    point: t => { track.update(); const v = track.vel(); return e.position.offset(v.x * t, (e.height || 1.8) * frac + v.y * t, v.z * t) },
    follow: false,
    mode: 'settle',
    shouldStop: () => !e.isValid || liveBlazes(bot, dead, 6).some(b => reachTo(bot, b) <= 2.6)
  }).catch(err => ({ shot: false, why: err.message }))
  await cs.equipSword()
  return r || { shot: false }
}

// Слезть со столба на помост: шаг в соседнюю клетку помоста (пол на уровне основания столба).
export async function campDescend (cs: CampState) {
  const { bot, ctl, spawner, setPhase } = cs
  cs.descWhy = ''
  const f = bot.entity.position.floored()
  if (f.y - cs.floorY > 5) { cs.descWhy = 'высоко'; return false }
  const cells = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => new Vec3(f.x + dx, cs.floorY, f.z + dz)).filter(c => {
    const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0))
    if (!a || !b || !u) return false
    if (a.boundingBox !== 'empty' || b.boundingBox !== 'empty' || u.boundingBox !== 'block' || /lava|fire|magma/.test(u.name)) return false
    // Столб над ней до нашей высоты — свободен.
    for (let y = c.y + 2; y <= f.y + 1; y++) { const q = bot.blockAt(new Vec3(c.x, y, c.z)); if (!q || q.boundingBox !== 'empty') return false }
    return !(spawner && c.x === spawner.x && c.z === spawner.z)
  })
  // Стенки чашки: в выбранную сторону — снести блок у ног и опору под ним (свои блоки, видно вплотную).
  const SL: typeof import('../../sealed') = require('../../sealed')
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  let c = cells[0]
  if (!c) {
    for (const [dx, dz] of dirs) {
      const w0 = f.offset(dx, 0, dz); const w1 = f.offset(dx, -1, dz)
      const land = new Vec3(f.x + dx, cs.floorY, f.z + dz)
      const u = bot.blockAt(land.offset(0, -1, 0)); const a = bot.blockAt(land)
      if (!u || u.boundingBox !== 'block' || /lava|fire|magma/.test(u.name) || !a || a.boundingBox !== 'empty') continue
      let clear = true
      for (let y = cs.floorY + 1; y < f.y - 1; y++) { const q = bot.blockAt(new Vec3(land.x, y, land.z)); if (!q || q.boundingBox !== 'empty') { clear = false; break } }
      if (!clear) continue
      const r0 = await SL.digCell(bot, w0).catch(e => 'err ' + e.message)
      const r1 = await SL.digCell(bot, w1).catch(e => 'err ' + e.message)
      const b0 = bot.blockAt(w0); const b1 = bot.blockAt(w1)
      if (b0 && b0.boundingBox === 'empty' && b1 && b1.boundingBox === 'empty') { c = land; break }
      cs.descWhy = `стенка ${xyz(w0)}: ${r0}/${r1}`
    }
  }
  if (!c) {
    // Шагнуть некуда (стоим над краем зала, у забора: B10f21 03.10 — 30 с наверху, 0 ударов) — копать вниз под собой:
    // свой блок/забор/стенку, по 1 клетке, пока ноги не у помоста (под колонной — твёрдое, без лавы).
    setPhase('лагерь: вниз копкой')
    bot.setControlState('sneak', false)
    for (let k = 0; k < 5 && !ctl.aborted && bot.entity.position.y >= cs.floorY + 1.5; k++) {
      const g0 = bot.entity.position.floored()
      let landY = null
      for (let y = g0.y - 2; y >= cs.floorY - 2; y--) { const q = bot.blockAt(new Vec3(g0.x, y, g0.z)); if (!q) break; if (/lava|fire/.test(q.name)) { landY = null; break } if (q.boundingBox === 'block') { landY = y; break } }
      if (landY == null || g0.y - 1 - landY > 4) { cs.descWhy = `под собой пусто/лава (land ${landY})`; return false }
      const r = await SL.digCell(bot, g0.offset(0, -1, 0)).catch(() => 'err')
      if (r !== 'ok' && r !== 'air') { cs.descWhy = 'копка вниз: ' + r; return false }
      for (let i = 0; i < 30 && !bot.entity.onGround; i++) await sleep(50)
      await sleep(150)
    }
    cs.out.descents++
    if (bot.entity.position.y < cs.floorY + 2.6) cs.base = bot.entity.position.floored()
    return bot.entity.position.y < cs.floorY + 2.6
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
  cs.out.descents++
  if (bot.entity.position.y < cs.floorY + 1) cs.base = bot.entity.position.floored()
  else cs.descWhy = `шагнул к ${xyz(c)}, а стою на ${Math.round(bot.entity.position.y * 10) / 10}`
  return bot.entity.position.y < cs.floorY + 1
}
