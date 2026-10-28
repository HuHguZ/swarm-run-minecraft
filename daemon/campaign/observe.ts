'use strict'
// Наблюдение: ответы RPC в состояние (acceptResult), refresh/sense/readMemory, память лавы и бастионов.
import { E2E } from './flags'
import { call } from './rpc'
import { strategyExecuting, tacticalRevision, state, sit, known, heardLava, setDied, setLastRefuge, setLostAt,
  setLostBag, setMemorySnapshot, setRefugeSeenAt, setSit, setState, setStrategyInterrupted, setTacticalRevision } from './state'
import { seamSnapshot, log } from './log'
import * as gameClock from '../src/game-clock'
let lastDeathSeen
let goldSeenLogged = false
function acceptResult (r) {
  const event = r.by?.type === 'death' ? r.by : (r.events || []).find(e => e.type === 'death')
  const stamp = r.state?.lastDeathAt
  const changed = stamp && lastDeathSeen !== undefined && stamp !== lastDeathSeen
  if (event || changed) {
    setLostBag(state.inventory || {})
    setLostAt(event?.pos || state.pos || null)
    setDied(true)
  }
  if (stamp !== undefined) lastDeathSeen = stamp
  if (r.state) {
    const revision = r.state.replanRevision ?? r.state.tactics?.replanRevision ?? tacticalRevision
    if (strategyExecuting && revision !== tacticalRevision) setStrategyInterrupted(true)
    setTacticalRevision(revision)
    setState(r.state)
    // Телеметрия (bast2 27.10, поведение не меняет): первая золотая броня на теле — минута в журнал (доля и минута ботинок в сериях).
    if (!goldSeenLogged && /golden_(helmet|chestplate|leggings|boots)/.test(JSON.stringify(r.state.armor || {}))) {
      goldSeenLogged = true
      log(`ВЕХА золото на теле: ${JSON.stringify(r.state.armor)} (${r.state.dimension || '?'})`)
    }
  }
  if (strategyExecuting && (r.status === 'interrupted' || [...(r.by ? [r.by] : []), ...(r.events || [])].some(e => /^(tactical|tactical_released|emergency)$/.test(e.type)))) setStrategyInterrupted(true)
  if (E2E && (event || changed)) {
    seamSnapshot('death')
    throw Object.assign(new Error('E2E_DEATH: смерть = провал сквозного прогона'), { stopCampaign: true, code: 'E2E_DEATH' })
  }
  for (const e of [...(r.by ? [r.by] : []), ...(r.events || [])]) {
    if (e && e.type === 'emergency') setRefugeSeenAt(gameClock.now())
    if (e && e.type === 'refuge') { setLastRefuge(e); setRefugeSeenAt(0) }
  }
}

async function sense () {
  try {
    const r: any = await call('situation')
    acceptResult(r)
    if (r.detail) setSit(r.detail)
  } catch (e) { log(`situation RPC-ОШИБКА ${e.message}`) }
  return sit
}

async function nearWalkers (r = 10) {
  try {
    const p: any = await call('peek')
    return ((p && p.detail && p.detail.foes) || []).filter(f => f && f.d <= r && Math.abs(f.dy || 0) <= 4 &&
      !/^(skeleton|stray|bogged|parched|pillager|witch|blaze|ghast|creeper|enderman|zombified_piglin|piglin)$/.test(f.name)).length
  } catch { return 0 }
}

async function refresh () {
  const r = await call('status')
  acceptResult(r)
  return state
}
async function readMemory () {
  try {
    const r: any = await call('recall', { lines: 1 })
    const memory = (r.detail && r.detail.state) || {}
    setMemorySnapshot({ updatedAt: memory.updatedAt || null, places: memory.places || {}, deaths: (memory.deaths || []).length })
    const places = { ...(memory.places || {}) }
    if (process.env.ND_EXTRA_PLACES) { try { Object.assign(places, JSON.parse(process.env.ND_EXTRA_PLACES)) } catch {} }
    known.portal = places['портал'] || null
    known.netherPortal = places['портал (ад)'] || null
    known.fortress = places['крепость (ад)'] || known.fortress
    known.bastion = places['бастион (ад)'] || known.bastion
    known.bastions = BASTION_KEYS.filter(k => places[k]).map(k => ({ key: k, ...places[k] }))
    for (const b of known.bastions) {
      const checkpoint = places[`выработан: ${b.key}`]
      if (checkpoint?.dimension === 'the_nether' && !/два сухих захода/.test(checkpoint.note || '') && (b.dimension || 'the_nether') === 'the_nether' &&
        Math.hypot(checkpoint.x - b.x, checkpoint.z - b.z) <= 100) bState(b).spent = true
    }
    known.stronghold = places['крепость'] || known.stronghold
    known.endPortal = places['портал в Край'] || known.endPortal
    known.spawnBed = places['точка возрождения'] || null
    // Озеро, у которого рама не встала (lavaBadSites), память не возвращает: g1-4 14.10 — «4 отказа — ищу другое озеро» и
    // через минуту то же место из памяти, 14 заходов за 100 мин.
    const lava = lavaMemoryPlace(places['лава'])
    if (!known.lava && lava && (lava.dimension || 'overworld') === 'overworld' && !lavaBad(lava)) known.lava = lava
  } catch {}
}
function lavaMemoryPlace (place) {
  if (!place || process.env.ND_OW_KIT_LAVA === '0') return place
  // remember records the observer's feet; the campaign's own note records the seen source.
  const at = /^лава на (-?\d+),(-?\d+),(-?\d+)$/.exec(String(place.note || ''))
  return at ? { ...place, x: +at[1], y: +at[2], z: +at[3] } : place
}
const lavaBadSites = []
const lavaBad = q => lavaBadSites.some(b => Math.hypot(b.x - q.x, b.z - q.z) < 24)
// S8d: до берега по горизонтали — лучи глаз (perceive surface) вниз-вбок по 8 сторонам: первая непрозрачная клетка, к которой
// луч шёл не сквозь воду, — суша. Нет такой в 24 бл. — 20.
async function shoreDistance () {
  let best = 20
  for (let yaw = 0; yaw < 360; yaw += 45) {
    try {
      const r: any = await call('perceive', { mode: 'surface', yaw, pitch: 35, maxDist: 24 })
      acceptResult(r)
      const s = r && r.detail && r.detail.surface
      // Берег — пол не выше ног (на него выйти), а не стенка ямы на уровне головы (s8d-a-v1-1: в своей лесенке с водой стенки в
      // 1 бл. считались берегом — «выйти 2 с», копка запрещалась, тело утонуло).
      const feetY = state.pos ? Math.floor(state.pos.y) : 0
      if (s && !s.water && s.pos && s.pos.y <= feetY && !/water|ice|kelp|seagrass/.test(String(s.name))) best = Math.min(best, Math.round(s.dist * Math.cos(35 * Math.PI / 180)))
    } catch {}
  }
  return best
}
// S8d (замечание проверки S8c «а», аудит S10 №13): «лава у/на x,y,z» в строке стопа колодца/лесенки/штрека — чутьё безопасности
// (hazardAt смотрит сквозь камень и может только ОТКАЗАТЬ копать). Целью литья и known.lava такая клетка становится, только если
// лаву видно (память глаз: увиденная клетка лавы в 3 бл.) или слышно (heardLava: место слуха не дальше услышанной дальности + 6).
// На уровне знания scan и при ND_HONEST_LAVA=0 — как было (клетка из строки).
async function stopLava (r) {
  const m = /лава (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String((r && r.detail && r.detail.stopped) || ''))
  if (!m) return null
  const q = { x: +m[1], y: +m[2], z: +m[3] }
  let level = 'rsg'
  try { level = (require('../src/perception/knowledge') as typeof import('../src/perception/knowledge')).level() } catch {}
  if (process.env.ND_HONEST_LAVA === '0' || level === 'scan') return q
  try {
    const s: any = await call('perceive', { mode: 'seen', block: 'lava', max: 1, maxDist: 3, from: q })
    acceptResult(s)
    const c = s && s.detail && Array.isArray(s.detail.seen) && s.detail.seen[0]
    if (c) return { x: c.x, y: c.y, z: c.z }
  } catch {}
  const H = heardLava
  if (H && H.from && gameClock.now() - H.t < 5 * 60000 && Math.hypot(H.from.x - q.x, H.from.y - q.y, H.from.z - q.z) <= (H.dist || 8) + 6) return q
  log(`чутьё: лава за блоком у ${q.x},${q.y},${q.z} — не видна и не слышна, целью не беру`)
  return null
}
const BASTION_KEYS = ['бастион (ад)', 'бастион 2 (ад)', 'бастион 3 (ад)']
const bastionState = new Map()
const bState = b => {
  const key = `${b.key}:${b.dimension || 'the_nether'}:${b.x}:${b.z}`
  if (!bastionState.has(key)) bastionState.set(key, { dry: 0, spent: false, runs: 0 })
  return bastionState.get(key)
}

export { acceptResult, sense, nearWalkers, refresh, readMemory, lavaBadSites, lavaBad, shoreDistance, stopLava,
  bState }
