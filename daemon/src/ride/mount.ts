'use strict'
// Езда (ride.ts): сесть и слезть, пустая рука, подойти к животному или лодке.
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sendInput, sleep } from './base'


// mineflayer 4.37 (entities.js, set_passengers) снимает с транспорта только тех,
// кто ЕСТЬ в новом списке пассажиров, а сервер, когда игрок слез или лошадь его
// сбросила, шлёт список уже БЕЗ него: bot.vehicle остаётся навсегда, 'dismount'
// не приходит. Ванильный клиент в этом пакете сперва высаживает всех, потом
// сажает перечисленных — то же здесь, один раз на бота.
export function patchVehicle (bot) {
  if (bot._ndVehiclePatch) return
  bot._ndVehiclePatch = true
  bot._client.on('set_passengers', ({ entityId, passengers }: any) => {
    const v = bot.vehicle
    if (!v || v.id !== entityId || !bot.entity || passengers.includes(bot.entity.id)) return
    const i = v.passengers ? v.passengers.indexOf(bot.entity) : -1
    if (i !== -1) v.passengers.splice(i, 1)
    bot.entity.vehicle = null
    bot.vehicle = null
    bot.emit('dismount', v)
  })
}

// Слезть: shift одним тиком, отпустить следующим.
export async function dismount (bot, ms = 2500) {
  patchVehicle(bot)
  if (!bot.vehicle) return true
  const gone = new Promise<any>(resolve => {
    const t = gameClock.setTimeout(() => resolve(false), ms)
    bot.once('dismount', () => { gameClock.clearTimeout(t); resolve(true) })
  })
  sendInput(bot, { shift: true })
  await sleep(120)
  sendInput(bot, {})
  const ok = await gone
  // Сервер ставит тело на землю телепортом — дождаться, пока физика mineflayer
  // оживёт на новом месте.
  await sleep(300)
  return ok || !bot.vehicle
}

export async function mountOn (bot, ctl, e, ms = 3000, getAim = null) {
  patchVehicle(bot)
  if (ctl.aborted) return false
  if (bot.vehicle && bot.vehicle.id === e.id) return true
  await emptyHand(bot)
  if (ctl.aborted) return false
  const point = getAim ? getAim() : e.position.offset(0, (e.height || 1) * 0.7, 0)
  if (!point) return false
  try { await bot.lookAt(point, true) } catch { return false }
  if (ctl.aborted || getAim && !getAim()?.equals(point)) return false
  const on = new Promise<any>(resolve => {
    const done = ok => { gameClock.clearTimeout(t); bot.removeListener('mount', h); ctl.onAbort = ctl.onAbort.filter(fn => fn !== abort); resolve(ok) }
    const abort = () => done(false)
    const t = gameClock.setTimeout(() => done(false), ms)
    const h = () => { if (bot.vehicle && bot.vehicle.id === e.id) done(true) }
    bot.on('mount', h)
    ctl.onAbort.push(abort)
  })
  try { bot.mount(e) } catch {}
  return on
}

export async function emptyHand (bot) {
  if (!bot.heldItem) return
  const slot = bot.inventory.firstEmptyHotbarSlot ? bot.inventory.firstEmptyHotbarSlot() : null
  try {
    if (slot !== null && slot !== undefined) bot.setQuickBarSlot(slot - 36)
    else await bot.unequip('hand')
  } catch {}
}

export async function approach (bot, ctl, e, range = 2, ms = 15000) {
  if (e.position.distanceTo(bot.entity.position) <= range + 0.5) return true
  const goal = new goals.GoalFollow(e, range)
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  try {
    bot.pathfinder.setGoal(goal, true)
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < ms && !ctl.aborted && e.isValid !== false) {
      if (e.position.distanceTo(bot.entity.position) <= range + 0.5) return true
      await sleep(150)
    }
    return false
  } finally {
    try { if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null) } catch {}
  }
}
