'use strict'
// Кристаллы Края в бою с игроком (просьба 2026-09-30: «они много урона наносят
// и тоже зрелищно драться ими, научи ботов ими биться зрелищно»). Бой — не
// ваншот, а размен: взрывы, «попы» тотемов, обсидиан вокруг ног, подрыв
// стрелой издалека. Без глупых самоподрывов и без действий сквозь стену.
//
// Механика — байткод Paper 1.21.11 (codex-lab/end-bytecode: EndCrystal,
// ServerExplosion, ExplosionDamageCalculator, LivingEntity) и декомпиляция
// клиента 1.21.11 (extremeheat/extracted_minecraft_data):
//  * EndCrystal.hurtServer: любой урон не от взрыва — remove и взрыв силы 6.0
//    в getX/Y/Z (низ кристалла = верх обсидиана), ExplosionInteraction.BLOCK,
//    приписан ударившему (damageSources.explosion(this, атакующий)); урон от
//    взрыва (чужой кристалл рядом) — remove БЕЗ взрыва: цепочек нет.
//  * EndCrystalItem.useOn: кликнутый блок — obsidian или bedrock (грань любая),
//    клетка над ним isEmptyBlock, в рамке [x,y+1,z]..[x+1,y+3,z+1] нет НИКАКИХ
//    сущностей (игроки, предметы, стрелы, рамки 2×2 соседних кристаллов).
//  * ServerExplosion.hurtEntities: d = |ноги − центр| / 12, > 1 — мимо;
//    видимость getSeenPercent (сетка по рамке, ClipContext.COLLIDER — луч от
//    точки рамки к центру); урон ((i² + i)/2·7·12 + 1), i = (1 − d)·вид.
//    Толчок (1 − d)·вид·(1 − explosion_knockback_resistance) по «центр → глаза»
//    («Взрывоустойчивость» +0.15 за уровень на вещь).
//  * LivingEntity.hurtServer: invulnerableTime > 10 (из 20) — урон не больше
//    lastHurt не проходит вовсе, больший — только разница. Значит второй
//    кристалл в 10 тиков после первого пропадает: ритм подрывов ≥ 0.5 с, а
//    свой следующий кристалл ставится заранее и бьётся, когда окно кончилось.
//    Обратное — своё окно: только что получил взрыв сырой силы R — чужой
//    кристалл со своими ≤ R бьётся «бесплатно» (ему — полностью).
//  * Урон после брони (CombatRules), чары: «Защита» 1, «Взрывоустойчивость»
//    2 за уровень, сумма ≤ 20 → ×(1 − EPF/25); сложность до брони: «трудно»
//    ×1.5, «легко» min(f/2+1, f) (boom.blast, Player.hurtServer).
//  * Пакеты при подрыве: damage_event и «поп» тотема (35) — из hurtServer, до
//    пакета взрыва; сущность кристалла снимается (remove) тоже раньше взрыва.
//  * RespawnAnchorBlock (бонус): светокамнем — заряд; «использовать» не
//    светокамнем в верхнем мире или Крае — removeBlock и взрыв 5 с огнём в
//    центре блока, ни на кого не записан.
// Приёмы (PVP-RESEARCH б.10, в.3; гайды Crystal PvP): кристалл у его ног —
// ближе к нему, чем к себе; подрыв рукой в 2–3 тика или стрелой с 6+ блоков;
// заранее поставленный кристалл во время его неуязвимости; surround — обсидиан
// с 4 сторон у своих ног (кристалл на уровне ног не встанет, а на блоке
// окружения закрыт снизу); сбить его кристалл, когда ему больнее или в своё
// окно; отойти, если его кристалл у меня и он его достаёт.

import * as gameClock from './game-clock'
import * as boom from './boom'
import { P, anchorReady, r1, shieldCovers } from './crystal/geometry'
import { kitOf } from './crystal/scoring'
import { createCrystalState } from './crystal/state'
import type { CrystalDeps } from './crystal/state'
import { createObserver } from './crystal/observe'
import { createDefense } from './crystal/defense'
import { createEvasion } from './crystal/evade'
import { createActions } from './crystal/actions'
import { createPlanner } from './crystal/plan'
import { createRunner } from './crystal/run'

const ON = process.env.ND_CRYSTAL !== '0'
const DEBUG = !!process.env.ND_DEBUG_CRYSTAL

const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
// S7c (07.10): щит в размене и в защите, уход в укрытие и блок между, хп соперника-игрока — оценкой.
// ND_CX2=0 — поведение до S7c (A/B серий).
const CX2 = process.env.ND_CX2 !== '0'

// ---------------------------------------------------------------- оценка

// Размен от взрыва в center: ему и мне (после брони и чар), сырые значения —
// для окна неуязвимости.
// meMax — мне при полной видимости (без лучей): предел «свой тотем — никогда»
// держится на нём, а не на лучах. Финальная партия b4: 15 из 298 подрывов
// дали мне больше прогноза на 3+ (шаг из-за укрытия за 2–3 тика до взрыва,
// лучи вскользь по краю окружения), один — хлопнул свой тотем при прогнозе 0.3.
// himShield — его щит поднят (shieldUpOf): источник в его передних 90° — ему 0 (сырой тоже: окна нет).
function trade (bot, center, him, me, dHim, dMe, cache, { himAt = null, meAt = null, power = P, himShield = false }: any = {}) {
  let h: ReturnType<typeof boom.blast> & { blocked?: boolean } = boom.blast(bot, center, power, himAt || him.position, { def: dHim, cache })
  if (himShield && h.raw > 0 && shieldCovers(him, himAt, center)) h = { ...h, dmg: 0, raw: 0, blocked: true }
  const m = boom.blast(bot, center, power, meAt || me.position, { def: dMe, cache })
  const mx = boom.blast(bot, center, power, meAt || me.position, { def: dMe, seen: 1 })
  return { him: h.dmg, me: m.dmg, meMax: mx.dmg, himRaw: h.raw, meRaw: m.raw, himSeen: h.seen, meSeen: m.seen }
}

// ---------------------------------------------------------------- бой

// foeHp(foe) — ЭХП соперника-игрока для решений: оценка (pvp.foeHpDecide, правило 06.10 «хп игрока только
// оценкой»); без неё — prior 20, для мобов — метаданные. telemetryHp — только замеры отчёта.
// noteAttack(range, {projectile}) — подтверждённый урон для
// оценки (combat-observe.trackFoe): damage_event с причиной «я» вычитает этот интервал.
// Тело — части crystal/: состояние S (бывшие let замыкания — его поля), наблюдение (слушатели), защита и уклонение,
// действия, план, исполнение; общее — через S, зависимости — через deps. game-clock, boom и build берёт только фасад
// (тесты подменяют их по spec './game-clock', './boom', './build').
function create (bot, opts: any = {}) {
  const deps: CrystalDeps = {
    gameClock, boom, sleep, trade, ON, DEBUG, CX2,
    // Лениво, как прежде в каждом месте установки блока.
    placeBlockAt: (...a: Parameters<typeof import('./build').placeBlockAt>) => (require('./build') as typeof import('./build')).placeBlockAt(...a)
  }
  const S = createCrystalState(bot, opts, deps)
  Object.assign(S, createObserver(S, deps))
  Object.assign(S, createDefense(S, deps))
  Object.assign(S, createEvasion(S, deps))
  Object.assign(S, createActions(S, deps))
  Object.assign(S, createPlanner(S, deps))
  Object.assign(S, createRunner(S, deps))
  const { st, enemy, anchorsAt, anchorSeen, heShows, hisHp, plan, run, close, worstVsMe, evade, coverSpot, wallSpot, guardFor, onBlock } = S

  function engaged () {
    const foe = enemy()
    if (!ON || !foe) return false
    const k = kitOf(bot)
    // Набор только с якорями (без кристаллов) — тоже взрывной бой (TODO п.8).
    return k.crystals > 0 || heShows(foe) || anchorReady(bot, k) ||
      [...anchorsAt.values()].some(a => a.pos.distanceTo(bot.entity.position) <= 8 && anchorSeen(a))
  }
  // Кристаллы — главное оружие (набор «кристаллы»: 96 штук): без коробки и без
  // перестрелки из лука. В «небе и порохе» (16 кристаллов среди элитр, булавы,
  // вагонеток) и в «арсенале» всё как было.
  const startDominant = kitOf(bot).crystals >= 20
  function dominant () {
    return ON && (startDominant || kitOf(bot).crystals >= 20)
  }

  function report () {
    const avg = st.dealt.length ? r1(st.dealt.reduce((s, x) => s + x, 0) / st.dealt.length) : undefined
    const active = st.placed || st.hits || st.shots || st.booms || st.surround || st.defuse || st.dodges || st.threats || st.shieldUps || st.covers || st.walls || st.anchors || st.anchorSeen || st.anchorPops
    if (!active) return undefined
    const out: any = {}
    for (const [k, v] of (Object.entries(st) as [string, any][])) {
      if (Array.isArray(v) ? v.length : (typeof v === 'object' ? Object.keys(v).length : v)) out[k] = v
    }
    if (avg !== undefined) out.avg = avg
    if (st.planN) { out.planMsAvg = Math.round(st.planMsSum / st.planN * 10) / 10; delete out.planMsSum }
    return out
  }

  return { st, plan, run, engaged, dominant, report, close, worstVsMe, evade, coverSpot, wallSpot, hisHp, guardFor, _onBlock: onBlock }
}

export { ON, CX2, create, trade }
export { baseFree, centerOf, hitAim, faceFor, crystalBox, boxDist, surrounded, losClear, shieldCovers, P } from './crystal/geometry'
export { landed, worthHit } from './crystal/scoring'
