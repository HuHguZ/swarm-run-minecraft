// Выход из лавы (стенд 15×15, a27 21.10: 5 из 16 смертей — «tried to swim in lava»; ямы лавы Колизея вровень с полом,
// 3×3, кольцо магмы: из середины ямы до края 1–1.5 бл., край — на блок выше ног). Прежний выход смотрел только соседние
// клетки на уровне ног — в яме вровень с полом таких нет (вокруг лава и стенка магмы), бот стоял в лаве.
// Здесь — ближайшая клетка, где можно стоять: на уровне ног или на блок выше (запрыгнуть), до 3 бл., не лава/огонь;
// цель — поле, не кольцо магмы (DeepSeek t3 21.10: с магмы у ямы следующий удар — снова в лаву, а магма жжёт): магма —
// +1.5, берётся, только если поле дальше. Чем ближе — тем лучше; дальше от врага — при равных.
import { Vec3 } from './vec3'
import * as gameClock from '../game-clock'
import { bodyBox, dimensions, intersects } from '../navigation/geometry'

const BURN = /^(lava|fire|soul_fire)$/
const HOT = /^(magma_block|campfire|soul_campfire)$/
const open = b => !!b && b.boundingBox === 'empty' && !BURN.test(b.name) && b.name !== 'cobweb'
function litCampfire (b) {
  if (b?.name !== 'campfire' && b?.name !== 'soul_campfire') return false
  const lit = b.getProperties?.().lit
  return lit === true || lit === 'true'
}

export function burnContact (bot) {
  if (bot.entity.isInLava) return 'lava'
  const body = bodyBox(bot, bot.entity.position)
  for (let x = Math.floor(body.minX); x <= Math.floor(body.maxX); x++) for (let z = Math.floor(body.minZ); z <= Math.floor(body.maxZ); z++) {
    for (let y = Math.floor(body.minY); y <= Math.floor(body.maxY); y++) {
      const b = bot.blockAt(new Vec3(x, y, z), false)
      if (b && BURN.test(b.name) && intersects(body, { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 })) return b.name
    }
  }
  return null
}

// На кромке центр может висеть над лавой, пока соседняя магма держит край стоп.
// Сравниваем высоту стоп с верхом формы: со ступени выше соседняя магма не жжёт.
export function hotSupport (bot): string | null {
  const p = bot.entity.position, { half } = dimensions(bot)
  // Магма 1.21.11 — полный куб, у костра верх коллизии на 7/16. Два таких верха
  // одновременно держать одни стопы не могут. На остальных высотах смотреть блоки незачем.
  const full = Math.abs(p.y - Math.round(p.y)) < 1e-5
  const y = full ? Math.round(p.y) - 1 : Math.floor(p.y)
  if (!full && Math.abs(p.y - (y + 7 / 16)) >= 1e-5) return null
  for (let x = Math.floor(p.x - half + 1e-7); x <= Math.floor(p.x + half - 1e-7); x++) for (let z = Math.floor(p.z - half + 1e-7); z <= Math.floor(p.z + half - 1e-7); z++) {
    const block = bot.blockAt(new Vec3(x, y, z), false)
    if (full && block?.name === 'magma_block') return block.name
    if (!full && litCampfire(block)) return block.name
  }
  return null
}

export function lavaExit (bot, feet: any, foe: { x: number; z: number } | null = null) {
  const f = feet.floored()
  let best = null
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (!dx && !dz) continue
      const d = Math.hypot(dx, dz)
      if (d > 3.2) continue
      for (const up of [0, 1]) {
        const c = new Vec3(f.x + dx, f.y + up, f.z + dz)
        const ground = bot.blockAt(c.offset(0, -1, 0))
        if (!ground || ground.boundingBox !== 'block' || BURN.test(ground.name)) continue
        if (!open(bot.blockAt(c)) || !open(bot.blockAt(c.offset(0, 1, 0)))) continue
        // Запрыгнуть на блок — над головой при прыжке свободно.
        if (up && !open(bot.blockAt(f.offset(0, 2, 0)))) continue
        let s = d + up * 0.3 + (HOT.test(ground.name) ? 1.5 : 0)
        // Враг — только при равных (до 0.3): в лаве лишний блок пути — ещё 4 хп.
        if (foe) s -= Math.min(0.3, Math.hypot(c.x + 0.5 - foe.x, c.z + 0.5 - foe.z) * 0.03)
        if (!best || s < best.s) best = { cell: c, s, up: !!up, d, hot: HOT.test(ground.name) }
      }
    }
  }
  return best
}

// Горит ли под ногами: ноги или голова в лаве/огне, стою на магме/костре — или в прыжке над лавой (выпрыгнул на миг и
// упаду обратно: a39 — выход «кончался» на взлёте, и его тут же начинали заново, теряя ход).
function footHazard (bot): string | null {
  const immediate = burnContact(bot) || hotSupport(bot)
  if (immediate) return immediate
  const p = bot.entity.position
  const at = (dy) => bot.blockAt(p.offset(0, dy, 0).floored(), false)
  if (!bot.entity.onGround) for (const dy of [-0.6, -1.2]) {
    const b = at(dy)
    if (b && b.boundingBox === 'block') return b.name === 'magma_block' || litCampfire(b) ? 'above_hot_floor' : null
    if (b && BURN.test(b.name)) return b.name
  }
  return null
}

export function burningFeet (bot) {
  return footHazard(bot) !== null
}

// Быстрый выход (без pathfinder'а: «goto на 3 бл.» в яме — A* и запуск пути, пока лава снимает 4 хп за 0.5 с): взгляд на
// клетку lavaExit, вперёд + прыжок + спринт, пока под ногами горит, до limitMs; цель пересчитывается раз в 300 мс
// (отброс, течение). Возвращает { ok, ms, why }.
// Время — игровое (game-clock): на ускоренном сервере стенка в миллисекундах — другие тики в лаве.
export async function escapeBurn (bot, { limitMs = 2500, foe = null as any, aborted = () => false, sleep = (ms: number) => new Promise(r => gameClock.setTimeout(r, ms)), now = () => gameClock.now() } = {}) {
  const t0 = now()
  let exit = null; let at = -1e9
  let hazard: string | null, crouching = false
  try {
    while ((hazard = footHazard(bot)) && now() - t0 < limitMs && !aborted() && (bot.health ?? 0) > 0) {
      crouching = hazard === 'magma_block'
      bot.setControlState('sneak', crouching)
      if (now() - at >= 300 || !exit) { exit = lavaExit(bot, bot.entity.position, foe) || exit; at = now() }
      if (!exit) return { ok: false, ms: now() - t0, why: 'некуда' }
      await bot.lookAt(exit.cell.offset(0.5, 1, 0.5), true).catch(() => {})
      for (const k of ['back', 'left', 'right']) bot.setControlState(k, false)
      bot.setControlState('forward', true); bot.setControlState('jump', !crouching || exit.up); bot.setControlState('sprint', !crouching)
      await sleep(50)
    }
  } finally {
    for (const k of ['forward', 'jump', 'sprint']) bot.setControlState(k, false)
    if (crouching && (aborted() || !bot.entity || !bot.health || hotSupport(bot) !== 'magma_block')) bot.setControlState('sneak', false)
  }
  const ok = !burningFeet(bot)
  return { ok, ms: now() - t0, why: ok ? 'вышел' : 'не вышел' }
}
