'use strict'
// Помощники сессии (не методы): части session/* и фасад берут их отсюда. Сюда не кладутся методы — Object.assign
// частей скопировал бы на прототип и константы.
import * as gameClock from '../game-clock'

// Abortable sleep. The shared helper in movement.js has no cancellation, and
// Прыжок вниз без ведра (пользователь 10.10: «убирай лимит глобально для всех режимов — пусть прыгают и подхиливаются»):
// глубина — по хп, урон падения (высота − 3) не больше четверти хп; на 20 хп — до 8 блоков вниз (5 урона), на 8 хп — до
// 4 (1). Было: 3 блока всегда — бойцы застревали на колоннах и крышах 5–6 бл. ND_FREE_DROP=0 — старый предел.
export function freeDrop (bot) { return process.env.ND_FREE_DROP === '0' ? 4 : Math.max(4, Math.floor((bot.health ?? 20) / 4) + 4) }

export function sleep (ms, ctl?: any) {
  if (ctl?.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve() })
  })
}

export function steerIntoDig (entity, node) {
  if (!entity || !node || !Array.isArray(node.toBreak) || !node.toBreak.length) return null
  if (entity.onGround || entity.isInWater || entity.isInLava) return null
  const p = entity.position
  const v = entity.velocity || { x: 0, z: 0 }
  const cx = Math.floor(node.x) + 0.5
  const cz = Math.floor(node.z) + 0.5
  // Колонна узла — под ногами или рядом (≤ 1.5 бл.): это и есть падение в свою клетку, а не прыжок пути.
  if (Math.hypot(cx - p.x, cz - p.z) > 1.5) return null
  // Прогноз посадки без клавиш: в воздухе скорость ×0.91 за тик, до пола — несколько тиков.
  const ex = p.x + v.x * 4
  const ez = p.z + v.z * 4
  const dx = cx - ex
  const dz = cz - ez
  const off = Math.hypot(dx, dz)
  return { yaw: Math.atan2(-dx, -dz), forward: off > 0.2 }
}

// leaves the bag in a state nobody can describe. Health, death, a kick and a
export const HOLDING = ['chat', 'low_health', 'death', 'kicked', 'disconnected']
// Зачарование, варка, сборы: окно посреди кликов не бросаем из-за реплики.
export const WORKBENCH = ['damage', 'low_health', 'death', 'kicked', 'disconnected']

// Короткая пометка мира для имени места: «лагерь (ад)».
export const worldsTag = dim => ({ overworld: 'верх', the_nether: 'ад', the_end: 'край' })[dim] || dim

export function skyLightAt (bot, p) {
  let col
  try { col = bot.world.getColumnAt(p) } catch { return null }
  if (!col) return null
  // Absent light data reads zero in prismarine-chunk, as on the client F3 screen.
  if (typeof col.getSkyLight === 'function') return col.getSkyLight({ x: Math.floor(p.x) & 15, y: Math.floor(p.y), z: Math.floor(p.z) & 15 })
  const b = bot.blockAt(p)
  return b && typeof b.skyLight === 'number' ? b.skyLight : null
}

// Клетки «лава рядом» для цены шага: под ногами и четыре стороны.
export const LAVA_AROUND = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
export const CLIFF_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// Штраф шага перехода поверху: клетка тела без неба (skyLight ≤ 7 — в
// пещере 0, под листвой 12-14, в устье пещеры убывает на блок за блок).
export const ROOF_STEP_COST = 1.5
export function underRoofCost (bot, block, strict = false) {
  if (!block || !block.position || typeof block.skyLight !== 'number' || block.skyLight > 7) return 0
  const s = skyLightAt(bot, block.position)
  return s !== null && s <= 7 ? (strict ? 100 : ROOF_STEP_COST) : 0
}
