'use strict'
const { REPO_ROOT }: typeof import('./paths') = require('./paths')
const gameClock: typeof import('./game-clock') = require('./game-clock')
// Природная лава для портала без алмазной кирки (агент G, 02.10.2026; research/07-portal-techniques.md).
// Найти ГЛАЗАМИ ближайшую годную лаву, выбрать технику, дойти, отлить раму (cast.js — не правлю, только зову) и
// зажечь (nether.portal). Новое поведение — RPC portal_natural (index.js); активный ход — под ND_PORTAL_NATURAL=1.
//
// Почему так, коротко (подробно и с числами — 07-portal-techniques.md):
// * «Магмовый овраг» спидраннеров 1.16 — это дно подводного оврага на y=10 (магма/обсидиан от карвера, лава под ним
//   при y ≤ 9), дверь — карман воздуха и стенка от воды, лава из-под магмы ставится в воду и сразу obsidian. В
//   1.21.11 подводного карвера нет: canyon/cave заливают лавой только ниже lava_level = above_bottom 8 (y −56).
//   Скан 12+ сидов (farm/portal-scan): у дна океанских впадин лавы 0 столбов из тысяч, магма — фича underwater_magma
//   в затопленных пещерах, без лавы под собой. Овражная техника неприменима.
// * Дверь: FlowingFluid.canHoldAnyFluid (Paper 1.21.11) не пускает воду в DoorBlock, SIGNS, LADDER, NETHER_PORTAL…
//   Лава ведром в воду — сразу obsidian (BucketItem.emptyContents: вода canBeReplaced → источник лавы → LiquidBlock
//   onPlace → shouldSpreadLiquid). Но рама в воде зажигается только с сухим интерьером 2×3 (PortalShape.isEmpty: воздух
//   или огонь): нужно запечатать 12 граней интерьера и вычерпать 6 источников — дороже, чем сэкономленные 10 вёдер воды
//   cast.js, а черпать лаву всё равно ходить 10 раз. Отдельным приёмом не делаю (см. 07, раздел «дверь»).
// * Значит, вся разница — НАЙТИ годную лаву быстро и честно. Порядок (скан): руины портала с лавой и поверхностное
//   озеро видны с поверхности издалека (светятся, на них небо) — первыми; вид с ближней высоты; пещерная лава видна
//   только из пещеры; дальше разведка лучами; низ (−55, гарантирован) — запасной путь потока overworld (ND_OW_DEEP).
//
// Честность: лава засчитана, только если луч от глаз упёрся в источник (sight.visibleOf). Источники одного тела
// (озера) считаются по связности от видимого и только с открытым верхом — их видно сверху тем же взглядом.

const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
const { visibleOf, seesBlock }: typeof import('./sight') = require('./sight')
const { travelXZ, sleep, xyz, inWater, escapeWater }: typeof import('./movement') = require('./movement')

const ON = () => process.env.ND_PORTAL_NATURAL === '1'
// Источников с открытым верхом на раму: cast.js льёт 10 клеток, по ведру на клетку, плюс промахи.
const NEED = 12
const RP_MARK = /^(obsidian|crying_obsidian|netherrack|magma_block|gold_block)$/
// Где с поверхности чаще годная лава — по скану (07, «биомы»); ровный рельеф = больше удачных озёр (LakeFeature:
// граница чаши ниже уровня жидкости должна быть твёрдой, выше — без жидкости).
const FLAT = /plains|savanna|desert|badlands|meadow|snowy_plains|beach/

const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
function levelOf (b) {
  try { const p = b.getProperties(); if (p && p.level !== undefined) return Number(p.level) } catch {}
  return typeof b.metadata === 'number' ? b.metadata : null
}
const isLavaSrc = b => !!b && b.name === 'lava' && levelOf(b) === 0

// Над клеткой до неба — ничего непрозрачного (листва, стекло не в счёт как «крыша»? в счёт: луч сверху их не
// пройдёт). Незагруженный верх считаем небом: выше прогруженного мира блоков нет.
function skyAbove (bot, p, maxUp = 80) {
  for (let dy = 1; dy <= maxUp; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (!b) return true
    if (!isAir(b)) return false
  }
  return true
}

// Тело лавы от видимого источника: связность по лаве (6 соседей), до limit клеток. open — источники с воздухом
// сверху (видны сверху тем же взглядом), all — все источники тела (для справки).
function lavaBody (bot, start, seen, limit = 900) {
  const key = p => `${p.x},${p.y},${p.z}`
  const q = [start]
  const body = { open: 0, all: 0, cells: 0, minY: start.y, maxY: start.y, openCells: [] }
  seen.add(key(start))
  while (q.length && body.cells < limit) {
    const p = q.shift()
    const b = bot.blockAt(p)
    if (!b || b.name !== 'lava') continue
    body.cells++
    if (levelOf(b) === 0) {
      body.all++
      if (isAir(bot.blockAt(p.offset(0, 1, 0)))) { body.open++; if (body.openCells.length < 40) body.openCells.push(p) }
    }
    body.minY = Math.min(body.minY, p.y); body.maxY = Math.max(body.maxY, p.y)
    for (const v of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = p.offset(v[0], v[1], v[2])
      const k = key(n)
      if (seen.has(k)) continue
      seen.add(k)
      const nb = bot.blockAt(n)
      if (nb && nb.name === 'lava') q.push(n)
    }
  }
  return body
}

// Руины портала рядом: обсидиан, плачущий, незерак, магма, золотые блоки в кубе r.
function rpNear (bot, c, r = 7) {
  const n = { obsidian: 0, crying_obsidian: 0, netherrack: 0, magma_block: 0, gold_block: 0 }
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const b = bot.blockAt(c.offset(dx, dy, dz))
        if (b && RP_MARK.test(b.name)) n[b.name]++
      }
    }
  }
  const rp = (n.crying_obsidian >= 1 && n.obsidian + n.netherrack >= 2) || (n.obsidian >= 3 && n.netherrack + n.magma_block >= 2)
  return { rp, ...n }
}

function waterNear (bot, c, r = 8) {
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const b = bot.blockAt(c.offset(dx, dy, dz))
        if (b && b.name === 'water' && levelOf(b) === 0) {
          const d = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))
          if (best === null || d < best) best = d
        }
      }
    }
  }
  return best
}

function biomeAt (bot, p) {
  try {
    const b = bot.blockAt(p)
    const id = b && b.biome && b.biome.id
    const reg = bot.registry && bot.registry.biomes
    if (reg && id !== undefined && reg[id]) return reg[id].name
    if (b && b.biome && b.biome.name) return b.biome.name
  } catch {}
  return null
}

// Оценка до горящего портала, с: путь (поверху 4 бл/с; вниз по пещере 1 с на уровень, вверх 0.6) плюс литьё
// cast.js (~150 с при большом озере, дольше при малом — добор ходит дальше). Для ранжирования, не обещание.
function estimate (me, site) {
  const h = Math.hypot(site.at.x - me.x, site.at.z - me.z)
  const dy = site.at.y - me.y
  const walk = h / 4 + (dy < 0 ? -dy * (site.kind === 'surface' || site.kind === 'rp' ? 0.4 : 1.0) : dy * 0.6)
  const cast = site.open >= 20 ? 150 : site.open >= NEED ? 180 : 240
  return Math.round(walk + cast)
}

// ---------------------------------------------------------------- осмотр (только чтение)

// Лава под открытым небом: верх столба (первая сверху не-воздушная клетка) — лава-источник. Так ищется озеро и
// лава у руин издалека. Через visibleOf сферой этого не видно: ближние сотни клеток лавы в пещерах под ногами (с
// пещерным воздухом рядом — «открытая грань») съедают потолок лучей раньше, чем очередь дойдёт до озера в 70 бл.
// (смоук pn-smoke2, 02.10: руины с лавой в 92 бл. и озеро в 146 бл. — «seen 0» на всех точках). Состояния читаются
// прямо из колонок чанков, как в sight.visibleOf; засчитана клетка только после луча seesBlock.
// Видна ли гладь жидкости: луч от глаз в точки ВЕРХНЕЙ грани клетки (центр и четыре точки у углов), а не в центр,
// как seesBlock: издали под пологим углом луч в центр клетки (y+0.5) упирается в край берега, хотя гладь (y+0.9)
// видна — человек видит именно её. Засчитано, если первая непустая на пути клетка — эта.
// Листва — не стена: у клиента (графика «Детально», по умолчанию) листья — вырезанная текстура с просветами, свечение
// лавы за кроной видно. Луч проходит не больше двух клеток листвы (смоук pn-pool, сид 2911374257081450067: озеро в
// 91 м за ельником — со столба +13 луч упирался в первую же еловую лапу).
const LEAVES = /leaves$/
function seesTop (bot, block, { leaves = 2 }: any = {}) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
  const p = block.position
  for (const [ox, oz] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
    const t = p.offset(ox, 0.85, oz)
    const delta = t.minus(eye)
    const dist = delta.norm()
    if (dist < 0.01) return true
    let leaf = 0
    try {
      const hit = bot.world.raycast(eye, delta.normalize(), dist + 0.3, (b, iter) => {
        if (b.position.equals(p)) return true
        if (LEAVES.test(b.name) && leaf < leaves) { leaf++; return false }
        return !!(b.shapes && b.shapes.length && iter.intersect(b.shapes, b.position))
      })
      if (hit && hit.position.equals(p)) return true
    } catch {}
  }
  return false
}

function skyLava (bot, radius, { up = 40, down = 48, rays = 1500 }: any = {}) {
  const reg = bot.registry
  const lava = reg.blocksByName.lava
  const airIds = new Set()
  for (const n of ['air', 'cave_air', 'void_air']) { const b = reg.blocksByName[n]; if (b) for (let s = b.minStateId; s <= b.maxStateId; s++) airIds.add(s) }
  const lavaSrc = lava.minStateId // level=0 — первое состояние лавы
  const minY = bot.game.minY
  const maxY = minY + bot.game.height - 1
  const c = bot.entity.position.floored()
  const r = Math.ceil(radius)
  const q = { x: 0, y: 0, z: 0 }
  const cols = new Map()
  const column = (x, z) => {
    const key = (x >> 4) * 131072 + (z >> 4)
    let col = cols.get(key)
    if (col === undefined) { col = bot.world.getColumn(x >> 4, z >> 4) || null; cols.set(key, col) }
    return col
  }
  const hits = []
  const top = Math.min(maxY, c.y + up)
  const bottom = Math.max(minY, c.y - down)
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const h2 = dx * dx + dz * dz
      if (h2 > r * r) continue
      const x = c.x + dx; const z = c.z + dz
      const col = column(x, z)
      if (!col) continue
      q.x = x & 15; q.z = z & 15
      for (let y = top; y >= bottom; y--) {
        q.y = y
        const s = col.getBlockStateId(q)
        if (airIds.has(s)) continue
        if (s === lavaSrc) hits.push({ x, y, z, d2: h2 + (y - c.y) * (y - c.y) })
        break
      }
    }
  }
  hits.sort((a, b) => a.d2 - b.d2)
  const out = []
  let cast = 0
  // Одно тело — много клеток: луч в каждую не нужен, хватит первой видимой из тела (тело считает lavaBody).
  const taken = []
  for (const h of hits) {
    if (taken.some(t => Math.abs(t.x - h.x) <= 6 && Math.abs(t.z - h.z) <= 6 && Math.abs(t.y - h.y) <= 3)) continue
    if (cast++ >= rays) break
    const b = bot.blockAt(new Vec3(h.x, h.y, h.z))
    if (!b || !(seesTop(bot, b) || seesBlock(bot, b))) continue
    out.push(b)
    taken.push(h)
  }
  return { blocks: out, candidates: hits.length, rays: cast, sample: hits.slice(0, 4).map(h => [h.x, h.y, h.z]) }
}

// Что видно отсюда. radius — сфера взгляда (лава светится, озеро видно издалека, если чанк прогружен);
// rays — потолок лучей на вызов (visibleOf). Возвращает площадки, лучшие первыми.
function terrainView (bot) {
  const eyes: typeof import('./perception/eyes') = require('./perception/eyes')
  const me = bot.entity.position
  const points = new Map(), sources = new Map(), horizon = [], signature = []
  let occluderTop = me.y
  for (let yaw = 0; yaw < 360; yaw += 22.5) {
    for (const pitch of [-20, 0, 20, 55]) {
      const hit = eyes.surface(bot, { yaw, pitch, maxDist: 128 })
      if (pitch === 0) horizon.push(hit ? hit.dist : 128)
      if (!hit) continue
      signature.push([yaw, pitch, hit.name, hit.pos])
      if (hit.name === 'lava') {
        const b = bot.blockAt(new Vec3(hit.pos.x, hit.pos.y, hit.pos.z))
        if (isLavaSrc(b)) sources.set(JSON.stringify(hit.pos), { at: hit.pos })
        continue
      }
      occluderTop = Math.max(occluderTop, hit.pos.y + 1)
      if (Math.abs(hit.pos.y + 1 - me.y) < 4 || /lava|leaves|log/.test(hit.name)) continue
      const at = { x: hit.pos.x + 0.5, y: hit.pos.y + 1, z: hit.pos.z + 0.5 }
      points.set(`${at.x},${at.y},${at.z}`, { at, water: hit.water })
    }
  }
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))(bot.registry)
  const items = bot.inventory?.items?.() || []
  const picks = items.filter(i => /_pickaxe$/.test(i.name))
  const seconds = name => Math.min(...(picks.length ? picks : [{ type: null }]).map(i =>
    Block.fromStateId(bot.registry.blocksByName[name].defaultState, undefined).digTime(i.type, false, false, false) / 1000))
  horizon.sort((a, b) => a - b)
  return { horizon: horizon[Math.floor(horizon.length / 2)], occluderTop, points: [...points.values()], sources: [...sources.values()],
    stoneSeconds: seconds('stone'), deepslateSeconds: seconds('deepslate'), signature: JSON.stringify(signature),
    tools: JSON.stringify(items.filter(i => /_pickaxe$|_log$|_planks$|^(stick|cobblestone|dirt)$/.test(i.name)).map(i => [i.name, i.count, i.durabilityUsed])) }
}

function survey (bot, { radius = 128, rays = 3000, need = NEED, terrain = false }: any = {}) {
  const t0 = gameClock.wall.now()
  const reg = bot.registry
  const me = bot.entity.position.floored()
  // Сначала лава под небом (дальний взгляд), потом ближняя любая (пещера, овраг — сфера 40).
  const sky = skyLava(bot, radius, { rays: Math.round(rays / 2) })
  const near = visibleOf(bot, [reg.blocksByName.lava.id], Math.min(40, radius), { max: 200, rays: Math.round(rays / 2) }).filter(isLavaSrc)
  const lavaSeen = [...sky.blocks, ...near]
  const seen = new Set()
  const sites = []
  for (const b of lavaSeen) {
    const p = b.position
    if (seen.has(`${p.x},${p.y},${p.z}`)) continue
    const body = lavaBody(bot, p, seen)
    const at = p
    const sky = skyAbove(bot, at)
    const rp = rpNear(bot, at)
    const kind = rp.rp ? 'rp' : sky ? 'surface' : 'cave'
    const site: any = {
      kind,
      at: xyz(at),
      open: body.open,
      all: body.all,
      y: [body.minY, body.maxY],
      dist: Math.round(at.distanceTo(me)),
      water: waterNear(bot, at),
      biome: biomeAt(bot, at.offset(0, 1, 0)),
      usable: body.open >= need,
      ...(rp.rp ? { ruins: { obsidian: rp.obsidian, crying: rp.crying_obsidian, netherrack: rp.netherrack, magma: rp.magma_block } } : {})
    }
    site.est = estimate(me, site)
    sites.push(site)
  }
  // Руины без лавы (видно рамку): сундук — обсидиан ~0.9, огниво или заряд в 73 % (loot_table ruined_portal) —
  // для потока overworld (structures.js), здесь только отметка.
  const marks = visibleOf(bot, [reg.blocksByName.crying_obsidian.id, reg.blocksByName.obsidian.id], radius, { max: 24, rays: 600 })
  const ruins = []
  for (const m of marks) {
    if (ruins.some(r => Math.hypot(r.at.x - m.position.x, r.at.z - m.position.z) < 12)) continue
    const n = rpNear(bot, m.position, 6)
    if (!n.rp) continue
    ruins.push({ at: xyz(m.position), dist: Math.round(m.position.distanceTo(me)), obsidian: n.obsidian, crying: n.crying_obsidian, lavaSite: sites.some(s => s.kind === 'rp' && Math.hypot(s.at.x - m.position.x, s.at.z - m.position.z) < 12) })
  }
  const usable = sites.filter(s => s.usable).sort((a, b) => a.est - b.est)
  return {
    me: xyz(me),
    biome: biomeAt(bot, me),
    ms: gameClock.wall.now() - t0,
    seenSources: lavaSeen.length,
    skyCandidates: sky.candidates,
    skySample: sky.sample,
    best: usable[0] || null,
    sites: [...usable, ...sites.filter(s => !s.usable).sort((a, b) => a.dist - b.dist)].slice(0, 8),
    ruins: ruins.sort((a, b) => a.dist - b.dist).slice(0, 4),
    ...(terrain ? { terrain: terrainView(bot) } : {})
  }
}

// Порядок поиска для мозга и кампании (по скану сидов, 07-portal-techniques.md).
function searchOrder (biome) {
  const flat = biome && FLAT.test(biome)
  return [
    'руины портала с лавой и поверхностное озеро в поле зрения — сразу туда (survey: лава под небом в 128 бл.)',
    'не видно — столб обзора +10 своими блоками (или ближняя высота ≥ +6) и осмотреться ещё раз',
    flat ? 'разведка лучами по 64 бл. поверху, на конце каждого — столб (ровный биом: озёра на поверхности удаются чаще)' : 'разведка лучами по 64 бл. поверху, на конце каждого — столб; к ровным сухим биомам (пустыня, саванна)',
    'пещерная лава — только если уже в пещере или в овраге и её видно',
    'не нашёл со столба и за 2 луча (~1.5 мин) — вниз к y −55 (лава гарантирована, поток overworld ND_OW_DEEP)'
  ]
}

// ---------------------------------------------------------------- ход

// Ближняя высота: самый высокий столб в radius, куда можно встать (верх — твёрдый не лист, над ним два воздуха).
function lookoutSpot (bot, radius = 24) {
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      if (dx * dx + dz * dz > radius * radius) continue
      for (let y = me.y + 30; y >= me.y - 4; y--) {
        const p = new Vec3(me.x + dx, y, me.z + dz)
        const b = bot.blockAt(p)
        if (!b) break
        if (isAir(b)) continue
        if (b.boundingBox === 'block' && !/leaves|log|water|lava/.test(b.name) && isAir(bot.blockAt(p.offset(0, 1, 0))) && isAir(bot.blockAt(p.offset(0, 2, 0)))) {
          if (!best || y > best.y) best = { x: p.x, y: p.y + 1, z: p.z }
        }
        break
      }
    }
  }
  return best && best.y >= me.y + 4 ? best : null
}

async function walkNear (bot, ctl, at, range, ms) {
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(at.x, at.y, at.z, range)),
      new Promise<any>((resolve, reject) => gameClock.setTimeout(() => reject(new Error('не дошёл')), ms))
    ])
    return true
  } catch { try { bot.pathfinder.setGoal(null) } catch {} return false }
}

const SWEEP = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]

// Верх столба (первая сверху не-воздушная клетка) около высоты yRef; null — чанк не прогружен.
const WET = /water|kelp|seagrass|bubble_column|lily_pad/
function surfaceTop (bot, x, z, yRef) {
  for (let y = Math.round(yRef) + 40; y >= Math.round(yRef) - 40; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)))
    if (!b) return null
    if (isAir(b)) continue
    return b
  }
  return null
}

// Доля воды по прямой от from до to (n точек; непрогруженные не в счёт).
function wetShare (bot, from, to, n = 8) {
  let wet = 0; let seen = 0
  for (let k = 1; k <= n; k++) {
    const t = k / n
    const b = surfaceTop(bot, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, from.y)
    if (!b) continue
    seen++
    if (WET.test(b.name)) wet++
  }
  return seen ? wet / seen : 0
}

// Конец луча по направлению [dx, dz] от start: сушей. pn-pool 02.10 (сиды 5647…, 6162…, −4332…, −5289…): лучи вслепую
// уводили тело в океан, дальше каждый луч «не дошёл» и «в воде — без столба» (~25 с впустую). Конец в воде или путь по
// воде больше трети — короче (¾, ½), иначе направление пропустить. Непрогруженный конец — идти (вода не видна).
function legTarget (bot, start, dir, step, here = null) {
  for (const f of [1, 0.75, 0.5]) {
    const to = { x: start.x + dir[0] * step * f, y: start.y, z: start.z + dir[1] * step * f }
    const top = surfaceTop(bot, to.x, to.z, start.y)
    if (top && WET.test(top.name)) continue
    if (wetShare(bot, start, to) > 0.34) continue
    if (here && wetShare(bot, here, to) > 0.34) continue
    return to
  }
  return null
}

// Подсказка из скана копии этого же мира (AGENTS.md: «знание карты из копии этого же мира — разрешено»):
// farm/seeds/good-v2.json, поле sky — ближайшая годная лава, видимая сверху (озеро или руины на поверхности, ≥ 10
// источников), farm/portal-scan/pool-merge.js; сида нет в пуле — скан farm/portal-scan/results-pool/<сид>.json (скан
// копии любого мира, например server-run). Только место, куда идти: лава засчитывается, когда её увидел глаз.
// skyOfScan — одно правило для pool-merge.js и для подсказки: тела классов surface и rp с глубиной ≤ 3, ≥ 10
// источников; тело < 20 источников — штраф 40 м (открытых сверху может не хватить на 10 наливов).
function skyOfScan (r) {
  let sky = null
  for (const k of ['surface', 'rp']) {
    const e = r && r.byClass && r.byClass[k]
    if (!e) continue
    for (const c of [e.nearest10, e.fastest10]) {
      if (!c || c.depth > 3) continue
      const cost = c.near + (c.src < 20 ? 40 : 0)
      if (!sky || cost < sky.cost) sky = { d: c.near, cls: k, at: c.at, src: c.src, cost }
    }
  }
  if (sky) delete sky.cost
  return sky
}

// { scanned, hint }: scanned — сид есть в good-v2 со сканом или есть файл скана; hint — {x,y,z,kind,src,dist} или null.
function poolInfo (seed, { file = null, dir = null }: any = {}) {
  const none = { scanned: false, hint: null }
  if (seed === undefined || seed === null || seed === '') return none
  if (!(require('./perception/knowledge') as typeof import('./perception/knowledge')).allows('lava', 'portal-natural.poolInfo')) return none // S10: в rsg скан не читается
  const path: typeof import('path') = require('path'); const fs: typeof import('fs') = require('fs')
  const toHint = sky => sky && Array.isArray(sky.at) ? { x: sky.at[0], y: sky.at[1], z: sky.at[2], kind: sky.cls, src: sky.src, dist: sky.d } : null
  try {
    const f = file || path.join(REPO_ROOT, 'farm/seeds/good-v2.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const s = (j.seeds || []).find(x => String(x.seed) === String(seed))
    if (s && (s.sky !== undefined || (s.lava !== null && s.lava !== undefined))) return { scanned: true, hint: toHint(s.sky) }
  } catch {}
  try {
    const f = path.join(dir || path.join(REPO_ROOT, 'farm/portal-scan/results-pool'), `${seed}.json`)
    if (fs.existsSync(f)) return { scanned: true, hint: toHint(skyOfScan(JSON.parse(fs.readFileSync(f, 'utf8')))) }
  } catch {}
  return none
}
function hintFor (seed, file?: any) { return poolInfo(seed, { file }).hint }

// Клетка на берегу у открытого источника того же тела лавы: пол твёрдый, ноги и голова — пусто, без жидкости. С неё
// черпак cast.js достаёт лаву (refillLava ищет источники в досягаемости от глаз).
// Тело ищется от любого открытого источника в кубе r у места: сама клетка site.at к этому времени часто вычерпана
// (pn-hint 02.10, сид 2911374257081450067: рама 9/10, озеро 57 открытых, пять заходов «лава кончилась» — тело от
// вычерпанной клетки пустое, к берегу не шёл). Слой снега под ногами — можно стоять (снежная тайга).
function shoreSources (bot, at, { r = 12 }: any = {}) {
  const c = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  const seen = new Set()
  const out = []
  const free = b => !!b && !/lava|water/.test(b.name) && (b.boundingBox === 'empty' || b.name === 'snow')
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = c.offset(dx, dy, dz)
        if (seen.has(`${p.x},${p.y},${p.z}`)) continue
        if (!isLavaSrc(bot.blockAt(p)) || !isAir(bot.blockAt(p.offset(0, 1, 0)))) continue
        const body = lavaBody(bot, p, seen, 600)
        for (const o of body.openCells) {
          // Берег вровень с гладью или на клетку выше (край чаши: LakeFeature — гладь ниже рельефа).
          for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
            const n = o.offset(ox, oy, oz)
            const feet = bot.blockAt(n); const head = bot.blockAt(n.offset(0, 1, 0)); const floor = bot.blockAt(n.offset(0, -1, 0))
            if (!free(feet) || !head || head.boundingBox !== 'empty' || /lava|water/.test(head.name)) continue
            if (!floor || floor.boundingBox !== 'block') continue
            out.push({ src: o, stand: n })
          }
        }
      }
    }
  }
  return out
}

function edgeSpot (bot, at, opts?: any) {
  const me = bot.entity.position
  let best = null
  for (const x of shoreSources(bot, at, opts)) { const d = x.stand.distanceTo(me); if (!best || d < best.d) best = { at: x.stand, d } }
  return best && best.at
}

// Живые источники у берега для добора cast.js: refillLava ходит только к session.castPlan.lavaAt (12 источников,
// видимых при выборе места) и ±2 от них; когда они вычерпаны — «лава кончилась» при живом озере (pn-hint 02.10, сид
// 6162616963942616824: рама 4/10, 63 открытых источника, шесть заходов «к 231,68,349: дошёл, видно 0»; переход тела
// к берегу не помогал — cast.js сперва идёт к раме). Обновить список ближними к раме живыми источниками с берегом.
function refreshCastLava (session, at, ref?) {
  const bot = session.bot
  const plan = session.castPlan
  if (!plan) return 0
  const o = ref || bot.entity.position
  const seen = new Set()
  const live = []
  for (const x of shoreSources(bot, at).sort((a, b) => a.src.distanceTo(o) - b.src.distanceTo(o))) {
    const k = `${x.src.x},${x.src.y},${x.src.z}`
    if (seen.has(k)) continue
    seen.add(k)
    live.push(xyz(x.src))
    if (live.length >= 12) break
  }
  if (!live.length) return 0
  plan.lavaAt = live
  try { session.journal.patch(st => { const pl = st.places && st.places[(require('./cast') as typeof import('./cast')).PLACE]; if (pl) pl.lavaAt = live }) } catch {}
  return live.length
}

// Трава и слой снега на месте рамы: у них нет коллизии, и pick.js (shapesOf: только boundingBox 'block' и паутина)
// их не видит — cast.js digVisible бросает «блок не виден прицелом», рама встаёт на «не выкопано 2: … short_grass»
// и «луч к грани … упирается в …» (pn-hint 02.10: снежная тайга 2911…, саванна 6162… — заходы по 0 с). Прицел
// клиента упирается в их контур (у травы 2..14 × 0..13/16, у снега — высота слоя): снять их самому, если луч из глаз к
// контуру не проходит через чужую коллизию раньше. Клетки — из trace/stopped литья.
const SOFT_PLANT = /^(short_grass|tall_grass|fern|large_fern|snow|dead_bush|bush|short_dry_grass|tall_dry_grass|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_petals|leaf_litter|sweet_berry_bush|firefly_bush|sunflower|lilac|rose_bush|peony)$/
function softCells (cast) {
  const out = []
  const text = [...(Array.isArray(cast && cast.trace) ? cast.trace.filter(t => /не выкопано/.test(t)) : []), String((cast && cast.stopped) || '')].join('; ')
  for (const m of text.matchAll(/(-?\d+),(-?\d+),(-?\d+)/g)) out.push(new Vec3(Number(m[1]), Number(m[2]), Number(m[3])))
  return out
}
async function clearSoft (bot, ctl, cells) {
  const { blockOnRay, eyeOf }: typeof import('./pick') = require('./pick')
  let n = 0
  const done = new Set()
  for (const p of cells) {
    const key = `${p.x},${p.y},${p.z}`
    if (done.has(key) || ctl.aborted) continue
    done.add(key)
    const b = bot.blockAt(p)
    if (!b || !SOFT_PLANT.test(b.name)) continue
    let h = 13 / 16
    if (b.name === 'snow') { try { h = Number(b.getProperties().layers || 1) * 2 / 16 } catch { h = 2 / 16 } }
    const aimP = p.offset(0.5, Math.max(0.06, h / 2), 0.5)
    if (eyeOf(bot).distanceTo(aimP) > 4.3) await walkNear(bot, ctl, p, 2, 8000)
    const o = eyeOf(bot)
    const delta = aimP.minus(o)
    const len = delta.norm()
    if (len > 4.5) continue
    const hit = blockOnRay(bot, o, delta.scaled(1 / len), len)
    if (hit && !hit.pos.equals(p)) continue // чужая коллизия раньше контура — не видно
    try { await bot.lookAt(aimP, true); await bot.dig(b, 'ignore'); n++ } catch {}
  }
  return n
}

// Столб обзора: озеро лавы — чаша на 4 ниже рельефа (LakeFeature), руины — вровень с землёй; с земли их закрывает
// первый же бугор (смоук pn-smoke2: озеро в 27 бл. за подъёмом в 4 бл. от глаз не видно, руины видно только с 25 бл.).
// С высоты +10 взгляд идёт поверх рельефа до края прорисовки. Встать на столб своими блоками (build.towerUp),
// осмотреться, спуститься, копая свой столб (свои блоки вернутся в рюкзак).
// Верх кроны рядом (листва и стволы в радиусе r): столб должен поднять глаза над ней.
function canopyTop (bot, r = 6) {
  const me = bot.entity.position.floored()
  let top = me.y
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let y = me.y + 24; y > top; y--) {
        const b = bot.blockAt(new Vec3(me.x + dx, y, me.z + dz))
        if (b && /leaves|_log$/.test(b.name)) { top = y; break }
      }
    }
  }
  return top
}

async function pillarLook (session, ctl, { height = 10, radius = 128 }: any = {}) {
  const bot = session.bot
  const { towerUp }: typeof import('./build') = require('./build')
  const { equipBestTool }: typeof import('./items') = require('./items')
  const y0 = bot.entity.position.floored().y
  // В лесу — выше кроны (глаза на +1.6 над её верхом), но не больше 20.
  height = Math.min(20, Math.max(height, canopyTop(bot) - y0 + 1))
  // В воде столб не растёт («не подпрыгнул» десять раз — pn-rand, берег океана): только осмотр.
  const feetB = bot.blockAt(bot.entity.position.floored())
  if (feetB && /water|lava/.test(feetB.name)) return { placed: 0, why: 'в воде — без столба', survey: survey(bot, { radius }) }
  const t = await towerUp(bot, ctl, height, { sneak: true })
  const s = survey(bot, { radius })
  // Вниз: копать блок под ногами, пока не на прежней высоте.
  for (let k = 0; k < height + 2 && !ctl.aborted; k++) {
    const feet = bot.entity.position.floored()
    if (feet.y <= y0) break
    const under = bot.blockAt(feet.offset(0, -1, 0))
    if (!under || under.boundingBox !== 'block') { await sleep(250); continue }
    try { await equipBestTool(bot, under); await bot.dig(under, true) } catch { break }
    await sleep(350)
  }
  return { placed: t.placed || 0, why: t.why || t.reason || null, survey: s }
}

async function run (session, ctl, p: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const secs = Math.max(60, Math.min(900, p.timeoutSeconds ?? 600))
  const deadline = t0 + secs * 1000 - 5000
  const late = () => gameClock.now() > deadline || ctl.aborted
  const steps = []
  const mark = (what, extra: any = {}) => steps.push({ s: Math.round((gameClock.now() - t0) / 100) / 10, what, ...extra })
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })

  const R = p.radius ?? 128
  const pillar = p.pillar ?? 10
  // Точка обзора: сначала естественная высота (≥ +8 в 24 бл. — глаза почти как на столбе) — дойти и осмотреться;
  // иначе (или не дошёл) — столб 10 своими блоками, обзор 128, спуск с копкой столба.
  let lastLook = null
  const lookout = async (tag) => {
    lastLook = null
    if (inWater(bot)) await escapeWater(bot, ctl).catch(() => null)
    const spot = lookoutSpot(bot)
    if (spot && spot.y >= bot.entity.position.y + Math.min(8, pillar || 8)) {
      const ok = await walkNear(bot, ctl, spot, 1, 20000)
      if (ok || !pillar) {
        const s2 = survey(bot, { radius: R })
        mark(`${tag}: высота`, { ok, at: spot, seen: s2.seenSources, best: s2.best && s2.best.kind })
        lastLook = 'высота'
        return s2
      }
    }
    if (!pillar) return survey(bot, { radius: R })
    const l = await pillarLook(session, ctl, { height: pillar, radius: R })
    mark(`${tag}: столб`, { placed: l.placed, why: l.why, seen: l.survey.seenSources, best: l.survey.best && l.survey.best.kind })
    lastLook = 'столб'
    return l.survey
  }
  let s = survey(bot, { radius: R })
  mark('осмотр', { seen: s.seenSources, best: s.best && s.best.kind })
  const start = bot.entity.position.clone()
  // Подсказка из скана копии мира (hint {x,y,z} или seed → hintFor): сразу к месту видимой лавы, там осмотр, обход и
  // точка обзора. Не увидел — лучи от старта (их число — legs; кампания с подсказкой зовёт legs: 0 и идёт вниз).
  const hint = p.hint || hintFor(p.seed)
  if (!s.best && hint && !late()) {
    // Отрезками по 64: путь в 245 м одним goto — «Took to long to decide path to goal!» на 25-й с (pn-hint 02.10, сид
    // 6162616963942616824), и дальше всё шло от места в 200 м от подсказки. Два отказа подряд — стоп.
    const hd = () => Math.hypot(hint.x - bot.entity.position.x, hint.z - bot.entity.position.z)
    let fails = 0; let legsTo = 0
    while (hd() > 16 && fails < 2 && !late()) {
      const d = hd(); const k = Math.min(1, 64 / d)
      const tx = bot.entity.position.x + (hint.x - bot.entity.position.x) * k
      const tz = bot.entity.position.z + (hint.z - bot.entity.position.z) * k
      const r = await travelXZ(bot, ctl, tx, tz, { range: k < 1 ? 6 : 12, retries: 1, deadline: Math.min(deadline, gameClock.now() + 45000) })
      legsTo++
      fails = r.ok ? 0 : fails + 1
      if (k >= 1 && r.ok) break
    }
    mark('к подсказке', { ok: hd() <= 24, legs: legsTo, hint, me: xyz(bot.entity.position.floored()) })
    // Гладь выше или ниже глаз на 4+ (pn-hint 02.10, сид −1438498926029987630: озеро на плато y 91, тело внизу на 72 в
    // 11 м — снизу глади не видно): подняться/спуститься к ней с копкой, как goto.
    const dy = hint.y - bot.entity.position.y
    if ((dy > 3 || dy < -6) && hd() <= 24 && !late()) {
      const ok = await walkNear(bot, ctl, { x: hint.x, y: hint.y + 1, z: hint.z }, 6, Math.min(60000, Math.max(5000, deadline - gameClock.now())))
      mark('к подсказке по высоте', { ok, dy: Math.round(dy), me: xyz(bot.entity.position.floored()) })
    }
    s = survey(bot, { radius: R })
    mark('осмотр у подсказки', { seen: s.seenSources, best: s.best && s.best.kind })
    // Не видно с подхода — обойти место по кругу в 8 бл. на уровне глади (край чаши с другой стороны), потом точка
    // обзора. pn-hint 02.10, сид −1438498926029987630: озеро на плато, с подхода и с горы рядом (+14) — 0 источников.
    for (const [ox, oz] of [[8, 0], [0, 8], [-8, 0], [0, -8]]) {
      if (s.best || late() || hd() > 32) break
      const to = { x: hint.x + ox, y: hint.y + 1, z: hint.z + oz }
      const ok = await walkNear(bot, ctl, to, 2, Math.min(25000, Math.max(3000, deadline - gameClock.now())))
      s = survey(bot, { radius: R })
      mark('обход подсказки', { ok, to, seen: s.seenSources, best: s.best && s.best.kind })
    }
    if (!s.best && p.lookout !== false && !late()) s = await lookout('подсказка')
    // Высота рядом не показала — ещё столб: лава здесь известна, 20 с того стоят.
    if (!s.best && pillar && lastLook === 'высота' && p.lookout !== false && !late()) {
      const l = await pillarLook(session, ctl, { height: pillar, radius: R })
      mark('подсказка: столб', { placed: l.placed, why: l.why, seen: l.survey.seenSources, best: l.survey.best && l.survey.best.kind })
      s = l.survey
    }
  }
  if (!s.best && p.lookout !== false && !late() && !hint) s = await lookout('старт')
  // Разведка лучами поверху: без копки и без лесов, как actions.explore.
  // По умолчанию 2 луча (~1.5 мин со столбами): находки были со столба на старте и после первого луча, а путь вниз к
  // −55 гарантирован (07 §8, бюджет поиска поверху).
  const legs = Math.max(0, Math.min(16, p.legs ?? 2))
  // Точки лучей — от места старта, не от текущего: от текущего восемь отрезков E, S, W, N… водили тело квадратом
  // вокруг старта (pn-pool 02.10: четвёртый луч вернулся на спавн). Здесь — восемь направлений на 64, потом на 128.
  // Конец луча — сушей (legTarget): в воду не идти; направление без суши пропускается и луча не стоит.
  for (let i = 0, k = 0; !s.best && i < legs && k < SWEEP.length * 2 && !late(); k++) {
    const [dx, dz] = SWEEP[k % SWEEP.length]
    const spread = 1 + Math.floor(k / SWEEP.length)
    const step = p.stepDistance ?? 64
    const to = legTarget(bot, start, [dx, dz], step * spread, bot.entity.position)
    if (!to) { mark(`луч ${dx},${dz}: вода — мимо`); continue }
    i++
    const mv = bot.pathfinder.movements
    const dug = mv ? mv.canDig : undefined
    const scaffold = mv ? mv.scafoldingBlocks : undefined
    if (mv) { mv.canDig = false; mv.scafoldingBlocks = [] }
    session.surfaceWalk = true
    let r
    try {
      r = await travelXZ(bot, ctl, to.x, to.z, { range: 6, retries: 1, deadline: Math.min(deadline, gameClock.now() + 45000) })
    } finally {
      session.surfaceWalk = false
      if (mv) { mv.canDig = dug; mv.scafoldingBlocks = scaffold }
    }
    s = survey(bot, { radius: R })
    mark(`луч ${dx},${dz}`, { ok: r.ok, to: xyz(new Vec3(to.x, to.y, to.z).floored()), seen: s.seenSources, best: s.best && s.best.kind })
    if (!s.best && p.lookout !== false && !late()) s = await lookout(`луч ${dx},${dz}`)
  }
  if (!s.best) {
    return { found: false, hintUsed: hint || null, seconds: Math.round((gameClock.now() - t0) / 1000), steps, order: searchOrder(s.biome), last: s.sites.slice(0, 3), ruins: s.ruins, stopped: 'годной лавы не видно — дальше путь вниз (ND_OW_DEEP) или разведка' }
  }
  const site = s.best
  const found = { kind: site.kind, at: site.at, open: site.open, dist: site.dist, est: site.est, water: site.water, biome: site.biome, ruins: site.ruins }
  mark('выбрал', found)
  // Подойти на сушу в 6–10 бл. от источника: cast.js ищет место рамы в radius 9 от тела, лава — не ближе 5 и не
  // дальше 18 от рамы. Не вышло с одной стороны — с другой.
  // Далеко — сперва поверху отрезком (travelXZ: страж застревания), потом точный подход.
  if (Math.hypot(site.at.x - bot.entity.position.x, site.at.z - bot.entity.position.z) > 24 && !late()) {
    const r = await travelXZ(bot, ctl, site.at.x, site.at.z, { range: 10, retries: 2, deadline: Math.min(deadline, gameClock.now() + 120000) })
    mark('к лаве поверху', { ok: r.ok, error: r.error, me: xyz(bot.entity.position.floored()) })
  }
  // Литьё — как этап cast кампании, заходами. «Места под раму нет» — к следующей стороне озера; «не вижу лавы» —
  // снова к лаве; остальное (лава кончилась, клетка не вышла, время) — тот же заход ещё раз: cast.js продолжает
  // начатую раму (план в памяти). Смоук pn-rand 02.10: «лава кончилась: зачерпнуть не вышло» на 5/10, а baseline со
  // второго захода дожал до горящего.
  const tries = [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]
  let side = 0
  let cast = null
  let approach = true
  let stall = 0
  let dry = 0
  let noProg = 0
  let lastFrame = -1
  // Заходов — до 30: предел ставят время (deadline) и стороны (tries; без прироста — к следующей, кончились — стоп).
  // pn-hint 02.10: −1438… — восемь заходов кончились на 304-й с из 570, 8388… (мангры) — двенадцать на 126-й с.
  for (let attempt = 0; attempt < 30 && !late(); attempt++) {
    if (approach) {
      const [ox, oz] = tries[Math.min(side, tries.length - 1)]
      const goal = { x: site.at.x + ox, y: site.at.y + 1, z: site.at.z + oz }
      const ok = await walkNear(bot, ctl, goal, ox || oz ? 3 : 7, Math.min(90000, Math.max(5000, deadline - gameClock.now())))
      mark('подошёл', { ok, to: goal, me: xyz(bot.entity.position.floored()) })
    }
    const left = Math.round((deadline - gameClock.now()) / 1000)
    if (left < 45) break
    const t1 = gameClock.now()
    const castMod: typeof import('./cast') = require('./cast')
    cast = await castMod.castPortal(session, ctl, { timeoutSeconds: Math.min(540, left), radius: 9 })
    mark('литьё', { built: cast.built, frame: cast.frame, stopped: cast.stopped, refills: cast.refills, trace: Array.isArray(cast.trace) ? cast.trace.slice(-6) : undefined, buckets: ['bucket', 'water_bucket', 'lava_bucket'].map(n => bot.inventory.items().filter(i => i.name === n).reduce((a, i) => a + i.count, 0)).join('/') })
    if (cast.built) break
    const why = cast.stopped || ''
    if (cast.need) break // нет вёдер или блоков — не здесь лечить
    // Пустая рама и отказ за секунды («не встал на …» пять раз за 1.5 с — pn-rand 02.10, сид 4307605278284484928):
    // место негодно для тела — забыть план (он и в журнале мира) и зайти с другой стороны озера.
    const empty = /^0\/10/.test(cast.frame || '0/10')
    const frameN = Number((/^(\d+)\//.exec(cast.frame || '') || [])[1] || 0)
    const fast = gameClock.now() - t1 < 5000
    // Трава или снег не дали выкопать место или налить — снять и тот же заход ещё раз.
    if (!/лава кончилась|места под раму/.test(why)) {
      const soft = softCells(cast)
      const n = soft.length && !late() ? await clearSoft(bot, ctl, soft) : 0
      if (n) { mark('трава/снег', { n }); approach = false; lastFrame = frameN; continue }
    }
    // Без прироста рамы и за секунды второй раз подряд — место негодно (не только при пустой раме: pn-hint 6162…,
    // 1/10 и четыре захода за 0 с) — к другой стороне.
    stall = fast && frameN <= lastFrame ? stall + 1 : 0
    noProg = frameN <= lastFrame ? noProg + 1 : 0 // четыре захода подряд без прироста рамы — тоже к другой стороне
    // «Лава кончилась» без единого черпака дважды подряд и после обновления плана живой лавой — с этой стороны черпак
    // не достаёт (pn-hint 02.10, сид 8388397891651367710, мангры: рама 1/10, восемь заходов «видно 0») — к другой.
    dry = /лава кончилась/.test(why) && !cast.refills ? dry + 1 : 0
    lastFrame = Math.max(lastFrame, frameN)
    if (/места под раму/.test(why) || (empty && fast) || stall >= 2 || dry >= 3 || noProg >= 4) {
      stall = 0; dry = 0; noProg = 0
      side++
      if (side >= tries.length) break
      session.castPlan = null
      try { session.journal.patch(st => { if (st.places) delete st.places[castMod.PLACE] }) } catch {}
      approach = true
      continue
    }
    approach = /не вижу лавы/.test(why)
    // Лава «кончилась» при живом озере (pn3-rand, сид 4307605278284484928: 74 открытых источника, рама 4/10, шесть
    // заходов подряд refills 0) — встать на берег у открытого источника и лить дальше.
    if (/лава кончилась/.test(why) && !late()) {
      const ref = cast.site && cast.site.origin ? new Vec3(cast.site.origin.x, cast.site.origin.y, cast.site.origin.z) : null
      const n = refreshCastLava(session, site.at, ref)
      mark('живая лава в план', { n })
      if (!n) { const e = edgeSpot(bot, site.at); if (e) { const ok = await walkNear(bot, ctl, e, 0, 20000); mark('к берегу', { ok, to: xyz(e) }) } }
    }
  }
  let light = null
  if (cast && cast.built && !ctl.aborted) {
    light = await (require('./nether') as typeof import('./nether')).portal(session, ctl, { mode: 'build', timeoutSeconds: 60 })
    mark('поджиг', { lit: !!(light && light.lit) })
  }
  return {
    found: true,
    hintUsed: hint || null,
    site: found,
    built: !!(cast && cast.built),
    lit: !!(light && light.lit),
    seconds: Math.round((gameClock.now() - t0) / 1000),
    cast: cast ? { frame: cast.frame, refills: cast.refills, placed: cast.placed, dug: cast.dug, stopped: cast.stopped, site: cast.site } : null,
    steps
  }
}

// RPC portal_natural: mode survey (по умолчанию, только чтение) | order | run (ND_PORTAL_NATURAL=1).
function rpc (session, p: any = {}) {
  const mode = String(p.mode || 'survey')
  if (mode === 'survey') return session.immediate(async () => survey(session.require(), p))
  // Отладка луча: во что упирается взгляд к верхней грани клетки at.
  if (mode === 'ray') {
    return session.immediate(async () => {
      const bot = session.require()
      const p0 = new Vec3(p.at.x, p.at.y, p.at.z)
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
      const t = p0.offset(0.5, 0.85, 0.5)
      const delta = t.minus(eye)
      const dist = delta.norm()
      const hit = bot.world.raycast(eye, delta.clone().normalize(), dist + 0.3, (b, iter) => {
        if (b.position.equals(p0)) return true
        return !!(b.shapes && b.shapes.length && iter.intersect(b.shapes, b.position))
      })
      const path = []
      const dir = delta.clone().normalize()
      for (let k = 0; k <= Math.ceil(dist * 4); k++) {
        const q = eye.plus(dir.scaled(k / 4)).floored()
        const b = bot.blockAt(q)
        const last = path[path.length - 1]
        if (!last || last[0] !== `${q.x},${q.y},${q.z}`) path.push([`${q.x},${q.y},${q.z}`, b ? b.name : null, b && b.shapes ? b.shapes.length : -1])
      }
      return { eye: xyz(eye), target: xyz(p0), hit: hit ? { at: xyz(hit.position), name: hit.name } : null, block: (bot.blockAt(p0) || {}).name, path: path.filter(x => x[1] !== 'air').slice(0, 12) }
    })
  }
  if (mode === 'order') return session.immediate(async () => ({ order: searchOrder(biomeAt(session.require(), session.require().entity.position.floored())) }))
  if (mode === 'run') {
    if (!ON()) return Promise.resolve({ status: 'failed', error: 'portal_natural run — под флагом ND_PORTAL_NATURAL=1 (по умолчанию выкл.)' })
    return session.runIntent('portal', ctl => {
      session.require()
      session.updateMovements()
      return run(session, ctl, p)
    }, {
      timeoutMs: (Math.min(900, p.timeoutSeconds ?? 600) + 90) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }
  return Promise.resolve({ status: 'failed', error: `mode: survey | order | run, не ${mode}` })
}

module.exports = { survey, terrainView, searchOrder, run, rpc, lavaBody, skyAbove, rpNear, estimate, lookoutSpot, edgeSpot, shoreSources, refreshCastLava, softCells, legTarget, wetShare, hintFor, poolInfo, skyOfScan, NEED }
export {
  survey, terrainView, searchOrder, run, rpc, lavaBody, skyAbove, rpNear, estimate, lookoutSpot, edgeSpot,
  shoreSources, refreshCastLava, softCells, legTarget, wetShare, hintFor, poolInfo, skyOfScan, NEED
}
