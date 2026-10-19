import * as fortify from '../fortify'
import * as gameClock from '../game-clock'
import { bestWeapon } from '../items'
import * as read from '../read'
import * as tempo from '../tempo'
import { healthOf, makeTracker } from './body'
import { FIX, profileOf } from './rules'
import { type DuelCtx } from './turn'

// Состояние боя: цель, профиль, счёт, калькулятор его хп (оценкой), граф боя.
export function installCore (ctx: DuelCtx) {
  const { acquired, bot, opts, vision } = ctx
  ctx.lastStand = opts.lastStand === true || opts.repelLava === true
  ctx.fireTerrainSafe = (cell) => {
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 4; dy++) {
      const block = bot.blockAt(cell.offset(dx, dy, dz))
      if (!block || /_log$|_wood$|_planks$|_leaves$|_wool$|_carpet$|_fence$|_stairs$|_slab$|chest|barrel|bookshelf|hay_block|bamboo|vine/.test(block.name)) return false
    }
    return true
  }
  const {
    retreatAtHealth = 4,
    timeoutSeconds = 60,
    guard = null,
    calmAfterMs = 0,
    healAt = 10,
    clearArea = 0,
    arena = null
  } = opts
  ctx.retreatAtHealth = retreatAtHealth
  ctx.guard = guard
  ctx.calmAfterMs = calmAfterMs
  ctx.healAt = healAt
  ctx.clearArea = clearArea
  ctx.arena = arena
  if (guard?.watch) guard.watch(ctx.entity, 3.2)
  ctx.label = ctx.entity.username || ctx.entity.name
  ctx.track = makeTracker(ctx.entity)
  ctx.prof = profileOf(ctx.entity)
  ctx.seenAt = gameClock.now()
  // Прыжок — средство пройти наблюдаемое препятствие/уступ к видимой опоре, без урона от падения.
  // Не в ближнем «держу дистанцию» (копьё 3.4–4.5: s7e — 17 попыток за раунд). ND_PVP_HOP=0 — выкл.
  ctx.HOP = process.env.ND_PVP_HOP !== '0'

  const st: any = ctx.st = {
    swings: 0,
    cutFails: 0,
    landed: 0,
    crits: 0,
    sprintHits: 0,
    axeOnShield: 0,
    dodges: 0,
    tricks: {},
    healed: [],
    hpStart: Math.round(bot.health ?? 20)
  }
  if (acquired.search.legs) st.search = acquired.search
  ctx.traceT0 = gameClock.now()
  // Урон приёмов (аудит комбо, 2026-10-06): падение его хп (с поглощением) —
  // последнему приёму не старше 1.5 с, иначе «прочее». Оценка: лечение между
  // тиками и тотем её занижают.
  st.trickDmg = {}
  // Хп противника-игрока в решениях — только оценкой (правило пользователя 06.10, боевой калькулятор:
  // pvp/combat-observe.trackFoe → hp-estimate по подтверждённым попаданиям, видимому лечению, тотему, регенерации).
  // healthOf остаётся для мобов и телеметрии (trickDmg, mace.dealt).
  const co = ctx.co = require('./combat-observe')
  ctx.telemetryHp = e => co.exactHpTelemetryOnly(bot, vision.source(e))
  ctx.calc = co.trackFoe(bot, ctx.entity, { honest: true, visible: vision.visible, roundScope: opts.roundScope })
  const foeEst = ctx.foeEst = () => ctx.calc.hp.snapshot()
  ctx.foeHpDecide = (e = ctx.entity) => co.isPlayer(e) ? (e === ctx.calc.entity ? foeEst().mean : 20) : healthOf(bot, e)
  // Граф боя (S7d, pvp/fight-graph): каждые 5 тиков — план калькулятора + длинные приёмы → решение и разрешения веткам.
  // ND_FIGHT_GRAPH=0 — прежний порядок веток (сравнение на снимках). Комбо — цепочки приёмов перед его потерей хп.
  const fg = ctx.fg = require('./fight-graph')
  const GRAPH = ctx.GRAPH = process.env.ND_FIGHT_GRAPH !== '0'
  ctx.combo = fg.comboLog(() => gameClock.now())
  ctx.blk = require('./block-log').install(bot)
  const noteGate = ctx.noteGate = (kind) => {
    st.calc = st.calc || { plans: 0, kinds: {} }
    st.calc.gated = st.calc.gated || {}
    st.calc.gated[kind] = (st.calc.gated[kind] || 0) + 1
  }
  ctx.gate = (kind) => {
    if (!GRAPH || !ctx.gp) return true
    if (ctx.gp.allow(kind)) return true
    noteGate(kind)
    return false
  }
}

// Учёт урона приёмов, размены, перекрытие еды, счётчики построек.
export function installDamageLog (ctx: DuelCtx) {
  const { TRACE, bot, combo, foeEst, st, trace, traceT0, vision } = ctx
  const onTickDmg = ctx.onTickDmg = () => {
    const h = healthOf(bot, vision.source(ctx.entity))
    if (typeof h !== 'number') return
    if (ctx.foeHp != null && h < ctx.foeHp - 0.05) {
      if (st.shield && gameClock.now() - ctx.shieldHitAt < 600) st.shield.through = Math.round((st.shield.through + ctx.foeHp - h) * 10) / 10
      const k = ctx.lastTrick && gameClock.now() - ctx.lastTrick.at <= 1500 ? ctx.lastTrick.what : 'прочее'
      st.trickDmg[k] = Math.round(((st.trickDmg[k] || 0) + ctx.foeHp - h) * 10) / 10
      combo.dealt(ctx.foeHp - h)
      if (TRACE) trace(`ему −${Math.round((ctx.foeHp - h) * 10) / 10} (у него ${Math.round(h)}; телеметрия)`)
    }
    if (TRACE) {
      const mh = (bot.health ?? 0)
      if (ctx.myHpT != null && mh < ctx.myHpT - 0.05) trace(`мне −${Math.round((ctx.myHpT - mh) * 10) / 10} (у меня ${Math.round(mh)})`)
      ctx.myHpT = mh
    }
    ctx.foeHp = h
  }
  bot.on('physicsTick', onTickDmg)
  ctx.used = (what) => {
    st.tricks[what] = (st.tricks[what] || 0) + 1
    ctx.lastTrick = { what, at: gameClock.now() }
    combo.note(what)
    if (process.env.ND_TRACE_PVP) {
      try {
        const m = bot.entity.position; const h = ctx.entity && ctx.entity.position
        // Оценка его хп (решения) и точное (только телеметрия — для разбора боя, не для решений).
        let est = ''
        try { const e = foeEst(); est = ` оценка ${Math.round(e.lo)}–${Math.round(e.hi)} (точно ${Math.round(healthOf(bot, vision.source(ctx.entity)) ?? -1)})` } catch {}
        console.log(`[trace] ${new Date().toISOString().slice(11, 19)} ${bot.username} +${((gameClock.now() - traceT0) / 1000).toFixed(1)}s ${what} | я ${m.x.toFixed(1)},${m.y.toFixed(1)},${m.z.toFixed(1)} хп ${Math.round(bot.health ?? 0)}${h ? ` | он ${h.x.toFixed(1)},${h.y.toFixed(1)},${h.z.toFixed(1)} d=${m.distanceTo(h).toFixed(1)}${est}` : ''}`)
      } catch {}
    }
  }
  const quiet = ctx.quiet = { at: gameClock.now(), gaps10: 0, total10: 0, longest: 0 }
  ctx.noteExchange = () => {
    const now = gameClock.now()
    const gap = now - quiet.at
    if (gap >= 10000) { quiet.gaps10++; quiet.total10 += gap }
    if (gap > quiet.longest) quiet.longest = gap
    quiet.at = now
  }
  ctx.ovl = { ms: 0, n: 0, at: gameClock.now(), was: false }
  st.build = { box: 0, pillar: 0, counter: 0, pit: 0, boxHot: 0, pillarHot: 0, counterHot: 0, pitHot: 0, aborted: 0, refused: 0, boxMs: [] }
  st.eatPunish = { tries: 0, swaps: 0 }
}

// Нрав (стиль), темп и чтение соперника, «заметил — ответил», броски жребия; оружие.
export function installTempo (ctx: DuelCtx) {
  const { attackers, bot, healAt, noticed, rolls, session, st, vision } = ctx
  const style: any = ctx.style = {
    aggression: 0.35 + Math.random() * 0.6, // кидаться ли в окна (ест, прячется)
    reactMs: 80 + Math.random() * 220, // заметил — через сколько ответил
    fortAt: healAt + Math.round(Math.random() * 5) - 2, // когда в коробку
    patchBudget: 3 + Math.floor(Math.random() * 6), // сколько блоков латать в осаде
    boxPatienceMs: 15000 + Math.random() * 25000, // сколько сидеть в коробке
    punchLimit: 4 + Math.floor(Math.random() * 4) // сколько прорубать без удара
  }
  st.style = { агрессия: Math.round(style.aggression * 100) / 100, реакцияМс: Math.round(style.reactMs), коробкаНа: style.fortAt }
  style.openDelayMs = Math.round(Math.random() * (FIX ? 1200 : 700))
  const tt = ctx.tt = tempo.track(bot, {
    threats: () => [ctx.entity, ...[...attackers.values()].filter(a => gameClock.now() - a.at < 8000).map(a => a.e)].map(vision.observe).filter(Boolean),
    reactMs: style.reactMs
  })
  session.tempo = tt
  const foe = ctx.foe = read.watch(bot, { threats: tt.threats, visible: vision.visible })
  tt.read = foe
  {
    const close0 = tt.close
    let closed = false
    tt.close = () => {
      close0()
      if (closed) return
      closed = true
      foe.close()
      const fsx = foe.stats
      if (fsx.pops) st.tricks[`враг: сработал тотем ×${fsx.pops}`] = 1
      if (fsx.shieldBreaks) st.tricks[`враг: щит выбит ×${fsx.shieldBreaks}`] = 1
      if (fsx.aimedAtMe) st.tricks[`враг: заряженный арбалет на мне ×${fsx.aimedAtMe}`] = 1
      if (fsx.absorb) st.tricks[`враг: поглощение до ${Math.round(fsx.absorb)}`] = 1
      const effs = Object.keys(fsx.effects)
      if (effs.length) st.tricks['враг: эффекты ' + effs.join(', ')] = 1
      if (st.xbow && (st.xbow.shots || st.xbow.loads)) st.tricks[`арбалет: выстрелов ${st.xbow.shots || 0}, попал ${st.xbow.hits || 0}, зарядок ${st.xbow.loads || 0}`] = 1
    }
  }
  ctx.fortSealed = () => !!(ctx.fort && fortify.enclosure(bot, ctx.fort.cell).sealed)
  ctx.after = (key, cond, ms = style.reactMs) => {
    if (!cond) { delete noticed[key]; return false }
    if (!noticed[key]) noticed[key] = gameClock.now()
    return gameClock.now() - noticed[key] >= ms
  }
  ctx.roll = (key, cond, p) => {
    if (!cond) { delete rolls[key]; return false }
    if (!(key in rolls)) rolls[key] = Math.random() < p
    return rolls[key]
  }

  ctx.weapon = bestWeapon(bot)
  ctx.lastHurtByTarget = gameClock.now()
}
