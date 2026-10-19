'use strict'
// Обратно наверх: шахта, подъём, мост под ногами, сбор блоков на столб.
// ---------------------------------------------------------------- наверх
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
// Вернуться наверх к нему: выпал с арены в небе живым (ведро спасло) и стоял
// внизу, глядя на него за полсотни блоков (2026-09-25: «не понимает, что между
// ними огромная высота»). Столб из блоков под ногами (build.towerUp) — в
// шахте, которая выходит на его пол: дыра в полу рядом с ним (край дыры —
// опора, над ним свободно). Нет такой — столб на месте, потолок над головой
// выломать (tools.breakFast) и дальше вверх.
// Куда подниматься обратно на арену (2026-09-27, пользователь: «поднимался
// на блоке, упёрся в обсидиан, в потолок — не увидел, что не может подняться»).
// Раньше дыра искалась в 20 блоках от НЕГО и только с землёй на нашей высоте,
// а не нашлась — столб на месте, в обсидиановый пол (9 с киркой, 12 с — отказ).
// Теперь: открытые клетки пола (дыры, выбитый взрывом светокамень) в radius от
// НАС; под дырой — земля у нашей высоты (±6) или свободный столб на нашей
// высоте (мы на уступе или старом столбе — к нему мост, pathfinder ставит
// блоки); нет дыр — клетка пола, которая ломается быстро (светокамень рукой
// ~0.5 с), под ней столб, её — ломать. Цена — путь по земле, мост, ломка.
// Water has no collision and can be replaced by the tower's support block.
// Keep the same clearance/hazard checks for every non-water cell.
const shaftPassable = b => !!b && b.boundingBox === 'empty' && !/lava|fire|cobweb/.test(b.name)

function findShaft (bot, target, { radius = 40, archer: shooter = false, floorY: floorAt = null, exclude = null, digNear = 3000 }: any = {}) {
  // floorAt — уровень ног на поле арены (он сам может стоять на столбе выше).
  const Ty = floorAt != null ? Math.floor(floorAt + 1e-6) : Math.floor(target.position.y + 1e-6)
  const floorY = Ty - 1
  const me = bot.entity.position
  const myY = Math.floor(me.y + 1e-3)
  const tools: typeof import('../tools') = require('../tools')
  const pass = p => shaftPassable(bot.blockAt(p, false))
  const solidAt = (p) => { const b = bot.blockAt(p, false); return !!b && b.boundingBox === 'block' }
  const cx = Math.floor(me.x); const cz = Math.floor(me.z)
  // Столб от уровня y вверх до пола свободен?
  const openUp = (x, z, y) => { for (let yy = y; yy < floorY; yy++) if (!pass(new Vec3(x, yy, z))) return false; return true }
  // Где стоять под клеткой пола (x, z): земля у нашей высоты или наш уровень.
  const standUnder = (x, z) => {
    for (let y = floorY - 1; y >= myY - 8; y--) {
      const p = new Vec3(x, y, z)
      if (pass(p)) continue
      if (solidAt(p) && Math.abs(y + 1 - me.y) <= 6 && Ty - (y + 1) >= 2) return { gy: y + 1, bridge: false }
      break
    }
    if (myY < floorY - 1 && openUp(x, z, myY)) return { gy: myY, bridge: !solidAt(new Vec3(x, myY - 1, z)) }
    return null
  }
  // Он у выхода — ударит, пока вылезаем; лук у края — весь подъём под
  // стрелами. Как человек: вылезать подальше от него (дыр в полу арены 8).
  const him = target.position
  const hand = target.equipment && target.equipment[0] ? target.equipment[0].name : ''
  // Лук в руке сейчас или стрелял в этом бою (меняет лук на меч и обратно).
  const archer = shooter || hand === 'bow' || hand === 'crossbow'
  const threat = (x, z, n) => {
    const dh = Math.hypot(x + 0.5 - him.x, z + 0.5 - him.z)
    let c = dh < 6 ? (6 - dh) * 5 : 0
    if (archer && dh < 24) c += n * 1.6 * (1 - dh / 24)
    return c
  }
  let best = null
  const slowCands = []
  const consider = (x, z, digMs) => {
    const u = standUnder(x, z)
    if (!u) return
    const cost = Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) + Math.abs(u.gy - me.y) * 2 + (u.bridge ? 6 : 0) + digMs / 250 + threat(x, z, Ty - u.gy)
    if (!best || cost < best.cost) best = { x, z, gy: u.gy, n: Ty - u.gy, cost, bridge: u.bridge, digMs: Math.round(digMs) }
  }
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue
      const x = cx + dx; const z = cz + dz
      if (exclude && exclude.has(x + ',' + z)) continue
      const top = new Vec3(x, floorY, z)
      if (!pass(top.offset(0, 1, 0)) || !pass(top.offset(0, 2, 0))) continue
      if (pass(top)) {
        // Открытая клетка пола: край, с которого шагнуть на пол.
        let rim = false
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = top.offset(ax, 0, az)
          if (solidAt(n) && pass(n.offset(0, 1, 0)) && pass(n.offset(0, 2, 0))) { rim = true; break }
        }
        if (rim) consider(x, z, 0)
        continue
      }
      // Закрытая клетка пола: ломать, если быстро (светокамень, дерево, песок).
      const b = bot.blockAt(top, false)
      if (!b || b.boundingBox !== 'block') continue
      const ms = tools.bestFor(bot, b).ms
      // Прямо над нами (или рядом) — ломать и дольше (digNear): застряли под
      // полом на своём столбе, а до дыр не дойти (живая арена 2026-09-27).
      if (ms <= 3000 || (ms <= digNear && Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) <= 1.6)) consider(x, z, ms)
      else if (Number.isFinite(ms) && ms <= 30000) slowCands.push([x, z, ms])
    }
  }
  // Быстрого выхода нет — долгая копка (обсидиан киркой ~9.4 с) по той же цене, а не «сидеть в яме» (S7d: колизей,
  // «кристаллы» — 120 с «над головой только обсидиан» под его «не выпускаю», ничья по застою).
  if (!best) for (const [x, z, ms] of slowCands) consider(x, z, ms)
  return best
}

async function climbBack (bot, ctl, target, { maxMs = 60000, beforeStep = null, archer = false, floorY = null, exclude = null, digNear = 3000 }: any = {}) {
  const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const { towerUp, pickFiller }: typeof import('../build') = require('../build')
  const tools: typeof import('../tools') = require('../tools')
  const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
  const t0 = gameClock.now()
  const Ty = floorY != null ? Math.floor(floorY + 1e-6) : Math.floor(target.position.y + 1e-6)
  const movement: typeof import('../movement') = require('../movement')
  const swimRoute = movement.inWater(bot) ? movement.findSwimRoute(bot, { visibleOnly: true }) : null
  if (swimRoute && (swimRoute.kind === 'land' || swimRoute.path.length)) {
    const swim = await movement.escapeWater(bot, ctl, { timeoutMs: maxMs, visibleOnly: true })
    if (ctl.aborted) return { ok: false, placed: 0, why: 'подъём прерван', seconds: Math.round((gameClock.now() - t0) / 1000) }
    if (swim.ok && Math.floor(bot.entity.position.y + 1e-6) >= Ty) {
      return { ok: true, how: 'выплыл из ямы на берег', placed: 0, seconds: Math.round((gameClock.now() - t0) / 1000) }
    }
    if (!swim.breathing) return { ok: false, placed: 0, why: swim.error, seconds: Math.round((gameClock.now() - t0) / 1000) }
  }
  if (gameClock.now() - t0 >= maxMs) return { ok: false, placed: 0, why: 'время подъёма вышло', seconds: Math.round((gameClock.now() - t0) / 1000) }
  const fillers = () => fillerCount(bot)
  // Обсидиан — последним: он нужен на коробки, но лучше подняться им, чем стоять внизу.
  const towerItem = () => pickFiller(bot) ? null : (bot.inventory.items().find(i => i.name === 'obsidian' || i.name === 'crying_obsidian') || {}).name || null
  const need0 = Ty - Math.floor(bot.entity.position.y)
  if ((!pickFiller(bot) && !towerItem()) || fillers() < need0) return { ok: false, why: `блоков ${fillers()}, надо ${need0}`, need: need0, have: fillers() }
  const shaft = findShaft(bot, target, { archer, floorY: Ty, exclude, digNear })
  if (process.env.ND_DEBUG_CLIMB) console.log('[climbBack] shaft', JSON.stringify({ me: bot.entity.position.floored(), him: target.position.floored(), hand: target.equipment && target.equipment[0] && target.equipment[0].name, archer, shaft }))
  let how = 'столб на месте, потолок — ломать'
  if (!shaft) return { ok: false, how: 'нет подходящей шахты для подъёма', placed: 0, why: 'не нашёл проходимый выход наверх', seconds: 0 }
  if (shaft) {
    how = shaft.digMs ? `под быстрый пол у ${shaft.x},${shaft.z} (${shaft.n} бл., ломать ${(shaft.digMs / 1000).toFixed(1)} с)` : `через дыру в полу у ${shaft.x},${shaft.z} (${shaft.n} бл.${shaft.bridge ? ', мостом' : ''})`
    try {
      bot.pathfinder.setGoal(new goals.GoalBlock(shaft.x, shaft.gy, shaft.z))
      const until = Math.min(t0 + maxMs, gameClock.now() + (shaft.bridge ? 30000 : 20000))
      // Пути нет (стоим на своём столбе под полом) — не ждать 20 с впустую.
      let noPath = 0
      const onPath = (r) => { if (r && r.status === 'noPath') noPath++ }
      bot.on('path_update', onPath)
      try {
        while (gameClock.now() < until && !ctl.aborted && noPath === 0) {
          const p = bot.entity.position
          if (Math.floor(p.x) === shaft.x && Math.floor(p.z) === shaft.z && Math.abs(p.y - shaft.gy) < 1.1) break
          await sleep(100)
        }
      } finally { bot.removeListener('path_update', onPath) }
    } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    let p = bot.entity.position
    if (!(Math.floor(p.x) === shaft.x && Math.floor(p.z) === shaft.z)) {
      // Не дошли, а стоим высоко — на своём столбе под сплошным полом (живая
      // арена 2026-09-27: 53 блока столба с земли, упёрся в край пола; кирки
      // нет — «небо и порох»). Как человек: мост под потолком к столбу дыры на
      // своём уровне, потом вверх сквозь неё.
      const myY2 = Math.floor(p.y + 1e-3)
      const dist = Math.abs(shaft.x - Math.floor(p.x)) + Math.abs(shaft.z - Math.floor(p.z))
      const passAt = (x, y, z) => shaftPassable(bot.blockAt(new Vec3(x, y, z), false))
      let open = true
      for (let yy = myY2; yy <= Ty + 1 && open; yy++) if (!passAt(shaft.x, yy, shaft.z)) open = false
      if ((shaft.bridge || myY2 > shaft.gy + 1) && dist <= 24 && open && fillers() >= dist + (Ty - myY2) + 2) {
        const br = await bridgeUnder(bot, ctl, shaft.x, shaft.z, { maxBlocks: dist + 2 })
        p = bot.entity.position
        how += br.ok ? ' — мостом под полом' : ' — мост под полом не вышел: ' + br.why
      }
      if (!(Math.floor(p.x) === shaft.x && Math.floor(p.z) === shaft.z)) return { ok: false, how, placed: 0, why: 'до места под дырой не дошёл', shaft, seconds: Math.round((gameClock.now() - t0) / 1000) }
    }
  }
  // Вверх, кусками: наполнитель пересчитывать (стопка кончается).
  let placed = 0
  while (!ctl.aborted && gameClock.now() - t0 < maxMs && Math.floor(bot.entity.position.y + 1e-6) < Ty) {
    const f = bot.entity.position.floored()
    for (const up of [2, 3]) {
      const b = bot.blockAt(f.offset(0, up, 0), false)
      if (b && b.boundingBox === 'block') {
        // Ломать только быстрое (светокамень выбранной клетки, мусор): в
        // обсидиан над головой не упираться.
        // Наверху столба потолок — ломать и обсидиан, если кирка берёт его за 12 с
        // (живая арена 2026-09-27: дыру над шахтой закрыли, 9.4 с алмазной —
        // «слишком долго» при пределе 3.5 с, и 50 блоков столба впустую).
        const r = await tools.breakFast(bot, b.position, { maxMs: Math.max(12000, ((shaft && shaft.digMs) || 0) + 2000) }).catch(() => ({ ok: false }))
        if (process.env.ND_DEBUG_CLIMB) console.log('[climbBack] ceiling', JSON.stringify({ at: b.position, name: b.name, up, r, onGround: bot.entity.onGround, held: bot.heldItem && bot.heldItem.name, plan: tools.bestFor(bot, bot.blockAt(b.position) || b) && tools.bestFor(bot, bot.blockAt(b.position) || b).ms }))
        if (!r.ok && up === 2) return { ok: false, how, placed, why: `не выломал потолок ${b.name}`, shaft, seconds: Math.round((gameClock.now() - t0) / 1000) }
      }
    }
    const left = Ty - Math.floor(bot.entity.position.y + 1e-6)
    const r = await towerUp(bot, ctl, Math.min(8, left), { sneak: true, fast: true, beforeStep, item: towerItem() })
    placed += ((r && r.placed) || 0) + ((r && r.supportPlaced) || 0)
    if (!r || !r.placed) {
      const again = await towerUp(bot, ctl, 1, { sneak: true, fast: true, beforeStep, item: towerItem() })
      placed += ((again && again.placed) || 0) + ((again && again.supportPlaced) || 0)
      if (!again || !again.placed) {
        const why = [].concat((again && (again.why || again.reason)) || [], (r && (r.why || r.reason)) || []).join('; ')
        return { ok: false, how, placed, why: why || 'столб не растёт', shaft, seconds: Math.round((gameClock.now() - t0) / 1000) }
      }
    }
  }
  try { bot.setControlState('sneak', false) } catch {}
  const ok = Math.floor(bot.entity.position.y + 1e-6) >= Ty
  return { ok, how, placed, shaft, seconds: Math.round((gameClock.now() - t0) / 1000) }
}

// Мост на своём уровне к столбу (x, z): клетка за клеткой по большей оси,
// присев (bridge.nextCell / stepOnto). Над мостом нужны две клетки воздуха.
async function bridgeUnder (bot, ctl, x, z, { maxBlocks = 24, timeoutMs = 20000 }: any = {}) {
  const bridge: typeof import('../bridge') = require('../bridge')
  const { placeBlockAt }: typeof import('../build') = require('../build')
  const t0 = gameClock.now()
  let placed = 0
  const goal = new Vec3(x + 0.5, 0, z + 0.5)
  try { bot.setControlState('sprint', false); bot.setControlState('sneak', true) } catch {}
  try {
    while (!ctl.aborted && gameClock.now() - t0 < timeoutMs && placed <= maxBlocks) {
      const cell = bridge.nextCell(bot, goal)
      if (!cell) return { ok: true, placed }
      const b = bot.blockAt(cell)
      if (!b) return { ok: false, placed, why: 'мир не прогружен' }
      if (b.boundingBox !== 'block') {
        const r = await placeBlockAt(bot, cell, { timeoutMs: 900 })
        if (!r.ok) return { ok: false, placed, why: r.reason || 'не поставил' }
        if (!r.already) placed++
      }
      for (const up of [1, 2]) { const hb = bot.blockAt(cell.offset(0, up, 0)); if (hb && hb.boundingBox === 'block') return { ok: false, placed, why: 'над мостом блок' } }
      await bridge.stepOnto(bot, ctl, cell)
    }
  } finally {
    try { bot.setControlState('sneak', false); bot.setControlState('forward', false) } catch {}
  }
  return { ok: false, placed, why: 'не успел' }
}

// Блоки, которыми строится столб (build.pickFiller), и обсидиан — счёт на подъём.
const CLIMB_FILLER = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|sand|gravel|obsidian|crying_obsidian|[a-z_]+_planks)$/
function fillerCount (bot) {
  return bot.inventory.items().filter(i => CLIMB_FILLER.test(i.name)).reduce((n, i) => n + i.count, 0)
}

// Блоки на подъём кончились — добыть (2026-09-27, пользователь: «если нет
// блоков, должна включаться программа выживания: землю лопатой легко
// добыть, и потом строиться»). Ближайшие блоки, что ломаются быстро и
// выпадают строительным блоком: земля и дёрн (→ земля), песок, гравий, камень
// (→ булыжник), сланец, андезит, диорит, гранит, туф, незерак. По одному:
// подойти на руку, сломать лучшим инструментом (tools.breakFast), подобрать.
// Не клетку под собой: столб из своей же ямки начинать незачем.
const GATHER = /^(dirt|grass_block|podzol|mycelium|sand|gravel|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|blackstone|basalt|netherrack|[a-z_]+_planks)$/
async function gatherBlocks (bot, ctl, { want = 20, maxMs = 30000, radius = 10 }: any = {}) {
  const tools: typeof import('../tools') = require('../tools')
  const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
  const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
  const t0 = gameClock.now()
  const before = fillerCount(bot)
  const what = {}
  const bad = new Set()
  let why = null
  let broke = 0
  const key = (p) => p.x + ',' + p.y + ',' + p.z
  const wet = (p) => { for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) { const n = bot.blockAt(p.offset(ax, ay, az)); if (n && /lava|water/.test(n.name)) return true } return false }
  const fast = (b) => !!b && GATHER.test(b.name) && !bad.has(key(b.position)) && tools.bestFor(bot, b).ms <= 1600 && !wet(b.position)
  const airish = (b) => !!b && b.boundingBox === 'empty' && !/lava|water|fire|cobweb/.test(b.name)
  const solidAt = (p) => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
  const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  const STRAIGHT = AROUND.slice(0, 4)
  const hit = async (p) => {
    const b = bot.blockAt(p)
    const r = await tools.breakFast(bot, p, { maxMs: 2500 }).catch(() => ({ ok: false }))
    if (r && r.ok) { broke++; what[b.name] = (what[b.name] || 0) + 1; return true }
    bad.add(key(p))
    return false
  }
  // Шаг в соседнюю клетку (в ямку или по траншее): вперёд, пока ноги не там.
  const stepTo = async (cell) => {
    const t1 = gameClock.now()
    try {
      while (gameClock.now() - t1 < 1500 && !ctl.aborted) {
        const p = bot.entity.position
        if (Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.abs(p.y - cell.y) < 0.6) break
        const dx = cell.x + 0.5 - p.x; const dz = cell.z + 0.5 - p.z
        await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('jump', cell.y > Math.floor(p.y + 1e-3))
        await sleep(50)
      }
    } finally {
      try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {}
    }
    await sleep(120)
  }
  // Траншея, как у человека (2026-09-27: 26 блоков за минуту обходом по
  // одному). Выпавшее из соседней клетки на уровне ног подбирается само:
  // рамка игрока, раздутая на блок в стороны и на полблока по высоте
  // (Player.aiStep), её накрывает — ходить за каждым не нужно. Поэтому:
  // (1) стенки вокруг на уровне ног и головы — ломать, стоя на месте;
  // (2) нет стенок — шаг по траншее к клетке, у которой они есть;
  // (3) и её нет — сломать землю рядом и шагнуть в ямку (яма в блок глубиной:
  // стенки вокруг — это и есть земля).
  while (!ctl.aborted && gameClock.now() - t0 < maxMs && fillerCount(bot) - before < want) {
    const feet = bot.entity.position.floored()
    let wall = null
    for (const dy of [0, 1]) {
      for (const [dx, dz] of AROUND) {
        const p = feet.offset(dx, dy, dz)
        if (fast(bot.blockAt(p))) { wall = p; break }
      }
      if (wall) break
    }
    if (wall) { await hit(wall); continue }
    let move = null
    for (const [dx, dz] of STRAIGHT) {
      const c = feet.offset(dx, 0, dz)
      if (!airish(bot.blockAt(c)) || !airish(bot.blockAt(c.offset(0, 1, 0))) || !solidAt(c.offset(0, -1, 0))) continue
      let n = 0
      for (const [ax, az] of AROUND) if (fast(bot.blockAt(c.offset(ax, 0, az)))) n++
      if (n >= 2 && (!move || n > move.n)) move = { c, n }
    }
    if (move) { await stepTo(move.c); continue }
    let pit = null
    for (const [dx, dz] of STRAIGHT) {
      const g = feet.offset(dx, -1, dz)
      if (!fast(bot.blockAt(g)) || !solidAt(g.offset(0, -1, 0))) continue
      if (!airish(bot.blockAt(g.offset(0, 1, 0))) || !airish(bot.blockAt(g.offset(0, 2, 0)))) continue
      pit = g
      break
    }
    if (pit) {
      if (await hit(pit)) await stepTo(pit)
      continue
    }
    // Вокруг ничего — ближайший подходящий блок в округе (подойти, сломать, подобрать).
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const ids = (Object.values(bot.registry.blocksByName) as any[]).filter((b : any) => GATHER.test(b.name)).map((b : any) => b.id)
    const far = bot.findBlocks({ matching: ids, maxDistance: radius, count: 60 })
      .map(p => bot.blockAt(p)).filter(b => fast(b))
      .filter(b => { for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) if (airish(bot.blockAt(b.position.offset(ax, ay, az)))) return true; return false })
      .sort((a, b) => a.position.offset(0.5, 0.5, 0.5).distanceTo(eye) - b.position.offset(0.5, 0.5, 0.5).distanceTo(eye))
    if (!far.length) { why = 'рядом нечего ломать'; break }
    const t = far[0].position
    if (t.offset(0.5, 0.5, 0.5).distanceTo(eye) > 4.3) {
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(t.x, t.y, t.z, 2))
        const until = gameClock.now() + 6000
        while (gameClock.now() < until && !ctl.aborted && t.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 4.2) await sleep(100)
      } catch {}
      try { bot.pathfinder.setGoal(null) } catch {}
      if (t.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 4.5) { bad.add(key(t)); continue }
    }
    if (await hit(t)) await pickupNear(bot, ctl, t, 1600)
  }
  // Задержка подбора выпавшего из блока — 10 тиков (ItemEntity): дождаться.
  const t2 = gameClock.now()
  while (gameClock.now() - t2 < 700 && !ctl.aborted) {
    const me = bot.entity.position
    if (!(Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(me) < 2.2)) break
    await sleep(100)
  }
  const got = fillerCount(bot) - before
  return {
    got,
    broke,
    what: (Object.entries(what) as [string, any][]).map(([k, v]) => k + '×' + v).join(', '),
    ms: gameClock.now() - t0,
    why: got >= want ? null : (why || (ctl.aborted ? 'прервали' : gameClock.now() - t0 >= maxMs ? 'не успел' : 'не вышло'))
  }
}

// Подобрать выпавшее из клетки pos: подойти к предмету (подбирается, когда
// рамка игрока, раздутая на блок по горизонтали, его касается).
async function pickupNear (bot, ctl, pos, maxMs = 1500) {
  const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
  const t0 = gameClock.now()
  const c = pos.offset(0.5, 0.5, 0.5)
  await sleep(120)
  try {
    while (gameClock.now() - t0 < maxMs && !ctl.aborted) {
      const it: any = (Object.values(bot.entities) as any[]).find((e : any) => e && e.name === 'item' && e.position && e.position.distanceTo(c) < 3)
      if (!it) return true
      const me = bot.entity.position
      const dx = it.position.x - me.x; const dz = it.position.z - me.z
      if (Math.hypot(dx, dz) < 0.8 && Math.abs(it.position.y - me.y) < 1.2) { bot.setControlState('forward', false); await sleep(80); continue }
      await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('jump', !!bot.entity.isCollidedHorizontally || it.position.y > me.y + 0.6)
      await sleep(80)
    }
  } finally {
    try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {}
  }
  return false
}

export { findShaft, climbBack, fillerCount, gatherBlocks }
