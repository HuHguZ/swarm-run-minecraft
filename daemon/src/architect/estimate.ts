'use strict'
import * as gameClock from '../game-clock'
import { xyz } from '../movement'
import { countItems } from '../items'
import { AIR, FLUID, V, HORIZ, JOB, sleep, k3, propsOf, isDone } from './world'

// ---------------------------------------------------------------- job memory

function jobOf (session) {
  return session.journal.state[JOB] || null
}

function saveJob (session, job) {
  session.journal.patch(s => { s[JOB] = job })
}

// ---------------------------------------------------------------- estimate

function pickaxeIn (bot) {
  return bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
}

// Что нужно ещё поставить и выкопать — только по клеткам, которых в мире нет:
// повтор после обрыва считает остаток, а не всю постройку заново.
function tally (bot, cells) {
  const need = {}; const optional = {}
  let digs = 0; let hard = 0; let standing = 0; let work = 0; let unknown = 0
  const hazards = []
  for (const c of cells) {
    if (c.kind === 'part') continue
    const w = bot.blockAt(c.pos)
    if (!w) { unknown++; continue }
    if (FLUID.test(w.name) && c.kind !== 'air') { hazards.push(`${w.name} на ${c.pos.x},${c.pos.y},${c.pos.z}`) }
    if (c.kind === 'air' && !AIR.has(w.name)) {
      if (FLUID.test(w.name)) hazards.push(`${w.name} на ${c.pos.x},${c.pos.y},${c.pos.z}`)
      for (const dir of ['up', ...HORIZ, 'down']) {
        const n = bot.blockAt(c.pos.plus(V[dir]))
        if (n && /lava/.test(n.name)) { hazards.push(`лава за стенкой ${n.position.x},${n.position.y},${n.position.z}`); break }
      }
    }
    if (isDone(bot, c)) { standing++; continue }
    work++
    if (c.kind === 'air' || (!AIR.has(w.name) && !FLUID.test(w.name) && w.boundingBox === 'block')) {
      digs++
      if (w.material && /pickaxe/.test(w.material)) hard++
      if (c.kind === 'air') continue
    }
    const bag = c.optional ? optional : need
    bag[c.item] = (bag[c.item] || 0) + 1
  }
  // Одна строка на вид опасности: «water ×40 (первая 1,2,3)», а не сорок строк.
  const kinds = new Map()
  for (const h of new Set(hazards)) {
    const [what, where] = h.split(' на ')
    const k = kinds.get(what) || { n: 0, first: where }
    k.n++
    kinds.set(what, k)
  }
  const summary = [...kinds].map(([what, k]) => k.n > 1 ? `${what} ×${k.n} (первая ${k.first})` : `${what} на ${k.first}`)
  return { need, optional, digs, hard, standing, work, unknown, hazards: summary }
}

// Рецепт словами: чтобы отказ сметы сразу говорил, из чего сделать.
function craftHint (bot, mcData, name, count) {
  const item = mcData.itemsByName[name]
  if (!item) return null
  let recipes = []
  try { recipes = bot.recipesAll(item.id, null, true) } catch {}
  if (!recipes.length) return null
  const stock = countItems(bot)
  const score = r => (r.delta || []).filter(d => d.count < 0).every(d => (stock[mcData.items[d.id]?.name] || 0) > 0) ? 1 : 0
  const r = recipes.sort((a, b) => score(b) - score(a))[0]
  const per = r.result ? r.result.count : 1
  const times = Math.ceil(count / per)
  const ins = (r.delta || []).filter(d => d.count < 0).map(d => {
    const n = mcData.items[d.id] ? mcData.items[d.id].name : String(d.id)
    return `${n}×${-d.count * times} (есть ${stock[n] || 0})`
  })
  return `${name}×${count}: ${ins.join(' + ')} → mc_craft item=${name} count=${times * per}`
}

// Скаффолдинг: насколько высоко ставить из-за земли. Пол по колено — REACH
// ~4.5 от глаз, глаза на 1.62 над ногами, ноги на y0+1: выше y0+5 — леса.
function scaffoldNeed (cells, groundY) {
  let top = -Infinity
  for (const c of cells) if (c.kind !== 'air' && c.kind !== 'part') top = Math.max(top, c.pos.y)
  return Math.max(0, top - (groundY + 5))
}

function scaffoldItem (bot, planNeeds) {
  const stock = countItems(bot)
  const order = ['dirt', 'netherrack', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'coarse_dirt']
  const spare = n => (stock[n] || 0) - (planNeeds[n] || 0)
  const free = order.find(n => spare(n) >= 3)
  if (free) return free
  return order.find(n => (stock[n] || 0) >= 3) || Object.keys(stock).find(n => /_planks$/.test(n) && stock[n] >= 3) || null
}

// Что в сундуках рядом. Открывает, считает, закрывает. Нужен только если
// рюкзака не хватает — иначе это пустая прогулка.
async function peekChests (session, ctl, radius = 12, max = 6) {
  const bot = session.bot
  const c: typeof import('../containers') = require('../containers')
  const ids = ['chest', 'trapped_chest', 'barrel'].map(n => session.mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: max * 2 })
  const seen = []
  const done = new Set()
  for (const pos of found) {
    if (ctl.aborted || seen.length >= max) break
    if (done.has(k3(pos))) continue
    try {
      const { block, win } = await c.findAndOpen(session, ctl, pos, gameClock.now() + 20000)
      const shut = c.guardWindow(ctl, win)
      try {
        const contents = {}
        for (const it of win.containerItems()) contents[it.name] = (contents[it.name] || 0) + it.count
        seen.push({ at: xyz(block.position), contents })
        done.add(k3(block.position))
        // Двойной сундук открывается с любой половины — вторую не открываем.
        for (const dir of HORIZ) {
          const n = block.position.plus(V[dir])
          const nb = bot.blockAt(n)
          if (nb && nb.name === block.name && propsOf(block).type && propsOf(block).type !== 'single') done.add(k3(n))
        }
      } finally { shut(); await sleep(150) }
    } catch {}
  }
  return seen
}

async function takeFromChests (session, ctl, chests, want) {
  const c: typeof import('../containers') = require('../containers')
  const took = {}
  for (const ch of chests) {
    const names = Object.keys(want).filter(n => want[n] > 0 && ch.contents[n])
    if (!names.length) continue
    try {
      const { win } = await c.findAndOpen(session, ctl, ch.at, gameClock.now() + 20000)
      const shut = c.guardWindow(ctl, win)
      try {
        const caps = {}
        for (const n of names) caps[n] = want[n]
        const r = await c.withdrawPass(session.bot, session.mcData, win, names, { caps, ctl })
        for (const [n, v] of ((Object.entries(r.took) as [string, any][]) as any)) { took[n] = (took[n] || 0) + v; want[n] -= v }
      } finally { shut(); await sleep(150) }
    } catch {}
  }
  return took
}

// Смета: что нужно, что есть в рюкзаке, что в сундуках рядом, чего нет.
function shortfall (bot, mcData, need, stock, chests) {
  const inChests = {}
  for (const ch of chests || []) for (const [n, v] of (Object.entries(ch.contents) as [string, any][])) inChests[n] = (inChests[n] || 0) + v
  const short = []
  for (const [what, count] of ((Object.entries(need) as [string, any][]) as any)) {
    const have = stock[what] || 0
    const box = inChests[what] || 0
    if (have + box >= count) continue
    short.push({ what, count: count - have - box, have, inChests: box || undefined, craft: craftHint(bot, mcData, what, count - have - box) || undefined })
  }
  return { short, inChests }
}

function say (kindRu, L, material, need, short) {
  const total = (Object.values(need) as any[]).reduce((a: any, b) => a + b, 0)
  const top = (Object.entries(need) as [string, any][]).sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([n, v]) => `${n} ${v}`).join(', ')
  const miss = short.length ? ` Не хватает: ${short.slice(0, 3).map(s => `${s.what} ${s.count}`).join(', ')}.` : ' Всё есть.'
  return `${kindRu} ${L.size.w}×${L.size.d}${material ? ` из ${material}` : ''}: ${total} блоков (${top}).${miss}`.slice(0, 240)
}

// Постройка в память: место по имени, склад — со списком сундуков.
function remember (session, job, cells) {
  const o = job.origin
  session.journal.patch(s => {
    s.places = s.places || {}
    s.places[job.name] = { x: o.x, y: o.y + 1, z: o.z, note: `${job.kind} ${job.size ? `${job.size.w}×${job.size.d}` : ''} (${job.status})` }
    if (job.kind === 'storage') {
      const chests = cells.filter(c => c.role === 'chest').map(c => ({ ...xyz(c.pos), category: c.label }))
      s.storage = { name: job.name, at: o, chests, updated: new Date().toISOString() }
    }
  })
}

export {
  jobOf, saveJob, pickaxeIn, tally, scaffoldNeed, scaffoldItem, peekChests, takeFromChests, shortfall, say,
  remember
}
