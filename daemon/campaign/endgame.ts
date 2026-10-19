'use strict'
// Край: стрелы, набор на Край и его цена, выход к крепости через Ад.
import { EYES_NEED, BEDS_END, END_PREP_PRICE } from './flags'
import { strategyInterrupted, state, sit, died, known, exitFrameTarget, endkitRuns, setExitFrameTarget } from './state'
import { log } from './log'
import { have, dim, LOGS, COBBLE, FOOD, PICK_DIAMOND, planksFor, rodsNow, lighter, arrowsNow } from './queries'
import { sense, refresh, readMemory } from './observe'
import { FOOD_STOCK } from './stages/table'
import { EXIT_KIT, exitKitNow, pendingExitFrame, nextBastion } from './nether-plan'
import { act } from './act'
import { rest, nightGuard } from './guards'
import { walkAway, goToward } from './travel'
import { eatTo, craft, sticks } from './kit'
import { enterNether } from './nether-trip'
const gameClock: typeof import('../src/game-clock') = require('../src/game-clock')
async function arrowsRun (want = 48) {
  const t0 = gameClock.now()
  for (let k = 0; k < 24 && arrowsNow() < want && !died && gameClock.now() - t0 < 12 * 60000; k++) {
    await nightGuard()
    await refresh()
    if (have('stick') < 1) await sticks(4)
    if (!have('flint')) {
      if (have('gravel')) {
        const p = await act('place', { block: 'gravel' })
        if (p.status === 'done') { await act('mine', { block: 'gravel', dry: true, count: 1, radius: 6, timeoutSeconds: 20 }); continue }
      }
      const g = await act('mine', { block: 'gravel', dry: true, count: 8, radius: 40, timeoutSeconds: 120 })
      if (!(g.detail && g.detail.dug)) {
        const e = await act('explore', { block: 'gravel', dry: true, radius: 48, stepDistance: 60, timeoutSeconds: 90 })
        if (!(e.detail && e.detail.found)) break
      }
      continue
    }
    if (!have('feather')) {
      const o = await act('observe', { radius: 64 })
      const hen = ((o.detail && o.detail.entities) || []).find(e => /^chicken$/i.test(String(e.name || '')))
      if (hen) {
        if ((hen.dist ?? 0) > 20 && hen.pos) await act('goto', { x: hen.pos.x, z: hen.pos.z, range: 8, timeoutSeconds: 45, surface: 'strict' })
        for (let j = 0; j < 4 && !have('feather'); j++) {
          const f = await act('fight', { target: 'chicken', timeoutSeconds: 30, retreatAtHealth: 0 })
          if (f.status !== 'done') break
          await refresh()
        }
      } else await walkAway(64, 0)
      continue
    }
    const c: any = await craft('arrow', 4)
    await refresh()
    if (c && c.status && c.status !== 'done') break
  }
  log(`стрелы: ${arrowsNow()} (перьев ${have('feather')}, кремня ${have('flint')})`)
}
const OBSIDIAN_END = 4
const obsidianEnd = () => have('obsidian') + have('crying_obsidian')
const ARROWS_END = 32
// Одно ведро воды — допуск (клатч, МЛГ); второе — не повод охотиться за железом посреди пути к крепости (s5c-f4-1 06.10:
// ведро ушло на клатч по дороге → endkit «mine iron_ore» и разведка 11 мин). Бой с драконом воду не требует (dragon missing()).
const BUCKETS_END = 1
const FILL_END = 108
const END_FILL_RE = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone)$/
const fillNow = () => have(END_FILL_RE)
// Блоки на Край — до комнаты крепости не держат её поиск (s5c 06.10, f1-3/e02: мосты по пути съели набор, endkit копал
// камень у моря 20+ мин и в затопленной шахте): шахта к комнате сама даёт камень. Полный запас — к входу в Энд
// (known.endPortal: endkit копает под землёй у комнаты). Кровати, обсидиан, вода, лодка — как были.
const fillWant = () => known.endPortal ? FILL_END : 0
// Вода — так же: до комнаты не держит поиск крепости (у комнаты под землёй железо рядом).
const waterWant = () => known.endPortal ? BUCKETS_END : 0
const ENDKIT_OFF = process.env.ND_ENDKIT === '0'
const END_SEAM = process.env.ND_END_SEAM !== '0'
const endPrep = require('../src/campaign/end-prep')
const endPrepRefused = new Map<string, string>()
const endPrepRelevant = () => !!known.endPortal || !!known.stronghold || have('ender_eye') >= EYES_NEED
const endPrepState = () => JSON.stringify([state.inventory, state.health, state.food, sit.foes,
  state.pos && [Math.floor(state.pos.x / 8), Math.floor(state.pos.y / 8), Math.floor(state.pos.z / 8)]])
const endPrepOffer = () => endPrep.endPrepOffers(state.inventory || {}, BEDS_END).find(o => endPrepRefused.get(o.item) !== endPrepState())
async function pricedEndPrep () {
  await refresh()
  const offer = endPrepOffer()
  if (!offer) { log(`END_PREP_PRICE: сборы не окупаются; дальше к крепости; нехватка ${endCoreLack().join(', ') || 'нет'}`); return }
  log(`END_PREP_PRICE: ${offer.item} +${offer.count}; cost=${offer.cost}s value=${offer.value}s`)
  for (const step of offer.plan.steps) {
    const before = have(step.output.item)
    const r = await act('craft', { item: step.output.item, count: step.output.count })
    await refresh()
    if (died || strategyInterrupted || r.status === 'interrupted') return
    if (r.status !== 'done' || have(step.output.item) < before + step.output.count) {
      endPrepRefused.set(offer.item, endPrepState())
      log(`END_PREP_PRICE: ${step.output.item} не подтверждён — повтор после изменения рюкзака или места`)
      return
    }
  }
}
function endCoreLack () {
  return [
    have(/_bed$/) < BEDS_END ? `beds:${have(/_bed$/)}/${BEDS_END}` : '',
    obsidianEnd() < OBSIDIAN_END ? `obsidian:${obsidianEnd()}/${OBSIDIAN_END}` : '',
    have('water_bucket') < waterWant() ? `water:${have('water_bucket')}/${waterWant()}` : '',
    fillNow() < fillWant() ? `blocks:${fillNow()}/${fillWant()}` : ''
  ].filter(Boolean)
}
async function checkEndEntry () {
  if (!END_SEAM || ENDKIT_OFF) return
  // Еда и отдых — до 3 заходов: у комнаты еду рвёт тактика (чешуйницы), один отказ ещё не голод (S5d s5d-N-5: «hunger 17/18» → БЛОКЕР).
  for (let k = 0; k < 3 && !died; k++) {
    await eatTo(18)
    if ((state.health ?? 0) < 16) await rest()
    await refresh()
    if ((state.food ?? 0) >= 18 && (state.health ?? 0) >= 16) break
  }
  if (died) return
  const lackNow = () => [...endCoreLack(),
    have(FOOD) < FOOD_STOCK ? `food:${have(FOOD)}/${FOOD_STOCK}` : '',
    !have(/_sword$/) ? 'sword:0/1' : '',
    !have(/^(iron|diamond|netherite)_pickaxe$/) ? 'pick:0/1' : '',
    (state.health ?? 0) < 16 ? `hp:${state.health ?? 0}/16` : '',
    (state.food ?? 0) < 18 ? `hunger:${state.food ?? 0}/18` : ''
  ].filter(Boolean)
  let lack = lackNow()
  // Снимок рюкзака бывает пустым посреди клика окна (s5d-R-7/R-9 07.10: «food:0/8» при 15 стейках, «sword:0/1» с мечом в руке) —
  // при любой нехватке перечитать один раз, прежде чем стоп.
  if (lack.length) { await act('wait', { seconds: 1 }); await refresh(); lack = lackNow() }
  // Хп, сытость и запас еды — цена входа, а не допуск (гибкость, AGENTS.md 06.10): хп ≥ 10 и хоть 2 еды — вхожу с отметкой риска.
  const soft = lack.filter(x => /^(hp|hunger|food):/.test(x))
  if (soft.length && soft.length === lack.length && (state.health ?? 0) >= 10 && have(FOOD) >= 2) {
    log(`РИСК END_SEAM: ${soft.join(', ')} — вхожу (цена, не допуск)`)
    lack.length = 0
  }
  // Нехватка снаряжения (блоки, кровати, обсидиан станции, вода, меч, кирка) — тоже цена (S5e 07.10, правило гибкости): сборы
  // endkit уже исчерпаны (3 захода) или их нет, а стоп у портала — такой же провал прогона, как неудачный бой (s5d-O-2/O-3: «blocks
  // 101/108», «47/108» → БЛОКЕР). Стоп — только физически без средства боя: ни кровати, ни лука со стрелами, ни меча/топора.
  // ND_END_GEAR_PRICE=0 — прежний стоп.
  if (lack.length && process.env.ND_END_GEAR_PRICE !== '0') {
    const canHurt = have(/_bed$/) > 0 || (have('bow') && arrowsNow() > 0) || have(/_(sword|axe)$/) > 0
    if (canHurt) {
      if ((state.health ?? 0) < 10) { await rest(); await refresh() }
      log(`РИСК END_SEAM: ${lack.join(', ')} — вхожу (снаряжение — цена: сборов ${endkitRuns}/3, кроватей ${have(/_bed$/)}, стрел ${arrowsNow()}, меч ${have(/_sword$/) ? 'есть' : 'нет'})`)
      lack.length = 0
    }
  }
  if (lack.length) {
    const msg = `END_SEAM_NOT_READY: ${lack.join(', ')}; сборов ${endkitRuns}/3 — в Энд не вхожу`
    log(`БЛОКЕР: ${msg}`)
    throw Object.assign(new Error(msg), { stopCampaign: true, code: 'END_SEAM_NOT_READY' })
  }
  if (!have('bow') || arrowsNow() < ARROWS_END || have(/^(enchanted_)?golden_apple$/) < 3) {
    log(`РИСК END_PROFILE: лук ${have('bow')}, стрел ${arrowsNow()}/${ARROWS_END}, яблок ${have(/^(enchanted_)?golden_apple$/)}/3; броня ${JSON.stringify(state.armor || {})} — это не набор campaign2 с Protection II`)
  }
}
const endkitPending = () => END_PREP_PRICE
  ? !ENDKIT_OFF && !known.dragonWon && dim() === 'overworld' && endPrepRelevant() && !!endPrepOffer()
  : END_SEAM
  ? !ENDKIT_OFF && !known.dragonWon && dim() === 'overworld' && endkitRuns < 3 &&
    (!!known.endPortal || have('ender_eye') >= EYES_NEED ||
      (have('ender_eye') + have('ender_pearl') >= EYES_NEED && have(/^(blaze_rod|blaze_powder)$/) > 0)) &&
    (endCoreLack().length > 0 || (!known.endPortal && !have(/_boat$/)))
  : !ENDKIT_OFF && !known.dragonWon && !known.endPortal && have('ender_eye') + have('ender_pearl') >= EYES_NEED &&
    rodsNow() >= 6 && endkitRuns < 3 && (have(/_bed$/) < BEDS_END || obsidianEnd() < OBSIDIAN_END || have('water_bucket') < BUCKETS_END || !have(/_boat$/) || fillNow() < FILL_END)

// К крепости Края через Ад — по умолчанию (S5d 07.10, ND_SH_NETHER=0 — пешком поверху): при раме (10 обсидиана или алмазная кирка)
// и огниве выход у крепости. s5d-H (10 сидов, пошаговый): путь до крепости медиана 5.1 игр. мин против 13.4 поверху у S5c (s5c-f2..g3),
// смертей в Аду на этом участке 0. Цели бартера на раму (EXIT_KIT, obsidian 10 в бастионе) по-прежнему за ND_SH_NETHER=1 / ND_EXIT_KIT.
const SH_NETHER = process.env.ND_SH_NETHER !== '0'
const SH_BLIND = process.env.ND_SH_BLIND === '1'
const SH_NETHER_MIN = 500
let shNetherTries = 0
const atExitTarget = () => process.env.ND_EXIT_LOCAL_RETRY !== '0' && dim() === 'the_nether' && known.stronghold && state.pos &&
  Math.hypot(state.pos.x - Math.floor(known.stronghold.x / 8), state.pos.z - Math.floor(known.stronghold.z / 8)) <= 12
const canLink = () => pendingExitFrame() || ((shNetherTries < 2 || atExitTarget()) && lighter() && (have('obsidian') >= 10 || have(PICK_DIAMOND) > 0))
async function prepareExitSupply (T) {
  await refresh(); await sense()
  const n = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
  const me = state.pos || n
  const want = Math.ceil(2 * (Math.abs(n.x - me.x) + Math.abs(n.z - me.z))) + 128
  if ((sit.pickLeft || 0) >= want && have('crafting_table')) return true
  const until = gameClock.now() + 180000
  const step = async (method, args = {}) => {
    if (died || gameClock.now() >= until) return null
    const p: any = { ...args }
    if (p.timeoutSeconds) p.timeoutSeconds = Math.max(1, Math.min(p.timeoutSeconds, Math.floor((until - gameClock.now()) / 1000)))
    const r = await act(method, p); await refresh(); return r
  }
  log('набор на выход: пополнение ≤180 с; сначала сундуки и железо, затем чёрный камень; дерево из сундука ≤20 с, стебли ≤60 с')
  if (sit.foes) {
    const r = await step('ne_burrow', { why: 'набор на выход: крафт под укрытием', timeoutSeconds: 30 })
    if (!r?.detail?.ok) { log('набор на выход: укрытие не подтвердилось — пополнение не начинаю'); return false }
    await sense()
  }
  for (let k = 0; k < 2; k++) {
    const iron = have('iron_block') * 9 + Math.floor(have('iron_nugget') / 9)
    if (!iron) break
    const before = have('iron_ingot'); await step('craft', { item: 'iron_ingot', count: iron })
    if (have('iron_ingot') <= before) break
  }
  await sense()
  const deficit = Math.max(0, want - (sit.pickLeft || 0))
  const ironPicks = Math.min(Math.floor(have('iron_ingot') / 3), Math.ceil(deficit / 250))
  const stonePicks = Math.ceil(Math.max(0, deficit - ironPicks * 250) / 131)
  const picks = ironPicks + stonePicks
  if (picks > 8) { log(`набор на выход: нужно ${picks} кирок — отдельный путь пополнения, один крафт не решит`); return false }
  const planksNeeded = () => (!have('crafting_table') ? 4 : 0) + 2 * Math.ceil(Math.max(0, 2 * picks - have('stick')) / 4)
  if (have(/_planks$/) + 4 * have(LOGS) < planksNeeded()) {
    await step('chest_take', { item: 'all', timeoutSeconds: 20 })
    if (have(/_planks$/) + 4 * have(LOGS) < planksNeeded()) await step('mine', {
      block: 'crimson_stem,warped_stem', count: Math.ceil((planksNeeded() - have(/_planks$/)) / 4), radius: 32, timeoutSeconds: 60
    })
  }
  while (!died && gameClock.now() < until && have(/_planks$/) < planksNeeded() && have(LOGS)) {
    const item = planksFor(); if (!item) break
    const before = have(/_planks$/); await step('craft', { item, count: 4 })
    if (have(/_planks$/) <= before) break
  }
  if (!have('crafting_table') && have(/_planks$/) >= 4) await step('craft', { item: 'crafting_table', count: 1 })
  if (!have('crafting_table')) return false
  const sticks = 4 * Math.ceil(Math.max(0, 2 * picks - have('stick')) / 4)
  if (sticks && have(/_planks$/) >= sticks / 2) await step('craft', { item: 'stick', count: sticks })
  for (let i = 0; i < picks && !died && gameClock.now() < until; i++) {
    await sense()
    if ((sit.pickLeft || 0) >= want) break
    if (have('iron_ingot') < 3 && have(COBBLE) < 3) await step('mine', {
      block: 'blackstone', count: Math.max(3, 3 * stonePicks - have(COBBLE)), radius: 16, timeoutSeconds: 45
    })
    const item = have('iron_ingot') >= 3 ? 'iron_pickaxe' : have(COBBLE) >= 3 ? 'stone_pickaxe' : null
    if (!item || have('stick') < 2) break
    const before = have(item); await step('craft', { item, count: 1 })
    if (have(item) <= before) break
  }
  await refresh(); await sense()
  const ok = !died && (sit.pickLeft || 0) >= want && !!have('crafting_table')
  log(`набор на выход: удары ${sit.pickLeft || 0}/${want}, верстак ${have('crafting_table')}, палки ${have('stick')}; ${ok ? 'готов' : 'пополнение не завершено за один бюджет'}`)
  return ok
}
async function prepareExitTools (T) {
  if (process.env.ND_EXIT_SUPPLY !== '0' && state.dimension === 'the_nether') return prepareExitSupply(T)
  await refresh(); await sense()
  const n = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
  const me = state.pos || n
  const want = Math.ceil(2 * (Math.abs(n.x - me.x) + Math.abs(n.z - me.z))) + 128
  // Враг рядом — крафт не начинаю, но и путь через Ад не отменяю, если взмахов кирок хватает хотя бы на 60 % (докрафт — в Аду,
  // prepareExitSupply/restockPicks): s5d-N-1 07.10 — моб у портала на старте, «сначала закончить бой» → 1461 бл. пешком.
  if (sit.foes) { const ok = (sit.pickLeft || 0) >= 0.6 * want; log(`набор на выход: рядом враг — крафт не начинаю; взмахов ${sit.pickLeft || 0}/${want}${ok ? ', хватит — иду' : ''}`); return ok }
  const needPicks = Math.max(0, Math.ceil((want - (sit.pickLeft || 0)) / 131))
  let planks = (!have('crafting_table') ? 4 : 0) + 2 * Math.ceil(Math.max(0, 2 * needPicks + 12 - have('stick')) / 4)
  while (have(/_planks$/) < planks && have(LOGS) && !died) {
    const item = planksFor(); if (!item) break
    const before = have(/_planks$/)
    await act('craft', { item, count: 4 }); await refresh()
    if (have(/_planks$/) <= before) break
  }
  if (!have('crafting_table') && have(/_planks$/) >= 4) await act('craft', { item: 'crafting_table', count: 1 })
  await refresh()
  if (!have('crafting_table')) { log('набор на выход: нет переносного верстака — остаюсь до пополнения'); return false }
  if (have('stick') < 2 * needPicks + 12 && have(/_planks$/) >= 2) await act('craft', { item: 'stick', count: 4 * Math.ceil((2 * needPicks + 12 - have('stick')) / 4) })
  for (let i = 0; i < needPicks && !died && have(COBBLE) >= 3 && have('stick') >= 2; i++) {
    const before = have('stone_pickaxe')
    await act('craft', { item: 'stone_pickaxe', count: 1 }); await refresh()
    if (have('stone_pickaxe') <= before) break
  }
  await sense(); await refresh()
  // Взмахов кирок на дорогу хватает — иду и без верстака/палок (запас на ремонт — цена, а не допуск; s5d-H-3 07.10: «верстак сломал,
  // но подобрать не успел» при 774/654 взмахах → 1435 бл. пешком).
  const ok = (sit.pickLeft || 0) >= want && (process.env.ND_EXIT_SUPPLY !== '0' || (have('stick') >= 12 && !!have('crafting_table')))
  log(`набор на выход: обсидиан ${have('obsidian')}/10, огонь ${lighter() ? 'есть' : 'нет'}, удары кирок ${sit.pickLeft || 0}/${want}, палки ${have('stick')}/12, верстак ${have('crafting_table')}; ${ok ? 'готов' : 'нужно пополнить, пешком домой не иду'}`)
  return ok
}
async function viaNetherTo (T, why) {
  if (EXIT_KIT) {
    await refresh()
    const kit = exitKitNow()
    const resuming = pendingExitFrame() && exitFrameTarget.x === T.x && exitFrameTarget.z === T.z
    if (!kit.ready && !resuming) { log(`${why}: набор на выход не готов: ${JSON.stringify(kit.need)} — до точки Края не иду`); return false }
    if (!resuming && !(await prepareExitTools(T))) return false
  }
  shNetherTries++
  const N = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
  log(`${why}: через Ад к ${T.x},${T.z} — точка Ада ${N.x},${N.z}; обсидиана ${have('obsidian')}, огниво ${lighter() ? 'есть' : 'нет'}`)
  if (dim() === 'overworld') {
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
    }
    let e = await enterNether()
    await refresh()
    // Не дошёл до своего портала в 48 бл. (джунгли: лоза и листва — «stuck» на месте, s5e-A-3 07.10: 1456 бл. поверху и море у
    // крепости вместо 180 бл. Ада) — ещё раз через goto к раме (копает листву), прежде чем отказаться от пути через Ад.
    if (dim() === 'overworld' && known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) <= 48 && !died) {
      log(`${why}: в портал не вошёл (${(e.detail && e.detail.stopped) || e.error || 'нет'}) — ещё раз к раме`)
      await act('goto', { x: known.portal.x, y: known.portal.y, z: known.portal.z, range: 2, timeoutSeconds: 60 })
      e = await enterNether()
      await refresh()
    }
    if (!(e.detail && e.detail.went) || dim() !== 'the_nether') { log(`${why}: в Ад не вошёл`); return false }
  }
  if (dim() !== 'the_nether') return false
  if (have('obsidian') >= 10) {
    // В 3 бл. от точки Ада, а не в 6: рама в 6–7 бл. — выход наверху в 50–80 бл. от крепости (S5d s5d-p4/p5).
    // Рама выхода повыше (y 80–112): сервер ставит выход наверху у ближайшей к (8x, y, 8z) годной точки — с рамы на y 23–65
    // выход попадал в пещеры у крепости (s5d-p5-1: вода и зомби; s5d-N-1: капельник), с высокой — на поверхность. ND_EXIT_HIGH=0 — выкл.
    await goToward({ x: N.x, z: N.z, ...(process.env.ND_EXIT_HIGH !== '0' ? { ry: 96, rdy: 16 } : {}) }, 3)
    await refresh()
    if (died || dim() !== 'the_nether') return false
    // Сетка не довела, а до точки ≤ 60 бл. (goToward штрекует только дальше 60) — штрек к точке: s5d-H-8 07.10 — «по сетке дальше пути
    // нет» в 24 бл., link пешком «pathfinder не нашёл» 4.5 игр. мин, потом домой и поверху.
    const left = state.pos ? Math.hypot(state.pos.x - N.x, state.pos.z - N.z) : 0
    if (left > 8 && left <= 60) {
      await act('nether_tunnel', { x: N.x, z: N.z, radius: 4, ironOk: !nextBastion(), timeoutSeconds: Math.round(120 + left * 3) })
      await refresh()
      if (died || dim() !== 'the_nether') return false
    }
  }
  // Точка выхода у бастиона (S5e 07.10, честно — по видимому: блоки бастиона в памяти глаз в 32 бл., брут видим/слышим): рама там —
  // бруты (s5d-R-3/T-3, s5e-M-3/G-3 на сиде −7145914149339214824: «slain by Piglin Brute»). Отойти от центра увиденного бастиона на
  // 40 бл. (в Аду; наверху это ~320 бл. дальше от крепости — дешевле смерти) и раму ставить там. ND_EXIT_BASTION=0 — прежнее.
  let TT = T
  if (dim() === 'the_nether' && process.env.ND_EXIT_BASTION !== '0' && state.pos && !died) {
    const sb = await act('perceive', { mode: 'seen', re: '^(gilded_blackstone|polished_blackstone_bricks|cracked_polished_blackstone_bricks|chiseled_polished_blackstone|polished_blackstone_brick_(slab|stairs|wall))$', max: 40, maxDist: 32 })
    const en = await act('perceive', { mode: 'entities', radius: 24 })
    const seen = (sb.detail && sb.detail.seen) || []
    const brutes = ((en.detail && en.detail.entities) || []).filter(e => e && /piglin_brute/.test(e.name || ''))
    if (seen.length >= 3 || brutes.length) {
      const pts = seen.length ? seen : brutes.map(e => e.pos || e.lastPos).filter(Boolean)
      const C = pts.length ? { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, z: pts.reduce((s, q) => s + q.z, 0) / pts.length } : state.pos
      const N0 = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
      let dx = N0.x - C.x; let dz = N0.z - C.z
      const L = Math.hypot(dx, dz)
      if (L < 1) { dx = -(T.z / 8 - state.pos.z); dz = T.x / 8 - state.pos.x }
      const n = Math.hypot(dx, dz) || 1
      const N2 = { x: Math.round(C.x + dx / n * 40), z: Math.round(C.z + dz / n * 40) }
      log(`${why}: у точки выхода бастион (блоков ${seen.length}, брутов ${brutes.length}) — рама в 40 бл. от него: точка Ада ${N2.x},${N2.z}`)
      await goToward({ x: N2.x, z: N2.z }, 3)
      await refresh()
      if (died || dim() !== 'the_nether') return false
      TT = { x: N2.x * 8 + 4, z: N2.z * 8 + 4 }
    }
  }
  for (let k = 0; k < 2 && dim() === 'the_nether' && !died; k++) {
    const obsBefore = have('obsidian')
    const t = await act('stronghold', { mode: 'travel', x: TT.x, z: TT.z, go: false, timeoutSeconds: 420 })
    await refresh()
    const td = t.detail || {}
    if (dim() === 'the_nether' && have('obsidian') < obsBefore && (td.build || td.link)) setExitFrameTarget({ ...TT })
    if (dim() === 'overworld') setExitFrameTarget(null)
    log(`${why}: travel — ${dim() === 'overworld' ? 'вышел наверх' : 'ещё в Аду'}${td.stopped ? ': ' + td.stopped : ''}`)
  }
  await readMemory()
  return dim() === 'overworld' && !!state.pos && Math.hypot(T.x - state.pos.x, T.z - state.pos.z) <= (TT === T ? 160 : 480)
}

export { OBSIDIAN_END, obsidianEnd, ARROWS_END, BUCKETS_END, fillNow, fillWant, waterWant, ENDKIT_OFF, END_SEAM,
  endPrepRelevant, endPrepOffer, pricedEndPrep, checkEndEntry, endkitPending, SH_NETHER, SH_BLIND, SH_NETHER_MIN,
  canLink, viaNetherTo }
