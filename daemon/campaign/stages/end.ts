'use strict'
// Этапы Края: pearls, eyes, endkit, stronghold, dragon и готовность DONE поздних этапов.
import { EYES_NEED, BEDS_END, END_PREP_PRICE } from '../flags'
import { state, sit, died, known, bastionDry, endkitRuns, setEndkitRuns, setHuntWool, setWantBeds } from '../state'
import { log } from '../log'
import { have, dim, LOGS, FOOD, foodUnits, planksFor, fillersNow, nearBastion, shieldOn, spawnAtPortal, lighter,
  pearlsNow, arrowsNow } from '../queries'
import { sense, refresh, readMemory } from '../observe'
import { READY, DONE, defStage, FOOD_STOCK, entrySupplies, stageRun } from './table'
import { EXIT_KIT, obsShort, eyesWant, notePortalEyes, nextBastion, rodsWanted, PEARL_STYLE, pearlTrips, emptyForests,
  failedHuntSites, forestEmpty, forestToHunt, endermenSecondsPerPearl } from '../nether-plan'
import { act } from '../act'
import { nightGuard, recoverGuard } from '../guards'
import { goToward, returnFromNether } from '../travel'
import { craft, sticks, sticksReserve, spares, lumber, mineSeenAll, smeltAll } from '../kit'
import { makeBed } from '../food'
import { enterNether } from '../nether-trip'
import { OBSIDIAN_END, obsidianEnd, ARROWS_END, BUCKETS_END, fillNow, fillWant, waterWant, ENDKIT_OFF, END_SEAM,
  endPrepRelevant, endPrepOffer, pricedEndPrep, checkEndEntry, endkitPending, SH_NETHER, SH_BLIND, SH_NETHER_MIN,
  canLink, viaNetherTo } from '../endgame'
import * as gameClock from '../../src/game-clock'
defStage('pearls', () => !!known.portal && have('ender_pearl') + have('ender_eye') < eyesWant(), async () => {
  if (dim() !== 'the_nether') {
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
    }
    await sticksReserve()
    await act('kit', { for: 'nether' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  // Эндермены в Аду живут в искажённом лесу (WarpedForest спавнит только их и страйдеров) — охота там, а не у портала (s1-SB-1/s1c-A-6
  // 06.10: «foxhole» у портала — 0 убийств за 5 заходов). S1e: лес — по видимости (nether-forest.js: видимый нилий + биом F3 под
  // ногами, решение пользователя 09:19/09:24), не по /locate biome (S1d: «лес» по locate на y 70 — 0 нилия в 24 бл., 34 окопа без
  // единого эндермена). Не видел леса — разведка обзором (глаза пишут лес сами), а не охота где попало.
  let warped = forestToHunt()
  if (!warped && dim() === 'the_nether' && !died) {
    log('эндермены: искажённого леса глазами не видел (или видел пустым) — разведка обзором до видимого нилия')
    const ex = await act('explore', { block: 'warped_nylium', radius: 96, stepDistance: 64, timeoutSeconds: 240 })
    await readMemory()
    warped = forestToHunt()
    const at = ex && ex.detail && ex.detail.found && ex.detail.at
    if (!warped && at && !forestEmpty(at)) warped = { x: at.x, y: at.y + 1, z: at.z, note: 'увидел нилий разведкой' }
    // S1f: не нашёл — неудача стратегии (директор отступает по времени и берёт другие: стержни), а не «успех без прогресса»: s1f-H1-1 —
    // HuntEndermen выбран 17 раз подряд, 45 игр. мин разведки нилия без леса, крепость известна, к спавнеру не вернулся. ND_EM_FAIL=0 — прежнее.
    if (!warped) { pearlTrips.zero = 2; log('эндермены: леса не нашёл — охоту не начинаю'); if (process.env.ND_EM_FAIL !== '0') throw new Error('эндермены: искажённого леса не нашёл'); return }
  }
  if (warped && dim() === 'the_nether' && state.pos && Math.hypot(warped.x - state.pos.x, warped.z - state.pos.z) > 4) {
    log(`эндермены: к искажённому лесу ${warped.x},${warped.y},${warped.z} (${Math.round(Math.hypot(warped.x - state.pos.x, warped.z - state.pos.z))} бл., ${warped.note || ''})`)
    await goToward({ x: warped.x, y: warped.y, z: warped.z }, 16)
    await refresh()
    // Штрек кончается в толще у леса — окопу нужен открытый пол леса (s1c-E-1 06.10: «эндерменов не вижу», 5 заходов по 400 с
    // из штрека, 0 убийств): на сам увиденный нилий (запись — видимый блок + 1).
    if (!died && dim() === 'the_nether') { await act('goto', { x: warped.x, y: warped.y, z: warped.z, range: 2, timeoutSeconds: 60 }); await refresh() }
  }
  for (let i = 0; i < 8 && have('ender_pearl') + have('ender_eye') < eyesWant(); i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    if ((state.health ?? 20) < 14 && have(FOOD)) await act('eat')
    await spares(400)
    if (fillersNow() < 12 && !nearBastion(state.pos, 90)) {
      await act('mine', { block: 'netherrack', count: 24, radius: 8, timeoutSeconds: 90 })
      await refresh()
    }
    if (fillersNow() < 6) { log(`блоков на окоп нет (${fillersNow()}) — охоту не начинаю`); break }
    const p0 = have('ender_pearl')
    const tHunt = gameClock.now()
    const h = await act('pearls', { ...(process.env.ND_BASTION_PRICE === '1' ? { mode: 'hunt' } : {}), count: eyesWant() - have('ender_eye') - have('ender_pearl'), timeoutSeconds: 400, style: PEARL_STYLE })
    await refresh()
    const hd = (h && h.detail) || {}
    if (process.env.ND_EM_PRICE_RECEIPTS !== '1') {
      pearlTrips.seconds += (gameClock.now() - tHunt) / 1000
      pearlTrips.pearls += Math.max(0, have('ender_pearl') - p0)
      if (process.env.ND_NE_RECOVER !== '1' || hd.prepared !== false) pearlTrips.zero = (Number(hd.seenEndermen) || 0) > 0 ? 0 : pearlTrips.zero + 1
    }
    if (process.env.ND_NE_RECOVER === '1' && hd.prepared === false) {
      if (state.pos) failedHuntSites.push({ ...state.pos })
      throw new Error('эндермены: окоп не подготовлен — другой наблюдаемый участок, лес не объявляю пустым')
    }
    log(`жемчуг: ${have('ender_pearl')} (+очей ${have('ender_eye')}); эндерменов в виду за заход ${hd.seenEndermen ?? '?'}; цена ${Math.round(endermenSecondsPerPearl())} с/жемчуг`)
    // Два захода подряд без единого эндермена в виду — место пустое (S1d: 23–40 мин охоты без единого): лес помечен, охота кончена.
    if (pearlTrips.zero >= 2) {
      pearlTrips.zero = 0
      log('эндермены: 2 захода подряд без единого в виду — место пустое, охоту прекращаю')
      if (state.pos) emptyForests.push({ x: state.pos.x, z: state.pos.z })
      break
    }
  }
})

defStage('eyes', () => have('ender_eye') < eyesWant() && have('ender_pearl') > 0 && (have('blaze_rod') + have('blaze_powder')) > 0, async () => {
  const want = Math.min(eyesWant() - have('ender_eye'), have('ender_pearl'))
  if (have('blaze_powder') < want) await craft('blaze_powder', Math.min(2 * have('blaze_rod'), want - have('blaze_powder') + 1))
  await craft('ender_eye', Math.min(want, have('blaze_powder')))
})
defStage('endkit', () => endkitPending() && dim() === 'overworld', async () => {
  if (END_PREP_PRICE) { await pricedEndPrep(); return }
  setEndkitRuns(endkitRuns + 1)
  await nightGuard()
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  const bucketsLack = () => Math.max(0, waterWant() - have('water_bucket') - have(/^bucket$/))
  if (bucketsLack() > 0) {
    await refresh()
    const ironWant = () => 3 * bucketsLack()
    for (let k = 0; k < 5 && have('iron_ingot') + have('raw_iron') < ironWant() && !died; k++) {
      await nightGuard()
      const m = await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: ironWant() - have('iron_ingot') - have('raw_iron'), radius: 48, timeoutSeconds: 150 })
      if (m.detail && m.detail.dug) continue
      await mineSeenAll('iron_ore,deepslate_iron_ore', 48)
      if (have('iron_ingot') + have('raw_iron') >= ironWant()) break
      const e = await act('explore', { block: 'iron_ore', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
      if (!(e.detail && e.detail.found)) break
    }
    await smeltAll('raw_iron', 'iron_ingot')
    for (let k = 0; k < BUCKETS_END && bucketsLack() > 0 && have('iron_ingot') >= 3; k++) { await craft('bucket'); await refresh() }
  }
  for (let k = 0; k < BUCKETS_END && have(/^bucket$/) && have('water_bucket') < BUCKETS_END && !died; k++) {
    const n = have('water_bucket')
    await act('bucket', { fluid: 'water', radius: 48 })
    await refresh()
    if (have('water_bucket') <= n) break
  }
  if (fillNow() < fillWant()) {
    const m = await act('mine', { block: 'stone,deepslate,andesite,diorite,granite,tuff', count: Math.min(64, fillWant() - fillNow()), radius: 24, timeoutSeconds: 120 })
    await refresh()
    log(`блоки на Край: ${fillNow()} из ${fillWant()}${m.detail && m.detail.dug ? '' : ' (не добыл)'}`)
  }
  for (let k = 0; k < 2 && have('golden_apple') < 2 && have('apple') > 0 && have('gold_ingot') + 9 * have('gold_block') >= 8 && !died; k++) {
    if (have('gold_ingot') < 8 && have('gold_block')) await craft('gold_ingot', 9)
    const n = have('golden_apple')
    await craft('golden_apple')
    await refresh()
    if (have('golden_apple') <= n) break
  }
  if (have(/_bed$/) < BEDS_END) {
    const l = await act('structure', { mode: 'list' })
    const v = ((l.detail && l.detail.known) || []).filter(x => x.kind === 'village' && x.dist != null && x.dist < 800).sort((a, b) => a.dist - b.dist)[0]
    if (v) {
      log(`за кроватями — деревня ${v.at.x},${v.at.z} (${v.dist} бл.)`)
      for (let k = 0; k < 8 && !died; k++) { await nightGuard(); if (await goToward(v.at, 24)) break }
      await act('structure', { mode: 'explore', kind: 'village', x: v.at.x, z: v.at.z, beds: BEDS_END, timeoutSeconds: 240 })
      await refresh()
      log(`деревня: кроватей ${have(/_bed$/)}`)
    }
  }
  if (have(/_bed$/) < BEDS_END) {
    setWantBeds(BEDS_END)
    setHuntWool(true)
    try { await stageRun('food')() } finally { setHuntWool(false) }
    for (let k = 0; k < BEDS_END && have(/_bed$/) < BEDS_END; k++) {
      const n = have(/_bed$/)
      if (have(/_planks$/) < 3 && !have(LOGS)) await lumber(2)
      await makeBed()
      await refresh()
      if (have(/_bed$/) <= n) break
    }
    setWantBeds(1)
  }
  if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow') }
  for (let k = 0; k < 8 && arrowsNow() < ARROWS_END && have('feather') && !died; k++) {
    if (!have('flint')) {
      const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 40, timeoutSeconds: 120 })
      if (!(g.detail && g.detail.dug)) break
      await refresh()
      if (!have('flint')) continue
    }
    await sticks(2)
    const c: any = await craft('arrow', 4)
    if (c && c.status !== 'done') break
  }
  if (!have(/_boat$/)) {
    if (have(/_planks$/) < 5 && !have(LOGS)) await lumber(3)
    if (have(/_planks$/) < 5) { const p = planksFor(); if (p) await craft(p, 8) }
    await act('ride', { kind: 'boat', mode: 'craft' })
    await refresh()
  }
  if (obsidianEnd() < OBSIDIAN_END && have(/^(diamond|netherite)_pickaxe$/) && !died) {
    await act('obsidian', { count: OBSIDIAN_END - obsidianEnd(), radius: 24, timeoutSeconds: 300 })
  }
  log(`набор на дракона: кроватей ${have(/_bed$/)}, обсидиана ${obsidianEnd()}, стрел ${arrowsNow()}, вёдер воды ${have('water_bucket')}, блоков ${fillNow()}, золотых яблок ${have('golden_apple')}, лук ${have('bow') ? 'есть' : 'нет'}, лодка ${have(/_boat$/) ? 'есть' : 'нет'}`)
})
defStage('stronghold', () => dim() !== 'the_end' && (have('ender_eye') >= Math.min(10, EYES_NEED) || !!known.endPortal) && (!known.endPortal || process.env.ND_END_ENTRY !== '0') &&
  // ND_GRAPH_END_ORDER: крепость ищется и с несобранным набором на дракона; найден портал — набор (endkit), затем вход.
  (!endkitPending() || (process.env.ND_GRAPH_END_ORDER === '1' && !known.endPortal)), async () => {
  if (known.endPortal && process.env.ND_END_ENTRY !== '0') {
    if (dim() !== 'overworld') return
    notePortalEyes(await act('stronghold', { mode: 'room', timeoutSeconds: 120 }))
    notePortalEyes(await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 90 }))
    await refresh()
    return
  }
  if (dim() === 'the_nether') {
    const stay = process.env.ND_SH_STAY === '1' || process.env.ND_END_ENTRY !== '0'
    let out = false
    if (obsShort() && (EXIT_KIT || (nextBastion() && bastionDry < 3))) {
      log(`выход у крепости Края — нужно 10 обсидиана, есть ${have('obsidian')}: сперва бартер (ND_OBS_EXIT)`)
      return
    }
    if (SH_NETHER && known.stronghold && canLink()) {
      out = await viaNetherTo({ x: known.stronghold.x, z: known.stronghold.z }, 'к крепости Края')
      if (out && !stay) return
    } else if (SH_BLIND && !known.stronghold && canLink() && state.pos) {
      const b = await act('stronghold', { mode: 'blind' })
      const plan = (b.detail && b.detail.overworld) ? b.detail : null
      out = !!(plan && await viaNetherTo(plan.overworld, `слепой выход (в среднем ~${plan.expectThere} бл. до крепости)`))
      if (out && !stay) return
    }
    if (!out || dim() !== 'overworld') {
      if (EXIT_KIT && SH_NETHER && known.stronghold) { log('переход у комнаты не закончен — продолжаю отсюда, путь домой не начинаю'); return }
      if (dim() === 'the_nether') await returnFromNether()
      return
    }
    log('у крепости Края: дальше в этом же ходе (ND_SH_STAY)')
    if (END_SEAM && endkitPending()) { log('перед комнатой — сборы на дракона здесь, наверху'); return }
  }
  if (have(/_bed$/)) await act('sleep', { mode: 'take' })
  if (!known.stronghold) {
    const r = await act('stronghold', { mode: 'find', timeoutSeconds: 400 })
    if (r.detail && (r.detail.at || r.detail.estimate)) known.stronghold = r.detail.at || r.detail.estimate
  }
  if (SH_NETHER && known.stronghold && state.pos && dim() === 'overworld' && !died && canLink() &&
    Math.hypot(known.stronghold.x - state.pos.x, known.stronghold.z - state.pos.z) > SH_NETHER_MIN) {
    await viaNetherTo({ x: known.stronghold.x, z: known.stronghold.z }, 'к крепости Края')
    await refresh()
    if (dim() === 'the_nether') { await returnFromNether(); return }
  }
  for (let k = 0; k < 6 && known.stronghold && state.pos && !died && dim() === 'overworld'; k++) {
    await refresh()
    const far = Math.hypot(known.stronghold.x - state.pos.x, known.stronghold.z - state.pos.z)
    if (far <= 160) break
    log(`к крепости ${known.stronghold.x},${known.stronghold.z}: ${Math.round(far)} блоков`)
    await nightGuard()
    await recoverGuard()
    if ((state.health ?? 20) < 12 && have(FOOD)) await act('eat')
    await goToward({ x: known.stronghold.x, z: known.stronghold.z }, 150)
  }
  if (!END_SEAM && known.stronghold && state.pos && dim() === 'overworld' && have(/_bed$/) >= 2) {
    await readMemory()
    const sb = known.spawnBed
    const nearS = Math.hypot(known.stronghold.x - state.pos.x, known.stronghold.z - state.pos.z) <= 200
    const sbNear = sb && Math.hypot(sb.x - known.stronghold.x, sb.z - known.stronghold.z) <= 220
    if (nearS && !sbNear) await act('sleep', { mode: 'spawn', why: 'у крепости Края' })
  }
  for (let i = 0; i < 6 && !known.endPortal; i++) {
    await recoverGuard()
    if (died) return
    if (dim() === 'overworld') { await sense(); if (sit.surface) await nightGuard() }
    const r = await act('stronghold', { mode: 'room', timeoutSeconds: 500 })
    notePortalEyes(r)
    if (r.detail && r.detail.room) { known.endPortal = r.detail.room.centre || r.detail.room; break }
    if (process.env.ND_ROOM_MAP !== '0' && require('../../src/stronghold').mappedRoom(known.stronghold)) {
      log(`подход к комнате по карте остановлен: ${(r.detail || {}).stopped || r.error || 'нет прогресса'} — одинаковый вызов в этом ходе не повторяю`)
      break
    }
    const went = r.detail && r.detail.went
    const ocean = went && went.ocean
    if (ocean && ocean.onTheWay && detours < 2 && known.stronghold && state.pos) {
      const S = known.stronghold
      const me = state.pos
      const mx = (me.x + S.x) / 2; const mz = (me.z + S.z) / 2
      const d = Math.hypot(S.x - me.x, S.z - me.z) || 1
      const side = detours === 0 ? 1 : -1
      const P = { x: Math.round(mx - (S.z - me.z) / d * 150 * side), z: Math.round(mz + (S.x - me.x) / d * 150 * side) }
      detours++
      log(`на прямой к крепости море — крюк через ${P.x},${P.z}`)
      for (let k = 0; k < 6 && !died; k++) { if (dim() === 'overworld') await nightGuard(); if (await goToward(P, 12)) break }
      continue
    }
    if (ocean && !ocean.onTheWay && Array.isArray(ocean.alternatives) && ocean.alternatives.length && !altTried) {
      altTried = true
      const me = state.pos || { x: 0, z: 0 }
      const pts = ocean.alternatives.map(a => { const b = a.bearingDeg * Math.PI / 180; return { x: Math.round(1900 * Math.sin(b)), z: Math.round(1900 * Math.cos(b)) } })
        .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))
      const P = pts[0]
      log(`крепость под морем — иду к другой крепости кольца: точка ${P.x},${P.z} (${Math.round(Math.hypot(P.x - me.x, P.z - me.z))} бл.)`)
      for (let k = 0; k < 8 && !died; k++) {
        if (dim() === 'overworld') await nightGuard()
        const t = await act('stronghold', { mode: 'travel', x: P.x, z: P.z, go: false, timeoutSeconds: 500 })
        if (t.detail && t.detail.arrived) break
        await recoverGuard()
      }
      const f = await act('stronghold', { mode: 'find', timeoutSeconds: 400 })
      if (f.detail && (f.detail.at || f.detail.estimate)) known.stronghold = f.detail.at || f.detail.estimate
      log(`новая крепость: ${JSON.stringify(known.stronghold)}`)
    }
  }
  if (known.endPortal && process.env.ND_END_ENTRY !== '0' && !died && dim() === 'overworld') {
    const r = await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 90 })
    notePortalEyes(r)
    await refresh()
    log(`вход в Энд после комнаты: ${(r.detail || {}).entered && dim() === 'the_end' ? 'подтверждён' : 'не завершён'}`)
  }
})
let altTried = false
let detours = 0

DONE.prep = () => entrySupplies() && known.portal ? READY.nether() && !!lighter() : shieldOn() && lighter() && foodUnits() >= FOOD_STOCK && (spawnAtPortal() || have(/_bed$/) > 0)
DONE.nether = () => !rodsWanted()
DONE.bastion = () => pearlsNow() >= eyesWant() && !obsShort()
DONE.pearls = () => have('ender_pearl') + have('ender_eye') >= eyesWant()
DONE.eyes = () => have('ender_eye') >= eyesWant()
DONE.endkit = () => END_PREP_PRICE ? endPrepRelevant() && (ENDKIT_OFF || !endPrepOffer())
  : have(/_bed$/) >= BEDS_END && obsidianEnd() >= OBSIDIAN_END && have('water_bucket') >= waterWant() &&
    have(/_boat$/) > 0 && fillNow() >= fillWant()
DONE.stronghold = () => process.env.ND_END_ENTRY !== '0' ? dim() === 'the_end' : !!known.endPortal

defStage('dragon', () => !known.dragonWon && (dim() === 'the_end' || !!known.endPortal), async () => {
  if (dim() !== 'the_end') {
    if (dim() === 'the_nether' && !(await returnFromNether())) return
    const E = known.endPortal
    for (let k = 0; k < 8 && E && state.pos && !died && Math.hypot(E.x - state.pos.x, E.z - state.pos.z) > 12; k++) {
      await nightGuard()
      await goToward(E, 4)
      await refresh()
    }
    await act('kit', { for: 'end' })
    if (!END_SEAM && have(/_bed$/) >= 2) await act('sleep', { mode: 'spawn', why: 'у портала в Энд' })
    await checkEndEntry()
    if (died) return
    const f = await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 200 })
    notePortalEyes(f)
    if (!(f.detail && f.detail.entered)) throw new Error('в Энд не вошёл')
  }
  let dragonHp = null
  for (let i = 0; i < 6 && !known.dragonWon; i++) {
    if (died || dim() !== 'the_end') return
    // Кровати кончились — бой не бросать: лук по кристаллам и меч по сидящему (режим full; S5d s5d-N-2 07.10: 5 кроватей мимо
    // головы, навык «ни шагу» без кроватей ×6, граф ушёл в legacy-этап nether прямо в Энде). ND_DRAGON_FALLBACK=0 — прежнее.
    const noBeds = !have(/_bed$/) && process.env.ND_DRAGON_FALLBACK !== '0'
    // S5e (07.10): без кроватей — оценка, а не безусловный бой (s5d-T-5: full с 20 хп дракона — «killed by Ender Dragon using magic»;
    // T-6: кровати сняли ~190, full с 11 стрелами 20 мин по кристаллам — время). Хп дракона (моба — можно точно): ≤ 40 — добить его
    // самого сразу (режим dragon: меч по сидящему, лук), пока кристаллы не вылечили; иначе — кристаллы и бой (full). Своё хп < 14 —
    // сперва поесть и отлежаться (ждать), потом бить. ND_DRAGON_FINISH=0 — всегда full.
    let mode = noBeds ? 'full' : null
    if (noBeds && process.env.ND_DRAGON_FINISH !== '0') {
      if ((state.health ?? 20) < 14) {
        log(`без кроватей, хп ${Math.round(state.health ?? 0)} — сперва ем и отлёживаюсь, потом бой`)
        if (have(FOOD) && (state.food ?? 20) < 20) await act('eat')
        await act('wait', { seconds: 15 })
        await refresh()
        if (died || dim() !== 'the_end') return
      }
      if (dragonHp !== null && dragonHp <= 40) mode = 'dragon'
    }
    if (noBeds) log(`кроватей нет — бой с драконом (${mode}): хп дракона ${dragonHp ?? '?'}, стрел ${arrowsNow()}, меч ${have(/_sword$/) ? 'есть' : 'нет'}`)
    const r = await act('dragon', { timeoutSeconds: 600, ...(mode ? { mode } : {}) })
    const dd = r.detail && r.detail.dragon
    if (dd && Number.isFinite(dd.hpNow)) dragonHp = dd.hpNow
    if (dd && dd.won) { known.dragonWon = true; log('ДРАКОН УБИТ') }
  }
})
