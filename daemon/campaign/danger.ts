'use strict'
// Угрозы: аварийный отход автопилота, ответ на угрозу, бой или уход, вода и мобы на пути.
import { call, sleep } from './rpc'
import { state, sit, refugeSeenAt, lastRefuge, died, fighting, dangerZone, setDangerZone, setFighting, setLastRefuge,
  setRefugeSeenAt, strategyInterrupted } from './state'
import { log } from './log'
import { have, y, dim, RAW, FOOD } from './queries'
import { acceptResult, sense, nearWalkers } from './observe'
import { act } from './act'
import { closedShelter } from './guards'
import { walkAway, awayFrom } from './travel'
import { eatTo, ensurePick } from './kit'
import { toSurface } from './underground'
import * as gameClock from '../src/game-clock'
const refugeRunning = () => state.busy === 'refuge' || refugeSeenAt > 0
async function awaitRefuge (why = '') {
  log(`идёт аварийный отход автопилота${why ? ` (${why})` : ''} — жду его конца, своё не зову`)
  for (let i = 0; i < 1200 && !died; i++) {
    if (state.busy !== 'refuge' && !(refugeSeenAt && i < 4)) break
    await sleep(500)
    try { acceptResult(await call('status')) } catch { break }
  }
  setRefugeSeenAt(0)
  const e = lastRefuge
  setLastRefuge(null)
  log(`отход кончился${e ? `: ${e.how || '?'}${e.code ? ' ' + e.code : ''}, хп ${e.hp0 ?? '?'} → ${e.hp ?? '?'}${e.healed ? ' (вылечился)' : ''}, ${e.seconds ?? '?'} с` : ''}; хп ${Math.round(state.health ?? 0)}`)
  return e
}
async function afterRefuge () {
  if (died) return
  await sense()
  if (!sit.foes || died) return
  const was = fighting
  setFighting(true)
  try {
    const first = (sit.fight && sit.fight.first) || {}
    if (process.env.ND_CREEPER_DODGE !== '0' && ((sit.fight && sit.fight.order) || []).some(o => o && o.name === 'creeper' && o.dist <= 8)) {
      log('после отхода рядом крипер — в коробку и пересидеть, а не бегом к той же работе')
      await act('refuge', { minHp: 20, maxSeconds: 60, why: 'крипер рядом после уклона' })
      return
    }
    const noFight = first.name === 'drowned' || ((sit.fight && sit.fight.order) || []).some(o => o && o.name === 'drowned' && o.dist <= 10)
    if (sit.foes <= 2 && sit.armed && !sit.inWater && !first.swelling && !noFight && (state.health ?? 0) >= 10 && sit.verdict !== 'уходить') {
      log(`после отхода рядом ${sit.foes} — дерусь`)
      await fightOrLeave({ timeoutSeconds: 30, retreatAtHealth: 7 })
    } else {
      log(`после отхода рядом ${sit.foes} — не дерусь, ухожу`)
      if (!sit.surface && process.env.ND_CROWD_REFUGE !== '0' && await boxAndDown(`после отхода рядом ${sit.foes} — коробка и вниз`)) return
      await act('flee', { timeoutSeconds: 20 })
    }
  } finally { setFighting(was) }
}
async function refugeRun (why, { minHp = 16, maxSeconds = 120, untilDawn = false, force = false } = {}) {
  if ((state.health ?? 0) >= minHp && !sit.foes && !force) return null
  const was = fighting
  setFighting(true)
  let r
  try { r = await act('refuge', { minHp, maxSeconds, why, ...(untilDawn ? { untilDawn: true } : {}) }) } finally { setFighting(was) }
  const d = (r && r.detail) || {}
  if (d.how) log(`отход: ${d.note || d.how}${d.code && d.code !== 'OK' ? ` [${d.code}]` : ''}`)
  if (await tunnelAway(d.code)) return r
  await afterRefuge()
  return r
}

let boxingDown = false
async function boxAndDown (why) {
  if (boxingDown || died) return false
  boxingDown = true
  const was = fighting
  setFighting(true)
  try {
    const r = await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why })
    if (died || !(r && r.detail && r.detail.stayed)) return false
    if (!have(/_pickaxe$/)) await ensurePick()
    const h = await act('shelter', { mode: 'enter', depth: 3 })
    if (died) return true
    if (closedShelter(h)) { log('коробка → нора из неё: дальше работаю снизу'); return true }
    log('из коробки вниз не вышло')
    return false
  } finally { setFighting(was); boxingDown = false }
}

let tunnelingAway = false
async function tunnelAway (code) {
  if (process.env.ND_CROWD_REFUGE === '0' || code !== 'NO_FOOD' || died || tunnelingAway) return false
  tunnelingAway = true
  try { return await tunnelAwayBody() } finally { tunnelingAway = false }
}
async function tunnelAwayBody () {
  await sense()
  if (sit.surface || dim() !== 'overworld' || sit.inWater || (!sit.foes && (await nearWalkers(12)) < 1)) return false
  log('под землёй, лечиться нечем, враги рядом — штрек прочь в породу')
  for (const dir of ['north', 'east', 'south', 'west']) {
    const t = await act('tunnel', { direction: dir, length: 10, torchEvery: 0, timeoutSeconds: 60 })
    if (died) return true
    if (((t.detail && t.detail.walked) || 0) >= 5) return true
  }
  return false
}

const ENV_DAMAGE = new Set(['starve', 'fall', 'in_wall', 'on_fire', 'in_fire', 'lava', 'hot_floor', 'campfire', 'drown', 'dry_out',
  'freeze', 'cactus', 'sweet_berry_bush', 'cramming', 'fly_into_wall', 'stalagmite', 'falling_block', 'falling_anvil',
  'falling_stalactite', 'out_of_world', 'outside_border', 'generic', 'generic_kill', 'lightning_bolt', 'ender_pearl', 'magic',
  'wither', 'dragon_breath', 'bad_respawn_point'])
function hurtCause (r) {
  const evs = [...(r.by && r.by.type === 'damage' ? [r.by] : []), ...(r.events || []).filter(e => e.type === 'damage')]
  const causes = evs.map(e => e.cause || 'unknown')
  return causes.find(c => !ENV_DAMAGE.has(c)) || causes[0] || 'unknown'
}
function hurtSource (r) {
  const evs = [...(r.by && r.by.type === 'damage' ? [r.by] : []), ...(r.events || []).filter(e => e.type === 'damage')]
  return (evs.reverse().find(e => e.source) || {}).source || null
}

function inlandWaterOrigin (o, at) {
  if (!at || o.detail?.fair !== true) return null
  const wet = (Array.isArray(o.detail?.blocks) ? o.detail.blocks : []).find(b => b?.name === 'water' && !b.remembered)
  const points = (Array.isArray(wet?.seen) && wet.seen.length ? wet.seen : [wet?.nearest])
    .filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.z))
  if (!points.length) return null
  const origin = { x: points.reduce((n, p) => n + p.x, 0) / points.length,
    z: points.reduce((n, p) => n + p.z, 0) / points.length }
  // A symmetric pool does not identify a landward direction. Do not invent one.
  return Math.hypot(origin.x - at.x, origin.z - at.z) >= 0.5 ? origin : null
}
async function awayFromWater (dist = 20, visibleOnly = false) {
  const shore = process.env.ND_DIG_PLUG_WATER === '1' && process.env.ND_DIG_PLUG_WATER_SHORE !== '0'
  if (shore) {
    await sense()
    if (died || strategyInterrupted) return null
    if (!sit.surface && dim() === 'overworld' && !(await toSurface(2))) return null
    if (died || strategyInterrupted) return null
  }
  const o = await act('observe', { radius: 16, ...(shore ? { fair: true } : {}) })
  const wet = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'water')
  if (died || (shore && strategyInterrupted)) return
  const origin = shore ? inlandWaterOrigin(o, state.pos) : wet?.nearest || null
  if (visibleOnly && !origin) return null
  try { return await awayFrom(origin, dist) } catch (e) { log(`от воды не ушёл: ${e.message}`); return null }
}
function markDanger (why) {
  if (state.pos) setDangerZone({ x: state.pos.x, z: state.pos.z, until: gameClock.now() + 300000, why })
}
function awayFromDanger () {
  if (!dangerZone || gameClock.now() >= dangerZone.until || !state.pos) return null
  const dx = state.pos.x - dangerZone.x, dz = state.pos.z - dangerZone.z
  if (Math.hypot(dx, dz) > 64) return null
  if (Math.abs(dx) < 1 && Math.abs(dz) < 1) return null
  return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
}
async function answerThreat (cause = 'unknown', source = null) {
  await sense()
  if (process.env.ND_OW_ENV_RESCUE === '1' && dim() === 'overworld' && cause === 'freeze') {
    // LivingEntity.aiStep (1.21.11): fully frozen loses 1 HP per 40 ticks.
    // Pay for breaking the visible snow before a long wait; leave one pulse in reserve.
    const seconds = Math.max(0.1, Math.min(6, ((state.health ?? 20) - 1) * 2))
    log(`замерзаю: вместо ожидания убираю видимый рыхлый снег, бюджет ${seconds} с`)
    const was = fighting
    setFighting(true)
    try { await act('mine', { block: 'powder_snow', count: 2, radius: 3, fair: true, collect: false, timeoutSeconds: seconds }) }
    finally { setFighting(was) }
    return
  }
  if (process.env.ND_OW_DEATH_WATER === '1' && dim() === 'overworld' && sit.inWater && (cause === 'drown' || sit.buried)) { await leaveWater(); return }
  if (sit.buried || cause === 'in_wall' && process.env.ND_OW_BURIAL_STEP === '1' && dim() === 'overworld') { await waitDugOut(); return }
  if (sit.inLava || sit.onFire) {
    await act('escape_fire')
    await sense()
    if (sit.inLava) await act('escape_fire')
    return
  }
  if (ENV_DAMAGE.has(cause)) {
    if (cause === 'starve') {
      if (have(FOOD) || have(RAW)) await act('eat')
      else log('урон от голода, еды нет — нора не лечит, нужна еда')
      return
    }
    if (cause === 'drown' && sit.inWater) { await act('surface', { targetY: y() + 2, timeoutSeconds: 20, preferPillar: false }); return }
    // Магма под ногами жжёт каждые полсекунды; под водой над ней столб пузырей тянет вниз (cl-w 14.10: «floor was lava», хп 17 → 0,
    // а этап звал штрек, руду и гравий): сойти с неё — из воды на берег, на суше — отбежать.
    if (cause === 'hot_floor') {
      if (sit.inWater) await leaveWater()
      else await act('flee', { timeoutSeconds: 6 })
      return
    }
    log(`урон «${cause}» — не нападение, нору не копаю`)
    return
  }
  const first = (sit.fight && sit.fight.first) || sit.first || {}
  const drowned = source === 'drowned' || first.name === 'drowned'
  if (drowned) markDanger('утопленник')
  if (drowned && sit.inWater) {
    log('бьёт утопленник, я в воде — в воде не дерусь, на сушу')
    if (!(await leaveWater()) && !died) await refugeRun('утопленник, я в воде')
    return
  }
  if (drowned && !sit.foes && await waterNear(6)) {
    log('бьёт невидимый утопленник у воды — ухожу на сушу подальше от воды')
    await awayFromWater(24)
    return
  }
  if (process.env.ND_REFUGE_SHORE !== '0' && drowned && !sit.inWater) {
    log('утопленник рядом, я на суше — не дерусь, ухожу от воды')
    if ((state.health ?? 20) < 12) await refugeRun('утопленник, хп мало')
    else await awayFromWater(24)
    return
  }
  if (!sit.foes) {
    if (sit.inWater || dim() === 'the_end') return
    if ((state.health ?? 20) < 16) await refugeRun(`бьёт невидимый (${cause}${source ? ' ' + source : ''})`)
    else log(`бьёт невидимый (${cause}${source ? ' ' + source : ''}), хп ${Math.round(state.health ?? 0)} — дальше дело`)
    return
  }
  if (first.swelling) { await act('flee', { timeoutSeconds: 15 }); return }
  if (process.env.ND_CROWD_REFUGE !== '0') {
    const seen = ((sit.fight && sit.fight.order) || []).filter(f => f && f.dist <= 10 && !f.ranged).length
    const walkers = sit.surface ? seen : Math.max(seen, await nearWalkers(10))
    if (walkers >= 3) {
      if (!sit.surface && await boxAndDown(`толпа: ${walkers} ходячих ближе 10 бл. — коробка и вниз из неё`)) return
      await refugeRun(`толпа: ${walkers} ходячих ближе 10 бл.`, { minHp: 20 }); return
    }
  }
  // Иссушитель/брут в Аду — не открытый бой: удар 9 (брут) / 4.8 + иссушение, наш меч 6 — проигрыш с 11 хп (s1c-F-2 06.10:
  // «fight» с иссушителем на 11 хп — смерть). В толщу: в замкнутой норе его рамка удара (раздута только вширь) не достаёт.
  // S1e (проверка S1d (в)): не «брут — всегда в толщу», а цена: ожидаемый урон боя (assess.plan: его удар после нашей брони × время
  // убийства; брут 13 = 7 + золотой топор, javap S4d; иссушитель + иссушение ~4) против запаса хп 6. Полный брут в железе — ~19 урона
  // (s1d-G22-5: LastStand с 20 хп — смерть) → в толщу; добитый брут или иссушитель на полном хп — бой.
  const expectDmg = (Number.isFinite(sit.fight?.expectedDamage) ? sit.fight.expectedDamage : first.name === 'piglin_brute' ? 19 : 8) + (first.name === 'wither_skeleton' ? 4 : 0)
  if (dim() === 'the_nether' && /^(wither_skeleton|piglin_brute)$/.test(String(first.name || '')) && expectDmg >= (state.health ?? 20) - 6 && !died) {
    log(`${first.name} в Аду, хп ${Math.round(state.health ?? 0)}, ожидаю ~${Math.round(expectDmg)} урона в бою — в толщу, не открытый бой`)
    await act('ne_burrow', { why: `${first.name}: в толщу` })
    return
  }
  const shield = have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || ''))
  if (first.ranged && shield && sit.armed && (state.health ?? 20) >= 5) {
    const f = await fightOrLeave({ timeoutSeconds: 45, retreatAtHealth: 4, shield: 'always' })
    return f
  }
  if (sit.armed && (state.health ?? 20) >= 10 && sit.verdict !== 'уходить') {
    const f = await fightOrLeave({ timeoutSeconds: 45, retreatAtHealth: 7 })
    if (f && f.detail && (f.detail.kills || f.detail.killed)) log(`отбился: ${JSON.stringify(f.detail.kills || f.detail.killed)}`)
    if (process.env.ND_CROWD_REFUGE !== '0' && !died) {
      const chain = process.env.ND_CROWD_CHAIN !== '0' ? 3 : 1
      for (let k = 0; k < chain && !died; k++) {
        await sense()
        const left = ((sit.fight && sit.fight.order) || []).filter(o => o && o.dist <= (chain > 1 ? 12 : 10))
        const hidden = sit.surface ? 0 : await nearWalkers(10)
        const hp = state.health ?? 20
        if (!left.length) {
          if (hidden >= 2 || (hidden >= 1 && hp < 16)) await refugeRun(`после боя рядом ещё ${hidden} (из-за угла)`, { minHp: 20 })
          break
        }
        const walk = Math.max(left.filter(o => !o.ranged).length, hidden)
        if (walk >= 2 || (walk >= 1 && left.length >= 2 && hp < 16)) { await refugeRun(`после боя рядом ещё ${left.length}`, { minHp: 20 }); break }
        if (chain === 1) break
        if (sit.armed && hp >= 12 && !left.some(o => o.name === 'drowned' || o.swelling)) {
          log(`после боя рядом ещё ${left[0].name} — и его`)
          const f2 = await fightOrLeave({ timeoutSeconds: 30, retreatAtHealth: 7 })
          if (!(f2 && f2.detail && (f2.detail.kills || f2.detail.killed))) break
        } else { await refugeRun(`после боя рядом ${left[0].name}, хп ${Math.round(hp)}`, { minHp: 20 }); break }
      }
    }
    return
  }
  if ((state.health ?? 20) < 16) { await refugeRun(`враги ${sit.foes}, хп ${Math.round(state.health ?? 0)}`); return }
  if (process.env.ND_CROWD_REFUGE !== '0' && sit.verdict === 'уходить') { await refugeRun(`враги ${sit.foes} не по силам`, { minHp: 20 }); return }
  const f = await act('flee', { timeoutSeconds: 40 })
  if (f.detail && f.detail.cornered && sit.armed) await act('fight', { timeoutSeconds: 40, retreatAtHealth: 4 })
}

const FIGHT_REFUSED = /размена|сытость не позволяет|запаса еды|нечем восстановить|не переживу|опасность под ногами|бросил бой/
async function fightOrLeave (params) {
  if ((state.food ?? 20) < 18 && have(FOOD)) {
    if ((state.health ?? 20) < 8) { await refugeRun(`сытость ${state.food ?? '?'} — бой не примут, хп ${Math.round(state.health ?? 0)}`); return null }
    await eatTo(18)
  }
  if (died) return null
  const f = await act('fight', params)
  const d = (f && f.detail) || {}
  const refused = f && f.status === 'done' && !(d.swings > 0) && !(d.kills && d.kills.length) && FIGHT_REFUSED.test(String(d.stopped || ''))
  if (!refused || died) return f
  log(`бой не принят (${String(d.stopped).slice(0, 60)}) — ухожу, а не стою`)
  if ((state.health ?? 20) < 16) await refugeRun('бой не принят')
  else await act('flee', { timeoutSeconds: 20 })
  return f
}

async function leaveWater () {
  await sense()
  if (!sit.inWater) return true
  const was = fighting
  setFighting(true)
  try {
    if (process.env.ND_REFUGE_SHORE !== '0') await act('refuge', { shore: true, minHp: 16, maxSeconds: 25, why: 'из воды на берег' })
    else await act('surface', { targetY: y() + 2, timeoutSeconds: 20, preferPillar: false })
    await sense()
    // ND_OW_WATER_UP=1: под землёй в затопленной пещере берега нет, а отход поверху (walkAway — goto strict) там бессмыслен: столб вверх
    // своими блоками из воды (owE2-04: y11, 3 мин «берег: в воде» и goto strict по кругу — утонул; owE1-04: 35 мин в водяной яме).
    if (process.env.ND_OW_WATER_UP === '1' && sit.inWater && !sit.surface && !died && dim() === 'overworld') {
      await act('tunnel', { direction: 'up', length: 3, timeoutSeconds: 20 })
      await sense()
    }
    for (let k = 0; k < 2 && sit.inWater && !died && state.pos && (process.env.ND_OW_WATER_UP !== '1' || sit.surface); k++) {
      await walkAway(12, k ? 1.2 : 0)
      await sense()
    }
  } finally { setFighting(was) }
  return !sit.inWater
}

async function waterNear (r = 6) {
  const o = await act('observe', { radius: Math.max(r, 8) })
  return (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).some(b => b && b.name === 'water' && (b.dist ?? 99) <= r)
}

async function waitDugOut () {
  if (process.env.ND_OW_DEATH_WATER === '1' && dim() === 'overworld' && sit.inWater && !died) { await leaveWater(); return }
  if (process.env.ND_OW_BURIAL_STEP === '1' && dim() === 'overworld') {
    log('in_wall — сразу освобождаюсь: видимая копка или физический шаг')
    const was = fighting
    setFighting(true)
    try { await act('unstuck', { cause: 'in_wall' }); await sense() } finally { setFighting(was) }
    return
  }
  log('завалило — не копаю, жду, пока автопилот откопает')
  const was = fighting
  setFighting(true)
  try {
    for (let i = 0; i < 8 && !died; i++) {
      await act('wait', { seconds: 2 })
      await sense()
      if (!sit.buried) return
      if (process.env.ND_OW_DEATH_WATER === '1' && dim() === 'overworld' && sit.inWater) { await leaveWater(); return }
    }
  } finally { setFighting(was) }
}

// Навык отказал из-за моба рядом: штрек («дойдёт до меня»), литьё (CAST_UNSAFE), подъём («видит меня — спиной не полезу»).
const MOB_BLOCKED = /дойдёт до меня|блоках (впереди|позади|снизу|сверху)|бл. (снизу|сверху)|бл. на моём уровне, вплотную|CAST_UNSAFE|видит меня — спиной/
async function mobInTheWay (r) {
  const why = String((r && r.detail && r.detail.stopped) || '')
  if (died || !MOB_BLOCKED.test(why)) return false
  if (r.mobAnswered) return true
  r.mobAnswered = true
  log(`моб мешает работе — отвечаю: ${why.slice(0, 80)}`)
  setFighting(true)
  try {
    await answerThreat()
    if (process.env.ND_CROWD_REFUGE !== '0' && !died && !sit.foes) await act('wait', { seconds: 3 })
  } finally { setFighting(false) }
  return true
}

const CAVE_FOES = /^(zombie|husk|drowned|skeleton|stray|creeper|spider|cave_spider|enderman|witch|zombie_villager|slime|silverfish|bogged)$/
function cavesFoes (o) {
  const ents = (o && o.detail && Array.isArray(o.detail.entities)) ? o.detail.entities : []
  const f = ents.filter(e => CAVE_FOES.test(String(e.name || '').toLowerCase()) && (e.dist ?? 99) <= 24)
  return f.length ? f.map(e => e.name).slice(0, 4).join(', ') : ''
}

export { refugeRunning, awaitRefuge, afterRefuge, refugeRun, tunnelAway, hurtCause, hurtSource, awayFromWater, inlandWaterOrigin,
  awayFromDanger, answerThreat, leaveWater, waitDugOut, MOB_BLOCKED, mobInTheWay, CAVE_FOES, cavesFoes }
