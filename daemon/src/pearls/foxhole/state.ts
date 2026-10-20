'use strict'
// Окоп (huntFoxhole) — состояние охоты и действия над ним. Прежние `let` и стрелки замыкания huntFoxhole — поля
// объекта fh (FoxHunt); большие стрелки (взгляд, место под окоп, бой снаружи) — функции с fh первым аргументом.
// Шаги цикла — foxhole/steps.ts, оркестр — pearls/foxhole.ts.
import * as gameClock from '../../game-clock'
import { sleep, xyz } from '../../movement'
import { countOf, bestWeapon } from '../../items'
import { POKE_R, FOX_AVOID, clamp, log, meta, ents, pickUp, solidAt } from '../common'
import { clearRay, eyesSeen, openFight } from '../aim'
import { trappedEm, endermanReach } from '../shelter'
import { foxSite, foxBuild } from './site'

export interface FoxHunt {
  session: any
  ctl: any
  p: any
  bot: any
  mcData: any
  t0: number
  deadline: number
  pearls0: number
  want: number
  hp0: number
  rounds: any[]
  dead: Set<any>
  hurtAt: Map<any, number>
  onHurt: (e: any) => void
  onDead: (e: any, how?: any) => void
  onGone: (e: any) => void
  pitchCap: number | null
  capPitch: () => void
  stopped: any
  fox: any
  kills: number
  aggros: number
  stares: number
  peeks: number
  moves: number
  hits: number
  hitsOnMe: number
  skip: Map<any, number>
  angrySince: Map<any, number>
  recentAngry: Map<any, number>
  hot: (e: any) => boolean
  ignore: Map<any, number>
  weapon: any
  isPearl: (e: any) => boolean
  endermen: () => any[]
  skipped: (e: any) => boolean
  ignored: (e: any) => boolean
  angry: (e: any) => boolean
  pending: () => any[]
  reach: any
  canCome: (e: any) => boolean
  onMeHurt: (victim: any) => void
  inHole: () => any
  bad: any[]
  used: any[]
  lastChance: number
  lastPeek: number
  lastPoke: number
  pokes: number
  lastNear: number
  lastReach: number
  stalks: number
  openFights: number
  avoid0: any
}

// Начало охоты: состояние, подписки на события, ограничитель взгляда (как прежнее начало huntFoxhole до try).
export function openFoxHunt (session, ctl, p: any = {}): FoxHunt {
  const bot = session.bot
  const mcData = session.mcData
  const fh = { session, ctl, p, bot, mcData } as FoxHunt
  fh.t0 = gameClock.now()
  fh.deadline = fh.t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  fh.pearls0 = countOf(bot, 'ender_pearl')
  fh.want = fh.pearls0 + Math.max(1, p.count ?? 4)
  fh.hp0 = Math.round(bot.health ?? 20)
  fh.rounds = []
  fh.dead = new Set()
  fh.hurtAt = new Map()
  fh.onHurt = e => { if (e && e.name === 'enderman') fh.hurtAt.set(e.id, gameClock.now()) }
  fh.onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || !e.position || e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (fh.hurtAt.get(e.id) || 0) < 3000)) return
    fh.dead.add(e.id)
  }
  fh.onGone = e => fh.onDead(e, 'gone')
  // Взгляд вниз всегда, кроме нарочного взгляда в глаза выбранному (как в дуэли).
  fh.pitchCap = -0.35
  fh.capPitch = () => { if (fh.pitchCap !== null && bot.entity && bot.entity.pitch > fh.pitchCap) bot.entity.pitch = fh.pitchCap }
  bot.on('entityHurt', fh.onHurt)
  bot.on('entityDead', fh.onDead)
  bot.on('entityGone', fh.onGone)
  bot.on('physicsTick', fh.capPitch)
  fh.stopped = null
  fh.fox = null
  fh.kills = 0
  fh.aggros = 0
  fh.stares = 0
  fh.peeks = 0
  fh.moves = 0
  fh.hits = 0
  fh.hitsOnMe = 0
  fh.skip = new Map()
  fh.angrySince = new Map()
  // Кто был злым последние 45 с: злость эндермена (NeutralMob) живёт 20–39 с и
  // после того, как метка «злой» снята (цель потеряна без луча за 3 с), — увидит
  // нас снова и сразу бьёт. Таких не подкрадываться и из ямы при них не выходить.
  fh.recentAngry = new Map()
  fh.hot = e => fh.angry(e) || gameClock.now() - (fh.recentAngry.get(e.id) || 0) < 45000
  fh.ignore = new Map()
  fh.weapon = bestWeapon(bot)
  fh.isPearl = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'ender_pearl' } catch { return false } }
  fh.endermen = () => ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !fh.dead.has(e.id))
  fh.skipped = e => (fh.skip.get(e.id) || 0) > gameClock.now()
  fh.ignored = e => (fh.ignore.get(e.id) || 0) > gameClock.now()
  fh.angry = e => !!meta(bot, e, 'creepy')
  fh.pending = () => fh.endermen().filter((e : any) => fh.angry(e) && !fh.ignored(e) && e.position.distanceTo(bot.entity.position) < 40)
  fh.reach = null
  fh.canCome = e => e.position.distanceTo(bot.entity.position) > 16 || !fh.reach || fh.reach.has(`${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}`)
  fh.onMeHurt = victim => { if (victim === bot.entity) fh.hitsOnMe++ }
  bot.on('entityHurt', fh.onMeHurt)
  fh.inHole = () => fh.fox && bot.entity.position.floored().equals(fh.fox.H) && solidAt(bot, fh.fox.R)
  // Места: bad — не построилось (исключаем саму клетку), used — ушли, потому
  // что рядом некого злить (исключаем 8 блоков вокруг). Раньше любое прошлое
  // место, даже не дошли, закрывало 10 блоков, и следующее выходило за 30–44
  // шага — pathfinder туда в лесу не доходил (ферма 29.09, foxhole-3: «до места
  // окопа не дошёл» 5 раз из 9).
  fh.bad = []
  fh.used = []
  fh.lastChance = gameClock.now()
  fh.lastPeek = gameClock.now()
  fh.lastPoke = 0
  fh.pokes = 0
  fh.lastNear = gameClock.now()
  fh.lastReach = gameClock.now()
  fh.stalks = 0
  fh.openFights = 0
  fh.avoid0 = bot._ndMobAvoidOnly
  bot._ndMobAvoidOnly = FOX_AVOID
  // S1f (проверка S1e (г)): «тело в своём окопе» — для тактики: стрелков вдали (гаст, скелет) окоп держит сам (крыша), охоту не рвать.
  bot._ndInFoxhole = () => !!fh.fox && !!fh.inHole()
  return fh
}

// Конец охоты (прежний finally huntFoxhole): отписки и флаги тела.
export function closeFoxHunt (fh: FoxHunt) {
  const { bot } = fh
  bot._ndInFoxhole = null
  bot._ndMobAvoidOnly = fh.avoid0
  bot.removeListener('entityHurt', fh.onHurt)
  bot.removeListener('entityDead', fh.onDead)
  bot.removeListener('entityGone', fh.onGone)
  bot.removeListener('entityHurt', fh.onMeHurt)
  bot.removeListener('physicsTick', fh.capPitch)
}

export async function foxStare (fh: FoxHunt, target, ms) {
  const { bot, ctl } = fh
  fh.stares++
  fh.pitchCap = null
  const tS = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() - tS < ms && !fh.angry(target) && target.isValid !== false && bot.entities[target.id]) {
      if (target.position.distanceTo(bot.entity.position) < 5) break
      if (eyesSeen(bot, target)) await bot.lookAt(target.position.offset(0, 2.55, 0), true).catch(() => {})
      await sleep(100)
    }
  } finally {
    fh.pitchCap = -0.35
    try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
  }
  const ok = fh.angry(target)
  if (ok) fh.aggros++
  else fh.skip.set(target.id, gameClock.now() + 30000)
  return ok
}

export function foxStarePool (fh: FoxHunt, maxD = 24) {
  const { bot } = fh
  const me = bot.entity.position
  return fh.endermen().filter(e => !fh.skipped(e) && !fh.angry(e) && !trappedEm(bot, e))
    .filter((e : any) => { const d = e.position.distanceTo(me); return d >= 5 && d <= maxD })
    .filter(e => fh.canCome(e) && eyesSeen(bot, e))
    .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

// opts.near — окоп вплотную к этому месту (подкрасться к спокойному: из ямы
// достать его мечом, и злой уже не бьёт — луча нет).
export async function foxNewSite (fh: FoxHunt, opts: any = {}) {
  const { bot, ctl, mcData } = fh
  const { walkable }: typeof import('../../walkable') = require('../../walkable')
  const ems = fh.endermen().filter(e => !trappedEm(bot, e))
  const cands = []
  let checked = 0
  let nodes = 0
  const rej = {}
  // Из ямы заливка наружу не выходит (прыжок упирается в крышу) — от выхода.
  // Только если стоим на дне этой самой ямы: после «к эндерменам» тело ниже
  // старой ямы, но далеко от неё — заливка от старого выхода давала 0 клеток.
  const from = fh.fox && bot.entity.position.floored().equals(fh.fox.H) ? fh.fox.out : bot.entity.position
  let list = walkable(bot, from, { radius: 24, maxNodes: 4000 })
  if (list.length < 5 && from !== bot.entity.position) list = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 4000 })
  // Сидим в яме (чужая нора, старый окоп, провал): заливка — 1–2 клетки, мест нет
  // (foxhole-9, слоты 1 и 5: «мест нет, nodes 0–1»). Подняться столбом на 2 и снова.
  if (list.length < 5) {
    try { await (require('../../build') as typeof import('../../build')).towerUp(bot, ctl, 2) } catch {}
    list = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 4000 })
  }
  for (const n of list) {
    if (fh.bad.some(s => s.distanceTo(n.pos) < 1.5) || fh.used.some(s => s.distanceTo(n.pos) < 1.5)) continue
    if (opts.near && (Math.hypot(n.pos.x + 0.5 - opts.near.x, n.pos.z + 0.5 - opts.near.z) > 2.6 || Math.hypot(n.pos.x + 0.5 - opts.near.x, n.pos.z + 0.5 - opts.near.z) < 1.2 || Math.abs(n.pos.y - Math.floor(opts.near.y)) > 1)) continue
    nodes++
    const site = foxSite(bot, mcData, n.pos, rej)
    if (!site) continue
    if (++checked > 250) break
    const eye = n.pos.offset(0.5, 0.62, 0.5)
    let seen = 0
    let around = 0
    let near = 0
    for (const e of (ems as any)) {
      const d = e.position.distanceTo(eye)
      if (d > 5 && d <= 24) { around++; if (clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++ }
      if (d <= POKE_R) near++
    }
    // Рядом (до POKE_R) — под удар-вызов: глаз в лесу почти не видно. Близкое
    // к телу место дороже дальнего: дальние pathfinder в лесу часто не находил.
    // Рядом со старым местом (там уже звать некого) — дешевле, но не запрет: в
    // холмах заливка короткая, и запрет 8 блоков оставлял «мест нет» (слот 1).
    const stale = fh.used.some(s => s.distanceTo(n.pos) < 8) ? 8 : 0
    const score = seen * 6 + near * 3 + around - n.d * 0.8 - (site.needProp ? 1 : 0) - site.fills.length * 0.7 - stale
    cands.push({ site, score, seen, around, near, steps: n.d })
  }
  if (!cands.length) { log('окоп: мест нет', { nodes, rej, at: xyz(bot.entity.position.floored()) }); return { ok: false, why: 'ровного места под окоп (яма 1x1, пол вокруг на уровне, без лавы) рядом нет', checked, nodes } }
  cands.sort((a, c) => c.score - a.score)
  let last = null
  for (const c of cands.slice(0, 3)) {
    if (ctl.aborted) break
    log('место окопа', { at: xyz(c.site.P), seen: c.seen, near: c.near, around: c.around, steps: c.steps, prop: c.site.needProp, checked })
    const b = await foxBuild(bot, ctl, mcData, c.site, () => fh.endermen().some((e : any) => fh.angry(e) && e.position.distanceTo(bot.entity.position) < 5))
    if (b.ok) {
      try { fh.reach = endermanReach(bot, c.site.out, { radius: 28 }) } catch { fh.reach = null }
      return { ok: true, fox: c.site, placed: b.placed }
    }
    fh.bad.push(c.site.P)
    last = b
    log('окоп не встал', { at: xyz(c.site.P), why: b.why })
    // Злой уже рядом — не бродить по местам, бой решит основной цикл.
    if (fh.endermen().some((e : any) => fh.angry(e) && e.position.distanceTo(bot.entity.position) < 8)) break
  }
  return last || { ok: false, why: 'окоп не построился' }
}

// Злой уже в 5 блоках, а мы не в яме (вышли за жемчугом, не вернулись) —
// бой на месте со щитом (как дуэль), а не поиск места под окоп у него под рукой.
export async function foxFightOpen (fh: FoxHunt) {
  const { bot, ctl, session } = fh
  const me = bot.entity.position
  const em: any = fh.endermen().filter((e : any) => fh.angry(e) && !fh.ignored(e) && e.position.distanceTo(me) < 5).sort((a: any, c: any) => a.position.distanceTo(me) - c.position.distanceTo(me))[0]
  if (!em) return false
  fh.openFights++
  const hpA = bot.health ?? 20
  const f: any = await openFight(session, ctl, em, { retreatAt: 6, dead: fh.dead, maxMs: 30000 }).catch(e => ({ error: e.message }))
  const r: any = { id: em.id, open: true, killed: fh.dead.has(em.id), swings: f && f.swings, hpLost: Math.round((hpA - (bot.health ?? 20)) * 10) / 10 }
  if (r.killed) {
    fh.kills++
    await sleep(1500)
    await pickUp(bot, ctl, 6, 2500)
  }
  r.pearls = countOf(bot, 'ender_pearl')
  // Ни одного взмаха (не достать: выше, за блоком) — не крутиться на нём: 20 с мимо
  // (ферма 29.09, foxhole-8 слот 13: «бой снаружи» с 0 взмахов по кругу).
  if (!r.killed && !(f && f.swings)) fh.ignore.set(em.id, gameClock.now() + 20000)
  fh.rounds.push(r)
  log('окоп: бой снаружи', r)
  return true
}
