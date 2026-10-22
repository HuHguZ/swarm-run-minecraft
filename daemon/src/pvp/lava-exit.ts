// Выход из лавы (стенд 15×15, a27 21.10: 5 из 16 смертей — «tried to swim in lava»; ямы лавы Колизея вровень с полом,
// 3×3, кольцо магмы: из середины ямы до края 1–1.5 бл., край — на блок выше ног). Прежний выход смотрел только соседние
// клетки на уровне ног — в яме вровень с полом таких нет (вокруг лава и стенка магмы), бот стоял в лаве.
// Здесь — ближайшая клетка, где можно стоять: на уровне ног или на блок выше (запрыгнуть), до 3 бл., не лава/огонь;
// цель — поле, не кольцо магмы (DeepSeek t3 21.10: с магмы у ямы следующий удар — снова в лаву, а магма жжёт): магма —
// +1.5, берётся, только если поле дальше. Чем ближе — тем лучше; дальше от врага — при равных.
import { Vec3 } from './vec3'
import * as gameClock from '../game-clock'

const BURN = /^(lava|fire|soul_fire)$/
const HOT = /^(magma_block|campfire|soul_campfire)$/
const open = b => !!b && b.boundingBox === 'empty' && !BURN.test(b.name) && b.name !== 'cobweb'

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
export function burningFeet (bot) {
  const p = bot.entity.position
  const at = (dy) => bot.blockAt(p.offset(0, dy, 0).floored())
  const f = at(0); const h = at(1); const g = at(-0.2)
  if ((f && BURN.test(f.name)) || (h && BURN.test(h.name)) || (g && HOT.test(g.name))) return true
  if (bot.entity.onGround) return false
  for (const dy of [-0.6, -1.2]) { const b = at(dy); if (b && b.boundingBox === 'block') return false; if (b && BURN.test(b.name)) return true }
  return false
}

// Быстрый выход (без pathfinder'а: «goto на 3 бл.» в яме — A* и запуск пути, пока лава снимает 4 хп за 0.5 с): взгляд на
// клетку lavaExit, вперёд + прыжок + спринт, пока под ногами горит, до limitMs; цель пересчитывается раз в 300 мс
// (отброс, течение). Возвращает { ok, ms, why }.
// Время — игровое (game-clock): на ускоренном сервере стенка в миллисекундах — другие тики в лаве.
export async function escapeBurn (bot, { limitMs = 2500, foe = null as any, aborted = () => false, sleep = (ms: number) => new Promise(r => gameClock.setTimeout(r, ms)), now = () => gameClock.now() } = {}) {
  const t0 = now()
  let exit = null; let at = -1e9
  try {
    while (burningFeet(bot) && now() - t0 < limitMs && !aborted() && (bot.health ?? 0) > 0) {
      if (now() - at >= 300 || !exit) { exit = lavaExit(bot, bot.entity.position, foe) || exit; at = now() }
      if (!exit) return { ok: false, ms: now() - t0, why: 'некуда' }
      await bot.lookAt(exit.cell.offset(0.5, 1, 0.5), true).catch(() => {})
      for (const k of ['back', 'left', 'right', 'sneak']) bot.setControlState(k, false)
      bot.setControlState('forward', true); bot.setControlState('jump', true); bot.setControlState('sprint', true)
      await sleep(50)
    }
  } finally { for (const k of ['forward', 'jump', 'sprint']) bot.setControlState(k, false) }
  const ok = !burningFeet(bot)
  return { ok, ms: now() - t0, why: ok ? 'вышел' : 'не вышел' }
}
