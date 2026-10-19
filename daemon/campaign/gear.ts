'use strict'
// Броня и щит: ранний щит, железо на снаряжение, цена брони.
import { strategyInterrupted, state, sit, died, resting, fighting, known, fightGearWanted } from './state'
import { log } from './log'
import { have, dim, PICK_IRON, planksFor, portalBuckets, ARMOR_POINTS, armorPointsNow, shieldOn, lighter } from './queries'
import { sense, refresh } from './observe'
import { act } from './act'
import { ensureTable, craft, sticks } from './kit'
let earlyShieldBusy = false
let earlyShieldFailed = null
async function earlyShield () {
  if (process.env.ND_OW_SHIELD === '0' || earlyShieldBusy || died || fighting || resting || strategyInterrupted || state.connected === false || state.playPolicy?.mode === 'free' || dim() !== 'overworld' || have('iron_ingot') < 1 || shieldOn()) return false
  const quote = () => require('../src/ow-shield').price({ inventory: state.inventory, shield: shieldOn(), hp: state.health ?? 20,
    night: !!sit.night, surface: sit.surface !== false, kitIron: 3 * Math.max(0, portalBuckets() - have(/bucket$/)) + (lighter() ? 0 : 1),
    exposedDps: (sit.fight?.order || []).reduce((n, f) => n + (f.dps || 0), 0) })
  if (!quote().take) return false
  await refresh(); await sense()
  const p = quote(), cause = JSON.stringify([state.pos && [Math.floor(state.pos.x), Math.floor(state.pos.y), Math.floor(state.pos.z)],
    Object.entries(state.inventory || {}).sort(([a], [b]) => a.localeCompare(b)), state.offHand, sit.fight?.order?.map(f => [f.name, Math.floor(f.dist)])])
  if (!p.take || earlyShieldFailed === cause) return false
  earlyShieldBusy = true
  try {
    await ensureTable()
    if (have(/_planks$/) < 6) { const pl = planksFor(); if (pl) await craft(pl, 4 * Math.ceil((6 - have(/_planks$/)) / 4)) }
    await refresh()
    log(`ранний щит: цена ${Math.round(p.costS)} с, ожидаемая потеря без него +${Math.round(p.avoidedS)} с`)
    if (have(/_planks$/) >= 6 && await craft('shield')) { await act('armor'); earlyShieldFailed = null; return true }
    earlyShieldFailed = cause
    return false
  } catch (e) { earlyShieldFailed = cause; throw e } finally { earlyShieldBusy = false }
}
async function spendIron () {
  await refresh()
  if (have('iron_block')) await craft('iron_ingot', 9 * have('iron_block'))
  if (have('iron_nugget') >= 9) await craft('iron_ingot', Math.floor(have('iron_nugget') / 9))
  await earlyShield()
  const noShield = () => !have('shield') && !(state.offHand && /shield/.test(JSON.stringify(state.offHand)))
  const plan = known.portal ? [
    ['flint_and_steel', 1, () => !lighter() && have('flint') > 0],
    ['iron_pickaxe', 3, () => !have(PICK_IRON)],
    ['bucket', 3, () => have(/bucket$/) < 1],
    ['shield', 1, noShield],
    ['iron_chestplate', 8, () => !worn('torso')],
    ['iron_sword', 2, () => !have(/^(iron|diamond|netherite)_sword$/)],
    ['iron_leggings', 7, () => !worn('legs')],
    ['iron_helmet', 5, () => !worn('head')],
    ['iron_boots', 4, () => !worn('feet')]
  ] : [
    ['bucket', 3, () => have(/bucket$/) < 1],
    ['flint_and_steel', 1, () => !lighter() && have('flint') > 0],
    ['bucket', 3, () => have(/bucket$/) < portalBuckets()],
    ['shield', 1, noShield],
    ['iron_pickaxe', 3, () => !have(PICK_IRON)],
    ['iron_chestplate', 8, () => !worn('torso')],
    ['iron_sword', 2, () => !have(/^(iron|diamond|netherite)_sword$/)],
    ['iron_leggings', 7, () => !worn('legs')],
    ['iron_boots', 4, () => !worn('feet')],
    ['iron_helmet', 5, () => !worn('head')]
  ]
  for (const [item, cost, want] of (plan as any)) {
    await refresh()
    const keep = (item !== 'flint_and_steel' && !lighter() ? 1 : 0) +
      (!known.portal && item !== 'bucket' ? 3 * Math.max(0, portalBuckets() - have(/bucket$/)) : 0)
    if (!want() || have('iron_ingot') < cost + keep) continue
    if (ARMOR_POINTS[item]) {
      const g = gearWorth(item, { inBag: true })
      const forFight = fightGearWanted && /chestplate|leggings|helmet/.test(item)
      log(g.line + (forFight && !g.take ? ' — но бой у спавнера без неё не выигрывался (ферма 29.09: 0 из 8) — беру' : ''))
      if (!g.take && !forFight) continue
    }
    if (item === 'shield' && have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
    if (/_(pickaxe|sword)$/.test(item)) await sticks(2)
    await craft(item)
  }
  await act('armor')
}

// Цена смерти — та же, что у графа (riskPenalty 72000 тиков = 60 мин, core/strategy.ts): при keep_inventory=false смерть —
// потеря рюкзака и прогона (правило пользователя 02.10). Прежние 6 мин считали её мелкой задержкой — броня «не окупалась»
// никогда, и тело шло в ночь и в Ад голым (cl-a…cl-d 14.10). ND_DEATH_COST_MIN — для сравнения.
const GEAR_CALC = { MIN_PER_INGOT: 1.1, TRIP_MIN: 4, CRAFT_MIN: 0.3, DEATHS_PER_H_AT8: 4, NETHER_H: 0.5, DEATH_COST_MIN: Number(process.env.ND_DEATH_COST_MIN) || 60, HIT: 6 }
const ARMOR_COST = { iron_chestplate: 8, iron_leggings: 7, iron_helmet: 5, iron_boots: 4, golden_helmet: 5 }
const ARMOR_SLOT = { chestplate: 'torso', leggings: 'legs', helmet: 'head', boots: 'feet' }
const armorCut = pts => Math.min(20, Math.max(pts / 5, pts - 4 * GEAR_CALC.HIT / 8)) / 25
function gearWorth (item, { inBag = false } = {}) {
  const C = GEAR_CALC
  const pts0 = armorPointsNow()
  const slot = ARMOR_SLOT[item.split('_').pop()]
  const wornName = (state.armor || {})[slot]
  const pts1 = pts0 - (wornName ? (ARMOR_POINTS[String(wornName)] || 0) : 0) + (ARMOR_POINTS[item] || 0)
  const rate = pts => C.DEATHS_PER_H_AT8 * (1 - armorCut(pts)) / (1 - armorCut(8))
  const d0 = rate(pts0) * C.NETHER_H
  const d1 = rate(pts1) * C.NETHER_H
  const firstDeath = process.env.ND_ARMOR_FIRST_DEATH === '1'
  // shortcut: constant hazard is an A/B assumption; replace it with measured first-death probabilities when available.
  const gain = Math.max(0, firstDeath ? Math.exp(-d1) - Math.exp(-d0) : d0 - d1) * C.DEATH_COST_MIN
  const need = ARMOR_COST[item] || 0
  const gold = /^golden_/.test(item)
  const haveBars = gold ? have('gold_ingot') + have('raw_gold') : have('iron_ingot') + have('raw_iron')
  const missing = inBag ? 0 : Math.max(0, need - haveBars)
  const cost = missing ? C.TRIP_MIN + missing * C.MIN_PER_INGOT : C.CRAFT_MIN
  const take = pts1 > pts0 && gain > cost
  const f = x => (Math.round(x * 10) / 10).toString()
  const exposure = firstDeath
    ? `риск первой смерти в Аду за ${f(C.NETHER_H * 60)} мин: ${f((1 - Math.exp(-d0)) * 100)}% → ${f((1 - Math.exp(-d1)) * 100)}%`
    : `смертей в Аду за ${f(C.NETHER_H * 60)} мин: ${f(d0)} → ${f(d1)}`
  return {
    take, cost, gain, missing,
    line: `броня по расчёту: ${item} — ${missing ? `поход за ${missing} слитк. ≈ ${f(cost)} мин` : `из рюкзака ≈ ${f(cost)} мин`} против пользы ${f(gain)} мин ` +
      `(${exposure} при броне ${pts0} → ${pts1}, смерть ${C.DEATH_COST_MIN} мин) — ${take ? 'беру' : 'не беру'}`
  }
}
function worn (slot) {
  const a = state.armor || {}
  if (a[slot]) return true
  const names = { torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/, head: /_helmet$/ }
  return have(names[slot]) > 0
}

export { earlyShield, spendIron, ARMOR_COST, ARMOR_SLOT, gearWorth, worn }
