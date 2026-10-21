'use strict'
// Еда: охота, кровать, готовка, печь на обратном пути.
import { OW_DEEP } from './flags'
import { state, sit, died, known, foodSpentMs, huntWool, wantBeds, setHunting } from './state'
import { log } from './log'
import { have, y, dim, LOGS, COBBLE, RAW, FOOD, netherFoodHave, planksFor } from './queries'
import { sense, refresh } from './observe'
import { weakAndHungry, netherFoodNeed, nightWork, FOOD_CAP_MS, entrySupplies, foodShort } from './stages/table'
import { act } from './act'
import { nightGuard, recoverGuard } from './guards'
import { walkAway } from './travel'
import { craft, unclutter, smeltAll, ensurePick } from './kit'
import { toSurface } from './underground'
import { ROUTE_COOKED_HUNGER, routeCookedHunger } from './route-wiring'
import * as gameClock from '../src/game-clock'
async function foodRun () {
  // S: a cancelled wood action may already have delivered the recipe. Buy the carried pick before a food walk;
  // do not search for extra wood or fund an optional reserve from this food step.
  if (process.env.ND_OW_STARTER === '1' && dim() === 'overworld' && state.playPolicy?.mode === 'speedrun' &&
      !known.portal && !died && !have(/_pickaxe$/) && have(LOGS) * 4 + have(/_planks$/) >=
      (have('crafting_table') ? 0 : 4) + 3 + 2 * Math.ceil(Math.max(0, 2 - have('stick')) / 4)) {
    await ensurePick()
    if (died) return
  }
  await cook()
  await makeBed()
  const woolMax = () => Math.max(0, ...Object.entries(state.inventory || {}).filter(([k]) => /_wool$/.test(k)).map(([, v]) => Number(v)))
  const wantWool = () => !entrySupplies() && (huntWool || !have(/_bed$/)) && have(/_bed$/) + Math.floor(woolMax() / 3) < wantBeds
  if (!foodShort() && !wantWool()) return
  await sense()
  if (process.env.ND_OW_FOOD_VISIBLE === '1' && !known.portal && dim() === 'overworld' && !sit.surface && (state.food ?? 20) >= 8 &&
      !weakAndHungry() && !(have(/bucket$/) && have(/^(flint_and_steel|fire_charge)$/))) { log('еда: до набора портала с глубины за охотой не поднимаюсь — сытость хватает'); return }
  if (OW_DEEP && known.portal && !sit.surface && y() < 40 && netherFoodHave() >= netherFoodNeed()) { log(`еды ${netherFoodHave()} — на вход в Ад хватает, с глубины за запасом не поднимаюсь`); return }
  // В спидране охоту уже выбрал граф по цене; старый общий бюджет не отменяет его шаг без действий.
  const deepEarly = OW_DEEP && !known.portal && state.playPolicy?.mode !== 'speedrun'
  if (deepEarly && /frozen|peaks|ice_spikes|snowy_slopes|grove/.test(String(state.biome || ''))) { log(`охота: ${state.biome} — рыхлый снег, звери редки; без охоты`); return }
  const remaining = deepEarly ? Math.max(0, FOOD_CAP_MS - foodSpentMs) : 120000
  if (deepEarly && remaining < 10000 && !weakAndHungry()) { log('охота: бюджет до портала (3 мин) исчерпан'); return }
  const deadline = gameClock.now() + (deepEarly ? Math.min(60000, remaining) : 120000)
  if (!(await toSurface(4, deadline))) { log('за едой не вышел на поверхность — сначала устранить причину подъёма'); return }
  await unclutter()
  if (have(/^bucket$/) && !have('water_bucket')) await act('bucket', { fluid: 'water', radius: 32 })
  let blocked = false
  let climbing = false
  let searchedMelons = false
  for (let i = 0; i < 4 && gameClock.now() < deadline && (foodShort() > 0 || wantWool()); i++) {
    await sense()
    if (nightWork()) break
    await nightGuard()
    await recoverGuard()
    if (died) return
    if (gameClock.now() >= deadline) break
    const o = await act('observe', { radius: 64 })
    const ents = (o.detail && o.detail.entities) || []
    const melons = (Array.isArray(o.detail?.blocks) ? o.detail.blocks : []).some(b => b.name === 'melon')
    if (foodShort() > 0 && (melons || (!searchedMelons && /jungle/.test(state.biome || '')))) {
      searchedMelons = true
      await act('mine', { block: 'melon', count: Math.min(4, Math.ceil(foodShort() / 1.5)),
        radius: 64, timeoutSeconds: 30 })
      if (died) return
      if (!foodShort() && !wantWool()) break
    }
    // Visible water alone is no attacker. Actual drowning/hostiles remain handled by act and the body's reflexes.
    const myY = y()
    const animals = ents.filter(e => /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(String(e.name || '').toLowerCase()) &&
      !(e.pos && Math.abs(e.pos.y - myY) > 6))
    const woolFor = !entrySupplies() && have(/_bed$/) + Math.floor(woolMax() / 3) < Math.max(2, wantBeds)
    const foodFull = !foodShort()
    const prey = (woolFor && animals.find(e => /^sheep$/i.test(e.name))) || (foodFull ? null : animals[0])
    if (prey) {
      const kind = String(prey.name).toLowerCase()
      if ((prey.dist ?? 0) > 20 && prey.pos) await act('goto', { x: prey.pos.x, z: prey.pos.z, range: 8, timeoutSeconds: 45, surface: 'strict' })
      for (let k = 0; k < 4 && gameClock.now() < deadline && (foodShort() > 0 || (kind === 'sheep' && wantWool())) && !died; k++) {
        const f = await act('fight', { target: kind, timeoutSeconds: 40, retreatAtHealth: 0,
          purpose: kind === 'sheep' && wantWool() && !foodShort() ? 'resource' : 'food',
          ...(kind === 'sheep' && wantWool() && !foodShort() ? { resourceGoal: { item: 'wool', count: have(/_wool$/) + wantBeds * 3 - woolMax() } } : {}) })
        if (f.detail?.stopped) return
        if (f.status !== 'done' || (state.health ?? 20) < 10) break
      }
      await refresh()
      if (have(RAW) >= 1 && ((state.health ?? 20) < 14 || (state.food ?? 20) < 14)) {
        await cook()
        if (have(FOOD) && (state.food ?? 20) < 20) await act('eat')
      }
    } else {
      // ND_OW_PREP_NEAR=1: портал горит — звери только в поле зрения у портала, без ходов по 64 бл. (owC1-03: после литья на 21-й мин
      // сборы еды увели на 400 бл. от портала, сумерки, ночь — в Ад не вошёл до 40-й мин). Вход — по READY.nether с ценой голода.
      // Пустая охота засчитывается этапом food (foodHuntEmpty) — READY.nether её видит.
      if (typeof process !== 'undefined' && process.env.ND_OW_PREP_NEAR === '1' && known.portal && dim() === 'overworld') break
      // ND_OW_FOOD_VISIBLE=1: до набора портала (ведро и огниво) — только видимые звери, без ходов по 64 бл. за едой при сытости ≥ 8
      // (до вехи iron этап food — 3.1 игр. мин на прогон, C12/R32/R37/D0, 90 прогонов; owR37-10: 5 мин овец и хода на 100 бл. до шахты).
      if (process.env.ND_OW_FOOD_VISIBLE === '1' && !known.portal && dim() === 'overworld' && (state.food ?? 20) >= 8 && !weakAndHungry() &&
          !(have(/bucket$/) && have(/^(flint_and_steel|fire_charge)$/))) break
      if (!(await toSurface(4, deadline))) break
      const y0 = y()
      const w = await walkAway(64, blocked || climbing ? Math.PI / 2 : 0)
      blocked = !(w && w.status === 'done')
      climbing = y() - y0 >= 12 || (y() > 100 && y() >= y0)
    }
    await makeBed()
  }
  await cook()
  await makeBed()
}
async function quickHunt () {
  await sense()
  if (!sit.surface || sit.night || (state.health ?? 20) < 10) return
  const until = gameClock.now() + 60000
  setHunting(true)
  try {
    for (let k = 0; k < 3 && gameClock.now() < until && !died; k++) {
      const o = await act('observe', { radius: 32 })
      const ents = (o.detail && o.detail.entities) || []
      const prey = ents.filter(e => /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(String(e.name || '').toLowerCase()) &&
        (e.dist ?? 99) <= 24 && !(e.pos && Math.abs(e.pos.y - y()) > 4)).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99))[0]
      if (!prey) break
      const f = await act('fight', { target: String(prey.name).toLowerCase(), timeoutSeconds: 25, retreatAtHealth: 0, purpose: 'food' })
      if (f.detail?.stopped) return
      if (f.status !== 'done') break
    }
  } finally { setHunting(false) }
  await refresh()
  if (have(RAW)) await cook()
}

async function makeBed () {
  if (have(/_bed$/) >= Math.max(2, wantBeds)) return
  if (have(/_wool$/) < 3) return
  await unclutter()
  const inv = state.inventory || {}
  let wool: any = Object.entries(inv).filter(([k]) => /_wool$/.test(k)).sort((a: any, b: any) => b[1] - a[1])[0]
  if ((!wool || wool[1] < 3) && have(/_wool$/) >= 3 &&
    have('white_dye') + have('bone_meal') + have('bone') * 3 >= 3 - have('white_wool')) {
    const need = 3 - have('white_wool')
    for (let i = 0; i < 3 && have('white_dye') < need; i++) {
      const before = have('white_dye')
      const meal = Math.max(0, need - before)
      if (have('bone_meal') < meal) await craft('bone_meal', Math.ceil((meal - have('bone_meal')) / 3) * 3)
      if (have('white_dye') < need) await craft('white_dye', need - have('white_dye'))
      if (have('white_dye') <= before) break
    }
    for (let i = 0; i < 3 && have('white_wool') < 3 && have('white_dye'); i++) {
      const before = have('white_wool')
      await craft('white_wool', Math.min(3 - before, have('white_dye')))
      if (have('white_wool') <= before) break
    }
    wool = Object.entries(state.inventory || {}).filter(([k]) => /_wool$/.test(k)).sort((a: any, b: any) => b[1] - a[1])[0]
  }
  if (!wool || wool[1] < 3) return
  const sameMax = () => Math.max(0, ...Object.entries(state.inventory || {}).filter(([k]) => /_planks$/.test(k)).map(([, v]) => Number(v)))
  const tableNeed = have('crafting_table') ? 0 : 4
  if (sameMax() < 3 + tableNeed) { const p = planksFor(); if (p) await craft(p, have(p) >= 3 + tableNeed ? 0 : 4 * Math.ceil((3 + tableNeed - have(p)) / 4)) }
  await refresh()
  await craft(wool[0].replace(/_wool$/, '_bed'))
  if (!have(/_bed$/) && sameMax() < 3) { const p = planksFor(); if (p) { await craft(p, 4); await craft(wool[0].replace(/_wool$/, '_bed')) } }
}

async function cook ({ reserveHunger = Infinity } = {}) {
  await refresh()
  const raw = () => Object.keys(state.inventory || {}).filter(k => RAW.test(k) && have(k) > 0)
  const needed = r => r === 'chicken' || !Number.isFinite(reserveHunger) ? have(r) :
    Math.min(have(r), Math.max(0, Math.ceil((reserveHunger - routeCookedHunger()) / ROUTE_COOKED_HUNGER[`cooked_${r}`])))
  const complete = () => raw().every(r => needed(r) === 0)
  const batch = async () => {
    for (const r of raw()) {
      const max = needed(r)
      if (max > 0) { await smeltAll(r, `cooked_${r}`, { max }); await refresh() }
    }
  }
  if (!raw().length) return
  await batch()
  await refresh()
  if (complete() || have('furnace') || have(COBBLE) >= 8) { if (complete()) await furnaceBack(); return }
  // Без настоящего топлива новая печь не поможет: камень на неё не копать.
  // (s8-r2-8: quickHunt у портала → cook → mine stone 8 за 34 с, жарить всё равно нечем).
  if (!have(/^(coal|charcoal)$/) && !have('lava_bucket') && !have(/^(?!crimson_|warped_).*_(log|planks)$/)) { log('жарить нечем: топлива нет — печь не копаю'); return }
  await act('mine', { block: 'stone', count: 8, radius: 32, dry: true, timeoutSeconds: 120 })
  if (have(COBBLE) < 8) await act('dig_down', { mode: 'stairs', depth: 6, torchEvery: 0, timeoutSeconds: 120 })
  await batch()
  await refresh()
  if (complete()) await furnaceBack()
}
async function furnaceBack () {
  if (!OW_DEEP || known.portal || have('furnace') || dim() !== 'overworld') return
  await refresh()
  if (have('furnace') || !have(/_pickaxe$/)) return
  await act('mine', { block: 'furnace', count: 1, radius: 6, timeoutSeconds: 20 })
}

export { foodRun, quickHunt, makeBed, cook, furnaceBack }
