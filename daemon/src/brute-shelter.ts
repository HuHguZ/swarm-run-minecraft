// ND_BRUTE_MEMORY: quiet is not evidence that an observed brute left its shelter exit.
import * as clock from './game-clock'
import * as memory from './brute-memory'

type Point = { x: number; y: number; z: number }
type ExitState = { key: string; since: number; failed: number }

export function assessExit(bot: any, exit: Point = { ...bot.entity.position, y: bot.entity.position.y + 3 }, { exposed = false }: any = {}) {
  memory.observe(bot)
  const risk = memory.riskNear(bot, exit)
  if (!memory.enabled() || !risk.count) { bot._ndBruteExit = null; return { mode: 'open', openCost: 0, coveredCost: 0, holdCost: 0, ...risk } }
  const spots = memory.spots(bot).filter(s => Math.abs(s.y - exit.y) <= 8 && Math.hypot(s.x - exit.x, s.z - exit.z) < 16)
    .sort((a, b) => Math.hypot(a.x - exit.x, a.z - exit.z) - Math.hypot(b.x - exit.x, b.z - exit.z))
  const key = spots[0]?.id == null ? 'near' : String(spots[0].id)
  const state: ExitState = bot._ndBruteExit?.key === key ? bot._ndBruteExit : (bot._ndBruteExit = { key, since: clock.now(), failed: 0 })
  const items: any[] = bot.inventory.items()
  const tools: typeof import('./items') = require('./items')
  const uses = Math.max(0, ...items.filter(i => /_pickaxe$/.test(i.name)).map(i => tools.usesLeft(i)))
  const blocks = items.filter(i => /^(cobblestone|cobbled_deepslate|netherrack|blackstone|basalt|stone|dirt|andesite|diorite|granite|tuff)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  // Nominal 6 cells cost 12 pick swings; depletion and failed mouths have a finite price.
  const coveredCost = 6 + 24 / Math.max(1, uses) + 12 / Math.max(1, blocks) + state.failed * 16 + (uses < 2 || blocks < 2 ? 200 : 0) + (bot.entity.isInLava ? 1000 : 0)
  const hp = bot.health ?? 20, food = bot.food ?? 20
  const openCost = 1 + memory.penalty(bot, exit) * (hp <= 13 ? 12 : 4)
  // Elapsed waiting is a cost, never proof that the brute vanished. Lava/starvation change the comparison.
  const holdCost = 8 + Math.max(0, clock.now() - state.since) / 5000 + (food <= 0 ? 200 : food < 6 ? 30 : 0) + (bot.entity.isInLava || exposed ? 1000 : 0)
  const mode = openCost <= Math.min(coveredCost, holdCost) ? 'risk' : coveredCost <= holdCost ? 'covered' : 'hold'
  return { mode, openCost, coveredCost, holdCost, ...risk,
    seen: spots.map(s => ({ id: s.id, x: s.x, y: s.y, z: s.z, seenAt: s.seenAt, firstSeenAt: s.firstSeenAt })) }
}

export async function ensureShelterExit(session: any, ctl: any, toward?: Point, { knownShelter = false, exposed = false, exit = undefined }: any = {}) {
  const bot = session.bot
  if (!memory.enabled() || !bot?.entity || ctl?.aborted) return null
  // pearls mode=seek держит своё расстояние до брутов (20 бл. — прочь) и выходит к торговцам сам: «hold» в яме при бруте в 16–18
  // замораживал тело на 12 мин (nbk35-0528: goto и seek без единого пути, setGoal(null) из ожидания).
  if (bot._ndNoBruteHold) return null
  ctl ??= { aborted: false, onAbort: [] }
  if (!knownShelter && !exposed) {
    const fortify: typeof import('./fortify') = require('./fortify')
    if (!fortify.enclosure(bot, fortify.feetCell(bot)).sealed && !(require('./build') as typeof import('./build')).inPit(bot)) return null
  }
  const choice = assessExit(bot, exit, { exposed })
  if (choice.mode === 'open') return null
  console.log('[brute-memory] shelter exit', JSON.stringify(choice))
  if (choice.mode === 'risk') return null
  const from = bot.entity.position.clone()
  if (ctl?.aborted) return { deferred: true, mode: choice.mode, moved: 0, choice, stopped: 'прервано' }
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  if (choice.mode === 'hold') {
    const until = clock.now() + 8000
    while (!ctl?.aborted && (bot.health ?? 0) > 0 && clock.now() < until) {
      memory.observe(bot)
      const next = assessExit(bot, exit, { exposed })
      if (next.mode !== 'hold') break
      await (require('./movement') as typeof import('./movement')).sleep(250)
    }
    return { deferred: true, mode: choice.mode, moved: 0, choice }
  }
  const near = memory.spots(bot).filter(s => Math.abs(s.y - from.y) <= 8)
    .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))[0]
  let dx = near ? from.x - near.x : (toward?.x ?? from.x + 1) - from.x
  let dz = near ? from.z - near.z : (toward?.z ?? from.z) - from.z
  if (Math.hypot(dx, dz) < .01) { dx = 1; dz = 0 }
  const length = Math.hypot(dx, dz)
  const candidates = [[dx / length, dz / length], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ x: from.x + x * 18, y: Math.floor(from.y), z: from.z + z * 18 }))
  // A second remembered brute can make "away from the nearest" the wrong side.
  // ND_BAST_BRUTE_EXIT=1: при равной опасности — ход к цели (toward), а не только прочь: прочь-и-обратно крутило путь у бастиона.
  const progress = (c: Point) => process.env.ND_BAST_BRUTE_EXIT === '1' && toward ? Math.hypot(c.x - toward.x, c.z - toward.z) / 18 : 0
  const target = candidates.sort((a, b) => memory.penalty(bot, a) + progress(a) - memory.penalty(bot, b) - progress(b))[0]
  // Existing visible-only closed bore seals each opening; it never has to climb back into the threat zone.
  const result = await (require('./nether-cover') as typeof import('./nether-cover')).closedBore(session, ctl, target,
    { maxSteps: 6, minY: Math.floor(from.y), deadline: clock.now() + 12000 })
  const moved = Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z)
  if (!ctl?.aborted && moved < 1 && bot._ndBruteExit) bot._ndBruteExit.failed++
  return { deferred: true, mode: choice.mode, moved, choice, stopped: result.why, covered: result }
}
