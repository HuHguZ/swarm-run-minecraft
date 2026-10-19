'use strict'
// Под землю и наверх: спуск лестницей и подъём к поверхности.
import { NIGHT_DOWN2, OW_DEEP, OW_SHAFT } from './flags'
import { strategyInterrupted, state, sit, died, known, stairEntrance, setDescendLava, setFighting, setSurfaceShaft } from './state'
import { log } from './log'
import { have, y, dim, COBBLE, PICK_STONE, fillerCount, todNow } from './queries'
import { sense, stopLava } from './observe'
import { nightHold } from './stages/table'
import { act } from './act'
import { answerThreat, leaveWater, mobInTheWay, cavesFoes } from './danger'
import { recoverGuard } from './guards'
import { walkAway, awayFrom } from './travel'
import { craft, sticks, spares, unclutter, reserve, ensurePick, mineSeenAll, torches } from './kit'
import { structureValue } from './scout'
import * as gameClock from '../src/game-clock'
async function descend (toY, { stopAtLava = false, short = false, wetCluster = false, oreRemaining = null } = {}) {
  const dirs = ['north', 'east', 'south', 'west']
  setDescendLava(null)
  // short — короткий спуск маршрута к лаве (≤ 24 бл.): запас дерева на кирки под землёй не нужен (s8-r2-9: reserve → lumber 6
  // брёвен за 109 с перед спуском на 13).
  if (!(short && y() - toY <= 24 && have(PICK_STONE))) await reserve()
  const lavaStop = async r => {
    if (!stopAtLava) return false
    const q = await stopLava(r)
    if (!q) return false
    setDescendLava(q)
    log(`спуск: лава у ${q.x},${q.y},${q.z} — её и надо, спуск кончаю на y ${Math.round(y())}`)
    return true
  }
  let surfaceWet = 0
  const wetStops = []
  // Retreat from the observed wet cluster rather than orbiting its last edge.
  const wetOrigin = last => wetCluster && process.env.ND_OW_IRON_WET !== '0' && wetStops.length ? {
    x: wetStops.reduce((sum, p) => sum + p.x, 0) / wetStops.length,
    z: wetStops.reduce((sum, p) => sum + p.z, 0) / wetStops.length
  } : last
  let caveSkips = 0
  for (let i = 0; i < (oreRemaining ? 16 : 8) && y() > toY + 2 && (!oreRemaining || oreRemaining() > 0); i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares(Math.min(260, (y() - toY) * 2 + 60))
    if (!(await ensurePick())) { log('кирки нет и не из чего — вниз не иду'); return }
    if (oreRemaining) {
      await mineSeenAll('iron_ore,deepslate_iron_ore', 24, oreRemaining)
      if (died || strategyInterrupted || oreRemaining() <= 0) return
    }
    let stairsDepth = oreRemaining ? 12 : 24
    if (OW_DEEP && OW_SHAFT) {
      const shTop = state.pos ? { x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z) } : null
      const shSurface = sit.surface
      const sh = await act('tunnel', { direction: 'down', length: Math.min(64, Math.round(y() - toY)), timeoutSeconds: 240 })
      if (died) return
      if (OW_DEEP && shTop && shSurface && sh.detail && (sh.detail.descended || 0) >= 10 && sh.detail.depth && sh.detail.depth.x === shTop.x && sh.detail.depth.z === shTop.z) {
        setSurfaceShaft({ x: shTop.x, z: shTop.z, top: shTop.y, bottom: sh.detail.depth.y })
      }
      if (await lavaStop(sh)) return
      if (OW_DEEP && /пустота|пещер/.test(String((sh.detail && sh.detail.stopped) || ''))) {
        const o = await act('observe', { radius: 48 })
        if (!cavesFoes(o)) {
          if (!known.portal && have(/bucket$/) < 2 && have(/^(raw_iron|iron_ingot)$/) < 7) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: 7 - have(/^(raw_iron|iron_ingot)$/), radius: process.env.ND_IRON_WIDE !== '0' ? 24 : 14, timeoutSeconds: 90 })
          if (!known.portal && have(/^(coal|charcoal)$/) < 2) await act('mine', { block: 'coal_ore,deepslate_coal_ore', count: 3, radius: 16, timeoutSeconds: 45 })
        } else log(`спуск: в пещере ${cavesFoes(o)} — руду в ней не беру`)
        const lv = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
        const foesNear = cavesFoes(o)
        if (lv && foesNear && stopAtLava) log(`спуск: в пещере видна лава ${lv.nearest.x},${lv.nearest.y},${lv.nearest.z}, но там ${foesNear} — мимо, вниз`)
        if (stopAtLava && lv && !foesNear && lv.nearest.y < y() + 4 && Math.hypot(lv.nearest.x - state.pos.x, lv.nearest.z - state.pos.z) <= 32) {
          setDescendLava({ ...lv.nearest })
          log(`спуск: в пещере видна лава ${lv.nearest.x},${lv.nearest.y},${lv.nearest.z} — к ней, спуск кончаю`)
          return
        }
      }
      if (await mobInTheWay(sh)) continue
      if (y() <= toY + 2) break
      if (OW_DEEP && /пустота|пещер/.test(String((sh.detail && sh.detail.stopped) || ''))) {
        let moved = false
        if (caveSkips < 3) {
          caveSkips++
          await act('tunnel', { direction: 'up', length: 3, timeoutSeconds: 20 })
          for (let k = 0; k < 4 && !moved && !died; k++) {
            const dirAway = dirs[(i + caveSkips + k) % 4]
            const t = await act('tunnel', { direction: dirAway, length: 8, torchEvery: 0, timeoutSeconds: 60 })
            moved = ((t.detail && t.detail.walked) || 0) >= 3
          }
        }
        log(`спуск: колодец вышел в пещеру на y ${Math.round(y())} — ${moved ? 'штрек вбок, колодец оттуда' : 'вбок не вышло — спуск здесь кончаю (лесенкой в пещеру не иду)'}`)
        if (moved) { i--; continue }
        return
      }
      const shWet = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(String((sh.detail && sh.detail.stopped) || ''))
      if (shWet) wetStops.push({ x: +shWet[1], z: +shWet[3] })
      if (shWet && OW_DEEP && !known.portal && have(/^bucket$/) && !have('water_bucket')) {
        await act('portal', { mode: 'cast', waterHint: { x: +shWet[1], y: +shWet[2], z: +shWet[3] }, timeoutSeconds: 60 })
        if (have('water_bucket')) log(`спуск: вода у колодца ${shWet[1]},${shWet[2]},${shWet[3]} — ведро полное`)
      }
      if (shWet && y() >= 50 && surfaceWet < 3) {
        await sense()
        if (sit.surface || y() >= 58) {
          surfaceWet++
          const dry = sh.detail && sh.detail.dryAt
          if (dry) {
            log(`спуск: вода под дёрном — к сухому возвышению ${dry.x},${dry.y},${dry.z}`)
            const g = await act('goto', { x: dry.x, y: dry.y, z: dry.z, range: 2, timeoutSeconds: 60, surface: 'strict' })
            if (g && g.status === 'done') { i--; continue }
          }
          const away = await awayFrom(wetOrigin({ x: +shWet[1], z: +shWet[3] }), 24 + 12 * surfaceWet).catch(() => null)
          if (away && away.status === 'done') { i--; continue }
        }
      }
      if (!(sh.detail && sh.detail.stopped) && (sh.detail && sh.detail.descended) > 0) { i--; continue }
      stairsDepth = 6
    }
    const d = await act('dig_down', { mode: 'stairs', depth: Math.min(stairsDepth, y() - toY), torchEvery: have('torch') ? 8 : 0, direction: dirs[i % 4], timeoutSeconds: 300 })
    if (await lavaStop(d)) return
    if (await mobInTheWay(d)) continue
    if (died) return
    if (d.detail && ((d.detail.dug ?? 0) >= 3 || (d.detail.steps ?? 0) >= 2) && !d.detail.stopped) continue
    const why = String((d.detail && d.detail.stopped) || d.error || '')
    const wet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if ((OW_DEEP || (NIGHT_DOWN2() && sit.night)) && wet && !/под ногами вода|я в воде/.test(why) && state.pos && y() < 55) {
      wetStops.push({ x: +wet[1], z: +wet[3] })
      const opts = [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]].map(([d, vx, vz]: any) => {
        const nx = state.pos.x + vx * 12; const nz = state.pos.z + vz * 12
        return { d, score: Math.min(...wetStops.map(w => Math.hypot(w.x - nx, w.z - nz))) }
      }).sort((a, b) => b.score - a.score)
      await spares(80)
      await act('tunnel', { direction: opts[0].d, length: 12, torchEvery: 0, timeoutSeconds: 90 })
      continue
    }
    if (wet || /под ногами вода|я в воде/.test(why)) {
      // Ночью поверху каждый переход к сухому месту — под мобами (cl-p 14.10: 6 попыток у болота, смерть): после второго отказа
      // спуск ночью здесь кончаю — главный цикл держит ночь в коробке.
      if (wet) wetStops.push({ x: +wet[1], z: +wet[3] })
      // Отход на 24 бл. ночью — ~12 с поверху (цена structure-value.NIGHT_SECONDS за секунду), коробка до рассвета — вся ночь
      // впустую (g3-s3-1 14.10: после второго отказа 9 мин ночи в коробке поверху, NO_BLOCKS, прогон без железа). Отход дороже
      // ожидания, враги рядом или пятый мокрый отказ подряд — тогда коробка (cl-p: шесть попыток у болота — смерть).
      if (nightHold() && wetStops.length >= 2) {
        await sense()
        const t = todNow()
        const toDawn = t !== null && t >= 11840 && t < 23460 ? (23460 - t) / 20 : 0
        const risk = 12 * structureValue.NIGHT_SECONDS
        if (wetStops.length >= 5 || (sit.foes ?? 0) > 0 || toDawn < risk) throw new Error('ночь, вода под дёрном — вниз здесь не выйдет, до рассвета в укрытии')
        log(`ночь: вода под дёрном — отхожу на 24 бл. (≈ ${risk} с риска поверху против ${Math.round(toDawn)} с до рассвета)`)
      }
      const away = await awayFrom(wetOrigin(wet ? { x: +wet[1], z: +wet[3] } : null), 24)
      if (away.status !== 'done') throw new Error('не смог отойти от воды — спуск здесь прекращаю')
      continue
    }
    if (/бьёт с дистанции|стреляет/.test(why)) {
      setFighting(true)
      try { await answerThreat() } finally { setFighting(false) }
      if (died) return
      await awayFrom(null, 20)
      continue
    }
    if (/пещер|пустот|лава/.test(why)) {
      await spares(80)
      await act('tunnel', { direction: dirs[i % 4], length: 8, torchEvery: 0, timeoutSeconds: 90 })
      continue
    }
    await spares(120)
    await act('dig_down', { mode: 'stairs', depth: Math.min(12, y() - toY), direction: dirs[i % 4], torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 240 })
    await torches()
  }
}
async function toSurface (tries = 4, deadline = Infinity) {
  const left = seconds => Math.max(0, Math.min(seconds, (deadline - gameClock.now()) / 1000))
  if (!left(1)) return false
  await sense()
  if (sit.inWater) {
    await leaveWater()
    await sense()
    if (died || sit.inWater) return false
  }
  const e = stairEntrance
  if (!sit.surface && e && e.dim === dim() && state.pos && e.y > y() + 2 && Math.hypot(e.x - state.pos.x, e.z - state.pos.z) <= 64) {
    log(`наверх своей лестницей к ${e.x},${e.y},${e.z}`)
    await act('goto', { x: e.x, y: e.y, z: e.z, range: 1, timeoutSeconds: left(90) })
    if (died) return false
    await sense()
    if (sit.surface) return true
  }
  let stalled = 0
  let shovelTried = false
  let blocksTried = false
  const wetTried = new Set()
  for (let i = 0; i < tries; i++) {
    await sense()
    if (sit.surface) return true
    if (!left(1)) return false
    await spares(120)
    const pick = await ensurePick()
    if (!left(1)) return false
    if (!pick) log('кирки нет и не из чего — лезу наверх рукой (камень 7.5 с за блок)')
    const from = state.pos && { ...state.pos }
    const r = await act('surface', { timeoutSeconds: left(pick ? 120 : 600), hand: !pick, preferPillar: pick })
    if (died || r.status === 'interrupted') return false
    if (r.detail && r.detail.out) return true
    if (!left(1)) return false
    // An open space under a sand overhang needs a lateral exit, not another identical vertical dig.
    if (r.detail?.pit === false && from) {
      const [dx, dz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][i % 4]
      await act('goto', { x: from.x + dx * 12, y: from.y, z: from.z + dz * 12, range: 2, timeoutSeconds: left(20), surface: 'strict' })
      await sense()
      if (sit.surface) return true
      continue
    }
    const why0 = String((r.detail && r.detail.stopped) || '')
    if (/лопат[аы]? в рюкзаке нет|нужна лопата|_shovel/.test(why0) && !have(/_shovel$/) && !shovelTried) {
      shovelTried = true
      await sticks(2)
      if (await craft(have(COBBLE) >= 1 ? 'stone_shovel' : 'wooden_shovel')) { log('сделал лопату — снег сверху копается'); continue }
    }
    const wet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(String((r.detail && r.detail.stopped) || ''))
    if (wet && state.pos) {
      const dx = state.pos.x - +wet[1]
      const dz = state.pos.z - +wet[3]
      let dir = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north')
      if (Math.hypot(dx, dz) < 1 || wetTried.has(dir)) dir = ['east', 'south', 'west', 'north'].find(d => !wetTried.has(d)) || dir
      wetTried.add(dir)
      const before = state.pos && { ...state.pos }
      const t = await act('tunnel', { direction: dir, length: 10, torchEvery: 0, timeoutSeconds: 90 })
      // Под озером штрек на этом уровне тоже упирается в воду над следующей клеткой (cl-b 14.10: десять кругов «подъём —
      // штрек» на месте, пауза этапа). Ниже на 3 и вбок на 16 — из-под воды, потом снова наверх.
      if (!died && before && state.pos && Math.hypot(state.pos.x - before.x, state.pos.z - before.z) < 2 && /вод/.test(String(t.detail?.stopped || t.error || ''))) {
        await act('dig_down', { mode: 'stairs', depth: 3, direction: dir, torchEvery: 0, timeoutSeconds: 60 })
        if (!died) await act('tunnel', { direction: dir, length: 16, torchEvery: 0, timeoutSeconds: 120 })
      }
      continue
    }
    // Столб и ступени не из чего (cl-c 14.10: 0 булыжника в пещере, «строить нечем» — 3 паузы этапов и простой): добыть
    // породы вокруг себя киркой, потом снова наверх.
    if (/строить нечем|нечем строить/.test(why0) && fillerCount() < 8 && pick && !blocksTried) {
      blocksTried = true
      await act('mine', { block: 'stone,deepslate,andesite,diorite,granite,tuff,dirt,grass_block,cobblestone,sandstone,netherrack', count: 12, radius: 8, timeoutSeconds: 45 })
      if (fillerCount() > 0) continue
    }
    // Над головой руда не по кирке (медь/железо деревянной; cl-f 14.10: «для copper_ore нужна кирка получше» — 18 мин на y 25):
    // шаг вбок штреком и снова наверх, по очереди во все стороны.
    // Над головой колонка песка/гравия (пустыня: 3–5 бл. песка над песчаником): подъём здесь её не прокопает — шаг вбок
    // штреком и снова наверх (cl-r 14.10: 100 мин под пустыней, голод до 0 и хп 1, все этапы «пустой заход»).
    if (/сыплется в забой/.test(why0) && i < tries - 1) {
      await act('tunnel', { direction: ['east', 'south', 'west', 'north'][i % 4], length: 6, torchEvery: 0, timeoutSeconds: 45 })
      continue
    }
    if (/нужна кирка получше/.test(why0) && i < tries - 1) {
      await act('tunnel', { direction: ['east', 'south', 'west', 'north'][i % 4], length: 4, torchEvery: 0, timeoutSeconds: 40 })
      continue
    }
    if (r.detail && /сыпуч|гравий|отойти/.test(String(r.detail.stopped || ''))) await walkAway(4, Math.PI / 2)
    else if (r.detail && /столб не встал|не смог шагнуть/.test(String(r.detail.stopped || '')) && state.pos) {
      const [dx, dz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][i % 4]
      await act('goto', { x: state.pos.x + dx * 10, y: state.pos.y, z: state.pos.z + dz * 10, range: 3, timeoutSeconds: 30, surface: false })
    }
    else if (r.detail && r.detail.stopped && from && state.pos &&
      Math.hypot(state.pos.x - from.x, state.pos.y - from.y, state.pos.z - from.z) < 1) {
      log(`подъём без прогресса — повтор не поможет: ${String(r.detail.stopped).slice(0, 180)}`)
      return false
    }
    if (from && state.pos && Math.hypot(state.pos.x - from.x, state.pos.y - from.y, state.pos.z - from.z) < 1) stalled++
    else stalled = 0
    if (stalled >= 2) { log('подъём и обход дважды без движения — прекращаю тратить сытость'); return false }
  }
  await sense()
  return !!sit.surface
}

export { descend, toSurface }
