'use strict'
// Арена (часть arena.ts): бойцы — выдача наборов с проверкой рюкзака, чары равной силы и их журнал, лечение, ожидание
// живого, люди на сервере. Чары выключает вход (демон без чар), людей в бою обновляет раунд — сеттерами в конце.
import * as enchMod from '../arena-ench'
import { A, B, cmd } from './rpc'
import { sleep, log, HUMANS, HUMAN, NA, NB } from './config'
import { bodySlot } from './kits'

async function equip (who, items, { onBody = false, offhand = null }: any = {} as Record<string, any>) {
  await cmd(`/clear ${who}`)
  await cmd(`/effect clear ${who}`)
  // Левая рука набора (кристаллы: тотем сразу в руке, 2026-09-30).
  if (offhand) await cmd(`/item replace entity ${who} weapon.offhand with minecraft:${offhand}`)
  if (onBody) {
    const rest = []
    for (const it of items) {
      const name = it.split(' ')[0]
      const slot = bodySlot(name)
      if (slot) await cmd(`/item replace entity ${who} ${slot} with ${name.includes(':') ? name : 'minecraft:' + name}`)
      else rest.push(it)
    }
    items = rest
  }
  // Броня — первой: рюкзак 36 слотов, и что не влезло, сервер роняет на пол
  // (арсенал 2026-09-25: броня выдавалась последней и валялась под ногами).
  items = [...items].sort((a, b) => (/_(helmet|chestplate|leggings|boots)\b/.test(b) ? 1 : 0) - (/_(helmet|chestplate|leggings|boots)\b/.test(a) ? 1 : 0))
  for (const it of items) {
    const [name, ...rest] = it.split(' ')
    const n = rest.length ? rest.join(' ') : '1'
    await cmd(`/give ${who} ${name.includes(':') || name.includes('[') ? name : 'minecraft:' + name} ${n}`)
  }
}

// Выдача проверяется по рюкзаку: в прогоне «полный кит» NeuroDown вышел с
// пустыми руками — /give пришёл, пока он ещё возрождался после прошлого раунда.
async function equipChecked (c, who, items, opts: any = {} as Record<string, any>) {
  // Рюкзак человека нам не виден — выдаём один раз.
  // Людям — ещё и обычная еда: без неё не отъесться между стычками.
  if (HUMANS.length && !who.startsWith('NeuroDown')) { for (const h of ACTIVE) { await equip(h, items, opts); await cmd(`/give ${h} minecraft:cooked_beef 32`) } return true }
  for (let attempt = 0; attempt < 3; attempt++) {
    await equip(who, items, opts)
    if (!items.length) return true
    await sleep(700)
    const st = await c.call('status').catch(() => null)
    const inv = (st && st.state && st.state.inventory) || {} as Record<string, any>
    const want = items[0].split(/[ [\]]/)[0].replace(/^minecraft:/, '')
    const worn = Object.values<any>((st && st.state && st.state.armor) || {} as Record<string, any>).filter(Boolean).map(x => String(x.name || x))
    if (Object.keys(inv).some(k => k.includes(want)) || worn.some(n => n.includes(want))) return true
    log(`${who}: набор не дошёл (нет ${want}), выдаю ещё раз`)
    await sleep(1500)
  }
  return false
}

// Чары (arena-ench.js, просьба 2026-09-26): каждому предмету набора — случайные
// чары из тех, что игра ему разрешает (таблица из jar 1.21.11), бойцам разные,
// но равной силы — чтобы случай не решал бой: оба набора добирают один бюджет
// (случайный на пару), суммы — в допуске. Во втором раунде пары бойцы
// меняются наборами: за пару каждый дрался обоими — для счёта побед и отбора.
// Закреплённое в наборе (quick_charge:3 арбалета, loyalty:3 трезубца — на них
// логика бота) не трогается, «Тягун» к «Верности» не встаёт.
//   ARENA_ENCH=0 — без чар; force — не спрашивать демонов (см. main);
//   ARENA_ENCH_BUDGET=40-70 — сила набора на пару (единица ≈ процент боя);
//   ARENA_ENCH_TOL=3 — допуск разницы сил пары;
//   ARENA_PAIR=0 — каждый раунд новая пара, без обмена; sides — меняться и в
//     наборах с разными предметами (a ≠ b): бойцы меняются сторонами целиком
//     (по умолчанию такие наборы тянутся заново каждый раунд — кто за какую
//     сторону, задумано в самом наборе);
//   ARENA_ENCH_SEED=строка — повторяемые розыгрыши.
const ENCH_ARG = process.env.ARENA_ENCH || '1'
let ENCH = ENCH_ARG !== '0'
const ENCH_BUDGET = (process.env.ARENA_ENCH_BUDGET || '40-70').split(/[-,]/).map(Number)
if (!(ENCH_BUDGET[1] >= ENCH_BUDGET[0])) ENCH_BUDGET[1] = ENCH_BUDGET[0]
const ENCH_TOL = Number(process.env.ARENA_ENCH_TOL || 3)
const PAIR = process.env.ARENA_PAIR || '1'
const enchRandom = enchMod.rng(process.env.ARENA_ENCH_SEED)
const enchPairs = new Map()
let pairNo = 0

// Что выдать сторонам в раунде n набора: первый раунд пары тянет два набора
// (X — первому бойцу, Y — второму), второй отдаёт те же, обменяв.
function kitSides (kit, n) {
  const a = kit.a
  const b = kit.b || kit.a
  // fixedEnch — чары набора закреплены целиком (кристаллы: модель урона бота).
  if (!ENCH || kit.fixedEnch || (!enchMod.enchantable(a) && !enchMod.enchantable(b))) return { a, b }
  const paired = PAIR !== '0' && (enchMod.sameItems(a, b) || PAIR === 'sides')
  const prev = enchPairs.get(kit.name)
  if (paired && prev && prev.round === n - 1 && !prev.swapped) {
    prev.swapped = true
    return { a: prev.d.b.strings, b: prev.d.a.strings, ench: { a: prev.d.b, b: prev.d.a, va: 'Y', vb: 'X', no: prev.no, swapped: true } }
  }
  // Набор со своими весами чар (ench: 'blast' — взрывы в цене, arena-ench.W_BLAST).
  const d = enchMod.drawPair(a, b, { budget: ENCH_BUDGET, tol: ENCH_TOL, random: enchRandom, weights: kit.ench === 'blast' ? enchMod.W_BLAST : undefined })
  const no = paired ? ++pairNo : null
  enchPairs.set(kit.name, { round: n, no, d, swapped: false })
  if (d.diff > ENCH_TOL) log(`чары: за ${d.tries} попыток разница сил ${d.diff} — больше допуска ${ENCH_TOL}, беру ближайшую`)
  return { a: d.a.strings, b: d.b.strings, ench: { a: d.a, b: d.b, va: 'X', vb: 'Y', no, swapped: false } }
}

// Строка на бойца: что выпало (только случайное — закреплённое в наборе и так
// известно), сила, дошло ли (status { enchants } против розыгрыша) и сколько
// шла выдача. Людям в руки не заглянуть — у них без «дошли».
async function enchLog (e, ms) {
  for (const [c, who, side, v, t, human] of [[A, NA, e.a, e.va, ms[0], false], [B, NB, e.b, e.vb, ms[1], !!HUMAN]]) {
    const bits = []
    if (e.no) bits.push(`пара ${e.no}·${v}${e.swapped ? ', обмен' : ''}`)
    bits.push(`сила ${side.power.toFixed(1)}`)
    if (!human) {
      const st = await c.call('status', { enchants: true }).catch(() => null)
      const got = st && st.detail && st.detail.enchants
      if (Array.isArray(got)) {
        const r = enchMod.verify(side, got)
        bits.push(r.missing.length ? `НЕ дошли ${r.missing.join(', ')} (${r.got}/${r.total})` : `дошли ${r.got}/${r.total}`)
      }
    }
    bits.push(`выдача ${(t / 1000).toFixed(1)} с`)
    log(`чары ${who} [${bits.join(', ')}]: ${enchMod.describe(side)}`)
  }
}

async function heal (who) {
  await cmd(`/effect give ${who} minecraft:instant_health 1 10 true`)
  await cmd(`/effect give ${who} minecraft:saturation 1 20 true`)
}

async function alive (c) {
  for (let i = 0; i < 20; i++) {
    const st = await c.call('status').catch(() => null)
    if (st && st.state && st.state.health > 0) return st
    await sleep(500)
  }
  return null
}

// Люди, которые сейчас на сервере: вышедший выбывает — ему не выдаём, не
// телепортируем и не ждём его в бою (2026-09-25 друг вышел посреди арены).
let ACTIVE = HUMANS
async function onlineHumans () {
  if (!HUMANS.length) return []
  const st = await A.call('status').catch(() => null)
  const on = st && st.state && st.state.playersOnline
  return Array.isArray(on) ? HUMANS.filter(h => on.includes(h)) : HUMANS
}

function setEnch (v) { ENCH = v }
function setActive (v) { ACTIVE = v }

export { equipChecked, ENCH_ARG, ENCH, ENCH_BUDGET, ENCH_TOL, PAIR, kitSides, enchLog, heal, alive, ACTIVE, onlineHumans, setEnch, setActive }
