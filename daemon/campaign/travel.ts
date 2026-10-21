'use strict'
// Переходы: отход от точки, путь к цели поверху, возврат из Ада.
import { EYES_NEED } from './flags'
import { stage, tacticalRevision, state, sit, hunting, died, known, heading, setHeading } from './state'
import { log } from './log'
import { have, dim, portalFar, nearBastion, fillerCount, goldOn, lighter, pearlsNow } from './queries'
import { sense, refresh } from './observe'
import { eyesWant, nextBastion } from './nether-plan'
import { act } from './act'
import { nightGuard } from './guards'
import { unclutter, ensurePick } from './kit'
import { toSurface } from './underground'
import * as path from 'path'
const LEASH = 660
const HUNT_LEASH = 660
async function homeLeash () {
  if (stage === 'stronghold' || stage === 'dragon' || (have('ender_eye') >= Math.min(10, EYES_NEED) && known.stronghold)) return
  if (portalFar() > (hunting ? HUNT_LEASH : LEASH) + 30) { log(`далеко от портала (${Math.round(portalFar())}) — назад к базе`); await goToward(known.portal, 24) }
}
async function walkAway (dist, turn = 0, targetY?: number) {
  setHeading(heading + turn)
  let x = Math.round(state.pos.x + Math.cos(heading) * dist)
  let z = Math.round(state.pos.z + Math.sin(heading) * dist)
  const leash = hunting ? HUNT_LEASH : LEASH
  if (known.portal && dim() === 'overworld' && Math.hypot(x - known.portal.x, z - known.portal.z) > leash) {
    setHeading(Math.atan2(known.portal.z - state.pos.z, known.portal.x - state.pos.x) + (Math.random() - 0.5) * 1.6)
    x = Math.round(state.pos.x + Math.cos(heading) * dist)
    z = Math.round(state.pos.z + Math.sin(heading) * dist)
  }
  const r = await act('goto', { x, y: targetY, z, range: 4, timeoutSeconds: Math.max(30, Math.round(dist * 1.5)), surface: 'strict' })
  // Поверху пути нет ни в одну сторону (берег, остров: s8c-b-v1-2 — 8 мин «No path» с одной клетки за брёвнами) — тот же отход
  // обычным goto (вплавь, через холм), не стоять на месте. ND_WALK_LOOSE=0 — прежнее.
  if (r.status !== 'done' && /No path|нечем строить/i.test(String(r.error || '')) && process.env.ND_WALK_LOOSE !== '0' && !died) {
    // Из ямы не вылезти — «нечем строить» (s8c-c-v1-2: яма без кирки и блоков, 8 мин на месте): земля/песок рукой — блоки на ступень.
    if (/нечем строить/.test(String(r.error || '')) && fillerCount() < 4) await act('mine', { block: 'dirt,grass_block,coarse_dirt,podzol,rooted_dirt,sand,red_sand,gravel,mud,clay', count: 6, radius: 8, timeoutSeconds: 40 })
    return act('goto', { x, y: targetY, z, range: 4, timeoutSeconds: Math.max(30, Math.round(dist * 1.5)), surface: targetY === undefined ? undefined : 'strict' })
  }
  return r
}

async function awayFrom (p, dist = 24) {
  await sense()
  if (!sit.surface && dim() === 'overworld' && !(await toSurface(2))) {
    throw new Error('не вышел наверх — отход поверху не запускаю')
  }
  await refresh()
  if (!p) return walkAway(dist, Math.PI / 2)
  let dx = state.pos.x - p.x
  let dz = state.pos.z - p.z
  const n = Math.hypot(dx, dz)
  if (n < 0.5) { dx = Math.cos(heading); dz = Math.sin(heading) } else { dx /= n; dz /= n }
  return act('goto', { x: Math.round(state.pos.x + dx * dist), z: Math.round(state.pos.z + dz * dist), range: 4, timeoutSeconds: 60, surface: 'strict' })
}

function netherVia (from, to) {
  const chain = [known.netherPortal, ...(known.bastions || [])].filter(Boolean)
  if (chain.length < 2 || !from || !to) return []
  const P = []; const at = new Array(chain.length).fill(-1)
  let k0 = 0
  for (let k = 1; k < chain.length; k++) {
    const leg = chain[k].via
    if (!Array.isArray(leg) || !leg.length) { if (P.length) break; k0 = k; continue }
    if (!P.length) at[k - 1] = 0
    P.push(...leg); at[k] = P.length - 1
  }
  if (P.length < 2) return []
  const d3 = (a, p) => Math.hypot(a[0] - p.x, a[2] - p.z) + Math.abs(a[1] - (Number.isFinite(p.y) ? p.y : a[1])) * 0.5
  let i = -1; let bd = Infinity
  P.forEach((a, n) => { const d = d3(a, from); if (d < bd) { bd = d; i = n } })
  if (bd > 160) i = -1
  let j = -1; let bj = Infinity
  chain.forEach((c, k) => { if (at[k] < 0) return; const d = Math.hypot(c.x - to.x, c.z - to.z); if (d < bj) { bj = d; j = at[k] } })
  if (i < 0 || j < 0 || bj > 160 || i === j || k0 < 0) return []
  return i < j ? P.slice(i, j + 1) : P.slice(j, i + 1).reverse()
}

let bastionWalkRefusals = 0
async function goToward (p, range = 6, frKeep = 1, sealedFrom: number | null = null) {
  const fromWorld = dim()
  const fromRevision = tacticalRevision
  const receipt = fromWorld === 'the_nether' && process.env.ND_BASTION_WALK_RECEIPT === '1'
  // F3/body position is the receipt. A completed RPC may still report "не дошёл".
  const distanceTo = target => state.pos ? Math.hypot(target.x - state.pos.x,
    receipt && typeof target.y === 'number' ? target.y - state.pos.y : 0, target.z - state.pos.z) : Infinity
  const interrupted = r => tacticalRevision !== fromRevision || r.status === 'interrupted' || r.code === 'TACTICAL' ||
    /^(tactical|damage|low_health|emergency)$/.test(r.by?.type || '')
  if (fromWorld === 'the_nether' && process.env.ND_NE_ROUTE === '1' && state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) > range + 2 && !died) {
    const far = Math.hypot(p.x - state.pos.x, p.z - state.pos.z)
    const yKnown = typeof p.y === 'number'
    // p.ry/p.rdy — высота цели только для хода по сетке (точка выхода у крепости, S5d), штрек без сетки её не берёт.
    const r = await act('ne_route', { x: p.x, y: typeof p.ry === 'number' ? p.ry : yKnown ? p.y : 64, z: p.z, r: Math.max(range, 3), dy: typeof p.rdy === 'number' ? p.rdy : yKnown ? 4 : 50, frKeep, ironOk: !nextBastion() || (process.env.ND_NE_STAY === '1' && pearlsNow() >= eyesWant()), ...(nearBastion(state.pos, 120) ? { zoneExpo: 14 } : {}), timeoutSeconds: Math.min(1200, Math.round(120 + far * 2.5)) })
    await refresh()
    if (died || dim() !== fromWorld) return false
    if (interrupted(r)) { log('переход прерван — возвращаю управление для нового наблюдения'); return false }
    if (distanceTo(p) <= range + 2) return true
    log(`по сетке не довёл: ${(r.detail && r.detail.why) || r.error || '?'} — дальше штреком`)
  }
  // Без золотой вещи — штреком уже с 16 бл.: поверху пиглины бьют на виду (b11-6-1 14.10: к порталу в 28 бл. поверху — смерть).
  if (fromWorld === 'the_nether' && state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) > (sealedFrom ?? (goldOn() ? 60 : 16)) && !died) {
    const far = Math.hypot(p.x - state.pos.x, p.z - state.pos.z)
    const via = netherVia(state.pos, p)
    const tArgs = () => ({ x: p.x, y: p.y, z: p.z, radius: Math.max(range, 5), ...(via.length ? { via } : {}), ironOk: !nextBastion() || (process.env.ND_NE_STAY === '1' && pearlsNow() >= eyesWant()), timeoutSeconds: Math.min(via.length ? 2700 : 1800, Math.round(120 + far * (via.length ? 3 : 1.6))) })
    let t = await act('nether_tunnel', tArgs())
    await refresh()
    if (died || dim() !== fromWorld) return false
    if (interrupted(t)) { log('штрек прерван — возвращаю управление для нового наблюдения'); return false }
    if (distanceTo(p) <= range + 2) return true
    const td0 = t.detail || {}
    if (!td0.ok && !td0.segs && !td0.dug && process.env.ND_BURROW !== '0') {
      const bw = await act('ne_burrow', { why: 'штрек по Аду не начался' })
      await refresh()
      if (died || dim() !== fromWorld) return false
      if (interrupted(bw)) return false
      if (bw.detail && bw.detail.ok) {
        t = await act('nether_tunnel', tArgs())
        await refresh()
        if (died || dim() !== fromWorld) return false
        if (interrupted(t)) return false
        if (distanceTo(p) <= range + 2) return true
      }
    }
    // S1f: от бастиона — пешком можно (путь уводит от ближнего бастиона), и третий отказ подряд — тоже: стоять у бастиона
    // с «пути нет» дороже риска хода (s1f-FA-5/FB-4: 7 отказов подряд за 5 игр. мин, тело стояло у бастиона, найденного глазами).
    // ND_NE_BASTION_AWAY=0 — прежнее (у бастиона никогда).
    // Прочь — путь тело → цель не подходит к ближнему бастиону ближе, чем тело сейчас (угол с направлением «от бастиона» ≤ 90°).
    const nearB = nearBastion(state.pos)
    const bNear = nearB && state.pos ? (known.bastions || []).reduce((m, b) => !m || Math.hypot(b.x - state.pos.x, b.z - state.pos.z) < Math.hypot(m.x - state.pos.x, m.z - state.pos.z) ? b : m, null) : null
    const awayDir = !!bNear && (p.x - state.pos.x) * (state.pos.x - bNear.x) + (p.z - state.pos.z) * (state.pos.z - bNear.z) >= 0
    const awayOk = process.env.ND_NE_BASTION_AWAY !== '0' && nearB && !!state.pos && (awayDir || ++bastionWalkRefusals >= 3)
    if (awayOk) { bastionWalkRefusals = 0; log(`штрек по Аду не довёл у бастиона — пешком (${awayDir ? 'прочь от бастиона' : 'третий отказ подряд'})`) }
    else if (nearB) { log(`штрек по Аду не довёл: ${(t.detail && t.detail.why) || t.error || '?'} — у бастиона пешком не иду`); return false }
    // Бастион глазами (S5e 07.10, честно: видимые блоки бастиона из памяти глаз, бруты — видимые/слышимые): пешком мимо него не идти
    // (s5e-M-3: штрек «пути нет» в 70 бл. от точки выхода → goto сквозь бастион → «slain by Piglin Brute» за 16 игр. с).
    // ND_NE_BASTION_EYES=0 — прежнее.
    if (!awayOk && process.env.ND_NE_BASTION_EYES !== '0') {
      const sb = await act('perceive', { mode: 'seen', re: '^(gilded_blackstone|polished_blackstone_bricks|cracked_polished_blackstone_bricks|chiseled_polished_blackstone)$', max: 1, maxDist: 40 })
      const en = await act('perceive', { mode: 'entities', radius: 32 })
      const brute = ((en.detail && en.detail.entities) || []).some(e => e && /piglin_brute/.test(e.name || e.kind || ''))
      const seenB = ((sb.detail && sb.detail.seen) || []).length > 0
      if (brute || seenB) { log(`штрек по Аду не довёл: ${(td0.why) || t.error || '?'} — рядом бастион (${brute ? 'брут' : 'блоки бастиона'}), пешком не иду`); return false }
    }
    log(`штрек по Аду не довёл: ${(t.detail && t.detail.why) || t.error || '?'} — дальше пешком`)
  }
  const detour = [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]
  let turn = 0
  // S1f (вслепую, без сетки): в Аду отрезки по 32, а не 64 — длинная цель в изрезанном рельефе Ада «Took to long to decide path»
  // (s1f-E1-1: к бастиону в 59 бл. 6 goto по 120 с — «не дошёл», 15 мин у бастиона). ND_NE_LEG=64 — прежнее.
  const LEG = fromWorld === 'the_nether' ? Math.max(16, Number(process.env.ND_NE_LEG) || 32) : 64
  let surfaceTried = false
  for (let k = 0; k < Math.round(12 * 64 / LEG) && !died; k++) {
    await refresh()
    if (died || dim() !== fromWorld || tacticalRevision !== fromRevision) return false
    if (!have(/_pickaxe$/)) await ensurePick()
    const dx = p.x - state.pos.x
    const dz = p.z - state.pos.z
    const far = Math.hypot(dx, dz)
    if (distanceTo(p) <= range + 2) return true
    if (dim() === 'overworld' && far > 24) {
      await sense()
      if (!sit.surface && !surfaceTried && typeof p.y !== 'number') {
        surfaceTried = true
        // Spend at most the remaining open-ground running time on getting out. A failed
        // climb still leaves the cave route available instead of becoming a resource gate.
        const seconds = Math.min(120, Math.max(10, Math.ceil(far / require('../src/hopgoto').RUN)))
        log(`наземная дорога ${Math.round(far)} бл. из-под крыши — выход до ${seconds}с, затем путь`)
        const up = await act('surface', { timeoutSeconds: seconds, preferPillar: true })
        if (died || interrupted(up)) return false
        k--; continue // re-observe the new position, including a partial climb or a dimension change
      }
      if (sit.night && sit.surface) await nightGuard()
      if (died) return false
    }
    let leg
    if (far > LEG + 8 || turn) {
      const a = Math.atan2(dz, dx) + detour[turn % detour.length]
      const step = Math.min(LEG, far)
      leg = { x: Math.round(state.pos.x + Math.cos(a) * step), z: Math.round(state.pos.z + Math.sin(a) * step) }
    } else leg = { x: p.x, z: p.z }
    const direct = far <= LEG + 8 && !turn
    // В Аду — без быстрого спуска со скалы (S1d s1d-G21-2: descent «ledges → no_ledge, down 25» — в лавовое море, смерть).
    const beforeDistance = receipt ? distanceTo(p) : 0
    const r = await act('goto', { x: leg.x, ...(direct && typeof p.y === 'number' ? { y: p.y } : {}), z: leg.z, range: direct ? range :Math.min(range, 8), timeoutSeconds: 120, ...(dim() === 'the_nether' ? { descent: false } : dim() === 'overworld' && typeof p.y !== 'number' ? { surface: true } : {}) })
    if (interrupted(r)) { log('ход прерван — возвращаю управление для нового наблюдения'); return false }
    if (receipt) {
      await refresh()
      if (died || dim() !== fromWorld || tacticalRevision !== fromRevision) return false
      const target = direct && typeof p.y === 'number' ? { ...leg, y: p.y } : leg
      const arrived = distanceTo(target) <= (direct ? range : Math.min(range, 8)) + 2
      const nearer = distanceTo(p) < beforeDistance
      turn = r.status === 'done' && arrived && nearer ? 0 : turn + 1
      if (r.status === 'done' && (!arrived || !nearer)) log('ход завершён без достижения отрезка или приближения к цели — следующий обход')
    } else turn = r.status === 'done' ? 0 : turn + 1
    if (turn >= detour.length) return false
  }
  return false
}

async function returnFromNether () {
  if (dim() !== 'the_nether') return dim() === 'overworld'
  await unclutter()
  // «портал (ад)» не записан (вход прерван тактикой) — портал прибытия рядом с x/8, z/8 портала верхнего мира: туда,
  // а там portal enter сам найдёт горящий в 16 бл. (s1-post08 06.10: 10 очей, «ПЕРЕХОДА НЕТ» в 150 бл. от портала).
  const home = known.netherPortal || (known.portal && Number.isFinite(known.portal.x) ? { x: Math.round(known.portal.x / 8), z: Math.round(known.portal.z / 8) } : null)
  if (!known.netherPortal && home) log(`«портал (ад)» в памяти нет — иду к ${home.x},${home.z} (портал верхнего мира / 8)`)
  // S1e: далеко до своего портала, а обсидиан и огниво при себе — новый портал на месте дешевле пешего хода по Аду (цена, nether-pause.exitChoice).
  if (home && state.pos && process.env.ND_EXIT_LOCAL !== '0') {
    const ch = require('../src/campaign/nether-pause').exitChoice({ homeDistance: Math.hypot(home.x - state.pos.x, home.z - state.pos.z), obsidian: have('obsidian'), lighter: !!lighter() })
    log(`выход: ${ch.why}`)
    if (ch.build) {
      const b = await act('portal', { timeoutSeconds: 150 })
      await refresh()
      if (dim() === 'the_nether' && !died && b.detail && b.detail.lit) await act('portal', { mode: 'enter', anyPortal: true, timeoutSeconds: 60 })
      await refresh()
      if (dim() !== 'the_nether') return dim() === 'overworld'
      log('новый портал на месте не вывел — к своему')
    }
  }
  const reached = home ? await goToward(home, 4) : true
  if (dim() !== 'the_nether') return dim() === 'overworld'
  // Портал близко (≤ 64 бл.), а ход не довёл — у portal enter свой подход: отрезками и ступенями штрека вверх к раме
  // (nether.walkToward: «подъём к цели»). goto не поднимается в Аду без столба (b6-6-1 14.10: портал на 37 бл. выше в 24 бл. —
  // «pathfinder закончил путь» ×7 и «домой не вышло» по кругу).
  const homeNear = !!home && !!state.pos && Math.hypot(home.x - state.pos.x, home.z - state.pos.z) <= 64
  if (!reached && homeNear && !died && (state.tactics?.threatLevel ?? 0) < 2) {
    log('ход к порталу не довёл — подход самого портала (ступенями к раме)')
    await act('portal', { mode: 'enter', timeoutSeconds: 180 })
    return dim() === 'overworld'
  }
  if (!reached) { log('безопасный путь к порталу не пройден — переход пешком не запускаю'); return false }
  await act('portal', { mode: 'enter', timeoutSeconds: 120 })
  return dim() === 'overworld'
}

export { homeLeash, walkAway, awayFrom, netherVia, goToward, returnFromNether }
