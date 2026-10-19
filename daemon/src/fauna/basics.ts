'use strict'
// Звери: что едят при приручении и разведении, видимость, ближний зверь, предмет в руке, подход, статус.
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { canSeePoint } from '../perception'

// Животные, питомцы, голем и жители — механики, которых у тела не было:
// приручить волка и кошку, развести животных, построить железного или
// снежного голема, поторговать с жителем.
//
// По коду сервера (paper-1.21.11.jar):
// * Wolf.tryToTame / Cat.tryToTame: random.nextInt(3) == 0 — шанс 1/3 за
//   предмет (волк — bone, кошка — сырая треска/лосось), удача —
//   broadcastEntityEvent 7 (сердечки), неудача — 6 (дым). Parrot: nextInt(10)
//   == 0, семена. Лошади: садиться, пока не «стерпит» — удача тоже событие 7.
//   Клиент эти события видит (mineflayer: entityTamed / entityTaming), по ним
//   и считаем, а не гадаем.
// * Любовь у животных — событие 18 (сердечки), ребёнок появляется рядом.
// * Голем: CarvedPumpkinBlock.trySpawnGolem — узор проверяется, когда тыква
//   (вырезанная или светильник Джека) встаёт на место; железный — Т из 4
//   железных блоков, снежный — столб из 2 снежных.

export const TAME = {
  wolf: { items: ['bone'], per: '1/3' },
  cat: { items: ['cod', 'salmon'], per: '1/3' },
  parrot: { items: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'], per: '1/10' },
  horse: { items: [], per: 'садиться, пока не стерпит' },
  donkey: { items: [], per: 'садиться, пока не стерпит' },
  mule: { items: [], per: 'садиться, пока не стерпит' },
  llama: { items: [], per: 'садиться, пока не стерпит' }
}

export const BREED = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['dandelion', 'carrot', 'golden_carrot'],
  horse: ['golden_carrot', 'golden_apple'], donkey: ['golden_carrot', 'golden_apple'],
  wolf: ['beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken', 'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit', 'rotten_flesh'],
  cat: ['cod', 'salmon'],
  llama: ['hay_block'], fox: ['sweet_berries', 'glow_berries'], turtle: ['seagrass'],
  frog: ['slime_ball'], armadillo: ['spider_eye'], camel: ['cactus'], strider: ['warped_fungus'], hoglin: ['crimson_fungus']
}

export function sleep (ms, ctl?: any) {
  return new Promise<any>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve(undefined) })
  })
}

export function countOf (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

// Метаданные (1.21): 16 — детёныш (AgeableMob), 17 — флаги приручаемого
// (0x04 приручен, 0x01 сидит).
export function isBaby (e) { return !!(e.metadata && e.metadata[16] === true) }
// Белый медведь нейтрален; детёныша не бьём. При литье 20 блоков — защитный запас,
// а не радиус агрессии: AttackPlayersGoal 1.21.11 выбирает игрока в 10, если есть детёныш в BB+8/4/8.
export function castHazard (bot, at = bot.entity.position) {
  const foes = /^(pillager|vindicator|evoker|ravager|skeleton|stray|bogged|parched|zombie|husk|drowned|spider|cave_spider|creeper|witch)$/
  for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
    if (!e || !e.position || !/^(polar_bear)$/.test(e.name || '') && !foes.test(e.name || '')) continue
    const d = e.position.distanceTo(at)
    if (d > (e.name === 'polar_bear' ? 20 : 16) || !visible(bot, e)) continue
    return { id: e.id, name: e.name, baby: e.name === 'polar_bear' ? isBaby(e) : undefined, distance: Math.round(d * 10) / 10 }
  }
  const feet = at.floored()
  for (const q of [feet, feet.offset(0, 1, 0), feet.offset(0, -1, 0)]) {
    const b = bot.blockAt && bot.blockAt(q)
    if (b && /^(lava|fire|soul_fire|campfire|soul_campfire|magma_block|powder_snow)$/.test(b.name)) return { name: b.name, at: { x: q.x, y: q.y, z: q.z } }
  }
  return null
}
export function isTamed (e) { const f = e.metadata && e.metadata[17]; return typeof f === 'number' && (f & 0x04) !== 0 }
export function isSitting (e) { const f = e.metadata && e.metadata[17]; return typeof f === 'number' && (f & 0x01) !== 0 }

export function visible (bot, e) {
  return canSeePoint(bot, e.position.offset(0, (e.height || 1) * 0.6, 0))
}

export function nearestOf (bot, kind, filter: (entity: any) => boolean = () => true, radius = 32) {
  const me = bot.entity.position
  return (Object.values(bot.entities) as any[])
    .filter((e : any) => e && e.name === kind && e.position && e.position.distanceTo(me) <= radius && filter(e) && visible(bot, e))
    .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

export async function holdOne (bot, names) {
  for (const n of names) {
    const it = bot.inventory.items().find(i => i.name === n)
    if (!it) continue
    if (!bot.heldItem || bot.heldItem.name !== n) { try { await bot.equip(it, 'hand') } catch { continue } }
    return n
  }
  return null
}

export async function holdNothing (bot) {
  if (!bot.heldItem) return
  const slot = bot.inventory.firstEmptyHotbarSlot ? bot.inventory.firstEmptyHotbarSlot() : null
  try {
    if (slot !== null && slot !== undefined) bot.setQuickBarSlot(slot - 36)
    else await bot.unequip('hand')
  } catch {}
}

export async function approach (bot, ctl, e, range = 2.2, ms = 15000) {
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

// Событие сущности (entity_status) за время ожидания.
export function statusWatch (bot, id) {
  const seen = []
  const on = (packet) => { if (packet.entityId === id) seen.push(packet.entityStatus) }
  bot._client.on('entity_status', on)
  return { seen, stop: () => bot._client.removeListener('entity_status', on) }
}
