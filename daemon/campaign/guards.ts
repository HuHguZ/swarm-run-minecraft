'use strict'
// Отдых и ночь: rest, укрытие до утра, ночная стража, возврат после смерти, склад у базы.
import { NIGHT_DOWN, NIGHT_DOWN2 } from './flags'
import { call, sleep } from './rpc'
import { state, sit, restIdleUntil, died, lostBag, lostAt, resting, fighting, known, routeHealing, blazeDugInAt,
  blazeDugInPos, setDetached, setDied, setFighting, setRestIdleUntil, setResting } from './state'
import { log } from './log'
import { have, y, dim, RAW, FOOD, planksFor, portalFar } from './queries'
import { sense, refresh, readMemory } from './observe'
import { canWorkAtNight } from './stages/table'
import { act } from './act'
import { afterRefuge, refugeRun, waitDugOut } from './danger'
import { homeLeash, walkAway, goToward, returnFromNether } from './travel'
import { craft, ensurePick } from './kit'
import { makeBed, cook } from './food'
import * as gameClock from '../src/game-clock'
async function rest (minHp = 16) {
  setResting(true)
  try {
    await sense()
    if (sit.buried) await waitDugOut()
    if (sit.inWater) {
      const was = fighting
      setFighting(true)
      try { await act('surface', { targetY: y() + 2, timeoutSeconds: 30, preferPillar: false }) } finally { setFighting(was) }
      await sense()
      for (let k = 0; k < 2 && sit.inWater && !died && state.pos; k++) {
        setFighting(true)
        try { await walkAway(12, k ? 1.2 : 0) } finally { setFighting(was) }
        await sense()
      }
      if (died) return
      if (sit.inWater) {
        if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
        await shelterFailed('WATER', 'не вышел из воды — лечение ожиданием небезопасно')
        return
      }
    }
    log(`мало хп (${Math.round(state.health)}) — прячусь и отлёживаюсь`)
    // Навык blaze оставил тело в своей яме под ифритами — укрытие уже есть: refuge выводил из ямы под шары (S1d s1d-N-3: хп 8 → 3 → 0
    // за секунду, «CORNERED»). Лечиться в яме: еда и ожидание.
    const inBlazePit = dim() === 'the_nether' && gameClock.now() - blazeDugInAt < 180000 && !!blazeDugInPos && !!state.pos &&
      Math.hypot(blazeDugInPos.x - state.pos.x, blazeDugInPos.z - state.pos.z) < 1.5 && Math.abs(blazeDugInPos.y - state.pos.y) < 1.5
    if (inBlazePit) {
      log('в яме навыка blaze — лечусь в ней, не выхожу')
      if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
      await act('wait', { seconds: 20 })
      return
    }
    if (sit.foes > 0) await refugeRun(`мало хп (${Math.round(state.health ?? 0)}), врагов ${sit.foes}`)
    if (died || (state.health ?? 0) >= minHp) return
    await sense()
    if (!have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 &&
        (!sit.night || (dim() === 'overworld' && state.playPolicy?.mode === 'speedrun'))) {
      if (!sit.night && process.env.ND_REFUGE_SIT !== '0' && sit.foes > 0 && (state.health ?? 20) < 10 && !died) {
        log(`еды нет, рассвет, хп ${Math.round(state.health ?? 0)}, врагов рядом ${sit.foes} — сижу, пока не сгорят или уйдут`)
        await refugeRun(`рассвет, хп мало, врагов ${sit.foes}`, { minHp: 20, maxSeconds: 120 })
        if (died) return
        await sense()
      }
      log(`еды нет, ${sit.night ? 'ночь спидрана' : 'день'} — лечит только охота, иду`)
      setRestIdleUntil(gameClock.now() + 60000)
      return
    }
    if (have(RAW) && !sit.foes && !(routeHealing && process.env.ND_ROUTE_ENTERHEAL !== '0')) await cook()
    if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
    if ((state.health ?? 0) >= minHp) return
    if (dim() === 'overworld' && state.playPolicy?.mode !== 'speedrun' && sit.night && sit.foes === 0 && !sit.buried) {
      await readMemory()
      const sb = known.spawnBed
      const closeBed = sb && state.pos && Math.hypot(sb.x - state.pos.x, sb.y - state.pos.y, sb.z - state.pos.z) <= 8
      if (closeBed || sit.bed || have(/_bed$/)) {
        log('восстановление ночью — сначала пробую ближайшую кровать')
        const r = await act('sleep', process.env.ND_ROUTE === '1' && have(/_bed$/) > 0 && !closeBed
          ? { untilMorning: true, take: true, timeoutSeconds: 120 }
          : { untilMorning: true, take: false, bunker: false, invite: false, waitSeconds: 10, timeoutSeconds: 60 })
        await sense()
        if ((state.health ?? 0) >= minHp) return
        if (r.detail?.morning && !sit.night && !have(FOOD) && !have(RAW) && (state.food ?? 20) < 18) {
          setRestIdleUntil(gameClock.now() + 60000)
          await act('shelter', { mode: 'exit' })
          log('ночь пропущена — иду за едой, ожидание не восстановит хп')
          return
        }
      }
    }
    // Домой с малым хп — только если портал рядом: путь по Аду в 100+ бл. с 4–8 хп кончался смертью (s1c-A-7 06.10: хп 8 у спавнера,
    // «домой через портал» 170 бл., иссушитель на первых шагах). Далеко — в толщу на месте и лечиться (цена пути против риска).
    // И портал близко, но враги рядом или до него больше 8 бл. — тоже в толщу: путь к порталу в 29–60 бл. под ифритами и пиглинами
    // с 7–9 хп кончался смертью у самой рамы (b0-6-1, b1-6-2 14.10), а стояние 4 с в портале — под их ударами.
    const portalDist = !known.netherPortal || !state.pos ? Infinity : Math.hypot(known.netherPortal.x - state.pos.x, known.netherPortal.z - state.pos.z)
    const portalFar = portalDist > 8 || (sit.foes ?? 0) > 0
    if ((process.env.ND_NE_STAY === '1' || portalFar) && dim() === 'the_nether' && (have(FOOD) || (state.food ?? 0) >= 18)) {
      const bw = await act('ne_burrow', { why: 'лечиться в Аду' })
      await refresh()
      if (process.env.ND_HEAL_WORLD_STATE === '1' && (died || (state.health ?? 0) >= minHp)) return
      const bd = bw.detail || {}
      if (!died && dim() === 'the_nether' && (bd.ok || /уже в своём штреке/.test(bd.why || ''))) {
        log(`в Аду мало хп — лечусь в толще${portalFar ? ' (портал далеко)' : ' (ND_NE_STAY)'}`)
        for (let i = 0; i < 12 && (state.health ?? 20) < minHp && !died; i++) {
          if ((state.food ?? 20) < 20 && (have(FOOD) || have(RAW))) await act('eat')
          if (process.env.ND_HEAL_WORLD_STATE === '1' && ((state.health ?? 0) >= minHp || (state.food ?? 20) < 18)) break
          const w = await act('wait', { seconds: 10 })
          if (w.status === 'interrupted' || (w.by && w.by.type === 'damage')) break
        }
        return
      }
      // Нора не вышла, а враги рядом или портал дальше 64 бл. — путь домой под ними хуже коробки на месте (b8-5-2 14.10: брут у
      // бастиона, нора не вышла, «домой через портал» 71 бл. — смерть на первых шагах штрека).
      if (!died && dim() === 'the_nether' && ((sit.foes ?? 0) > 0 || portalDist > 64)) {
        log(`в Аду мало хп, нора не вышла (${bd.why || bd.pit || '?'}) — коробка на месте, не путь домой`)
        await refugeRun(`отлёжка: хп ${Math.round(state.health ?? 0)}`, { minHp, maxSeconds: 120 })
        return
      }
    }
    if (dim() === 'the_nether' && known.netherPortal) {
      log('в Аду мало хп — домой через портал, лечиться там')
      if (await returnFromNether()) {
        if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
        for (let i = 0; i < 12 && (state.health ?? 20) < minHp && !died; i++) {
          if (process.env.ND_HEAL_WORLD_STATE === '1' && (state.food ?? 20) < 18) break
          const w = await act('wait', { seconds: 10 })
          if (w.by && w.by.type === 'damage') break
          if ((state.food ?? 20) < 18 && (have(FOOD) || have(RAW))) await act('eat')
        }
        return
      }
    }
    if (!have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && sit.night && dim() === 'overworld') {
      await holeTillMorning()
      return
    }
    await refugeRun(`отлёжка: хп ${Math.round(state.health ?? 0)}`, { minHp, maxSeconds: 120 })
  } finally { setResting(false) }
}

let nightSatUntil = 0
async function holeTillMorning () {
  if (gameClock.now() < shelterFailUntil) return
  if (NIGHT_DOWN && gameClock.now() < nightSatUntil) { log('ночь: аварийно уже отсидел — работаю внизу'); setRestIdleUntil(Math.max(restIdleUntil, nightSatUntil)); return }
  if (!have(/_pickaxe$/)) await ensurePick()
  if (!(await restShelter())) return
  log(NIGHT_DOWN ? 'еды нет, ночь — авария: сижу в норе до 4 мин, потом работаю внизу' : 'еды нет, ночь — сижу в норе до утра')
  for (let k = 0; k < (NIGHT_DOWN ? 8 : 40) && !died; k++) {
    const w2 = await act('wait', { seconds: 30 })
    if (w2.by && w2.by.type === 'damage' && !died && !(await restShelter())) return
    await sense()
    if (!sit.night) break
  }
  if (NIGHT_DOWN && sit.night && !died) { nightIdleS += 240; setRestIdleUntil(gameClock.now() + 600000); nightSatUntil = gameClock.now() + 600000; log('ночь: 4 мин в норе — дальше работаю внизу, наверх не лезу'); return }
  log('еды нет — лечиться нечем, иду за едой')
  if (!died) await act('shelter', { mode: 'exit' })
}

const closedShelter = r => r.status === 'done' && r.detail?.sealed === true
async function restShelter () {
  let r = await act('shelter', { mode: 'enter', depth: 3 })
  if (!closedShelter(r) && !died) {
    const why = String((r.detail && r.detail.stopped) || r.error || '')
    await sense()
    if (sit.inWater || /вод/.test(why)) {
      for (let k = 0; k < 2 && !died && state.pos; k++) { await walkAway(12, k ? 1.2 : 0); await sense(); if (!sit.inWater) break }
    } else {
      try { await act('surface', { targetY: y() + 2, timeoutSeconds: 30, preferPillar: false }) } catch {}
    }
    if (!died) r = await act('shelter', { mode: 'enter', depth: 3 })
  }
  if (!closedShelter(r)) {
    await refresh()
    if (died) return false
    if ((state.health ?? 0) >= 8) { log(`нора не закрылась, хп ${Math.round(state.health)} — дальше без отлёжки`); setRestIdleUntil(gameClock.now() + 90000); return false }
    await shelterFailed('NO_SEAL', 'укрытие не закрыто — лечение ожиданием небезопасно')
    return false
  }
  return true
}

let shelterFailUntil = 0
let shelterRisks = 0
async function shelterFailed (klass, reason) {
  shelterRisks++
  shelterFailUntil = gameClock.now() + 180000
  setRestIdleUntil(Math.max(restIdleUntil, gameClock.now() + 90000))
  log(`РИСК укрытие:${klass} — ${reason}; не отключаюсь: ухожу от угроз и продолжаю (${shelterRisks}-й за запуск)`)
  await sense()
  if ((sit.foes > 0 || (state.health ?? 20) < 16) && !died) await refugeRun(`укрытие:${klass} — ${reason}`)
}
async function abortUnsafe (reason) {
  reason = `БЛОКЕР: ${reason}`
  log(reason)
  try { await call('stop') } catch (e) { log(`stop RPC-ОШИБКА ${e.message}`) }
  try { await call('disconnect', { reason }); setDetached(true) } catch (e) { log(`disconnect RPC-ОШИБКА ${e.message}`) }
  const error: any = new Error(reason)
  error.stopCampaign = true
  throw error
}

let guarding = false
let nightWorkSaidAt = 0
async function nightGuard (opts = {}) {
  if (guarding) return
  guarding = true
  try { await nightGuardBody(opts) } finally { guarding = false }
}
async function nightGuardBody ({ afterDeath = false, dusk = false } = {}) {
  await sense()
  if (dim() !== 'overworld') return
  if (state.playPolicy?.mode === 'speedrun') return
  if (sit.night || sit.dusk) await makeBed()
  await readMemory()
  const sb = known.spawnBed
  const sbFar = sb && state.pos ? Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) : Infinity
  const homeBed = sbFar <= (sit.night ? 24 : 96)
  const bed = have(/_bed$/) > 0 || sit.bed || homeBed
  if (!sit.night) nightHoles = 0
  const duskDown = dusk && NIGHT_DOWN2() && sit.dusk && sit.surface && !sit.night
  if (!(sit.night || duskDown || (sit.dusk && bed))) return
  if (!bed && !afterDeath && !duskDown && canWorkAtNight()) {
    if (gameClock.now() - nightWorkSaidAt > 60000) {
      log('ночь без видимых угроз: продолжаю работу; кровать — ближайшая цель охоты')
      nightWorkSaidAt = gameClock.now()
    }
    return
  }
  if (!sit.surface && !bed) {
    if (!sit.night) return
    if (NIGHT_DOWN) { await nightBelow('под крышей'); return }
    log('ночь, я под крышей — жду утра здесь')
    for (let i = 0; i < 40 && !died; i++) {
      await act('wait', { seconds: 30 })
      await sense()
      if (!sit.night) break
    }
    if (!died) await act('shelter', { mode: 'exit' })
    return
  }
  if (bed) {
    if (homeBed && sbFar > 6) {
      log(`к своей кровати-точке ${sb.x},${sb.y},${sb.z} (${Math.round(sbFar)} блоков)`)
      await goToward(sb, 3)
    }
    log(sit.night ? 'ночь — сплю' : 'сумерки — ставлю кровать, лягу с темнотой')
    await refresh()
    const nearHome = sb && state.pos ? Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) <= 8 : false
    const carry = !nearHome && have(/_bed$/) > 0
    const r = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: carry })
    if (r.detail && r.detail.morning) return
    if (/монстр/.test(String((r.detail && (r.detail.note || r.detail.stopped)) || r.error || '')) && have(/_bed$/) > 0) {
      await act('flee', { timeoutSeconds: 12 })
      const r2 = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: true })
      if (r2.detail && r2.detail.morning) return
    }
    if (/негде поставить кровать/.test(String((r.detail && (r.detail.stopped || r.detail.note)) || r.error || '')) && have(/_bed$/) > 0) {
      await walkAway(12)
      const r3 = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: true })
      if (r3.detail && r3.detail.morning) return
    }
    await sense()
    if (!sit.night) return
  }
  if (process.env.ND_NIGHT_BOX === '1' && !NIGHT_DOWN && !died && dim() === 'overworld') {
    log('ночь наверху без кровати — укрытие до рассвета')
    const r = await refugeRun('ночь наверху: до рассвета', { minHp: 20, untilDawn: true, force: true })
    await sense()
    if (died || !sit.night || (r && r.detail && r.detail.code === 'OK' && r.detail.how !== 'flee')) return
  }
  if (gameClock.now() < shelterFailUntil) return
  await sense()
  if (sit.foes > 0 && !died) {
    log(`ночь, врагов рядом ${sit.foes} — нору под ними не копаю, сперва ответ`)
    if (!NIGHT_DOWN) await afterRefuge()
    await sense()
    if (NIGHT_DOWN && sit.foes > 0 && !died) {
      const r = await act('refuge', { minHp: 16, maxSeconds: 60, stayIn: true, why: `ночь: врагов ${sit.foes} у норы — коробка и вниз из неё` })
      if (died) return
      if (r.detail && r.detail.stayed) {
        if (!have(/_pickaxe$/)) await ensurePick()
        const h = await act('shelter', { mode: 'enter', depth: 3 })
        if (died) return
        if (closedShelter(h)) { nightHoles++; await nightBelow('нора из коробки'); return }
        log('из коробки вниз не вышло — дальше по-старому')
      }
      await sense()
      if (!(r.detail && r.detail.stayed) && sit.foes > 0 && !died) { await afterRefuge(); await sense() }
    } else if (sit.foes > 0 && !died) await refugeRun(`ночь: врагов ${sit.foes} у норы`)
    if (died) return
  }
  log('ночь на поверхности — в нору до рассвета')
  if (!have(/_pickaxe$/)) await ensurePick()
  let s = await act('shelter', { mode: 'enter', depth: 3 })
  if (!closedShelter(s)) {
    for (let k = 0; k < 3; k++) {
      await walkAway(k ? 16 : 12, k ? 1.2 : 0)
      await sense()
      if (!sit.night) return
      if (!sit.inWater) break
    }
    if (!sit.inWater && !afterDeath && canWorkAtNight()) { log('на суше, угроз нет — работаю ночью'); return }
    s = await act('shelter', { mode: 'enter', depth: 3 })
  }
  if (!closedShelter(s)) { await shelterFailed('NIGHT', 'обе норы не закрыты — ночное ожидание небезопасно'); return }
  if (NIGHT_DOWN && !died) {
    nightHoles++
    if (nightHoles <= 2) { await nightBelow('нора закрыта'); return }
    log(`РИСК ночь: ${nightHoles}-я нора за ночь — наверху работать нельзя, жду утра в норе`)
  }
  for (let i = 0; i < 40; i++) {
    await act('wait', { seconds: 30 })
    if (died) return
    await sense()
    if (!sit.night) break
  }
  await act('shelter', { mode: 'exit' })
}
let nightHoles = 0
let nightIdleS = 0
async function nightBelow (why) {
  log(`ночь (${why}) — утра не жду, работаю внизу; хп ${Math.round(state.health ?? 0)}, еда ${state.food ?? '?'}`)
  const t0 = gameClock.now()
  for (let i = 0; i < 8 && !died; i++) {
    await sense()
    if (!sit.night || canWorkAtNight()) break
    if (sit.foes > 0) break
    const hp = state.health ?? 20
    const food = have(FOOD) || have(RAW)
    if (food && (state.food ?? 20) < 20 && hp < 16) { await act('eat'); continue }
    const heals = hp < 16 && ((state.food ?? 0) >= 18 || food)
    const emergency = hp < 10 && !food
    const capS = emergency ? 240 : 180
    if (!(heals || emergency) || gameClock.now() - t0 > capS * 1000) break
    if (i === 0) log(emergency ? `хп ${Math.round(hp)} и лечиться нечем — авария: сижу в норе (до ${capS / 60} мин)` : `хп ${Math.round(hp)} — отлёживаюсь (реген), до ${capS / 60} мин`)
    await act('wait', { seconds: 30 })
  }
  const s = Math.round((gameClock.now() - t0) / 1000)
  nightIdleS += s
  if (s >= 20) log(`ночь: ожидание ${s} с (за запуск ${nightIdleS} с) — дальше работа`)
}

async function recoverGuard () {
  await refresh()
  if (died) {
    setDied(false)
    for (let k = 0; k < 20 && (state.health ?? 0) <= 0; k++) { await sleep(500); await refresh() }
    if ((state.health ?? 0) <= 0) await abortUnsafe('возрождение не подтвердилось — действия мёртвым телом не начинаю')
    await refresh()
    if (Object.keys(state.inventory || {}).length >= 3) {
      log('умер, но вещи при мне (keep_inventory) — к делу')
      await sense()
      if (dim() === 'overworld' && sit.night && sit.surface) {
        log('ночь, я наверху после возрождения — в укрытие до рассвета')
        if (sit.foes > 0) await afterRefuge()
        await nightGuard({ afterDeath: true })
      }
      return
    }
    const worth = Object.keys(lostBag || {}).filter(k => /iron|gold|diamond|obsidian|bucket|_bed$|ender|blaze|shield|bow|arrow|flint_and_steel|netherite|emerald|cooked_/.test(k))
    const far = lostAt && state.pos ? Math.hypot(lostAt.x - state.pos.x, lostAt.z - state.pos.z) : 0
    if (!worth.length || far > 600) {
      log(`умер; за вещами не иду — ${worth.length ? `далеко (${Math.round(far)} блоков)` : 'ценного не было'}, собираю заново`)
      return
    }
    log(`умер — пробую забрать вещи (${worth.join(', ')}; ${Math.round(far)} блоков)`)
    const r = await act('recover', { timeoutSeconds: far > 300 ? 300 : 240 })
    if (r.detail && r.detail.stopped) log('за вещами не пройти — собираю заново')
  }
  if (dim() === 'overworld' && known.portal && portalFar() < 48 && !have(/_pickaxe$/)) await sense()
  if (dim() === 'overworld' && known.portal && portalFar() < 48 && !have(/_pickaxe$/) && !sit.night) {
    if (portalFar() > 10) await act('goto', { x: known.portal.x, y: known.portal.y, z: known.portal.z, range: 3, timeoutSeconds: 40 })
    const t = await act('chest_take', { item: 'all' })
    if (t.status === 'done') { log('взял запас из сундука базы'); baseStocked = false }
  }
  if ((state.health ?? 20) < 12 && !resting) await rest()
  await homeLeash()
}

let baseStocked = false
async function baseDeposit () {
  if (!known.portal || dim() !== 'overworld') return
  if (portalFar() > 8) await goToward(known.portal, 4)
  await refresh()
  const list = await act('chest_list', {})
  if (list.status !== 'done') {
    if (!have('chest')) {
      if (have(/_planks$/) < 8) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('chest')
    }
    if (have('chest')) await act('place', { block: 'chest' })
  }
  const keep = { iron_ingot: 2, cobblestone: 96 }
  const put = []
  for (const [k, v] of (Object.entries(state.inventory || {}) as any)) {
    if (keep[k] !== undefined && v > keep[k]) put.push([k, v - keep[k]])
    else if (/^(raw_iron|raw_copper|raw_gold|diamond|lapis_lazuli|coal)$/.test(k)) put.push([k, v])
  }
  const food = Object.entries(state.inventory || {}).filter(([k]) => FOOD.test(k)).sort((a: any, b: any) => a[1] - b[1])
  let extra = have(FOOD) - 16
  for (const [k, v] of food) { if (extra <= 0) break; const n = Math.min(Number(v), extra); put.push([k, n]); extra -= n }
  if (have('stone_pickaxe') > 2) put.push(['stone_pickaxe', have('stone_pickaxe') - 2])
  for (const [item, count] of put) await act('chest_put', { item, count })
  if (put.length) { baseStocked = true; log(`база: в сундук — ${put.map(([k, n]) => k + '×' + n).join(', ')}`) }
}

export { rest, closedShelter, nightGuard, recoverGuard, baseDeposit }
