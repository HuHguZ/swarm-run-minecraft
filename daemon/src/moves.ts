'use strict'
// Шаги клавишами: куда смотрит какая клавиша и можно ли туда шагнуть. Общее
// для боя (pvp.js) и побега (flee.js) — отдельно, чтобы они не тянули друг
// друга по кругу.

function blockName (bot, p) {
  const b = bot.blockAt(p)
  return b ? b.name : null
}

function solid (bot, p) {
  const b = bot.blockAt(p)
  return !!b && b.boundingBox === 'block'
}

const HURTS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'campfire', 'soul_campfire', 'powder_snow', 'wither_rose'])

// Можно ли пройти на ~0.9 блока в эту сторону: не в лаву и огонь, не с обрыва
// выше трёх блоков и не в стену выше прыжка. Стена раньше считалась «не
// опасностью» — и бот, убегая от крипера, бежал в стекло арены и долбился в
// него. Ступенька в блок проходима (перепрыгнем), стена в два — нет.
// water:false — ещё и в воду не шагать: в ней медленно и нельзя критовать,
// в бою это проигрыш; горящему, наоборот, вода нужна.
// reach — куда проверять: 0.9 для шага; для прыжка с разбега — дальше (прыжок
// несёт вперёд на ~1.5 блока шагом и до ~2.5 спринтом).
// Паутина у ног или головы — тоже не шаг: в ней ход ×0.25, прыжок ×0.05 и ни
// крита, ни уворота (WebBlock.entityInside). Раньше её знал только шаг к нему
// (pvp.js webAhead), а увороты, отходы, стрейфы и бег из-под булавы водили
// ботов в паутину, как будто её нет (арена 2026-09-26).
const SLOWS = new Set(['cobweb'])
function stepSafe (bot, dir, { water = true, reach = 0.9 }: any = {}) {
  const me = bot.entity.position
  const p = me.offset(dir.x * reach, 0, dir.z * reach)
  const feet = p.floored()
  for (const dy of [0, 1]) {
    const n = blockName(bot, feet.offset(0, dy, 0))
    if (n && (HURTS.has(n) || SLOWS.has(n))) return false
    if (!water && dy === 0 && n === 'water') return false
  }
  if (solid(bot, feet)) {
    return !solid(bot, feet.offset(0, 1, 0)) && !solid(bot, feet.offset(0, 2, 0)) &&
      !solid(bot, me.floored().offset(0, 2, 0))
  }
  if (solid(bot, feet.offset(0, 1, 0))) return false
  for (let dy = 1; dy <= 4; dy++) {
    const below = feet.offset(0, -dy, 0)
    const n = blockName(bot, below)
    if (n && HURTS.has(n)) return false
    if (n === 'water') return water
    if (solid(bot, below)) return dy <= 3
  }
  return false
}

// Ступенька по ходу на уровне ног при свободной голове — перепрыгнуть.
function wantsJump (bot, dir) {
  const me = bot.entity.position
  const p = me.offset(dir.x * 0.7, 0, dir.z * 0.7).floored()
  return solid(bot, p) && !solid(bot, p.offset(0, 1, 0)) && !solid(bot, me.floored().offset(0, 2, 0))
}

// Направления клавиш в мире при текущем взгляде.
function keyDir (bot, key) {
  const y = bot.entity.yaw
  const f = { x: -Math.sin(y), z: -Math.cos(y) }
  const r = { x: Math.cos(y), z: -Math.sin(y) }
  switch (key) {
    case 'forward': return f
    case 'back': return { x: -f.x, z: -f.z }
    case 'right': return r
    case 'left': return { x: -r.x, z: -r.z }
  }
  return { x: 0, z: 0 }
}

module.exports = { blockName, solid, stepSafe, wantsJump, keyDir, HURTS }
