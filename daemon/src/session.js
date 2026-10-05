'use strict'
const gameClock = require('./game-clock')
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
// an intent that ignores its abort signal keeps running after the brain has
// already moved on.
function sleep (ms, ctl) {
  if (ctl?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve() })
  })
}

// Машинная причина исхода намерения (research/05-synthesis.md F.3-4): кампания,
// сцены фермы и LLM читают одну строку, а не прозу detail.stopped.
//   timeout → TIMEOUT; interrupted → по типу события (CHAT, DAMAGE, LOW_HP, DIED,
//   KICKED, DISCONNECTED, EMERGENCY, GESTURE, …); failed → свой code навыка
//   (err.code или detail.code), иначе FAILED; done → detail.code навыка, иначе OK.
const INTERRUPT_CODES = { chat: 'CHAT', gesture: 'GESTURE', damage: 'DAMAGE', low_health: 'LOW_HP', death: 'DIED',
  kicked: 'KICKED', disconnected: 'DISCONNECTED', emergency: 'EMERGENCY', friend_hurt: 'FRIEND_HURT' }
const isCode = c => typeof c === 'string' && /^[A-Z][A-Z0-9_]*$/.test(c)
// Регрессия спуска 30.09 (farm/results/mlg-reg-dbg1): столб 3×3, путь — шахта вниз в крайнем столбце (узлы «3049,258
// b1», «3049,257 b1»…). mineflayer-pathfinder засчитывает узел, когда |dy| < 1, то есть ещё в падении в только что
// выкопанную клетку, а следующий узел — копка: копку он начинает только на полу и до того ничего не делает — клавиши
// шага («вперёд», спринт) остаются нажатыми, и тело в воздухе проезжает клетку и съезжает с края столба (8.1 с x=3049.54
// → 8.3 с x=3050.50, падение на 59). В обычной породе дальше стена, у края столба — пустота. Пока тело в воздухе, а
// следующий узел — копка, вести его в центр колонны этого узла: смотреть туда и толкаться, пока прогноз посадки вне
// центра, иначе отпустить клавиши. Возвращает клавиши (для теста) или null — не вмешиваться.
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

function resultCode (result) {
  if (!result) return 'FAILED'
  const own = result.detail && typeof result.detail === 'object' && isCode(result.detail.code) ? result.detail.code : null
  if (result.status === 'timeout') return 'TIMEOUT'
  if (result.status === 'interrupted') {
    const t = result.by && result.by.type
    return INTERRUPT_CODES[t] || (t ? String(t).toUpperCase().replace(/[^A-Z0-9]+/g, '_') : 'INTERRUPTED')
  }
  if (result.status === 'failed') return isCode(result.code) ? result.code : own || 'FAILED'
  return own || 'OK'
}

// The interrupt set for work that is holding something open. `damage` is in
// the default set (events.js:9) and is the right default for walking and
// digging — but a craft, a furnace and a chest are all the one screen the
// server is willing to show, and runIntent aborts the moment it interrupts:
// containers closes the window mid-transfer (containers.js guardWindow), and
// an aborted craft has been seen to eat the ingredients and hand back nothing.
// One skeleton arrow through a cave mouth then costs the whole operation and
// leaves the bag in a state nobody can describe. Health, death, a kick and a
// person talking all still stop it. `base` already made exactly this call for
// the walk home; the six below were simply left behind.
const HOLDING = ['chat', 'low_health', 'death', 'kicked', 'disconnected']
// Зачарование, варка, сборы: окно посреди кликов не бросаем из-за реплики.
const WORKBENCH = ['damage', 'low_health', 'death', 'kicked', 'disconnected']

// Короткая пометка мира для имени места: «лагерь (ад)».
const worldsTag = dim => ({ overworld: 'верх', the_nether: 'ад', the_end: 'край' })[dim] || dim

// Свет неба в клетке: число, 15 для секции без данных, null — чанка нет.
// Секцию без DataLayer сервер не шлёт вовсе (ClientboundLightUpdatePacketData.
// prepareSectionData: dataLayer == null — ни в маску, ни в пустые), а
// prismarine-chunk читает такую как 0. Это воздух над рельефом
// (SkyLightSectionStorage.getLightValue: выше верхней секции — 15), не пещера.
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
  constructor (cfg, bus, journal) {
    this.cfg = cfg
    this.bus = bus
    this.journal = journal
    this.bot = null
    this.mcData = null
    this.current = null
    this.lastHealth = 20
    this.connecting = null
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
  setTemper (p = {}) {
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

  setPlayMode (p = {}) {
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
          // Полуширина хитбокса как на сервере: EntityDimensions хранит ширину
          // float 0.6f, и сервер берёт (double)0.6f/2 = 0.30000001192092896, а
          // prismarine-physics — ровно 0.3. Упёршись в стену на земле (ступенька
          // перед прыжком), клиент встаёт в 0.3 от грани, серверный хитбокс
          // залезает в блок на 1.2e-8, и handleMovePlayer (hasNewCollision →
          // CLIPPED_INTO_BLOCK) молча откатывает позицию — «застрял у ступеньки».
          // Замер (dragon-агент, Энд): 245 откатов за 15 с → 0 с этой строкой.
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
          // 'spawn' fires before the chunk under our feet has arrived, so an
          // observe() right after connect would see an empty world.
          // Wait for neighbouring columns too: a portal across the chunk border
          // otherwise looks absent. client-loaded's earlier listener sends its
          // acknowledgement after the same load, before connect becomes ready.
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

  // What the bot is physically able to do while travelling depends on what it
  // is carrying. With canDig on and an empty inventory pathfinder happily
  // plans a tunnel through stone and then stands there mining it by hand,
  // which from the outside looks exactly like a hang.
  updateMovements (force = false) {
    const bot = this.bot
    if (!bot || !bot.pathfinder) return
    const items = bot.inventory ? bot.inventory.items() : []
    const canDig = items.some(i => /_(pickaxe|shovel|axe)$/.test(i.name))
    const scaffold = items
      .filter(i => /^(dirt|cobblestone|cobbled_deepslate|netherrack|stone|oak_planks|spruce_planks|birch_planks)$/.test(i.name))
      .reduce((n, i) => n + i.count, 0)
    const towers = scaffold >= 8

    // Спрыгнуть на 4 блока — это 1 хп (урон падения — дистанция минус 3), а
    // pathfinder по умолчанию прыгает на 4 (maxDropDown). На 1-2 хп такой
    // спуск по склону — смерть: ранен — не глубже трёх.
    // С ведром воды — глубже: вода под ноги в конце падения (edges.mlgDrop,
    // сторож падения ставит её сам). Ведро заранее в хотбар — сторож иначе
    // тратит на перекладку первые тики падения.
    const mlg = edges.mlgDrop(this)
    const dropDown = mlg.ok ? mlg.drop : (bot.health ?? 20) <= 6 ? 3 : 4
    if (mlg.toBar && !bot.currentWindow && bot._ndFallGuard && bot._ndFallGuard.toHotbar) bot._ndFallGuard.toHotbar().catch(() => {})
    if (bot.pathfinder.movements) bot.pathfinder.movements.maxDropDown = dropDown
    if (this.dropSet !== dropDown || mlg.why !== this.dropWhy) console.log('[mlg] cap', JSON.stringify({ at: 'update', drop: dropDown, was: this.dropSet, why: mlg.why || null }))
    this.dropSet = dropDown
    this.dropWhy = mlg.why
    // Мир — в подписи: подмости в Аду свои (worlds.tuneMovements), и переход
    // порталом должен пересобрать ходы. Ведро — тоже: путь с прыжком на 15
    // блоков, проложенный с ведром, без него должен перестроиться.
    // Мост на ходу (blockmoves.js) — тоже в подписи: goto может включить его на один переход ({ bridge: true }).
    const bridge = this.bridgeWanted ?? blockmoves.on()
    // Бег (как у спидраннеров) — goto { sprint } или movement.sprintOn: по умолчанию в верхнем мире, ND_SPRINT=1/0 — везде/нигде.
    // Но не на последние крохи: бег — 0.1 истощения на блок (spigot.yml sprint-multiplier, шаг — 0), сытость < 14 и еды
    // в рюкзаке нет — шагом (сытость ≤ 6 гасит бег и так: itemuse.js, как клиент).
    const foods = (bot.registry && bot.registry.foodsByName) || {}
    const fed = (bot.food ?? 20) >= 14 || items.some(i => foods[i.name] && !/^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew|chorus_fruit)$/.test(i.name))
    // В болоте (мангры, топь) — шагом, если бег не просили явно: ил, корни, кувшинки и лианы — рельеф пула, слот 28,
    // 7 ног из 10 в манграх, по сериям mv-ka-A/B и mv-terr-fin: бег 15/21 дошли и 916 с на всё против шага 18/21 и 732 с;
    // вне болот бег 9/9 и −9 % суммы (−18 % медианы). Биом — у тела и у цели goto (если её чанк уже есть).
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
    // Sprinting is the biggest source of client/server physics divergence and
    // the usual trigger for "moved too quickly". Parkour stays on: turning it
    // off makes pathfinder fail to find any route at all on this terrain.
    movements.allowSprinting = sprint
    // Путь в обход мобов: каждая клетка рядом с врагом дороже, тем дороже,
    // чем моб опаснее (flee.js DOCTRINE). Раньше маршрут шёл сквозь толпу, и
    // бот «тупо бежал на мобов».
    if (Array.isArray(movements.exclusionAreasStep)) movements.exclusionAreasStep.push(flee.mobAvoidance(bot))
    // Поверху — значит поверху. GoalNearXZ высоты не спрашивает, и переход «по
    // прямой» нырял в пещеры: кампания 2026-09-26 охотилась через пещеру с
    // капельником (4,55,-139), а подъём из другой такой (-158,79,-97) стоил две
    // с половиной минуты и 82 булыжника. Пока идёт переход поверху
    // (this.surfaceWalk ставит goto), клетка тела без неба дороже шага:
    // pathfinder обходит пещеру поверху и лезет в неё, только если другой
    // дороги нет (штраф, а не запрет).
    if (Array.isArray(movements.exclusionAreasStep)) movements.exclusionAreasStep.push(block => this.surfaceWalk ? underRoofCost(bot, block, this.surfaceStrict) : 0)
    // Шаг вплотную к лаве (под ногами или рядом на уровне тела) — дороже:
    // толчок моба, сорванная постановка или неточный шаг кончаются в ней
    // (Ад, 2026-09-26 11:32 — см. мост по лаве ниже).
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
        // _ndLavaStrict: под клеткой ног воздух до самой лавы (дыра в полу,
        // обрыв над морем) — шаг туда кончается падением в лаву. Ферма 29.09,
        // bastion-route-12: 11 смертей «tried to swim in lava» из 22 прогонов,
        // тело падало с y 37 в море y ≤ 31 после копки на пути к золоту.
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
    // Мост над пропастью. Pathfinder кладёт леса (dirt, cobblestone) под шаг над
    // пустотой, и одна неудачная постановка — это падение: кампания 2026-09-26,
    // «fell from a high place», 52 блока с моста на вершине горы (y=195 → 143).
    // Блок под ноги с пятью и больше клетками воздуха под ним — очень дорого:
    // пусть обходит ущелье, а мостит только там, где другого пути нет.
    if (Array.isArray(movements.exclusionAreasPlace)) {
      movements.exclusionAreasPlace.push(block => {
        const p = block && block.position
        if (!p) return 0
        // Мост по лаве: лава заменима, и pathfinder кладёт блок прямо в неё
        // под следующий шаг; постановка сорвалась («place_error») — и шаг в
        // лаву. Кампания 2026-09-26, Ад (11:32): разведка крепости стояла над
        // лавой на y=52, 19 → 10 хп, потом «doomed to fall», и всё, что было в
        // рюкзаке, осталось в Аду. Блок в клетку лавы или с лавой под ней —
        // как мост над пропастью в Аду (worlds.tuneMovements): 1000, обходить.
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
    // Мост на ходу: блок под ноги, не останавливаясь (blockmoves.js, ND_BRIDGE=1 или goto bridge:true); запас
    // строительных блоков pack.RESERVE.build — на столб и отход.
    // Ад: лава под мостом ищется на 64 вниз (море y 31); Край: над пустотой без дна не мостим.
    // Ход моста без исполнителя — шаг в пустоту: исполнитель ставится здесь же (идемпотентно, на текущее тело;
    // ревью Codex: после переподключения bridgeWanted жил, а wire исполнителя не ставил).
    // goalY — высота цели goto: мост только на её уровне (цель ниже — спуск, а не мост в небо; mv-mlg-4).
    if (bridge) { blockmoves.addBridge(movements, { reserve: packMod.RESERVE.build, depthMax: worlds.worldOf(bot) === 'the_nether' ? 64 : 24, voidOk: worlds.worldOf(bot) !== 'the_end', goalY: () => this.pathGoalY }); blockmoves.install(this) }
    bot.pathfinder.setMovements(movements)
    this.movements = { canDig, towers, mlg: mlg.ok, bridge }
  }

  // Предел спуска — живой: ведро вылито (или потеряно), здоровье упало — и
  // маршрут с прыжком, проложенный раньше, стал смертельным. Правим только
  // своё значение: бой (pvp.js) и этапы со своими ходами ставят своё, и его
  // не трогаем. Путь перестраивается, лишь если в нём есть прыжок глубже
  // нового предела — не на каждый удар моба.
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
    // Узлы — живой массив pathfinder'а (pathNodes из path_update; его же сдвигает исполнитель, так что это
    // остаток пути). lastPath — сводка поиска {status, cost, …}, а не узлы: до 02.10 здесь стояло
    // Array.isArray(this.lastPath), и перестройка при снижении предела не срабатывала никогда (dev-A 30.09).
    const path = this.pathNodes
    this.dropRecheck = false
    if (!Array.isArray(path) || !path.length || !moving || !bot.entity) return
    // В воздухе путь не перестраивать: прыжок уже идёт, вода — у сторожа, а
    // путь из воздуха начинается не с той клетки (Baritone: safeToCancel).
    // Проверить заново, когда встанем.
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

  // Смерть и строка сервера о ней сошлись (в пять секунд) — причина в запись
  // смерти. Сгорел в лаве — значит, лава там есть: место «лава» для литья
  // портала (campaign.js known.lava), как игрок помнит, где сгорел.
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

  // Тело под открытым небом верхнего мира (свет неба у головы ≥ 12, под
  // листвой 12-14): переход отсюда идёт поверху (underRoofCost). goto и
  // explore ставят this.surfaceWalk на время ходьбы.
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
    // Тип урона (research/05-synthesis.md H1): голод, падение и удушье выглядели как нападение, и кампания
    // копала нору от собственного голода. Пакет damage_event по своему телу несёт номер типа в реестре
    // damage_type (gamedata.DAMAGE_TYPES) и id виновника (+1). Сервер шлёт его сразу из hurtServer
    // (broadcastDamageEvent), а здоровье — в тике игрока, то есть обычно раньше update_health. Тип старше
    // 250 мс к потере здоровья не относится: тогда cause нет — поведение прежнее («неизвестно»).
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
        this.bus.emit('damage', { health: Math.round(hp), lost: Math.round(last - hp), ...(typed ? { cause: typed.cause, ...(typed.source ? { source: typed.source } : {}) } : {}) })
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

    // Who just hit us. Underground the attacker regularly is not in
    // nearestEntity's answer — around a corner, out of the entity list — and
    // the brain got "не вижу цель" while being eaten.
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
    // Бег вприпрыжку на прямых ровных участках пути (sprintjump.js, поток route; ND_SPRINT_JUMP=1, по умолчанию выкл.).
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
      // «[NeuroDown: Gamerule … set to …]» — эхо чужой админ-команды
      // (chat.type.admin), не речь: прерывало любое намерение, стоило на
      // сервере работать второму оператору (try-bed, 2026-09-25).
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
        // Что было в рюкзаке — чтобы решать, стоит ли идти за кучей
        // (директор: далеко за досками не ходят). Пакеты очистки рюкзака
        // приходят после update_health, так что здесь он ещё полный.
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
      // Must be visible: a throw inside the physics tick silently freezes the
      // body, and burying it in the event buffer makes that look like "the
      // pathfinder is bad".
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
      busy: this.current ? this.current.name : null
    })
  }

  // ------------------------------------------------------------ intent runner

  cancel () {
    require('./reflex-lock').cancel(this)
    // Everything below drops the pathfinder goal, and a follow set by follow()
    // is exactly such a goal. The autopilot asks about this flag before it
    // stands a crafting table up (autopilot.js keepTools), so a stale one would
    // cost it every craft for the rest of the session.
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

  // Runs a blocking intent. Returns when the work finishes, an interrupting
  // event fires (player chat, damage, low health, death, disconnect), or the
  // timeout expires. The timeout is not optional: pathfinder can keep
  // searching for an unreachable goal forever, and an intent that never
  // returns hangs the brain permanently.
  //
  // `params` are the intent's own arguments, handed over only so the gear check
  // below can price the work (a 16-block drift wants two torches, a 64-block
  // one eight). runIntent itself reads nothing else out of them.
  async runIntent (name, worker, { exclusive = true, interruptible = true, timeoutMs = 120000, interruptOn = null, params = null } = {}) {
    // Директор (director.js) не рвёт mc_wait мозга: мозг ждёт и слушает, пока
    // директор работает, и прерывания будят его как обычно.
    const fromDirector = require('./director').byDirector()
    if (exclusive && !(fromDirector && this.current && this.current.name === 'wait')) this.cancel()

    const ctl = { aborted: false, onAbort: [] }
    const reflexLock = require('./reflex-lock')
    ctl.waitReflex = () => reflexLock.on() ? reflexLock.wait(this, ctl) : Promise.resolve()
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
    }
    // Намерение без exclusive (wait) идёт рядом с чужим делом и его место не занимает: mc_wait поверх аварийного
    // отхода переписывал current, «занят: refuge» пропадал, мозг и директор звали своё и рвали отход
    // (research/dev-B-refuge.md, правка 3). Своё место wait берёт, только когда тело свободно (или ждёт другой wait).
    const beside = !exclusive && this.current && this.current.name !== 'wait' && this.current.ctl && !this.current.ctl.aborted
    if (!beside) this.current = { name, ctl, byDirector: fromDirector }

    // Gear before work, for the long intents only (preflight.js NEEDS). Armour
    // already in the bag and a better weapon than the one in hand are put on
    // here; no torches for a drift, no food for a long way down, no shield for
    // the graveyard are NOT refusals — the work runs anyway and the words ride
    // out on `result.gear`, a field of its own so the action's `detail.need`
    // is never the one that gets overwritten.
    //
    // Inside the race on purpose, not ahead of it: a chat that lands mid-swap
    // is answered the instant it lands, exactly as before, and the seconds
    // spent here come out of this intent's own timeout — bounded at
    // preflight.PREFLIGHT_MS, which is under the margin every long intent keeps
    // over its action's deadline. And `this.current` is already set, so the
    // autopilot's own dressing (bodyBusy) cannot start on top of this one.
    //
    // A short intent has no entry and takes the old path untouched: no read of
    // the bag, no timer, not even an extra tick before the worker.
    const spec = gear.requirements(name, params)
    const kit = spec ? gear.freshKit() : null
    // Whether the worker was ever entered, read as a state and not inferred from
    // the error text: the grace below hands over whatever a worker threw on its
    // way out, and «прервано ещё до начала» shares that field with
    // mineflayer-pathfinder's own English. And chat, which gets no grace, never
    // sees that throw at all — the flag is all it has.
    let entered = false
    const begin = async () => {
      await ctl.waitReflex()
      if (ctl.aborted) throw new Error('прервано ещё до начала: к работе не приступал')
      entered = true
      return worker(ctl)
    }
    const start = spec
      ? () => gear.preflight(this, ctl, spec, kit).then(() => {
          // Interrupted while dressing: the answer has already gone out, and a
          // worker started now would move the body behind it — the very bug
          // escort and goto pay a paragraph each to rule out. Most workers check
          // the flag only between swings, some not before their first walk.
          if (ctl.aborted) throw new Error('прервано ещё до начала: успел только проверить снаряжение, к работе не приступал')
          return begin()
        })
      : begin

    const work = Promise.resolve()
      .then(() => reflexLock.on() ? reflexLock.run(this, ctl, start) : start())
      .then(
        async detail => { if (!ctl.aborted) await ctl.waitReflex(); return { status: 'done', detail: detail ?? null } },
        err => ({ status: 'failed', error: String((err && err.message) || err), ...(err && typeof err.code === 'string' && /^[A-Z][A-Z_]+$/.test(err.code) ? { code: err.code } : {}) })
      ).catch(err => ({ status: 'failed', error: String(err?.message || err), ...(err?.code ? { code: err.code } : {}) }))

    // stop/disconnect must answer even when gameplay timers are frozen.
    const racers = [work, new Promise(resolve => {
      ctl.onAbort.push(() => resolve({ status: 'interrupted', by: { type: 'cancelled' } }))
    })]
    let pending = null
    if (interruptible) {
      let waiter
      const next = async () => {
        waiter = this.bus.nextInterrupt(interruptOn)
        const ev = await waiter
        // A melee reflex is a pause, not a worker cancellation. Other events
        // (chat/death/end and environmental damage) keep their normal semantics.
        if (this.reflex && (ev.type === 'low_health' || (ev.type === 'damage' && /^mob_attack/.test(ev.cause || '')))) return next()
        return { status: 'interrupted', by: ev }
      }
      pending = { cancel: () => waiter?.cancel() }
      racers.push(next())
    }
    let timer = null
    if (timeoutMs > 0) {
      racers.push(new Promise(resolve => {
        timer = gameClock.setTimeout(
          () => resolve({ status: 'timeout', afterSeconds: Math.round(timeoutMs / 1000) }),
          timeoutMs
        )
      }))
    }

    const result = await Promise.race(racers)
    if (pending) pending.cancel()
    if (timer) gameClock.clearTimeout(timer)

    ctl.abort()
    if (this.current && this.current.ctl === ctl) this.current = null

    // The clock used to throw the work away along with the budget. Measured in
    // the recover run of 2026-08-31: the body walked to the pile fourteen levels
    // down — the coordinates in the state header prove it — and the brain got
    // `timeout` with detail:null, which from the outside is indistinguishable
    // from «не пошёл вовсе». Two false reds in a scene that had been green the
    // day before, and in a live run the same answer buys the wrong decision:
    // «идти снова» instead of «вещи уже у меня».
    //
    // Every long action checks ctl.aborted between swings and then returns its
    // own report (actions.digDown/digStairs/explore, mining.tunnel,
    // survival.recoverLoot/surface), so the abort just above is normally all it
    // takes and the report lands in milliseconds. One second of grace is the
    // whole price. A worker parked inside a single bot.dig — which does not
    // watch the flag — misses the window and answers exactly as it did before.
    //
    // `status` is left alone on purpose: 'done' means «интент завершился» and
    // neither of these did. What changes is that «сделал половину» and «не сделал
    // ничего» stop looking identical.
    //
    // Which endings get the grace is decided by the EVENT, not by the status.
    // Chat is the one interrupt with a person on the other end of it, waiting for
    // an answer, and a second added to every line they type is a second they
    // watch a silent bot — so chat is answered the instant it lands, as before.
    // The other four interrupts have nobody waiting: damage, low_health, death,
    // kicked, disconnected. A forty-block drift ended by one skeleton scratch was
    // reaching the brain as `interrupted` with detail:null — indistinguishable
    // from «не начинал», which is the very lie the recover run told.
    //
    // The second is safe to spend even at 8 hp, and that is a fact about the two
    // lines above rather than a judgement: ctl.abort() has already fired and
    // this.current is already null, so the body is not working during the grace —
    // it is unwinding — and the autopilot, which is what actually answers
    // low_health, is unblocked (bodyBusy reads current) on its very next tick
    // without waiting for us. All the grace delays is the brain, whose turn costs
    // 10-30 seconds anyway.
    const by = result.status === 'interrupted' && result.by ? result.by.type : null
    if (result.status === 'timeout' || (by && by !== 'chat' && by !== 'gesture')) {
      const settled = await Promise.race([work, gameClock.wall.sleep(1000)])
      if (settled && settled.detail && typeof settled.detail === 'object') {
        result.detail = settled.detail
        result.partial = true
        // The human line of the answer is built out of detail.stopped
        // (mcp/src/format.js), so a report that never got round to naming a
        // reason is given the one it actually had. The action's own words are
        // never overwritten.
        if (typeof settled.detail.stopped !== 'string') {
          settled.detail.stopped = by
            ? `прервано (${by}) — ниже то, что успел`
            : `время вышло за ${result.afterSeconds}с — ниже то, что успел`
        }
      } else if (settled && settled.error) {
        // Aborted mid-swing and threw on the way out. The text is worth more
        // than the bare clock: «нет кирки» and «не дошёл» are different orders.
        result.error = settled.error
      }
    }

    // On every ending — done, failed, timeout, interrupted, chat included — and
    // after the grace, so a preflight that was mid-swap when the interrupt came
    // has had its second to finish saying so. Chat gets no grace and so gets
    // whatever was found by the time it landed; a copy either way.
    const kitReport = gear.summary(kit)
    if (kitReport) result.gear = kitReport
    // Absent on the ordinary path, where the worker was entered. Present only
    // when the body never left the door: status line «к работе не приступал»
    // (mcp/src/format.js) — «оборвалось» with nothing done, and nothing to go
    // back for.
    if (!entered) result.notStarted = true

    // Drained after the grace above, so whatever the unwinding worker emitted
    // travels with the report it belongs to instead of with the next answer.
    const drained = this.bus.drain()
    result.events = result.by ? drained.filter(e => e.seq !== result.by.seq) : drained
    result.state = this.state()
    result.code = resultCode(result)
    return result
  }

  // Non-blocking action: does not cancel whatever is running.
  //
  // A throw in here used to escape as a raw WebSocket error, and that cost a
  // diamond run: "no food in the bag" and a crash inside mineflayer reached
  // the brain as the same shapeless RPC failure, with no state header on it
  // either. Same mapping as runIntent.
  async immediate (worker) {
    const result = await Promise.resolve()
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

  // Answering in open chat something that was said privately is a different act:
  // the whole server reads it. `to` sends the reply back down the channel the
  // question came from — the same split the daemon already makes on the way in
  // (bot.on('chat') vs bot.on('whisper'), two handlers above).
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

  // The last long intent without a deadline of its own, and the one red left in
  // try-truth once the diggers were fixed. The loop below only ever stopped when
  // runIntent's clock ran out, and on an abort it throws — so the report was
  // whatever the throw said. But the abort does not always land somewhere that
  // can throw quickly: pathfinder.goto rejects at once (its goto.js turns a
  // changed goal into GoalChanged), while unstick() holds the keys for about a
  // second and ends on a bot.look round trip, and escapePit can climb for
  // several. Caught inside either, the worker missed the one second of grace
  // runIntent allows and the brain got «не уложился в 10с» with detail:null —
  // the same lie the recover run told, from the other end.
  //
  // So: the body stops itself, in time to answer. Where it got to, how many
  // routes it tried and how far the target still is are worth more than a bare
  // clock, and the intent keeps fifteen seconds more than the walk so this is
  // the ordinary ending rather than a race.
  goto ({ x, y, z, range = 2, timeoutSeconds = 90, surface, bridge, pathWait, pearl, sprint, unstuck: unstuckWanted }) {
    const secs = Math.max(5, Math.min(600, timeoutSeconds))
    return this.runIntent('goto', async (ctl) => {
      const bot = this.require()
      const deadline = gameClock.now() + secs * 1000
      // Мост на ходу на этот переход (сцены A/B на одном демоне): bridge true/false поверх ND_BRIDGE; не задан —
      // как в окружении. Держится до следующего goto.
      this.bridgeWanted = typeof bridge === 'boolean' ? bridge : undefined
      this.sprintWanted = typeof sprint === 'boolean' ? sprint : undefined
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
      // Never plan a route from the bottom of our own shaft. Pathfinder cannot
      // climb a 1x1 column, so the first attempt is guaranteed to burn its
      // whole budget on a route the body cannot walk — measured: four failed
      // attempts out of an eight-block dig_down hole.
      // Цель ниже тела — из своей шахты не вылезать: спуск по шахте и есть дорога (ферма 02.10, mv-mlg-1, H=60 без
      // ведра: ретрай goto у дна поднял тело по столбу на 22 блока и не дошёл). Только в новом goto (waitPartial).
      const goalBelow = () => waitPartial && y != null && Number.isFinite(Number(y)) && Number(y) < bot.entity.position.y - 2
      const pit = goalBelow() ? { wasInPit: false } : await escapePit(bot, ctl, { mcData: this.mcData, maxClimb: 24 })
      const bx = Math.floor(x)
      const bz = Math.floor(z)
      // Вышли из-под открытого неба верхнего мира — идём поверху
      // (underRoofCost в updateMovements); из шахты и пещеры — как раньше.
      // surface:false снимает штраф (нарочно в пещеру).
      const surfaceWalk = surface !== false && this.underSky()

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

      ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} })

      // Жемчуг как ход (hopgoto.js): пеший путь по A* долгий (обход) — бросок к цели, дальше пешком.
      // pearl: true | { reserve, … } или ND_PEARL_GOTO=1; резерв по умолчанию 12 (очи Края).
      let pearlRun = null
      if (hopgoto.on(pearl)) {
        try { pearlRun = await hopgoto.maybeHop(this, ctl, { x: bx, y: resolvedTo.y, z: bz }, goal, pearl) } catch (err) { pearlRun = { hopped: false, why: 'ошибка: ' + err.message } }
        if (ctl.aborted) throw new Error('прервано')
      }

      // surface:'strict' — разведочный отрезок (охота, «отойти»): поверху и
      // без копки. С копкой pathfinder шёл сквозь гору штреком — две минуты
      // «block_updated» на y=84-87 и подъём с 87 на 112 (2026-09-26, 08:45).
      // Пути поверху нет — пусть откажет сразу: зовущий повернёт.
      // И без лесов: столб и мост под ногами на склоне срывались «place_error»
      // по кругу — тот же план, та же неудача, две минуты до таймаута
      // (2026-09-26, 08:52-08:54, y=103-113).
      const strict = surface === 'strict' && surfaceWalk
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
        // Тот же круг и без strict: блок под ноги не встаёт, pathfinder
        // сбрасывает путь («place_error») и строит тот же самый. Шесть отказов
        // за попытку — путь не работает: к следующей попытке (unstick, заново).
        let failPlace
        const placeGuard = new Promise((resolve, reject) => { failPlace = reject })
        let placeErrors = 0
        const onReset = (reason) => {
          if (reason === 'place_error' && ++placeErrors >= 6) failPlace(new Error('блок под ноги не ставится — шесть отказов подряд, этот путь не работает'))
        }
        bot.on('path_reset', onReset)
        try {
          await Promise.race([waitPartial ? gotoGoal(bot, g, { unstuck: un }) : bot.pathfinder.goto(g), guard.promise, placeGuard])
          // goto резолвит и пустой partial-путь. Достигнутая цель определяется
          // координатами тела, включая высоту для 3D-плана.
          if (!g.isEnd(bot.entity.position.floored())) {
            throw Object.assign(new Error('pathfinder закончил путь, но не достиг цели — не дошёл'), { noStep: true })
          }
        } finally {
          bot.removeListener('path_reset', onReset)
          this.surfaceWalk = false
          this.pathGoalY = null
          this.surfaceStrict = false
          if (strict && mv) { mv.canDig = dug; mv.scafoldingBlocks = scaffold }
          guard.stop()
        }
      }

      // An exact 3D goal is brittle on uneven ground, so fall back to "just get
      // to that column" — which is what a player would aim for anyway. Each
      // plan gets a second try after shaking the bot loose. The whole loop is
      // bounded by the intent timeout, so it cannot run away.
      const plan = [{ goal, mode: resolvedTo.mode }]
      if (resolvedTo.mode === 'near') {
        plan.push({ goal: new goals.GoalNearXZ(bx, bz, Math.max(2, range)), mode: 'xz' })
      }

      const tried = []
      let settledRetry = false
      let lastError = null
      const outOfTime = () => gameClock.now() >= deadline
      // Horizontal only: the caller asked for a column, and «до цели ещё 3
      // блока» and «ещё 900» are different orders — one is «позови ещё раз»,
      // the other «эта дорога не работает, думай заново».
      const away = () => Math.round(Math.hypot(bot.entity.position.x - bx, bot.entity.position.z - bz))
      // Deliberately carries no `arrived` key: on the way out of a successful
      // walk that field is the position we reached, and a falsy one would read
      // as a place. Absence plus `stopped` is the honest shape, and `stopped` is
      // what format.js turns into the human line.
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
      let stuckOut = false
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
              unstuck: un && (un.stats.detected || un.stats.refusals) ? un.report() : undefined
            }
          } catch (err) {
            if (ctl.aborted) throw err
            lastError = err
            tried.push(`${step.mode}#${retry + 1}: ${err.message}`)
            // Лестница выхода прошла все ступени в этой точке: дальше прежний goto (рывок, столб из ямы, план XZ) — так
            // на рельефе доходило там, где лестница сдавалась (us-reg-terr); класс и место остаются в «Последняя: …».
            // Продвинулись к цели на 8+ блоков — попытка не провальная: A* не уложился в 5 с ('timeout' — goto.js
            // отказывает, хотя тело уже шло по лучшему частичному пути) или «stuck» на дальнем отрезке. Тот же план ещё
            // раз, без встряски и не в счёт попыток; число таких повторов ограничено (и сроком goto). Только новый goto.
            // Рельеф пула, mv-spr-1: «Took to long to decide path» — 2 провала из 40 ног 40–90 бл.
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
              // Пусто из воздуха или из воды (только что сел после прыжка с ведром): A* со старта в падении видит «ни
              // шага» (ферма 02.10, mv-mlg-1: «noPath, visited 1» дважды → не дошёл за 3 с). Дождаться посадки и тот же
              // план ещё раз — один раз за goto. Только в новом goto (waitPartial).
              if (waitPartial && !settledRetry && (!bot.entity.onGround || bot.entity.isInWater)) {
                settledRetry = true
                const t0 = gameClock.now()
                while (gameClock.now() - t0 < 1500 && !ctl.aborted && (!bot.entity.onGround || bot.entity.isInWater)) await new Promise(resolve => gameClock.setTimeout(resolve, 50))
                tried.push('ждал посадки')
                continue
              }
              break
            }
            // Shaking loose is only worth doing while there is time left to walk
            // afterwards. unstick holds the keys for a second and escapePit can
            // climb for several, and spending the last of the budget on them is
            // exactly how the answer used to turn into a bare clock: the abort
            // arrived mid-shake and there was nothing left able to report.
            if (outOfTime()) return ranOut()
            // Shaking loose does nothing at the bottom of our own shaft: there
            // is nowhere sideways to shake to. Climb out first, then re-plan.
            // Both, always. Climbing out answers "there is nowhere to walk to";
            // the shake answers the other failure this keeps hitting, where the
            // body stands on solid grass with onGround reading false and
            // pathfinder simply never starts moving. Doing only the climb left
            // that case unshaken and the retry failed identically.
            const out = goalBelow() ? { wasInPit: false } : await escapePit(bot, ctl, { mcData: this.mcData, maxClimb: 24 })
            if (out.wasInPit) tried.push(`вылез из ямы на ${out.climbed}${out.stopped ? ' (' + out.stopped + ')' : ''}`)
            await unstick(bot)
          }
        }
      }
      if (un) console.log('[unstuck] goto', JSON.stringify(un.report()))
      throw new Error(
        `не дошёл (${tried.length} попытки)${pit.wasInPit ? `, из ямы вылез на ${pit.climbed}${pit.stopped ? ' — ' + pit.stopped : ''}` : ''}. ` +
        `Последняя: ${lastError.message}`)
    }, { timeoutMs: (secs + 15) * 1000 })
  }

  // Sets a persistent follow goal and returns straight away. Block afterwards
  // with wait() so the follow keeps running while we listen for events.
  follow ({ player, distance = 3 }) {
    this.cancel()
    return this.immediate(async () => {
      const bot = this.require()
      this.updateMovements()
      const target = bot.players[player] && bot.players[player].entity
      if (!target) throw new Error(`не вижу игрока ${player} рядом`)
      bot.pathfinder.setGoal(new goals.GoalFollow(target, distance), true)
      // The one goal that outlives the call that set it. wait() is not exclusive
      // and therefore does not cancel it — that is the whole follow+wait pattern,
      // and also the reason the autopilot has to be able to tell «тело стоит без
      // дела» from «тело идёт за человеком».
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
  wait ({ seconds = 30 }) {
    const s = Math.max(1, Math.min(300, seconds))
    return this.runIntent('wait', async (ctl) => {
      await sleep(s * 1000, ctl)
      return { waited: s }
      // Ожидание слышит и жесты людей (gestures.js): присед, взгляд в упор,
      // брошенную вещь — живой игрок на них отвечает, а не спит дальше.
    }, { exclusive: false, timeoutMs: (s + 5) * 1000, interruptOn: [...require('./events').WAKES] })
  }

  // Raw turn, no result envelope — used by vision before taking a shot so the
  // buffered events are not drained into a throwaway response.
  async turnTo ({ x, y, z }) {
    const bot = this.require()
    await bot.lookAt(new Vec3(x, y, z), true)
  }

  lookAt ({ x, y, z }) {
    return this.immediate(async () => {
      await this.turnTo({ x, y, z })
      return { lookingAt: { x, y, z } }
    })
  }

  observe ({ radius = 24, fair } = {}) {
    return this.immediate(async () => {
      const bot = this.require()
      const useFair = fair === undefined ? this.cfg.fairPlay : !!fair
      return observe(bot, this.mcData, { radius, fair: useFair })
    })
  }

  // Кто рядом из людей, сразу словами: «Vasya в 4 блоках позади, в руке кирка».
  // Through immediate() and not runIntent, for the same reason base 'where' and
  // stash 'list' are: the answer to "кто рядом" must not cost the intent that
  // is running, and it has to arrive while the body is busy — being walked up
  // to in the middle of work is the whole case the routine exists for.
  players (p = {}) {
    return this.immediate(async () => {
      this.require()
      return social.players(this, p)
    })
  }

  // Follow with a standing watch on it, and blocking — that is the whole
  // difference from follow() above. follow() sets the raw goal and returns:
  // GoalFollow.isValid only asks `entity != null`
  // (node_modules/mineflayer-pathfinder/lib/goals.js:363) and the entity object
  // outlives the player logging out, so the goal keeps walking the body toward a
  // place nobody is standing in until someone thinks to call stop. escort
  // measures the gap, watches for lava, mobs and hunger, and clears the goal on
  // every exit — including the timeout fired from out here.
  escort (p = {}) {
    return this.runIntent('escort', ctl => {
      this.require()
      this.updateMovements()
      return escort(this, ctl, p)
    }, {
      timeoutMs: (Math.min(300, p.forSeconds ?? 60) + 20) * 1000,
      params: p,
      // Damage is the thing escort is watching for and answering about: a mob's
      // first hit has to reach the brain as «кто и в скольких блоках», not as a
      // bare interrupt with no report attached. Same call tunnel and surface
      // make, for the same reason. Chat still interrupts — the player talking is
      // usually the player being escorted, and that outranks the numbers.
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  // Отдать вещь человеку в руки и подобрать то, что он бросил. Оба намерения,
  // а не immediate: оба ходят телом, а всё, что ходит, обязано убирать за собой
  // цель pathfinder'а на любом выходе — правило, за которое заплатил escort.
  //
  // Чат СПЕЦИАЛЬНО не прерывает передачу, в отличие от escort. Передача и есть
  // ответ на сказанное человеком; его следующая реплика («спасибо», «ещё одну»)
  // приходит через пару секунд и разорвала бы работу ровно между броском и
  // распиской: вещи уже на земле, отчёта о них ещё нет. Ничего при этом не
  // теряется — чат копится в шине и приезжает вместе с результатом. А вот
  // здоровье и смерть прерывают: доставать кирку из рюкзака под мобом не время.
  giveItem (p = {}) {
    return this.runIntent('give', ctl => {
      this.require()
      this.updateMovements()
      return handover.give(this, ctl, p)
    }, {
      timeoutMs: (Math.min(180, p.timeoutSeconds ?? 60) + 20) * 1000,
      interruptOn: ['low_health', 'death', 'kicked', 'disconnected']
    })
  }

  takeItem (p = {}) {
    return this.runIntent('take', ctl => {
      this.require()
      this.updateMovements()
      return handover.take(this, ctl, p)
    }, {
      timeoutMs: (Math.min(120, p.timeoutSeconds ?? 25) + 20) * 1000,
      interruptOn: ['low_health', 'death', 'kicked', 'disconnected']
    })
  }

  // ------------------------------------------------------ survival actions

  mine (p = {}) {
    return this.runIntent('mine', ctl => {
      this.require()
      this.updateMovements()
      return actions.mine(this, ctl, p)
    }, { timeoutMs: Math.min(600, p.timeoutSeconds ?? 180) * 1000, params: p })
  }

  // Добор по памяти. `mine` спрашивает глаза и потому не может вернуться за
  // рудой, мимо которой прошло тело: на y=-59 штрек доложил алмазы на
  // 139,-57,159, а через сорок блоков mine ответил «не вижу в радиусе 24».
  // Это намерение спрашивает реестр (memory/state.json, ключ ore), куда
  // штрек кладёт ровно то, что сам вскрыл или увидел лучом.
  //
  // Без координат и без имени это не интент, а справка: «что ты помнишь» не
  // должно отменять то, чем тело сейчас занято. Тот же приём, что у stash.
  mineSeen (p = {}) {
    if (!p.at && !p.block) {
      return this.immediate(() => { this.require(); return mining.recallOre(this, p) })
    }
    return this.runIntent('mine_seen', ctl => {
      this.require()
      this.updateMovements()
      return mining.mineSeen(this, ctl, p)
    }, {
      // Дорога считается в бюджет: руда в шестнадцати блоках позади — это
      // сначала ходьба и только потом кирка.
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 180) + 20) * 1000,
      // Урон рвёт: добор — не штрек, ради него не стоят под ударами. Кампания
      // 2026-09-26: добор у края пещеры, зомби сняли 20 → 7, пока тело докапывало
      // жилу (рвал только low_health), и отойти на 6 хп уже не вышло.
      interruptOn: ['chat', 'damage', 'low_health', 'death', 'kicked', 'disconnected'],
      params: p
    })
  }

  digDown (p = {}) {
    // Deepslate takes roughly twice as long per swing as stone, and a descent
    // to the diamond layer is over a hundred blocks. A flat two minutes was
    // enough for the five-block test shaft and nothing else. A staircase cuts
    // three blocks per level instead of one and walks between them, so it gets
    // its own budget rather than a multiple of the shaft's.
    const stairs = p.mode === 'stairs' || p.mode === 'лестница'
    const depth = Math.max(1, Math.min(128, p.depth ?? 5))
    // The shaft took its budget from depth alone and ignored timeoutSeconds
    // outright, although mc_dig_down accepts it up to 600 — and the number lived
    // only out here, so when it ran out runIntent answered `timeout` and the
    // dug/gained the action was holding died with it. The same number is now
    // handed down as the action's own deadline; the intent keeps twenty seconds
    // more than the action, so the ordinary way for a shaft to run out of time is
    // a `done` with numbers and a `stopped`, not a bare clock.
    const budget = stairs
      ? Math.min(600, p.timeoutSeconds ?? 240)
      : Math.min(600, p.timeoutSeconds ?? (25 + depth * 4))
    return this.runIntent('dig_down', ctl => {
      this.require()
      return actions.digDown(this, ctl, { ...p, budgetSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      // Chip damage must not throw away a descent. Falling gravel, a stray
      // arrow through a cave mouth, a single skeleton hit — a 24-step staircase
      // was being abandoned on one point of damage. The action watches its own
      // health and stops itself below 6, and low_health still interrupts, so
      // the dangerous case is still reported. Same call that was already made
      // for fight, for the same reason.
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  explore (p = {}) {
    return this.runIntent('explore', ctl => {
      this.require()
      this.updateMovements()
      return actions.explore(this, ctl, p)
    }, { timeoutMs: (Math.min(280, p.timeoutSeconds ?? 45) + 20) * 1000, params: p })
  }

  // Sixty seconds was exactly the width of the happy path, which is why it held
  // until the day a table was left behind twelve blocks back. The unavoidable
  // worst case is two 20s waits for a windowOpen that never comes (the table is
  // unreliable on 1.21.11) with a fresh table placed between them, plus up to
  // 15s of bounded walking: about 58 seconds of honest work under a 60 second
  // budget. Ninety gives the retry the room it was written to have.
  craft (p = {}) {
    return this.runIntent('craft', ctl => {
      this.require()
      // The autopilot crafts replacement tools between turns, and two crafts
      // share one table, one window and one inventory. Refusing for a second is
      // cheaper than the half-finished window that used to come out of it.
      if (this.crafting) throw new Error('автопилот сейчас делает инструмент, повтори через секунду')
      return actions.craft(this, ctl, p)
    }, { timeoutMs: 90000, interruptOn: HOLDING })
  }

  place (p = {}) {
    return this.runIntent('place', ctl => {
      this.require()
      return actions.place(this, ctl, p)
    }, { timeoutMs: 45000 })
  }

  // Damage is expected in a fight and must not count as a reason to stop and
  // think — the action retreats on its own when health drops.
  fight (p = {}) {
    return this.runIntent('fight', ctl => {
      this.require()
      this.updateMovements()
      return combat.fight(this, ctl, p)
    }, {
      timeoutMs: (Math.min(300, p.timeoutSeconds ?? 60) + 15) * 1000,
      // Драку с человеком чат не рвёт: тот, с кем дерёшься, пишет посреди боя
      // («ахах», «ну всё»), и каждая строка останавливала бы бой на полувзмахе.
      // Строки не теряются — они лежат в событиях и приедут с отчётом.
      interruptOn: p.allowPlayer
        ? ['death', 'kicked', 'disconnected']
        : ['chat', 'death', 'kicked', 'disconnected']
    })
  }

  // Убежать от всех, кто рядом (flee.js). Урон не прерывает — побег под
  // ударами и есть смысл вызова.
  flee (p = {}) {
    return this.runIntent('flee', ctl => {
      this.require()
      return flee.smartFlee(this, ctl, {
        timeoutMs: Math.min(60, p.timeoutSeconds ?? 15) * 1000,
        safeDist: p.safeDist ?? 14
      })
    }, {
      timeoutMs: (Math.min(60, p.timeoutSeconds ?? 15) + 5) * 1000,
      interruptOn: ['chat', 'death', 'kicked', 'disconnected']
    })
  }

  // Лут: забрать сундук с постройки игры (данж, шахта, храм...). Без
  // координат — ближайший такой из видимых. force — и «чей-то» сундук.
  loot (p = {}) {
    return this.runIntent('loot', ctl => {
      this.require()
      this.updateMovements()
      return lootMod.loot(this, ctl, p)
    }, { timeoutMs: 90000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  // Постройки игры (structures.js): scan/list/where/plan/forget — без
  // движения; explore/loot — дойти, обезвредить ловушку, взять ценное.
  structure (p = {}) {
    const S = require('./structures')
    const mode = p.mode || 'scan'
    if (mode !== 'explore' && mode !== 'loot') {
      return this.immediate(async () => {
        this.require()
        if (mode === 'list') return { known: S.known(this, { all: !!p.all }) }
        if (mode === 'where') return S.whereNext(this, p.kind || 'village')
        if (mode === 'plan') return { go: S.opportunities(this, { radius: p.radius || 192 }) }
        if (mode === 'forget') return S.forget(this, p)
        const r = S.scan(this, { radius: Math.min(96, p.radius || 48) })
        return { seen: r.found, fresh: r.fresh.length, dim: r.dim, blocks: p.blocks ? r.blocks : undefined }
      })
    }
    const secs = Math.min(600, p.timeoutSeconds || 300)
    return this.runIntent('structure', ctl => {
      this.require()
      return S.explore(this, ctl, { ...p, chestsOnly: mode === 'loot' || p.chestsOnly })
    }, { timeoutMs: (secs + 5) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  // То же, но от автопилота: без runIntent, чтобы не съесть шину событий
  // (см. retaliate). Мозг любым своим намерением это снимает.
  async autoLoot (target) {
    this.require()
    // mc_wait — это мозг слушает, тело свободно (autopilot.bodyBusy).
    if (this.current && this.current.name !== 'wait') return { busy: this.current.name }
    const ctl = { aborted: false, onAbort: [] }
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
    }
    this.current = { name: 'loot', ctl }
    const t = gameClock.setTimeout(() => ctl.abort(), 60000)
    try {
      this.updateMovements()
      return await lootMod.loot(this, ctl, target.entityId !== undefined ? { entityId: target.entityId } : target.at)
    } catch (err) {
      return { error: String((err && err.message) || err) }
    } finally {
      gameClock.clearTimeout(t)
      ctl.abort()
      if (this.current && this.current.ctl === ctl) this.current = null
    }
  }

  // Выстрелить из лука в ближайшую сущность с этим именем count раз. Для тира:
  // каждая стрела прослежена — попала или на сколько промахнулась.
  shoot (p = {}) {
    const count = Math.max(1, Math.min(20, p.count ?? 1))
    return this.runIntent('shoot', async ctl => {
      const bot = this.require()
      const target = bot.nearestEntity(e => e && e.name === p.target && e.position)
      if (!target) throw new Error(`не вижу ${p.target}`)
      const shots = []
      let last = null
      let vel = { x: 0, y: 0, z: 0 }
      const velFn = () => {
        const now = gameClock.now()
        const pos = target.position
        if (last) {
          const dt = (now - last.t) / 50
          if (dt > 0.3) vel = { x: (pos.x - last.x) / dt, y: (pos.y - last.y) / dt, z: (pos.z - last.z) / dt }
        }
        last = { x: pos.x, y: pos.y, z: pos.z, t: now }
        return vel
      }
      // strafe:true — стрейфиться во время натяжения, как в бою (проверка
      // того, что движение стрелка не уводит стрелу).
      let side = 'left'
      const onDraw = p.strafe
        ? (ms) => {
            if (ms % 600 < 60) side = side === 'left' ? 'right' : 'left'
            try { bot.setControlState('left', side === 'left'); bot.setControlState('right', side === 'right') } catch {}
          }
        : null
      // probe:true — сразу после выстрела спросить у сервера точные Motion и
      // Pos нашей стрелы (/data get entity), и записать, как мы в момент
      // спуска двигались и куда смотрели. Правда из игры, а не из догадок.
      const probeArrow = async () => {
        const lines = []
        const onMsg = (m) => { if (/Motion|Pos|\[/.test(m)) lines.push(m) }
        bot.on('messagestr', onMsg)
        try {
          const sel = `@e[type=arrow,sort=nearest,limit=1,distance=..8]`
          bot.chat(`/data get entity ${sel} Motion`)
          await sleep(250)
          bot.chat(`/data get entity ${sel} Pos`)
          await sleep(350)
        } finally { bot.removeListener('messagestr', onMsg) }
        return lines
      }
      for (let i = 0; i < count && !ctl.aborted; i++) {
        const release = {}
        const shot = await bow.shoot(bot, target, {
          velFn,
          onDraw,
          follow: !p.probe,
          mode: p.mode || 'compensate',
          shouldStop: () => ctl.aborted,
          onRelease: (moved) => {
            const v = bot.entity.velocity
            release.vel = v ? { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) } : null
            // Предсказание: 3 × направление взгляда + смещение за тик (y — только в воздухе).
            const yw = bot.entity.yaw; const pt = bot.entity.pitch
            const m = moved || { x: 0, y: 0, z: 0 }
            release.predicted = {
              x: +(-Math.sin(yw) * Math.cos(pt) * 3 + m.x).toFixed(3),
              y: +(Math.sin(pt) * 3 + (bot.entity.onGround ? 0 : m.y)).toFixed(3),
              z: +(-Math.cos(yw) * Math.cos(pt) * 3 + m.z).toFixed(3)
            }
            release.yawDeg = +(bot.entity.yaw * 180 / Math.PI).toFixed(2)
            release.pitchDeg = +(bot.entity.pitch * 180 / Math.PI).toFixed(2)
            const pp = bot.entity.position
            release.pos = { x: +pp.x.toFixed(3), y: +pp.y.toFixed(3), z: +pp.z.toFixed(3) }
            release.onGround = bot.entity.onGround
          }
        })
        if (p.probe && shot.shot) { shot.release = release; shot.server = await probeArrow() }
        shots.push(shot)
        if (p.probe) await sleep(1500)
      }
      const hit = shots.filter(s => s.hit).length
      return { target: p.target, hit, of: shots.length, shots }
    }, { timeoutMs: count * 6000 + 10000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
  }

  // Подготовка к бою из сырья (prep.js): скрафтить снаряжение по тактике
  // strategy (rush | smart | full). Прерывается уроном: пришли бить — бросаем
  // верстак и деремся тем, что успели.
  prep (p = {}) {
    return this.runIntent('prep', ctl => {
      const bot = this.require()
      const enemy = p.enemy || null
      const shouldStop = (mode) => {
        const e = enemy && bot.players[enemy] && bot.players[enemy].entity
        if (!e) return false
        const d = e.position.distanceTo(bot.entity.position)
        return mode === 'soon' ? d < 14 : d < 5
      }
      return prepMod.prepare(this, ctl, { strategy: p.strategy || 'full', shouldStop })
    }, { timeoutMs: 120000, interruptOn: ['damage', 'death', 'kicked', 'disconnected'] })
  }

  // Зачарование (enchant.js): mode plan | setup | table (по умолчанию) | anvil.
  // Верстачные работы (как prep): рвёт урон и смерть, не чат — клик посреди
  // окна стола/стойки, оборванный репликой, оставляет вещь в окне. Чат едет в
  // events и читается в том же ответе.
  enchant (p = {}) {
    if (p.mode === 'plan') return this.immediate(async () => { this.require(); return require('./enchant').plan(this, p) })
    return this.runIntent('enchant', ctl => {
      this.require()
      return require('./enchant').run(this, ctl, p)
    }, { timeoutMs: 240000, interruptOn: WORKBENCH })
  }

  // Зелья (brew.js): варка партиями по 3, шаг 20 с. plan:true — только план.
  brew (p = {}) {
    if (p.plan) return this.immediate(async () => { this.require(); return require('./brew').brew(this, { aborted: false, onAbort: [] }, p) })
    const steps = (require('./brew').chainOf(require('./brew').resolvePotion(p.potion || 'fire_resistance') || 'awkward') || []).length + (p.splash ? 1 : 0)
    const batches = Math.ceil(Math.max(1, Math.min(6, p.count || 3)) / 3)
    return this.runIntent('brew', ctl => {
      this.require()
      return require('./brew').brew(this, ctl, p)
    }, { timeoutMs: (150 + steps * batches * 25) * 1000, interruptOn: WORKBENCH })
  }

  // Сборы в поход (fightkit.js): чек-лист + крафт того, что можно сейчас.
  kit (p = {}) {
    if (p.craft === false) return this.immediate(async () => { this.require(); return require('./fightkit').kit(this, { aborted: false, onAbort: [] }, p) })
    return this.runIntent('kit', ctl => {
      this.require()
      return require('./fightkit').kit(this, ctl, p)
    }, { timeoutMs: 180000, interruptOn: WORKBENCH })
  }

  // Тир бросков: один бросок item в точку to {x,y,z} на ходу move (still,
  // strafe, run, back, jump). Правда из игры: жемчуг переносит бота туда, где
  // упал (forcedMove), оседающее зелье оставляет облако там, где разбилось.
  // mode 'old' — прошлый прицел, для сравнения.
  throwTest (p = {}) {
    return this.runIntent('throw', async ctl => {
      const bot = this.require()
      const it = bot.inventory.items().find(i => i.name === p.item)
      if (!it) throw new Error(`нет ${p.item}`)
      const to = new Vec3(p.to.x, p.to.y, p.to.z)
      const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint']
      const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
      const move = p.move || 'still'
      await bot.equip(it, 'hand')
      await bot.lookAt(to, true)
      // Разогнаться: к броску тело идёт с установившейся скоростью.
      let side = 'left'
      const t0 = gameClock.now()
      const drive = () => {
        if (move === 'strafe' || move === 'jump') {
          if ((gameClock.now() - t0) % 700 < 60) side = side === 'left' ? 'right' : 'left'
          set('left', side === 'left'); set('right', side === 'right')
        }
        if (move === 'run') { set('forward', true); set('sprint', true) }
        if (move === 'back') set('back', true)
      }
      while (gameClock.now() - t0 < 900 && !ctl.aborted) {
        drive()
        await bot.lookAt(to, true).catch(() => {})
        await sleep(50)
      }
      if (move === 'jump') {
        set('jump', true)
        // В воздух и чуть после вершины.
        const j0 = gameClock.now()
        while (gameClock.now() - j0 < 600 && (bot.entity.onGround || bot.entity.velocity.y > 0.1)) { drive(); await sleep(10) }
        set('jump', false)
      }
      let landed = null
      const onMove = () => { if (!landed) landed = bot.entity.position.clone() }
      const onSpawn = (e) => {
        if (!landed && e && e.name === 'area_effect_cloud' && e.position && e.position.distanceTo(to) < 12) landed = e.position.clone()
      }
      bot.on('forcedMove', onMove)
      bot.on('entitySpawn', onSpawn)
      let r
      try {
        r = await throwMod.throwAt(bot, to, { item: bot.heldItem, mode: p.mode || 'exact' })
        for (const k of keys) set(k, false)
        const w0 = gameClock.now()
        while (!landed && gameClock.now() - w0 < 5000 && !ctl.aborted) await sleep(50)
      } finally {
        for (const k of keys) set(k, false)
        bot.removeListener('forcedMove', onMove)
        bot.removeListener('entitySpawn', onSpawn)
      }
      const err = landed ? Math.round(Math.hypot(landed.x - to.x, landed.z - to.z) * 100) / 100 : null
      return {
        ...r,
        move,
        landed: landed ? { x: +landed.x.toFixed(2), y: +landed.y.toFixed(2), z: +landed.z.toFixed(2) } : null,
        err,
        predictedErr: r.land ? Math.round(Math.hypot(r.land.x - to.x, r.land.z - to.z) * 100) / 100 : null,
        modelErr: r.land && landed ? Math.round(Math.hypot(r.land.x - landed.x, r.land.z - landed.z) * 100) / 100 : null
      }
    }, { timeoutMs: 15000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
  }

  // Око эндера: mode throw — один бросок и направление, mode find — два броска
  // с отходом поперёк и координаты крепости.
  // Ведро: набрать воды или лавы из видимого источника (obsidian.js).
  bucket (p = {}) {
    return this.runIntent('bucket', ctl => {
      this.require()
      this.updateMovements()
      return obsidianMod.fillBucket(this, ctl, { fluid: p.fluid === 'lava' ? 'lava' : 'water', radius: p.radius ?? 24 })
    }, { timeoutMs: 60000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  // Животные, питомцы, голем, жители (fauna.js). mode:
  // tame / breed / sit / stand — животные; golem — голем; trade — житель.
  animals (p = {}) {
    const mode = p.mode || 'tame'
    return this.runIntent('animals', ctl => {
      this.require()
      this.updateMovements()
      if (mode === 'tame') return fauna.tame(this, ctl, p)
      if (mode === 'breed') return fauna.breed(this, ctl, p)
      if (mode === 'sit' || mode === 'stand') return fauna.pet(this, ctl, { ...p, sit: mode === 'sit' })
      throw new Error(`не знаю режим ${mode}: tame / breed / sit / stand`)
    }, { timeoutMs: 120000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  golem (p = {}) {
    return this.runIntent('golem', ctl => {
      this.require()
      return fauna.golem(this, ctl, p)
      // Голем на железо (mode kill, поток route): подход, столб, ~12 ударов топором — до 110 с; постройка — 60 с.
    }, { timeoutMs: p && p.mode === 'kill' ? (Math.min(110, Number(p.timeoutSeconds) || 85) + 15) * 1000 : 60000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  trade (p = {}) {
    return this.runIntent('trade', ctl => {
      this.require()
      this.updateMovements()
      return fauna.trade(this, ctl, p)
    }, { timeoutMs: 60000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  // Рюкзак: сколько места, что пойдёт в выброс первым (status — сразу, без
  // намерения); tidy — выбросить хлам сверх запасов (pack.js).
  pack (p = {}) {
    if ((p.mode || 'status') === 'status') {
      return this.immediate(async () => packMod.status(this.require()))
    }
    return this.runIntent('pack', async () => {
      const bot = this.require()
      const before = packMod.status(bot)
      // also: «cobblestone:128, cobbled_deepslate:128» — ещё и это сверх числа.
      let also = null
      if (p.also) {
        also = {}
        for (const part of String(p.also).split(',')) {
          const [name, n] = part.split(':').map(s => s.trim())
          if (name) also[name] = Math.max(0, Number(n) || 0)
        }
      }
      const r = await packMod.tidy(bot, { also })
      // Отойти от выброшенного: через 2 с (задержка подбора 40 тиков) тело,
      // стоящее над ним, подберёт всё обратно.
      if (r.tossed.length) try {
        const yaw = bot.entity.yaw
        await bot.look(yaw + Math.PI, 0, true)
        bot.setControlState('forward', true)
        await sleep(900)
      } finally { bot.setControlState('forward', false) }
      return { ...r, free: bot.inventory.emptySlotCount(), was: before.free }
    }, { timeoutMs: 20000, interruptOn: ['death', 'kicked', 'disconnected'] })
  }

  // Схрон: сундук там, где стоишь, и всё лишнее в него — именованная «база»
  // (containers.js baseSet + stashPut), так что mc_base go / mc_stash take
  // по тому же имени ведут обратно и достают. list — все схроны из памяти.
  cache (p = {}) {
    const mode = p.mode || 'make'
    if (mode === 'list') {
      return this.immediate(async () => {
        const places = this.journal.state.places || {}
        const out = []
        for (const [name, r] of Object.entries(places)) {
          if (!/^схрон/.test(name) || !r) continue
          out.push({ name, x: r.x, y: r.y, z: r.z, dimension: r.dimension, chests: (r.chests || []).map(c => c.contents || {}) })
        }
        return { caches: out, text: out.length ? out.map(c => `${c.name} на ${c.x},${c.y},${c.z}`).join('; ') : 'схронов нет' }
      })
    }
    return this.runIntent('cache', async ctl => {
      this.require()
      this.updateMovements()
      let name = p.name
      if (!name) {
        const taken = new Set(Object.keys(this.journal.state.places || {}))
        let n = 1
        while (taken.has(`схрон-${n}`)) n++
        name = `схрон-${n}`
      }
      const set = await containers.base(this, ctl, { mode: 'set', name, radius: 6, torch: false })
      const put = await containers.stash(this, ctl, { mode: 'put', name, item: p.item || 'all', keep: p.keep || null })
      return { name, at: set.at || put.at, put: put.put, kept: put.kept, stopped: put.stopped, note: put.note }
    }, { timeoutMs: 120000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  // Обсидиан на портал: готовый видимый — ломать, лаву — залить водой и
  // ломать то, что застыло (obsidian.js).
  obsidian (p = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? 300)
    return this.runIntent('obsidian', ctl => {
      this.require()
      this.updateMovements()
      return obsidianMod.obsidian(this, ctl, { count: p.count ?? 10, radius: p.radius ?? 20, timeoutSeconds: budget })
    }, { timeoutMs: (budget + 20) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  stronghold (p = {}) {
    // Путь от точки до горящего портала (endportal.js): go — дойти, уточнить
    // оком, прокопаться к кирпичу; room — найти комнату по коридорам; fill —
    // вставить глаза в рамки.
    if (p.mode === 'go' || p.mode === 'room' || p.mode === 'fill' || p.mode === 'travel') return this.strongholdPath(p)
    // Спидран-решатель (stronghold.js, 2026-09-26): solve — по броскам из
    // памяти, blind — точка слепого выхода из Ада; без тела и мира.
    if (p.mode === 'solve') return this.immediate(async () => { this.require(); return stronghold.solveStored(this, p) })
    if (p.mode === 'blind') return this.immediate(async () => { const bot = this.require(); return stronghold.blindPlan(bot.entity.position, require('./worlds').worldOf(bot)) })
    const find = p.mode !== 'throw'
    const budget = Math.min(600, p.timeoutSeconds ?? 240)
    return this.runIntent('stronghold', async ctl => {
      this.require()
      this.updateMovements()
      if (find) return stronghold.findStronghold(this, ctl, { sideways: p.sideways ?? 24, maxThrows: p.maxThrows ?? 4, timeoutSeconds: budget })
      const t = await stronghold.throwEye(this, ctl)
      if (t.thrown) stronghold.rememberThrow(this, t)
      return t
    }, {
      timeoutMs: (budget + 20) * 1000,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  // Огненные стержни у спавнера блейзов (blaze.js): бой за боем, пока в рюкзаке
  // не станет нужное число. Урон не прерывает — это бой; хп стережёт сам.
  blaze (p = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? 240)
    return this.runIntent('blaze', ctl => {
      this.require()
      this.updateMovements()
      return blazeMod.farmRods(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      interruptOn: ['chat', 'death', 'kicked', 'disconnected']
    })
  }

  // Эндер-дракон (dragon.js): кристаллы, бой, яйцо, домой. Урон не прерывает —
  // это бой, хп стережёт сам модуль (еда, яма с крышкой). Чат тоже не рвёт:
  // оборванный посреди поля тело стояло бы под облаком огня; строки людей
  // лежат в событиях и приедут с отчётом, а срок по умолчанию короткий.
  dragon (p = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? 300)
    return this.runIntent('dragon', ctl => {
      this.require()
      return dragonMod.dragon(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      interruptOn: ['death', 'kicked', 'disconnected']
    })
  }

  // Крепость Ада глазами (fortress.js): look — только взгляд, explore — идти
  // отрезками по направлению и смотреть после каждого.
  fortress (p = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? 240)
    return this.runIntent('fortress', ctl => {
      this.require()
      this.updateMovements()
      return fortressMod.scout(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  // Жемчуг эндера (pearls.js): hunt — эндермены из ямы, barter — золото пиглинам.
  pearls (p = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? (p.mode === 'barter' ? 180 : 240))
    return this.runIntent('pearls', ctl => {
      this.require()
      this.updateMovements()
      return pearlsMod.pearls(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: p.mode === 'barter'
        ? ['chat', 'low_health', 'death', 'kicked', 'disconnected']
        : ['chat', 'death', 'kicked', 'disconnected']
    })
  }

  // Бастион (bastion.js): золотые блоки и сундуки без злости пиглинов, потом бартер.
  bastion (p = {}) {
    const budget = Math.min(1800, p.timeoutSeconds ?? 400) // второй бастион — сотни блоков по Аду до него
    return this.runIntent('bastion', ctl => {
      this.require()
      this.updateMovements()
      return bastionMod.bastion(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'death', 'kicked', 'disconnected']
    })
  }

  // Переход по Аду закрытым штреком на высоте band (tunnel.js): к бастиону, крепости, порталу.
  netherTunnel (p = {}) {
    // По маршруту (via) между бастионами — ~750 ходов, до 40 минут.
    const budget = Math.min(Array.isArray(p.via) && p.via.length ? 2700 : 1800, p.timeoutSeconds ?? 900)
    return this.runIntent('nether_tunnel', async ctl => {
      this.require()
      this.updateMovements()
      const { tunnelTo } = require('./tunnel')
      const t = { x: Number(p.x), y: p.y !== undefined ? Number(p.y) : undefined, z: Number(p.z) }
      if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) throw new Error('tunnel: нужны x и z')
      const nb = p.noBreachNear && Number.isFinite(Number(p.noBreachNear.x)) ? { x: Number(p.noBreachNear.x), z: Number(p.noBreachNear.z), r: Number(p.noBreachNear.r) || 48 } : null
      const r = await tunnelTo(this, ctl, t, { band: p.band, radius: p.radius ?? 4, via: p.via, budgetCheck: p.budgetCheck === true, ironOk: p.ironOk === true, noBreachNear: nb, deadline: gameClock.now() + budget * 1000, log: (w, d) => console.log('[tunnel] ' + w + ' ' + JSON.stringify(d)) })
      delete r.own
      return { ...r, note: r.ok ? `штреком дошёл: кусков ${r.segs}, вскрытий ${r.breach}, обходов ${r.detours}, копок ${r.dug}` : `штрек встал: ${r.why}` }
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'death', 'kicked', 'disconnected']
    })
  }

  strongholdPath (p = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? (p.mode === 'fill' ? 180 : 300))
    const work = { go: endportal.goStronghold, room: endportal.findRoom, fill: endportal.fillFrames, travel: (s, c, q) => require('./travel').travel(s, c, q) }[p.mode]
    return this.runIntent('stronghold', ctl => {
      this.require()
      this.updateMovements()
      return work(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      // Копка и коридоры не рвутся от царапины (как dig_down и tunnel);
      // глаза в рамки — окно, которое не бросают на полпути. Дорога через Ад
      // (travel) — как переход порталом: урон не рвёт, бои ведёт сам.
      interruptOn: p.mode === 'fill' ? HOLDING : (p.mode === 'travel' || p.mode === 'room') ? ['chat', 'death', 'kicked', 'disconnected'] : ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  // Бой, который начал не мозг, а обида: автопилот отвечает тому, кто бьёт.
  // Не через runIntent — тот в конце выгребает шину событий, и всё, что
  // случилось за бой, ушло бы в никуда вместо ответа мозгу. Здесь current
  // занят тем же способом, чтобы автопилот и мозг видели тело занятым, а
  // любое намерение мозга по-прежнему снимает бой (cancel в runIntent).
  async retaliate (name, p = {}) {
    const bot = this.require()
    if (this.current && this.current.name === 'retaliate') return { already: true }
    this.cancel()
    const ctl = { aborted: false, onAbort: [] }
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
    }
    this.current = { name: 'retaliate', ctl, target: name }
    const onDeath = () => ctl.abort()
    bot.once('death', onDeath)
    try {
      this.updateMovements()
      return await combat.fight(this, ctl, { target: name, allowPlayer: true, ...p })
    } catch (err) {
      return { error: String((err && err.message) || err) }
    } finally {
      bot.removeListener('death', onDeath)
      ctl.abort()
      if (this.current && this.current.ctl === ctl) this.current = null
    }
  }

  // Вступиться за друга: моб бьёт человека рядом — бьём этого моба (по id, не
  // «ближайшего»). Как retaliate: своё намерение, чтобы автопилот и мозг
  // видели занятость, и тот же бой pvp.js. Людей не бьёт никогда.
  async defend (entityId, friend, p = {}) {
    const bot = this.require()
    if (this.current && this.current.name !== 'wait') return { busy: this.current.name }
    this.cancel()
    const ctl = { aborted: false, onAbort: [] }
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
    }
    this.current = { name: 'defend', ctl, target: `#${entityId}`, friend }
    const onDeath = () => ctl.abort()
    bot.once('death', onDeath)
    // Убит ли именно он: pvp.duel видит исчезновение цели раньше, чем пакет
    // смерти, и называет его «пропал из виду».
    let slain = false
    const onDead = (e) => { if (e && e.id === entityId) slain = true }
    bot.on('entityDead', onDead)
    try {
      this.updateMovements()
      const r = await combat.fight(this, ctl, { target: `#${entityId}`, allowPlayer: false, timeoutSeconds: 45, retreatAtHealth: 6, ...p })
      if (slain && r && typeof r === 'object' && !r.killed) r.killed = r.target || true
      return r
    } catch (err) {
      return { error: String((err && err.message) || err), killed: slain || undefined }
    } finally {
      bot.removeListener('entityDead', onDead)
      bot.removeListener('death', onDeath)
      ctl.abort()
      if (this.current && this.current.ctl === ctl) this.current = null
    }
  }

  // Smelting. Without a furnace the run stops at stone tools.
  smelt (p = {}) {
    return this.runIntent('smelt', ctl => {
      this.require()
      return containers.smelt(this, ctl, p)
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 120) + 30) * 1000, interruptOn: HOLDING })
  }

  chestPut (p = {}) {
    return this.runIntent('chest_put', ctl => {
      this.require()
      this.updateMovements()
      return containers.chestPut(this, ctl, p)
    }, { timeoutMs: 60000, interruptOn: HOLDING })
  }

  chestTake (p = {}) {
    return this.runIntent('chest_take', ctl => {
      this.require()
      this.updateMovements()
      return containers.chestTake(this, ctl, p)
    }, { timeoutMs: 60000, interruptOn: HOLDING })
  }

  chestList (p = {}) {
    return this.runIntent('chest_list', ctl => {
      this.require()
      this.updateMovements()
      return containers.chestList(this, ctl, p)
    }, { timeoutMs: 45000, interruptOn: HOLDING })
  }

  // The base: a place in memory plus the operations over it. `where`, `forget`
  // and stash `list` never move the body and never read the world, so they go
  // through immediate() — knowing where home is and what lies in the stash must
  // not cost a turn of the brain, and must still answer with the bot offline.
  base (p = {}) {
    const mode = String(p.mode || 'where').trim().toLowerCase()
    if (mode === 'where' || mode === 'forget') return this.immediate(() => containers.baseNow(this, p))
    return this.runIntent('base', ctl => {
      this.require()
      this.updateMovements()
      return containers.base(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 120) + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  stash (p = {}) {
    if (String(p.mode || 'list').trim().toLowerCase() === 'list') {
      return this.immediate(() => containers.stashNow(this, p))
    }
    return this.runIntent('stash', ctl => {
      this.require()
      this.updateMovements()
      return containers.stash(this, ctl, p)
    }, { timeoutMs: 90000, interruptOn: HOLDING })
  }

  // Armour is not an intent: it is a housekeeping swap the autopilot also does
  // on its own, so it must not cancel whatever the brain is in the middle of.
  wearBestArmor (p = {}) {
    return this.immediate(() => {
      this.require()
      return armor.equipBestArmor(this, { aborted: false, onAbort: [] }, p)
    })
  }

  // Horizontal mining. The only way to find ore at depth — dig_down gets you to
  // stone, a drift gets you past it.
  tunnel (p = {}) {
    return this.runIntent('tunnel', ctl => {
      this.require()
      this.updateMovements()
      return mining.tunnel(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 180) + 20) * 1000,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'],
      params: p
    })
  }

  // The answer to night when there is no bed: a hole with the lid pulled shut.
  // Урон и низкое здоровье нору не рвут (research/05-synthesis.md C.3a, H1): укрытие — единственное аварийное
  // действие, которое прерывалось ровно тем, от чего защищает, — удар посреди копки оставлял открытую яму,
  // кампания звала нору снова, следующий удар рвал и её. Рвут только человек, смерть и связь.
  shelter (p = {}) {
    return this.runIntent('shelter', ctl => {
      this.require()
      return survival.shelter(this, ctl, p)
    }, { timeoutMs: 90000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
  }

  // Getting home from the diamond layer. Long by nature — it returns partial
  // progress and expects to be called again, the same way explore does.
  surface (p = {}) {
    return this.runIntent('surface', ctl => {
      this.require()
      this.updateMovements()
      return survival.surface(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 240) + 25) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  recoverLoot (p = {}) {
    return this.runIntent('recover', ctl => {
      this.require()
      this.updateMovements()
      return survival.recoverLoot(this, ctl, p)
    }, {
      timeoutMs: (Math.min(300, p.timeoutSeconds ?? 90) + 25) * 1000,
      params: p,
      // recover digs now, and a fetch that ends on the first scratch never
      // reaches the pile: measured in try-surface, the descent to loot 14
      // levels down was cut by a single damage event. Same policy the other
      // long digs already have — health and death still stop it.
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  // Ночь целиком (bedtime.js): сумерки → кровать → мобы в коробке сна ±8/±5 →
  // бункер под землёй → сон → утром кровать с собой. simple: только лечь.
  sleepInBed (p = {}) {
    if (p.simple) {
      return this.runIntent('sleep', ctl => {
        this.require()
        return actions.sleepInBed(this, ctl, p)
      }, { timeoutMs: (Math.min(120, p.waitSeconds ?? 40) + 20) * 1000 })
    }
    // mode=spawn — кровать как точка возрождения (клик днём), mode=take — забрать.
    if (p.mode === 'spawn' || p.mode === 'take') {
      return this.runIntent('sleep', ctl => {
        this.require()
        const bt = require('./bedtime')
        return p.mode === 'spawn' ? bt.setSpawn(this, ctl, p) : bt.takeSpawnBed(this, ctl)
      }, { timeoutMs: 40000, params: p })
    }
    return this.runIntent('sleep', ctl => {
      this.require()
      this.updateMovements()
      return require('./bedtime').night(this, ctl, p)
    }, { timeoutMs: (Math.max(60, Math.min(600, p.timeoutSeconds ?? 300)) + 20) * 1000, params: p })
  }

  wakeUp () {
    return this.immediate(() => { this.require(); return actions.wakeUp(this) })
  }

  equipItem (p = {}) {
    return this.immediate(() => { this.require(); return actions.equip(this, p) })
  }

  eat (p = {}) {
    return this.immediate(async () => {
      this.require()
      this.eating = true
      try { return await actions.eat(this, p) } finally { this.eating = false }
    })
  }

  dropItem (p = {}) {
    return this.immediate(() => { this.require(); return actions.drop(this, p) })
  }

  // Портал в Ад: рама из десяти обсидианов, огонь и координаты в памяти.
  // `where` и `forget` не двигают тело и не читают мир — через immediate(), по
  // той же причине, что base 'where' и stash 'list': «где мой портал» не должно
  // стоить хода мозга и должно отвечать даже с ботом офлайн.
  // Полторы минуты по умолчанию — это расчистка котлована и десять постановок
  // блока. Обсидиан здесь только ставится: ломать его умеет одна алмазная кирка,
  // и это отдельная работа для mine.
  portal (p = {}) {
    const mode = String(p.mode || 'build').trim().toLowerCase()
    if (mode === 'where' || mode === 'forget') return this.immediate(() => nether.portalNow(this, p))
    // Переход (nether.js enter). Чат не рвёт: оборванное стояние — это тело на
    // пороге чужого мира, а человек подождёт один ход, строки приедут в
    // событиях. Урон не рвёт тоже: у портала прибытия бьют, а шаг назад в портал
    // хуже шага вперёд. Своё событие dimension намерение как раз и ждёт.
    if (mode === 'enter') {
      return this.runIntent('portal', ctl => {
        this.require()
        this.updateMovements()
        return nether.enter(this, ctl, p)
      }, {
        timeoutMs: (Math.min(600, p.timeoutSeconds ?? 90) + 20) * 1000,
        params: p,
        interruptOn: ['death', 'kicked', 'disconnected']
      })
    }
    // Литьё рамы вёдрами у лавы, без алмазной кирки (cast.js), и поджиг
    // готовой рамы тем же nether.portal. Долгая работа: царапина не рвёт, как
    // dig_down, — здоровье и смерть рвут.
    if (mode === 'cast') {
      return this.runIntent('portal', async ctl => {
        this.require()
        this.updateMovements()
        const r = await require('./cast').castPortal(this, ctl, p)
        if (!r.built || ctl.aborted) return r
        const lit = await nether.portal(this, ctl, { mode: 'build', timeoutSeconds: 60 })
        return { ...r, lit: !!(lit && lit.lit), light: lit }
      }, {
        timeoutMs: (Math.min(600, p.timeoutSeconds ?? 540) + 90) * 1000,
        params: p,
        interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
      })
    }
    return this.runIntent('portal', ctl => {
      this.require()
      this.updateMovements()
      return nether.portal(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 150) + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  // Архитектор (architect.js). kinds/plan/status/forget — справка без мира и
  // без тела, через immediate: договориться с игроком о постройке не должно
  // стоить хода и не должно рвать то, чем тело занято. preview читает мир и
  // может заглянуть в сундуки рядом — короткое намерение. build — долгое:
  // рвётся чатом, здоровьем и смертью, но не царапиной (как штрек).
  build (p = {}) {
    const mode = String(p.mode || 'build').trim().toLowerCase()
    if (mode === 'kinds' || mode === 'plan') return this.immediate(() => architect.kinds(this, mode === 'plan' ? p : {}))
    if (mode === 'status') return this.immediate(() => architect.status(this))
    if (mode === 'forget') return this.immediate(() => architect.forget(this))
    if (mode === 'preview') {
      return this.runIntent('build', ctl => {
        this.require()
        this.updateMovements()
        return architect.preview(this, ctl, p)
      }, { timeoutMs: 120000, interruptOn: HOLDING })
    }
    return this.runIntent('build', ctl => {
      this.require()
      this.updateMovements()
      return architect.build(this, ctl, { ...p, mode })
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 240) + 25) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

  // Разложить рюкзак и сундуки склада по категориям (sorting.js).
  sortStorage (p = {}) {
    return this.runIntent('sort', ctl => {
      this.require()
      this.updateMovements()
      return sorting.sort(this, ctl, p)
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 180) + 30) * 1000, interruptOn: HOLDING })
  }

  // Табличка: переписать или повесить новую.
  writeSign (p = {}) {
    return this.runIntent('sign', ctl => {
      this.require()
      this.updateMovements()
      return sorting.sign(this, ctl, p)
    }, { timeoutMs: 45000, interruptOn: HOLDING })
  }

  // Грядки (farm.js). status — сразу, без намерения: что видно на поле.
  // Остальное — долгое намерение, рвётся чатом, здоровьем, смертью, но не
  // царапиной: поле на 80 клеток — это минута работы.
  farm (p = {}) {
    const mode = String(p.mode || 'status').toLowerCase()
    if (mode === 'status') {
      return this.immediate(async () => {
        this.require()
        const at = p.at ? new Vec3(Math.floor(p.at.x), Math.floor(p.at.y), Math.floor(p.at.z)) : null
        return farmMod.survey(this, { radius: Math.max(2, Math.min(24, p.radius ?? 12)), center: at })
      })
    }
    return this.runIntent('farm', ctl => {
      this.require()
      return farmMod.run(this, ctl, { ...p, mode })
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 180) + 15) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  // Езда (ride.js): лошадь — приручить, осёдлать, доехать, привязать; лодка —
  // скрафтить, спустить, переплыть, подобрать. Долгое намерение: рвётся чатом,
  // здоровьем, смертью, но не царапиной — лошадь, сбрасывая, не бьёт.
  ride (p = {}) {
    return this.runIntent('ride', ctl => {
      this.require()
      this.updateMovements()
      return rideMod.run(this, ctl, p)
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 120) + 20) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  // Механизмы из чертежа (mechanism.js): самосрез тростника — build / collect;
  // status и plan — сразу, без намерения.
  mechanism (p = {}) {
    const mode = String(p.mode || 'status').toLowerCase()
    if (mode === 'status' || mode === 'plan') {
      return this.immediate(async () => {
        this.require()
        return mechanismMod.run(this, { aborted: false, onAbort: [] }, { ...p, mode })
      })
    }
    return this.runIntent('mechanism', ctl => {
      this.require()
      this.updateMovements()
      return mechanismMod.run(this, ctl, { ...p, mode })
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 240) + 15) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

  // -------------------------------------------------------------- memory ops

  setGoal ({ text }) {
    return this.immediate(async () => {
      this.journal.patch(s => { s.goal = text })
      this.journal.append('цель', text, this.bot && this.bot.entity && this.bot.entity.position)
      return { goal: text }
    })
  }

  remember ({ kind = 'заметка', text, place }) {
    return this.immediate(async () => {
      const pos = this.bot && this.bot.entity ? this.bot.entity.position : null
      if (place) {
        // Merge, never replace. containers.js hangs the whole stash off this same
        // record — `chests`, and with it `sky`, `why`, `table`, `furnace` — and
        // states the contract out loud next to STASH_RADIUS: «mc_remember
        // place=база rewrites x/y/z and leaves our keys alone». Assigning a fresh
        // object honoured half of that: one note about the base and every chest in
        // the общак was gone from memory.
        //
        // xyz(null) is null and spreading null adds nothing, so a note remembered
        // while the bot is offline no longer wipes the coordinates either.
        // Мир записи (worlds.js). Слить заметку в запись ДРУГОГО мира нельзя:
        // x/y/z встали бы из Ада, а общак базы и мозг читали бы их как верхний
        // мир. Отказ до записи, с другим именем на выбор.
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
  // dumping fifty records on every recall costs more tokens than the whole rest
  // of the answer. What the brain can act on is the count and the last few
  // piles nobody has been back for.
  compactState () {
    const s = this.journal.state
    const deaths = Array.isArray(s.deaths) ? s.deaths : []
    const open = deaths.filter(d => !d.recovered)
    // Реестр руды растёт так же, как рос список смертей, и по той же причине
    // его нельзя вываливать целиком: 120 записей стоят дороже всего остального
    // ответа. Здесь — счётчик и виды; координаты отдаёт mc_mine_seen, которому
    // они нужны, чтобы туда пойти.
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

  recall ({ lines = 40 } = {}) {
    return this.immediate(async () => ({
      state: this.compactState(),
      journal: this.journal.tail(lines)
    }))
  }
}

module.exports = { Session, sleep, xyz, resultCode, steerIntoDig }
