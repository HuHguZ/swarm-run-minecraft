'use strict'
const gameClock = require('./game-clock')
// Стояние на столбах (интеграционная арена 2026-09-26): оба бота на своих
// столбах в 4–5 блоках над полом, в 4.8 друг от друга, и минутами никто
// никого не бьёт: рефлекс края (edges.guard) не пускает шагнуть с обрыва
// глубже трёх, а мостить никто не умеет. Выход — как у человека:
//  · мост к нему: блок на уровне своей опоры перед собой, присев (присед
//    держит на краю — prismarine-physics, как и ванильный клиент), шаг на
//    новый блок, следующий — пока он не в досягаемости руки;
//  · или спуск туда, где урон от падения дёшев: floor(h − 3)
//    (world/entity/LivingEntity.calculateFallDamage, клиент 1.21.11), при
//    запасе хп и безопасной посадке; рефлекс края пропускает по allow().

const Vec3 = require('vec3')
const edges = require('./edges')
const { placeBlockAt, pickFiller } = require('./build')

const EYE = 1.62
const HIT_REACH = 2.9
const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))

function reachFrom (eye, e) {
  const hw = (e.width || 0.6) / 2
  const h = e.height || 1.8
  const p = e.position
  const cx = Math.max(p.x - hw, Math.min(p.x + hw, eye.x))
  const cy = Math.max(p.y, Math.min(p.y + h, eye.y))
  const cz = Math.max(p.z - hw, Math.min(p.z + hw, eye.z))
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

// Под шагом к нему — обрыв глубже безопасного (мы наверху).
function elevatedToward (bot, foePos) {
  const me = bot.entity.position
  const dx = foePos.x - me.x; const dz = foePos.z - me.z
  const n = Math.hypot(dx, dz) || 1
  const p = me.offset(dx / n, 0, dz / n)
  const c = edges.column(bot, Math.floor(p.x), Math.floor(p.z), me.y)
  return { drop: c.drop, lava: !!c.lava, water: !!c.water, unknown: !!c.unknown }
}

// Следующая клетка моста: соседняя к нему (по большей оси), на уровне опоры.
function nextCell (bot, foePos) {
  const me = bot.entity.position
  const y = Math.floor(me.y + 1e-6) - 1
  const x0 = Math.floor(me.x); const z0 = Math.floor(me.z)
  const dx = foePos.x - (x0 + 0.5); const dz = foePos.z - (z0 + 0.5)
  if (Math.abs(dx) < 0.6 && Math.abs(dz) < 0.6) return null
  return Math.abs(dx) >= Math.abs(dz) ? new Vec3(x0 + Math.sign(dx), y, z0) : new Vec3(x0, y, z0 + Math.sign(dz))
}

// Шаг на клетку (её верх — на уровне ног), присев: с края не сорвёмся.
async function stepOnto (bot, ctl, cell) {
  const tgt = cell.offset(0.5, 1, 0.5)
  await bot.lookAt(tgt.offset(0, 0.2, 0), true).catch(() => {})
  bot.setControlState('forward', true)
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 900 && !ctl.aborted) {
      const p = bot.entity.position
      if (Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.hypot(p.x - tgt.x, p.z - tgt.z) < 0.35) break
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
}

// Мост к нему. Вернёт { ok, placed, why }.
async function build (bot, ctl, foe, { maxBlocks = 6, timeoutMs = 8000 }: any = {}) {
  const t0 = gameClock.now()
  let placed = 0
  if (!pickFiller(bot)) return { ok: false, placed, why: 'нечем мостить' }
  bot.setControlState('sprint', false)
  bot.setControlState('sneak', true)
  try {
    while (!ctl.aborted && gameClock.now() - t0 < timeoutMs && placed <= maxBlocks) {
      if (!foe.isValid) return { ok: false, placed, why: 'он пропал' }
      const eye = bot.entity.position.offset(0, EYE, 0)
      if (reachFrom(eye, foe) <= HIT_REACH) return { ok: true, placed, why: 'достаю рукой' }
      const cell = nextCell(bot, foe.position)
      if (!cell) return { ok: true, placed, why: 'рядом' }
      const b = bot.blockAt(cell)
      if (!b) return { ok: false, placed, why: 'мир не прогружен' }
      if (b.boundingBox !== 'block') {
        // Взгляд — на грань, к которой ставим (свою опору), а не на него.
        const r = await placeBlockAt(bot, cell, { timeoutMs: 900 })
        if (!r.ok) return { ok: false, placed, why: r.reason || 'не поставил' }
        if (!r.already) placed++
      }
      // Над мостом должно быть свободно: ноги и голова.
      for (const up of [1, 2]) { const hb = bot.blockAt(cell.offset(0, up, 0)); if (hb && hb.boundingBox === 'block') return { ok: false, placed, why: 'над мостом блок' } }
      await stepOnto(bot, ctl, cell)
    }
  } finally {
    bot.setControlState('sneak', false)
    bot.setControlState('forward', false)
  }
  return { ok: false, placed, why: 'не успел' }
}

// Спуск туда, где урон от падения дёшев, поближе к нему. edgeGuard — рефлекс
// края этого боя (edges.guard): allow пропускает намеренное падение.
async function dropDown (bot, ctl, foe, { edgeGuard, minHpAfter = 8 }: any = {}) {
  const me = bot.entity.position
  const hp = bot.health ?? 20
  let best = null
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4
    const p = me.offset(-Math.sin(a) * 1.0, 0, -Math.cos(a) * 1.0)
    const c = edges.column(bot, Math.floor(p.x), Math.floor(p.z), me.y)
    if (c.lava || c.unknown || c.drop <= 0.5 || c.drop > 23) continue
    const dmg = c.water ? 0 : Math.max(0, Math.floor(c.drop - 3 + 1e-6))
    if (hp - dmg < minHpAfter) continue
    const land = p.offset(0, -c.drop, 0)
    const sc = dmg * 2 + land.distanceTo(foe.position) * 0.5
    if (!best || sc < best.sc) best = { sc, a, dmg, drop: c.drop }
  }
  if (!best) return { ok: false, why: 'посадки с дешёвым падением нет' }
  edgeGuard && edgeGuard.allow(Math.ceil(best.drop) + 1, 1500)
  await bot.look(best.a, 0, true).catch(() => {})
  bot.setControlState('sneak', false)
  bot.setControlState('forward', true)
  const y0 = me.y
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 900 && bot.entity.position.y > y0 - 0.6 && !ctl.aborted) await sleep(50)
  } finally { bot.setControlState('forward', false) }
  return { ok: bot.entity.position.y < y0 - 0.5, dmg: best.dmg, drop: Math.round(best.drop * 10) / 10 }
}

module.exports = { elevatedToward, nextCell, build, dropDown, reachFrom, stepOnto }
