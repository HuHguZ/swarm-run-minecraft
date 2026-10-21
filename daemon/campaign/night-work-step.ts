'use strict'
// Работа ночью: что можно делать в темноте и один шаг такой работы.
import { OW_HEAR, DEEP_Y } from './flags'
import { call } from './rpc'
import { manualControl, strategyInterrupted, state, sit, died, known, lavaSourceKnown, knownWater, setHeardLava,
  setStage } from './state'
import { log } from './log'
import { have, y, dim, LOGS, COBBLE, RAW, FOOD, PICK_IRON, portalFar, portalBuckets, shieldOn, lighter } from './queries'
import { sense, refresh, readMemory } from './observe'
import { READY, netherFoodNeed, near3, lavaApproachSeconds, stageRun } from './stages/table'
import { act } from './act'
import { leaveWater, awayFromWater, MOB_BLOCKED, CAVE_FOES } from './danger'
import { spares, smeltAll, torches } from './kit'
import { spendIron } from './gear'
import { cook } from './food'
import { castForKit, kitWaterHere } from './portal-kit'
import { structureValue } from './scout'
import { approachCastLava } from './deep-cast'
import { enterNether } from './nether-trip'
import { intelligence } from './strategy-bridge'
import * as path from 'path'
import * as gameClock from '../src/game-clock'
const nightWorkEnabled = process.env.ND_NIGHT_WORK !== '0'
const nightWorkSafe = process.env.ND_NIGHT_WORK_SAFE !== '0'
const nightWorkSafety = nightWorkSafe ? require('../src/night-work') : null
const nightWorkFailures = new Map()
const nightRelocated = new Set<string>()
let nightWorkFoes = ''
let nightWorkLavaView = ''
const nightWorkCastCause = () => JSON.stringify([known.lava, nightWorkLavaView])
const nightWorkItems = re => JSON.stringify(Object.entries(state.inventory || {}).filter(([k]) => re.test(k)).sort())
// Повтор оценивает тот же открытый проём, а не стены, которые сами поставили после отказа.
function nightWorkMouthDependency (r) {
  const seconds = r.seconds, hp = state.health, night = sit.night, fight = sit.fight
  const env = { ...r.view, hp, night, fight }
  const filler = (require('../src/build') as typeof import('../src/build')).FILLER
  const blocks = Object.entries(state.inventory || {}).reduce((n, [name, count]) =>
    n + (filler.includes(name) && !/^(sand|gravel)$/.test(name) ? Number(count) : 0), 0)
  const open = nightWorkSafety.price(env, seconds)
  const shut = { ...env, walls: 4, roof: true, sealed: false }
  const closed = r.corridor && blocks >= 2 ? r.closeSeconds + nightWorkSafety.price(shut, r.closeSeconds) : Infinity
  const stay = process.env.ND_NIGHT_STEP_MARGINAL === '1' && env.floor && r.standing?.floor
    ? nightWorkSafety.price({ ...r.standing, hp, night }, seconds) : 0
  const background = nightWorkSafety.price({ ...(closed < open ? shut : env), fight: null }, closed < open ? r.closeSeconds : seconds)
  const extra = Math.max(0, Math.min(open, closed) - Math.min(stay, background))
  const distance = Math.abs(r.target.x - r.from.x) + Math.abs(r.target.y - r.from.y) + Math.abs(r.target.z - r.from.z)
  // Новая возможность осветить проём и фактический местный свет допускают пробу.
  // Расход булыжника, еда, своя закладка и лечение без изменения допустимости — нет.
  return JSON.stringify([extra <= seconds, have('torch') > 0,
    Number(sit.work?.block) > distance, !sit.night && Number(sit.work?.sky) > distance + 7])
}
function nightWorkDependency (why, need, mouth = null) {
  if (process.env.ND_NIGHT_FAIL_KEY === '1' && mouth?.view && /NIGHT_RISK/.test(why)) return nightWorkMouthDependency(mouth)
  const materials = () => nightWorkItems(/^(torch|coal|charcoal|cobblestone|cobbled_deepslate|dirt|netherrack|stick)$|_log$|_planks$/)
  // ND_NIGHT_FAIL_KEY=1 (Codex D 21.10): ключ отказа без точных координат мобов — их дрейф снимал отказ, тот же шаг снова за 178 с.
  if (process.env.ND_NIGHT_FAIL_KEY !== '1') {
    if (/NIGHT_RISK|закрыться на месте|факел/.test(why)) return JSON.stringify([sit.work, state.health, state.food, nightWorkFoes, sit.fight?.order, materials()])
  // Положение далёкого моба не исправляет основание коробки и не добавляет опору для блока.
  } else if (/закрыться на месте/.test(why)) return JSON.stringify([sit.work, materials()])
  else if (/NIGHT_RISK|факел/.test(why)) {
    // Горизонты native tunnel/stairs: движение врага меняет решение, когда меняет допустимость работы,
    // а не при каждом новом subpixel dist/order. sealed убирает prior, оставляя видимый боевой риск.
    const combat = [2, 3.25].map(seconds => nightWorkSafety?.price({ ...sit.work, sealed: true,
      hp: state.health, night: sit.night, fight: sit.fight }, seconds) > seconds)
    return JSON.stringify([sit.work, state.health, state.food, combat, materials()])
  }
  if (/здоров|хп|NO_FOOD/.test(why)) return JSON.stringify([state.health, state.food, nightWorkItems(FOOD), nightWorkItems(RAW)])
  if (MOB_BLOCKED.test(why) || /CAST_UNSAFE|моб|враг|скелет|зомби|creeper|skeleton|zombie|spider/.test(why)) return nightWorkFoes
  if (/кирк|инструмент|нечем копать/.test(why)) return nightWorkItems(/_pickaxe$|_log$|_planks$|^stick$|^crafting_table$/)
  if (need?.what) return JSON.stringify([need.what, have(need.what)])
  return ''
}
function nightWorkBlocked (id, cause) {
  const f = nightWorkFailures.get(id)
  return !!f && f.cause === cause && f.dependency === nightWorkDependency(f.why, f.need, f.mouth) && !!state.pos &&
    (process.env.ND_NIGHT_FAIL_KEY === '1' && f.mouth
      ? ['x', 'y', 'z'].every(axis => Math.floor(state.pos[axis]) === f.mouth.from[axis])
      : Math.hypot(state.pos.x - f.at.x, state.pos.y - f.at.y, state.pos.z - f.at.z) < 8)
}
// M: all alternatives are priced to a portal, not to one cheap digging action.
const nightKitRoute = () => process.env.ND_NIGHT_KIT_ROUTE === '1' && nightWorkSafe &&
  !known.portal && have(/bucket$/) >= portalBuckets() && !!lighter()
const nightKitPoint = q => !!q && ['x', 'y', 'z'].every(k => Number.isFinite(q[k]))
const nightKitCastHere = () => !nightKitRoute() || nightKitPoint(known.lava) &&
  ((nightWorkLavaView !== '' && nightWorkLavaView !== '[]' && near3(known.lava, 12)) ||
    y() >= known.lava.y + 1 && near3(known.lava, 4))
function nightKitTravel (from, q) {
  if (!nightKitPoint(q)) return Infinity
  return Math.abs(q.y - 2 - from.y) * 3.25 +
    (Math.max(0, Math.abs(q.x - from.x) - 2) + Math.max(0, Math.abs(q.z - from.z) - 2)) * 2
}
function nightKitPrices () {
  const t = Number.isFinite(sit.tod) ? sit.tod : null
  // Unknown phase is charged as a whole night, never assumed to be dawn.
  const dawn = !sit.night && !sit.dusk ? 0 : t === null ? 600 : t < 23460 ? (23460 - t) / 20 : 0
  const death = (Number(process.env.ND_DEATH_COST_MIN) || 60) * 60
  // Exposed cast, not imaginary cover: castOne removes a low shelter roof.
  const cast = (q, eta) => 120 + ((q.y ?? 64) >= 0 ? Math.max(0, Math.min(120, dawn - eta)) * .07 / 60 * death : 0)
  // shortcut: search priors 60 s each are hypotheses; paired kit scenes must measure them.
  const deep = from => Math.max(0, from.y - DEEP_Y) * 3.25 + 60 + 120
  const lava = (from, elapsed = 0) => {
    const eta = nightKitCastHere() && from === state.pos ? 0 : nightKitTravel(from, known.lava) + 3 * 3.25
    return eta + (nightKitPoint(known.lava) ? cast(known.lava, elapsed + eta) : Infinity)
  }
  let water = Infinity
  if (nightKitPoint(knownWater)) {
    const eta = nightKitTravel(state.pos, knownWater) + 12
    const shore = { x: knownWater.x, y: knownWater.y - 2, z: knownWater.z }
    water = eta + Math.min(lava(shore, eta), deep(shore))
  }
  return { water, lava: lava(state.pos), deep: (have('water_bucket') ? 0 : 60) + deep(state.pos) }
}
async function nightKitPath (q, water = false) {
  const p = state.pos
  const dx = Math.floor(q.x) - Math.floor(p.x), dz = Math.floor(q.z) - Math.floor(p.z)
  // Stay beside the remembered fluid, not directly beneath it. Only the final lava view rises to the bank.
  const goalY = Math.floor(q.y) + (!water && Math.max(Math.abs(dx), Math.abs(dz)) <= 2 ? 1 : -2)
  const dy = goalY - Math.floor(p.y)
  const remaining = Math.max(Math.abs(dx), Math.abs(dz)) - 2
  const direction = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
  if (dy > 0) {
    const r = await act('tunnel', { direction: 'up', length: Math.min(8, dy), toY: goalY, timeoutSeconds: 90 })
    if (r.status === 'interrupted' || died || strategyInterrupted || remaining <= 0 ||
        !/вода|water/.test(String(r.detail?.stopped || ''))) return r
    log('ночной набор: над колонкой вода — сначала сухой штрек к кромке')
  }
  if (dy < -2) return act('dig_down', { mode: 'stairs', direction, depth: Math.min(8, -dy), maxFallHp: 0, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 90 })
  if (remaining <= 0) return { detail: { stopped: 'берег рядом, источник пока недоступен' } }
  return act('tunnel', { direction, length: Math.min(8, remaining), torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 90 })
}
// dawn (ND_OW_DAWN_DAY=1): днём подземный подход ночного набора (ND_NIGHT_KIT_ROUTE) не держит ночной режим — вода/литьё идут
// дневными этапами. D0-07 21.10: набор к 11 мин, затем 29 мин «ночной работы» (и весь день) — штрек 16 на север ↔ к воде 8+8 на юг.
function nightWorkHere (dawn = false) {
  const need = 3 * Math.max(0, portalBuckets() - have(/bucket$/)) + (lighter() ? 0 : 1)
  const raw = Math.max(0, need - have('iron_ingot'))
  // 300 тиков на доску, 200 на слиток; две доски оставляет существующий smeltAll.
  const planks = have(/^(?!crimson_|warped_).*_planks$/) + 4 * have(/^(?!(?:stripped_)?(?:crimson|warped)_).*_log$/) - (have('crafting_table') ? 0 : 4) - 2
  const heat = 8 * have(/^(coal|charcoal)$/) + 100 * have('lava_bucket') + Math.max(0, planks) * 1.5
  const carriedKit = process.env.ND_IRON_FINISH_HERE === '1' && !known.portal && need > 0 &&
    have('iron_ingot') + have('raw_iron') >= need && (lighter() || have('flint') || have('gravel')) &&
    (have('crafting_table') || have(/_planks$/) + 4 * have(LOGS) >= 4) &&
    (!raw || heat >= raw && (have('furnace') || have(COBBLE) >= 8))
  if (nightWorkEnabled && !sit.surface && nightKitRoute() && !(dawn && process.env.ND_OW_DAWN_DAY === '1')) {
    const price = nightKitPrices(), id = have('water_bucket') ? 'lava-path' : 'water'
    const q = have('water_bucket') ? known.lava : knownWater
    if (nightKitPoint(q) && price[have('water_bucket') ? 'lava' : 'water'] < price.deep &&
        !nightWorkBlocked(id, JSON.stringify(q))) return true
  }
  return nightWorkEnabled && !sit.surface && ((known.portal && READY.nether() && near3(known.portal, 12)) ||
    (!known.portal && have('water_bucket') && READY.cast() && near3(known.lava, 12) &&
      !nightWorkBlocked('cast', nightWorkCastCause())) || carriedKit)
}
async function nightWorkPath (q) {
  const dx = q.x - state.pos.x, dz = q.z - state.pos.z, dy = q.y + 1 - y()
  const direction = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
  if (dy < -2) return act('dig_down', { mode: 'stairs', direction, depth: Math.min(8, Math.ceil(-dy)), maxFallHp: 0, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 90 })
  if (dy > Math.max(2, Math.hypot(dx, dz))) return act('tunnel', { direction: 'up', length: Math.min(8, Math.ceil(dy)), timeoutSeconds: 90 })
  return act('tunnel', { direction, length: Math.min(8, Math.max(1, Math.ceil(Math.hypot(dx, dz) - 2))), torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 90 })
}
// A failed inlet keeps its approach cost when another job walks away and back.
// Only its observed target, side and height matter; cobble/HP drift changes no face.
const nightWaterRoutes = new Map<string, string>()
function nightWaterRouteKey () {
  if (!knownWater || !state.pos) return null
  const dx = state.pos.x - knownWater.x, dz = state.pos.z - knownWater.z
  const side = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
  return JSON.stringify([knownWater, side, Math.floor(state.pos.y)])
}
async function nightWorkWater () {
  if (process.env.ND_NIGHT_WATER_ROUTE_MEMORY !== '1') return nightWorkWaterBody()
  const key = nightWaterRouteKey(), blocked = key && nightWaterRoutes.get(key)
  if (blocked) {
    // A newly reachable source or acquired full bucket always wins over memory.
    const r = await act('bucket', { fluid: 'water', radius: 4, walk: false })
    if (r.status === 'interrupted' || died || strategyInterrupted || have('water_bucket')) return r
    return { status: 'done', detail: { stopped: blocked } }
  }
  const r = await nightWorkWaterBody()
  const why = String(r?.detail?.stopped || ''), learned = nightWaterRouteKey()
  if (learned && r?.status !== 'interrupted' && !died && !strategyInterrupted &&
      /нет видимой грани для затычки/.test(why)) nightWaterRoutes.set(learned, why)
  return r
}
async function nightWorkWaterBody () {
  const r = await act('bucket', { fluid: 'water', radius: 4, walk: false,
    ...(nightKitRoute() && nightKitPoint(knownWater) ? { nightKitWater: knownWater } : {}) })
  if (r.status === 'interrupted' || died || strategyInterrupted || have('water_bucket')) return r
  if (nightKitRoute() && nightKitPoint(knownWater)) {
    // A wall can be too far from the source while one more dry step remains useful.
    if (Math.max(Math.abs(knownWater.x - state.pos.x), Math.abs(knownWater.z - state.pos.z)) > 2 || !near3(knownWater, 4)) return nightKitPath(knownWater, true)
    return r // at the bank a refused intake needs a changed cause
  }
  if (knownWater && !near3(knownWater, 4)) return nightWorkPath(knownWater)
  if (OW_HEAR) {
    const h = await act('portal', { mode: 'cast', listen: 16, fluid: 'water', timeoutSeconds: 30 })
    if (h.status === 'interrupted' || died || strategyInterrupted) return h
    const sound = h.detail?.heard?.[0]
    if (sound) {
      const vertical = Math.abs(sound.height || 0) > (sound.flat || 0)
      return act('tunnel', { direction: vertical ? (sound.height > 0 ? 'up' : 'down') : sound.dir,
        length: Math.max(1, Math.min(8, vertical ? Math.abs(sound.height) : (sound.flat || 0) + 3)), torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 90 })
    }
  }
  return r
}
// Отказ «хп N и еды нет — сначала еда» (act) и смерть внутри ночной работы раньше вылетали из главного цикла — кампания
// падала («прогон упал», gr0/gr1-fp1-s14-2-kit 16.10, nw1-s16-1 C8). Здесь — как у шагов маршрута: еда, затем новый выбор.
async function nightWorkStep () {
  try { return await nightWorkStepInner() } catch (e) {
    if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e
    log(`ночная работа прервана: ${e.message}`)
    if (/сначала еда/.test(e.message) && !died) {
      try { await stageRun('food')() } catch (e2) { if (e2.stopCampaign || manualControl) throw e2; log(`еда ночью: ${e2.message}`) }
    }
    return { progress: false }
  }
}
async function nightWorkStepInner () {
  if (!nightWorkEnabled || died || dim() !== 'overworld' || !state.pos) return null
  if (sit.inWater) { await leaveWater(); return { progress: false } }
  const jobs = []
  const stationaryPrice = process.env.ND_OW_NIGHT_STATIONARY_PRICE === '1' && nightWorkSafe
  const stationary = /^(torches|eat|pick|craft|cook|smelt|flint)$/
  const observed = await intelligence.environment.observe()
  const add = (id, seconds, strategy, cause, run) => {
    const risk = strategy ? intelligence.registry.get(strategy).estimateRisk(observed) : 0
    const guarded = /^(down:|tunnel:|sound$|lava-path$|water$)/.test(id)
    const extra = nightWorkSafe && !guarded &&
      (!/^(cover|light|torches|eat|pick|craft|cook|smelt|flint)$/.test(id) || stationaryPrice && stationary.test(id))
      ? nightWorkSafety.price({ ...sit.work, hp: state.health, night: sit.night, fight: sit.fight }, seconds) : 0
    jobs.push({ id, seconds, extra, price: seconds + (nightWorkSafe ? extra : risk * (Number(process.env.ND_DEATH_COST_MIN) || 60) * 60), cause, run })
  }
  if (known.portal && READY.nether() && portalFar() < 96) add('enter', portalFar() / 2.5 + 10, null,
    () => JSON.stringify([known.portal, state.dimension]), () => enterNether())
  const castJob = () => add('cast', 120, 'LavaPoolPortal',
    nightWorkCastCause, async () => {
      // The caster opens visible windows, resumes its own frame and validates reachable sources.
      const r = await castForKit({ mode: 'cast', windows: true, maxDig: 64, keep: 8, radius: 12, timeoutSeconds: 540 })
      if (r.status !== 'interrupted' && !died && !strategyInterrupted) await readMemory()
      return r
    })
  if (!known.portal && have('water_bucket') && READY.cast() && near3(known.lava, 12) && nightKitCastHere() && (!sit.surface || lavaSourceKnown)) castJob()
  if (!sit.surface) {
    setStage('nightWork')
    const o = await act('observe', { radius: 32 })
    if (o.status === 'interrupted' || died || strategyInterrupted) return { progress: false }
    nightWorkFoes = JSON.stringify((o.detail?.entities || []).filter(e => CAVE_FOES.test(e.name)).map(e => [e.id, e.name, e.pos]).sort())
    const blocks = o.detail?.blocks || []
    nightWorkLavaView = JSON.stringify(blocks.filter(b => b.name === 'lava').map(b => [b.nearest, b.count]))
    const kit = have(/bucket$/) >= portalBuckets() && lighter()
    const ironNeed = !known.portal ? 3 * Math.max(0, portalBuckets() - have(/bucket$/)) + (lighter() ? 0 : 1)
      : (!have(PICK_IRON) ? 3 : 0) + (!shieldOn() ? 1 : 0)
    const fuel = () => nightWorkItems(/^(coal|charcoal|lava_bucket)$|_log$|_planks$|^stick$/)
    if (nightWorkSafe) {
      const w = sit.work || {}, dark = !(Number(w.block) > 0 || !sit.night && Number(w.sky) > 7)
      if (!w.sealed && (dark || sit.foes)) add('cover', w.coverSeconds || 3, null,
        () => JSON.stringify(w), () => act('shelter', { mode: 'box' }))
      if (dark && !have('torch') && have(/^(coal|charcoal)$/) >= 2) add('torches', 1.6, null,
        () => nightWorkItems(/^(coal|charcoal|stick|torch)$|_planks$|_log$/), () => torches())
      if (dark && have('torch')) add('light', .8, null, () => JSON.stringify(w) + have('torch'),
        () => act('shelter', { mode: 'light' }))
    }
    if ((state.food ?? 20) < 20 && (have(FOOD) || have(RAW))) add('eat', 1.6, null,
      () => JSON.stringify([state.food, nightWorkItems(FOOD), nightWorkItems(RAW)]), () => act('eat'))
    if ((state.health ?? 20) < 20 && (state.food ?? 20) >= 18) add('heal', 40, null,
      () => JSON.stringify([state.health, state.food]), () => nightWorkSafe ? act('wait', { seconds: 5 })
        : act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why: 'ночная работа: регенерация' }))
    if (have(RAW)) add('cook', 10 * have(RAW), null, () => nightWorkItems(RAW) + fuel() + have('furnace') + have(COBBLE),
      () => cook({ reserveHunger: netherFoodNeed() * 6 }))
    if (have('iron_ingot') < ironNeed && have('raw_iron')) add('smelt', 10 * Math.min(have('raw_iron'), ironNeed - have('iron_ingot')), null,
      () => JSON.stringify([ironNeed, have('raw_iron'), have('iron_ingot'), fuel(), have('furnace'), have(COBBLE)]),
      () => smeltAll('raw_iron', 'iron_ingot', { max: ironNeed - have('iron_ingot'), fetchCoal: false }))
    if ((!kit && (have('iron_ingot') >= 3 && have(/bucket$/) < portalBuckets() || !lighter() && have('flint') && have('iron_ingot'))) ||
        (known.portal && ironNeed && have('iron_ingot') >= ironNeed)) add('craft', 20, null,
      () => nightWorkItems(/^(iron_ingot|iron_nugget|iron_block|flint|stick|crafting_table|shield)$|bucket$|_pickaxe$|_log$|_planks$/), () => spendIron())
    if (!lighter() && !have('flint') && have('gravel')) add('flint', 20, null, () => String(have('gravel')),
      () => act('flint_grind', { max: 40, timeoutSeconds: 90 }))
    const wantOre = have('raw_iron') + have('iron_ingot') < ironNeed
    const wantCoal = have(/^(coal|charcoal)$/) < 2 && (wantOre || have('raw_iron') || have(RAW))
    const wantGravel = !lighter() && !have('flint') && !have('gravel')
    const ledger: any = await call('mine_seen', { limit: 40 })
    for (const p of ledger.detail?.spots || []) {
      if ((p.fromMe ?? Infinity) > 24 || !(wantOre && /^(deepslate_)?iron_ore$/.test(p.name) || wantCoal && /^(deepslate_)?coal_ore$/.test(p.name))) continue
      add(`ore:${p.name}:${JSON.stringify(p.at)}`, 10, 'MineIron', () => JSON.stringify(p.at),
        () => nightWorkSafe && !near3(p.at, 3) ? nightWorkPath(p.at) : act('mine_seen', { at: p.at, timeoutSeconds: 90 }))
    }
    const gravel = blocks.find(b => b.name === 'gravel' && b.nearest)
    if (wantGravel && gravel) add('gravel', 15, 'MineIron', () => JSON.stringify(gravel.nearest),
      () => nightWorkSafe && !near3(gravel.nearest, 3) ? nightWorkPath(gravel.nearest)
        : act('mine', { block: 'gravel', count: 4, radius: nightWorkSafe ? 4 : 24, dry: true, timeoutSeconds: 60 }))
    if (!known.portal && have('bucket') && !have('water_bucket')) add('water', 40, 'GetWater',
      () => JSON.stringify(knownWater), () => nightWorkSafe ? nightWorkWater() : kitWaterHere())
    if (!known.portal && kit && have('water_bucket')) {
      // Observe may have discovered lava since the job list was started.
      if (near3(known.lava, 12) && nightKitCastHere() && !jobs.some(j => j.id === 'cast')) castJob()
      else if (known.lava && (!near3(known.lava, 12) || !nightKitCastHere())) add('lava-path', lavaApproachSeconds(known.lava, lavaSourceKnown), 'LavaPoolPortal',
        () => JSON.stringify(known.lava), () => nightKitRoute() ? nightKitPath(known.lava)
          : nightWorkSafe ? nightWorkPath(known.lava) : approachCastLava())
    }
    const search = !known.portal && (!kit || !have('water_bucket') || !near3(known.lava, 12) || nightWorkBlocked('cast', nightWorkCastCause()) ||
      nightKitRoute() && (!nightKitCastHere() || nightKitPrices().lava > nightKitPrices().deep))
    if (search || known.portal && (wantOre || wantCoal || have(COBBLE) < 64)) {
      // Do not send an empty bucket to deep lava. First water/kit/iron, then the deep lava band.
      const goal = !known.portal && kit && have('water_bucket') ? DEEP_Y : Math.min(16, y())
      const purpose = !kit ? 'набор: железо/гравий' : !have('water_bucket') ? 'вода' : 'лава'
      if (OW_HEAR && kit && have('water_bucket') && !known.portal) {
        const h = await act('portal', { mode: 'cast', listen: 16, timeoutSeconds: 30 })
        if (h.status === 'interrupted' || died || strategyInterrupted) return { progress: false }
        const sound = h.detail?.heard?.[0]
        if (sound) {
          setHeardLava({ ...sound, from: { ...state.pos }, t: gameClock.now() })
          const vertical = Math.abs(sound.height || 0) > (sound.flat || 0)
          const direction = vertical ? (sound.height > 0 ? 'up' : 'down') : sound.dir
          const length = Math.max(1, Math.min(16, vertical ? Math.abs(sound.height) : (sound.flat || 0) + 3))
          add('sound', length * 2, 'ScoutLava', () => JSON.stringify(sound),
            () => act('tunnel', { direction, length, torchEvery: nightWorkSafe && have('torch') ? 8 : 0, timeoutSeconds: 90 }))
        }
      }
      for (const direction of ['north', 'east', 'south', 'west']) {
        const remaining = Math.max(0, y() - goal), depth = Math.min(12, Math.ceil(remaining))
        const searchPrice = remaining * 3.25 + (!kit ? structureValue.SECONDS.iron : 60)
        // shortcut: stairs 3.25 s/level (467 receipts A1-A5), horizontal leg ~2 s/block; verify on paired snapshots.
        if (depth) add(`down:${direction}`, searchPrice, 'MineIron', () => `${purpose}:${goal}`,
          () => act('dig_down', { mode: 'stairs', direction, depth, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 120 }))
        add(`tunnel:${direction}`, searchPrice + 16 * 2, 'MineIron', () => `${purpose}:${goal}`,
          () => act('tunnel', { direction, length: 16, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 120 }))
      }
    }
    if ((sit.pickLeft ?? 0) < 48) add('pick', 20, null,
      () => nightWorkItems(/_pickaxe$|_log$|_planks$|^stick$|^crafting_table$|^(cobblestone|cobbled_deepslate|iron_ingot)$/), () => spares(48))
  }
  if (nightKitRoute()) {
    const p = nightKitPrices()
    for (const job of jobs) {
      // Replace only the old ambient prior. Observed combat damage and a missing floor still cost their full price.
      if (job.id === 'cast') {
        job.extra = nightWorkSafety.price({ ...sit.work, sealed: true, hp: state.health, night: sit.night, fight: sit.fight }, 120)
        job.price = job.seconds + job.extra
      }
      const terminal = job.id === 'water' ? (nightKitPoint(knownWater) ? p.water : p.deep) : job.id === 'lava-path' || job.id === 'cast' ? p.lava
        : /^(down:|tunnel:|sound$)/.test(job.id) ? p.deep + (job.id.startsWith('tunnel:') ? 32 : 0) : null
      if (terminal !== null) job.price += terminal - job.seconds
    }
  }
  // S: buy a real closed entrance only when it pays for the next available stationary job.
  // A predicted enclosure prices the alternative; only fresh sense() after shelter grants sealed work.
  if (stationaryPrice && !sit.surface && !sit.work?.sealed && !jobs.some(j => j.id === 'cover')) {
    const view = { ...sit.work, hp: state.health, night: sit.night, fight: sit.fight }
    const work = jobs.filter(j => stationary.test(j.id) && !nightWorkBlocked(j.id, j.cause()))
    const close = Number(sit.work?.coverSeconds)
    const closing = close + nightWorkSafety.price(view, close)
    const open = Math.min(...work.map(j => j.price))
    const shut = Math.min(...work.map(j => j.seconds + nightWorkSafety.price({ ...view, sealed: true }, j.seconds)))
    if (Number.isFinite(close) && close >= 0 && closing + shut < open) add('cover', closing, null,
      () => JSON.stringify(sit.work), () => act('shelter', { mode: 'box' }))
  }
  const reasons = []
  const kitOnly = process.env.ND_IRON_FINISH_HERE === '1' && !sit.night && !known.portal && !READY.cast()
  // Уже подтверждённый отказ при тех же условиях: стоимость завершения этим шагом бесконечна.
  // Новая геометрия, свет, материалы, здоровье или боевой горизонт снова дают обычную цену.
  for (const job of jobs) if (nightWorkBlocked(job.id, job.cause())) {
    job.price = Infinity; job.refused = nightWorkFailures.get(job.id).why
  }
  for (const job of jobs.filter(j => !kitOnly || ['cover', 'light', 'torches', 'eat', 'smelt', 'craft', 'flint'].includes(j.id)).sort((a, b) => a.price - b.price)) {
    if (job.refused) { reasons.push(`${job.id}: ${job.refused}`); continue }
    if (nightWorkSafe && job.extra > job.seconds) { reasons.push(`${job.id}: NIGHT_RISK ${Math.round(job.extra)} с > выигрыш ${Math.round(job.seconds)} с`); continue }
    setStage('nightWork')
    const before = JSON.stringify([state.inventory, state.health, state.food, known.lava, known.portal, dim()]), at = { ...state.pos }
    const bagBefore = { ...(state.inventory || {}) }
    log(`ночная работа: ${job.id}, цена ≈ ${Math.round(job.price)} с`)
    let r
    try { r = await job.run() } catch (e) {
      if (e.stopCampaign) throw e
      if (e.strategyInterrupted || died) return { progress: false }
      r = { error: e.message }
    }
    if (r?.status === 'interrupted' || died || strategyInterrupted) return { progress: false }
    if (process.env.ND_NIGHT_WATER_ROUTE_MEMORY === '1' && job.id !== 'water' && (r?.detail?.dug || 0) > 0) nightWaterRoutes.clear()
    await refresh(); await sense()
    // ND_NIGHT_OWN_TUNNEL=1 (owC7-01): штрек/спуск, не вскрывший ни блока и не давший ни предмета, прошёл по своему же ходу —
    // это не работа; иначе north/south по одному 16-бл. штреку «двигали тело» всю ночь (10 игр. мин с 2 слитками из 4).
    // Отказ — в клетке старта: оттуда это направление пусто, из другой клетки оно снова по цене.
    const ownLeg = process.env.ND_NIGHT_OWN_TUNNEL === '1' && /^(tunnel:|down:)/.test(job.id) && Number(r?.detail?.dug) === 0 &&
      !Object.entries(state.inventory || {}).some(([k, v]) => Number(v) > (Number(bagBefore[k]) || 0))
    const progress = !ownLeg && (before !== JSON.stringify([state.inventory, state.health, state.food, known.lava, known.portal, dim()]) ||
      Math.hypot(at.x - state.pos.x, at.y - state.pos.y, at.z - state.pos.z) >= 1 || (r?.detail?.dug || 0) > 0)
    const why = String(r?.detail?.stopped || r?.error || (ownLeg ? 'свой ход: новых блоков 0' : !progress ? 'без прогресса' : ''))
    if (why) {
      nightWorkFailures.set(job.id, { at: ownLeg ? at : { ...state.pos }, cause: job.cause(), why, need: r?.detail?.need,
        mouth: r?.detail?.nightRefusal, dependency: nightWorkDependency(why, r?.detail?.need, r?.detail?.nightRefusal) })
      reasons.push(`${job.id}: ${why}`)
    } else nightWorkFailures.delete(job.id)
    if (progress) return { progress: true }
    if (sit.surface) {
      if (process.env.ND_OW_NIGHT_RELOCATE_REACH === '1') break
      return null
    }
  }
  if (kitOnly) return { progress: false }
  // L: the surface relocation below was unreachable after this unconditional return.
  if (sit.surface && process.env.ND_OW_NIGHT_RELOCATE_REACH !== '1') return null
  setStage('nightWork')
  const why = `ночь: нет доступной работы — ${reasons.join('; ') || (known.portal ? 'портал есть, нужны еда/путь; местная подготовка закончена' : 'нет инструмента или доступных целей')}`
  log(why)
  // ND_NIGHT_RELOCATE=1: все работы отказали здесь (берег — вниз нельзя, вода; шаг из коробки — NIGHT_RISK) — ожидание до рассвета
  // стоит его секунды; отход на сухое место в 16–24 бл. стоит риска пути по ночной цене. Дороже ждать — иду (owK6-base21b-s4: 145
  // отказов «стен 0/4» на берегу за ночь). Своё место не повторяю: после отхода — новые работы на новом месте.
  if (process.env.ND_NIGHT_RELOCATE === '1' && nightWorkSafe && sit.surface && (sit.night || sit.dusk) && !died && have(/_pickaxe$/) && state.pos) {
    const t = Number.isFinite(sit.tod) ? sit.tod : null
    const toDawn = t !== null && t >= 11840 && t < 23460 ? (23460 - t) / 20 : 0
    const walkS = 12, cost = walkS + nightWorkSafety.price({ ...sit.work, walls: 0, roof: false, sealed: false, hp: state.health, night: true, fight: sit.fight }, walkS)
    const key = `${Math.round(state.pos.x / 8)},${Math.round(state.pos.z / 8)}`
    if (toDawn > cost && !nightRelocated.has(key)) {
      nightRelocated.add(key)
      log(`ночь: работы здесь нет, до рассвета ${Math.round(toDawn)} с ждать дороже отхода ≈ ${Math.round(cost)} с — ухожу на сухое место`)
      const from = { ...state.pos }
      await awayFromWater(20)
      await refresh(); await sense()
      if (state.pos && Math.hypot(state.pos.x - from.x, state.pos.z - from.z) >= 6) return { progress: true }
    }
  }
  if (sit.surface) return null
  if (!nightWorkSafe) await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why })
  if (!died) await act('wait', { seconds: 5 }) // observation polling, never re-admits a refused job
  return { progress: false }
}

export { nightWorkEnabled, nightWorkHere, nightWorkStep }
