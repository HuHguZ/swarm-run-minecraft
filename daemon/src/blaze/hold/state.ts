'use strict'
// Бой у спавнера (holdSpawner) — состояние захода и мелкие действия над ним. Прежние `let` замыкания holdSpawner —
// поля объекта hs (HoldState), прежние внутренние стрелки — функции с hs первым аргументом. Фазы боя (start, rest,
// шаги цикла) — соседние части; оркестр — blaze/hold.ts.
import * as gameClock from '../../game-clock'
import { xyz } from '../../movement'
import { walkable } from '../../walkable'
import * as survival from '../../combat-safety'
import { log, liveBlazes, sweepRisk, FOOD_RE, witherClose } from '../targets'
import { hasEffect } from '../potions'
import { swingMs, NEAR, blazeEye, seesMe, blazeShieldPrice, makeRadar } from '../radar'
import { fightMoves, pitFrom } from '../post'
import { shutDoor } from '../bunker'

// Итог шага цикла боя: 'next' — следующий оборот (прежний continue), 'stop' — конец цикла (прежний break),
// undefined — дальше по шагам этого оборота.
export type Turn = 'next' | 'stop' | undefined

// Значения одного оборота цикла, общие для шагов (прежние const внутри while).
export interface Tick {
  now: number
  hp?: number
  blazes?: any[]
  vis?: any[]
  quiet?: any
  bowOk?: any
  shootable?: any[]
  quietAll?: any
}

export interface HoldState {
  session: any
  ctl: any
  ctx: any
  bot: any
  combat: typeof import('../../combat')
  actions: typeof import('../../actions')
  bestWeapon: typeof import('../../items')['bestWeapon']
  spawner: any
  want: number
  deadline: number
  dead: any
  setPhase: (phase: string) => void
  fp: any
  out: any
  clearRevision: number
  clearChecked: string
  onClearBlock: () => void
  onBlazeHurt: (e: any) => void
  onHeld: () => void
  guard: any
  safety: any
  radar: any
  lookSpeed: any[] | null
  saved: any
  weapon: any
  lastSwing: number
  swapAt: number
  idleSince: number
  silentApproach: number
  lastBeat: number
  shieldOn: boolean
  shieldAt: number
  goalAt: number
  stopped: any
  bail: boolean
  bunker: any
  lastBow: number
  lowWindowCrouchAt: number
  sortieAfter: number
  lastVisAt: number
  reposts: number
  approaches: number
  farApproaches: number
  seenBlocks: number
  blockAt: number
  boxPlan: any
  boxTries: number
  boxRetryAt: number
  noShot: Map<any, number>
  startedFireproof: boolean
  blockedCorner: any
  home: any
  reach: Set<string> | null
}

export const p0 = ctx => ctx.p || {}

// Начало захода: слушатели, щит, радар, движения боя. Порядок побочных действий — как в прежнем прологе holdSpawner.
export function openHold (session, ctl, ctx): HoldState {
  const bot = session.bot
  const combat: typeof import('../../combat') = require('../../combat')
  const actions: typeof import('../../actions') = require('../../actions')
  const { bestWeapon }: typeof import('../../items') = require('../../items')
  const { spawner, want, deadline, dead, setPhase, fireproof: fp } = ctx
  const out: any = { melee: 0, arrows: 0, blocks: 0, rests: [], sorties: 0, shieldMs: 0, foes: [], bunker: null, hits: 0, swingNoLease: 0 }
  const hs = { session, ctl, ctx, bot, combat, actions, bestWeapon, spawner, want, deadline, dead, setPhase, fp, out } as HoldState
  hs.clearRevision = 0; hs.clearChecked = ''
  hs.onClearBlock = () => { hs.clearRevision++ }
  // Свидетель попадания — entityHurt ифрита, а не счёт взмахов (s1-post07 06.10: melee 17, убийств 0).
  hs.onBlazeHurt = e => { if (e && e.name === 'blaze') out.hits++ }
  bot.on('entityHurt', hs.onBlazeHurt)
  hs.guard = combat.makeShield(session, ctl, { shield: 'ranged' })
  hs.safety = survival.watch(bot)
  hs.radar = makeRadar(bot)
  hs.lookSpeed = bot.physics ? [bot.physics.yawSpeed, bot.physics.pitchSpeed] : null
  if (bot.physics) { bot.physics.yawSpeed = 1000; bot.physics.pitchSpeed = 1000 }
  hs.saved = bot.pathfinder.movements
  const moves = fightMoves(session)
  bot.pathfinder.setMovements(moves)
  hs.weapon = bestWeapon(bot)
  hs.lastSwing = gameClock.now()
  // Смена предмета в руке обнуляет откат удара (Player.tick → resetAttackStrengthTicker при смене main hand, 1.21.11).
  hs.swapAt = 0
  hs.onHeld = () => { hs.swapAt = gameClock.now() }
  bot.on('heldItemChanged', hs.onHeld)
  hs.idleSince = gameClock.now()
  // S1e: спавнер работает, только когда игрок в 16 бл. от его центра (BaseSpawner.isNearPlayer, requiredPlayerRange 16) — молчит
  // издали (s1e-B0-3: «спавнер молчит 50с — стою в 18 бл.» ×3, этап ифритов брошен) — подойти на 8 и ждать снова, а не уходить.
  hs.silentApproach = 0
  hs.lastBeat = 0
  hs.shieldOn = false
  hs.shieldAt = 0
  hs.goalAt = 0
  hs.stopped = null
  hs.bail = false
  hs.bunker = null
  hs.lastBow = gameClock.now()
  hs.lowWindowCrouchAt = 0
  hs.sortieAfter = 0
  hs.lastVisAt = gameClock.now()
  hs.reposts = 0
  hs.approaches = 0
  hs.farApproaches = 0
  hs.seenBlocks = 0
  hs.blockAt = 0
  // Коробку не достроили (блейз в клетке стены, сервер не ответил) — достроить
  // в тишине, до 4 раз (замер 18: «в клетке стоит blaze», 12 хп на стройке).
  hs.boxPlan = null
  hs.boxTries = 0
  hs.boxRetryAt = 0
  hs.noShot = new Map()
  // Бой начат под огнестойкостью — она и держит его (шар и горение — #is_fire). Кончилась посреди боя — новое зелье
  // (ферма 02.10 neF-blz-3: 3 мин под зельем — 0 урона огнём, после — шары 10.8 и горение 5); нет зелья — отдых и
  // конец захода, а не продолжение тира без защиты (разбор Codex ne-blaze.md, правка 1).
  hs.startedFireproof = fireproof(hs)
  if (ctx.ledger) ctx.ledger.probe = () => ({ up: combat.shieldUp(bot), want: hs.shieldOn, ms: hs.shieldOn ? gameClock.now() - hs.shieldAt : undefined })
  hs.blockedCorner = null
  hs.home = null
  // Куда дойти ногами от места боя (для «стержень с этого поднять» и вылазок).
  hs.reach = null
  return hs
}

// Конец захода (прежний finally): окно щели закрыть, слушатели снять, щит опустить, движения и скорость взгляда вернуть.
export async function closeHold (hs: HoldState) {
  const { bot, ctl, out, radar, safety, guard } = hs
  if (hs.bunker?.lowWindow && inBunker(hs) && (bot.health ?? 0) > 0 && !ctl.aborted) {
    out.windowSealed = await shutDoor(bot, hs.bunker).catch(() => false)
  }
  bot.removeListener('blockUpdate', hs.onClearBlock)
  bot.removeListener('entityHurt', hs.onBlazeHurt)
  bot.removeListener('heldItemChanged', hs.onHeld)
  try { await setShield(hs, false) } catch {}
  stopWalking(hs)
  radar.stop()
  safety.close()
  guard.close()
  if (bot.physics && hs.lookSpeed) { bot.physics.yawSpeed = hs.lookSpeed[0]; bot.physics.pitchSpeed = hs.lookSpeed[1] }
  try { bot.pathfinder.setMovements(hs.saved) } catch {}
}

export function lockOwner (hs: HoldState) { try { return (require('../../reflex-lock') as typeof import('../../reflex-lock')).owner(hs.session)?.source || null } catch { return null } }

export function fireproof (hs: HoldState) { return hs.fp || hasEffect(hs.bot, 'fire_resistance') }

export async function equipSword (hs: HoldState) {
  const bot = hs.bot
  const weapon = hs.weapon = hs.bestWeapon(bot)
  if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
}

// Нейтрал вплотную к ифриту — бить киркой: у кирки нет размашистого удара (Player.isSweepAttack — только меч), зомби-пиглины
// не злятся; без нейтралов — меч (s1-LA-6 06.10: при запрете удара ифрит в 0.8 бл. бил безответно, смерть).
export async function equipFor (hs: HoldState, e) {
  const { bot, out } = hs
  if (!sweepRisk(bot, e)) return equipSword(hs)
  const pk = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).sort((a, b) => ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'].indexOf(b.name.split('_')[0]) - ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'].indexOf(a.name.split('_')[0]))[0]
  out.pickSwings = (out.pickSwings || 0) + 1
  if (pk && (!bot.heldItem || bot.heldItem.name !== pk.name)) { try { await bot.equip(pk, 'hand') } catch {} }
}

// Удар, только когда откат предмета в руке прошёл; оружие под цель (кирка при нейтрале рядом) — до проверки отката.
export async function swingFor (hs: HoldState, e) {
  const { bot, out } = hs
  await equipFor(hs, e)
  if (gameClock.now() - Math.max(hs.lastSwing, hs.swapAt) < swingMs(bot)) return false
  const aim = (require('../../pick') as typeof import('../../pick')).aim(bot, e)
  if (!aim?.point) return false
  await setShield(hs, false)
  try { await bot.lookAt(aim.point, true) } catch {}
  try { if (lockOwner(hs)) out.swingNoLease++; bot.attack(e); hs.lastSwing = gameClock.now(); out.melee++ } catch {}
  await setShield(hs, true, inBunker(hs) ? doorPoint(hs) : blazeEye(e))
  return true
}

export async function setShield (hs: HoldState, on, face = null) {
  const { bot, guard, out } = hs
  if (face) { try { await bot.lookAt(face, true) } catch {} }
  if (on) {
    if (!hs.shieldOn) { hs.shieldOn = true; hs.shieldAt = gameClock.now() }
    await guard.raise(true)
  } else if (hs.shieldOn) { hs.shieldOn = false; out.shieldMs += gameClock.now() - hs.shieldAt; await guard.raise(false) }
}

export function stopWalking (hs: HoldState) { try { hs.bot.pathfinder.setGoal(null) } catch {}; hs.bot.clearControlStates() }
export function inBunker (hs: HoldState) { return hs.bunker && hs.bot.entity.position.floored().equals(hs.bunker.cell) }
export function doorPoint (hs: HoldState) { return hs.bunker ? hs.bunker.cell.plus(hs.bunker.front).offset(0.5, 1.6, 0.5).plus(hs.bunker.front.scaled(3)) : null }
// Близкий враг запрещает неподвижный отдых, но требует раннего отхода.
export function meleeThreat (hs: HoldState) { return liveBlazes(hs.bot, hs.dead, 6).find((e : any) => e.position.distanceTo(hs.bot.entity.position) < 2.7 && seesMe(hs.bot, e)) || null }
export function foesNow (hs: HoldState) { return (require('../../flee') as typeof import('../../flee')).hostilesAround(hs.bot, 24).map(h => h.e).filter(e => !hs.dead.has(e.id)) }

export function checkSafety (hs: HoldState, phase) {
  const { bot, ctx, dead, safety, radar, guard } = hs
  const foes = foesNow(hs)
  const risk = safety.check({ entities: foes, phase,
    expectedEnemy: phase === 'start' ? 'blaze' : null, minHealth: Math.max(8, ctx.restAt) })
  if (process.env.ND_BLAZE_WORLD_STATE === '0' || !foes.length || foes.some(e => e.name !== 'blaze') ||
      risk.action !== 'leave' || !/не переживу ближайший размен/.test(risk.reason || '')) return risk
  const vis = liveBlazes(bot, dead, 48).filter(e => seesMe(bot, e))
  const from = [...vis.map(blazeEye), ...radar.incoming(gameClock.now()).map(b => b.from)]
  const price = blazeShieldPrice(bot, vis, radar, guard, fireproof(hs), from.length ? faceFor(hs, from) : null)
  if (price.cost >= (bot.health ?? 0)) return risk
  return { ...risk, action: 'fight', reason: 'размен по лучам, щиту и летящим шарам', blazeCost: price.cost }
}

// Опасность: видящие нас в окне очереди и летящие к нам шары.
export function dangersNow (hs: HoldState, vis, now) {
  const { bot, radar } = hs
  const out2 = []
  if (fireproof(hs)) return out2
  for (const e of vis) if (e.position.distanceTo(bot.entity.position) <= NEAR && radar.untilDanger(e, now) === 0) out2.push(blazeEye(e))
  for (const b of radar.incoming(now)) if (b.eta < 1600) out2.push(b.from)
  return out2
}

export function faceFor (hs: HoldState, dangers) {
  const me = hs.bot.entity.position
  if (inBunker(hs)) return doorPoint(hs)
  let sx = 0; let sz = 0
  for (const d of dangers) { const dx = d.x - me.x; const dz = d.z - me.z; const n = Math.hypot(dx, dz) || 1; sx += dx / n; sz += dz / n }
  if (Math.hypot(sx, sz) < 0.3 * dangers.length) return dangers.slice().sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0]
  return me.offset(sx * 4, 1.6, sz * 4)
}

export function refreshReach (hs: HoldState) {
  const bot = hs.bot
  try { hs.reach = new Set(walkable(bot, bot.entity.position, { radius: 20, maxNodes: 5000 }).map(n => `${n.pos.x},${n.pos.y},${n.pos.z}`)) } catch { hs.reach = null }
  // Из закрытой коробки (второй вызов начинается в ней) ногами никуда — тогда
  // правило «пол в 5 ниже и 1 выше ног» (прогон 33: 0 выстрелов за вызов).
  log("куда дойти", { cells: hs.reach ? hs.reach.size : null, at: xyz(bot.entity.position) })
  if (hs.reach && hs.reach.size < 20) hs.reach = null
}

export async function witherPit (hs: HoldState) {
  const w = witherClose(hs.bot)
  if (!w) return false
  await setShield(hs, false)
  stopWalking(hs)
  hs.setPhase('яма от иссушителя')
  const ok = await pitFrom(hs.session, hs.ctl, hs.out, w)
  return ok
}

export function onlyBlazes (hs: HoldState) { return foesNow(hs).every((e: any) => e.name === 'blaze') }
// Под огнестойкостью и среди одних ифритов «не переживу размен» — неверно (расчёт берёт удар 6 у каждого и шары): бой
// начинать (s1-LE-10 06.10: «не переживу ближайший размен» на 20 хп при старте → навык вышел, смерть у спавнера).
export function frOnlyBlazes (hs: HoldState) { return fireproof(hs) && onlyBlazes(hs) && (hs.bot.health ?? 0) >= 9 }
// Без огнестойкости среди одних ифритов вердикт «не переживу размен» (удар 6 каждого и шары) — не отказ: с 14+ хп бой по
// механике ифрита, при малом хп — отлёжка в толще (restNow) и возврат (s1c-N-4 06.10: «не переживу» на 16 хп → бег → смерть).
// Еды нет — отлёжка не лечит: тогда вердикт safety в силе.
export function nofrOnlyBlazes (hs: HoldState) { return !fireproof(hs) && onlyBlazes(hs) && (hs.bot.health ?? 0) > 0 && hs.bot.inventory.items().some(i => FOOD_RE.test(i.name)) }
