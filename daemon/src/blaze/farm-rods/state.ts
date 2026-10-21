'use strict'
// Стержни ифрита (farmRods) — состояние навыка. Прежние `let` и стрелки замыкания farmRods — поля объекта fr (RodsFarm);
// стадии — farm-rods/stages.ts, старый цикл (legacy) — farm-rods/legacy.ts, оркестр — blaze/farm-rods.ts.
import * as gameClock from '../../game-clock'
import { xyz } from '../../movement'
import { countOf } from '../../items'
import * as worlds from '../../worlds'
import { EYES_WANTED, clamp, log, rodsShort } from '../targets'
import { damageLedger } from './ledger'

export const SPAWNER_RANGE = 16
// Снежок летит 1.5 блока за тик; дальше 24 блоков он опускается и расходится.
export const SNOW_RANGE = 24
// Досягаемость меча: от глаз до хитбокса, entity_interaction_range 3.0.
export const SWORD_REACH = 3.0
// Из укрытия мечом — только за теми, кто висит в этом радиусе от угла.
export const CHASE_FROM_COVER = 7
// Дальше этого от укрытия бой без огнестойкости не уводит (см. farmRods).
export const LEASH = 9

export interface RodsFarm {
  session: any
  ctl: any
  p: any
  bot: any
  mcData: any
  combat: typeof import('../../combat')
  actions: typeof import('../../actions')
  t0: number
  deadline: number
  retreatAt: number
  restAt: number
  restsLeft: number
  rests: any[]
  covers: any[]
  coverAt: number
  coverFailAt: number
  lastBeat: number
  anchor: any
  farSince: number
  coverFails: number
  bail: boolean
  fled: any
  dugIn: any
  retrace?: any
  radius: number
  rods0: number
  short: number
  want: number
  hp0: number
  here: any
  kills: any[]
  dead: Set<any>
  phase: string
  ledger: ReturnType<typeof damageLedger>
  hurtAt: Map<any, number>
  onHurt: (e: any) => void
  onDead: (e: any, how?: any) => void
  onGone: (e: any) => void
  fights: any[]
  ate: any[]
  thrown: number
  walked: any
  stopped: any
  highTimeouts: number
  potion: any
  toured: any
  held: any
  camp: any
  unseenWalks: number
  skip: Set<any>
  spawner: any
  spawnerFrom: string | null
  idleSince: number
}

// Начало навыка: сторож Ада, состояние, подписки на события (прежнее начало farmRods до try).
export function openRods (session, ctl, p: any = {}): RodsFarm {
  const bot = session.bot
  try { (require('../../ne-guard') as typeof import('../../ne-guard')).swatInstall(bot) } catch {}
  try { (require('../../ne-guard') as typeof import('../../ne-guard')).attach(session) } catch {}
  const mcData = session.mcData
  const fr = { session, ctl, p, bot, mcData } as RodsFarm
  fr.combat = require('../../combat')
  fr.actions = require('../../actions')
  fr.t0 = gameClock.now()
  fr.deadline = fr.t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  fr.retreatAt = clamp(p.retreatAtHealth ?? 8, 3, 16)
  // Раньше порога отхода — отдых за углом: пять блейзов разом снимают 16 хп за
  // полминуты (замер try-blaze-rods (а), первый прогон), а порог — это конец боя.
  fr.restAt = Math.max(fr.retreatAt + 6, 14)
  fr.restsLeft = p.rest === false ? 0 : 4
  fr.rests = []
  fr.covers = []
  fr.coverAt = 0
  fr.coverFailAt = 0
  fr.lastBeat = 0
  fr.anchor = null
  fr.farSince = 0
  fr.coverFails = 0
  fr.bail = false
  fr.fled = null
  fr.dugIn = null
  fr.radius = clamp(p.radius ?? 20, 8, 32)
  // Бой мечом (ND_BLAZE_MELEE) владеет руками с начала навыка: тактика не рвёт подготовку у спавнера (bnf3/bnf4 16.10: TACTICAL
  // на 2–4-й с — заход потерян до первого взмаха). Чужие враги вплотную тактика по-прежнему берёт (protectedEncounter).
  if (process.env.ND_BLAZE_MELEE !== '0' && worlds.worldOf(bot) === 'the_nether') session._blazeCombatCtl = ctl
  fr.rods0 = countOf(bot, 'blaze_rod')
  fr.short = rodsShort(bot, p.eyes ?? EYES_WANTED)
  // rods — сколько должно СТАТЬ в рюкзаке (так зовёт автомат: blaze {rods: 7});
  // count — сколько добыть сверх того, что есть.
  fr.want = p.rods ? Math.max(fr.rods0 + 1, p.rods) : fr.rods0 + Math.max(1, p.count ?? fr.short)
  fr.hp0 = Math.round(bot.health ?? 20)
  fr.here = worlds.worldOf(bot)

  fr.kills = []
  fr.dead = new Set()
  fr.phase = 'начало'
  fr.ledger = damageLedger(bot, () => fr.phase)
  // Кого мы задели за последние 3 с: пропажа засчитывается убийством только у
  // них. Иначе смена мира (worlds.js чистит все сущности) и смерть самого бота
  // рождали «убил 8» у бота, убившего одного.
  fr.hurtAt = new Map()
  fr.onHurt = e => { if (e && e.name === 'blaze') fr.hurtAt.set(e.id, gameClock.now()) }
  bot.on('entityHurt', fr.onHurt)
  fr.onDead = (e, how) => {
    if (!e || e.name !== 'blaze' || !e.position || fr.dead.has(e.id)) return
    if (e.position.distanceTo(bot.entity.position) > 24) return
    if (how === 'gone' && !(gameClock.now() - (fr.hurtAt.get(e.id) || 0) < 3000)) return
    fr.dead.add(e.id)
    fr.kills.push({ at: xyz(e.position), t: Math.round((gameClock.now() - fr.t0) / 100) / 10 })
  }
  fr.onGone = e => fr.onDead(e, 'gone')
  // entityDead приходит не всегда (pvp.js: «сущность снимается с мира через
  // секунду после смерти, и entityDead приходит не всегда») — счёт по нему одному
  // давал «по 1 стержню на блейза» 12 раз из 14, где игра даёт 0..1. Блейз не
  // исчезает сам в 24 блоках от игрока, поэтому пропажа рядом — тоже смерть.
  bot.on('entityDead', fr.onDead)
  bot.on('entityGone', fr.onGone)

  fr.fights = []
  fr.ate = []
  fr.thrown = 0
  fr.walked = null
  fr.stopped = null
  fr.highTimeouts = 0
  fr.potion = null
  fr.toured = null
  fr.held = null
  fr.camp = null
  fr.unseenWalks = 0
  // Недостижимые за стеной — не мёртвые: убийство их всё равно засчитается.
  fr.skip = new Set()
  return fr
}

// Конец навыка (прежний finally farmRods): отписки, руки — тактике, итог урона в журнал.
export function closeRods (fr: RodsFarm) {
  const { bot, session, ctl } = fr
  bot.removeListener('entityDead', fr.onDead)
  if (session._blazeCombatCtl === ctl) delete session._blazeCombatCtl
  bot.removeListener('entityGone', fr.onGone)
  bot.removeListener('entityHurt', fr.onHurt)
  fr.ledger.stop()
  log('урон', { hp: Math.round(bot.health ?? 0), ...(fr.ledger.report() || {}), last: fr.ledger.hits.slice(-6) })
}
