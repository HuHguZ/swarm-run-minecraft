'use strict'
const gameClock = require('./game-clock')
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const tools = require('./tools')
const pick = require('./pick')
const { raySees } = require('./perception')
const { withTimeout } = require('./build')

// Вёдра и обсидиан — то, без чего нет портала в Ад. nether.js ставит раму из
// обсидиана в рюкзаке и сам его не добывает; здесь — откуда он берётся:
// вода на лаву-источник и алмазная кирка.
//
// Всё по коду сервера (paper-1.21.11.jar, байткод):
// * LiquidBlock.shouldSpreadLiquid (лава): для направлений POSSIBLE_FLOW_DIRECTIONS
//   = [DOWN, SOUTH, NORTH, EAST, WEST] смотрит в клетку pos.relative(dir.getOpposite())
//   — то есть СВЕРХУ и по четырём сторонам, но не снизу. Там вода — лава-источник
//   становится obsidian, текущая лава — cobblestone. Вода под лавой не делает
//   ничего.
// * BucketItem.use: пустое ведро целится лучом с ClipContext.Fluid.SOURCE_ONLY —
//   луч проходит сквозь текущую жидкость и цепляет только источник; полное
//   ведро — Fluid.NONE: луч проходит сквозь любую жидкость, упирается в твёрдый
//   блок и кладёт воду в соседнюю клетку по грани (relative(direction)), если
//   сам блок воду не держит. Дальность — атрибут block_interaction_range, 4.5.
// * Обсидиан роняет только алмазная или незеритовая кирка (harvestTools в
//   minecraft-data 1.21.11); время — prismarine-block digTime (tools.js), с
//   алмазной без чар ~9.4 с на блок.
// * Выпавший предмет в лаве сгорает — обсидиан над лавой не ломаем: он упадёт
//   в неё.

const REACH = 4.5
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function sleep (ms, ctl?: any) {
  return new Promise<any>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve(undefined) })
  })
}

function levelOf (block) {
  if (!block) return null
  try {
    const p = block.getProperties ? block.getProperties() : null
    if (p && p.level !== undefined) return Number(p.level)
  } catch {}
  return typeof block.metadata === 'number' ? block.metadata : null
}

function isSource (block, name) {
  return !!block && block.name === name && levelOf(block) === 0
}

function solid (block) {
  return !!block && block.boundingBox === 'block'
}

function countOf (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

function eye (bot) {
  return bot.entity.position.offset(0, 1.62, 0)
}

// Видно ли глазами: луч от глаз до верхней части клетки не упирается в
// твёрдое раньше неё (жидкости лучу не мешают — их видно насквозь).
function seen (bot, pos) {
  return raySees(bot, eye(bot), pos.offset(0.5, 0.85, 0.5))
}

// Источники жидкости, которые видно, ближние вперёд.
function visibleSources (bot, name, radius) {
  const id = bot.registry.blocksByName[name] && bot.registry.blocksByName[name].id
  if (id === undefined) return []
  const me = bot.entity.position
  const candidates = process.env.ND_OW_KIT_WATER === '0' ? bot.findBlocks({ matching: id, maxDistance: radius, count: 400 }).map(p => bot.blockAt(p))
    : require('./sight').visibleOf(bot, [id], radius, { max: 24, rays: 1500, skip: p => !isSource(bot.blockAt(p), name) })
  return candidates
    .filter(b => isSource(b, name) && seen(bot, b.position))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

async function holdItem (bot, name) {
  const it = bot.inventory.items().find(i => i.name === name)
  if (!it) return false
  if (bot.heldItem && bot.heldItem.name === name) return true
  try { await bot.equip(it, 'hand'); return true } catch { return false }
}

async function walk (bot, ctl, goal, ms = 15000) {
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, 'дойти не успел')
    return true
  } catch {
    try { bot.pathfinder.setGoal(null) } catch {}
    return false
  }
}

// Предмет в руке сменился: ведро наполнилось или опустело.
async function waitHeld (bot, name, ms = 1500) {
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < ms) {
    if (countOf(bot, name) > 0) return true
    await sleep(50)
  }
  return countOf(bot, name) > 0
}

// ------------------------------------------------------------------ ведро

// Набрать ведро воды или лавы из видимого источника.
async function fillBucket (session, ctl, { fluid = 'water', radius = 24, walk: approach = true }: any = {}) {
  const bot = session.bot
  const full = `${fluid}_bucket`
  if (countOf(bot, full) > 0) return { already: true, have: full }
  if (countOf(bot, 'bucket') === 0) {
    return { filled: false, need: { what: 'bucket', count: 1, have: 0 }, stopped: 'нет пустого ведра (3 железа на верстаке)' }
  }
  const sources = visibleSources(bot, fluid, radius)
  if (!sources.length) {
    return { filled: false, stopped: `не вижу источника ${fluid === 'water' ? 'воды' : 'лавы'} в ${radius} блоках (текущая не годится: ведро берёт только источник)${sourceCensus(bot, fluid, radius)}` }
  }
  // Почему не вышло — по каждому источнику (лаборатория ow-W, 02.10: «не набралось ни из одного» без причины).
  const why = []
  for (const src of sources.slice(0, 6)) {
    if (ctl.aborted) break
    const p = src.position
    const tag = `${p.x},${p.y},${p.z}`
    // Подойти так, чтобы верх клетки был в досягаемости, и не встать в лаву.
    if (p.offset(0.5, 0.85, 0.5).distanceTo(eye(bot)) > REACH - 0.3) {
      if (!approach) { why.push(`${tag}: вне досягаемости, нужен отдельный подход`); continue }
      const goal = new goals.GoalNear(p.x, p.y + 1, p.z, 2)
      if (!(await walk(bot, ctl, goal))) { why.push(`${tag}: не дошёл`); continue }
    }
    const d = p.offset(0.5, 0.85, 0.5).distanceTo(eye(bot))
    if (d > REACH - 0.2) { why.push(`${tag}: далеко ${d.toFixed(1)}`); continue }
    if (!(await holdItem(bot, 'bucket'))) { why.push('ведро не взял в руку'); break }
    // Клик ведром — как в cast1.useAt: поворот в самом use_item, до 3 повторов с ожиданием ответа (Paper роняет use_item,
    // замок руки автопилота отменяет клик; rt3 03.10: «черпак мимо (пусто)» у шести источников подряд при чистом луче).
    await require('./cast1').useAt(bot, p.offset(0.5, 0.85, 0.5), 'bucket', { tries: 3, wait: 400 })
    if (await waitHeld(bot, full, 600)) {
      return { filled: true, have: full, from: { x: p.x, y: p.y, z: p.z } }
    }
    // Вода за стенкой (водоносный карман у штрека, озеро за краем): человек сломал бы стенку и зачерпнул. Для воды это
    // безопасно — она зальёт пол штрека, а ведро (SOURCE_ONLY) берёт источник сквозь текущую. Ломается только блок,
    // в который упёрся луч черпака, вплотную к источнику, по видимой грани (pick.faceAim), не свой пол.
    if (fluid === 'water') {
      const b = await breachWall(bot, ctl, p)
      if (b === true) {
        await sleep(400)
        if (await holdItem(bot, 'bucket')) {
          await require('./cast1').useAt(bot, p.offset(0.5, 0.85, 0.5), 'bucket', { tries: 3, wait: 400 })
          if (await waitHeld(bot, full, 600)) return { filled: true, have: full, from: { x: p.x, y: p.y, z: p.z }, breached: true }
        }
        why.push(`${tag}: стенку сломал, черпак мимо (${firstOnRay(bot, p.offset(0.5, 0.85, 0.5))})`)
        continue
      }
      if (b) { why.push(`${tag}: ${b}`); continue }
    }
    why.push(`${tag}: черпак мимо (${firstOnRay(bot, p.offset(0.5, 0.85, 0.5))})`)
  }
  return { filled: false, stopped: `ведро не набралось ни из одного из ${Math.min(6, sources.length)} источников (не дотянулся или луч упёрся в блок): ${why.join('; ').slice(0, 300)}` }
}

// Сломать стенку между глазами и источником воды: true — сломана, строка — почему нельзя, null — стенки нет.
async function breachWall (bot, ctl, src) {
  const o = eye(bot)
  const tgt = src.offset(0.5, 0.85, 0.5)
  const delta = tgt.minus(o)
  const len = delta.norm()
  const hit = pick.blockOnRay(bot, o, delta.scaled(1 / len), len + 0.3)
  if (!hit || !hit.block || hit.pos.equals(src)) return null
  const w = hit.pos
  const b = bot.blockAt(w)
  if (!b || b.boundingBox !== 'block' || !tools.breakable(b)) return `стенка ${b ? b.name : '?'} не ломается`
  if (/bedrock|obsidian|chest|barrel|spawner|portal|reinforced/.test(b.name)) return `стенка ${b.name} — не ломаю`
  if (w.distanceTo(src) > 1.8) return `стенка ${b.name} ${w.x},${w.y},${w.z} не у воды`
  const feet = bot.entity.position.floored()
  if (w.x === feet.x && w.z === feet.z && w.y < feet.y) return 'стенка — мой пол'
  // Лава рядом со стенкой или сыпучее над ней — не вскрывать (Codex ow-review1: вода из кармана не единственный риск).
  const around = [w.offset(0, 1, 0), ...SIDES.map(([x, z]) => w.offset(x, 0, z))]
  if (around.some(q => { const n = bot.blockAt(q); return !n || n.name === 'lava' || /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$|concrete_powder$/.test(n.name) })) return 'стенка у лавы или под сыпучим — не вскрываю'
  let aim = null
  for (const f of [new Vec3(0, 0, 0)].concat(SIDES.map(([x, z]) => new Vec3(x, 0, z)), [new Vec3(0, 1, 0), new Vec3(0, -1, 0)])) {
    if (!f.x && !f.y && !f.z) continue
    aim = pick.faceAim(bot, w, f, { range: REACH })
    if (aim) break
  }
  if (!aim) return `стенка ${b.name} не видна прицелом`
  try {
    await tools.equipFastest(bot, b)
    await bot.lookAt(aim, true)
    await withTimeout(bot.dig(b, 'ignore'), 8000, 'не копается')
  } catch (e) {
    try { bot.stopDigging() } catch {}
    return `стенка ${b.name}: ${e.message}`
  }
  if (ctl.aborted) return 'прервано'
  return solid(bot.blockAt(w)) ? `стенка ${b.name} не сломалась` : true
}

// Диагностика «не вижу»: сколько клеток жидкости в радиусе, сколько из них источники, сколько видно.
function sourceCensus (bot, name, radius) {
  try {
    const id = bot.registry.blocksByName[name] && bot.registry.blocksByName[name].id
    const all = bot.findBlocks({ matching: id, maxDistance: radius, count: 400 }).map(p => bot.blockAt(p)).filter(Boolean)
    const src = all.filter(b => isSource(b, name))
    const vis = src.filter(b => seen(bot, b.position))
    const near = src[0] ? ` ближний ${src[0].position.x},${src[0].position.y},${src[0].position.z} lvl ${levelOf(src[0])}` : (all[0] ? ` ближняя ${all[0].position.x},${all[0].position.y},${all[0].position.z} lvl ${levelOf(all[0])}` : '')
    return ` [клеток ${all.length}, источников ${src.length}, видно ${vis.length}${near}]`
  } catch (e) { return ` [перепись: ${e.message}]` }
}

// Что первым стоит на луче черпака (для причины промаха): имя и клетка.
function firstOnRay (bot, target) {
  try {
    const from = eye(bot)
    const delta = target.minus(from)
    const hit = bot.world.raycast(from, delta.normalize(), Math.min(delta.norm() + 0.5, 6), b => b && (b.boundingBox !== 'empty' || /water|lava|seagrass|kelp/.test(b.name)))
    return hit ? `${hit.name} ${hit.position.x},${hit.position.y},${hit.position.z}` : 'пусто'
  } catch (e) { return e.message }
}

// Вылить воду так, чтобы она легла в клетку over (над твёрдым блоком ground):
// полное ведро целится с Fluid.NONE — в верхнюю грань ground.
async function pourOnto (bot, ground) {
  if (!(await holdItem(bot, 'water_bucket'))) return false
  try { await bot.lookAt(ground.offset(0.5, 1, 0.5), true) } catch {}
  await sleep(80)
  try { bot.activateItem() } catch {}
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1200) {
    if (countOf(bot, 'water_bucket') === 0) return true
    await sleep(50)
  }
  return false
}

// Забрать воду обратно: источник там, куда лили.
async function scoopWater (bot, cell) {
  if (!(await holdItem(bot, 'bucket'))) return false
  try { await bot.lookAt(cell.offset(0.5, 0.8, 0.5), true) } catch {}
  await sleep(80)
  try { bot.activateItem() } catch {}
  return waitHeld(bot, 'water_bucket', 1200)
}

// --------------------------------------------------------------- обсидиан

// Можно ли ломать этот обсидиан: не над лавой (дроп сгорит), не часть горящего
// портала, видно и достаёт.
function mineable (bot, pos) {
  const below = bot.blockAt(pos.offset(0, -1, 0))
  if (!below || below.name === 'lava' || below.name === 'air' || below.name === 'water') {
    // В воздух — упадёт ниже; ниже может быть лава. Не рискуем.
    return { ok: false, why: below && below.name === 'lava' ? 'под ним лава — дроп сгорит' : 'под ним пусто' }
  }
  for (const [dx, dz] of SIDES) {
    const n = bot.blockAt(pos.offset(dx, 0, dz))
    if (n && n.name === 'nether_portal') return { ok: false, why: 'это рама горящего портала' }
  }
  const up = bot.blockAt(pos.offset(0, 1, 0))
  if (up && up.name === 'nether_portal') return { ok: false, why: 'это рама горящего портала' }
  return { ok: true }
}

// Край лавы, на котором можно встать: твёрдая клетка вровень с источником
// (сбоку от него), над ней две свободные. Встав на неё и вылив воду себе под
// ноги, заливаем поверхность лавы сверху.
function edgeSpots (bot, lava) {
  const out = []
  for (const src of lava) {
    for (const [dx, dz] of SIDES) {
      const g = src.position.offset(dx, 0, dz)
      const gb = bot.blockAt(g)
      if (!solid(gb) || gb.name === 'obsidian') continue
      const a = bot.blockAt(g.offset(0, 1, 0))
      const b = bot.blockAt(g.offset(0, 2, 0))
      if (!a || !b || a.boundingBox !== 'empty' || b.boundingBox !== 'empty') continue
      if (a.name === 'lava' || b.name === 'lava') continue
      out.push({ ground: g, lava: src.position })
    }
  }
  const me = bot.entity.position
  out.sort((p, q) => p.ground.distanceTo(me) - q.ground.distanceTo(me))
  return out
}

function hasObsidianPick (bot) {
  return bot.inventory.items().find(i => i.name === 'netherite_pickaxe') ||
    bot.inventory.items().find(i => i.name === 'diamond_pickaxe') || null
}

async function mineOne (session, ctl, block) {
  const bot = session.bot
  const p = block.position
  if (p.offset(0.5, 0.5, 0.5).distanceTo(eye(bot)) > REACH - 0.2) {
    const goal = new goals.GoalNear(p.x, p.y + 1, p.z, 2)
    if (!(await walk(bot, ctl, goal))) return { ok: false, why: 'не подошёл' }
  }
  const pick = hasObsidianPick(bot)
  if (!pick) return { ok: false, why: 'нет алмазной кирки' }
  try { await bot.equip(pick, 'hand') } catch {}
  // В воде и в прыжке копается в 5 раз медленнее (digTime: /5 за каждое) —
  // после заливки вода сходит секунду-другую: подождать, а не ломать 47 с.
  const t1 = gameClock.now()
  while (gameClock.now() - t1 < 4000 && !ctl.aborted && (bot.entity.isInWater || !bot.entity.onGround)) await sleep(100)
  const before = countOf(bot, 'obsidian')
  const r = await tools.breakFast(bot, p, { maxMs: 20000 })
  if (!r.ok) return { ok: false, why: r.why === 'слишком долго' ? `ломать ${Math.round(r.ms / 1000)} с — стою в воде или не на земле` : 'не сломал', retry: true }
  // Дроп падает в ямку на месте блока: подойти и подобрать.
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 4000 && !ctl.aborted && countOf(bot, 'obsidian') <= before) {
    const drop = bot.nearestEntity(e => e && e.name === 'item' && e.position && e.position.distanceTo(p.offset(0.5, 0.5, 0.5)) < 2.5)
    if (drop && drop.position.distanceTo(bot.entity.position) > 1) {
      try { bot.pathfinder.setGoal(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)) } catch {}
    }
    await sleep(200)
  }
  try { bot.pathfinder.setGoal(null) } catch {}
  return { ok: countOf(bot, 'obsidian') > before, ms: r.ms }
}

// Добыть count обсидиана: сначала видимый готовый (в том числе от прошлого
// захода), потом залить водой ближнюю лаву и ломать то, что застыло.
async function obsidian (session, ctl, { count = 10, radius = 20, timeoutSeconds = 300 }: any = {}) {
  const bot = session.bot
  const deadline = gameClock.now() + Math.min(600, timeoutSeconds) * 1000
  const have0 = countOf(bot, 'obsidian')
  const want = have0 + count
  const report: any = { want: count, got: 0, poured: 0, skipped: {} }
  const skip = (why) => { report.skipped[why] = (report.skipped[why] || 0) + 1 }

  if (!hasObsidianPick(bot)) {
    return { ...report, stopped: 'обсидиан роняет только алмазная или незеритовая кирка', need: { what: 'diamond_pickaxe', count: 1, have: 0 } }
  }
  const tried = new Set()
  const fails = new Map()
  const pouredAt = new Set()
  while (!ctl.aborted && gameClock.now() < deadline && countOf(bot, 'obsidian') < want) {
    // 1. Готовый видимый обсидиан, который можно ломать.
    const obsId = bot.registry.blocksByName.obsidian.id
    const ready = bot.findBlocks({ matching: obsId, maxDistance: radius, count: 200 })
      .map(p => bot.blockAt(p))
      .filter(b => b && !tried.has(b.position.toString()) && seen(bot, b.position))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    let mined = false
    for (const b of ready) {
      const key = b.position.toString()
      const m = mineable(bot, b.position)
      if (!m.ok) { tried.add(key); skip(m.why); continue }
      const r = await mineOne(session, ctl, b)
      if (r.ok) { mined = true; break }
      // Вторая попытка по тому же блоку — только одна.
      fails.set(key, (fails.get(key) || 0) + 1)
      if (!r.retry || fails.get(key) >= 2) { tried.add(key); skip(r.why) }
    }
    if (mined) continue

    // 2. Лава: вода сверху делает из источника обсидиан.
    const lava = visibleSources(bot, 'lava', radius)
    if (!lava.length) {
      report.stopped = `не вижу ни лавы-источника, ни обсидиана, который можно ломать, в ${radius} блоках`
      break
    }
    if (countOf(bot, 'water_bucket') === 0) {
      const f = await fillBucket(session, ctl, { fluid: 'water', radius: Math.max(radius, 32) })
      if (!f.filled && !f.already) {
        report.stopped = `нужна вода на лаву: ${f.stopped}`
        if (f.need) report.need = f.need
        else report.need = { what: 'water_bucket', count: 1, have: 0 }
        break
      }
    }
    const spots = edgeSpots(bot, lava).filter(s => !pouredAt.has(s.ground.toString()))
    if (!spots.length) {
      report.stopped = 'лава есть, но встать на край вровень с ней негде (нужна твёрдая клетка сбоку от источника и две свободные над ней)'
      break
    }
    let done = false
    for (const s of spots.slice(0, 4)) {
      if (ctl.aborted) break
      pouredAt.add(s.ground.toString())
      const g = s.ground
      if (!(await walk(bot, ctl, new goals.GoalBlock(g.x, g.y + 1, g.z)))) continue
      const feet = bot.entity.position.floored()
      if (feet.x !== g.x || feet.z !== g.z || feet.y !== g.y + 1) continue
      if (!(await pourOnto(bot, g))) continue
      report.poured++
      // Вода растекается по 1 блоку за 5 тиков (WaterFluid.getTickDelay = 5);
      // на 3-4 клетки над лавой — около секунды, с запасом две.
      await sleep(2000, ctl)
      await scoopWater(bot, g.offset(0, 1, 0))
      await sleep(600, ctl)
      done = true
      break
    }
    if (!done) {
      report.stopped = 'не смог вылить воду ни с одного края'
      break
    }
  }
  report.got = countOf(bot, 'obsidian') - have0
  report.have = countOf(bot, 'obsidian')
  if (!report.stopped && report.have < want) report.stopped = gameClock.now() >= deadline ? 'время вышло' : (ctl.aborted ? 'прервано' : 'не набрал')
  if (!Object.keys(report.skipped).length) delete report.skipped
  return report
}

module.exports = { fillBucket, obsidian, visibleSources, pourOnto, scoopWater, isSource }
