'use strict'
const gameClock = require('./game-clock')
const { resultCode } = require('./session/results')
const mineflayer = require('mineflayer')
const { Movements, goals } = require('mineflayer-pathfinder')
const tickPlugins = require('./tick-plugins')
const { pathfinder } = tickPlugins
const mcDataLoader = require('minecraft-data')
const Vec3 = require('vec3')
const { observe, stateSummary, biomeName } = require('./perception')
const { xyz, standableY, stuckGuard, unstick, escapeWater, inWater, gotoGoal, gotoWaitOn, sprintOn, pathKeepAlive } = require('./movement')
const actions = require('./actions')
const combat = require('./combat')
const { escapePit, withTimeout } = require('./build')
const mining = require('./mining')
const survival = require('./survival')
const containers = require('./containers')
const armor = require('./armor')
const { escort } = require('./escort')
const social = require('./social')
const nether = require('./nether')
const handover = require('./handover')
const gear = require('./preflight')
const flee = require('./flee')
const stronghold = require('./stronghold')
const obsidianMod = require('./obsidian')
const gamedata = require('./gamedata')
const packMod = require('./pack')
const fauna = require('./fauna')
const bow = require('./bow')
const throwMod = require('./throw')
const prepMod = require('./prep')
const lootMod = require('./loot')
const worlds = require('./worlds')
const edges = require('./edges')
const blockmoves = require('./blockmoves')
const hopgoto = require('./hopgoto')
const blazeMod = require('./blaze')
const endportal = require('./endportal')
const fortressMod = require('./fortress')
const pearlsMod = require('./pearls')
const bastionMod = require('./bastion')
const dragonMod = require('./dragon')
const architect = require('./architect')
const sorting = require('./sorting')
const farmMod = require('./farm')
const rideMod = require('./ride')
const mechanismMod = require('./mechanism')
const playPolicy = require('./play-policy')

// Abortable sleep. The shared helper in movement.js has no cancellation, and
function sleep (ms, ctl?: any) {
  if (ctl?.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve() })
  })
}

function steerIntoDig (entity, node) {
  if (!entity || !node || !Array.isArray(node.toBreak) || !node.toBreak.length) return null
  if (entity.onGround || entity.isInWater || entity.isInLava) return null
  const p = entity.position
  const v = entity.velocity || { x: 0, z: 0 }
  const cx = Math.floor(node.x) + 0.5
  const cz = Math.floor(node.z) + 0.5
  // Колонна узла — под ногами или рядом (≤ 1.5 бл.): это и есть падение в свою клетку, а не прыжок пути.
  if (Math.hypot(cx - p.x, cz - p.z) > 1.5) return null
  // Прогноз посадки без клавиш: в воздухе скорость ×0.91 за тик, до пола — несколько тиков.
  const ex = p.x + v.x * 4
  const ez = p.z + v.z * 4
  const dx = cx - ex
  const dz = cz - ez
  const off = Math.hypot(dx, dz)
  return { yaw: Math.atan2(-dx, -dz), forward: off > 0.2 }
}

// leaves the bag in a state nobody can describe. Health, death, a kick and a
const HOLDING = ['chat', 'low_health', 'death', 'kicked', 'disconnected']
// Зачарование, варка, сборы: окно посреди кликов не бросаем из-за реплики.
const WORKBENCH = ['damage', 'low_health', 'death', 'kicked', 'disconnected']

// Короткая пометка мира для имени места: «лагерь (ад)».
const worldsTag = dim => ({ overworld: 'верх', the_nether: 'ад', the_end: 'край' })[dim] || dim

function skyLightAt (bot, p) {
  let col
  try { col = bot.world.getColumnAt(p) } catch { return null }
  if (!col) return null
  const sky = col.skyLightSections
  if (!sky || !sky[Math.floor((p.y - (col.minY ?? -64)) / 16) + 1]) return 15
  const b = bot.blockAt(p)
  return b && typeof b.skyLight === 'number' ? b.skyLight : 15
}

// Штраф шага перехода поверху: клетка тела без неба (skyLight ≤ 7 — в
// пещере 0, под листвой 12-14, в устье пещеры убывает на блок за блок).
const ROOF_STEP_COST = 1.5
function underRoofCost (bot, block, strict = false) {
  if (!block || !block.position || typeof block.skyLight !== 'number' || block.skyLight > 7) return 0
  const s = skyLightAt(bot, block.position)
  return s !== null && s <= 7 ? (strict ? 100 : ROOF_STEP_COST) : 0
}

// Holds the body. One Session == one bot on one server.
class Session {
  declare replanRevision: number
  declare tactics: import('./tactics/minecraft').TacticalSystem

  declare cfg: any
  declare bus: any
  declare journal: any
  declare bot: any
  declare mcData: any
  declare current: any
  declare lastHealth: any
  declare connecting: any
  declare playPolicy: any
  declare temper: any
  declare director: any
  declare autopilot: any
  declare dropSet: any
  declare dropWhy: any
  declare bridgeWanted: any
  declare sprintWanted: any
  declare gotoTarget: any
  declare movementsSignature: any
  declare routeOutpostInfo: any
  declare surfaceWalk: any
  declare surfaceStrict: any
  declare pathGoalY: any
  declare movements: any
  declare dropForeign: any
  declare dropRecheck: any
  declare pathNodes: any
  declare dropRecheckSince: any
  declare dropRetryTimer: any
  declare lastPath: any
  declare lastDeath: any
  declare pendingCause: any
  declare respawnNudge: any
  declare ticks: any
  declare steerSaid: any
  declare bagFullSaid: any
  declare pathKeep: any
  declare followGoal: any
  declare reflex: any
  declare crafting: any
  declare eating: any

  constructor (cfg, bus, journal) {
    this.cfg = cfg
    this.bus = bus
    this.journal = journal
    this.bot = null
    this.mcData = null
    this.current = null
    this.lastHealth = 20
    this.connecting = null
    this.replanRevision = 0
    this.tactics = new (require('./tactics/minecraft').TacticalSystem)(this)
    this.playPolicy = playPolicy.configure(journal.state?.playPolicy)
    // Характер: как бот отвечает человеку, который его бьёт (autopilot.js
    // provoked). Меняется через mc_temper, живёт до перезапуска демона.
    this.temper = {
      enabled: true,
      firstHitChance: 0.35,
      windowMs: 30000,
      fightSeconds: 90,
      calmAfterMs: 12000,
      retreatAtHealth: 4,
      // Вступаться за игрока рядом, когда его бьёт моб (gestures.js).
      defend: true
    }
  }

  // Посмотреть или поменять характер. Числа проверяются здесь, а не в MCP:
  // демон зовут и сцены, мимо схемы.
  setTemper (p: any = {}) {
    const t = this.temper
    if (typeof p.enabled === 'boolean') t.enabled = p.enabled
    if (typeof p.firstHitChance === 'number') t.firstHitChance = Math.max(0, Math.min(1, p.firstHitChance))
    if (typeof p.windowSeconds === 'number') t.windowMs = Math.max(5, p.windowSeconds) * 1000
    if (typeof p.fightSeconds === 'number') t.fightSeconds = Math.max(10, Math.min(300, p.fightSeconds))
    if (typeof p.calmSeconds === 'number') t.calmAfterMs = Math.max(3, p.calmSeconds) * 1000
    if (typeof p.retreatAtHealth === 'number') t.retreatAtHealth = Math.max(1, Math.min(19, p.retreatAtHealth))
    if (typeof p.defend === 'boolean') t.defend = p.defend
    return this.immediate(async () => ({
      enabled: t.enabled,
      firstHitChance: t.firstHitChance,
      windowSeconds: t.windowMs / 1000,
      fightSeconds: t.fightSeconds,
      calmSeconds: t.calmAfterMs / 1000,
      retreatAtHealth: t.retreatAtHealth,
      defend: t.defend,
      now: this.current && this.current.name === 'retaliate' ? `дерусь с ${this.current.target}` : null
    }))
  }

  setPlayMode (p: any = {}) {
    const next = playPolicy.configure(this.playPolicy, p)
    return this.immediate(async () => {
      if (next.mode !== this.playPolicy.mode) {
        this.cancel()
        if (next.mode === 'free') this.director?.stop()
      }
      this.playPolicy = next
      if (this.bot) this.bot.ndPlayPolicy = next
      this.journal.patch(s => { s.playPolicy = next })
      return { playPolicy: next }
    })
  }

  // ---------------------------------------------------------------- lifecycle

  connect () {
    if (this.connecting) return this.connecting
    if (this.bot && this.bot.entity) return Promise.resolve({ already: true, state: this.state() })

    this.connecting = new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        version: this.cfg.version,
        auth: this.cfg.auth,
        plugins: tickPlugins.plugins,
        hideErrors: false
      })
      this.bot = bot
      gameClock.bind(bot)
      // Autopilot starts before connect. Replace its initial wall timer with
      // this connection's game timer, also on every reconnect.
      this.autopilot?.stop()
      this.autopilot?.start()
      this.wireHealth(bot)
      bot.ndPlayPolicy = this.playPolicy
      require('./client-loaded').install(bot)
      // Поправка данных игры до первого блока: у руд и обсидиана не тот
      // материал, и копка шла в 6-8 раз дольше ванильной (gamedata.js).
      gamedata.fixMaterials(bot.registry)
      bot.once('inject_allowed', () => gamedata.fixMaterials(bot.registry))
      // Доски из ободранного бревна и древесины — рецепт из тега (gamedata.js).
      bot.once('inject_allowed', () => { try { gamedata.fixPlanks(bot.registry); gamedata.fixWhiteWool(bot.registry) } catch {} })
      // Имена атрибутов в пакете (скорость и прочее) — gamedata.js.
      bot.once('inject_allowed', () => { try { gamedata.fixAttributes(bot) } catch {} })
      bot.once('inject_allowed', () => { try { gamedata.fixBreath(bot) } catch {} })
      bot.loadPlugin(pathfinder)

      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        if (this.bot === bot) this.bot = null
        reject(err)
      }

      bot.once('spawn', async () => {
        if (settled) return
        try {
          try { if (bot.physics) bot.physics.playerHalfWidth = Math.fround(0.6) / 2 } catch {}
          require('./swimming').install(bot)
          // Предметы на земле: скорость из пакета появления и физика полёта (drops.js) —
          // иначе брошенное видно в точке броска до секунды.
          try { require('./drops').install(bot) } catch {}
          // Рюкзак после окон сверяется с сервером (invsync.js): иначе верстак,
          // кирка и прочее «пропадают» у клиента, оставаясь у сервера.
          try { require('./invsync').install(bot) } catch {}
          // Сколько секунд куча после смерти реально тикала (lootclock.js).
          try { require('./lootclock').install(this) } catch {}
          // Кровать-точка возрождения: сервер сбросил — забыть (bedtime.js).
          try { require('./bedtime').install(this) } catch {}
          // Постройки игры глазами раз в 8 с → память и structure_seen (structures.js).
          try { require('./structures').install(this) } catch {}
          // Слез / сброшен / телепортирован из седла — mineflayer этого не видит
          // (ride.js patchVehicle): без правки bot.vehicle висит вечно.
          try { rideMod.patchVehicle(bot) } catch {}
          this.mcData = mcDataLoader(bot.version)
          this.updateMovements(true)
          this.watchDrop()
          this.wire()
          this.tactics.attach(bot)
          await withTimeout(bot.waitForChunksToLoad(), 12000, 'чанки вокруг игрока не загрузились — вход не готов', gameClock.wall)
          await this.waitUntilWorldLoaded(10000)
          if (settled || this.bot !== bot) return
          this.journal.append('вход', `зашёл на сервер как ${bot.username} (${bot.version})`, bot.entity.position)
          settled = true
          resolve({ ok: true, state: this.state() })
        } catch (err) {
          fail(err)
          try { bot.quit('вход не готов') } catch {}
        }
      })
      bot.once('error', fail)
      bot.once('kicked', reason => fail(new Error('kicked: ' + JSON.stringify(reason))))
      bot.once('end', reason => fail(new Error('вход прерван: ' + String(reason))))
    }).finally(() => { this.connecting = null })

    return this.connecting
  }

  updateMovements (force = false) {
    const bot = this.bot
    if (!bot || !bot.pathfinder) return
    const items = bot.inventory ? bot.inventory.items() : []
    const canDig = items.some(i => /_(pickaxe|shovel|axe)$/.test(i.name))
    const scaffold = items
      .filter(i => /^(dirt|cobblestone|cobbled_deepslate|netherrack|stone|oak_planks|spruce_planks|birch_planks)$/.test(i.name))
      .reduce((n, i) => n + i.count, 0)
    const towers = scaffold >= 8

    const mlg = edges.mlgDrop(this)
    const dropDown = mlg.ok ? mlg.drop : (bot.health ?? 20) <= 6 ? 3 : 4
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
    const sprint = !!(this.sprintWanted ?? sprintOn(worlds.worldOf(bot))) && fed && !marsh
    const signature = `${canDig}:${towers}:${worlds.worldOf(bot)}:${mlg.ok}:${bridge ? 1 : 0}:${sprint ? 1 : 0}`
    if (!force && signature === this.movementsSignature) return
    this.movementsSignature = signature

    const movements = new Movements(bot)
    if (process.env.ND_ROUTE === '1' && process.env.ND_WORLD_SEED && process.env.ND_ROUTE_OUTPOSTPATH !== '0' && worlds.worldOf(bot) === 'overworld' && Array.isArray(movements.exclusionAreasStep)) {
      const route = require('./route')
      if (!this.routeOutpostInfo) this.routeOutpostInfo = route.routeInfo(process.env.ND_WORLD_SEED)
      movements.exclusionAreasStep.push(block => {
        const at = block && (block.position || block)
        const from = bot.entity && bot.entity.position
        return at && from ? route.outpostStepCost(this.routeOutpostInfo, from, at) : 0
      })
    }
    movements.canDig = canDig
    movements.allow1by1towers = towers
    movements.maxDropDown = dropDown
    movements.allowSprinting = sprint
    // чем моб опаснее (flee.js DOCTRINE). Раньше маршрут шёл сквозь толпу, и
    if (Array.isArray(movements.exclusionAreasStep)) movements.exclusionAreasStep.push(flee.mobAvoidance(bot))
    if (Array.isArray(movements.exclusionAreasStep)) movements.exclusionAreasStep.push(block => this.surfaceWalk ? underRoofCost(bot, block, this.surfaceStrict) : 0)
    if (Array.isArray(movements.exclusionAreasStep)) {
      movements.exclusionAreasStep.push(block => {
        const p = block && block.position
        if (!p) return 0
        for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
          const b = bot.blockAt(p.offset(dx, dy, dz))
          // _ndLavaStrict (бастион над лавовым морем: две смерти «tried to swim
          // in lava» на подходе к стене, ферма 29.09) — обходить почти любой ценой.
          if (b && b.name === 'lava') return bot._ndLavaStrict ? 200 : 8
        }
        if (bot._ndLavaStrict) {
          for (let d = 1; d <= 14; d++) {
            const b = bot.blockAt(p.offset(0, -d, 0))
            if (!b) break
            if (b.name === 'lava') return 1000
            if (b.boundingBox === 'block') break
          }
        }
        return 0
      })
    }
    if (Array.isArray(movements.exclusionAreasPlace)) {
      movements.exclusionAreasPlace.push(block => {
        const p = block && block.position
        if (!p) return 0
        if (/lava/.test(block.name || '')) return 1000
        const under = bot.blockAt(p.offset(0, -1, 0))
        if (under && /lava/.test(under.name)) return 1000
        for (let d = 1; d <= 5; d++) {
          const b = bot.blockAt(p.offset(0, -d, 0))
          if (!b || b.boundingBox !== 'empty') return 0
        }
        return 100
      })
    }
    // Порталы и огонь душ pathfinder считает пустотой и шагал бы сквозь них
    // (worlds.js tuneMovements): в портал тело входит только mc_portal enter.
    worlds.tuneMovements(bot, movements)
    // Прыжок глубже обычного — дороже шага на время воды (edges.priceDrops).
    edges.priceDrops(movements)
    if (bridge) { blockmoves.addBridge(movements, { reserve: packMod.RESERVE.build, depthMax: worlds.worldOf(bot) === 'the_nether' ? 64 : 24, voidOk: worlds.worldOf(bot) !== 'the_end', goalY: () => this.pathGoalY }); blockmoves.install(this) }
    bot.pathfinder.setMovements(movements)
    this.movements = { canDig, towers, mlg: mlg.ok, bridge }
  }

  refreshDrop () {
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
    const drop = mlg.ok ? mlg.drop : (bot.health ?? 20) <= 6 ? 3 : 4
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

  dropRetry (ms) {
    if (this.dropRetryTimer && !this.dropRetryTimer.clock?.disposed) return
    this.dropRetryTimer = gameClock.setTimeout(() => { this.dropRetryTimer = null; try { this.refreshDrop() } catch {} }, ms)
  }

  watchDrop () {
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
  notePath (r) {
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

  noteDeathCause () {
    const d = this.lastDeath
    const c = this.pendingCause
    if (!d || !c || d.causeNoted || Math.abs(d.at - c.at) > 5000) return
    // Строка о себе, но не всякая — только о смерти (death.* в en_us).
    if (!/died|slain|shot|blew up|fell|burn|lava|drown|suffocat|killed|pricked|froze|starved|withered|impaled|squashed|fireball|flames|hit the ground|swim|struck|walked into|squished|poked|skewered|obliterated|experienced kinetic/i.test(c.text)) return
    d.causeNoted = true
    try {
      this.journal.patch(s => {
        const rec = s.deaths && s.deaths[s.deaths.length - 1]
        if (rec && !rec.cause) rec.cause = c.text
        if (/lava/i.test(c.text) && d.pos && (d.dimension || 'overworld') === 'overworld') {
          s.places = s.places || {}
          if (!s.places['лава']) s.places['лава'] = { x: d.pos.x, y: d.pos.y, z: d.pos.z, dimension: 'overworld', note: `сгорел тут: ${c.text}` }
        }
      })
    } catch {}
  }

  underSky () {
    const bot = this.bot
    if (!bot || !bot.entity || !bot.game || bot.game.dimension !== 'overworld') return false
    const s = skyLightAt(bot, bot.entity.position.offset(0, 1.62, 0).floored())
    return s !== null && s >= 12
  }

  // Blocks until the column we are standing in is actually readable, so the
  // first observe() after connect returns real terrain instead of nulls.
  async waitUntilWorldLoaded (timeoutMs = 10000) {
    const bot = this.bot
    const deadline = gameClock.wall.now() + timeoutMs
    while (gameClock.wall.now() < deadline) {
      try {
        const feet = bot.blockAt(bot.entity.position.offset(0, -1, 0))
        if (feet && (bot.health ?? 0) > 0) return true
      } catch {}
      await gameClock.wall.sleep(200)
    }
    return false
  }

  disconnect (reason = 'по команде') {
    this.cancel()
    if (this.bot) {
      this.journal.append('выход', reason, this.bot.entity && this.bot.entity.position)
      try { this.bot.quit(reason) } catch {}
      this.bot = null
    }
    return { ok: true }
  }

  wireHealth (bot) {
    if (bot.ndHealthTracked) return
    bot.ndHealthTracked = true
    let hit = null
    try {
      bot._client.on('damage_event', pk => {
        if (this.bot !== bot || !bot.entity || !pk || pk.entityId !== bot.entity.id) return
        const src = pk.sourceCauseId > 0 && bot.entities ? bot.entities[pk.sourceCauseId - 1] : null
        hit = { cause: gamedata.damageTypeName(pk.sourceTypeId) || `type_${pk.sourceTypeId}`, source: src ? (src.username || src.name) : null, at: gameClock.now() }
      })
    } catch {}
    // Mineflayer starts with hp20 before the first server update. That first
    // value is saved state, not an attack; track it before spawn as well.
    let last = null
    bot.on('health', () => {
      if (this.bot !== bot) return
      const hp = bot.health ?? 20
      if (last !== null && hp < last) {
        const typed = hit && gameClock.now() - hit.at <= 250 ? hit : null
        if (typed) hit = null
        // Принятый урон падения спуска (navigation/descent.ts, гибкость): не рвать им goto.
        const planned = bot._ndExpectFall && gameClock.now() < bot._ndExpectFall.until && last - hp <= bot._ndExpectFall.max && (!typed || typed.cause === 'fall')
        if (planned) console.log('[descent] принятый урон падения', JSON.stringify({ lost: last - hp, hp }))
        else this.bus.emit('damage', { health: Math.round(hp), lost: Math.round(last - hp), ...(typed ? { cause: typed.cause, ...(typed.source ? { source: typed.source } : {}) } : {}) })
      }
      if (last !== null && hp > 0 && hp <= this.cfg.lowHealth && last > this.cfg.lowHealth) {
        this.bus.emit('low_health', { health: Math.round(hp) })
      }
      last = hp
      this.lastHealth = hp
      // The initial dead state must still request respawn after the server
      // starts accepting client commands.
      if (hp <= 0 && !this.respawnNudge) {
        this.respawnNudge = gameClock.wall.setInterval(() => {
          if (this.bot !== bot || (bot.health ?? 20) > 0) { gameClock.wall.clearInterval(this.respawnNudge); this.respawnNudge = null; return }
          try { bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 }) } catch {}
        }, 3000)
      }
    })
  }

  wire () {
    const bot = this.bot
    this.wireHealth(bot)

    combat.trackAttackers(this)

    // В каком мире тело: событие dimension на «устроился», чистка сущностей
    // прошлого мира (worlds.js).
    worlds.installWorldTracker(this, bot)

    // Physics heartbeat. A frozen body and a body with no path look identical
    // from the outside; the tick rate tells them apart.
    this.ticks = 0
    bot.on('physicsTick', () => { this.ticks++ })
    // Падение в выкопанную клетку перед следующей копкой — не проезжать её (steerIntoDig выше). Узлы — живой массив
    // pathfinder'а (path_update отдаёт тот же массив, что он сдвигает по ходу).
    bot.on('physicsTick', () => {
      try {
        const nodes = this.pathNodes
        if (!nodes || !nodes.length || !bot.pathfinder || !bot.pathfinder.isMoving()) return
        const c = steerIntoDig(bot.entity, nodes[0])
        if (!c) return
        bot.look(c.yaw, bot.entity.pitch, true).catch(() => {})
        bot.setControlState('sprint', false)
        bot.setControlState('jump', false)
        bot.setControlState('back', false)
        bot.setControlState('left', false)
        bot.setControlState('right', false)
        bot.setControlState('forward', c.forward)
        if (!this.steerSaid || gameClock.now() - this.steerSaid > 5000) { this.steerSaid = gameClock.now(); console.log('[path] в воздухе перед копкой — веду в колонну узла', JSON.stringify({ at: nodes[0].x + ',' + nodes[0].y + ',' + nodes[0].z })) }
      } catch {}
    })

    // Ведро воды при падении с высоты — всегда, не только в бою (edges.js):
    // с арены в небе бот падал на землю и разбивался (2026-09-25).
    edges.installFallGuard(this)
    // Исполнитель моста на ходу — после сторожа падения (общая рука lockHand; сорвался — клатч раньше нас в тике).
    if (blockmoves.on()) blockmoves.install(this)
    // Своё отбрасывание — в полную силу, как у игрока (mineflayer делил его
    // на 8000: бот стоял под ударами как вкопанный, edges.fixSelfKnockback).
    edges.fixSelfKnockback(bot)
    // Предмет в ходу (еда, питьё, лук, щит) — ход ×0.2 и без спринта, как у
    // ванильного клиента (itemuse.js, просьба 2026-09-26 играть честно).
    require('./itemuse').install(bot)
    // Копать только самым быстрым инструментом (tools.js install): паутину —
    // мечом, а не булыжником в руке после столба (арена 2026-09-26).
    require('./tools').install(bot)
    // Удар только по тому, что клиент игры взял бы в прицел (pick.js): сервер
    // прямую видимость не проверяет, и боты били сквозь стенку коробки.
    require('./pick').install(bot)
    // Титры после выходного портала — всегда ответ perform_respawn (credits.ts): иначе игрок вне мира, часы стоят.
    require('./credits').install(bot)
    // Бег вприпрыжку на прямых ровных участках пути (sprintjump.js; по умолчанию вкл., ND_SPRINT_JUMP=0 — выкл.).
    try { require('./sprintjump').install(bot) } catch {}
    // Свет чанков — со своей перестановкой x (prismarine-chunk 1.41, lightfix.js).
    require('./lightfix').install(bot)
    // Заряженный арбалет — только прицельным выстрелом (ranged.guardCrossbow).
    require('./ranged').guardCrossbow(bot)
    // Install after tool/pick wrappers; attach for ALL intents, including gold,
    // pearls, ne_route/ne_burrow and crafting, not just bastion/farmRods callers.
    if (require('./reflex-lock').on()) require('./ne-guard').attach(this)
    bot.on('nd_mlg', (e) => console.log('[mlg]', JSON.stringify({ ...e, y: bot.entity && Math.round(bot.entity.position.y * 10) / 10, hp: bot.health })))

    // Рюкзак полон (pack.js через collectNearbyDrops): выбросил дешёвое ради
    // дорогого — факт; выбросить нечего — мозгу решать про схрон.
    bot.on('nd_tossed', (e) => this.bus.emit('tossed', e))
    bot.on('nd_bag_full', (e) => {
      const now = gameClock.now()
      if (this.bagFullSaid && now - this.bagFullSaid < 20000) return
      this.bagFullSaid = now
      this.bus.emit('bag_full', { ...e, text: `РЮКЗАК ПОЛОН: ${e.item}×${e.count} лежит на ${e.at.x},${e.at.y},${e.at.z}, а выкинуть дешевле нечего — поставь схрон (mc_cache) или разгрузись (mc_pack tidy)` })
    })

    bot.on('chat', (username, message, translate) => {
      if (username === bot.username) return
      if (translate === 'chat.type.admin') return
      this.bus.emit('chat', { from: username, text: message })
      this.journal.append('чат', `<${username}> ${message}`, bot.entity && bot.entity.position)
    })

    bot.on('whisper', (username, message) => {
      if (username === bot.username) return
      this.bus.emit('chat', { from: username, text: message, whisper: true })
    })

    // Возрождение: флаг копки pathfinder'а, оставшийся от копки до смерти, вешал все goto («застрял на air у air»,
    // isMining() навсегда — регрессия спуска 30.09). tools.install обрывает такую копку; здесь — страховка.
    bot.on('spawn', () => {
      if (require('./tools').unstickPathfinderDig(bot)) console.log('[path] флаг копки после смерти сброшен')
    })
    bot.on('death', () => {
      const pos = bot.entity ? xyz(bot.entity.position) : null
      this.bus.emit('death', { pos })
      this.journal.patch(s => {
        let bag = null
        try { bag = bot.inventory.items().map(i => ({ name: i.name, count: i.count })) } catch {}
        s.deaths.push({ at: new Date().toISOString(), pos, dimension: worlds.worldOf(bot), recovered: false, bag: bag || undefined })
        if (s.deaths.length > 50) s.deaths.splice(0, s.deaths.length - 50)
      })
      this.journal.append('смерть', `умер${pos ? '' : ' (координаты неизвестны)'}`, bot.entity && bot.entity.position)
      this.lastDeath = { at: gameClock.now(), pos, dimension: worlds.worldOf(bot) }
      this.noteDeathCause()
    })
    // Причина смерти — строка сервера «NeuroRun tried to swim in lava»; она
    // приходит рядом с update_health, раньше или позже него.
    bot.on('messagestr', (msg) => {
      const t = String(msg || '')
      if (!t.startsWith(bot.username + ' ') || t.length > 160) return
      this.pendingCause = { text: t, at: gameClock.now() }
      this.noteDeathCause()
    })

    bot.on('playerJoined', p => {
      if (p.username !== bot.username) this.bus.emit('player_joined', { username: p.username })
    })
    bot.on('playerLeft', p => this.bus.emit('player_left', { username: p.username }))

    bot.on('kicked', reason => {
      if (this.bot !== bot) return
      this.bus.emit('kicked', { reason: JSON.stringify(reason) })
      this.bot = null
    })
    bot.on('end', reason => {
      if (this.bot !== bot) return
      this.bus.emit('disconnected', { reason: String(reason) })
      this.bot = null
    })
    bot.on('error', err => {
      console.error('[bot error]', err && err.stack ? err.stack : String(err))
      this.bus.emit('error_event', { error: String((err && err.message) || err) })
    })

    // Узел-метка на ходу, пока поиск идёт: иначе pathfinder сбрасывает путь «stuck» через 3.5 с поиска, хотя тело
    // бежит по нему (movement.pathKeepAlive; ND_PATH_KEEPALIVE=0 — выкл.).
    this.pathKeep = pathKeepAlive(bot)
    // Pathfinder diagnostics. A goal that silently never moves the bot is the
    // hardest failure to read from the outside, so keep the raw search result.
    bot.on('path_update', r => {
      this.notePath(r)
      console.log('[path]', JSON.stringify(this.lastPath))
      // Отладка спуска (регрессия 30.09): узлы пути с копкой/стройкой — ND_DEBUG_PATH=1.
      if (process.env.ND_DEBUG_PATH && r.path && r.path.length) {
        const me = bot.entity ? bot.entity.position.floored() : null
        console.log('[path] nodes', JSON.stringify({ me, drop: bot.pathfinder.movements && bot.pathfinder.movements.maxDropDown,
          nodes: r.path.slice(0, 14).map(n => `${n.x},${n.y},${n.z}${n.toBreak && n.toBreak.length ? ' b' + n.toBreak.length : ''}${n.toPlace && n.toPlace.length ? ' p' + n.toPlace.length : ''}${n.ndBridge ? ' M' : ''}${n.ndDescend ? ' S' : ''}${n.parkour ? ' J' : ''}`) }))
      }
    })
    bot.on('goal_reached', () => console.log('[path] goal_reached'))
    bot.on('path_reset', reason => {
      console.log('[path] reset:', reason)
      // «stuck» — 3.5 с без нового узла: где тело и на каком узле встало (рельеф, mv-spr: несколько на ногу). Путь ещё
      // живой (resetPath шлёт событие до path = []).
      if (reason === 'stuck') {
        try {
          const e = bot.entity
          const n = Array.isArray(this.pathNodes) ? this.pathNodes.slice(0, 2) : []
          const nm = (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return b ? b.name : '?' }
          console.log('[stuck-node]', JSON.stringify({ pos: [e.position.x, e.position.y, e.position.z].map(v => Math.round(v * 100) / 100), g: e.onGround, w: !!e.isInWater,
            v: [e.velocity.x, e.velocity.y, e.velocity.z].map(v => Math.round(v * 100) / 100),
            nodes: n.map(q => ({ at: [q.x, q.y, q.z], b: q.toBreak ? q.toBreak.length : 0, p: q.toPlace ? q.toPlace.length : 0, j: !!q.parkour, br: !!q.ndBridge, d: !!q.ndDescend,
              feet: nm(q.x, q.y, q.z), head: nm(q.x, q.y + 1, q.z), under: nm(q.x, q.y - 1, q.z) })),
            c: ['forward', 'back', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState(k)) }))
        } catch {}
      }
    })
  }

  // ------------------------------------------------------------------- basics

  alive () {
    return !!(this.bot && this.bot.entity)
  }

  require () {
    if (!this.alive()) throw new Error('бот не в игре — сначала connect')
    return this.bot
  }

  state () {
    return stateSummary(this.bot, {
      goal: this.journal.state.goal,
      playPolicy: this.playPolicy,
      // События читают несколько наблюдателей; смерть не должна потеряться
      // после drain() или перезапуска тела. Журнал сохраняется на диске.
      lastDeathAt: this.journal.state.deaths?.at(-1)?.at || null,
      clock: this.bot?.ndClock?.snapshot() || null,
      // Физических тиков тела (physicsTick): доля от clock.ticks — сколько тиков
      // клиент не успел (часы пропускают их при нехватке CPU), S7 06.10.
      physicsTicks: this.ticks,
      busy: this.current ? this.current.name : null,
      tactics: this.tactics?.snapshot() || null
    })
  }

  // ------------------------------------------------------------ intent runner

  cancel () {
    require('./reflex-lock').cancel(this)
    this.followGoal = null
    if (this.current) {
      this.current.ctl.abort()
      this.current = null
    }
    if (this.bot) {
      try { this.bot.pathfinder.setGoal(null) } catch {}
      try { this.bot.clearControlStates() } catch {}
    }
  }

  // event fires (player chat, damage, low health, death, disconnect), or the
  runIntent (name, worker, options: any = {}) {
    return require('./session/intent-runner').runIntent.call(this, name, worker, options)
  }

  // Non-blocking action: does not cancel whatever is running.
  async immediate (worker) {
    const result: any = await Promise.resolve()
      .then(() => worker())
      .then(
        detail => ({ status: 'done', detail: detail ?? null }),
        err => ({ status: 'failed', error: String((err && err.message) || err) })
      )
    result.events = this.bus.drain()
    result.state = this.state()
    return result
  }

  // ------------------------------------------------------------------ intents

  say (text, to = null) {
    return this.immediate(async () => {
      const bot = this.require()
      const body = String(text).slice(0, 250)
      if (to) bot.whisper(String(to), body)
      else bot.chat(body)
      this.journal.append('чат', `<${bot.username}> ${text}`, bot.entity.position)
      return { said: text }
    })
  }

  // runIntent's clock ran out, and on an abort it throws — so the report was
  goto ({ x, y, z, range = 2, timeoutSeconds = 90, surface, bridge, pathWait, pearl, sprint, sprintJump, descent, unstuck: unstuckWanted }: any) {
    const secs = Math.max(5, Math.min(600, timeoutSeconds))
    return this.runIntent('goto', async (ctl) => {
      const bot = this.require()
      const deadline = gameClock.now() + secs * 1000
      // Мост на ходу на этот переход (сцены A/B на одном демоне): bridge true/false поверх ND_BRIDGE; не задан —
      // как в окружении. Держится до следующего goto.
      this.bridgeWanted = typeof bridge === 'boolean' ? bridge : undefined
      this.sprintWanted = typeof sprint === 'boolean' ? sprint : undefined
      // Бег вприпрыжку на этот переход (A/B в одном сеансе, try-parkour-sprint): поверх ND_SPRINT_JUMP.
      bot._ndSprintJumpWanted = typeof sprintJump === 'boolean' ? sprintJump : undefined
      // Цель — для выбора бега (болото у цели — шагом), высота — тела, если не задана.
      this.gotoTarget = bot.entity ? new Vec3(Math.floor(x) + 0.5, y == null ? bot.entity.position.y : Number(y), Math.floor(z) + 0.5) : null
      // Пустой частичный результат поиска — ждать продолжения, а не «дошёл» (movement.gotoGoal): ND_GOTO_WAIT=1,
      // pathWait:true или мост на ходу (обход и мост ищутся дольше 40 мс первого тика).
      const waitPartial = typeof pathWait === 'boolean' ? pathWait : (gotoWaitOn() || !!(this.bridgeWanted ?? blockmoves.on()))
      if (this.bridgeWanted) blockmoves.install(this)
      this.updateMovements()
      // Лестница выхода из застреваний (unstuck.js): ND_UNSTUCK или goto { unstuck }; только в новом goto (gotoGoal).
      const un = waitPartial && require('./unstuck').on(unstuckWanted) ? require('./unstuck').watch(this, ctl, { deadline }) : null
      console.log('[goto]', JSON.stringify({ to: [x, y ?? null, z], from: bot.entity ? [Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)] : null,
        bridge: !!(this.movements && this.movements.bridge), wait: waitPartial, unstuck: !!un, sprint: !!(bot.pathfinder.movements && bot.pathfinder.movements.allowSprinting), pearl: hopgoto.on(pearl) }))
      // С лестницей выхода к берегу плыть, только если он вплавь есть: пруд в яме (берег выше воды на 2+) escapeWater
      // обходил по 25 с впустую (try-lab-stuck pond, us-pilot1) — оттуда выводит ступенька/лесенка лестницы.
      if (inWater(bot) && !(un && !require('./unstuck').landBySwim(bot))) await escapeWater(bot, ctl)
      const goalBelow = () => waitPartial && y != null && Number.isFinite(Number(y)) && Number(y) < bot.entity.position.y - 2
      const pit = goalBelow() ? { wasInPit: false } : await escapePit(bot, ctl, { mcData: this.mcData, maxClimb: 24 })
      const bx = Math.floor(x)
      const bz = Math.floor(z)
      let goal
      let resolvedTo
      if (y === undefined || y === null) {
        goal = new goals.GoalNearXZ(bx, bz, Math.max(1, range))
        resolvedTo = { x: bx, y: null, z: bz, mode: 'xz' }
      } else {
        const yy = standableY(bot, bx, Math.floor(y), bz)
        if (yy === null) {
          goal = new goals.GoalNearXZ(bx, bz, Math.max(2, range))
          resolvedTo = { x: bx, y: null, z: bz, mode: 'xz (нет места встать на заданной высоте)' }
        } else {
          goal = new goals.GoalNear(bx, yy, bz, range)
          resolvedTo = { x: bx, y: yy, z: bz, mode: 'near' }
        }
      }

      // Цель под крышей (небо ≤ 7 в клетке ног цели): поверху к ней не дойти, а штраф крыши раздувает A* у самой цели
      // (s6b 06.10, арена S7: комнаты под перекрытием; над западом висит кусок рельефа, небо там на 1 темнее — A* запад
      // 62 узла против 9 зеркально, на 750 TPS «partial» по кругу; try-parkour-path-mirror.js). Только для цели с высотой:
      // у цели без y клетка «на высоте тела» в колонне горы — внутри камня (небо 0), и strict снимался — штрек сквозь гору
      // (замечание проверки S6c 07.10).
      // Снимается только штраф крыши; запрет копки strict остаётся как до правки.
      const goalSky = resolvedTo.y == null ? null : skyLightAt(bot, new Vec3(bx, Math.floor(resolvedTo.y), bz))
      const overSurface = surface !== false && this.underSky()
      const surfaceWalk = overSurface && !(goalSky !== null && goalSky <= 7)

      ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })

      // Жемчуг как ход (hopgoto.js): пеший путь по A* долгий (обход) — бросок к цели, дальше пешком.
      // pearl: true | { reserve, … } или ND_PEARL_GOTO=1; резерв по умолчанию 12 (очи Края).
      let pearlRun = null
      if (hopgoto.on(pearl)) {
        try { pearlRun = await hopgoto.maybeHop(this, ctl, { x: bx, y: resolvedTo.y, z: bz }, goal, pearl) } catch (err) { pearlRun = { hopped: false, why: 'ошибка: ' + err.message } }
        if (ctl.aborted) throw new Error('прервано')
      }

      // Быстрый спуск со скалы (navigation/descent.ts, S6c): цель ниже на 6+ — прыжок в воду, уступы или блоки вдоль
      // стены, если быстрее пешего пути pathfinder'а. descent: false | { minGain, maxFallDamage, … }; ND_DESCENT=0 — выкл.
      // На ходу — сторож (descent.watch): у края с готовым вариантом попытка pathfinder'а обрывается, решает maybeDescend.
      const descentRuns = []
      const descentMod = require('./navigation/descent')
      const descentOpt = typeof descent === 'object' && descent ? descent : {}
      const descendNow = async () => {
        let r
        try { r = await descentMod.maybeDescend(this, ctl, { x: bx, y: resolvedTo.y, z: bz }, goal, descentOpt) } catch (err) { r = { used: null, why: 'ошибка: ' + err.message } }
        if (ctl.aborted) throw new Error('прервано')
        if (r && r.used) descentRuns.push(r)
        return r
      }
      const firstDescent = descentMod.on(descent) ? await descendNow() : null
      let failDescent = null
      const descentWatch = descentMod.on(descent) && !(firstDescent && firstDescent.efficient) ? descentMod.watch(bot, { x: bx, y: resolvedTo.y, z: bz }, () => { if (!failDescent) return false; failDescent(Object.assign(new Error('край обрыва — спуск'), { descent: true })); return true }) : null

      // без копки. С копкой pathfinder шёл сквозь гору штреком — две минуты
      const strict = surface === 'strict' && overSurface
      const attempt = async (g) => {
        // С лестницей выхода сторож — последняя страховка: застревание раньше ловит и лечит unstuck.
        const guard = stuckGuard(bot, ctl, un && !un.exhausted() ? 45000 : 8000)
        const mv = bot.pathfinder.movements
        const dug = mv ? mv.canDig : undefined
        const scaffold = mv ? mv.scafoldingBlocks : undefined
        if (strict && mv) { mv.canDig = false; mv.scafoldingBlocks = [] }
        this.surfaceWalk = surfaceWalk
        this.pathGoalY = typeof g.y === 'number' ? g.y : null
        this.surfaceStrict = strict
        let failPlace
        const placeGuard = new Promise((resolve, reject) => { failPlace = reject })
        const descentGuard = new Promise((resolve, reject) => { failDescent = reject })
        let placeErrors = 0
        const onReset = (reason) => {
          if (reason === 'place_error' && ++placeErrors >= 6) failPlace(new Error('блок под ноги не ставится — шесть отказов подряд, этот путь не работает'))
        }
        bot.on('path_reset', onReset)
        try {
          await Promise.race([waitPartial ? gotoGoal(bot, g, { unstuck: un }) : bot.pathfinder.goto(g), guard.promise, placeGuard, descentGuard])
          // goto резолвит и пустой partial-путь. Достигнутая цель определяется
          // координатами тела, включая высоту для 3D-плана.
          if (!g.isEnd(bot.entity.position.floored())) {
            throw Object.assign(new Error('pathfinder закончил путь, но не достиг цели — не дошёл'), { noStep: true })
          }
        } finally {
          failDescent = null
          bot.removeListener('path_reset', onReset)
          this.surfaceWalk = false
          this.pathGoalY = null
          this.surfaceStrict = false
          if (strict && mv) { mv.canDig = dug; mv.scafoldingBlocks = scaffold }
          guard.stop()
        }
      }

      const plan = [{ goal, mode: resolvedTo.mode }]
      if (resolvedTo.mode === 'near') {
        plan.push({ goal: new goals.GoalNearXZ(bx, bz, Math.max(2, range)), mode: 'xz' })
      }

      const tried = []
      let settledRetry = false
      let lastError = null
      const outOfTime = () => gameClock.now() >= deadline
      const away = () => Math.round(Math.hypot(bot.entity.position.x - bx, bot.entity.position.z - bz))
      const report = why => ({
        at: xyz(bot.entity.position),
        target: { x: bx, y: resolvedTo.y, z: bz, mode: resolvedTo.mode },
        attempts: tried.length,
        tried: tried.length ? tried : undefined,
        awayBlocks: away(),
        stopped: why,
        climbedOut: pit.wasInPit ? pit.climbed : undefined
      })
      const ranOut = () => report(
        `время вышло за ${secs}с — не дошёл, до цели ещё ${away()} блоков по горизонтали` +
        (lastError ? `: ${lastError.message}` : ''))

      let progressRetries = 0
      let descentChecks = 0
      let stuckOut = false
      ctl.onAbort.push(() => descentWatch && descentWatch.stop())
      try {
      for (const step of plan) {
        if (stuckOut) break
        for (let retry = 0; retry < 2; retry++) {
          if (outOfTime()) return ranOut()
          const away0 = away()
          try {
            await attempt(step.goal)
            return {
              arrived: xyz(bot.entity.position),
              target: { x: bx, y: resolvedTo.y, z: bz, mode: step.mode },
              attempts: tried.length + 1,
              climbedOut: pit.wasInPit ? pit.climbed : undefined,
              surface: surfaceWalk || undefined,
              pearl: pearlRun || undefined,
              descent: descentRuns.length ? (descentRuns.length === 1 ? descentRuns[0] : descentRuns) : undefined,
              unstuck: un && (un.stats.detected || un.stats.refusals) ? un.report() : undefined
            }
          } catch (err) {
            if (ctl.aborted) throw err
            if (err.descent) {
              // Сторож спуска: решить у края; «пешком» — сюда не возвращаться. Попытка не в счёт.
              try { bot.pathfinder.setGoal(null) } catch {}
              const r = await descendNow()
              if (descentWatch) descentWatch.skip(bot.entity.position)
              if (descentWatch && r && r.efficient) descentWatch.stop()
              tried.push(`спуск: ${r && r.used ? r.used + (r.why ? ' (' + r.why + ')' : '') : 'пешком'}`)
              if (++descentChecks >= 6 && descentWatch) descentWatch.stop()
              retry--
              continue
            }
            lastError = err
            tried.push(`${step.mode}#${retry + 1}: ${err.message}`)
            const gained = away0 - away()
            if (waitPartial && progressRetries < 12 && gained >= 8 && away() > Math.max(4, range + 2)) {
              progressRetries++
              retry--
              tried[tried.length - 1] += ` (ближе на ${gained} бл. — ещё раз)`
              try { bot.pathfinder.setGoal(null) } catch {}
              continue
            }
            // Пустой маршрут — не физическое застревание. Для 3D ещё есть
            // отдельный план XZ; последнюю такую попытку прекращаем сразу.
            if (err.noStep) {
              try { bot.pathfinder.setGoal(null) } catch {}
              if (y != null && resolvedTo.y != null && !outOfTime()) {
                const local = await require('./navigation/parkour').tryLocal(bot, ctl, { x: bx + .5, y: resolvedTo.y, z: bz + .5 })
                if (ctl.aborted) throw new Error('прервано')
                if (local.ok) return { arrived: xyz(bot.entity.position), target: { x: bx, y: resolvedTo.y, z: bz, mode: 'parkour' }, attempts: tried.length + 1, parkour: { ticks: local.ticks } }
              }
              if (waitPartial && !settledRetry && (!bot.entity.onGround || bot.entity.isInWater)) {
                settledRetry = true
                const t0 = gameClock.now()
                while (gameClock.now() - t0 < 1500 && !ctl.aborted && (!bot.entity.onGround || bot.entity.isInWater)) await new Promise(resolve => gameClock.setTimeout(resolve, 50))
                tried.push('ждал посадки')
                continue
              }
              break
            }
            // exactly how the answer used to turn into a bare clock: the abort
            if (outOfTime()) return ranOut()
            const out = goalBelow() ? { wasInPit: false } : await escapePit(bot, ctl, { mcData: this.mcData, maxClimb: 24 })
            if (out.wasInPit) tried.push(`вылез из ямы на ${out.climbed}${out.stopped ? ' (' + out.stopped + ')' : ''}`)
            await unstick(bot)
          }
        }
      }
      } finally { if (descentWatch) descentWatch.stop() }
      if (un) console.log('[unstuck] goto', JSON.stringify(un.report()))
      throw new Error(
        `не дошёл (${tried.length} попытки)${pit.wasInPit ? `, из ямы вылез на ${pit.climbed}${pit.stopped ? ' — ' + pit.stopped : ''}` : ''}. ` +
        `Последняя: ${lastError.message}`)
    }, { timeoutMs: (secs + 15) * 1000 })
  }

  // Sets a persistent follow goal and returns straight away. Block afterwards
  // with wait() so the follow keeps running while we listen for events.
  follow ({ player, distance = 3 }: any) {
    this.cancel()
    return this.immediate(async () => {
      const bot = this.require()
      this.updateMovements()
      const target = bot.players[player] && bot.players[player].entity
      if (!target) throw new Error(`не вижу игрока ${player} рядом`)
      bot.pathfinder.setGoal(new goals.GoalFollow(target, distance), true)
      // and therefore does not cancel it — that is the whole follow+wait pattern,
      this.followGoal = { player, distance }
      return { following: player, distance }
    })
  }

  stop () {
    return this.immediate(async () => {
      this.cancel()
      return { stopped: true }
    })
  }

  // Idle: block until something interrupts or the timeout expires. Does not
  // touch an active follow goal.
  wait ({ seconds = 30, holdPosition = false }: { seconds?: number; holdPosition?: boolean }) {
    if (typeof holdPosition !== 'boolean') throw new TypeError('holdPosition must be boolean')
    const s = Math.max(1, Math.min(300, seconds))
    return this.runIntent(holdPosition ? 'hold_position' : 'wait', async (ctl) => {
      if (holdPosition) { const bot = this.require(); bot.pathfinder.setGoal(null); bot.clearControlStates() }
      await sleep(s * 1000, ctl)
      return { waited: s }
      // Ожидание слышит и жесты людей (gestures.js): присед, взгляд в упор,
      // брошенную вещь — живой игрок на них отвечает, а не спит дальше.
    }, { exclusive: holdPosition, timeoutMs: (s + 5) * 1000, interruptOn: [...require('./events').WAKES] })
  }

  // Raw turn, no result envelope — used by vision before taking a shot so the
  // buffered events are not drained into a throwaway response.
  async turnTo ({ x, y, z }: any) {
    const bot = this.require()
    await bot.lookAt(new Vec3(x, y, z), true)
  }

  lookAt ({ x, y, z }: any) {
    return this.immediate(async () => {
      await this.turnTo({ x, y, z })
      return { lookingAt: { x, y, z } }
    })
  }

  observe ({ radius = 24, fair }: any = {}) {
    return this.immediate(async () => {
      const bot = this.require()
      const useFair = fair === undefined ? this.cfg.fairPlay : !!fair
      const result = observe(bot, this.mcData, { radius, fair: useFair })
      this.tactics?.observed()
      return { ...result, tactics: this.tactics?.snapshot() || null }
    })
  }

  players (p: any = {}) {
    return this.immediate(async () => {
      this.require()
      return social.players(this, p)
    })
  }

  escort (p: any = {}) {
    return this.runIntent('escort', ctl => {
      this.require()
      this.updateMovements()
      return escort(this, ctl, p)
    }, {
      timeoutMs: (Math.min(300, p.forSeconds ?? 60) + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  giveItem (p: any = {}) {
    return this.runIntent('give', ctl => {
      this.require()
      this.updateMovements()
      return handover.give(this, ctl, p)
    }, {
      timeoutMs: (Math.min(180, p.timeoutSeconds ?? 60) + 20) * 1000,
      interruptOn: ['low_health', 'death', 'kicked', 'disconnected']
    })
  }

  takeItem (p: any = {}) {
    return this.runIntent('take', ctl => {
      this.require()
      this.updateMovements()
      return handover.take(this, ctl, p)
    }, {
      timeoutMs: (Math.min(120, p.timeoutSeconds ?? 25) + 20) * 1000,
      interruptOn: ['low_health', 'death', 'kicked', 'disconnected']
    })
  }
  declare mine: any

  declare mineSeen: any

  declare digDown: any

  declare explore: any

  declare craft: any

  declare place: any

  declare fight: any

  declare flee: any

  declare loot: any

  declare structure: any

  declare autoLoot: any

  declare shoot: any

  declare prep: any

  declare enchant: any

  declare brew: any

  declare kit: any

  declare throwTest: any

  declare bucket: any

  declare animals: any

  declare golem: any

  declare trade: any

  declare pack: any

  declare cache: any

  declare obsidian: any

  declare stronghold: any

  declare blaze: any

  declare dragon: any

  declare fortress: any

  declare pearls: any

  declare bastion: any

  declare netherTunnel: any

  declare strongholdPath: any

  declare retaliate: any

  declare defend: any

  declare smelt: any

  declare chestPut: any

  declare chestTake: any

  declare chestList: any

  declare base: any

  declare stash: any

  declare wearBestArmor: any

  declare tunnel: any

  declare shelter: any

  declare surface: any

  declare recoverLoot: any

  declare sleepInBed: any

  declare wakeUp: any

  declare equipItem: any

  declare eat: any

  declare dropItem: any

  declare portal: any

  declare build: any

  declare sortStorage: any

  declare writeSign: any

  declare farm: any

  declare ride: any
  declare flightRoute: (p: import('./combat/flight-route').FlightRouteRequest) => Promise<unknown>
  declare boatHop: (p?: import('./combat/boat-hop').BoatHopRequest) => Promise<unknown>
  declare parkour: (p: Parameters<typeof import('./navigation/parkour').navigate>[2] & { timeoutSeconds?: number }) => Promise<unknown>

  declare mechanism: any

  // -------------------------------------------------------------- memory ops

  setGoal ({ text }: any) {
    return this.immediate(async () => {
      this.journal.patch(s => { s.goal = text })
      this.journal.append('цель', text, this.bot && this.bot.entity && this.bot.entity.position)
      return { goal: text }
    })
  }

  remember ({ kind = 'заметка', text, place }: any) {
    return this.immediate(async () => {
      const pos = this.bot && this.bot.entity ? this.bot.entity.position : null
      if (place) {
        const here = pos ? worlds.worldOf(this.bot) : null
        const old = (this.journal.state.places || {})[place]
        if (old && here && worlds.worldOfRecord(old) !== here) {
          const there = worldsTag(here)
          throw new Error(`«${place}» уже записано ${worlds.inWorld(worlds.worldOfRecord(old))} — ` +
            `это место ${worlds.inWorld(here)} назову иначе, например «${place} (${there})». Старую запись не трогаю.`)
        }
        this.journal.patch(s => {
          if (!s.places) s.places = {}
          s.places[place] = { ...(s.places[place] || {}), ...xyz(pos), ...(here ? { dimension: here } : {}), note: text }
        })
      }
      this.journal.append(kind, text, pos)
      return { remembered: text, place: place || null }
    })
  }

  // The death log is the one part of memory that grows without bound, and
  compactState () {
    const s = this.journal.state
    const deaths = Array.isArray(s.deaths) ? s.deaths : []
    const open = deaths.filter(d => !d.recovered)
    const ore = Array.isArray(s.ore) ? s.ore : []
    const kinds = {}
    for (const r of ore) kinds[r.name] = (kinds[r.name] || 0) + 1
    return {
      ...s,
      deaths: {
        всего: deaths.length,
        неразобрано: open.length,
        последние: open.slice(-3).map(d => ({ at: d.at, pos: d.pos }))
      },
      ore: {
        всего: ore.length,
        виды: kinds,
        последние: ore.slice(-3).map(r => ({ name: r.name, at: { x: r.x, y: r.y, z: r.z }, seen: r.seen })),
        как: 'это память о виденном, а не зрение — забрать через mc_mine_seen'
      },
      // Постройки — счёт и последние (весь список — mc_structure mode=list).
      structures: require('./structures').compact(s.structures),
      looted: Array.isArray(s.looted) ? s.looted.length : undefined
    }
  }

  recall ({ lines = 40 }: any = {}) {
    return this.immediate(async () => ({
      state: this.compactState(),
      journal: this.journal.tail(lines)
    }))
  }
}

Object.assign(Session.prototype, require('./session/resources'), require('./session/progression'), require('./session/equipment'), require('./session/combat'))

module.exports = { Session, sleep, xyz, resultCode, steerIntoDig }
