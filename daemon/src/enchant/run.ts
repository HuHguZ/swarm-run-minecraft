'use strict'
// Зачарование: план (полки, лазурит, уровни, цели) и вход.
import { sleep, xyz } from '../movement'
import { countOf } from '../items'
import { shelfPower, levelOf, lapisOf, MAX_SHELVES, costRange, pointsBetween, WANT, KIND_RU, enchantsOf, kindOf, fmtEnch } from './facts'
import { chooseTargets } from './window'
import { findTable, setupTable, approachTable } from './table'
import { enchantOne } from './enchanting'
import { anvilRun } from './anvil'

// ------------------------------------------------------------ план

// Где взять опыт — одна строка, чтобы мозг знал, что делать при нехватке.
export const XP_WAYS = 'опыт: плавка (слиток железа 0.7, золота 1.0, еда 0.35 — забрать из печи), руда (алмаз, лазурит, редстоун, кварц, уголь), мобы 5, ифрит 10, дракон 12000'

export function plan (session, { goal = 'default' }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const lines = []
  const table = findTable(bot, mcData, 16)
  const power = table ? shelfPower(bot, table.position) : { counted: 0, raw: 0, blocked: 0 }
  const level = levelOf(bot)
  const lapis = lapisOf(bot)
  const shelvesBag = countOf(bot, 'bookshelf')
  const shelvesTotal = Math.min(MAX_SHELVES, power.counted + shelvesBag)
  const range = costRange(shelvesTotal)
  const targets = chooseTargets(bot, { goal, count: 4 })

  if (table) lines.push(`▸ стол на ${table.position.x},${table.position.y},${table.position.z}, полок видит ${power.counted}/15`)
  else if (countOf(bot, 'enchanting_table')) lines.push('▸ стол в рюкзаке — поставлю')
  else {
    const miss = []
    if (countOf(bot, 'obsidian') < 4) miss.push(`обсидиан ${countOf(bot, 'obsidian')}/4`)
    if (countOf(bot, 'diamond') < 2) miss.push(`алмазы ${countOf(bot, 'diamond')}/2`)
    if (!countOf(bot, 'book') && !(countOf(bot, 'leather') && (countOf(bot, 'paper') >= 3 || countOf(bot, 'sugar_cane') >= 3))) miss.push('книга (3 бумаги из тростника + кожа с коровы)')
    lines.push(miss.length ? `⚠ стола нет, не хватает: ${miss.join(', ')}` : '▸ стола нет, но всё на него есть — скрафчу')
  }
  if (shelvesTotal < MAX_SHELVES) {
    const need = MAX_SHELVES - shelvesTotal
    lines.push(`▸ полок ${shelvesTotal}/15: верхняя строка до ${range.top[1]} ур. На ещё ${need}: ${need * 3} книг = ${need * 3} кожи + ${need * 9} тростника, досок ${need * 6}`)
  }
  lines.push(`${lapis >= 3 ? '▸' : '⚠'} лазурит ${lapis} (строка 1/2/3 берёт 1/2/3; руда на y≈0, удача утраивает)`)
  const topCost = shelvesTotal >= MAX_SHELVES ? 30 : range.top[1]
  lines.push(`${level >= topCost ? '▸' : '⚠'} уровни ${level}; до ${topCost} — ещё ${pointsBetween(level, Math.max(level, topCost))} очков. ${XP_WAYS}`)
  for (const t of targets) {
    const want = (Object.entries(WANT[t.kind] || {}) as [string, any][]).sort((a: any, b: any) => b[1].w - a[1].w).slice(0, 3)
    lines.push(`▸ ${t.item.name}: ${want.map(([n, w]: any) => `${n} — ${w.why}`).join('; ')}`)
  }
  lines.push('▸ не трать уровни на: деревянное/каменное/золотое (заменишь), мусор вроде bane_of_arthropods/knockback/thorns — перебрось книгой за 1 ур.')
  return {
    table: table ? xyz(table.position) : null,
    shelves: power.counted,
    shelvesInBag: shelvesBag || undefined,
    level,
    lapis,
    topCost: range.top,
    targets: targets.map(t => ({ item: t.item.name, kind: KIND_RU[t.kind] })),
    lines
  }
}

// ------------------------------------------------------------ вход

// mode: plan — только план; setup — стол и полки; table (по умолчанию) —
// стол+зачарование; anvil — книга на вещь.
export async function run (session, ctl, p: any = {}) {
  const bot = session.bot
  const mode = p.mode || 'table'
  if (mode === 'plan') return plan(session, p)
  const lines = []
  ctl.onAbort.push(() => {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  })
  if (mode === 'anvil') {
    const r: any = await anvilRun(session, ctl, p, lines)
    if (lines.length) r.lines = lines
    return r
  }

  const { table, report } = await setupTable(session, ctl, { shelves: p.shelves ?? MAX_SHELVES, lines })
  if (mode === 'setup') return { ...report, level: levelOf(bot), lapis: lapisOf(bot), lines: lines.length ? lines : undefined }

  if (!lapisOf(bot)) throw new Error('нет лазурита — копай на y от -32 до 32, лучше около 0 (стол стоит, полок ' + report.shelves + ')')
  if (levelOf(bot) < 1) throw new Error(`нет уровней опыта. ${XP_WAYS}`)

  let targets
  if (p.item) {
    const look = () => bot.inventory.items().find(i => i.name === p.item && !enchantsOf(bot, i).length) ||
      [5, 6, 7, 8].map(s => bot.inventory.slots[s]).find(i => i && i.name === p.item && !enchantsOf(bot, i).length)
    let it = look()
    // Рюкзак мог разойтись с сервером после чужого окна (invsync) — сверить раз.
    if (!it) { try { (require('../invsync') as typeof import('../invsync')).resync(bot) } catch {} await sleep(700); it = look() }
    if (!it) throw new Error(`нет незачарованного ${p.item}`)
    if (!kindOf(it.name)) throw new Error(`${p.item} в стол не кладётся (щит, элитры, ножницы — только наковальней)`)
    targets = [{ item: it, kind: kindOf(it.name) }]
  } else {
    targets = chooseTargets(bot, { goal: p.goal || 'default', count: Math.max(1, Math.min(6, p.count || 1)) })
    if (!targets.length) throw new Error('нечего зачаровывать: нет незачарованного оружия/брони/инструмента не хуже камня')
  }

  await approachTable(bot, table)
  const results = []
  for (const t of targets) {
    if (ctl.aborted) break
    if (!lapisOf(bot) || levelOf(bot) < 1) break
    try {
      const r = await enchantOne(session, ctl, table, t, { rerolls: p.rerolls ?? 3, patient: p.now !== true, lines })
      results.push(r)
    } catch (e) {
      results.push({ item: t.item.name, error: e.message })
    }
  }
  for (const r of results) {
    if (r.got) lines.push(`▸ ${r.item}: ${fmtEnch(r.got)} за ${r.spentLevels} ур. (строка ${r.slot}, цена ${r.cost}) — ${r.why[0]}`)
    else if (r.skipped) lines.push(`⚠ ${r.item}: ${r.skipped}`)
    else if (r.error) lines.push(`⚠ ${r.item}: ${r.error}`)
  }
  const done = results.filter(r => r.got)
  const out: any = {
    ...report,
    enchanted: results,
    level: levelOf(bot),
    lapis: lapisOf(bot),
    lines
  }
  const skipped = results.find(r => r.need)
  if (skipped) out.need = skipped.need
  if (!done.length && results.length) out.stopped = results[0].skipped || results[0].error
  return out
}
