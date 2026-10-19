'use strict'
import * as gameClock from './game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { xyz } from './movement'
import { countItems } from './items'

// Склад по категориям: что куда класть, какие сундуки чьи, таблички на них.
// Сундуки открывает containers.js (там оплачены все болезни окон 1.21.11),
// ставит таблички architect.js (там постановка с направлением и присед).

const CATS = [
  { key: 'ores', lines: ['Руда', 'и слитки'], ru: 'руда и слитки', words: /руд|слит|ore|ingot/i },
  { key: 'blocks', lines: ['Блоки'], ru: 'блоки', words: /блок|block/i },
  { key: 'food', lines: ['Еда'], ru: 'еда', words: /(^|\s)ед[аы]|food|жрат/i },
  { key: 'gear', lines: ['Инструменты', 'оружие, броня'], ru: 'инструменты, оружие, броня', words: /инстр|оруж|брон|tool|weapon|armou?r/i },
  { key: 'mob', lines: ['Мобьё'], ru: 'добыча с мобов', words: /моб|mob|drop/i },
  { key: 'rare', lines: ['Редкое'], ru: 'редкое', words: /редк|ценн|rare/i },
  { key: 'misc', lines: ['Разное'], ru: 'разное', words: /разн|проч|misc|other/i }
]
const BY_KEY = Object.fromEntries(CATS.map(c => [c.key, c]))

// Порядок проверки важен: золотое яблоко — еда, но место ему в «редком»;
// гнилая плоть и паучий глаз — еда по minecraft-data, а по смыслу — мобьё.
const RARE = /^(enchanted_book|golden_apple|enchanted_golden_apple|totem_of_undying|nether_star|heart_of_the_sea|name_tag|saddle|elytra|dragon_egg|dragon_breath|experience_bottle|echo_shard|recovery_compass|music_disc_\w+|disc_fragment_5|\w+_smithing_template|\w+_pottery_sherd|goat_horn|sniffer_egg|trial_key|ominous_trial_key|heavy_core|beacon|conduit|end_crystal|ender_eye|nautilus_shell|shulker_shell|wither_skeleton_skull|\w+_banner_pattern|netherite_upgrade_smithing_template)$/
const GEAR = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots|horse_armor)$|^(bow|crossbow|shield|trident|mace|fishing_rod|shears|flint_and_steel|arrow|spectral_arrow|tipped_arrow|compass|clock|spyglass|brush|lead|bucket|water_bucket|lava_bucket|carrot_on_a_stick|warped_fungus_on_a_stick|turtle_helmet|wolf_armor)$/
const MOB = /^(rotten_flesh|bone|bone_meal|string|spider_eye|fermented_spider_eye|gunpowder|ender_pearl|slime_ball|blaze_rod|blaze_powder|ghast_tear|phantom_membrane|leather|feather|ink_sac|glow_ink_sac|rabbit_hide|rabbit_foot|magma_cream|prismarine_shard|prismarine_crystals|egg|honeycomb|scute|armadillo_scute|turtle_scute|breeze_rod|wind_charge)$/
const ORES = /_ore$|^raw_(iron|gold|copper)(_block)?$|_ingot$|_nugget$|^(coal|charcoal|diamond|emerald|lapis_lazuli|redstone|quartz|amethyst_shard|netherite_scrap|ancient_debris|glowstone_dust)$|^(coal|iron|gold|diamond|emerald|lapis|redstone|copper|netherite|amethyst|quartz)_block$/

function categoryOf (name, mcData) {
  if (RARE.test(name)) return 'rare'
  if (GEAR.test(name)) return 'gear'
  if (MOB.test(name)) return 'mob'
  if (mcData && mcData.foodsByName && mcData.foodsByName[name]) return 'food'
  if (/^(cake|pumpkin_pie|cookie|suspicious_stew|rabbit_stew|mushroom_stew|beetroot_soup)$/.test(name)) return 'food'
  if (ORES.test(name)) return 'ores'
  if (mcData && mcData.blocksByName[name]) return 'blocks'
  return 'misc'
}

// Категория по тексту таблички или по слову мозга («руда», «food», «ores»).
function categoryFromText (text) {
  const t = String(text || '').toLowerCase()
  if (!t.trim()) return null
  if (BY_KEY[t.trim()]) return t.trim()
  for (const c of CATS) if (c.words.test(t)) return c.key
  return null
}

// Таблички для склада: названные мозгом категории, иначе — те, что правда есть
// в рюкзаке (без снаряжения), плюс «Разное», и не меньше четырёх.
function labelsFor (session, categories, stock) {
  let keys = []
  if (Array.isArray(categories) && categories.length) {
    for (const c of categories) {
      const k = categoryFromText(c)
      if (!k) throw new Error(`не понял категорию «${c}»: ${CATS.map(x => `${x.key} (${x.ru})`).join(', ')}`)
      if (!keys.includes(k)) keys.push(k)
    }
  } else {
    const present = new Set()
    for (const n of Object.keys(stock || {})) {
      if (/^(chest|trapped_chest|barrel)$|_sign$|_planks$|_log$/.test(n)) continue
      present.add(categoryOf(n, session.mcData))
    }
    keys = CATS.map(c => c.key).filter(k => present.has(k) && k !== 'misc')
    for (const k of ['ores', 'blocks', 'food']) if (keys.length < 3 && !keys.includes(k)) keys.push(k)
    keys.push('misc')
  }
  return keys.map(k => ({ key: k, lines: BY_KEY[k].lines }))
}

// ---------------------------------------------------------------- chests

const CHEST = /^(chest|trapped_chest|barrel)$/
const HORIZ = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) }

function propsOf (b) { try { return b.getProperties() || {} } catch { return {} } }

// Вторая половина двойного сундука: сосед с тем же facing и парным type.
function partnerOf (bot, block) {
  const p = propsOf(block)
  if (!p.type || p.type === 'single') return null
  for (const v of (Object.values(HORIZ) as any[])) {
    const n = bot.blockAt(block.position.plus(v))
    if (n && n.name === block.name) {
      const q = propsOf(n)
      if (q.facing === p.facing && q.type && q.type !== 'single' && q.type !== p.type) return n
    }
  }
  return null
}

// Табличка «при сундуке»: над ним, на его передней грани, или над парной
// половиной. Текст читается из блок-сущности, которую сервер присылает.
function signFor (bot, block) {
  const architect: typeof import('./architect') = require('./architect')
  const spots = [block.position.offset(0, 1, 0)]
  const f = propsOf(block).facing
  if (f && HORIZ[f]) spots.push(block.position.plus(HORIZ[f]))
  const partner = partnerOf(bot, block)
  if (partner) spots.push(partner.position.offset(0, 1, 0))
  for (const s of spots) {
    const b = bot.blockAt(s)
    if (!b || !/_sign$/.test(b.name)) continue
    const t = architect.signText(bot, s)
    const text = t ? [...t.front, ...t.back].join(' ') : ''
    return { at: s, text, category: categoryFromText(text) }
  }
  return null
}

function findStorage (session, { radius = 12, at = null }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const rec = session.journal.state.storage
  const me = bot.entity.position
  const out = []
  const taken = new Set()
  const k = p => `${p.x},${p.y},${p.z}`
  const add = (block, category, source) => {
    if (taken.has(k(block.position))) return
    taken.add(k(block.position))
    const partner = partnerOf(bot, block)
    if (partner) taken.add(k(partner.position))
    const sign = signFor(bot, block)
    out.push({ block, pos: block.position, category: (sign && sign.category) || category || null, sign, source, double: !!partner })
  }
  // Склад, построенный mc_build kind=storage, — по памяти: там записано, какой сундук чей.
  if (rec && rec.chests && rec.chests.length && new Vec3(rec.at.x, rec.at.y, rec.at.z).distanceTo(me) < 48) {
    for (const c of rec.chests) {
      const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
      if (b && CHEST.test(b.name)) add(b, c.category, 'память склада')
    }
  }
  const centre = at ? new Vec3(at.x, at.y, at.z) : me
  const ids = ['chest', 'trapped_chest', 'barrel'].map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 32, point: centre })
  for (const p of found.sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y)) {
    const b = bot.blockAt(p)
    if (b) add(b, null, 'рядом')
  }
  return out
}

// ---------------------------------------------------------------- sort

async function walkNear (bot, pos, ms = 12000) {
  const { withTimeout }: typeof import('./build') = require('./build')
  if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) < 3.6) return true
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)), ms, 'не дошёл')
    return true
  } catch {
    try { bot.pathfinder.setGoal(null) } catch {}
    return false
  }
}

// Табличка на сундук без таблички: над ним, если там воздух и за ним стена
// (как в складе mc_build), иначе на переднюю грань присев, иначе стоячая
// сверху. Все три держатся по isSolid() — сундук годится (у табличек
// WallSignBlock/StandingSignBlock.canSurvive смотрят isSolid, не крепость грани).
async function labelChest (session, ctl, ch, category) {
  const bot = session.bot
  const architect: typeof import('./architect') = require('./architect')
  const sign = bot.inventory.items().find(i => /_sign$/.test(i.name) && !/hanging/.test(i.name))
  if (!sign) return { ok: false, why: 'табличек нет' }
  const wall = sign.name.replace(/_sign$/, '_wall_sign')
  const f = propsOf(ch.block).facing || 'south'
  const back = { north: 'south', south: 'north', east: 'west', west: 'east' }[f]
  const up = ch.pos.offset(0, 1, 0)
  const air = p => { const b = bot.blockAt(p); return b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
  const solid = p => { const b = bot.blockAt(p); return b && b.boundingBox === 'block' }
  const cands = []
  if (air(up) && solid(up.plus(HORIZ[back]))) cands.push({ pos: up, name: wall, item: sign.name, kind: 'wall', props: { facing: f }, support: back })
  const front = ch.pos.plus(HORIZ[f])
  if (air(front)) cands.push({ pos: front, name: wall, item: sign.name, kind: 'wall', props: { facing: f }, support: back })
  if (air(up)) cands.push({ pos: up, name: sign.name, item: sign.name, kind: 'floor', support: 'down', faces: f })
  const lines = BY_KEY[category].lines
  for (const c of cands) {
    if (ctl.aborted) break
    await walkNear(bot, c.pos)
    const open = architect.onceSignEditor(bot, 2500)
    const r = await architect.putCell(bot, { ...c, key: `${c.pos.x},${c.pos.y},${c.pos.z}`, text: lines })
    if (!r.ok) { open.cancel(); continue }
    const w = await architect.writeSign(bot, c.pos, lines, { opened: open })
    return { ok: w.ok, at: xyz(c.pos), why: w.ok ? undefined : w.why }
  }
  return { ok: false, why: 'некуда повесить: над сундуком и перед ним занято' }
}

async function sort (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const containers: typeof import('./containers') = require('./containers')
  const deadline = gameClock.now() + Math.min(600, p.timeoutSeconds ?? 180) * 1000
  const chests = findStorage(session, { radius: Math.max(4, Math.min(24, p.radius ?? 12)), at: p.at || null })
  if (!chests.length) {
    return { sorted: false, stopped: 'сундуков рядом нет — сначала mc_build kind=storage (склад с табличками) или поставь сундуки' }
  }

  // Категории сундукам без таблички и без записи — по порядку, свободные.
  const used = new Set(chests.map(c => c.category).filter(Boolean))
  const wanted = CATS.map(c => c.key)
  for (const ch of chests) {
    if (ch.category) continue
    const k = wanted.find(x => !used.has(x))
    ch.category = k || 'misc'
    ch.assigned = true
    used.add(ch.category)
  }
  const byCat: any = {}
  for (const ch of chests) (byCat[ch.category] = byCat[ch.category] || []).push(ch)
  const home = cat => byCat[cat] ? cat : byCat.misc ? 'misc' : null

  // Что из рюкзака отдаём: всё сверх снаряжения и запасов (containers KEEP),
  // или всё подряд с everything=true. Взятое из чужого сундука — целиком.
  const plan: { plan: Record<string, number>; kept?: Record<string, number> } = p.everything ? { plan: countItems(bot) } : containers.surplusPlan(bot)
  // Сколько каждого ещё можно отдать: лишнее сверх запаса плюс взятое из чужих
  // сундуков. Уменьшается с каждым положенным — иначе второй круг снова отдаёт
  // «лишние» четыре палки из тех восьми, что положено держать при себе.
  const budget = { ...plan.plan }
  const carried = {}
  const giveable = () => {
    const bag = countItems(bot)
    const out = {}
    for (const [n, have] of (Object.entries(bag) as [string, any][])) {
      const can = Math.min(have, budget[n] || 0)
      if (can > 0) out[n] = can
    }
    return out
  }

  const report = chests.map(ch => ({ at: xyz(ch.pos), category: ch.category, label: BY_KEY[ch.category].ru, put: {}, took: {}, sign: ch.sign ? 'была' : undefined, source: ch.source }))
  const misplaced = {}
  const noHome = {}
  let moves = 0
  let passes = 0

  for (let pass = 0; pass < 3 && !ctl.aborted && gameClock.now() < deadline; pass++) {
    passes++
    let movedThisPass: any = 0
    let misplacedSeen = 0
    for (let i = 0; i < chests.length && !ctl.aborted && gameClock.now() < deadline; i++) {
      const ch = chests[i]
      const rep: any = report[i]
      let win = null; let shut = null
      try {
        const opened = await containers.findAndOpen(session, ctl, ch.pos, gameClock.now() + 25000)
        win = opened.win
        shut = containers.guardWindow(ctl, win)
      } catch (e) { rep.error = e.message; continue }
      try {
        // Положить своё.
        const give = giveable()
        const mine = Object.keys(give).filter(n => home(categoryOf(n, mcData)) === ch.category)
        if (mine.length) {
          const caps = {}
          for (const n of mine) caps[n] = give[n]
          const d = await containers.depositPass(bot, mcData, win, mine, { caps, ctl })
          for (const [n, v] of ((Object.entries(d.put) as [string, any][]) as any)) {
            rep.put[n] = (rep.put[n] || 0) + v
            movedThisPass += v
            budget[n] = Math.max(0, (budget[n] || 0) - v)
            if (carried[n]) carried[n] = Math.max(0, carried[n] - v)
          }
        }
        // Забрать чужое — если ему есть куда лечь.
        const inside = {}
        for (const it of win.containerItems()) inside[it.name] = (inside[it.name] || 0) + it.count
        const foreign = Object.keys(inside).filter(n => {
          const h = home(categoryOf(n, mcData))
          return h && h !== ch.category
        })
        misplacedSeen += foreign.length
        if (foreign.length) {
          const caps = {}
          for (const n of foreign) caps[n] = inside[n]
          const w = await containers.withdrawPass(bot, mcData, win, foreign, { caps, ctl })
          for (const [n, v] of (Object.entries(w.took) as [string, any][])) {
            rep.took[n] = (rep.took[n] || 0) + v
            carried[n] = (carried[n] || 0) + v
            budget[n] = (budget[n] || 0) + v
            movedThisPass += v
          }
        }
        rep.slots = win.containerItems().length
        rep.of = win.inventoryStart
      } finally {
        shut()
        await sleep(150)
      }
    }
    moves += movedThisPass
    const leftover = (Object.entries(giveable()) as [string, any][]).filter(([n]) => home(categoryOf(n, mcData)))
    if (!movedThisPass || (!misplacedSeen && !leftover.length)) break
  }

  // Что осталось не на месте: при себе взятое из чужих сундуков и без дома.
  for (const [n, v] of (Object.entries(giveable()) as [string, any][])) {
    const h = home(categoryOf(n, mcData))
    if (!h) noHome[n] = v
    else if (carried[n]) misplaced[n] = carried[n]
  }

  // Таблички: на сундуки без таблички.
  let signed = 0
  const signFails = []
  if (p.label !== false) {
    for (let i = 0; i < chests.length && !ctl.aborted && gameClock.now() < deadline; i++) {
      const ch = chests[i]
      if (ch.sign) continue
      const r = await labelChest(session, ctl, ch, ch.category)
      if (r.ok) { signed++; report[i].sign = `повесил на ${r.at.x},${r.at.y},${r.at.z}` } else signFails.push(`${report[i].at.x},${report[i].at.y},${report[i].at.z}: ${r.why}`)
    }
  }

  // Память: какой сундук чей — чтобы следующий раз не гадать по табличкам.
  session.journal.patch(s => {
    const prev = s.storage || {}
    s.storage = {
      name: prev.name || 'склад',
      at: prev.at || xyz(chests[0].pos),
      chests: chests.map(ch => ({ ...xyz(ch.pos), category: ch.category })),
      updated: new Date().toISOString()
    }
  })

  const cats = [...new Set(chests.map(c => c.category))]
  return {
    sorted: true,
    chests: report.map(r => ({ ...r, put: Object.keys(r.put).length ? r.put : undefined, took: Object.keys(r.took).length ? r.took : undefined })),
    categories: cats.map(k => BY_KEY[k].ru),
    moved: moves,
    passes,
    signed: signed || undefined,
    signFails: signFails.length ? signFails : undefined,
    misplaced: Object.keys(misplaced).length ? misplaced : undefined,
    noHome: Object.keys(noHome).length ? noHome : undefined,
    kept: Object.keys(plan.kept || {}).length ? plan.kept : undefined,
    note: Object.keys(noHome).length
      ? `Не нашлось сундука для: ${Object.keys(noHome).slice(0, 5).join(', ')} — нет ни своей категории, ни «Разного». Добавь сундук (mc_build kind=storage categories=…).`
      : Object.keys(misplaced).length
        ? 'Часть чужого осталась при мне: полный сундук своей категории. Нужен ещё сундук под неё.'
        : `Разложено по ${cats.length} категориям. Снаряжение и запасы (кирки, броня, еда, факелы) оставил при себе${p.everything ? ' — нет, с everything=true отдал всё' : ''}.`
  }
}

const sleep = ms => new Promise<any>(resolve => gameClock.setTimeout(resolve, ms))

// ---------------------------------------------------------------- sign

// Написать на табличке: существующую переписать, иначе повесить новую.
async function sign (session, ctl, p: any = {}) {
  const bot = session.bot
  const architect: typeof import('./architect') = require('./architect')
  if (p.x === undefined || p.y === undefined || p.z === undefined) throw new Error('где: нужны x, y, z')
  const lines = Array.isArray(p.text) ? p.text : String(p.text || '').split(/\n|\|/)
  if (!lines.join('').trim()) throw new Error('что писать: text пуст (строки через | или \\n, до 4 по 15 знаков)')
  const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  const b = bot.blockAt(pos)
  if (!b) throw new Error('это место не прогружено')
  const cut = lines.map(s => String(s).trim()).slice(0, 4)
  const long = cut.filter(s => s.length > 15)
  if (/_sign$/.test(b.name)) {
    await walkNear(bot, pos)
    const w = await architect.writeSign(bot, pos, cut)
    return { at: xyz(pos), placed: false, rewrote: w.ok, text: architect.signText(bot, pos), why: w.why, cut: long.length ? long : undefined }
  }
  const item = bot.inventory.items().find(i => /_sign$/.test(i.name) && !/hanging/.test(i.name))
  if (!item) return { at: xyz(pos), placed: false, need: { what: 'oak_sign', count: 1, have: 0 }, stopped: 'табличек нет: 6 досок + палка → 3 таблички (mc_craft item=oak_sign)' }
  const me = bot.entity.position
  const toward = Math.abs(me.x - (pos.x + 0.5)) > Math.abs(me.z - (pos.z + 0.5))
    ? (me.x > pos.x + 0.5 ? 'east' : 'west')
    : (me.z > pos.z + 0.5 ? 'south' : 'north')
  let cell
  if (b.boundingBox === 'block') {
    // Твёрдый блок — повесить на его грань, по умолчанию на ту, что ко мне.
    const f = p.facing || toward
    cell = { pos: pos.plus(HORIZ[f]), name: item.name.replace(/_sign$/, '_wall_sign'), item: item.name, kind: 'wall', props: { facing: f }, support: { north: 'south', south: 'north', east: 'west', west: 'east' }[f] }
  } else if (p.facing) {
    cell = { pos, name: item.name.replace(/_sign$/, '_wall_sign'), item: item.name, kind: 'wall', props: { facing: p.facing }, support: { north: 'south', south: 'north', east: 'west', west: 'east' }[p.facing] }
  } else {
    cell = { pos, name: item.name, item: item.name, kind: 'floor', support: 'down', faces: toward }
  }
  cell.key = `${cell.pos.x},${cell.pos.y},${cell.pos.z}`
  const there = bot.blockAt(cell.pos)
  if (!there || there.boundingBox !== 'empty') return { at: xyz(cell.pos), placed: false, stopped: `на ${cell.pos.x},${cell.pos.y},${cell.pos.z} не воздух (${there && there.name}) — табличку некуда` }
  await walkNear(bot, cell.pos)
  const open = architect.onceSignEditor(bot, 2500)
  const r = await architect.putCell(bot, cell)
  if (!r.ok) { open.cancel(); return { at: xyz(cell.pos), placed: false, stopped: `табличка не встала: ${r.why}` } }
  const w = await architect.writeSign(bot, cell.pos, cut, { opened: open })
  return { at: xyz(cell.pos), placed: true, wrote: w.ok, block: r.name, text: architect.signText(bot, cell.pos), why: w.why, cut: long.length ? long : undefined }
}
declare namespace sign {
  let category: any
}


const signExport = sign
export { CATS, categoryOf, categoryFromText, labelsFor, findStorage, sort, signExport as sign, labelChest }
