'use strict'
// Крепость и портал в Край (endportal.ts): разведка крепости (findRoom) — состояние обхода и вход. Прежние const/let
// замыкания findRoom — поля объекта rx (RoomRun); оборот цикла обхода — шаги room-steps.ts.
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { xyz } from '../movement'
import { countOf } from '../items'
import { PLACE, ROOM, log, placeOf, savePlace, walkTo, noInfested } from './common'
import { enterByBricks, breakIn } from './break-in'

export type Turn = 'next' | 'stop' | undefined

export interface RoomRun {
  session: any
  ctl: any
  p: any
  bot: any
  t0: number
  deadline: number
  frameId: number
  spawnerId: number
  brickIds: number[]
  went: any
  visited: any[]
  frontier: Map<string, any>
  known: Map<string, any>
  failed: Set<string>
  legs: any[]
  walked: number
  last: any
  markTimer: any
  seenFrames: any[]
  digOuts: number
  lure: any
  lureBest: any
  lureStale: number
  lurePie: boolean
  lurePrecise: boolean
  vertTries: number
  lureBores: number
  usedLures: any[]
  picks: Map<string, number>
  spawner: any
  bricksSeen: number
  origin: any
  restoreInfested: () => void
  torches: any[]
}

// Значения одного оборота обхода (прежние const тела while).
export interface RoomTick {
  nodes?: any[]
  fresh?: any[]
  me?: any
  next?: any
}

export const roomKey = v => `${v.x},${v.y},${v.z}`

export function roomMark (rx: RoomRun) {
  const { bot, visited } = rx
  const f = bot.entity.position.floored()
  if (!visited.some(v => v.distanceTo(f) < 4)) visited.push(f)
  rx.walked += bot.entity.position.distanceTo(rx.last)
  rx.last = bot.entity.position.clone()
}

// Обход крепости помнится между вызовами (ключ — крепость из памяти): раньше
// каждый вызов room начинал заново от места, где стоит, и ходил теми же
// коридорами (репетиция на двойнике мира прохождения, 2026-09-28: 85
// переходов, 730 блоков, все — на восточной половине; комната — в 15 блоках
// к западу, этажом выше; вызов оборвало low_health).
export function openExplore (rx: RoomRun) {
  const { session, ctl, bot } = rx
  const recK = placeOf(session, PLACE)
  const memKey = recK ? `${recK.x},${recK.z}` : 'нет'
  if (!session._roomExplore || session._roomExplore.key !== memKey) session._roomExplore = { key: memKey, visited: [], known: new Map(), failed: new Set() }
  rx.visited = session._roomExplore.visited
  rx.frontier = new Map()
  rx.known = session._roomExplore.known
  rx.failed = session._roomExplore.failed
  rx.legs = []
  rx.walked = 0
  rx.last = bot.entity.position.clone()
  const markTimer = rx.markTimer = gameClock.setInterval(() => roomMark(rx), 500)
  ctl.onAbort.push(() => gameClock.clearInterval(markTimer))

  rx.seenFrames = []
  rx.digOuts = 0
  rx.lure = null
  rx.lureBest = null
  rx.lureStale = 0
  rx.lurePie = false
  rx.lurePrecise = false
  rx.vertTries = 0
  rx.lureBores = 0
  rx.usedLures = []
  rx.picks = new Map()
  rx.spawner = null
  rx.bricksSeen = 0
}

// Стоим ещё в своей шахте у стены — сначала внутрь: вход по кирпичу, назад в посещённый коридор или пробиться.
export async function enterExplore (rx: RoomRun) {
  const { session, ctl, bot, deadline, legs } = rx
  const recS = placeOf(session, PLACE)
  // Точка отсчёта обхода — лестница старта (угол чанка старта + 4, высота —
  // где вошли); без крепости в памяти — где стоим.
  rx.origin = recS && Number.isFinite(recS.x)
    ? new Vec3(recS.x + (recS.refined ? 4 : 0), Number.isFinite(recS.y) ? recS.y : bot.entity.position.y, recS.z + (recS.refined ? 4 : 0))
    : bot.entity.position.clone()
  const restoreInfested = rx.restoreInfested = noInfested(bot)
  ctl.onAbort.push(restoreInfested)
  rx.torches = []
  let pre: any = { steps: [] }
  const eb = await enterByBricks(session, ctl, { deadline })
  log('вход по кирпичу', eb)
  if (eb.inside) session._roomExplore.entered = bot.entity.position.clone()
  else if (session._roomExplore.entered) {
    // Уже посещённый коридор — вернуться из штрека; повторный спуск уводил ниже крепости при каждом room.
    const back = session._roomExplore.entered
    const w = await walkTo(bot, ctl, back, 1, Math.min(30000, Math.max(0, deadline - gameClock.now())))
    legs.push({ why: 'назад в коридор', to: xyz(back), ok: w.ok })
  } else {
    pre = await breakIn(session, ctl, { deadline, tries: 8, toward: recS && recS.refined ? { x: recS.x + 4, z: recS.z + 4 } : null })
    if (pre.inside) session._roomExplore.entered = bot.entity.position.clone()
  }
  if (pre.steps.length) legs.push({ why: 'пробился внутрь', steps: pre.steps, inside: pre.inside })
}

// Итог обхода: увиденная комната (центр, рамки с оком) в память, или почему не нашёл.
export function roomReport (rx: RoomRun) {
  const { session, ctl, bot, t0, deadline, frameId, went, visited, frontier, legs, seenFrames, spawner, bricksSeen } = rx
  const detail: any = {
    found: seenFrames.length > 0,
    frames: seenFrames.length,
    spawner: spawner ? xyz(spawner) : undefined,
    legs: legs.length,
    walked: Math.round(rx.walked),
    visited: visited.length,
    frontierLeft: frontier.size,
    bricksSeen,
    went: went ? { dug: went.dug, refined: went.refined, bricks: went.bricks, inside: went.inside, seconds: went.seconds, descentSeconds: went.descentSeconds, honest: went.honest } : undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (seenFrames.length) {
    const all = bot.findBlocks({ matching: [frameId], maxDistance: 12, point: seenFrames[0].position, count: 24 })
    const withEye = all.filter(pos => { const b = bot.blockAt(pos); return b && String(b.getProperties().eye) === 'true' }).length
    const c = all.reduce((a, v) => a.plus(v), new Vec3(0, 0, 0)).scaled(1 / all.length)
    const centre = { x: Math.floor(c.x), y: all[0].y, z: Math.floor(c.z) }
    detail.room = { centre, frames: all.length, withEye, empty: all.length - withEye }
    savePlace(session, ROOM, { ...centre, dimension: 'overworld', frames: all.length, withEye, note: `портальная комната: рамок ${all.length}, с оком ${withEye}` },
      `нашёл портальную комнату: центр ${centre.x},${centre.y},${centre.z}, рамок ${all.length}, с оком ${withEye}`)
    detail.note = `${went && Number.isFinite(went.descentSeconds) ? `(спуск ${went.descentSeconds} с) ` : ''}Вижу портальную комнату: ${all.length} рамок, с оком уже ${withEye}, пустых ${all.length - withEye}. ` +
      `Вставить: mc_stronghold mode=fill (глаз в рюкзаке ${countOf(bot, 'ender_eye')}).`
  } else {
    detail.stopped = ctl.aborted ? 'прервано' : (gameClock.now() >= deadline ? 'время вышло' : 'куда идти дальше, не вижу')
    detail.note = `${went && Number.isFinite(went.descentSeconds) ? `(спуск ${went.descentSeconds} с) ` : ''}Рамок не увидел: прошёл ${detail.walked} блоков, ${legs.length} переходов, кирпича видно ${bricksSeen}. ` +
      'Позови ещё раз — граница разведки строится заново от того места, где стою.'
  }
  return detail
}
