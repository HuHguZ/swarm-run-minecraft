'use strict'
// Директор: вон из лавы и огня — вода из ведра под ноги или безопасные шаги к клетке без огня.
import * as gameClock from '../game-clock'
import { sleep } from './situation'

// Итог escapeFire: status — done / interrupted / failed, detail — отчёт ветки (how, escaped, nether, поля навыка спасения).
interface FireEscape { status: string; detail: Record<string, any> }
export async function escapeFire (session, ctl: any = null): Promise<FireEscape> {
  const bot = session.bot
  ctl ||= (require('../reflex-lock') as typeof import('../reflex-lock')).owner(session)?.ctl || { aborted: false, onAbort: [] }
  const rescue: typeof import('../tactics/lava-escape') = require('../tactics/lava-escape')
  if (rescue.inLava(bot)) {
    const air = (require('../combat/emergency-escape') as typeof import('../combat/emergency-escape')).createEmergencyEscape(bot)
    const capabilities = air.snapshot()
    for (const kind of ['flight', 'pearl'] as const) {
      if (ctl.aborted) return { status: 'interrupted', detail: { how: 'lava rescue interrupted' } }
      if (!capabilities[kind === 'flight' ? 'flightReady' : 'pearlReady']) continue
      const result = await air.run(ctl, kind)
      if (result.ok && !rescue.inLava(bot)) return { status: 'done', detail: { how: kind, ...result } }
    }
    const kit: typeof import('../fightkit') = require('../fightkit')
    if (!kit.hasEffect(bot, 'fire_resistance') && rescue.lavaCapabilities(session).potion) await rescue.drinkFireResistance(session, ctl)
    if (kit.hasEffect(bot, 'fire_resistance')) {
      const result = await rescue.climbFromLava(session, ctl)
      return { status: result.ok ? 'done' : ctl.aborted ? 'interrupted' : 'failed', detail: result }
    }
    const result = await (require('../unstuck') as typeof import('../unstuck')).RUNGS.swimOutLava({ bot, session: session, ctl, sleep })
    const escaped = !rescue.inLava(bot) && bot.entity.onGround
    return { status: escaped ? 'done' : ctl.aborted ? 'interrupted' : 'failed', detail: { ...result, escaped } }
  }
  const nether = /nether/.test(String((bot.game && bot.game.dimension) || ''))
  const bucket = nether ? null : bot.inventory.items().find(i => i.name === 'water_bucket')
  if (bucket) {
    try { await bot.equip(bucket, 'hand'); await bot.look(bot.entity.yaw, -Math.PI / 2, true); bot.activateItem() } catch {}
    await sleep(600)
    return { status: 'done', detail: { how: 'вода из ведра' } }
  }
  // Без лавы и ведра бег огонь не тушит (горит 8 с): уйти можно только из клетки огня, и только безопасным шагом. Раньше —
  // спринт с прыжком 1.2 с вслепую к «ближайшей клетке с полом» (часто своей же) — с моста или платформы в пустоту и лаву
  // под огнём ифрита (S4c 07.10, замечание проверки г; звали директор «горю», тактика Flee и укрытие).
  const me = bot.entity.position.floored()
  const { HURTS, stepSafe, keyDir }: typeof import('../moves') = require('../moves')
  const hot = v => HURTS.has(bot.blockAt(v)?.name || '')
  const fiery = c => [c.offset(0, -1, 0), c, c.offset(0, 1, 0)].some(hot)
  // Огонь жжёт, когда его клетку задевает хитбокс 0.6×1.8, а не только клетка под ногами: у горящей травы бот 9 раз ответил
  // «не в огне» с одной клетки и сгорел, хп 17 → 0 за 18 игр. с (s8-f3-15, проверка S4c 07.10).
  const touching = () => { const p = bot.entity.position; return [-0.3, 0.3].some(dx => [-0.3, 0.3].some(dz => [-0.01, 0.05, 1.7].some(dy => hot(p.offset(dx, dy, dz).floored())))) }
  if (!touching()) return { status: 'done', detail: { how: 'не в огне — бег огонь не тушит', ...(nether ? { nether: true } : {}) } }
  let best = null
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (const dy of [0, 1, -1]) {
        const c = me.offset(dx, dy, dz)
        const b = bot.blockAt(c)
        const f = bot.blockAt(c.offset(0, -1, 0))
        if (!b || !f || (dx === 0 && dz === 0) || fiery(c) || b.boundingBox !== 'empty' || f.boundingBox !== 'block') continue
        // Трава горит и огонь ползёт: клетка рядом с огнём хуже на 1.5 блока пути.
        const dd = Math.hypot(dx, dz) + 1.5 * [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([x, z]) => fiery(c.offset(x, 0, z))).length
        if (best && dd >= best.dd) continue
        const toward = c.offset(.5, 0, .5).minus(bot.entity.position), distance = Math.hypot(toward.x, toward.z)
        // A diagonal can leave the first guarded step inside the same magma cell.
        if (distance && stepSafe(bot, { x: toward.x / distance, z: toward.z / distance })) best = { c, dd }
      }
    }
  }
  if (best) {
    try { await bot.lookAt(best.c.offset(0.5, 1, 0.5), true) } catch {}
    const until = gameClock.now() + 1200
    while (gameClock.now() < until && !ctl.aborted && !(bot.entity.position.floored().equals(best.c) && !touching())) {
      bot.setControlState('forward', stepSafe(bot, keyDir(bot, 'forward')))
      bot.setControlState('jump', best.c.y > me.y && !!bot.entity.onGround)
      await sleep(50)
    }
    bot.clearControlStates()
  }
  const escaped = !touching()
  return { status: ctl.aborted ? 'interrupted' : escaped ? 'done' : 'failed', detail: { how: escaped ? 'вышел из огня' : 'некуда', escaped, ...(nether ? { nether: true } : {}) } }
}
