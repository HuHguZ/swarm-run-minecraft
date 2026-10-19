'use strict'
// Этапы верхнего мира: wood, stone, food, iron, water, cast, diamond, obsidian, portal.
import { OW_DEEP, OW_HEAR } from '../flags'
import { stage, strategyInterrupted, state, sit, died, known, fightGearWanted, foodHuntEmpty, foodSpentMs,
  waterSearchView, castSurfaceFailed, deepLava, skyLavaSeen, naturalTried, shaftWaterSeen, setCastSurfaceFailed,
  setDeepLava, setFoodHuntEmpty, setFoodSpentMs, setHunting, setLavaSourceKnown, setShaftWaterSeen, setSkyLookAt,
  setWaterDeepFailAt, setWaterSearchFailedView } from '../state'
import { log } from '../log'
import { have, y, dim, LOGS, COBBLE, FOOD, foodUnits, PICK_STONE, PICK_IRON, PICK_DIAMOND, planksFor, woodNow,
  portalBuckets, rodsNow, goldOn, shieldOn, lighter } from '../queries'
import { sense, readMemory, lavaBadSites } from '../observe'
import { canWorkAtNight, nightHold, weakAndHungry, fightReady, defStage, FOOD_STOCK, foodShort, near3,
  surfaceLavaNear } from './table'
import { act } from '../act'
import { awayFromWater, leaveWater, mobInTheWay } from '../danger'
import { nightGuard, recoverGuard } from '../guards'
import { walkAway, awayFrom, goToward } from '../travel'
import { craft, sticks, spares, lumber, unclutter, bucketOnTheWay, mineSeenAll, ironToSmelt, smeltAll, lightUp,
  torches } from '../kit'
import { descend, toSurface } from '../underground'
import { spendIron, ARMOR_COST, ARMOR_SLOT, gearWorth, worn } from '../gear'
import { foodRun, quickHunt, cook } from '../food'
import { castForKit, kitWaterHere, waterSearchDirection, ensureFlint } from '../portal-kit'
import { NATURAL, dayLavaStep, skyLavaLook, castSiteFails, castSiteFailAt, lavaAtSeenRuins, lootSeenStructures,
  surfaceLavaSurvey, naturalCast } from '../scout'
import { deepBad, listenForLava, deepCast, surfaceShaftNear, waterViaShaft, deepWater, approachCastLava } from '../deep-cast'
import { wearGold } from '../nether-trip'
const gameClock: typeof import('../../src/game-clock') = require('../../src/game-clock')
let ironRuns = 0
let ironLeg = 0 // сквозной номер штрека этапа iron (змейка между заходами)
const ironBlocked = new Set() // «x,z:сторона» — штрек отсюда туда не пошёл (глубокий путь)

let woodRoofed = 0
defStage('wood', () => !have(/_pickaxe$/) ||
  (!!known.portal && rodsNow() < 7 && woodNow() < 4 && ((!shieldOn() && have('iron_ingot') > 0) || have(/_pickaxe$/) <= 2)), async (bootstrap = null) => {
  const recovering = !!known.portal
  const starter = process.env.ND_ROUTE === '1' && !recovering && process.env.ND_ROUTE_WOOD_ONCE !== '0' &&
    have(/_pickaxe$/) && have('crafting_table') && have('stick') >= 2
  const stock = () => starter ? have(LOGS) : woodNow()
  // Спидран: 6 брёвен на старте хватает на верстак, кирки и палки, остальное — reserve() по ходу; 14 гоняли по редколесью
  // 15 мин до первой ночи (cl-u 14.10: 4 бревна, ещё 10 искал — смерть от утопленника на 15-й мин).
  const want = bootstrap ?? (starter ? 5 : recovering ? 4 : (process.env.ND_ROUTE === '1' && !known.portal ? (Number(process.env.ND_ROUTE_WOODN) > 0 ? Number(process.env.ND_ROUTE_WOODN) : 6) : state.playPolicy?.mode === 'speedrun' ? 6 : 14))
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  for (let i = 0; i < 10 && stock() < want; i++) {
    await nightGuard()
    await recoverGuard()
    await sense()
    // Наверх не вышло (кирки нет, свод скалы/навес над головой — s8b-a1-7: роща карты под навесом, «лезу рукой» отказ → дерево
    // брошено, камень с пустым рюкзаком, пещера на y −23, зомби): брёвна по видимости и в сторону по поверхности, до 3 раз.
    if (!sit.surface && (!sit.night || canWorkAtNight()) && dim() === 'overworld' && !(await toSurface())) {
      if (process.env.ND_ROUTE === '1' && process.env.ND_WOOD_ROOFED !== '0' && !have(/_pickaxe$/) && ++woodRoofed <= 3 && !died) {
        log(`дерево: наверх не выйти — брёвна на виду, потом в сторону (${woodRoofed}/3)`)
        const m0 = await act('mine', { block: 'any_log', count: want - stock(), radius: 32, timeoutSeconds: 90 })
        if (stock() < want && !(m0.detail && m0.detail.dug)) await walkAway(24, Math.PI / 2)
        continue
      }
      break
    }
    const m = await act('mine', { block: 'any_log', count: want - stock(), radius: 48, timeoutSeconds: 240 })
    if (stock() >= want) break
    if (m.status !== 'done' || !(m.detail && m.detail.dug)) {
      if (!/не вижу/.test(String(m.error || ''))) { await walkAway(20, Math.PI / 2); continue }
      // Дерево видно дальше 48 (прорисовка фермы 128): пустыня и степь — деревья у горизонта (cl-c/cl-d 14.10: 8–18 мин без
      // единого бревна). Видимое — дойти до него, потом рубить.
      const e = await act('explore', { block: 'any_log', radius: 96, stepDistance: 80, timeoutSeconds: 120 })
      const at = e.detail && e.detail.found && e.detail.at
      if (at && state.pos && Math.hypot(at.x - state.pos.x, at.z - state.pos.z) > 40) await act('goto', { x: at.x, z: at.z, range: 8, timeoutSeconds: 90, surface: 'strict' })
      else if (!at) await walkAway(60, Math.PI / 3)
    }
  }
  if (recovering && have(/_pickaxe$/)) return
  if (starter && stock() >= want) {
    if (!known.lava) await act('observe', { radius: 48 })
    return
  }
  const planks = planksFor()
  if (!planks) throw new Error('брёвен нет')
  if (have(/_planks$/) < 12) await craft(planks, 12 - have(/_planks$/))
  if (!have('crafting_table')) await craft('crafting_table')
  await sticks(6)
  await craft('wooden_pickaxe')
  if (!known.lava && !known.portal) await act('observe', { radius: 48 })
})

defStage('stone', () => !have(PICK_STONE) || !have(/_sword$/), async () => {
  // Маршрут (ND_ROUTE_STONETUN=0 — выкл.): в этапе камня — только кирка и меч (5 булыжника); печь — по нужде у жилы под землёй
  // (routeStep ore) или routeFurnaceSupply: «mine stone 13» у поверхности — 83–100 с ходьбы (s8-r1-1, s8-r2-1), а железо из
  // сундуков и голема печи не требует.
  const light = process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_STONETUN !== '0' && !known.portal
  // Сколько булыжника ещё нужно сейчас: в лёгком режиме — 3 на кирку, пока её нет, и 2 на меч, пока его нет.
  let want = light ? 5 : OW_DEEP ? 13 : 24
  const wantNow = () => light ? (have(PICK_STONE) ? 0 : 3) + (have(/_sword$/) ? 0 : 2) : want
  const safeStone = process.env.ND_ROUTE === '1'
  const pickFirst = safeStone && process.env.ND_ROUTE_PICK_FIRST !== '0'
  let hurt = false
  for (let i = 0; i < 8 && have(COBBLE) < (want = wantNow()); i++) {
    await nightGuard()
    await recoverGuard()
    if (died) return
    if (!have(PICK_STONE) && have(COBBLE) >= 3 && process.env.ND_ROUTE === '1') { await sticks(2); await craft('stone_pickaxe') }
    if (light) { want = wantNow(); if (have(COBBLE) >= want) break }
    const firstPick = pickFirst && !have(PICK_STONE)
    const batch = firstPick ? Math.min(want - have(COBBLE), Math.max(1, 3 - have(COBBLE))) : want - have(COBBLE)
    // Булыжник после каменной кирки — штреком вперёд под землёй, а не «mine stone» по видимым блокам: штрек 8 даёт 16 за
    // 24–38 с, mine 13 — 83–100 с ходьбы от блока к блоку (s8-base/s8-r1 06–07.10). ND_ROUTE_STONETUN=0 — выкл.
    if (!firstPick && !hurt && have(PICK_STONE) && process.env.ND_ROUTE_STONETUN !== '0') {
      await sense()
      if (!sit.surface) {
        await act('tunnel', { length: Math.min(10, Math.ceil(batch / 2) + 1), torchEvery: 0, timeoutSeconds: 60 })
        if (have(COBBLE) >= want) break
      }
    }
    const m = hurt ? { detail: {} } : await act('mine', { block: 'stone', count: batch, radius: safeStone ? 14 : 32, dry: true, timeoutSeconds: 180 })
    if (have(COBBLE) >= want) break
    if (safeStone && (m.code === 'DAMAGE' || m.status === 'interrupted')) { hurt = true; log(`камень: ${m.code || m.status} в забое — дальше своей лесенкой`); await act('surface', { timeoutSeconds: 40, hand: false, preferPillar: true }) }
    else if (m.detail && m.detail.dug) continue
    if (safeStone) {
      const ob = await act('observe', { radius: 7 })
      if ((Array.isArray(ob.detail && ob.detail.blocks) ? ob.detail.blocks : []).some(b => b && b.name === 'water')) { log('камень: вода рядом — лесенку копаю подальше от неё'); await awayFromWater(24); await sense(); if (sit.inWater) await leaveWater() }
    }
    const d = await act('dig_down', { mode: 'stairs', depth: firstPick ? 3 : 10, torchEvery: 0, timeoutSeconds: 180 })
    const dWet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(String((d.detail && d.detail.stopped) || ''))
    if (dWet && !(d.detail && d.detail.steps >= 3)) { await awayFrom({ x: +dWet[1], z: +dWet[3] }, 20).catch(() => null); continue }
    if (d.detail && d.detail.steps) continue
    // «Digging aborted» — копку на первом же блоке сорвал крафт автопилота (деревянный меч, s8-base-2/4: +wooden_sword в том
    // же ответе), а не порода: ещё раз здесь же, а не разведка камня за 60 м (там — вода и ночь).
    if (/aborted/i.test(String((d.detail && d.detail.stopped) || '')) && i < 3) continue
    if (/У кирки осталось/.test(String((d.detail && d.detail.stopped) || ''))) {
      if (have(/_planks$/) >= 3 || have(LOGS)) { await sticks(2); if (await craft('wooden_pickaxe')) continue }
      const d2 = await act('dig_down', { mode: 'stairs', depth: 3, torchEvery: 0, timeoutSeconds: 90 })
      if (d2.detail && d2.detail.steps) continue
    }
    const e = await act('explore', { block: 'stone', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
    if (!(e.detail && e.detail.found) || /уже видно/.test(String((e.detail && e.detail.note) || ''))) await walkAway(40, Math.PI / 2)
  }
  await sticks(5)
  if (!have(PICK_STONE)) await craft('stone_pickaxe')
  if (!have(/_sword$/)) await craft('stone_sword')
  if (!have(/_axe$/) && have(COBBLE) >= 11) await craft('stone_axe')
  if (!have('furnace') && have(COBBLE) >= 8) await craft('furnace')
  if (!known.lava && !known.portal) await act('observe', { radius: 48 })
})
defStage('food', () => foodShort() > 0, async () => {
  setHunting(true)
  const before = foodUnits()
  const t0 = gameClock.now()
  try { await foodRun() } finally { setHunting(false); if (OW_DEEP && !known.portal) setFoodSpentMs(foodSpentMs + (gameClock.now() - t0)) }
  if (foodUnits() > before) setFoodHuntEmpty(0)
  else if (!died && setFoodHuntEmpty(foodHuntEmpty + 1) === 2) log('охота пуста дважды подряд — железо пойдёт и при сытости ≥ 8 (в горах оно на склонах)')
})

defStage('iron', () => (!known.portal && have(/bucket$/) < portalBuckets()) ||
  (!!known.portal && rodsNow() >= 7 && !have(PICK_IRON)) ||
  (!!known.portal && fightGearWanted && rodsNow() < 7 && !fightReady() && ironRuns < 8) ||
  (!known.portal && castSurfaceFailed && !have(PICK_IRON)) ||
  (!known.portal && !have(/bucket$/)), async (portalOnly = false) => {
  ironRuns++
  if (!known.portal && have('raw_iron')) {
    const buckets = have(/bucket$/)
    await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
    await spendIron()
    if (!(castSurfaceFailed && !have(PICK_IRON)) && (have(/bucket$/) > buckets || (have(/bucket$/) && lighter()))) return
  }
  const ironBase = known.portal
    ? Math.max(3, (have(PICK_IRON) ? 0 : 3) + ((have(/bucket$/) || have('water_bucket')) ? 0 : 3) +
      (fightGearWanted ? (worn('torso') ? 0 : 8) + (worn('legs') ? 0 : 7) + (worn('head') ? 0 : 5) + (shieldOn() ? 0 : 1) : 0))
    : 3 * portalBuckets() + 1 + ((castSurfaceFailed && !have(PICK_IRON)) ? 3 : 0)
  let want = ironBase
  if (!portalOnly) for (const item of ['iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots']) {
    if (worn(ARMOR_SLOT[item.split('_').pop()])) continue
    const g = gearWorth(item)
    if (g.missing) { log(g.line); if (g.take) want += ARMOR_COST[item] }
  }
  const ironNow = () => have(/^(raw_iron|iron_ingot)$/) + Math.floor(have('iron_nugget') / 9) + 9 * have('iron_block') + 9 * have('raw_iron_block') +
    (!known.portal ? 3 * Math.min(portalBuckets(), have(/bucket$/)) + (lighter() ? 1 : 0) : 0)
  const useMemory = process.env.ND_OW_IRON_MEMORY !== '0' && dim() === 'overworld'
  await sense()
  if (weakAndHungry()) { log(`хп ${Math.round(state.health ?? 0)} и еды нет — вниз не иду, сначала охота`); return }
  await cook()
  if ((state.food ?? 20) < 18 && have(FOOD)) await act('eat')
  if (useMemory) {
    await mineSeenAll('iron_ore,deepslate_iron_ore', 24, () => want - ironNow())
    if (died || strategyInterrupted) return
  }
  if (OW_DEEP && !known.portal && ironNow() < want && sit.surface && !sit.night && dim() === 'overworld') {
    const high = y() > 90
    for (let k = 0; k < (high ? 2 : 1) && ironNow() < want && !died; k++) {
      const m = await act('mine', { block: 'iron_ore', count: want - ironNow(), radius: high ? 32 : 24, timeoutSeconds: high ? 90 : 60 })
      if (!(m.detail && m.detail.dug)) break
    }
    if (have(/^(coal|charcoal)$/) < 4) await act('mine', { block: 'coal_ore', count: 6, radius: 24, timeoutSeconds: 60 })
  } else if (ironNow() < want && sit.surface && !sit.night && dim() === 'overworld') {
    for (let k = 0; k < 4 && ironNow() < want && !died; k++) {
      const m = await act('mine', { block: 'iron_ore', count: want - ironNow(), radius: 48, timeoutSeconds: 180 })
      if (m.detail && m.detail.dug) continue
      await sense()
      if (sit.night) break
      const e = await act('explore', { block: 'iron_ore', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
      if (!(e.detail && e.detail.found)) break
    }
    if (have(/^(coal|charcoal)$/) < 4) await act('mine', { block: 'coal_ore', count: 6, radius: 32, timeoutSeconds: 90 })
  }
  if (died) return
  if (ironNow() < want && y() > 24 && have(/_bed$/)) {
    await sense()
    await readMemory()
    const sb = known.spawnBed
    if (dim() === 'overworld' && (!sb || Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) > 48)) {
      await act('sleep', { mode: 'spawn', why: 'у шахты за железом' })
    }
  }
  // Дерева на глубину: маршруту хватает 4 (плавка ~5 слитков — 4 доски, палки на кирку/факелы — одно бревно); s8c-g: лесоповал перед
  // спуском при 4–5 брёвнах — 43 с/прогон. ND_ROUTE_IRONWOOD=0 — прежние 6.
  const woodFloor = process.env.ND_ROUTE === '1' && stage === 'route' && process.env.ND_ROUTE_IRONWOOD !== '0' ? 4 : 6
  if (ironNow() < want && y() > 24 && !(OW_DEEP && woodNow() >= woodFloor)) { await sense(); if (sit.surface && !sit.night) await lumber(8) }
  if (OW_DEEP && !known.portal && ironNow() < want && y() > 24 && foodUnits() < FOOD_STOCK + 2) await quickHunt()
  if (OW_DEEP && !known.portal && ironNow() < want && y() > 24 && !skyLavaSeen) await surfaceLavaSurvey()
  if (OW_DEEP && !known.portal && ironNow() < want && y() > 24 && !have('water_bucket')) {
    await sense()
    if (sit.surface) {
      const o = await act('observe', { radius: 48 })
      const w = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'water' && b.nearest)
      setShaftWaterSeen(w ? w.nearest : null)
    }
  }
  const visibleLegs = process.env.ND_IRON_VISIBLE_LEGS === '1' && !known.portal && dim() === 'overworld'
  if (ironNow() < want && y() > 24) await descend(16, { wetCluster: dim() === 'overworld',
    ...(visibleLegs ? { oreRemaining: () => want - ironNow() } : {}) })
  if (died) return
  if (OW_DEEP && OW_HEAR && !known.portal && y() < 40) await listenForLava('низ колодца')
  if (OW_DEEP && ironNow() < want) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: want - ironNow(), radius: process.env.ND_IRON_WIDE !== '0' ? 24 : 14, timeoutSeconds: 120 })
  if (died) return
  await lightUp()
  const ironDir = n => ['north', 'east', 'south', 'west'][n % 4]
  // Штрек 32 оставлял раннюю виденную руду за радиусом добора 24; между короткими частями — mineSeenAll.
  const ironLegLength = visibleLegs ? 16 : 32
  for (let i = 0; i < 14 * 32 / ironLegLength && ironNow() < want; i++) {
    await recoverGuard()
    if (died) return
    if (useMemory) {
      await mineSeenAll('iron_ore,deepslate_iron_ore', 24, () => want - ironNow())
      if (died || strategyInterrupted) return
      if (ironNow() >= want) break
    }
    await unclutter()
    await spares()
    await sense()
    if ((sit.pickLeft ?? 0) < 120 && have('stick') < 2 && have(/_planks$/) < 2 && !have(LOGS)) {
      log(`кирке осталось ${sit.pickLeft ?? 0} ударов, палок нет — наверх за деревом, пока есть чем копать`)
      // Ночью наверх за деревом — под мобов: кирку беречь, внизу ждать рассвета (главный цикл держит ночь).
      if (nightHold()) { log('ночь — за деревом с рассветом, кирку берегу'); break }
      if (await toSurface()) { await nightGuard(); await lumber(10); await spares(300) }
      break
    }
    // Две части по 16 сохраняют прежний поворот через 32 блока и область поиска.
    let tdir = ironDir(Math.floor(ironLeg++ * ironLegLength / 32))
    if (state.pos) {
      const here = `${Math.floor(state.pos.x)},${Math.floor(state.pos.z)}`
      for (let k = 0; k < 4 && ironBlocked.has(`${here}:${tdir}`); k++) tdir = ['north', 'east', 'south', 'west'][(['north', 'east', 'south', 'west'].indexOf(tdir) + 1) % 4]
    }
    const tFrom = state.pos ? `${Math.floor(state.pos.x)},${Math.floor(state.pos.z)}` : ''
    const t = await act('tunnel', { direction: tdir, length: ironLegLength, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    if (t.detail && t.detail.stopped && !(t.detail.walked > 0)) ironBlocked.add(`${tFrom}:${tdir}`)
    if (await mobInTheWay(t)) continue
    if (OW_DEEP && OW_HEAR && !known.portal) await listenForLava('штрек за железом')
    if (useMemory) await mineSeenAll('iron_ore,deepslate_iron_ore', 24, () => want - ironNow())
    else { await mineSeenAll('iron_ore'); await mineSeenAll('deepslate_iron_ore') }
    // Портальный набор — железо и кремень: гравий видимый в штреке — сейчас, а не поиском поверху на рассвете (g3-s2-1 14.10:
    // ночь в коробке с 4 железом без кремня, на рассвете гравий и деревня — смерть от зомби).
    if (portalOnly && !have('flint') && !lighter()) await mineSeenAll('gravel', 16)
    if (portalOnly && ironNow() >= want && (have('flint') || lighter())) break
    if (OW_DEEP && !known.portal && !have('water_bucket')) await bucketOnTheWay(t)
    if (ironNow() < want) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: Math.min(8, want - ironNow()), radius: OW_DEEP ? (process.env.ND_IRON_WIDE !== '0' ? 24 : 16) : 32, timeoutSeconds: 150 })
    if ((!known.lava || OW_DEEP) && !known.portal) await act('observe', { radius: 32 })
    if (have(/^(coal|charcoal)$/) < 12) await mineSeenAll('coal_ore')
    if (!have('flint') && !have('flint_and_steel')) await act('mine', { block: 'gravel', dry: true, count: 8, radius: 16, timeoutSeconds: 90 })
    await torches()
    if (t.detail && t.detail.need) break
    // Золото в верхнем мире не ищу (пользователь 14.10: «если золота нет в основном мире, то тратить время на его поиски — тупим»):
    // золото на броню и бартер берётся в Аду, здесь — только попутно из построек. Штреки кончаются по железу.
    if (i >= (known.portal ? 1 : 4) && ironNow() >= (known.portal ? want : 8)) break
  }
  if (have('raw_iron') && !have(/^(coal|charcoal)$/) && woodNow() < 6 && ironToSmelt() > 0) {
    await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
    if (have('raw_iron') && ironToSmelt() > 0 && await toSurface()) { await nightGuard(); await lumber(12) }
  }
  await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
  await spendIron()
  await smeltAll('raw_gold', 'gold_ingot')
  if (known.portal && !goldOn() && have('gold_ingot') >= 4) await wearGold()
})

defStage('water', () => have(/^bucket$/) > 0 && !have('water_bucket') && !known.portal, async () => {
  await sense()
  const local = await kitWaterHere()
  if (local || local === null) return
  if (OW_DEEP && !sit.surface && y() < 50) {
    const viaShaft = surfaceShaftNear() && !!shaftWaterSeen
    if (await deepWater({ legs: viaShaft ? 2 : 5 })) return
    if (viaShaft && !died && await waterViaShaft()) return
    if (!died && have(/bucket$/) >= 2 && ++waterDeepFails < 3) { setWaterDeepFailAt(gameClock.now()); log(`вода глубоко: штреками не нашлась (${waterDeepFails}-й раз) — ищу попутно у лавы, наверх не иду`); return }
  }
  for (let i = 0; i < 6 && !have('water_bucket'); i++) {
    await recoverGuard()
    if (died) return
    const r = await act('bucket', { fluid: 'water', radius: 32 })
    if (have('water_bucket')) break
    if (r.detail && r.detail.need) break
    if (!(await toSurface())) break
    await nightGuard()
    const r2 = await act('bucket', { fluid: 'water', radius: 32 })
    if (have('water_bucket') || (r2.detail && r2.detail.need)) break
    const direction = await waterSearchDirection()
    if (died || strategyInterrupted || direction === undefined) return
    const from = state.pos && { ...state.pos }
    const e = await act('explore', { block: 'water', waterSource: true, radius: 48, stepDistance: 80, direction,
      newView: process.env.ND_OW_KIT_WATER !== '0', timeoutSeconds: 150 })
    if (!(e.detail && e.detail.found)) await walkAway(60, Math.PI / 4)
    // Источник виден дальше радиуса ведра (32) — explore отвечает «уже видно», ведро «не вижу»: подойти к нему.
    else if (e.detail.at && state.pos && Math.hypot(e.detail.at.x - state.pos.x, e.detail.at.y - state.pos.y, e.detail.at.z - state.pos.z) > 6) {
      await act('goto', { x: e.detail.at.x, y: e.detail.at.y, z: e.detail.at.z, range: 4, timeoutSeconds: 60 })
    }
    if (process.env.ND_OW_KIT_WATER !== '0' && !e.detail?.found && from && state.pos &&
        Math.hypot(from.x - state.pos.x, from.y - state.pos.y, from.z - state.pos.z) < 1) {
      setWaterSearchFailedView(waterSearchView)
      log('вода: разведка и обход без пути — тот же вид не повторяю')
      return
    }
  }
})

let castRuns = 0

let waterDeepFails = 0

// Литьё без воды в ведре невозможно (портал из лавы и воды; «одно ведро: вода с собой»): этап cast без water_bucket падал сразу
// «нет воды в ведре», дважды — пауза, а вода сама в паузе (ocr0-fp1-s11-1-kit-941 16.10: 7-я–24-я мин без шага). ND_CAST_NEEDS_WATER=0 — прежнее.
defStage('cast', () => !known.portal && (process.env.ND_CAST_NEEDS_WATER === '0' || have('water_bucket') > 0), async () => {
  castRuns++
  let surfaceLooks = 0
  await sense()
  if (weakAndHungry()) { log(`хп ${Math.round(state.health ?? 0)} и еды нет — к лаве не иду, сначала охота`); return }
  if (OW_DEEP) {
    await readMemory()
    if (portalBuckets() === 2 && skyLavaSeen && NATURAL && naturalTried < 1) { if (await naturalCast()) return; if (died) return }
    if (!known.lava && sit.surface) await act('observe', { radius: 64 })
    if (!deepLava && known.lava && !sit.surface && near3(known.lava, 48) && !deepBad.some(b => Math.hypot(b.x - known.lava.x, b.y - known.lava.y, b.z - known.lava.z) < 6)) setDeepLava(known.lava)
    if (deepLava || !surfaceLavaNear()) { await deepCast(); return }
  }
  if (await dayLavaStep()) return
  if (process.env.ND_OW_KIT_LAVA !== '0') await readMemory()
  if (!sit.surface && dim() === 'overworld' && !sit.night &&
      (process.env.ND_OW_KIT_LAVA === '0' || !known.lava)) await act('shelter', { mode: 'exit' })
  if (process.env.ND_OW_KIT_LAVA === '0') await readMemory()
  await skyLavaLook()
  if (!known.lava) await act('observe', { radius: 48 })
  if (known.lava && state.pos && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) > 16) await goToward(known.lava, 8)
  // Лава у руин (класс rp пула good-v2) — их сундук в двух шагах: огниво, обсидиан — до литья, если окупается.
  await lootSeenStructures(32)
  await ensureFlint()
  for (let i = 0; i < 6 && !known.portal; i++) {
    await recoverGuard()
    if (died) return
    await sense()
    if (state.playPolicy?.mode !== 'speedrun' && sit.night && sit.surface && dim() === 'overworld') { await nightGuard(); continue }
    await unclutter()
    const r = await castForKit({ mode: 'cast', timeoutSeconds: 540 })
    await readMemory()
    if (known.portal || died) break
    if (process.env.ND_OW_KIT_FRAME !== '0' && r.detail?.retryBlocked) {
      log('литьё: источники у сохранённой рамы не изменились — новая точка обзора вместо того же повтора')
      await act('explore', { block: 'lava', newView: true, radius: 48, stepDistance: 16, surface: !!sit.surface, timeoutSeconds: 60 })
      break
    }
    const why = String((r.detail && r.detail.stopped) || r.error || '')
    // Литьё у этого озера не встаёт (лава под навесом, берег из жидкости — cl-ai 14.10: 100 мин «не вижу лавы-источника» и
    // «места на берегу нет» у одной и той же пещерной лавы): после 4 отказов место плохое, ищем другое озеро.
    // Тот же отказ с той же точки (тело не сдвинулось на 3 бл. с прошлого отказа у этой лавы) — причина не изменилась: место плохое
    // сразу; издалека тоже считается (ocr/m2g/rgk 16.10: 278 отказов «не вижу лавы-источника» на 75 сцен, литьё до конца 25 мин).
    const castSame = process.env.ND_CAST_SAME_FAIL === '1'
    if (known.lava && state.pos && /не вижу лавы|места на берегу нет|места под раму/.test(why) &&
        (castSame || Math.hypot(known.lava.x - state.pos.x, (known.lava.y ?? state.pos.y) - state.pos.y, known.lava.z - state.pos.z) <= 12)) {
      const key = `${Math.round(known.lava.x / 8)},${Math.round(known.lava.z / 8)}`
      const lastAt = castSame ? castSiteFailAt.get(key) : null
      const samePlace = castSame && lastAt && Math.hypot(lastAt.x - state.pos.x, lastAt.y - state.pos.y, lastAt.z - state.pos.z) < 3
      if (castSame) castSiteFailAt.set(key, { ...state.pos })
      castSiteFails.set(key, (castSiteFails.get(key) || 0) + 1)
      if (samePlace || castSiteFails.get(key) >= 4) {
        log(`литьё: у лавы ${known.lava.x},${known.lava.y},${known.lava.z} рама не встаёт (4 отказа) — ищу другое озеро`)
        lavaBadSites.push({ ...known.lava })
        known.lava = null; setLavaSourceKnown(false); setSkyLookAt(null)
        break
      }
    }
    const needWhat = String((r.detail && r.detail.need && r.detail.need.what) || '')
    if (/cobblestone|stone/.test(needWhat)) {
      const filler = /^(cobblestone|cobbled_deepslate|dirt|stone|deepslate|andesite|diorite|granite|tuff|netherrack|blackstone|basalt|sandstone|red_sandstone)$/
      const want = Number(r.detail.need.count) || 3
      const before = have(filler)
      await act('mine', { block: 'dirt,grass_block,stone,deepslate,andesite,diorite,granite,tuff,sandstone,red_sandstone', count: Math.max(1, want - have(filler)), radius: 32, dry: true, timeoutSeconds: 35 })
      if (have(filler) < want) await act('dig_down', { mode: 'stairs', depth: 8, torchEvery: 0, maxFallHp: 0, timeoutSeconds: 90 })
      if (have(filler) <= before) break
      continue
    }
    if (r.detail && r.detail.need) break
    if (/не вижу лавы/.test(why)) {
      if (process.env.ND_OW_KIT_LAVA !== '0' && known.lava) {
        const before = state.pos && { ...state.pos }
        await approachCastLava()
        if (died || strategyInterrupted) return
        if (before && state.pos && ['x', 'y', 'z'].some(axis => Math.floor(state.pos[axis]) !== Math.floor(before[axis]))) continue
      } else if (known.lava && state.pos && i < 3) {
        const before = { ...state.pos }
        const dx = known.lava.x - before.x
        const dz = known.lava.z - before.z
        const lower = typeof known.lava.y === 'number' && known.lava.y < before.y - 3
        if (lower && Math.hypot(dx, dz) <= 16) {
          const direction = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
          await act('dig_down', { mode: 'stairs', depth: Math.min(12, before.y - known.lava.y - 3), direction, timeoutSeconds: 90, maxFallHp: 0, torchEvery: 0 })
          await act('observe', { radius: 32 })
        } else if (Math.hypot(dx, (known.lava.y ?? y()) - before.y, dz) > 12) await goToward(known.lava, 8)
        // Рядом, но источника не видно (лава выше ног, за краем — cl-i 14.10: в 4.5 бл. «не вижу лавы-источника» и уход):
        // встать у самой лавы на её высоте.
        else await act('goto', { x: known.lava.x, y: known.lava.y, z: known.lava.z, range: 2, timeoutSeconds: 60 })
        if (died) return
        if (['x', 'y', 'z'].some(axis => Math.floor(state.pos[axis]) !== Math.floor(before[axis]))) continue
      }
      if (y() < 0) {
        await spares(120)
        await act('tunnel', { direction: ['north', 'east', 'south', 'west'][i % 4], length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
        if (!known.lava) await act('observe', { radius: 32 })
        continue
      }
      if (await skyLavaLook()) continue
      if (await lavaAtSeenRuins()) continue
      const e = await act('explore', { block: 'lava', lavaSource: true, radius: 48, stepDistance: 60, timeoutSeconds: 150, surface: true })
      if (e.detail && e.detail.found) continue
      if (++surfaceLooks >= 2 && !known.lava) {
        setCastSurfaceFailed(true)
        log('литьё: поверху лавы нет (обзор и две разведки) — запасной путь: железная кирка, алмазы, обсидиан ведром у лавы глубоко')
        return
      }
      continue
    }
    if (/места под раму|места на берегу нет/.test(why)) { await walkAway(12, Math.PI / 2, y()); continue }
  }
})

defStage('diamond', () => !have(PICK_DIAMOND) && !known.portal, async () => {
  if (y() > -55) await descend(-57)
  if (died) return
  await lightUp()
  const dirs = ['north', 'east', 'south', 'west']
  for (let i = 0; i < 14 && have('diamond') < 3; i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares()
    const t = await act('tunnel', { direction: dirs[i % 4], length: 40, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 360 })
    await mineSeenAll('deepslate_diamond_ore,diamond_ore', 48)
    if (!known.lava && !known.portal) await act('observe', { radius: 32 })
    await act('mine', { block: 'deepslate_diamond_ore,diamond_ore', count: 6, radius: 32, timeoutSeconds: 180 })
    if (have('raw_iron') + have('iron_ingot') < 8) await mineSeenAll('deepslate_iron_ore,iron_ore', 24)
    await torches()
    if (t.detail && t.detail.need) break
  }
  if (have('diamond') >= 3) {
    await sticks(2)
    await craft('diamond_pickaxe')
  }
})

defStage('obsidian', () => have('obsidian') < 10 && !known.portal, async () => {
  if (have(/^raw_(iron|gold)$/) >= 3 && have(/^bucket$/) >= 1) {
    await act('bucket', { fluid: 'lava', radius: 24 })
    await smeltAll('raw_iron', 'iron_ingot')
    await smeltAll('raw_gold', 'gold_ingot')
    await spendIron()
  }
  for (let i = 0; i < 8 && have('obsidian') < 10; i++) {
    await recoverGuard()
    if (died) return
    const r = await act('obsidian', { count: 10 - have('obsidian'), radius: 24, timeoutSeconds: 300 })
    if (have('obsidian') >= 10) break
    const why = String((r.detail && r.detail.stopped) || r.error || '')
    if (r.detail && r.detail.need && r.detail.need.what === 'water_bucket') break
    if (r.detail && r.detail.need && /pickaxe/.test(r.detail.need.what)) break
    if (/лав/.test(why) || /не вижу/.test(why) || !(r.detail && r.detail.got)) {
      await unclutter()
      await act('tunnel', { direction: ['north', 'east', 'south', 'west'][i % 4], length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    }
  }
})

defStage('portal', () => !known.portal, async () => {
  if (have('obsidian') < 10) throw new Error(`обсидиана ${have('obsidian')} из 10`)
  if (!have('flint_and_steel') && !have('fire_charge')) {
    for (let i = 0; i < 4 && !have('flint'); i++) {
      const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 32, timeoutSeconds: 150 })
      if (!(g.detail && g.detail.dug)) break
    }
    if (have('flint') && have('iron_ingot')) await craft('flint_and_steel')
  }
  await toSurface()
  await nightGuard()
  if (!have('flint_and_steel') && !have('fire_charge')) {
    for (let i = 0; i < 4 && !have('flint'); i++) {
      const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 32, timeoutSeconds: 150 })
      if (!(g.detail && g.detail.dug)) await act('explore', { block: 'gravel', dry: true, radius: 48, stepDistance: 60, timeoutSeconds: 120 })
    }
    if (have('flint') && have('iron_ingot')) await craft('flint_and_steel')
  }
  const r = await act('portal', { mode: 'build', timeoutSeconds: 300 })
  if (r.detail && r.detail.lit) await readMemory()
})
