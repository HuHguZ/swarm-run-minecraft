'use strict'
// Быстрый доступ к блокам мира для горячих путей (S9, 07.10). bot.blockAt строит полный Block на каждый вызов
// (prismarine-block: свойства состояния, хеш, биом, свет, сущность блока) — 40 % CPU демона на маршруте и 29 % в бою
// (research/claude-1006/lockstep.md, профиль V8). Ответы те же, что у bot.blockAt:
//  - def(x, y, z) — описание блока из реестра по номеру состояния (name, id, boundingBox, …), без Block; null — столбец
//    не загружен (как blockAt);
//  - block(x, y, z) — тот же Block, что bot.blockAt(p, false), из кеша. Кеш сбрасывают события мира: blockUpdate (клетка),
//    chunkColumnLoad/Unload, пакеты update_light (столбец) и tile_entity_data (клетка), смена объекта мира. Тихая
//    постановка блока мимо событий (blockmoves silentSet) зовёт invalidate сама. Блоки из кеша — только для чтения.
// ND_S9=0 — прежний код (bot.blockAt на каждый вызов).
const Vec3 = require('vec3')
const nbt = require('prismarine-nbt')
const gameClock = require('./game-clock')

const LIMIT = 120000 // блоков в кеше (~0.5 КБ на Block — до ~70 МБ); больше — сброс целиком (ponytail: без LRU — поиск A* трогает ~6 тыс. клеток)
const on = () => process.env.ND_S9 !== '0'
// Столбец: cx, cz в ±2^21 (мир ±30 млн бл.) → ключ < 2^44. Клетка в столбце: y в ±2048.
const chunkKey = (cx, cz) => (cx + 2097152) * 4194304 + (cz + 2097152)
const localKey = (x, y, z) => ((y + 2048) << 8) | ((z & 15) << 4) | (x & 15)
// Номер состояния без записи в реестре: Block такого состояния — name '' и форма 'empty' (prismarine-block).
const UNKNOWN = Object.freeze({ name: '', boundingBox: 'empty', shapes: [] })

class FastBlocks {
  declare bot: any
  declare world: any
  declare chunks: Map<number, any>
  declare size: number
  declare pos: any
  declare stats: any
  declare live: boolean
  declare ver: number
  constructor (bot) {
    this.bot = bot
    this.world = null
    this.chunks = new Map()
    this.size = 0
    this.pos = { x: 0, y: 0, z: 0 }
    this.stats = { hits: 0, misses: 0, resets: 0, invalid: 0 }
    this.live = false
    // Версия мира: растёт на любом сбросе (блок, столбец, свет) — память цен шагов на блоках (lavaMemo) по ней.
    this.ver = 0
  }

  // Мир сменился (первый вход, тест) — подписаться на его события заново.
  attach (w) {
    const prev = this.world
    if (prev && this.onWorld) {
      prev.removeListener('blockUpdate', this.onWorld.block)
      prev.removeListener('chunkColumnLoad', this.onWorld.column)
      prev.removeListener('chunkColumnUnload', this.onWorld.column)
    }
    this.world = w
    this.clear()
    // Кеш — только у настоящего мира с событиями (prismarine-world): у поддельного мира тестов — bot.blockAt.
    this.live = !!w && typeof w.prependListener === 'function' && typeof w.getColumn === 'function'
    if (!this.live) return
    this.onWorld = {
      block: (oldBlock, newBlock) => { const p = (newBlock && newBlock.position) || (oldBlock && oldBlock.position); if (p) this.invalidate(p.x, p.y, p.z) },
      column: (corner) => { if (corner) this.invalidateChunk(Math.floor(corner.x / 16), Math.floor(corner.z / 16)) }
    }
    // Раньше пересылки mineflayer в bot.emit: слушатели тела видят уже свежий кеш.
    w.prependListener('blockUpdate', this.onWorld.block)
    w.prependListener('chunkColumnLoad', this.onWorld.column)
    w.prependListener('chunkColumnUnload', this.onWorld.column)
  }
  declare onWorld: any

  // Запись столбца; null — не загружен, undefined — у мира нет API столбцов (поддельное тело тестов): тогда bot.blockAt.
  entry (cx, cz) {
    const w = this.bot.world
    if (w !== this.world) this.attach(w)
    if (!this.live) return undefined
    const k = chunkKey(cx, cz)
    let e = this.chunks.get(k)
    if (e) return e
    const col = w.getColumn(cx, cz)
    if (!col) return null
    e = { col, blocks: new Map() }
    this.chunks.set(k, e)
    return e
  }

  // Тот же Block, что bot.blockAt(new Vec3(x, y, z), false); null — столбец не загружен.
  block (x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
    const e = this.entry(x >> 4, z >> 4)
    if (e === undefined) return this.bot.blockAt(new Vec3(x, y, z), false)
    if (!e) return null
    const lk = localKey(x, y, z)
    let b = e.blocks.get(lk)
    if (b !== undefined) { this.stats.hits++; return b }
    this.stats.misses++
    b = this.bot.blockAt(new Vec3(x, y, z), false)
    if (!b) return null
    if (this.size >= LIMIT) { this.clear(); this.stats.resets++; return b }
    e.blocks.set(lk, b)
    this.size++
    return b
  }

  // Номер состояния; -1 — столбец не загружен, -2 — у мира нет API столбцов.
  stateId (x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z)
    const e = this.entry(x >> 4, z >> 4)
    if (e === undefined) return -2
    if (!e) return -1
    const p = this.pos
    p.x = x & 15; p.y = y; p.z = z & 15
    return e.col.getBlockStateId(p)
  }

  // Описание из реестра (name, id, boundingBox, shapes по умолчанию); null — столбец не загружен.
  def (x, y, z) {
    const id = this.stateId(x, y, z)
    if (id === -2) return this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), false)
    if (id < 0) return null
    const reg = this.bot.registry && this.bot.registry.blocksByStateId
    return (reg && reg[id]) || UNKNOWN
  }

  invalidate (x, y, z) {
    this.ver++
    const e = this.chunks.get(chunkKey(Math.floor(x) >> 4, Math.floor(z) >> 4))
    if (e && e.blocks.delete(localKey(Math.floor(x), Math.floor(y), Math.floor(z)))) { this.size--; this.stats.invalid++ }
  }

  invalidateChunk (cx, cz) {
    this.ver++
    const k = chunkKey(cx, cz)
    const e = this.chunks.get(k)
    if (!e) return
    this.size -= e.blocks.size
    this.chunks.delete(k)
  }

  clear () { this.chunks.clear(); this.size = 0; this.ver++ }
}

// bot.findBlocks mineflayer 4.37.1 (lib/plugins/blocks.js:156) для matching — id или список id без useExtraInfo: тот же
// обход секций (OctahedronIterator, слой доводится до конца), тот же порядок и отбор, но проверка по номеру состояния, а
// не Block на каждую из 4096 клеток секции, где в палитре нашёлся искомый id (автолут r=24 — 7 % CPU в бою). Функция в
// matching или useExtraInfo — исходный findBlocks.
function patchFindBlocks (bot) {
  const orig = bot.findBlocks
  if (typeof orig !== 'function' || orig._ndFast) return
  let Octahedron
  try { Octahedron = require('prismarine-world').iterators.OctahedronIterator } catch { return }
  const fast = function (options: any = {}) {
    const reg = bot.registry && bot.registry.blocksByStateId
    if (!reg || !bot.world || typeof bot.world.getColumn !== 'function' || typeof options.matching === 'function' || options.useExtraInfo) return orig(options)
    const ids = new Set(Array.isArray(options.matching) ? options.matching : [options.matching])
    const hit = stateId => { const d = reg[stateId]; return !!d && ids.has(d.id) }
    const point = (options.point || bot.entity.position).floored()
    const maxDistance = options.maxDistance || 16
    const count = options.count || 1
    const start = new Vec3(Math.floor(point.x / 16), Math.floor(point.y / 16), Math.floor(point.z / 16))
    const it = new Octahedron(start, Math.ceil((maxDistance + 8) / 16))
    const visitedSections = new Set()
    let blocks = []
    let startedLayer = 0
    let next = start
    const p = { x: 0, y: 0, z: 0 }
    while (next) {
      const column = bot.world.getColumn(next.x, next.z)
      const sectionY = next.y + Math.abs(bot.game.minY >> 4)
      const totalSections = bot.game.height >> 4
      if (sectionY >= 0 && sectionY < totalSections && column && !visitedSections.has(next.toString())) {
        const section = column.sections[sectionY]
        // isBlockInSection: пустая секция — мимо; палитра без искомого — мимо; глобальная палитра — полный перебор.
        if (section && (!section.palette || section.palette.some(hit))) {
          const begin = new Vec3(next.x * 16, sectionY * 16 + bot.game.minY, next.z * 16)
          const cursor = begin.clone()
          const end = cursor.offset(16, 16, 16)
          for (cursor.x = begin.x; cursor.x < end.x; cursor.x++) {
            for (cursor.y = begin.y; cursor.y < end.y; cursor.y++) {
              for (cursor.z = begin.z; cursor.z < end.z; cursor.z++) {
                p.x = cursor.x & 15; p.y = cursor.y; p.z = cursor.z & 15
                if (hit(column.getBlockStateId(p)) && cursor.distanceTo(point) <= maxDistance) blocks.push(cursor.clone())
              }
            }
          }
        }
        visitedSections.add(next.toString())
      }
      if (startedLayer !== it.apothem && blocks.length >= count) break
      startedLayer = it.apothem
      next = it.next()
    }
    blocks.sort((a, b) => a.distanceTo(point) - b.distanceTo(point))
    if (blocks.length > count) blocks = blocks.slice(0, count)
    return blocks
  }
  ;(fast as any)._ndFast = true
  ;(fast as any)._ndOrig = orig
  bot.findBlocks = fast
}

// Нарезка кадров протокола (minecraft-protocol 1.66 transforms/framing.js Splitter._transform) без исключения на конце
// буфера: readVarInt protodef бросает PartialReadError со стеком (captureStackTrace) на КАЖДОМ куске сети, где буфер
// кончился ровно на границе кадра, — 2.5 % CPU демона. Те же кадры в том же порядке, тот же остаток буфера; исключение
// из push (ниже по потоку) — как в оригинале: partialReadError — стоп, иное — наверх.
function readVarIntSoft (buffer, offset) {
  let result = 0
  let shift = 0
  let cursor = offset
  while (true) {
    if (cursor >= buffer.length) return null
    const byte = buffer[cursor]
    result |= (byte & 0x7F) << shift
    cursor++
    if (!(byte & 0x80)) return { value: result, size: cursor - offset }
    shift += 7
    if (shift > 64) return null
  }
}
const LEGACY_PING_PACKET_ID = 0xfe
function softTransform (chunk, enc, cb) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.recognizeLegacyPing && this.buffer[0] === LEGACY_PING_PACKET_ID) {
      const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
      const header = Buffer.alloc(sizeOfVarInt(LEGACY_PING_PACKET_ID))
      writeVarInt(LEGACY_PING_PACKET_ID, header, 0)
      let payload = this.buffer.slice(1)
      if (payload.length === 0) payload = Buffer.from('\0')
      this.push(Buffer.concat([header, payload]))
      return cb()
    }
    let offset = 0
    let r = readVarIntSoft(this.buffer, offset)
    if (r) {
      while (this.buffer.length >= offset + r.size + r.value) {
        try {
          this.push(this.buffer.slice(offset + r.size, offset + r.size + r.value))
        } catch (e) {
          if (e.partialReadError) break
          throw e
        }
        offset += r.size + r.value
        r = readVarIntSoft(this.buffer, offset)
        if (!r) break
      }
    }
    this.buffer = this.buffer.slice(offset)
    return cb()
}
function patchSplitter (client) {
  const sp = client && client.splitter
  const proto = sp && Object.getPrototypeOf(sp)
  if (!proto || proto._ndSoft || typeof proto._transform !== 'function' || !('recognizeLegacyPing' in sp)) return
  proto._ndSoft = true
  proto._ndOrigTransform = proto._transform
  proto._transform = softTransform
}

// Один кеш на тело. null — ND_S9=0 или нет мира.
function install (bot) {
  if (!on() || !bot) return null
  if (bot._ndFastBlocks) return bot._ndFastBlocks
  const fb = new FastBlocks(bot)
  bot._ndFastBlocks = fb
  patchFindBlocks(bot)
  patchSplitter(bot._client)
  const c = bot._client
  if (c && typeof c.prependListener === 'function') {
    c.prependListener('update_light', pk => { try { fb.invalidateChunk(pk.chunkX, pk.chunkZ) } catch {} })
    c.prependListener('tile_entity_data', pk => { try { const l = pk.location; if (l) fb.invalidate(l.x, l.y, l.z) } catch {} })
  }
  return fb
}

// Эффекты тела строкой (ключ памяти времени копки: спешка, проводник, усталость).
function effectsKey (effects) {
  let s = ''
  if (effects) for (const id in effects) { const e = effects[id]; s += id + ':' + (e && e.amplifier) + ';' }
  return s
}

// Инструмент и время копки по памяти. bot.pathfinder.bestHarvestTool перебирает весь рюкзак (digTime на каждый предмет,
// nbt каждого инструмента) на КАЖДУЮ ломаемую клетку поиска — 17 % A* на стенде. Ответ зависит от вида блока (материал,
// твёрдость, инструменты добычи — по id), предметов рюкзака и эффектов тела: память сбрасывает любой updateSlot рюкзака
// и смена объекта рюкзака, эффекты — в ключе. Время копки — по объекту предмета (его тип и чары не меняются).
function toolMemo (bot, fb) {
  const pf = bot.pathfinder
  if (!pf || pf._ndToolMemo || typeof pf.bestHarvestTool !== 'function') return
  const orig = pf.bestHarvestTool
  const st: any = { inv: null, best: new Map(), dig: new WeakMap(), bare: new Map() }
  const fresh = () => {
    const inv = bot.inventory
    if (inv === st.inv) return
    st.inv = inv; st.best.clear()
    if (inv && typeof inv.on === 'function') inv.on('updateSlot', () => st.best.clear())
  }
  pf._ndToolMemo = st
  pf.bestHarvestTool = function (block) {
    fresh()
    if (!st.inv || typeof st.inv.on !== 'function' || !block) return orig(block)
    const key = block.type + '|' + effectsKey(bot.entity && bot.entity.effects)
    if (st.best.has(key)) return st.best.get(key)
    const tool = orig(block)
    st.best.set(key, tool)
    return tool
  }
  // block.digTime(tool.type, false, false, false, чары, эффекты) — как safeOrBreak pathfinder'а.
  fb.digTime = (block, tool) => {
    const effects = bot.entity.effects
    let m = tool ? st.dig.get(tool) : st.bare
    if (!m) { m = new Map(); st.dig.set(tool, m) }
    const key = block.type + '|' + effectsKey(effects)
    let t = m.get(key)
    if (t === undefined) {
      const enchants = (tool && tool.nbt) ? nbt.simplify(tool.nbt).Enchantments : []
      t = block.digTime(tool ? tool.type : null, false, false, false, enchants, effects)
      m.set(key, t)
    }
    return t
  }
}

// Множества, по которым getBlock ставит поля хода: правка (add/delete/clear) или замена любого — новая версия, и поля
// блоков из кеша считаются заново. Правят на ходу: pvp (паутина), farm (вода), structures, dragon.
const DECOR_SETS = ['climbables', 'carpets', 'blocksToAvoid', 'fences', 'replaceables', 'liquids', 'gravityBlocks', 'openable']
function guardSets (mv) {
  mv._ndSetsVer = 1
  const bump = () => { mv._ndSetsVer++ }
  const guard = set => {
    if (!(set instanceof Set)) return set
    const add = set.add; const del = set.delete; const clr = set.clear
    set.add = function (v) { bump(); return add.call(this, v) }
    set.delete = function (v) { bump(); return del.call(this, v) }
    set.clear = function () { bump(); return clr.call(this) }
    return set
  }
  for (const name of DECOR_SETS) {
    let cur = guard(mv[name])
    Object.defineProperty(mv, name, { configurable: true, enumerable: true, get: () => cur, set: v => { bump(); cur = guard(v) } })
  }
}

// Индекс сущностей pathfinder'а (entityIntersections: строка «x,y,z» → число) — ещё и по числовому ключу: getNumEntitiesAt
// зовут на каждую клетку-кандидата, строка ключа на каждый вызов — 9 % A*. Ответ тот же; дробные координаты и клетки
// дальше ±2^19 — прежним путём (ключ < 2^52).
const NUM = 524288
const entKey = (x, y, z) => ((x + NUM) * 1048576 + (z + NUM)) * 4096 + (y + 2048)
function entityIndex (mv) {
  const update = mv.updateCollisionIndex; const clear = mv.clearCollisionIndex; const get = mv.getNumEntitiesAt
  if (typeof update !== 'function' || typeof clear !== 'function' || typeof get !== 'function') return
  const rebuild = () => {
    const m = new Map()
    for (const k of Object.keys(mv.entityIntersections || {})) {
      const [x, y, z] = k.split(',').map(Number)
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || Math.abs(x) >= NUM || Math.abs(z) >= NUM || Math.abs(y) >= 2048) { mv._ndEnt = null; return }
      m.set(entKey(x, y, z), mv.entityIntersections[k])
    }
    mv._ndEnt = m
  }
  mv._ndEnt = null
  mv.updateCollisionIndex = function () { const r = update.apply(this, arguments); rebuild(); return r }
  mv.clearCollisionIndex = function () { const r = clear.apply(this, arguments); rebuild(); return r }
  mv.getNumEntitiesAt = function (pos, dx, dy, dz) {
    const m = this._ndEnt
    if (m === null || this.allowEntityDetection === false || !pos) return get.call(this, pos, dx, dy, dz)
    if (m.size === 0) return 0
    const x = pos.x + dx; const y = pos.y + dy; const z = pos.z + dz
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || Math.abs(x) >= NUM || Math.abs(z) >= NUM || Math.abs(y) >= 2048) return get.call(this, pos, dx, dy, dz)
    return m.get(entKey(x, y, z)) ?? 0
  }
}

// pathfinder 2.4.5 Movements.getBlock (lib/movements.js:218) поверх кеша: тот же Block и те же поля хода. Поля ставятся
// при каждом вызове — по множествам этого Movements (их правят на ходу: pvp паутина, farm вода).
function wrapMovements (bot, mv) {
  if (!mv || mv._ndFast || !on()) return mv
  const fb = install(bot)
  if (!fb) return mv
  mv._ndFast = fb
  toolMemo(bot, fb)
  // Movements.safeOrBreak (lib/movements.js:282) — тот же расчёт, время копки — по памяти (fb.digTime).
  if (fb.digTime) {
    mv.safeOrBreak = function (block, toBreak) {
      let cost = 0
      cost += this.exclusionStep(block) // Is excluded so can't move or break
      cost += this.getNumEntitiesAt(block.position, 0, 0, 0) * this.entityCost
      if (block.safe) return cost
      if (!this.safeToBreak(block)) return 100 // Can't break, so can't move
      toBreak.push(block.position)

      if (block.physical) cost += this.getNumEntitiesAt(block.position, 0, 1, 0) * this.entityCost // Add entity cost if there is an entity above (a breakable block) that will fall

      const tool = this.bot.pathfinder.bestHarvestTool(block)
      const digTime = fb.digTime(block, tool)
      const laborCost = (1 + 3 * digTime / 1000) * this.digCost
      cost += laborCost
      return cost
    }
  }
  guardSets(mv)
  entityIndex(mv)
  mv.getBlock = function (pos, dx, dy, dz) {
    const b = pos ? fb.block(pos.x + dx, pos.y + dy, pos.z + dz) : null
    if (!b) {
      return {
        replaceable: false,
        canFall: false,
        safe: false,
        physical: false,
        liquid: false,
        climbable: false,
        height: dy,
        openable: false
      }
    }
    // Поля-признаки этого Movements уже стоят и множества с тех пор не менялись — те же значения. Высота — каждый раз:
    // getMoveJumpUp правит её на объекте (blockC.height += 1), а у прежнего getBlock объект всякий раз новый.
    if (b._ndMv !== this || b._ndMvVer !== this._ndSetsVer) {
      b._ndMv = this; b._ndMvVer = this._ndSetsVer
      b.climbable = this.climbables.has(b.type)
      b.safe = (b.boundingBox === 'empty' || b.climbable || this.carpets.has(b.type)) && !this.blocksToAvoid.has(b.type)
      b.physical = b.boundingBox === 'block' && !this.fences.has(b.type)
      b.replaceable = this.replaceables.has(b.type) && !b.physical
      b.liquid = this.liquids.has(b.type)
      b.canFall = this.gravityBlocks.has(b.type)
      b.openable = this.openable.has(b.type)
    }
    b.height = pos.y + dy

    for (const shape of b.shapes) {
      b.height = Math.max(b.height, pos.y + dy + shape[4])
    }
    return b
  }
  return mv
}

// ---------------------------------------------------------------- бюджет A* в узлах: срез и весь поиск
// AStar 2.4.5 режет поиск по РЕАЛЬНОМУ времени: срез tickTimeout (40 мс) на тик и весь поиск thinkTimeout (5 с). До S9
// раскрытие узла стоило ~0.35 мс: срез — медиана 74–80 раскрытых узлов (p90 ~120, s8b/s8c/s9-ab: 20 тыс. срезов), поиск
// без шага кончался таймаутом на 14–15.7 тыс. узлов (s8b: цель на дереве). С кешем блоков узел ~0.06 мс.
//  - ND_ASTAR_SLICE_NODES=N (> 0, умолч. 120): срез ещё и не больше N узлов (120 — прежний p90): в игровом времени поиск идёт как
//    прежде (столько же узлов за тик, тот же таймаут на том же тике), а реальное время среза — 7–8 мс вместо 40: тело
//    не «думает» 40 мс каждый тик долгого поиска (идёт по частичному пути до «stuck»). Весь поиск — не больше
//    timeout × ND_ASTAR_NODES_PER_MS (3 — прежний темп) узлов: при N ≈ 120 это тот же тик таймаута, что был.
//  - N = 0: срез только по времени (в 5–7 раз больше узлов за тик, чем прежде), а предел в узлах — только для поиска без
//    шага (лучший узел — старт): тот же таймаут на том же числе узлов, а не 5 с стоя.
// Срез кончается в начале цикла compute (tickTimeout = −∞ после N-го узла) — порядок раскрытия тот же, что без среза.
// ND_ASTAR_NODES_PER_MS=0 или ND_S9=0 — только время, как было.
// ponytail: стоп по бюджету — исключением из goal.isEnd внутри AStar.compute (узел, на котором встали, уже снят с кучи;
// после таймаута поиск не продолжают), а не копией цикла compute.
const OVER = new Error('astar node budget')
function nodeBudget (timeoutMs) {
  if (!on()) return 0
  const r = Number(process.env.ND_ASTAR_NODES_PER_MS ?? 3)
  return r > 0 && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs * r) : 0
}
function sliceNodes () {
  if (!on()) return 0
  const n = Number(process.env.ND_ASTAR_SLICE_NODES ?? 120)
  return n > 0 ? Math.floor(n) : 0
}
function patchAStar () {
  let AStar
  try { AStar = require('mineflayer-pathfinder/lib/astar') } catch { return false }
  if (!AStar || !AStar.prototype || AStar.prototype._ndBudget) return !!AStar
  const compute = AStar.prototype.compute
  AStar.prototype._ndBudget = true
  AStar.prototype.compute = function () {
    if (this._ndMax === undefined) { this._ndMax = nodeBudget(this.timeout); this._ndSlice = sliceNodes() }
    const max = this._ndMax
    const slice = this._ndSlice
    if (!(max > 0) && !(slice > 0)) return compute.call(this)
    const over = () => max > 0 && this.closedDataSet.size >= max && (slice > 0 || this.bestNode.parent === null)
    if (over()) return this.makeResult('timeout', this.bestNode)
    const goal = this.goal
    const tick0 = this.tickTimeout
    // At 750 TPS a physical turn has 1.33 ms; a 40 ms search slice stalls movement and reactions.
    const tickRate = gameClock.snapshot()?.tickRate ?? 20
    if (tickRate > 20) this.tickTimeout = Math.min(tick0, 40 * 20 / tickRate)
    let pops = 0
    this.goal = {
      heuristic: n => goal.heuristic(n),
      isEnd: n => {
        if (over()) throw OVER
        if (slice > 0 && ++pops >= slice) this.tickTimeout = -Infinity
        return goal.isEnd(n)
      }
    }
    let result
    try { result = compute.call(this) } catch (err) {
      if (err !== OVER) throw err
      return this.makeResult('timeout', this.bestNode)
    } finally { this.goal = goal; this.tickTimeout = tick0 }
    // The closest node may be the start or an already reached prefix while a legal detour goes sideways.
    // Walk the cheapest queued native chain; keep bestNode and the continuing search intact.
    const frontier = this.openHeap.heap[1]
    const end = result.path[result.path.length - 1]
    const at = this.movements.bot?.entity?.position
    const reached = at && end && Math.abs(at.x - end.x) <= 0.35 && Math.abs(at.z - end.z) <= 0.35 && Math.abs(at.y - end.y) < 1 &&
      result.path.every(n => !n.toBreak.length && !n.toPlace.length)
    if (result.status === 'partial' && (!result.path.length || reached) && frontier?.parent) {
      return Object.assign(this.makeResult('partial', frontier), { ndPartialNode: frontier })
    }
    return result
  }
  return true
}
patchAStar()

// Описание блока для цен шагов: из кеша тела или bot.blockAt (ND_S9=0). Флаг читается при постройке читателя, а не на
// каждую клетку: process.env — запрос к окружению ОС на каждое чтение (на стенде A* 45 % времени ушло в on()).
function defReader (bot) {
  const fb = install(bot)
  return fb ? (x, y, z) => fb.def(x, y, z) : (x, y, z) => bot.blockAt(new Vec3(x, y, z))
}

// Разовое чтение (не в горячем цикле).
function defAt (bot, x, y, z) { return defReader(bot)(x, y, z) }

module.exports = { install, wrapMovements, defReader, defAt, FastBlocks, on, UNKNOWN, _softTransform: softTransform }
