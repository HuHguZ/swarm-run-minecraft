'use strict'
// Лагерь у спавнера (campSpawner) — шаги оборота цикла лагеря в прежнем порядке тела while: шаг возвращает 'next'
// (прежний continue), 'stop' (прежний break) или ничего (дальше по шагам). Порядок — CAMP_STEPS в blaze/camp.ts.
import * as gameClock from '../../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../../movement'
import { countOf } from '../../items'
import { log, reachTo, ents, isRod, lavaNear, liveBlazes, bystanderOnLine } from '../targets'
import { hasEffect, drinkFireResistance } from '../potions'
import { collectRods, walkNear } from '../approach'
import { aimFrac } from '../radar'
import { type CampState, OTHER, WS } from './state'
import { campClimb, campShoot, campDescend } from './moves'

export type Turn = 'next' | 'stop' | undefined

// Значения одного оборота, общие для шагов (прежние const внутри while).
export interface CampTick {
  have?: number
  me?: any
  now?: number
  blazes?: any[]
  others?: any[]
  vis?: (e: any) => boolean
  melee?: any[]
}

export async function campPotion (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot, want } = cs
  tk.have = countOf(bot, 'blaze_rod')
  if (tk.have >= want) { cs.out.stopped = 'набрал'; return 'stop' }
  if (!hasEffect(bot, 'fire_resistance')) {
    if (cs.frLeft() > 0) {
      const d = await drinkFireResistance(bot).catch(e => e.message)
      cs.out.drinks++
      for (let i = 0; i < 40 && !hasEffect(bot, 'fire_resistance'); i++) await sleep(100)
      log('лагерь: огнестойкость', { d, left: cs.frLeft(), on: hasEffect(bot, 'fire_resistance') })
      await cs.equipSword()
      // Не подействовало (глоток прерван ударом/пакет эффекта запоздал: B17c21 03.10) — ещё раз, потом выход.
      if (!hasEffect(bot, 'fire_resistance')) { cs.out.frMiss = (cs.out.frMiss || 0) + 1; if (cs.out.frMiss >= 3) { cs.out.stopped = 'зелье не подействовало'; return 'stop' } }
      return 'next'
    }
    cs.out.stopped = 'огнестойкость кончилась, зелий нет'
    return 'stop'
  }
}

export async function campEat (cs: CampState): Promise<Turn> {
  const { bot, session, dead } = cs
  // Сытость ≥ 19 — быстрое лечение (FoodData); есть, когда вплотную никого.
  if (((bot.food ?? 20) <= 18 || ((bot.health ?? 20) < 14 && (bot.food ?? 20) < 20)) && !liveBlazes(bot, dead, 4).some(e => reachTo(bot, e) <= 2.6)) {
    try { await (require('../../actions') as typeof import('../../actions')).eat(session, {}) } catch {}
    await cs.equipSword()
  }
  if ((bot.health ?? 20) < 7) { cs.out.stopped = `хп ${Math.round(bot.health ?? 0)} — лагерь бросаю`; return 'stop' }
}

export async function campLook (cs: CampState, tk: CampTick): Promise<void> {
  const { bot, dead } = cs
  cs.up = cs.onTop()
  if (cs.up !== !!bot.getControlState('sneak')) bot.setControlState('sneak', cs.up)
  tk.me = bot.entity.position
  tk.now = gameClock.now()
  tk.blazes = liveBlazes(bot, dead, 20)
  tk.others = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.position && e.isValid !== false && OTHER.test(e.name || '') && e.position.distanceTo(tk.me) < 12)
  // Иссушитель/брут рядом на уровне помоста (по горизонтали ≤ 8, по высоте ≤ 3) — угроза ближнего боя.
  // Только видимые (луч от глаз до груди): за стенами крепости иссушители есть всегда (B11f21 — наверху без спуска).
  tk.vis = e => { try { return (require('../../perception') as typeof import('../../perception')).raySees(bot, (require('../../perception') as typeof import('../../perception')).eyePos(bot), e.position.offset(0, (e.height || 1.8) * 0.6, 0)) } catch { return true } }
  tk.melee = tk.others.filter((e : any) => WS.test(e.name) && Math.hypot(e.position.x - tk.me.x, e.position.z - tk.me.z) <= 8 && Math.abs(e.position.y - cs.floorY) <= 3 && tk.vis(e))
  if (tk.now - cs.lastLog > 5000 && bot.inventory.emptySlotCount() < 3) { try { await (require('../../nether-route') as typeof import('../../nether-route')).makeRoom(bot, 5) } catch {} }
  if (tk.now - cs.lastLog > 5000) { cs.lastLog = tk.now; log('лагерь', { t: Math.round((tk.now - cs.t0) / 1000), hp: Math.round(bot.health ?? 0), up: cs.up, rods: tk.have, blazes: tk.blazes.length, ws: tk.melee.length, swings: cs.out.swings, shots: cs.out.shots, picks: cs.out.picks, kills: dead.size }) }
}

export async function campMelee (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot, ctl, session, setPhase, pick } = cs
  if (!cs.up && tk.melee.length) {
    // Наверх (столб с чашкой); не вышло — бой.
    if (await campClimb(cs)) { cs.lastAct = gameClock.now(); return 'next' }
    const foe: any = tk.melee.filter(e => pick.canHit(bot, e, { range: 6 })).sort((a: any, b: any) => a.position.distanceTo(tk.me) - b.position.distanceTo(tk.me))[0]
    if (foe && tk.now - (cs.noShot.get('f' + foe.id) || 0) > 5000) {
      cs.out.fights++
      setPhase('лагерь: бой ' + foe.name)
      const tf = gameClock.now()
      const r = await (require('../../combat') as typeof import('../../combat')).fight(session, ctl, { target: '#' + foe.id, timeoutSeconds: 20, retreatAtHealth: 7, shield: 'always', clearArea: 0 }).catch(e => ({ error: e.message }))
      log('лагерь: чужой', { name: foe.name, killed: !!(r && (r.killed || (r.kills && r.kills.length))), hp: Math.round(bot.health ?? 0), ms: gameClock.now() - tf })
      if (gameClock.now() - tf < 1500) { cs.noShot.set('f' + foe.id, gameClock.now()); await sleep(250) }
      await cs.equipSword()
      setPhase('лагерь у спавнера')
      return 'next'
    }
  }
}

export async function campWither (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot, setPhase } = cs
  // Наверху и иссушитель внизу — луком его (сверху он не достаёт).
  if (cs.up && tk.melee.length) {
    const ws: any = tk.melee.filter((e : any) => tk.now - (cs.noShot.get(e.id) || 0) > 2000).sort((a: any, b: any) => a.position.distanceTo(tk.me) - b.position.distanceTo(tk.me))[0]
    if (ws && cs.bowReady()) {
      setPhase('лагерь: лук по ' + ws.name)
      const r = await campShoot(cs, ws, 0.6)
      if (r.shot) { cs.out.wsShots++; cs.lastAct = gameClock.now() } else cs.noShot.set(ws.id, gameClock.now())
      if (cs.onTop()) bot.setControlState('sneak', true)
      return 'next'
    }
  }
}

export async function campSword (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot, pick } = cs
  // Меч по блейзу в досягаемости; щит к ближнему между взмахами.
  const inReach = tk.blazes.filter(e => reachTo(bot, e) <= 3.0 && pick.canHit(bot, e)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))
  if (inReach.length) {
    const e: any = inReach[0]
    if (tk.now - cs.lastSwing >= 640) {
      await cs.shield(false)
      try { await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.6, 0), true) } catch {}
      try { bot.attack(e); cs.lastSwing = gameClock.now(); cs.out.swings++; cs.lastAct = gameClock.now() } catch {}
      await sleep(60)
    }
    if (reachTo(bot, e) <= 2.4) await cs.shield(true, e.position.offset(0, (e.height || 1.8) * 0.6, 0))
    await sleep(50)
    return 'next'
  }
  if (cs.shieldOn) await cs.shield(false)
}

export async function campDown (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot } = cs
  // Наверху, иссушителей рядом нет — вниз, к спавнеру (там блейзы).
  if (cs.up && !tk.melee.length && !tk.others.some((e : any) => WS.test(e.name) && e.position.distanceTo(tk.me) < 10 && tk.vis(e)) && tk.now - (cs.noShot.get('down') || 0) > 5000) {
    if (await campDescend(cs)) { cs.lastAct = gameClock.now(); return 'next' }
    cs.noShot.set('down', gameClock.now())
    log('лагерь: слезть не вышло', { at: xyz(bot.entity.position), floorY: cs.floorY, why: cs.descWhy })
  }
}

export async function campRods (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot, ctl, setPhase } = cs
  // Стержни рядом на помосте — подобрать сразу (под зельем шары не страшны).
  if (!cs.up && tk.now - (cs.noShot.get('rods') || 0) > 10000) {
    const rodsNear = ents(bot).filter((e : any) => e && e.name === 'item' && e.position && isRod(e) && e.position.distanceTo(tk.me) <= 7 && e.position.y >= cs.floorY - 2.5 && !lavaNear(bot, e.position, 1))
    if (rodsNear.length) {
      setPhase('лагерь: стержни')
      const r0 = countOf(bot, 'blaze_rod')
      await collectRods(bot, ctl, 7, 4000)
      // Не прибавилось — эти стержни недостижимы (под спавнером, за забором): 10 с не пробовать (B13f21: 32 захода, 0).
      if (countOf(bot, 'blaze_rod') > r0) cs.out.picks++
      else cs.noShot.set('rods', gameClock.now())
      cs.lastAct = gameClock.now()
      await cs.equipSword()
      setPhase('лагерь у спавнера')
      return 'next'
    }
  }
}

export async function campChase (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot, ctl, setPhase } = cs
  // Блейз над помостом в 6 бл. и на высоте досягаемости — подойти под него по помосту (меч, а не лук: стержень
  // упадёт рядом; блейз с лучом сам не подлетает — BlazeAttackGoal).
  if (!cs.up) {
    const chase: any = tk.blazes.filter((e : any) => Math.hypot(e.position.x - tk.me.x, e.position.z - tk.me.z) <= 6 && e.position.y >= cs.floorY - 1 && e.position.y <= cs.floorY + 2.2 && tk.now - (cs.noShot.get('c' + e.id) || 0) > 4000)
      .map((e : any) => ({ e, c: new Vec3(Math.floor(e.position.x), cs.floorY, Math.floor(e.position.z)) }))
      .filter(({ c }: any) => { const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0)); return a && b && u && a.boundingBox === 'empty' && b.boundingBox === 'empty' && u.boundingBox === 'block' && !/lava|fire|magma/.test(u.name) })
      .sort((a: any, b: any) => a.e.position.distanceTo(tk.me) - b.e.position.distanceTo(tk.me))[0]
    if (chase) {
      setPhase('лагерь: к блейзу')
      const w = await walkNear(bot, ctl, chase.c, 1, 2500)
      if (!w || !w.ok) cs.noShot.set('c' + chase.e.id, gameClock.now())
      setPhase('лагерь у спавнера')
      return 'next'
    }
  }
}

export async function campBow (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot, spawner, setPhase } = cs
  // Дальние блейзы над помостом — луком (стержень упадёт на помост).
  const overFloor = e => !spawner || Math.hypot(e.position.x - spawner.x - 0.5, e.position.z - spawner.z - 0.5) <= 3.5
  const target: any = cs.bowReady() ? tk.blazes.filter((e : any) => { const d = e.position.distanceTo(tk.me); return d >= 3.2 && d <= 16 && overFloor(e) && tk.now - (cs.noShot.get(e.id) || 0) > 2500 && aimFrac(bot, e) !== null && !bystanderOnLine(bot, e) }).sort((a: any, b: any) => a.position.distanceTo(tk.me) - b.position.distanceTo(tk.me))[0] : null
  if (target) {
    setPhase('лагерь: лук')
    const r = await campShoot(cs, target, aimFrac(bot, target) ?? 0.55)
    if (r.shot) { cs.out.shots++; cs.lastAct = gameClock.now() } else cs.noShot.set(target.id, gameClock.now())
    if (cs.onTop()) bot.setControlState('sneak', true)
    setPhase('лагерь у спавнера')
    return 'next'
  }
}

export async function campHug (cs: CampState, tk: CampTick): Promise<Turn> {
  const { bot, ctl, spawner } = cs
  // Внизу — вплотную к спавнеру (соседняя клетка помоста): новые блейзы появляются в ±4 от него — ближе к мечу.
  if (!cs.up && spawner && Math.hypot(bot.entity.position.x - spawner.x - 0.5, bot.entity.position.z - spawner.z - 0.5) > 1.9 && tk.now - (cs.noShot.get('hug') || 0) > 8000) {
    const hug = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => new Vec3(spawner.x + dx, cs.floorY, spawner.z + dz)).filter(c => {
      const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0))
      return a && b && u && a.boundingBox === 'empty' && b.boundingBox === 'empty' && u.boundingBox === 'block' && !/lava|fire|magma/.test(u.name)
    }).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
    if (hug) { const w = await walkNear(bot, ctl, hug, 0, 3000); if (!w || !w.ok) cs.noShot.set('hug', gameClock.now()); else cs.base = hug }
    else cs.noShot.set('hug', gameClock.now())
    return 'next'
  }
}

export async function campIdle (cs: CampState): Promise<void> {
  await sleep(120)
}
