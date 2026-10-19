'use strict'
import type { Session } from '../session'
import * as gameClock from '../game-clock'
import { Movements } from 'mineflayer-pathfinder'
import { biomeName } from '../perception'
// Цена шага по воде — статическим импортом: ленивый require('../movement') из папки части шёл бы в разбор пути на каждую
// клетку A* (кеш Node по (папка, spec) заполняет только первая загрузка модуля).
import { sprintOn, waterStepCost, waterCell } from '../movement'
import * as flee from '../flee'
import * as packMod from '../pack'
import * as worlds from '../worlds'
import * as fastblocks from '../fastblocks'
import * as edges from '../edges'
import * as blockmoves from '../blockmoves'
import { freeDrop, underRoofCost, LAVA_AROUND, CLIFF_SIDES } from './shared'

function updateMovements (this: Session, force = false): void {
    const bot = this.bot
    if (!bot || !bot.pathfinder) return
    const items = bot.inventory ? bot.inventory.items() : []
    const canDig = items.some(i => /_(pickaxe|shovel|axe)$/.test(i.name))
    // Арена (ND_SCAFFOLD_ANY=1): столбы и мосты pathfinder ставит и блоками постройки (build.ARENA_FILLER).
    const arenaScaffold = process.env.ND_SCAFFOLD_ANY === '1'
    const scaffold = items
      .filter(i => /^(dirt|cobblestone|cobbled_deepslate|netherrack|stone|oak_planks|spruce_planks|birch_planks)$/.test(i.name) || (arenaScaffold && (require('../build') as typeof import('../build')).ARENA_FILLER.test(i.name)))
      .reduce((n, i) => n + i.count, 0)
    const towers = scaffold >= 8

    const mlg = edges.mlgDrop(this)
    const free = freeDrop(bot)
    const dropDown = mlg.ok ? Math.max(mlg.drop, free) : (bot.health ?? 20) <= 6 ? 3 : free
    if (mlg.toBar && !bot.currentWindow && bot._ndFallGuard && bot._ndFallGuard.toHotbar) bot._ndFallGuard.toHotbar().catch(() => {})
    if (bot.pathfinder.movements) bot.pathfinder.movements.maxDropDown = dropDown
    if (this.dropSet !== dropDown || mlg.why !== this.dropWhy) console.log('[mlg] cap', JSON.stringify({ at: 'update', drop: dropDown, was: this.dropSet, why: mlg.why || null }))
    this.dropSet = dropDown
    this.dropWhy = mlg.why
    const bridge = this.bridgeWanted ?? blockmoves.on()
    const foods = (bot.registry && bot.registry.foodsByName) || {}
    const fed = (bot.food ?? 20) >= 14 || items.some(i => foods[i.name] && !/^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew|chorus_fruit)$/.test(i.name))
    const swampy = (p) => { if (!p) return false; try { return /swamp|mangrove/.test(biomeName(bot, p) || '') } catch { return false } }
    const marsh = this.sprintWanted === undefined && (swampy(bot.entity && bot.entity.position) || swampy(this.gotoTarget))
    const sprint = !!(this.sprintWanted ?? sprintOn(worlds.worldOf(bot))) && (bot.food ?? 20) > 6 && fed && !marsh
    const signature = `${canDig}:${towers}:${worlds.worldOf(bot)}:${mlg.ok}:${bridge ? 1 : 0}:${sprint ? 1 : 0}:${this.surfaceStrict ? 1 : 0}:${JSON.stringify(this.gotoArena ?? null)}:${arenaScaffold ? [...new Set(items.filter(i => (require('../build') as typeof import('../build')).ARENA_FILLER.test(i.name)).map(i => i.name))].sort().join() : ''}`
    if (!force && signature === this.movementsSignature) return
    this.movementsSignature = signature

    const movements = new Movements(bot)
    // Блоки pathfinder'а — из кеша тела, ответы те же (fastblocks.ts, S9; ND_S9=0 — bot.blockAt на каждую клетку).
    fastblocks.wrapMovements(bot, movements)
    const defAt = fastblocks.defReader(bot)
    if (process.env.ND_ROUTE === '1' && process.env.ND_WORLD_SEED && process.env.ND_ROUTE_OUTPOSTPATH !== '0' && worlds.worldOf(bot) === 'overworld' && Array.isArray(movements.exclusionAreasStep)) {
      const route: typeof import('../route') = require('../route')
      if (!this.routeOutpostInfo) this.routeOutpostInfo = route.routeInfo(process.env.ND_WORLD_SEED)
      movements.exclusionAreasStep.push(block => {
        const at = block && (block.position || block)
        const from = bot.entity && bot.entity.position
        return at && from ? route.outpostStepCost(this.routeOutpostInfo, from, at) : 0
      })
    }
    movements.canDig = canDig && !this.surfaceStrict
    movements.allow1by1towers = towers && !this.surfaceStrict
    if (arenaScaffold) movements.scafoldingBlocks = [...new Set([...(movements.scafoldingBlocks || []), ...items.filter(i => (require('../build') as typeof import('../build')).ARENA_FILLER.test(i.name)).map(i => i.type)])]
    movements.maxDropDown = dropDown
    movements.allowSprinting = sprint
    // чем моб опаснее (flee.js DOCTRINE). Раньше маршрут шёл сквозь толпу, и
    if (Array.isArray(movements.exclusionAreasStep)) movements.exclusionAreasStep.push(flee.mobAvoidance(bot))
    if (Array.isArray(movements.exclusionAreasStep)) movements.exclusionAreasStep.push(block => this.surfaceWalk ? underRoofCost(bot, block, this.surfaceStrict) : 0)
    // Разведка поверху не спускается в овраг: клетка на 10+ ниже начала отрезка — дороже (не запрет: спуск с горы остаётся);
    // cl-ae 14.10: отрезок разведки построек ушёл с y 74 на 50 в пещеру со скелетом, зомби и крипером — смерть на 5-й мин, днём.
    if (Array.isArray(movements.exclusionAreasStep)) movements.exclusionAreasStep.push(block => this.surfaceWalk && typeof this.scoutFromY === 'number' && block?.position && block.position.y < this.scoutFromY - 10 ? 10 : 0)
    // Путь по дну водоёма: воздух кончается за ~9 с, тактика всплывает и рвёт goto, кампания зовёт тот же путь снова
    // (cl-e 14.10: 20 кругов «к деревне по дну озера» → Surface → берег за 3 мин). Клетка воды под водой — ещё цена воды
    // сверху (liquidCost), чтобы путь плыл поверху или шёл в обход.
    if (Array.isArray(movements.exclusionAreasStep)) movements.exclusionAreasStep.push(block => {
      if (process.env.ND_WATER_ESCAPE_BUDGET !== '0') return Math.max(waterStepCost(bot, block),
        block?.position && waterCell(block) && waterCell(bot.blockAt(block.position.offset(0, 1, 0), false)) ? (movements.liquidCost ?? 1) : 0)
      if (!block || block.name !== 'water' || !block.position) return 0
      const above = bot.blockAt(block.position.offset(0, 1, 0), false)
      return above && above.name === 'water' ? (movements.liquidCost ?? 1) : 0
    })
    if (Array.isArray(movements.exclusionAreasStep)) {
      const fbm = bot._ndFastBlocks
      // На Block из кеша — память цены лавы (версия кеша fastblocks, флаг строгости, цена).
      movements.exclusionAreasStep.push((block: import('mineflayer-pathfinder').SafeBlock & { _ndLavaVer?: number; _ndLavaK?: boolean; _ndLavaV?: number }) => {
        const p = block && block.position
        if (!p) return 0
        // Цена зависит только от блоков вокруг и флага строгости — по памяти на Block из кеша, пока мир не менялся
        // (fastblocks: версия растёт на любом сбросе кеша). Описание блока — по номеру состояния, а не Block
        // (fastblocks.defReader): 5 клеток на кандидата — 21 % CPU маршрута.
        const strict = !!bot._ndLavaStrict
        if (fbm && fbm.live && block._ndLavaVer === fbm.ver && block._ndLavaK === strict) return block._ndLavaV
        const v = lavaStepCost(p, strict)
        if (fbm && fbm.live) { block._ndLavaVer = fbm.ver; block._ndLavaK = strict; block._ndLavaV = v }
        return v
      })
    }
    function lavaStepCost (p, strict) {
      for (const [dx, dy, dz] of LAVA_AROUND) {
        const b = defAt(p.x + dx, p.y + dy, p.z + dz)
        // _ndLavaStrict (бастион над лавовым морем: две смерти «tried to swim
        // in lava» на подходе к стене, ферма 29.09) — обходить почти любой ценой.
        if (b && b.name === 'lava') return strict ? 200 : 8
      }
      if (strict) {
        for (let d = 1; d <= 14; d++) {
          const b = defAt(p.x, p.y - d, p.z)
          if (!b) break
          if (b.name === 'lava') return 1000
          if (b.boundingBox === 'block') break
        }
        // Край обрыва (рядом клетка без пола на 3 вниз): шар гаста отбрасывает на 2–3 бл. — с края тело падало в лавовое
        // море с y 70–87 (b4g-6-2, b6-7-1 14.10: лава в 40–60 бл. ниже — проверка колонны выше её не видит). Дороже, не запрет.
        for (const [dx, dz] of CLIFF_SIDES) {
          const n = defAt(p.x + dx, p.y, p.z + dz)
          if (!n || n.boundingBox !== 'empty') continue
          let floor = false
          for (let d = 1; d <= 3 && !floor; d++) { const b = defAt(p.x + dx, p.y - d, p.z + dz); floor = !b || b.boundingBox === 'block' }
          if (!floor) return 30
        }
      }
      return 0
    }
    if (Array.isArray(movements.exclusionAreasPlace)) {
      movements.exclusionAreasPlace.push(block => {
        const p = block && block.position
        if (!p) return 0
        if (/lava/.test(block.name || '')) return 1000
        const under = defAt(p.x, p.y - 1, p.z)
        if (under && /lava/.test(under.name)) return 1000
        for (let d = 1; d <= 5; d++) {
          const b = defAt(p.x, p.y - d, p.z)
          if (!b || b.boundingBox !== 'empty') return 0
        }
        return 100
      })
    }
    // Порталы и огонь душ pathfinder считает пустотой и шагал бы сквозь них
    // (worlds.js tuneMovements): в портал тело входит только mc_portal enter.
    worlds.tuneMovements(bot, movements)
    // Прыжок глубже обычного — дороже шага на время воды (edges.priceDrops).
    edges.priceDrops(movements, () => this.surfaceWalk && this.pathGoalY == null)
    // Мост над смертельной высотой не строим ни в одном мире: срыв или отказ сервера = смерть (Ад S1f; верхний мир cl-f 14.10:
    // мост над оврагом 58 бл. на y 16 за железом, no_face — падение 58, смерть). Над водой — можно.
    if (bridge && !this.surfaceStrict) { blockmoves.addBridge(movements, { reserve: packMod.RESERVE.build, depthMax: worlds.worldOf(bot) === 'the_nether' ? 64 : 24, voidOk: worlds.worldOf(bot) !== 'the_end', goalY: () => this.pathGoalY, ...(process.env.ND_BRIDGE_LETHAL !== '0' ? { lethalDepth: 20 } : {}) }); blockmoves.install(this) }
    if (this.surfaceStrict) { movements.canDig = false; movements.allow1by1towers = false; movements.scafoldingBlocks = [] }
    if (this.gotoArena) {
      const arena = this.gotoArena, within = (require('../navigation/parkour') as typeof import('../navigation/parkour')).withinArena
      const cost = block => { const p = block?.position; return p && within(bot, { x: p.x + .5, y: p.y, z: p.z + .5 }, arena) ? 0 : Infinity }
      movements.exclusionAreasStep.push(cost)
      movements.exclusionAreasPlace.push(cost)
      movements.exclusionAreasBreak.push(cost)
      const neighbors = movements.getNeighbors.bind(movements)
      movements.getNeighbors = node => {
        const p = bot.entity.position
        const from = node.x === Math.floor(p.x) && node.y === Math.floor(p.y) && node.z === Math.floor(p.z) ? p : { x: node.x + .5, y: node.y, z: node.z + .5 }
        return neighbors(node).filter(n => within(bot, { x: n.x + .5, y: n.y, z: n.z + .5 }, arena, from))
      }
    }
    movements.exclusionAreasStep.push(blk => this.stuckPenalty(blk))
    bot.pathfinder.setMovements(movements)
    this.movements = this.gotoArena ? { canDig: movements.canDig, towers: movements.allow1by1towers, mlg: mlg.ok, bridge: false } : { canDig, towers, mlg: mlg.ok, bridge }
}

function stuckPenalty (this: Session, blk): number {
    if (!this.stuckCells?.size || !blk || !blk.position) return 0
    const k = `${blk.position.x},${blk.position.y},${blk.position.z}`
    const until = this.stuckCells.get(k)
    if (!until) return 0
    if (until < gameClock.now()) { this.stuckCells.delete(k); return 0 }
    return 30
}

function refreshDrop (this: Session): void {
    const bot = this.bot
    const mv = bot && bot.pathfinder && bot.pathfinder.movements
    if (!mv || this.dropSet == null) return
    if (mv.maxDropDown !== this.dropSet) {
      if (this.dropForeign !== mv.maxDropDown) console.log('[mlg] cap', JSON.stringify({ at: 'foreign', have: mv.maxDropDown, mine: this.dropSet }))
      this.dropForeign = mv.maxDropDown
      return
    }
    this.dropForeign = null
    const mlg = edges.mlgDrop(this)
    if (mlg.retryMs) this.dropRetry(mlg.retryMs)
    // Ведро выпало из хотбара посреди дела (сервер откатил клик, рюкзак
    // разобрали) — вернуть, а готовность проверит следующее событие слота.
    if (mlg.toBar && !bot.currentWindow && bot._ndFallGuard && bot._ndFallGuard.toHotbar) bot._ndFallGuard.toHotbar().catch(() => {})
    const free = freeDrop(bot)
    const drop = mlg.ok ? Math.max(mlg.drop, free) : (bot.health ?? 20) <= 6 ? 3 : free
    const was = mv.maxDropDown
    if (drop === was && !this.dropRecheck) return
    const moving = bot.pathfinder.isMoving && bot.pathfinder.isMoving()
    if (drop !== was) {
      mv.maxDropDown = drop
      this.dropSet = drop
      this.dropWhy = mlg.why
      console.log('[mlg] cap', JSON.stringify({ at: 'refresh', drop, was, why: mlg.why || null, moving }))
      // Ведро только что стало готово — путь по лестнице переложить на прыжок.
      if (moving && drop > was && was <= 4) {
        try { bot.pathfinder.setMovements(mv) } catch {}
        return
      }
      if (drop > was) return
    }
    const path = this.pathNodes
    this.dropRecheck = false
    if (!Array.isArray(path) || !path.length || !moving || !bot.entity) return
    if (!bot.entity.onGround && !bot.entity.isInWater) {
      // Не дольше 10 с: планер, лодка, лестница — «в воздухе» надолго.
      if (!this.dropRecheck) this.dropRecheckSince = gameClock.now()
      if (gameClock.now() - this.dropRecheckSince < 10000) {
        this.dropRecheck = true
        this.dropRetry(100)
      }
      return
    }
    // maxDropDown = N пускает ноги вниз не больше чем на N − 1.
    let y = Math.floor(bot.entity.position.y + 1e-3)
    for (const n of path) {
      if (y - n.y >= drop) {
        try { bot.pathfinder.setMovements(mv) } catch {}
        return
      }
      y = n.y
    }
}

function dropRetry (this: Session, ms): void {
    if (this.dropRetryTimer && !this.dropRetryTimer.clock?.disposed) return
    this.dropRetryTimer = gameClock.setTimeout(() => { this.dropRetryTimer = null; try { this.refreshDrop() } catch {} }, ms)
}

function watchDrop (this: Session): void {
    const bot = this.bot
    if (!bot || bot._ndDropWatch) return
    bot._ndDropWatch = true
    let queued = false
    const later = () => {
      if (queued) return
      queued = true
      gameClock.setTimeout(() => { queued = false; try { this.refreshDrop() } catch {} }, 0)
    }
    // Узлы пути пишет notePath (wire): здесь же писали lastPath = r.path, но обработчик wire, подписанный позже,
    // тут же затирал его сводкой поиска.
    bot.on('health', later)
    bot.on('game', later)
    bot.on('respawn', later)
    try { bot.inventory.on('updateSlot', (slot, was, now) => { if ((was && /bucket$/.test(was.name)) || (now && /bucket$/.test(now.name))) later() }) } catch {}
}

// Итог поиска pathfinder'а: pathNodes — сами узлы (живой массив исполнителя: steerIntoDig, refreshDrop),
// lastPath — сводка для журнала и диагностики.
function notePath (this: Session, r): void {
    this.pathNodes = r && Array.isArray(r.path) ? r.path : null
    this.lastPath = r ? {
      status: r.status,
      cost: Math.round(r.cost),
      visited: r.visitedNodes,
      generated: r.generatedNodes,
      length: r.path ? r.path.length : 0,
      ms: Math.round(r.time)
    } : null
}

export { updateMovements, stuckPenalty, refreshDrop, dropRetry, watchDrop, notePath }
