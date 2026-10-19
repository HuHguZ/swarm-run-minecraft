'use strict'
// Литьё в глубине: лава по слуху, у штрека, вода через шахту, подход к лаве для литья.
import { OW_HEAR, DEEP_Y } from './flags'
import { strategyInterrupted, state, died, known, descendLava, deepLava, heardLava, surfaceShaft, shaftWaterSeen,
  knownWater, setDeepLava, setHeardLava, setKnownWater, setSurfaceShaft, setWaterDeepFailAt } from './state'
import { log } from './log'
import { have, y, dim, COBBLE, lighter } from './queries'
import { refresh, readMemory, stopLava } from './observe'
import { near3 } from './stages/table'
import { act } from './act'
import { mobInTheWay, cavesFoes } from './danger'
import { recoverGuard } from './guards'
import { craft, spares, unclutter } from './kit'
import { descend } from './underground'
import { castForKit } from './portal-kit'
import { toShaftColumn } from './scout'
import * as gameClock from '../src/game-clock'
const deepBad = [] // лава, у которой окно или место не вышли
async function listenForLava (where) {
  if (heardLava && gameClock.now() - heardLava.t < 20 * 60000 && near3(heardLava.from, 32)) return
  const h = await act('portal', { mode: 'cast', listen: 16, timeoutSeconds: 30 })
  const heard = h.detail && Array.isArray(h.detail.heard) && h.detail.heard[0]
  if (!heard || !state.pos) return
  setHeardLava({ ...heard, from: { x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z) }, t: gameClock.now() })
  log(`слышу лаву (${where}): ${heard.dir}, ~${heard.dist} бл., высота ${heard.height ?? '?'} — запомнил для литья`)
}
async function toHeardLava () {
  const H = heardLava
  setHeardLava(null)
  if (!H || !state.pos || gameClock.now() - H.t > 30 * 60000 || !near3(H.from, 96)) return null
  log(`литьё: к лаве, услышанной у ${H.from.x},${H.from.y},${H.from.z} (${H.dir}, ~${H.dist} бл.)`)
  if (!near3(H.from, 3)) await act('goto', { x: H.from.x, y: H.from.y, z: H.from.z, range: 2, timeoutSeconds: 90 })
  if (died || !near3(H.from, 6)) return null
  const v = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[H.dir] || [0, 0]
  const flat = H.flat || 0
  const dy = Number.isFinite(H.height) ? H.height : 0
  const T = { x: Math.round(state.pos.x + v[0] * flat), y: Math.round(state.pos.y + 1.62 + dy), z: Math.round(state.pos.z + v[1] * flat) }
  if (Math.abs(dy) <= 2) {
    const t = await act('tunnel', { direction: H.dir, length: Math.max(3, Math.min(20, flat + 2)), torchEvery: 0, timeoutSeconds: 120 })
    const lv = /лава на (-?\d+),(-?\d+),(-?\d+)/.exec(String((t.detail && t.detail.stopped) || ''))
    if (lv) return { x: +lv[1], y: +lv[2], z: +lv[3] }
  } else {
    await act('goto', { x: T.x, y: T.y + 1, z: T.z, range: 3, timeoutSeconds: 60 })
  }
  if (died) return null
  const o = await act('observe', { radius: 32 })
  const sv = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
  if (sv && !cavesFoes(o)) return sv.nearest
  return null
}
async function deepCast () {
  if (deepLava && !near3(deepLava, 48)) setDeepLava(null)
  if (!deepLava && heardLava) {
    const lv = await toHeardLava()
    if (died) return
    if (lv && !deepBad.some(b => Math.hypot(b.x - lv.x, b.y - lv.y, b.z - lv.z) < 6)) { setDeepLava(lv); log(`литьё: лава по слуху у ${lv.x},${lv.y},${lv.z} — лью здесь, без спуска к ${DEEP_Y}`) }
  }
  for (let k = 0; k < 3 && !deepLava && y() > DEEP_Y + 3 && !died; k++) {
    log(`литьё глубоко: ${k ? 'спуск ещё раз' : 'лавы поверху не вижу'} — вниз к ${DEEP_Y} (водоносная лава ниже −54)`)
    await descend(DEEP_Y, { stopAtLava: true })
    if (descendLava) setDeepLava(descendLava)
    if (y() <= DEEP_Y + 12) break
  }
  if (died) return
  if (!deepLava && known.lava && near3(known.lava, 10) && !deepBad.some(q => Math.hypot(q.x - known.lava.x, q.y - known.lava.y, q.z - known.lava.z) < 6)) setDeepLava(known.lava)
  if (!deepLava && y() > DEEP_Y && y() <= DEEP_Y + 12) {
    const d = await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 120 })
    const lv = await stopLava(d)
    if (lv) setDeepLava(lv)
  }
  if (died) return
  if (!deepLava && y() > DEEP_Y + 12) { log(`литьё глубоко: спуск встал на y ${Math.round(y())}`); return }
  if (deepLava && !near3(deepLava, 6)) {
    log(`литьё глубоко: к известной лаве ${deepLava.x},${deepLava.y},${deepLava.z}`)
    await act('goto', { x: deepLava.x, y: deepLava.y + 1, z: deepLava.z, range: 3, timeoutSeconds: 90 })
    if (!near3(deepLava, 8)) { deepBad.push(deepLava); setDeepLava(null) }
  }
  const dirs = ['north', 'east', 'south', 'west']
  let dir = Math.floor(Math.random() * 4)
  let cobbleTried = false
  let lastHeard = null
  let hearOff = 0
  let upTried = 0
  for (let i = 0; i < 10 && !known.portal && !died; i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares(200)
    if (deepLava && near3(deepLava, 8)) {
      if (!have('water_bucket') && have(/^bucket$/)) {
        const lavaKeep = deepLava
        log('литьё глубоко: лава рядом, ведро воды пустое — вода штреками отсюда')
        await deepWater()
        if (died) return
        if (!have('water_bucket')) {
          setWaterDeepFailAt(gameClock.now())
          log('литьё глубоко: воды у дна не нашёл — заход кончаю, без повторных штреков')
          return
        }
        if (!near3(lavaKeep, 8)) await act('goto', { x: lavaKeep.x, y: lavaKeep.y + 1, z: lavaKeep.z, range: 3, timeoutSeconds: 90 })
        setDeepLava(lavaKeep)
      }
      const r = await castForKit({ mode: 'cast', windows: true, hint: deepLava, maxDig: 64, keep: 8, radius: 12, timeoutSeconds: 540 })
      await readMemory()
      if (known.portal || died) return
      if (process.env.ND_OW_KIT_FRAME !== '0' && r.detail?.retryBlocked) { log('литьё глубоко: причина отказа не изменилась — возвращаю выбор плану'); return }
      const why = String((r.detail && r.detail.stopped) || r.error || '')
      const needWhat = String((r.detail && r.detail.need && r.detail.need.what) || '')
      if (/cobblestone|stone/.test(needWhat) && !cobbleTried) {
        cobbleTried = true
        await act('tunnel', { direction: dirs[(dir + 2) % 4], length: 8, torchEvery: 0, timeoutSeconds: 90 })
        continue
      }
      if (r.detail && r.detail.need) { log(`литьё глубоко: не хватает ${JSON.stringify(r.detail.need)}`); return }
      if (/не вижу лавы|места под раму|места на берегу нет|лава далеко|расчистить место/.test(why)) {
        log(`литьё глубоко: у лавы ${deepLava.x},${deepLava.y},${deepLava.z} не вышло (${why.slice(0, 120)}) — штрек дальше`)
        deepBad.push(deepLava)
        setDeepLava(null)
        dir = (dir + 1) % 4
      }
      continue
    }
    setDeepLava(null)
    if (y() > DEEP_Y && y() <= DEEP_Y + 6) await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 90 })
    if (y() < DEEP_Y - 0.5) await act('tunnel', { direction: 'up', length: 8, toY: DEEP_Y, timeoutSeconds: 40 })
    if (died) return
    let len = 32
    if (OW_HEAR && hearOff > 0) hearOff--
    else if (OW_HEAR) {
      const h = await act('portal', { mode: 'cast', listen: 16, timeoutSeconds: 30 })
      let heard = h.detail && Array.isArray(h.detail.heard) && h.detail.heard[0]
      const OPP = { east: 'west', west: 'east', north: 'south', south: 'north' }
      const flip = heard && lastHeard && OPP[lastHeard.dir] === heard.dir && near3(lastHeard.at, 16)
      if (heard && (heard.above || flip) && upTried < 2 && state.pos) {
        upTried++
        const v = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[heard.dir]
        const flat = heard.flat || 0
        const dy = Number.isFinite(heard.height) ? heard.height : (heard.below ? -1 : 1) * Math.round(Math.sqrt(Math.max(0, (heard.dist || 0) ** 2 - flat ** 2)))
        const T = { x: Math.round(state.pos.x + v[0] * flat), y: Math.round(state.pos.y + 1.62 + dy), z: Math.round(state.pos.z + v[1] * flat) }
        log(`литьё глубоко: слышу лаву ${heard.dir}, ~${heard.dist} бл.${heard.above ? ', выше' : heard.below ? ', ниже' : ''}${flip ? ' (сторона сменилась — она между концами штрека)' : ''} — к ней ~${T.x},${T.y},${T.z}`)
        await act('goto', { x: T.x, y: T.y + 1, z: T.z, range: 3, timeoutSeconds: 45 })
        if (died) return
        const o2 = await act('observe', { radius: 32 })
        const sv = (Array.isArray(o2.detail && o2.detail.blocks) ? o2.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
        if (sv && !cavesFoes(o2) && !deepBad.some(b => Math.hypot(b.x - sv.nearest.x, b.y - sv.nearest.y, b.z - sv.nearest.z) < 6)) {
          setDeepLava(sv.nearest)
          log(`литьё глубоко: вижу лаву ${deepLava.x},${deepLava.y},${deepLava.z} (по слуху)`)
          continue
        }
        log('литьё глубоко: по слуху не дошёл/не увидел — слух молчит два штрека, штрек в новую сторону')
        hearOff = 2
        lastHeard = null
        dir = (dirs.indexOf(heard.dir) + 1) % 4
        heard = null
        if (y() > DEEP_Y && y() <= DEEP_Y + 12) await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 90 })
      }
      else if (heard && (heard.above || flip)) {
        hearOff = 2
        lastHeard = null
        dir = (dirs.indexOf(heard.dir) + 1) % 4
        heard = null
      }
      if (heard) lastHeard = { dir: heard.dir, at: { ...state.pos } }
      if (heard) {
        dir = dirs.indexOf(heard.dir)
        len = Math.max(4, Math.min(32, (heard.flat || 0) + 3))
        log(`литьё глубоко: слышу лаву — ${heard.dir}, ~${heard.dist} бл.${heard.below ? ', ниже' : heard.above ? ', выше' : ''}`)
        if (heard.below && (heard.flat || 0) <= 2 && y() > DEEP_Y + 0.5) {
          const sh = await act('tunnel', { direction: 'down', length: Math.max(1, Math.min(8, heard.dist + 1, Math.floor(y() - DEEP_Y))), timeoutSeconds: 60 })
          const lv = await stopLava(sh)
          if (lv) { setDeepLava(lv); log(`литьё глубоко: колодец встал у лавы ${lv.x},${lv.y},${lv.z}`); continue }
        }
        if (heard.below && (heard.flat || 0) > 2 && y() > DEEP_Y + 1.5) {
          const dy = Number.isFinite(heard.height) ? Math.abs(heard.height) : Math.round(Math.sqrt(Math.max(0, (heard.dist || 0) ** 2 - (heard.flat || 0) ** 2)))
          const st = await act('dig_down', { mode: 'stairs', depth: Math.max(1, Math.min(8, dy + 1, Math.floor(y() - DEEP_Y))), direction: heard.dir, torchEvery: 0, timeoutSeconds: 120 })
          const lv = await stopLava(st)
          if (lv) { setDeepLava(lv); log(`литьё глубоко: лесенка встала у лавы ${lv.x},${lv.y},${lv.z}`); continue }
        }
      }
    }
    const t = await act('tunnel', { direction: dirs[dir], length: len, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    if (died) return
    if (await mobInTheWay(t)) continue
    const why = String((t.detail && t.detail.stopped) || t.error || '')
    if (t.status === 'failed' && !((t.detail && t.detail.walked) > 0)) { log(`литьё глубоко: штрек на ${dirs[dir]} не идёт (${why.slice(0, 80)}) — поворачиваю`); dir = (dir + 1) % 4; hearOff = Math.max(hearOff, 1); lastHeard = null; continue }
    const p = /лава на (-?\d+),(-?\d+),(-?\d+)/.test(why) ? await stopLava(t) : null
    if (p) {
      if (!deepBad.some(b => Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) < 6)) { setDeepLava(p); log(`литьё глубоко: штрек встал у лавы ${p.x},${p.y},${p.z}`); continue }
    }
    const wetHere = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if (wetHere && !have('water_bucket') && have(/^bucket$/)) {
      await act('portal', { mode: 'cast', waterHint: { x: +wetHere[1], y: +wetHere[2], z: +wetHere[3] }, timeoutSeconds: 120 })
      if (have('water_bucket')) log(`литьё глубоко: вода у штрека ${wetHere[1]},${wetHere[2]},${wetHere[3]} — ведро полное`)
    }
    if (t.detail && t.detail.stopped && !(t.detail.walked > 0) && !(t.detail.dug > 0)) { dir = (dir + 1) % 4; hearOff = Math.max(hearOff, 1); lastHeard = null; continue }
    if (!lighter() && !have('flint')) await act('mine', { block: 'gravel', dry: true, count: 6, radius: 16, timeoutSeconds: 45 })
    if (!lighter() && have('flint') && have('iron_ingot')) await craft('flint_and_steel')
    const o = await act('observe', { radius: 48 })
    const seen = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
    if (seen && cavesFoes(o)) log(`литьё глубоко: лава ${seen.nearest.x},${seen.nearest.y},${seen.nearest.z} видна, но рядом ${cavesFoes(o)} — мимо`)
    if (seen && !cavesFoes(o) && !deepBad.some(b => Math.hypot(b.x - seen.nearest.x, b.y - seen.nearest.y, b.z - seen.nearest.z) < 6)) {
      setDeepLava(seen.nearest)
      log(`литьё глубоко: вижу лаву ${deepLava.x},${deepLava.y},${deepLava.z}`)
      if (!near3(deepLava, 8)) await act('goto', { x: deepLava.x, y: deepLava.y + 1, z: deepLava.z, range: 4, timeoutSeconds: 90 })
      if (!near3(deepLava, 10)) { log('литьё глубоко: к видимой лаве не дошёл — штрек дальше'); deepBad.push(deepLava); setDeepLava(null) }
      continue
    }
    if (why) dir = (dir + 1) % 4
  }
}
const surfaceShaftNear = () => !!surfaceShaft && !!state.pos && dim() === 'overworld' && Math.hypot(surfaceShaft.x - state.pos.x, surfaceShaft.z - state.pos.z) <= 64 && y() < surfaceShaft.top - 8 && Math.abs(y() - surfaceShaft.bottom) <= 3
async function waterViaShaft () {
  const S = surfaceShaft
  if (!S || have('water_bucket') || !have(/^bucket$/)) return false
  if (have(COBBLE) + have(/^(dirt|andesite|diorite|granite|tuff|cobbled_deepslate)$/) < S.top - S.bottom + 4) { log('вода: на подъём колодцем не хватит блоков'); return false }
  log(`вода: штреками нет — поднимаюсь своим колодцем ${S.x},${S.z} (${S.bottom} → ${S.top}), поверху черпаю`)
  await toShaftColumn(S)
  await refresh()
  if (!state.pos || Math.floor(state.pos.x) !== S.x || Math.floor(state.pos.z) !== S.z) { log('вода: до низа колодца не дошёл'); setSurfaceShaft(null); return false }
  const up = await act('tunnel', { direction: 'up', length: 96, toY: S.top, timeoutSeconds: 150 })
  if (died) return false
  await refresh()
  if (y() < S.top - 2) { log(`вода: подъём колодцем встал на y ${Math.round(y())} (${String((up.detail && up.detail.stopped) || up.error || '').slice(0, 80)})`); setSurfaceShaft(null); return false }
  setSurfaceShaft(null) // колонна теперь забита столбом
  await act('bucket', { fluid: 'water', radius: 32 })
  if (!have('water_bucket') && shaftWaterSeen && Math.hypot(shaftWaterSeen.x - state.pos.x, shaftWaterSeen.z - state.pos.z) > 4) {
    await act('goto', { x: shaftWaterSeen.x, z: shaftWaterSeen.z, range: 3, timeoutSeconds: 45, surface: 'strict' })
    await act('bucket', { fluid: 'water', radius: 16 })
  }
  if (!have('water_bucket')) await act('bucket', { fluid: 'water', radius: 32 })
  log(have('water_bucket') ? 'вода: ведро полное (поверху у колодца)' : 'вода: поверху у колодца не набралась')
  return have('water_bucket') > 0
}
async function deepWater ({ legs = 5 } = {}) {
  const dirs = ['north', 'east', 'south', 'west']
  let dir = Math.floor(Math.random() * 4)
  if (knownWater && state.pos && Math.hypot(knownWater.x - state.pos.x, knownWater.y - state.pos.y, knownWater.z - state.pos.z) <= 64) {
    const kw = knownWater
    log(`вода глубоко: к известной ${kw.x},${kw.y},${kw.z}`)
    if (Math.hypot(kw.x - state.pos.x, kw.y - state.pos.y, kw.z - state.pos.z) > 4) await act('goto', { x: kw.x, y: kw.y, z: kw.z, range: 3, timeoutSeconds: 90 })
    await act('bucket', { fluid: 'water', radius: 16 })
    if (!have('water_bucket')) await act('portal', { mode: 'cast', waterHint: kw, timeoutSeconds: 120 })
    if (have('water_bucket')) { log('вода глубоко: ведро полное (известная вода)'); return true }
    setKnownWater(null)
  }
  for (let i = 0; i < legs && !have('water_bucket') && !died; i++) {
    await recoverGuard()
    if (died) return false
    const r = await act('bucket', { fluid: 'water', radius: 32 })
    if (have('water_bucket')) break
    if (r.detail && r.detail.need) return false
    await unclutter()
    await spares(120)
    let len = 32
    if (OW_HEAR) {
      const h = await act('portal', { mode: 'cast', listen: 16, fluid: 'water', timeoutSeconds: 30 })
      const heard = h.detail && Array.isArray(h.detail.heard) && h.detail.heard[0]
      if (heard) { dir = dirs.indexOf(heard.dir); len = Math.max(4, Math.min(32, (heard.flat || 0) + 3)); log(`вода глубоко: слышу ручей — ${heard.dir}, ~${heard.dist} бл.`) }
    }
    const t = await act('tunnel', { direction: dirs[dir], length: len, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    if (died) return false
    if (await mobInTheWay(t)) continue
    if (OW_HEAR && !known.portal) await listenForLava('штрек за водой')
    const why = String((t.detail && t.detail.stopped) || t.error || '')
    const wet = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if (wet) {
      const hint = { x: +wet[1], y: +wet[2], z: +wet[3] }
      let w = await act('portal', { mode: 'cast', waterHint: hint, timeoutSeconds: 120 })
      if (!have('water_bucket') && /не вижу источника/.test(String((w.detail && w.detail.stopped) || ''))) {
        const closer = await act('tunnel', { direction: dirs[dir], length: 3, torchEvery: 0, timeoutSeconds: 60 })
        if (died) return false
        if (((closer.detail && closer.detail.walked) || 0) > 0) w = await act('portal', { mode: 'cast', waterHint: hint, timeoutSeconds: 120 })
      }
      if (have('water_bucket')) { log(`вода глубоко: окно у ${wet[1]},${wet[2]},${wet[3]} — ведро полное`); break }
      log(`вода глубоко: у ${wet[1]},${wet[2]},${wet[3]} не набралась (${String((w.detail && w.detail.stopped) || w.error || '').slice(0, 160)})`)
    }
    const lava = !deepLava && /лава на (-?\d+),(-?\d+),(-?\d+)/.test(why) ? await stopLava(t) : null
    if (lava) setDeepLava(lava)
    if (why) dir = (dir + 1) % 4
  }
  return have('water_bucket') > 0
}

async function approachCastLava () {
  if (process.env.ND_OW_KIT_LAVA === '0' || !known.lava || !state.pos || dim() !== 'overworld') return false
  const q = { ...known.lava }, distance = () => Math.hypot(q.x - state.pos.x, (q.y ?? y()) - y(), q.z - state.pos.z)
  // Each repetition requires a shorter three-dimensional route, including actual descent.
  while (!died && !strategyInterrupted && distance() > 4) {
    const before = distance()
    const r = await act('goto', { x: q.x, y: (q.y ?? y()) + 1, z: q.z, range: 3, surface: false, descent: false, timeoutSeconds: 60 })
    if (r.status === 'interrupted' || died || strategyInterrupted) return false
    const dx = q.x - state.pos.x, dz = q.z - state.pos.z, lower = y() - q.y
    if (distance() >= before && lower > 4 && Math.hypot(dx, dz) <= 16) {
      const down = await act('dig_down', { mode: 'stairs', depth: Math.min(12, lower - 3),
        direction: Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north'),
        maxFallHp: 0, torchEvery: 0, timeoutSeconds: 90 })
      if (down.status === 'interrupted') return false
    }
    if (died || strategyInterrupted || distance() >= before) return false
  }
  return !died && !strategyInterrupted && distance() <= 4
}

export { deepBad, listenForLava, deepCast, surfaceShaftNear, waterViaShaft, deepWater, approachCastLava }
