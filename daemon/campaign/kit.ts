'use strict'
// Снаряжение: еда, верстак и крафт, палки, запасные кирки, наполнители, переплавка, факелы.
import { OW_DEEP } from './flags'
import { call, sleep } from './rpc'
import { strategyInterrupted, state, sit, died, known, castSurfaceFailed, knownWater, stairEntrance } from './state'
import { log } from './log'
import { have, y, dim, LOGS, COBBLE, RAW, FOOD, PICK_IRON, planksFor, portalFar, fillersNow, nearBastion, woodNow,
  portalBuckets, lighter, shieldOn } from './queries'
import { sense, refresh } from './observe'
import { canWorkAtNight } from './stages/table'
import { act } from './act'
import * as gameClock from '../src/game-clock'
import { SWINGS_PER_LEVEL } from '../src/items'
async function eatTo (target = 18, interrupted = () => false) {
  // Each iteration must confirm a rising bar or a spent item; delayed slot ACKs are not extra bites.
  while (!died && !interrupted() && (state.food ?? 20) < target && (have(FOOD) || have(RAW))) {
    const before = state.food ?? 20
    const receipt = await act('eat')
    if ((state.food ?? 20) <= before && !(receipt?.detail?.spent > 0)) break
  }
  return (state.food ?? 20) >= target
}

const TABLE_ITEMS = /_(pickaxe|sword|axe|shovel|hoe|chestplate|leggings|helmet|boots)$|^(shield|bucket|furnace|flint_and_steel|bow|chest|_bed)$|_bed$/
async function ensureTable () {
  if (have('crafting_table')) return true
  if (died || strategyInterrupted) return false
  if ((state.health ?? 20) >= 12) {
    const recovered = await act('mine', { block: 'crafting_table', count: 1, radius: 3, fair: true, dry: true, timeoutSeconds: 15 })
    await refresh()
    if (recovered.status === 'interrupted' || died || strategyInterrupted) return false
    if (have('crafting_table')) return true
  }
  if (have(/_planks$/) < 4) { const p = planksFor(); if (p) await act('craft', { item: p, count: 4 }) }
  // ND_OW_TABLE_WOOD=1 (owC9-07: 3 слитка, огниво, 227 булыжника, 2 доски и ни бревна — 19 игр. мин набор и кирка «НЕ ГОТОВ» без
  // похода за деревом): верстаку не хватает досок — одно бревно (lumber сам решает, можно ли рубить: поверху, не ночью без защиты).
  if (typeof process !== 'undefined' && process.env.ND_OW_TABLE_WOOD === '1' && have(/_planks$/) < 4 && !have(LOGS) && dim() === 'overworld') {
    await lumber(1)
    if (died || strategyInterrupted) return false
    if (have(/_planks$/) < 4) { const p = planksFor(); if (p) await act('craft', { item: p, count: 4 }) }
  }
  if (have(/_planks$/) < 4) return false
  for (let k = 0; k < 3 && !have('crafting_table'); k++) {
    const r = await act('craft', { item: 'crafting_table', count: 1 })
    if (r.status === 'interrupted' || died || strategyInterrupted) return false
    if (r.status === 'done') break
    await sleep(1200)
    await refresh()
  }
  return have('crafting_table') > 0
}

async function craft (item, count = 1) {
  await unclutter()
  const handIgniter = item === 'flint_and_steel' && process.env.ND_OW_IRON_HAND_IGNITER !== '0'
  if (TABLE_ITEMS.test(item) && item !== 'crafting_table' && !handIgniter) { await refresh(); if (!(await ensureTable())) return false }
  let r = await act('craft', { item, count })
  if (r.status !== 'done' && /не прибавилось|не открылся|автопилот сейчас|нужен верстак|missing ingredient/.test(String(r.error || ''))) {
    await sleep(1500)
    r = await act('craft', { item, count })
  }
  if (r.status !== 'done' && /не смог поставить|некуда поставить/.test(String(r.error || ''))) {
    await act('surface', { timeoutSeconds: 60, preferPillar: true })
    await refresh()
    r = await act('craft', { item, count })
  }
  if (r.detail && r.detail.tableBack === false) {
    await refresh()
    const note = String(r.detail.note || '')
    const m = /crafting_table@(-?\d+),(-?\d+),(-?\d+)/.exec(note)
    if (!have('crafting_table') && m) await act('goto', { x: +m[1], y: +m[2], z: +m[3], range: 0, timeoutSeconds: 20, surface: false })
    await refresh()
    if (!have('crafting_table')) await act('mine', { block: 'crafting_table', count: 1, radius: 8, timeoutSeconds: 30 })
    await refresh()
    if (!have('crafting_table')) log(`верстак не вернул (${note.slice(0, 120)}) — новый сделаю из запаса`)
  }
  return r.status === 'done' && !(r.detail && r.detail.need)
}

async function sticks (n) {
  if (have('stick') >= n) return
  if (have(/_planks$/) < 2) { const p = planksFor(); if (p) await craft(p, 4) }
  if (have(/_planks$/) < 2) return
  await craft('stick', Math.max(4, n - have('stick')))
}

async function sticksReserve () {
  await refresh()
  const stickWant = 12
  if (have('stick') < stickWant) {
    if (have(/_planks$/) < 6 && !have(LOGS)) { await sense(); if (dim() === 'overworld' && sit.surface && !sit.night) await lumber(4) }
    await sticks(stickWant)
  }
  if (have(COBBLE) < 24 && known.portal && portalFar() < 48) await act('chest_take', { item: 'cobblestone', count: 32 })
}

async function spares (wantSwings = 200) {
  await refresh()
  await sense()
  if ((sit.pickLeft ?? 0) >= wantSwings) return
  if (have('stick') < 4 && (have(/_planks$/) >= 2 || have(LOGS))) await sticks(4)
  for (let i = 0; i < 3; i++) {
    await sense()
    if ((sit.pickLeft ?? 0) >= wantSwings) break
    if (have('stick') < 2) { if (have(/_planks$/) >= 2 || have(LOGS)) await sticks(4); else break }
    if (!have(PICK_IRON) && (have('iron_ingot') + have('raw_iron') > 0 || have('iron_nugget') >= 9) && have('stick') + 4 * Math.floor(have(/_planks$/) / 2) < 4 && !have(LOGS)) break
    if (have(COBBLE) >= 3) {
      if (!(await craft('stone_pickaxe'))) break
    } else if (have('iron_ingot') >= 3 && have('stick') >= 2) {
      if (!(await craft('iron_pickaxe'))) break
    } else {
      if (have(/_planks$/) < 3) { const p = planksFor(); if (p) await craft(p, 4) }
      if (have(/_planks$/) < 3 || !(await craft('wooden_pickaxe'))) break
    }
  }
}

// S1f: запас блоков в Аду (незерак под ногами — везде): без него не встаёт ни коробка отхода, ни столб обзора (s1f-B0b-1: мост и
// штрек разведки съели 127 булыжника за 3 мин, через 4 мин «на коробку блоков нет (0)» под шаром гаста — падение в лаву). Перед
// разведкой и ходом к спавнеру/бастиону — добрать до want, если меньше min. ND_NE_FILLERS=0 — выкл.
let fillersRetryAt = 0
async function netherFillers (min = 24, want = 48) {
  if (process.env.ND_NE_FILLERS === '0' || dim() !== 'the_nether' || died) return
  if (fillersNow() >= min || (state.pos && nearBastion(state.pos, 90)) || gameClock.now() < fillersRetryAt) return
  const before = fillersNow()
  const r = await act('mine', { block: 'netherrack', count: want - before, radius: 16, timeoutSeconds: 60 })
  await refresh()
  // Не добыл (незерака на виду нет: мост над лавой, крепость) — не повторять до следующих 2 игр. мин (s1f-C1-1: 6 пустых попыток подряд).
  if (fillersNow() <= before) fillersRetryAt = gameClock.now() + 120000
  log(`запас блоков в Аду: ${before} → ${fillersNow()}${r.error ? ' — ' + String(r.error).slice(0, 80) : ''}`)
}

async function lumber (want = 10) {
  await refresh()
  if (want <= 0) return
  if (have(LOGS) + Math.floor(have(/_planks$/) / 4) >= want) return
  for (let i = 0; i < 3 && have(LOGS) + Math.floor(have(/_planks$/) / 4) < want; i++) {
    await sense()
    // Под кроной небо закрыто листвой — «не на поверхности», а брёвна вот они (cl-h 14.10: спуск за железом с 2 брёвнами,
    // внизу «плавить нечем» и кирки кончились). Глубоко под землёй (y < 50) — не рубить.
    if ((!sit.surface && y() < 50) || (sit.night && !canWorkAtNight())) return
    const m = await act('mine', { block: 'any_log', count: want - have(LOGS), radius: 40, timeoutSeconds: 180 })
    if (!(m.detail && m.detail.dug)) {
      const e = await act('explore', { block: 'any_log', radius: 48, stepDistance: 60, timeoutSeconds: 90 })
      if (!(e.detail && e.detail.found)) return
    }
  }
}

async function unclutter () {
  await sense()
  if ((sit.free ?? 36) < 8) {
    const netherrack = dim() === 'the_nether' ? 128 : 64
    const extra = ['quartz:0', 'wildflowers:0', 'bone_meal:0']
    if (have(/^(iron|diamond|netherite)_sword$/) > 0) extra.push('stone_sword:0', 'wooden_sword:0', 'golden_sword:0')
    if (have(/^stone_pickaxe$/) >= 2 || have(/^(diamond|netherite)_pickaxe$/) > 0) extra.push('wooden_pickaxe:0')
    await act('pack', { mode: 'tidy', also: `cobblestone:128, cobbled_deepslate:128, netherrack:${netherrack}, raw_copper:0, copper_ingot:0, leaf_litter:0, magma_block:0, nether_brick_fence:0, nether_bricks:0, crafting_table:1, furnace:1, bowl:1, leather:0, lapis_lazuli:0, ${extra.join(', ')}` })
  }
}
async function reserve () {
  await sense()
  if ((!sit.surface && y() < 50) || sit.night || dim() !== 'overworld') return
  if (typeof process !== 'undefined' && process.env.ND_OW_FAST_KIT === '1' && !known.portal) {
    // O: запас дерева на набор — тот же woodFloor 4, что у этапа iron; спуск (descend → reserve) рубил до 10 (owC7-01: 8 брёвен, 2 игр. мин).
    if (woodNow() < 4) await lumber(4)
  } else if (woodNow() < (OW_DEEP ? 4 : 8)) await lumber(OW_DEEP ? 6 : 10)
  await refresh()
  if (!have('crafting_table')) await ensureTable()
}

async function ensurePick () {
  await refresh()
  if (have(/_pickaxe$/)) return true
  if (have(/_planks$/) < 9 && have(LOGS)) { const p = planksFor(); if (p) await craft(p, Math.min(16, have(LOGS) * 4)) }
  await refresh()
  if (!have('crafting_table') && have(/_planks$/) >= 4) await craft('crafting_table')
  if (have('crafting_table')) {
    await sticks(2)
    if (have('stick') < 2) return false
    if (have(COBBLE) >= 3 && await craft('stone_pickaxe')) return true
    if (have(/_planks$/) >= 3 && await craft('wooden_pickaxe')) return true
  }
  await refresh()
  return have(/_pickaxe$/) > 0
}

async function bucketOnTheWay (t) {
  if (!have(/bucket$/) && have(/^(raw_iron|iron_ingot)$/) >= 3) {
    await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
    if (have('iron_ingot') >= 3 && !have(/bucket$/)) await craft('bucket')
  }
  if (!have('bucket') || have('water_bucket')) return
  const why = String((t && t.detail && t.detail.stopped) || '')
  const wet = /вода (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(why)
  const r = await act('bucket', { fluid: 'water', radius: 24 })
  if (have('water_bucket')) { log('вода по пути: ведро полное'); return }
  const q = wet ? { x: +wet[1], y: +wet[2], z: +wet[3] } : (knownWater && state.pos && Math.hypot(knownWater.x - state.pos.x, knownWater.y - state.pos.y, knownWater.z - state.pos.z) <= 8 ? knownWater : null)
  if (q && !(r.detail && r.detail.need)) {
    await act('portal', { mode: 'cast', waterHint: q, timeoutSeconds: 90 })
    if (have('water_bucket')) log(`вода по пути: окно у ${q.x},${q.y},${q.z} — ведро полное`)
  }
}

async function mineSeenAll (block, maxDist = 24, remaining = null) {
  const names = block.split(',').map(s => s.trim())
  const boundedIron = remaining && process.env.ND_OW_IRON_MEMORY !== '0'
  const cleared = new Set<string>()
  for (let i = 0; i < 3; i++) {
    const before = boundedIron ? remaining() : Infinity
    const count = boundedIron ? Math.min(8, before) : 8
    if (count <= 0) return
    let spots = []
    try {
      const r: any = await call('mine_seen', { limit: 40 })
      spots = (r.detail && r.detail.spots) || []
    } catch { return }
    // S8c (вслепую железо только копкой): виденная руда до 8 по высоте и 24 бл. (было 4 и 16 — жила в стене пещеры рядом
    // оставалась). ND_IRON_WIDE=0 — прежнее.
    const wide = process.env.ND_IRON_WIDE !== '0'
    const levelOk = p => !OW_DEEP || (Math.abs(((p.at && p.at.y) ?? y()) - y()) <= (wide ? 8 : 4) && (p.fromMe ?? 99) <= (wide ? 24 : 16))
    const s = spots.find(p => !cleared.has(JSON.stringify(p.at)) && names.includes(p.name) && (p.fromMe ?? 99) <= maxDist &&
      (boundedIron || (levelOk(p) && (p.why !== 'в прямой видимости' || (p.fromMe ?? 99) <= 5))))
    if (!s) return
    const r = await act('mine_seen', { at: s.at, ...(boundedIron ? { count } : {}), timeoutSeconds: 120 })
    if (r.status !== 'done' || died) return
    if (boundedIron && remaining() >= before) {
      // Блок честно проверен и вычеркнут: причина изменилась, следующая жила ещё не пробовалась.
      if (process.env.ND_IRON_STALE_LEDGER === '1' && r.detail?.gone?.length) cleared.add(JSON.stringify(s.at))
      else return
    }
  }
}

const ironToSmelt = () => {
  if (!((OW_DEEP || process.env.ND_OW_FAST_KIT === '1' && dim() === 'overworld') && !known.portal)) return Infinity
  const noShield = process.env.ND_OW_FAST_KIT !== '1' && !have('shield') && !(state.offHand && /shield/.test(JSON.stringify(state.offHand)))
  const wantB = portalBuckets()
  const need = 3 * Math.max(0, wantB - have(/bucket$/)) + (lighter() ? 0 : 1) + (noShield ? 1 : 0) + (castSurfaceFailed && !have(PICK_IRON) ? 3 : 0)
  return Math.max(0, need - have('iron_ingot'))
}
async function smeltAll (from, into, { fetchCoal = false, max = Infinity } = {}) {
  await refresh()
  if (!have(from) || max <= 0) return
  const target = have(into) + Math.min(have(from), max)
  const left = () => Math.min(have(from), Math.max(0, target - have(into)))
  await unclutter()
  if (!have('furnace')) await ensureTable()
  if (fetchCoal && have(/^(coal|charcoal)$/) * 8 < left()) {
    await mineSeenAll('coal_ore,deepslate_coal_ore', 24)
    if (have(/^(coal|charcoal)$/) * 8 < left()) await act('mine', { block: 'coal_ore,deepslate_coal_ore', count: 3, radius: 16, timeoutSeconds: 60 })
  }
  const inv = () => Object.keys(state.inventory || {})
  const cooking = RAW.test(from)
  const fireLogs = inv().filter(k => LOGS.test(k) && !/crimson|warped/.test(k)).reduce((n, k) => n + have(k), 0)
  if (!have(/^(coal|charcoal)$/) && !have('lava_bucket') && left() >= 4 && fireLogs >= 5) {
    const want = Math.min(Math.ceil(left() / 8), fireLogs - 4)
    if (want > 0) {
      if (have(/_planks$/) * 1.5 < want) { const p = planksFor(); if (p) await craft(p, 4) }
      const plank = inv().find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k))
      if (plank) await act('smelt', { item: 'charcoal', count: want, fuel: plank, timeoutSeconds: 120 })
    }
    await refresh()
  }
  for (let i = 0; i < 3 && left() > 0; i++) {
    await unclutter()
    const coal = have(/^(coal|charcoal)$/) > 0
    const logK = inv().find(k => LOGS.test(k) && (!cooking || !/crimson|warped/.test(k)) && have(k) > 0)
    let plankK = inv().find(k => /_planks$/.test(k) && (!cooking || !/^(crimson|warped)_/.test(k)) && have(k) > 0)
    // Еда нужна телу сейчас. Печь/верстак уже проверяются перед топливом;
    // четыре будущих бревна не должны запрещать готовку имеющегося мяса.
    // Бревно превращается в четыре доски: в печи это вчетверо больше топлива.
    if (cooking && !coal && !have('lava_bucket') && logK && (plankK ? have(plankK) : 0) * 1.5 < left()) {
      await craft(logK.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks'), 4)
      plankK = inv().find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k) && have(k) > 0)
    }
    // Сырое железо/золото — узкое место маршрута (ведро, огниво, кирка): запас дерева на будущее — одно бревно или две доски,
    // остальное в печь. Прежний резерв 4 бревна / 8 досок без ND_OW_DEEP запрещал плавку вовсе (cl-b 14.10: 6 сырого железа,
    // «плавить нечем», подъём за деревом под озеро и 5-минутная пауза этапа).
    const metal = /^raw_(iron|gold)$/.test(from)
    const keepLogs = cooking ? 0 : metal ? 1 : 4
    const keepPlanks = cooking ? 0 : metal ? 2 : 8
    // Бревно в доски перед печью: доска горит 1.5 предмета, бревно — тоже 1.5, а досок из него четыре.
    if (metal && !coal && have(LOGS) >= 1 && (have(/_planks$/) - keepPlanks) * 1.5 < left()) {
      const p = planksFor(); if (p) { await craft(p, 4); plankK = inv().find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k) && have(k) > 0) }
    }
    const stickK = metal && have('stick') > 4 ? 'stick' : null
    const wood = have('lava_bucket') ? 'lava_bucket'
      : cooking && plankK ? plankK
      : metal && plankK && have(/_planks$/) > keepPlanks ? plankK
      : (logK && have(LOGS) > keepLogs) ? logK
        : (plankK && have(/_planks$/) > keepPlanks) ? plankK
          : stickK
    if (!coal && !wood) { log(`плавить ${from} нечем: угля нет, а дерево — запас на глубину`); break }
    const r = await act('smelt', { item: into, count: left(), fuel: coal ? undefined : wood, timeoutSeconds: 400 })
    await refresh()
    if (metal && /печки нет/.test(String(r.error || '')) && process.env.ND_OW_IRON_FURNACE !== '0' && dim() === 'overworld') {
      if (died || strategyInterrupted || r.status === 'interrupted') break
      if (have(COBBLE) < 8) {
        const stone = await act('mine', { block: 'stone', count: 8 - have(COBBLE), radius: 32, dry: true, timeoutSeconds: 120 })
        if (died || strategyInterrupted || stone.status === 'interrupted') break
        if (have(COBBLE) < 8) await act('dig_down', { mode: 'stairs', depth: 6, torchEvery: 0, timeoutSeconds: 120 })
      }
      if (died || strategyInterrupted || have(COBBLE) < 8) break
    }
    if (r.status !== 'done' && !coal && !wood) break
  }
}

async function lightUp () {
  await refresh()
  if (have('torch') >= 8 || have(/^(coal|charcoal)$/) >= 2) return torches()
  if (have(LOGS) < 4) return
  await unclutter()
  if (!have('furnace')) await ensureTable()
  if (have(/_planks$/) < 2) { const p = planksFor(); if (p) await craft(p, 4) }
  const plank = Object.keys(state.inventory || {}).find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k))
  if (plank) await act('smelt', { item: 'charcoal', count: 2, fuel: plank, timeoutSeconds: 90 })
  await torches()
}

async function torches () {
  await refresh()
  const materials = process.env.ND_OW_TORCH_MATERIALS === '1' && dim() === 'overworld'
  const fuel = have(/^(coal|charcoal)$/)
  if (have('torch') >= 16 || fuel < (materials ? 1 : 2)) return
  await sticks(materials ? Math.min(2, fuel) : 2)
  const count = materials ? 4 * Math.min(2, have('stick'), have(/^(coal|charcoal)$/)) : 8
  if (count) await craft('torch', count)
}

export { eatTo, ensureTable, craft, sticks, sticksReserve, spares, netherFillers, lumber, unclutter, reserve,
  ensurePick, bucketOnTheWay, mineSeenAll, ironToSmelt, smeltAll, lightUp, torches }
