'use strict'
// Крепость и портал в Край (endportal.ts): разведка крепости до портальной комнаты (mode=room). Состояние обхода — объект
// rx (room-state.ts), оборот цикла — шаги room-steps.ts по порядку.
import * as gameClock from '../game-clock'
import * as worlds from '../worlds'
import { PLACE, BRICKS, clamp, placeOf, visibleOf } from './common'
import { goStronghold } from './go'
import { type RoomRun, type RoomTick, type Turn, roomMark, openExplore, enterExplore, roomReport } from './room-state'
import { torchIfDark, roomHeal, roomEyes, roomVProbe, roomFrontier, roomLure, roomLureMove, roomPick, roomWalk } from './room-steps'

// Порядок шагов оборота — порядок веток прежнего тела while: первая сработавшая ветка решает оборот.
const ROOM_STEPS: ((rx: RoomRun, t: RoomTick) => Turn | void | Promise<Turn | void>)[] = [
  roomHeal, roomEyes, roomVProbe, roomFrontier, roomLure, roomLureMove, roomPick, roomWalk
]

// Разведка крепости: идти туда, где ещё не был, по клеткам, которые связаны с
// нами (walkable.js, «ощупью») и ВИДНЫ сейчас или были видны раньше (граница
// разведки). Цель — рамки end_portal_frame или спавнер чешуйниц, замеченные
// только лучом. Кирпич за стеной не подсказывает ничего.
async function findRoom (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 300, 30, 600) * 1000 - 4000
  if (worlds.worldOf(bot) !== 'overworld') return { found: false, stopped: 'крепости бывают только в верхнем мире' }
  const frameId = mcData.blocksByName.end_portal_frame.id
  const spawnerId = mcData.blocksByName.spawner.id
  const brickIds = (Object.values(mcData.blocksByName) as any[]).filter((b : any) => BRICKS.test(b.name)).map((b : any) => b.id)

  // Позвали прямо с поверхности (директор идёт find → room, минуя go): кирпича
  // рядом не видно, а крепость в памяти есть — сперва go (дойти, уточнить оком,
  // прокопаться к кирпичу), на него — до 60% срока, остальное — коридоры.
  let went = null
  const map = process.env.ND_ROOM_MAP !== '0' && (require('../stronghold') as typeof import('../stronghold')).mappedRoom(placeOf(session, PLACE))
  if (p.go !== false && ((!visibleOf(bot, brickIds, 12, 4).length && placeOf(session, PLACE)) || (map && !visibleOf(bot, [frameId], 16, 16).length))) {
    const secs = Math.max(30, Math.round((deadline - gameClock.now()) / 1000 * 0.6))
    went = await goStronghold(session, ctl, { ...p, timeoutSeconds: secs })
    if (!went.went) return { found: false, went, stopped: `до крепости не добрался: ${went.stopped}` }
  }

  const rx = { session, ctl, p, bot, t0, deadline, frameId, spawnerId, brickIds, went } as RoomRun
  openExplore(rx)
  await enterExplore(rx)
  try {
    turn: while (!ctl.aborted && gameClock.now() < deadline) {
      roomMark(rx)
      const t: RoomTick = {}
      for (const step of ROOM_STEPS) {
        const r = await step(rx, t)
        if (r === 'stop') break turn
        if (r === 'next') continue turn
      }
    }
  } finally {
    gameClock.clearInterval(rx.markTimer)
    rx.restoreInfested()
  }
  return roomReport(rx)
}

export {
  torchIfDark, findRoom
}
