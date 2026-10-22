// Мост по воде на бегу (пользователь 21.10, «как Dream»): плыть по поверхности медленно (~2 бл/с), а по своим блокам —
// бег. Блок — в клетку воды перед собой на уровне пола, к видимой передней грани блока, на котором стою (pick: только
// видимая грань — она видна, когда глаза уже за краем: присед у края держит тело на блоке, сколько бы ни свисало).
// Шаг моста: бег к краю → присед у края (сам клампит тело на блоке — не упасть) → блок вперёд (build.placeBlockAt
// honest) → снова бег на новый блок. Направление — по ближней оси (мост прямой, грань — одна из четырёх).
import * as gameClock from './game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const WATERY = /^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/
const isWater = b => !!b && (WATERY.test(b.name) || b.getProperties?.()?.waterlogged === true)
const open = b => !!b && b.boundingBox === 'empty' && !isWater(b) && !/lava|fire|cobweb/.test(b.name)
const solid = b => !!b && b.boundingBox === 'block' && !/magma|lava|fire/.test(b.name)

// Ближняя ось направления yaw (mineflayer: взгляд (−sin yaw, −cos yaw)).
export function axisOf (yaw: number) {
  const x = -Math.sin(yaw); const z = -Math.cos(yaw)
  return Math.abs(x) >= Math.abs(z) ? { x: Math.sign(x) || 1, z: 0 } : { x: 0, z: Math.sign(z) || 1 }
}

// Что впереди по оси от клетки опоры (блок под ногами): 'land' — пол есть, иди; 'place' — пол вода, ноги и голова над
// ней свободны: ставить блок в cell к грани опоры; 'blocked' — стена или опасность; 'none' — не над водой (обрыв в воздух
// и т.п. — не мост по воде).
export function bridgeStep (world: { blockAt: (p: any) => any }, support: any, dir: { x: number; z: number }) {
  const cell = support.offset(dir.x, 0, dir.z)
  const floor = world.blockAt(cell)
  const feet = world.blockAt(cell.offset(0, 1, 0)); const head = world.blockAt(cell.offset(0, 2, 0))
  if (!feet || !head || (!open(feet) && !isWater(feet)) || (!open(head) && !isWater(head))) return { kind: 'blocked', cell }
  if (isWater(feet)) return { kind: 'blocked', cell } // вода выше пола — это заплыв, не мост
  if (solid(floor)) return { kind: 'land', cell }
  if (isWater(floor)) return { kind: 'place', cell, against: support, face: new Vec3(dir.x, 0, dir.z) }
  return { kind: 'none', cell }
}

// Сколько клеток воды по оси впереди до берега (≤ max) и есть ли берег: цена моста против заплыва.
export function waterAhead (world: { blockAt: (p: any) => any }, support: any, dir: { x: number; z: number }, max = 24) {
  let n = 0
  for (let k = 1; k <= max; k++) {
    const s = bridgeStep(world, support.offset(dir.x * (k - 1), 0, dir.z * (k - 1)), dir)
    if (s.kind === 'place') { n++; continue }
    return { water: n, shore: s.kind === 'land' }
  }
  return { water: n, shore: false }
}

// Скорость: заплыв по поверхности ~2 бл/с; мост — ~0.4 с на блок (бег 1 бл. + присед + поставка), 2.5 бл/с, и тело
// не в воде (бить и щититься можно, утопленники не достают). Мост не дороже — если блоков хватает на всю воду.
export const SWIM_BPS = 2.0
export const BRIDGE_S_PER_BLOCK = 0.4
export function bridgeWorth ({ water, shore, blocks }: { water: number; shore: boolean; blocks: number }) {
  return water > 0 && shore && blocks >= water && water * BRIDGE_S_PER_BLOCK <= water / SWIM_BPS + 0.3
}

// Сам мост: до maxBlocks блоков по оси yaw, пока впереди вода. Возвращает { placed, ms, why }.
export async function waterBridge (bot, ctl, yaw: number, { maxBlocks = 24, sleep = (ms: number) => gameClock.sleep(ms) }: any = {}) {
  const { placeBlockAt, pickFiller } = require('./build')
  const dir = axisOf(yaw)
  const t0 = gameClock.now()
  let placed = 0
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  const look = () => bot.look(Math.atan2(-dir.x, -dir.z), 0.9, true).catch(() => {})
  try {
    while (!ctl?.aborted && placed < maxBlocks) {
      const feet = bot.entity.position
      const support = new Vec3(Math.floor(feet.x), Math.floor(feet.y) - 1, Math.floor(feet.z))
      const step = bridgeStep(bot, support, dir)
      if (step.kind !== 'place') return { placed, ms: gameClock.now() - t0, why: step.kind === 'land' ? 'берег' : step.kind === 'blocked' ? 'стена' : 'не вода' }
      if (!pickFiller(bot)) return { placed, ms: gameClock.now() - t0, why: 'нет блоков' }
      // К краю: бег, у края (глазами за гранью опоры) — присед; присед клампит тело на блоке.
      const edge = (v) => dir.x ? (dir.x > 0 ? support.x + 1 - v.x : v.x - support.x) : (dir.z > 0 ? support.z + 1 - v.z : v.z - support.z)
      const t1 = gameClock.now()
      await look()
      set('forward', true)
      while (!ctl?.aborted && edge(bot.entity.position) > -0.05 && gameClock.now() - t1 < 1500) {
        const left = edge(bot.entity.position)
        set('sneak', left < 0.45); set('sprint', left >= 0.45 && (bot.food ?? 20) > 6)
        await sleep(50)
      }
      set('forward', false); set('sprint', false); set('sneak', true)
      const r = await placeBlockAt(bot, step.cell, { honest: true, timeoutMs: 600, ctl })
      if (!r.ok && !r.already) return { placed, ms: gameClock.now() - t0, why: 'не поставил: ' + (r.reason || '?') }
      placed++
      set('sneak', false)
    }
    return { placed, ms: gameClock.now() - t0, why: placed >= maxBlocks ? 'лимит' : 'прервано' }
  } finally { set('forward', false); set('sprint', false); set('sneak', false) }
}
