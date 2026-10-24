'use strict'
// Кристаллы (crystal.ts): состояние одного create() — счёт st, память его кристаллов и якорей, окна неуязвимости,
// бывшие let замыкания create() (поля S), честное восприятие. Части добавляют в S свои функции.

import * as pick from '../pick'
import { EYE, IFRAME_MS, losClear } from './geometry'
import { effHp } from './scoring'

// Зависимости одного create(): фасад crystal.ts берёт их своим require и передаёт частям. Тесты подменяют
// './game-clock', './boom' и './build' по spec у фасада — поэтому части сами game-clock/boom/build не требуют.
export interface CrystalDeps {
  gameClock: typeof import('../game-clock')
  boom: typeof import('../boom')
  sleep: (ms: number) => Promise<any>
  trade: (bot: any, center: any, him: any, me: any, dHim: any, dMe: any, cache: any, opts?: any) => CrystalTrade
  placeBlockAt: (...a: Parameters<typeof import('../build').placeBlockAt>) => ReturnType<typeof import('../build').placeBlockAt>
  ON: boolean
  DEBUG: boolean
  CX2: boolean
}
// Размен от взрыва (crystal.trade): ему и мне после брони и чар, сырые — для окна неуязвимости.
export interface CrystalTrade { him: number, me: number, meMax: number, himRaw: number, meRaw: number, himSeen: number, meSeen: number,
  allyDamage?: number, allyPush?: number, allyRisk?: boolean }
// Состояние одного create(): опции, счёт, память, бывшие let замыкания (поля с «?» задаются по ходу создания)
// и функции частей (Object.assign в фасаде).
export interface CrystalState {
  bot: any
  st?: any
  enemy: () => any
  // окна неуязвимости { at, raw } после взрыва: моё и его
  myWin?: { at: number, raw: number } | null
  hisWin?: { at: number, raw: number } | null
  // метки времени (gameClock.now()) — последнее действие своего вида
  myHurtAt?: number
  hisHurtAt?: number
  sawHis?: number
  pendingAt?: number
  lastSurround?: number
  lastDodge?: number
  lastPlaceShoot?: number
  lastEat?: number
  lastObby?: number
  lastMend?: number
  lastAnchor?: number
  shieldUntil?: number
  bowSeenAt?: number
  shieldStreakAt?: number
  shieldLastEnd?: number
  coverSince?: number | null
  anchorClick?: { key: string, at: number } | null
  worstCache?: { at: number, v: number }
  lastDmg?: { at: number, self: boolean } | null
  lastPress?: boolean
  [name: string]: any
}

function createCrystalState (bot, { enemy, used = () => {}, foeHp = null, noteAttack = null, telemetryHp = e => effHp(bot, e), guard = null }: any = {}, deps: CrystalDeps): CrystalState {
  const { gameClock } = deps
  const S = { bot, enemy, used, foeHp, noteAttack, telemetryHp, guard } as CrystalState
  const st: any = {
    placed: 0, obby: 0, hits: 0, shots: 0, pre: 0, booms: 0, mine: 0, his: 0,
    dealt: [], self: 0, selfPops: 0, popsDealt: 0, popsTaken: 0, hisPops: 0, myPops: 0,
    surround: 0, surroundBlocks: 0, defuse: 0, free: 0, dodges: 0,
    wallPlace: 0, wallHit: 0, fails: {},
    // Его подрывы у меня: threats — взрыв, который при полной видимости снял бы мне ≥ 4; evaded — из них
    // пришло ≤ max(1.5, четверть); threatMax/threatTaken — суммы прогноза и пришедшего (телеметрия, точное хп своё).
    threats: 0, evaded: 0, threatMax: 0, threatTaken: 0
  }
  const isPlayerE = (e) => !!e && (e.type === 'player' || !!e.username)
  const hisHp = (foe) => {
    if (isPlayerE(foe)) { const v = foeHp?.(foe); return typeof v === 'number' && Number.isFinite(v) ? v : 20 }
    return effHp(bot, foe)
  }
  const mine = new Map() // id → { at, how, hitAt }
  const exploded = [] // { at, center, mine }
  // Окно неуязвимости: принятый удар открывает 10 тиков; больший удар внутри
  // окна проходит разницей и окно НЕ продлевает (LivingEntity.hurtServer;
  // ревью Codex) — начало держим, сырой поднимаем до большего.
  const winUpdate = (w, at, raw) => (w && at - w.at < IFRAME_MS ? { at: w.at, raw: Math.max(w.raw, raw) } : { at, raw })
  S.myWin = null // { at, raw } — моё окно неуязвимости после взрыва
  S.hisWin = null
  S.myHurtAt = 0
  S.hisHurtAt = 0
  S.sawHis = 0 // когда он показал кристалл/обсидиан (в руке, свой кристалл)
  S.pendingAt = 0
  S.lastSurround = 0
  S.lastDodge = 0
  S.lastPlaceShoot = 0
  S.lastEat = 0
  S.lastObby = 0
  S.lastMend = 0
  S.lastAnchor = 0
  S.shieldUntil = 0
  S.bowSeenAt = -1e9
  // Щит подряд (s7c1 «кристалл со щитом» р.3: оба 75 раз под щитом, 192 с ничья): дольше 2.5 с без подрыва —
  // щит из вариантов уклонения вон, остаются укрытие/блок/отход (кристалл стоит — уйти от него, а не стоять).
  S.shieldStreakAt = 0
  S.shieldLastEnd = -1e9
  S.coverSince = null
  // Якоря рядом (S7c, просьба пользователя 01:26 — наравне с кристаллами): блоки respawn_anchor по blockUpdate;
  // mine — поставил я. anchorClick — мой клик-подрыв (свой или его якорь): чей взрыв силы 5.
  const anchorsAt = new Map()
  const myAnchorCells = new Set()
  // Честное восприятие (S7d, открытое №3 S7c): его кристаллы — только увиденные (луч от моих глаз до кристалла без
  // блоков, или этот кристалл я уже видел), якоря — мои или увиденные (pick.blockSeen: верх/грань в прицеле глаз),
  // его снаряжение (лук, кристалл в руке) запоминается, только пока он сам мне виден. blockUpdate/entity_spawn
  // приходят на всё в прогруженных чанках — это знание мира, не взгляд. ND_HONEST_CX=0 — прежнее (для сравнения).
  const HONEST = process.env.ND_HONEST_CX !== '0'
  const seenCrystals = new Set()
  const myEye = () => bot.entity.position.offset(0, EYE, 0)
  const crystalSeen = (e) => {
    if (!HONEST) return true
    if (seenCrystals.has(e.id)) return true
    const eye = myEye()
    if (losClear(bot, eye, e.position.offset(0, 1, 0))) { seenCrystals.add(e.id); st.seenCrystals = (st.seenCrystals || 0) + 1; return true }
    st.hiddenCrystals = (st.hiddenCrystals || 0) + 1
    return false
  }
  const foeVisible = (foe) => !HONEST || (foe && foe.position && losClear(bot, myEye(), foe.position.offset(0, 1.2, 0)))
  const anchorSeen = (a) => {
    const now = gameClock.now()
    if (now - (a.checkAt ?? -Infinity) < 250) return !!(a.seen || a.mine)
    a.checkAt = now
    try {
      const b = bot.blockAt(a.pos, false)
      if (b?.name === 'respawn_anchor') {
        if (!HONEST || pick.blockSeen(bot, a.pos)) {
          a.seen = true
          a.charges = Number(b.getProperties?.().charges) || 0
        }
      } else if (b) {
        // Пропажу тоже нужно увидеть: packet за стеной не стирает память якоря.
        const eye = myEye(); const d = a.pos.offset(.5, .5, .5).minus(eye); const len = d.norm()
        if (!HONEST || len <= 64) {
          const hit = len > 0 ? pick.blockOnRay(bot, eye, d.scaled(1 / len), len) : null
          if (!HONEST || !hit || hit.pos.equals(a.pos)) { anchorsAt.delete(cellKey(a.pos)); return false }
        }
      }
    } catch {}
    return !!(a.seen || a.mine)
  }
  S.anchorClick = null
  const cellKey = (p) => `${p.x},${p.y},${p.z}`
  S.worstCache = { at: 0, v: 0 }
  const fail = (why) => { st.fails[why] = (st.fails[why] || 0) + 1 }

  const inWin = (w, ms = IFRAME_MS - 20) => w && gameClock.now() - w.at < ms ? w : null
  // Только кристалл (в руке или поставленный у нас): обсидиан в руке — ещё не
  // кристаллы («арсенал»: обсидиан — на коробку), и «бой кристаллами» с его
  // запретом коробки и перестрелки тогда включался бы зря.
  const heShows = (foe) => {
    const eq = (foe && foe.equipment) || []
    if (eq.slice(0, 2).some(it => it && /^(end_crystal|respawn_anchor)$/.test(it.name)) && foeVisible(foe)) S.sawHis = gameClock.now()
    return gameClock.now() - S.sawHis < 60000
  }
  return Object.assign(S, { st, isPlayerE, hisHp, mine, exploded, winUpdate, anchorsAt, myAnchorCells, seenCrystals, myEye, crystalSeen, foeVisible, anchorSeen, cellKey, fail, inWin, heShows })
}

export { createCrystalState }
