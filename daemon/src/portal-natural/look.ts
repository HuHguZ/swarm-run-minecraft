'use strict'
// Природная лава для портала (portal-natural.ts): что видно — лава с открытым верхом, руины, вода, биом, обзор местности.
import { Vec3 } from 'vec3'
import { seesBlock, visibleOf } from '../sight'
import * as gameClock from '../game-clock'
import { xyz } from '../movement'


export const ON = () => process.env.ND_PORTAL_NATURAL === '1'
// Источников с открытым верхом на раму: cast.js льёт 10 клеток, по ведру на клетку, плюс промахи.
export const NEED = 12
const RP_MARK = /^(obsidian|crying_obsidian|netherrack|magma_block|gold_block)$/
// Где с поверхности чаще годная лава — по скану (07, «биомы»); ровный рельеф = больше удачных озёр (LakeFeature:
// граница чаши ниже уровня жидкости должна быть твёрдой, выше — без жидкости).
const FLAT = /plains|savanna|desert|badlands|meadow|snowy_plains|beach/

export const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
function levelOf (b) {
  try { const p = b.getProperties(); if (p && p.level !== undefined) return Number(p.level) } catch {}
  return typeof b.metadata === 'number' ? b.metadata : null
}
export const isLavaSrc = b => !!b && b.name === 'lava' && levelOf(b) === 0

// Над клеткой до неба — ничего непрозрачного (листва, стекло не в счёт как «крыша»? в счёт: луч сверху их не
// пройдёт). Незагруженный верх считаем небом: выше прогруженного мира блоков нет.
export function skyAbove (bot, p, maxUp = 80) {
  for (let dy = 1; dy <= maxUp; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (!b) return true
    if (!isAir(b)) return false
  }
  return true
}

// Тело лавы от видимого источника: связность по лаве (6 соседей), до limit клеток. open — источники с воздухом
// сверху (видны сверху тем же взглядом), all — все источники тела (для справки).
export function lavaBody (bot, start, seen, limit = 900) {
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
export function rpNear (bot, c, r = 7) {
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

export function biomeAt (bot, p) {
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
export function estimate (me, site) {
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
export function terrainView (bot) {
  const eyes: typeof import('../perception/eyes') = require('../perception/eyes')
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

export function survey (bot, { radius = 128, rays = 3000, need = NEED, terrain = false }: any = {}) {
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
export function searchOrder (biome) {
  const flat = biome && FLAT.test(biome)
  return [
    'руины портала с лавой и поверхностное озеро в поле зрения — сразу туда (survey: лава под небом в 128 бл.)',
    'не видно — столб обзора +10 своими блоками (или ближняя высота ≥ +6) и осмотреться ещё раз',
    flat ? 'разведка лучами по 64 бл. поверху, на конце каждого — столб (ровный биом: озёра на поверхности удаются чаще)' : 'разведка лучами по 64 бл. поверху, на конце каждого — столб; к ровным сухим биомам (пустыня, саванна)',
    'пещерная лава — только если уже в пещере или в овраге и её видно',
    'не нашёл со столба и за 2 луча (~1.5 мин) — вниз к y −55 (лава гарантирована, поток overworld ND_OW_DEEP)'
  ]
}
