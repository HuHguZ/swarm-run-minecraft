'use strict'
// Глаза и память увиденного (S10, 07.10; AGENTS.md «Что бот знает о мире — как игрок на случайном сиде»).
//
// Блок увиден, если луч из глаз в пределах прорисовки (загруженные столбцы, радиус radius) первым входит в его клетку
// (как sight.visibleOf/pick.blockSeen, но по номерам состояний — без Block на каждую клетку). Увиденное помнится
// (память по измерениям), пока клетку не сменит blockUpdate — тогда забыто и может быть увидено заново. Руда в толще,
// сундук за стеной, лава под полом — не видны: у клетки нет открытой грани или луч упёрся раньше.
//
// Обход — понемногу: раз в everyTicks игровых тиков (по физике тела) — кандидаты (клетки типов WATCH с открытой гранью
// из кеша секций: палитра секции говорит, есть ли там цель) ближние первыми, лучей не больше rays и не дольше maxMs
// реального времени. Под пошаговой фермой (--lockstep) мир ждёт тело — расход слоя = замедление мира, поэтому бюджет
// и замер (stats: доля CPU процесса) — часть слоя.
//
// Луч: клетка непрозрачна, если у неё коробка 'block' (полная или часть: плита, забор, листва — с запасом в сторону
// «не видно») или это лава; вода, воздух, трава, стекло, решётки, паутина — прозрачны. Незагруженный столбец — конец
// луча (не знаем — не видим). Отключить слой: ND_EYES=0. Бюджет: ND_EYES_EVERY (тиков), ND_EYES_RAYS, ND_EYES_MS, ND_EYES_R.
const Vec3 = require('vec3')
const gameClock = require('../game-clock')

const SEE_THROUGH = /glass|_pane$|^barrier$|^iron_bars$|^cobweb$|^light$/
// Что запоминать (видимое, с открытой гранью). По измерениям — в Аду лава повсюду, её не копим.
const WATCH: Record<string, RegExp> = {
  overworld: /_log$|_stem$|_ore$|^(gravel|lava|obsidian|crying_obsidian|chest|trapped_chest|barrel|spawner|nether_portal|end_portal_frame|crafting_table|furnace|hay_block|bell|iron_block|sand|clay|pumpkin|melon|sugar_cane)$|_bed$/,
  the_nether: /_ore$|^(ancient_debris|gold_block|gilded_blackstone|chest|spawner|nether_portal|obsidian|crying_obsidian|warped_nylium|crimson_nylium|soul_sand|nether_wart|glowstone|magma_block)$/,
  the_end: /^(obsidian|chest|end_portal|end_gateway|end_rod|purpur_block|shulker_box|.*_shulker_box)$/
}
// Блок-сущности с отрисовщиком — их считает «пирог» F3 (perception/senses.pie): все, без зрения.
const PIE = /^(chest|trapped_chest|ender_chest|shulker_box|.*_shulker_box|spawner|trial_spawner|vault|.*_bed|.*_sign|.*_hanging_sign|.*_banner|.*_wall_banner|.*_head|.*_skull|.*_wall_head|.*_wall_skull|bell|lectern|enchanting_table|campfire|soul_campfire|conduit|beacon|end_portal|end_gateway|suspicious_sand|suspicious_gravel|decorated_pot|creaking_heart)$/
const CAND_MAX = 256 // кандидатов на обход (ближние секции первыми)
const PER_NAME = 400 // ponytail: потолок памяти на имя (дальние вытесняются), хватит для маршрута; больше — индекс по чанкам

const dimOf = bot => String((bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, '')
const env = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d }
const eyeOf = bot => { const p = bot.entity.position; return { x: p.x, y: p.y + (bot.entity.eyeHeight || 1.62), z: p.z } }
const keyOf = (x, y, z) => `${x},${y},${z}`
const nowMs = () => { const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6 }

// Чтение номеров состояний по столбцам: -1 — столбец не загружен (или ниже мира), 0 — выше мира (небо).
function reader (bot) {
  const cols = new Map()
  const minY = bot.game.minY
  const maxY = minY + bot.game.height - 1
  const q = { x: 0, y: 0, z: 0 }
  const column = (cx, cz) => {
    const k = cx * 4194304 + cz
    let c = cols.get(k)
    if (c === undefined) { c = (bot.world.getColumn && bot.world.getColumn(cx, cz)) || null; cols.set(k, c) }
    return c
  }
  const at = (x, y, z) => {
    if (y > maxY) return 0
    if (y < minY) return -1
    const c = column(x >> 4, z >> 4)
    if (!c) return -1
    q.x = x & 15; q.y = y; q.z = z & 15
    return c.getBlockStateId(q)
  }
  return { at, column, minY, maxY }
}

// Свойства состояния для луча и для кандидатов: 1 — непрозрачно, 0 — прозрачно; open — без коробки (воздух, вода…).
function shapeCache (registry) {
  const opaque = new Map(); const open = new Map(); const name = new Map()
  const def = s => registry.blocksByStateId[s]
  return {
    opaque (s) {
      let v = opaque.get(s)
      if (v === undefined) { const b = def(s); v = !!b && (b.name === 'lava' || (b.boundingBox === 'block' && !SEE_THROUGH.test(b.name))); opaque.set(s, v) }
      return v
    },
    open (s) {
      if (s < 0) return false
      let v = open.get(s)
      if (v === undefined) { const b = def(s); v = !b || b.boundingBox === 'empty' || SEE_THROUGH.test(b.name); open.set(s, v) }
      return v
    },
    name (s) {
      let v = name.get(s)
      if (v === undefined) { const b = def(s); v = b ? b.name : ''; name.set(s, v) }
      return v
    }
  }
}

// Доходит ли луч от o до точки t (клетка цели cx,cy,cz — входит первой; без цели — до точки без препятствий).
// Клетка глаз не считается (голова в листве/паутине не слепит).
function ray (read, shapes, o, t, cell = null) {
  const dx = t.x - o.x; const dy = t.y - o.y; const dz = t.z - o.z
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (len < 1e-6) return true
  const ux = dx / len; const uy = dy / len; const uz = dz / len
  let x = Math.floor(o.x); let y = Math.floor(o.y); let z = Math.floor(o.z)
  const sx = ux > 0 ? 1 : -1; const sy = uy > 0 ? 1 : -1; const sz = uz > 0 ? 1 : -1
  const inv = v => Math.abs(v) < 1e-12 ? Infinity : Math.abs(1 / v)
  const ddx = inv(ux); const ddy = inv(uy); const ddz = inv(uz)
  let tx = Math.abs(ux) < 1e-12 ? Infinity : ((sx > 0 ? x + 1 : x) - o.x) / ux
  let ty = Math.abs(uy) < 1e-12 ? Infinity : ((sy > 0 ? y + 1 : y) - o.y) / uy
  let tz = Math.abs(uz) < 1e-12 ? Infinity : ((sz > 0 ? z + 1 : z) - o.z) / uz
  const ex = Math.floor(t.x); const ey = Math.floor(t.y); const ez = Math.floor(t.z)
  for (let i = 0; i < 4096; i++) {
    if (tx <= ty && tx <= tz) { if (tx > len) break; x += sx; tx += ddx } else if (ty <= tz) { if (ty > len) break; y += sy; ty += ddy } else { if (tz > len) break; z += sz; tz += ddz }
    if (cell && x === cell.x && y === cell.y && z === cell.z) return true
    const s = read.at(x, y, z)
    if (s < 0) return false
    if (shapes.opaque(s)) return false
  }
  // Луч дошёл до точки: для цели — она в клетке назначения (точка на грани), для точки без клетки — свободно.
  return cell ? (ex === cell.x && ey === cell.y && ez === cell.z) : true
}

// Видна ли клетка c из глаз o: луч к центру, затем к 4 точкам каждой обращённой к глазам грани.
const FACE_PTS = [[0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]
function seesCell (read, shapes, o, c, counter = null) {
  const n = () => { if (counter) counter.rays++ }
  n()
  if (ray(read, shapes, o, { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }, c)) return true
  for (const a of ['x', 'y', 'z']) {
    const lo = c[a]; const hi = c[a] + 1
    const plane = o[a] < lo ? lo + 1e-4 : o[a] > hi ? hi - 1e-4 : null
    if (plane === null) continue
    const [u, v] = a === 'x' ? ['y', 'z'] : a === 'y' ? ['x', 'z'] : ['x', 'y']
    // Соседняя клетка за этой гранью непрозрачна — грань закрыта, лучи к ней не нужны.
    const nb = { x: c.x, y: c.y, z: c.z }; nb[a] += o[a] < lo ? -1 : 1
    const ns = read.at(nb.x, nb.y, nb.z)
    if (ns < 0 || shapes.opaque(ns)) continue
    for (const [fu, fv] of FACE_PTS) {
      const p = { x: 0, y: 0, z: 0 }
      p[a] = plane; p[u] = c[u] + fu; p[v] = c[v] + fv
      n()
      if (ray(read, shapes, o, p, c)) return true
    }
  }
  return false
}

class Eyes {
  declare bot: any
  declare mem: Map<string, Map<string, any>> // измерение → клетка → запись
  declare cache: Map<string, any> // 'cx,cz,sy' → { data, cells }
  declare tried: Map<string, any>
  declare stats: any
  declare opts: any
  declare shapes: any
  declare ticks: number
  declare dim: string
  declare cpu0: any
  declare off: any[]
  declare want: Map<number, number>
  declare count: Map<string, number>

  constructor (bot, opts: any = {}) {
    this.bot = bot
    this.mem = new Map()
    this.cache = new Map()
    this.tried = new Map()
    this.opts = {
      every: opts.every ?? env('ND_EYES_EVERY', 10),
      rays: opts.rays ?? env('ND_EYES_RAYS', 48),
      maxMs: opts.maxMs ?? env('ND_EYES_MS', 1.0),
      radius: opts.radius ?? env('ND_EYES_R', 64)
    }
    this.stats = { sweeps: 0, rays: 0, sections: 0, seen: 0, forgot: 0, ms: 0, scanMs: 0, worstMs: 0 }
    this.shapes = bot.registry ? shapeCache(bot.registry) : null
    this.ticks = 0
    this.dim = null
    this.cpu0 = process.cpuUsage()
    this.off = []
    this.want = new Map()
    this.count = new Map()
  }

  // Смена измерения: кеш секций и «не видно отсюда» — заново (память увиденного — по измерениям, остаётся).
  syncDim () {
    const dim = dimOf(this.bot)
    if (dim !== this.dim) { this.dim = dim; this.cache.clear(); this.tried.clear(); this.want.clear(); this.count.clear() }
    return dim
  }

  // Битовая маска: 1 — запоминать (WATCH измерения), 2 — считает «пирог» (PIE); по номеру состояния, кешем.
  wantOf (s) {
    let w = this.want.get(s)
    if (w === undefined) {
      const nm = this.shapes.name(s)
      w = ((WATCH[this.dim] || WATCH.overworld).test(nm) ? 1 : 0) | (PIE.test(nm) ? 2 : 0)
      this.want.set(s, w)
    }
    return w
  }

  memory (dim = dimOf(this.bot)) {
    let m = this.mem.get(dim)
    if (!m) { m = new Map(); this.mem.set(dim, m) }
    return m
  }

  // Запомнить увиденный блок (из обхода или из sight.visibleOf любого навыка).
  saw (name, x, y, z) {
    const m = this.memory()
    const k = keyOf(x, y, z)
    const rec = m.get(k)
    if (rec && rec.name === name) { rec.t = gameClock.now(); return rec }
    if (rec) this.count.set(rec.name, (this.count.get(rec.name) || 1) - 1)
    const r = { name, x, y, z, t: gameClock.now() }
    m.set(k, r)
    this.stats.seen++
    const n = (this.count.get(name) || 0) + 1
    this.count.set(name, n)
    if (n > PER_NAME) this.trim(m, name, n)
    return r
  }

  trim (m, name, n) {
    const me = this.bot.entity ? this.bot.entity.position : { x: 0, y: 0, z: 0 }
    const list = [...m.entries()].filter(([, r]) => r.name === name)
      .sort((a, b) => d2(b[1], me) - d2(a[1], me))
    const drop = Math.max(0, n - Math.floor(PER_NAME * 0.9))
    for (let i = 0; i < drop; i++) m.delete(list[i][0])
    this.count.set(name, n - drop)
  }

  forget (x, y, z, newName = null) {
    const m = this.memory()
    const k = keyOf(x, y, z)
    const r = m.get(k)
    if (r && r.name !== newName) { m.delete(k); this.stats.forgot++; this.count.set(r.name, (this.count.get(r.name) || 1) - 1) }
    this.tried.delete(k)
  }

  dropSection (cx, cz, sy) { this.cache.delete(`${cx},${cz},${sy}`) }
  dropColumn (cx, cz) { for (const k of [...this.cache.keys()]) if (k.startsWith(`${cx},${cz},`)) this.cache.delete(k) }

  // Клетки секции типов WATCH (с открытой гранью) и PIE (все) — по палитре, кешем до смены секции.
  section (read, cx, cz, sy) {
    const k = `${cx},${cz},${sy}`
    const col = read.column(cx, cz)
    if (!col) return null
    const sec = col.sections && col.sections[sy]
    const data = sec ? sec.data : null
    const hit = this.cache.get(k)
    if (hit && hit.data === data) return hit
    const t0 = nowMs()
    this.syncDim()
    const shapes = this.shapes
    const cells = []
    const ent = { data, cells }
    this.cache.set(k, ent)
    if (!data) return ent // пустая секция (воздух)
    const wantS = s => this.wantOf(s)
    let palette = null
    if (data.palette) palette = data.palette
    else if (data.value !== undefined) palette = [data.value]
    if (palette) {
      let any = false; let openPal = false; let pie = false
      for (const s of palette) { const w = wantS(s); if (w) any = true; if (w & 2) pie = true; if (shapes.open(s)) openPal = true }
      // Цель без открытой клетки в секции видна только с краю секции — ponytail: такие секции пропускаем (кроме «пирога»).
      if (!any || (!openPal && !pie)) return ent
    }
    this.stats.sections++
    const y0 = read.minY + sy * 16
    const bx = cx * 16; const bz = cz * 16
    for (let i = 0; i < 4096; i++) {
      const s = data.get ? data.get(i) : col.getBlockStateId({ x: i & 15, y: y0 + (i >> 8), z: (i >> 4) & 15 })
      if (!s) continue
      const w = wantS(s)
      if (!w) continue
      const x = bx + (i & 15); const y = y0 + (i >> 8); const z = bz + ((i >> 4) & 15)
      const open = shapes.open(read.at(x, y + 1, z)) || shapes.open(read.at(x, y - 1, z)) || shapes.open(read.at(x + 1, y, z)) ||
        shapes.open(read.at(x - 1, y, z)) || shapes.open(read.at(x, y, z + 1)) || shapes.open(read.at(x, y, z - 1))
      if ((w & 2) || open) cells.push({ x, y, z, name: shapes.name(s), open, watch: (w & 1) === 1, pie: (w & 2) === 2 })
    }
    this.stats.scanMs += nowMs() - t0
    return ent
  }

  // Секции в радиусе r от точки o (сферой по коробке секции), ближние первыми. Список — памятью до смены секции глаз
  // или числа загруженных столбцов вокруг (обход раз в 10 тиков не сортирует полторы тысячи секций заново).
  sectionsNear (read, o, r) {
    const memo = `${Math.floor(o.x) >> 4},${Math.floor(o.z) >> 4},${(Math.floor(o.y) - read.minY) >> 4},${r},${this.cols}`
    if (this.near && this.near.memo === memo && this.near.world === this.bot.world) return this.near.list
    const list = this.sectionsNearRaw(read, o, r)
    this.near = { memo, list, world: this.bot.world }
    return list
  }
  declare near: any
  declare cols: number

  sectionsNearRaw (read, o, r) {
    const out = []
    const cr = Math.ceil(r / 16)
    const ocx = Math.floor(o.x) >> 4; const ocz = Math.floor(o.z) >> 4
    const nSec = Math.ceil((read.maxY - read.minY + 1) / 16)
    for (let dcx = -cr; dcx <= cr; dcx++) {
      for (let dcz = -cr; dcz <= cr; dcz++) {
        const cx = ocx + dcx; const cz = ocz + dcz
        if (!read.column(cx, cz)) continue
        const hx = Math.max(cx * 16 - o.x, 0, o.x - cx * 16 - 16)
        const hz = Math.max(cz * 16 - o.z, 0, o.z - cz * 16 - 16)
        const h2 = hx * hx + hz * hz
        if (h2 > r * r) continue
        for (let sy = 0; sy < nSec; sy++) {
          const y0 = read.minY + sy * 16
          const hy = Math.max(y0 - o.y, 0, o.y - y0 - 16)
          const dd = h2 + hy * hy
          if (dd <= r * r) out.push({ cx, cz, sy, dd })
        }
      }
    }
    out.sort((a, b) => a.dd - b.dd)
    return out
  }

  // Один обход: досканировать секции по бюджету, лучи к невиданным кандидатам ближними первыми.
  sweep ({ rays = this.opts.rays, maxMs = this.opts.maxMs, radius = this.opts.radius }: any = {}) {
    const bot = this.bot
    if (!bot.entity || !bot.game || !this.shapes) return null
    const t0 = nowMs()
    const dim = this.syncDim()
    const read = reader(bot)
    const o = eyeOf(bot)
    const m = this.memory(dim)
    const cand = []
    const r2 = radius * radius
    // Секции — ближние первыми; кандидатов набрать с запасом на бюджет лучей и не дальше (сортировка тысяч бревен леса
    // на каждом обходе — та же цена, что лучи). Флаги на клетке кеша: seen — увидена, t* — откуда не была видна.
    for (const s of this.sectionsNear(read, o, radius)) {
      let ent = this.cache.get(`${s.cx},${s.cz},${s.sy}`)
      const col = read.column(s.cx, s.cz)
      const data = col && col.sections && col.sections[s.sy] ? col.sections[s.sy].data : null
      if (!ent || ent.data !== data) {
        if (nowMs() - t0 > maxMs * 0.6) continue // скан секций — не больше 60 % бюджета, остальное — лучам
        ent = this.section(read, s.cx, s.cz, s.sy)
      }
      if (!ent) continue
      for (const c of ent.cells) {
        if (!c.open || !c.watch || c.seen) continue
        const dd = d2(c, o)
        if (dd > r2) continue
        // Не видна была отсюда — ждать сдвига глаз: ближней — на 3 бл., дальней — на d/8.
        if (c.tx !== undefined) { const ex = c.tx - o.x; const ey = c.ty - o.y; const ez = c.tz - o.z; if (ex * ex + ey * ey + ez * ez < Math.max(9, dd / 64)) continue }
        cand.push({ c, dd })
      }
      if (cand.length >= CAND_MAX) break
    }
    cand.sort((a, b) => a.dd - b.dd)
    const counter = { rays: 0 }
    for (const { c } of cand) {
      if (counter.rays >= rays || nowMs() - t0 > maxMs) break
      if (seesCell(read, this.shapes, o, c, counter)) { c.seen = true; this.saw(c.name, c.x, c.y, c.z) } else { c.tx = o.x; c.ty = o.y; c.tz = o.z }
    }
    if (this.tried.size > 50000) this.tried.clear()
    const ms = nowMs() - t0
    this.stats.sweeps++
    this.stats.rays += counter.rays
    this.stats.ms += ms
    if (ms > this.stats.worstMs) this.stats.worstMs = ms
    // Журнал демона: расход слоя раз в 2000 обходов (≈ 17 игр. мин) — доля CPU по любому прогону без сцены.
    if (this.stats.sweeps % 2000 === 0) { try { const c = this.cpu(); console.log('[eyes]', JSON.stringify({ sweeps: this.stats.sweeps, rays: this.stats.rays, sections: this.stats.sections, seen: this.stats.seen, ms: c.layerMs, processMs: c.processMs, share: c.share, worstMs: Math.round(this.stats.worstMs * 100) / 100 })) } catch {} }
    return { rays: counter.rays, candidates: cand.length, ms }
  }

  // Подписки мира: смена клетки — забыть её и пересканировать секцию (и соседнюю через грань), столбец — кеш.
  // mineflayer при смене измерения заводит новый bot.world — подписки переносятся (как fastblocks S9).
  attachWorld () {
    const bot = this.bot
    if (this.worldOff) { try { this.worldOff() } catch {} this.worldOff = null }
    const w = bot.world
    this.worldRef = w
    this.cache.clear()
    const onBlock = (oldB, newB) => {
      const p = (newB && newB.position) || (oldB && oldB.position)
      if (!p) return
      this.forget(p.x, p.y, p.z, newB ? newB.name : null)
      const minY = bot.game ? bot.game.minY : -64
      const cx = p.x >> 4; const cz = p.z >> 4; const sy = (p.y - minY) >> 4
      this.dropSection(cx, cz, sy)
      if ((p.x & 15) === 0) this.dropSection(cx - 1, cz, sy)
      if ((p.x & 15) === 15) this.dropSection(cx + 1, cz, sy)
      if ((p.z & 15) === 0) this.dropSection(cx, cz - 1, sy)
      if ((p.z & 15) === 15) this.dropSection(cx, cz + 1, sy)
      if (((p.y - minY) & 15) === 0) this.dropSection(cx, cz, sy - 1)
      if (((p.y - minY) & 15) === 15) this.dropSection(cx, cz, sy + 1)
      // Соседи клетки могли открыться (выкопал камень — руда за ним теперь с открытой гранью).
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) this.tried.delete(keyOf(p.x + dx, p.y + dy, p.z + dz))
    }
    const onLoad = corner => {
      if (!corner) return
      this.cols = (this.cols || 0) + 1
      const cx = Math.floor(corner.x / 16); const cz = Math.floor(corner.z / 16)
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) this.dropColumn(cx + dx, cz + dz)
    }
    if (w && typeof w.on === 'function') {
      w.on('blockUpdate', onBlock)
      w.on('chunkColumnLoad', onLoad)
      w.on('chunkColumnUnload', onLoad)
      this.worldOff = () => { w.removeListener('blockUpdate', onBlock); w.removeListener('chunkColumnLoad', onLoad); w.removeListener('chunkColumnUnload', onLoad) }
    }
  }
  declare worldOff: any
  declare worldRef: any

  attach () {
    const bot = this.bot
    this.attachWorld()
    this.off.push(() => { if (this.worldOff) this.worldOff() })
    const onTick = () => {
      if (++this.ticks % this.opts.every) return
      try { if (bot.world !== this.worldRef) this.attachWorld(); this.sweep() } catch {}
    }
    if (typeof bot.on === 'function') {
      bot.on('physicsTick', onTick)
      this.off.push(() => bot.removeListener('physicsTick', onTick))
    }
  }

  detach () { for (const f of this.off.splice(0)) { try { f() } catch {} } }

  // Доля CPU процесса, ушедшая на слой, с установки (stats.ms — реальное время обходов; процесс однопоточный).
  cpu () {
    const u = process.cpuUsage(this.cpu0)
    const proc = (u.user + u.system) / 1000
    return { layerMs: Math.round(this.stats.ms), processMs: Math.round(proc), share: proc > 0 ? Math.round(this.stats.ms / proc * 1000) / 1000 : null }
  }
}

function d2 (a, b) { const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z; return dx * dx + dy * dy + dz * dz }

function matcher (what) {
  if (what instanceof RegExp) return n => what.test(n)
  if (Array.isArray(what)) { const s = new Set(what); return n => s.has(n) }
  if (what === 'log' || what === 'any_log') return n => /_log$|_stem$/.test(n)
  if (typeof what === 'string' && what.endsWith('*')) { const p = what.slice(0, -1); return n => n.startsWith(p) }
  return n => n === what
}

// ---------------------------------------------------------------- API

function install (sessionOrBot, opts: any = {}) {
  const bot = sessionOrBot && sessionOrBot.bot ? sessionOrBot.bot : sessionOrBot
  if (!bot || process.env.ND_EYES === '0') return null
  if (bot._ndEyes) return bot._ndEyes
  const e = new Eyes(bot, opts)
  bot._ndEyes = e
  e.attach()
  return e
}

// Ближайшие увиденные блоки типа what (имя, 'log', 'iron*', массив имён, RegExp) из памяти этого измерения.
// fresh: true — сначала обход без бюджета лучей по этим типам (на запрос навыка: «посмотреть вокруг»).
function nearest (bot, what, { max = 8, maxDist = Infinity, from = null, fresh = false }: any = {}) {
  const e = bot && bot._ndEyes
  if (!e || !bot.entity) return []
  if (fresh) e.sweep({ rays: 600, maxMs: 25 })
  const ok = matcher(what)
  const me = from || bot.entity.position
  const now = gameClock.now()
  const out = []
  for (const r of e.memory().values()) {
    if (!ok(r.name)) continue
    const d = Math.sqrt(d2(r, me))
    if (d > maxDist) continue
    out.push({ name: r.name, x: r.x, y: r.y, z: r.z, dist: Math.round(d * 10) / 10, ago: Math.round((now - r.t) / 100) / 10 })
  }
  out.sort((a, b) => a.dist - b.dist)
  return out.slice(0, max)
}

// Видна ли клетка сейчас (по номерам состояний, без Block): для навыков и тестов.
function seesNow (bot, pos) {
  if (!bot.entity || !bot.registry) return false
  const shapes = (bot._ndEyes && bot._ndEyes.shapes) || shapeCache(bot.registry)
  return seesCell(reader(bot), shapes, eyeOf(bot), { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) })
}

// Что видно в направлении: dir {x,y,z} | yaw/pitch (градусы, как F3: yaw 0 — юг, 90 — запад) | toward {x,y,z}.
// Первая непрозрачная клетка до maxDist: { name, pos, dist, biome, water } (water — луч прошёл воду) или null.
function surface (bot, { dir = null, yaw = null, pitch = 0, toward = null, maxDist = 128 }: any = {}) {
  if (!bot.entity || !bot.registry) return null
  const o = eyeOf(bot)
  let v = dir
  if (!v && toward) v = { x: toward.x - o.x, y: (toward.y ?? o.y) - o.y, z: toward.z - o.z }
  if (!v && yaw !== null) {
    const ry = yaw * Math.PI / 180; const rp = pitch * Math.PI / 180
    v = { x: -Math.sin(ry) * Math.cos(rp), y: -Math.sin(rp), z: Math.cos(ry) * Math.cos(rp) }
  }
  if (!v) { const ry = bot.entity.yaw; const rp = bot.entity.pitch; v = { x: -Math.sin(ry) * Math.cos(rp), y: Math.sin(rp), z: -Math.cos(ry) * Math.cos(rp) } }
  const n = Math.hypot(v.x, v.y, v.z)
  if (n < 1e-9) return null
  const read = reader(bot)
  const shapes = (bot._ndEyes && bot._ndEyes.shapes) || shapeCache(bot.registry)
  let x = Math.floor(o.x); let y = Math.floor(o.y); let z = Math.floor(o.z)
  const u = { x: v.x / n, y: v.y / n, z: v.z / n }
  const sx = u.x > 0 ? 1 : -1; const sy = u.y > 0 ? 1 : -1; const sz = u.z > 0 ? 1 : -1
  const inv = a => Math.abs(a) < 1e-12 ? Infinity : Math.abs(1 / a)
  let tx = Math.abs(u.x) < 1e-12 ? Infinity : ((sx > 0 ? x + 1 : x) - o.x) / u.x
  let ty = Math.abs(u.y) < 1e-12 ? Infinity : ((sy > 0 ? y + 1 : y) - o.y) / u.y
  let tz = Math.abs(u.z) < 1e-12 ? Infinity : ((sz > 0 ? z + 1 : z) - o.z) / u.z
  let water = false
  for (let i = 0; i < 4096; i++) {
    let t
    if (tx <= ty && tx <= tz) { t = tx; x += sx; tx += inv(u.x) } else if (ty <= tz) { t = ty; y += sy; ty += inv(u.y) } else { t = tz; z += sz; tz += inv(u.z) }
    if (t > maxDist) return null
    const s = read.at(x, y, z)
    if (s < 0) return null
    if (shapes.opaque(s)) {
      const pos = new Vec3(x, y, z)
      let biome = null
      try { biome = require('../perception').biomeName(bot, pos) } catch {}
      return { name: shapes.name(s), pos: { x, y, z }, dist: Math.round(t * 10) / 10, biome, water }
    }
    if (shapes.name(s) === 'water') water = true
  }
  return null
}

// Сущности, которые бот знает: видимые по лучу (в радиусе) и слышимые (perception/senses — звук за последние hearMs,
// без точного места: сторона и полоса дальности). Остальные — нет. Видимая помнится rememberMs: место — последнее увиденное.
function entities (bot, { radius = 64, rememberMs = 5000, hearMs = 4000 }: any = {}) {
  if (!bot.entity || !bot.registry) return []
  const e = bot._ndEyes
  const read = reader(bot)
  const shapes = (e && e.shapes) || shapeCache(bot.registry)
  const o = eyeOf(bot)
  const now = gameClock.now()
  const lastSeen = e ? (e._ent || (e._ent = new Map())) : new Map()
  let heard = null
  try { heard = require('./senses').heardEntities(bot, { sinceMs: hearMs }) } catch {}
  const out = []
  for (const ent of Object.values(bot.entities || {}) as any[]) {
    if (!ent || ent === bot.entity || !ent.position) continue
    const p = ent.position
    const d = Math.sqrt(d2(p, o))
    if (d > radius) continue
    const h = ent.height || 1
    const sees = [0.85, 0.5, 0.15].some(f => ray(read, shapes, o, { x: p.x, y: p.y + h * f, z: p.z }))
    if (sees) lastSeen.set(ent.id, { t: now, x: p.x, y: p.y, z: p.z })
    const ls = lastSeen.get(ent.id)
    const hr = heard && heard.get(ent.id)
    if (!sees && !(ls && now - ls.t <= rememberMs) && !hr) continue
    out.push({
      id: ent.id, name: ent.username || ent.name, kind: ent.type, seen: sees,
      // Место — только увиденное (сейчас или последнее); слышимая без взгляда — сторона и полоса.
      ...(sees ? { pos: { x: p.x, y: p.y, z: p.z }, dist: Math.round(d * 10) / 10 } : ls && now - ls.t <= rememberMs ? { lastPos: { x: ls.x, y: ls.y, z: ls.z }, ago: Math.round((now - ls.t) / 100) / 10 } : {}),
      ...(hr ? { heard: hr } : {})
    })
  }
  if (lastSeen.size > 2000) lastSeen.clear()
  return out
}

// S1f: объекты сущностей, которые бот знает (видимые лучом, увиденные за rememberMs, слышимые) — замена Object.values(bot.entities)
// в решениях «кого бить / сколько злых / куда идти» (аудит S10 №20). Без глаз (тесты, ND_EYES=0), на scan или ND_HONEST_ENT=0 —
// все, как было. Кеш на 5 игровых тиков: в циклах навыка фильтр зовётся каждый тик.
function knownEntities (bot, { radius = 64 }: any = {}): any[] {
  const all = Object.values(bot.entities || {}) as any[]
  const e = bot && bot._ndEyes
  if (!e || process.env.ND_HONEST_ENT === '0' || require('./knowledge').level() === 'scan') return all
  const now = gameClock.now()
  let c = e._known
  if (!c || c.r !== radius || now - c.t >= 250 || now < c.t) {
    c = { t: now, r: radius, ids: new Set(entities(bot, { radius }).map(x => x.id)) }
    e._known = c
  }
  return all.filter(x => x && c.ids.has(x.id))
}

// Найти блоки names так, как нашёл бы игрок: память увиденного + оглядеться сейчас (sight.visibleOf — луч к кандидатам).
// Замена bot.findBlocks в решениях спидрана (аудит S10). На уровне scan (полный скан копии) — bot.findBlocks, как было:
// это знание карты. Vec3[] ближние первыми; запись памяти, чья клетка сменилась (столбец перегружен без blockUpdate), — мимо.
function locate (bot, names, { radius = 64, max = 6, rays = 600, filter = null }: any = {}) {
  const reg = bot.registry
  const ids = names.map(n => reg.blocksByName[n]).filter(Boolean).map(b => b.id)
  if (!ids.length || !bot.entity) return []
  if (require('./knowledge').level() === 'scan') {
    const f = bot.findBlocks({ matching: ids, maxDistance: radius, count: max * 4 })
    return (filter ? f.filter(filter) : f).slice(0, max)
  }
  const me = bot.entity.position
  const out = new Map()
  for (const r of nearest(bot, names, { max: max * 4, maxDist: radius })) {
    const b = bot.blockAt(new Vec3(r.x, r.y, r.z))
    if (b && b.name !== r.name) continue
    out.set(keyOf(r.x, r.y, r.z), new Vec3(r.x, r.y, r.z))
  }
  try {
    for (const b of require('../sight').visibleOf(bot, ids, Math.min(radius, 96), { max: max * 2, rays })) out.set(keyOf(b.position.x, b.position.y, b.position.z), b.position.clone())
  } catch {}
  let list = [...out.values()]
  if (filter) list = list.filter(filter)
  return list.sort((a, b) => a.distanceTo(me) - b.distanceTo(me)).slice(0, max)
}

function stats (bot) {
  const e = bot && bot._ndEyes
  if (!e) return null
  const byName = {}
  for (const r of e.memory().values()) byName[r.name] = (byName[r.name] || 0) + 1
  const s = e.stats
  return { ...s, ms: Math.round(s.ms), scanMs: Math.round(s.scanMs), worstMs: Math.round(s.worstMs * 100) / 100, avgMs: s.sweeps ? Math.round(s.ms / s.sweeps * 1000) / 1000 : 0,
    cached: e.cache.size, remembered: byName, opts: e.opts, cpu: e.cpu() }
}

module.exports = { install, nearest, locate, seesNow, surface, entities, knownEntities, stats, Eyes, reader, shapeCache, ray, seesCell, WATCH, PIE, dimOf }
