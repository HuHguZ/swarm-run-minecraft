'use strict'
const gameClock = require('./game-clock')
// 03.10: require('./src/index') ради проверки загрузки поднимал демон на 8765 (порт арены) → 25565 — дважды за день.
// Демон запускается только как точка входа (node src/index.js); проверка загрузки — node --check.
if (require.main !== module) throw new Error('index.js — точка входа демона, не модуль; проверка загрузки — node --check src/index.js')
const { WebSocketServer } = require('ws')
const cfg = require('./config')
const { EventBus } = require('./events')
const { Journal } = require('./journal')
const { Session } = require('./session')
const { Autopilot } = require('./autopilot')
const { Vision } = require('./vision')

const bus = new EventBus()
const journal = new Journal(cfg.memoryDir)
const session = new Session(cfg, bus, journal)
const autopilot = new Autopilot(session, cfg)
// Жесты людей живут на автопилоте (gestures.js), а mc_players читает их через сессию.
session.autopilot = autopilot
// Средний слой: обстановка раз в секунду, шаги к цели, вытеснение (director.js).
const { Director } = require('./director')
const director = new Director(session)
session.director = director
const vision = new Vision(session, cfg)
autopilot.start()

// Чары того, что на теле, в руках и в рюкзаке (арена с чарами, 2026-09-26):
// арена сверяет с ними выдачу — status { enchants: true }. Без параметра status
// прежний: мозгу чары в каждом ответе ни к чему. Слоты — окна игрока: 5–8
// броня, 9–44 рюкзак и хотбар, 45 левая рука. Читается сам компонент
// enchantments (enchant.enchantsOf), а не prismarine-item.enchants.
// Что поле есть (хоть пустое) — ещё и знак арене, что демон умеет
// зачарованные инструменты (gamedata.fixEnchants): старый демон параметр
// молча пропускает.
function enchantedGear (bot) {
  if (!bot || !bot.inventory) return []
  const { enchantsOf } = require('./enchant')
  const out = []
  bot.inventory.slots.forEach((it, slot) => {
    if (!it || slot < 5) return
    const list = enchantsOf(bot, it)
    if (list.length) out.push({ slot, name: it.name, ench: Object.fromEntries(list.map(e => [e.name, e.level])) })
  })
  return out
}

const methods = {
  status: async (p) => session.immediate(async () => ({
    fairPlay: cfg.fairPlay,
    server: `${cfg.host}:${cfg.port}`,
    ...(p && p.enchants ? { enchants: enchantedGear(session.bot) } : {}),
    ...(p && p.physics && session.bot?.entity ? { physics: {
      pos: session.bot.entity.position, velocity: session.bot.entity.velocity,
      onGround: session.bot.entity.onGround, pose: session.bot.entity.pose,
      controls: session.bot.controlState, jumpTicks: session.bot.jumpTicks,
      height: session.bot.physics?.playerHeight, halfWidth: session.bot.physics?.playerHalfWidth,
      gravity: session.bot.physics?.gravity, attributes: session.bot.entity.attributes,
      // Отладка «стоит на месте при живом пути» (регрессия спуска 30.09): флаги pathfinder'а и рефлекс края.
      pathfinder: session.bot.pathfinder ? { mining: session.bot.pathfinder.isMining(), building: session.bot.pathfinder.isBuilding(),
        moving: session.bot.pathfinder.isMoving(), goal: !!session.bot.pathfinder.goal } : null,
      targetDig: session.bot.targetDigBlock ? session.bot.targetDigBlock.position : null,
      simWrapped: !!(session.bot.physics && session.bot._ndSimOrig && session.bot.physics.simulatePlayer !== session.bot._ndSimOrig)
    } } : {})
  })),
  // Наблюдатель сцены рядом с работающей кампанией: состояние и враги рядом БЕЗ выемки шины событий
  // (status/situation через immediate() забирают события у мозга — emergency/refuge/damage пропадали бы).
  peek: async () => {
    const bot = session.bot
    let foes = []
    try { if (bot && bot.entity) foes = require('./flee').hostilesAround(bot, 24).slice(0, 8).map(h => ({ name: h.e.name, d: Math.round(h.d * 10) / 10, dy: Math.round((h.e.position.y - bot.entity.position.y) * 10) / 10 })) } catch {}
    return { status: 'done', detail: { foes, busy: session.current ? session.current.name : null, refuging: !!(session.autopilot && session.autopilot.refuging) }, events: [], state: session.state() }
  },
  connect: async () => {
    const r = await session.connect()
    // Same envelope as every other method so the brain reads one shape.
    return { status: 'done', detail: r.already ? { already: true } : { joined: true }, events: bus.drain(), state: session.state() }
  },
  disconnect: async (p) => session.disconnect(p && p.reason),

  say: async (p) => session.say(p.text, p.to),
  goto: async (p) => session.goto(p),
  follow: async (p) => session.follow(p),
  escort: async (p) => session.escort(p || {}),
  give: async (p) => session.giveItem(p || {}),
  take: async (p) => session.takeItem(p || {}),
  stop: async () => session.stop(),
  wait: async (p) => session.wait(p || {}),
  look_at: async (p) => session.lookAt(p),
  observe: async (p) => session.observe(p || {}),
  players: async (p) => session.players(p || {}),

  // Actual eyesight. Returns the PNG alongside the usual envelope so the brain
  // gets the picture and the state header in one round trip.
  look: async (p = {}) => {
    session.require()
    if (p.at) await session.turnTo(p.at)
    const shot = await vision.capture(p)
    return {
      status: 'done',
      detail: { size: `${shot.width}x${shot.height}`, lookedAt: p.at || null },
      image: shot.image,
      mime: shot.mime,
      events: bus.drain(),
      state: session.state()
    }
  },

  mine: async (p) => session.mine(p || {}),
  explore: async (p) => session.explore(p || {}),
  dig_down: async (p) => session.digDown(p || {}),
  craft: async (p) => session.craft(p || {}),
  place: async (p) => session.place(p || {}),
  fight: async (p) => session.fight(p || {}),
  temper: async (p) => session.setTemper(p || {}),
  play_mode: async (p) => session.setPlayMode(p || {}),
  flee: async (p) => session.flee(p || {}),
  stronghold: async (p) => session.stronghold(p || {}),
  bucket: async (p) => session.bucket(p || {}),
  obsidian: async (p) => session.obsidian(p || {}),
  pack: async (p) => session.pack(p || {}),
  cache: async (p) => session.cache(p || {}),
  animals: async (p) => session.animals(p || {}),
  golem: async (p) => session.golem(p || {}),
  // Шерсть на кровать (поток route, 03.10; fauna.wool): стадо одного цвета на виду (или по карте x,z) — убить или
  // остричь до count шерсти этого цвета.
  wool: async (p = {}) => session.runIntent('wool', ctl => {
    session.require()
    session.updateMovements()
    return require('./fauna').wool(session, ctl, p || {})
  }, { timeoutMs: (Math.min(240, Number(p && p.timeoutSeconds) || 90) + 20) * 1000, params: p, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] }),
  trade: async (p) => session.trade(p || {}),
  blaze: async (p) => session.blaze(p || {}),
  fortress: async (p) => session.fortress(p || {}),
  pearls: async (p) => session.pearls(p || {}),
  bastion: async (p) => session.bastion(p || {}),
  nether_tunnel: async (p) => session.netherTunnel(p || {}),
  // Поток nether-end: закопаться в толщу (bastion.burrowIntent) — штрек по Аду с открытого места не начинается.
  ne_burrow: async (p) => session.runIntent('ne_burrow', ctl => require('./bastion').burrowIntent(session, ctl, p || {}), { timeoutMs: 60000, params: p || {}, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] }),
  // Поток nether (03.10): ход по Аду по сетке копии мира (nether-route.routeTo: {x,y,z,r,dy,timeoutSeconds}).
  ne_route: async (p) => { p = p || {}; const s = Math.min(1500, Number(p.timeoutSeconds) || 600); return session.runIntent('ne_route', async ctl => { session.updateMovements(); return require('./nether-route').routeTo(session, ctl, { ...p, timeoutSeconds: s }) }, { timeoutMs: (s + 20) * 1000, params: p, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] }) },
  // Поток unstuck: лестница выхода из застревания здесь и сейчас (unstuck.freeHere; {x,y,z} — куда надо, необязательно).
  unstuck: async (p) => session.runIntent('unstuck', ctl => require('./unstuck').freeHere(session, ctl, { toward: p && p.x != null && p.z != null ? new (require('vec3'))(Number(p.x) + 0.5, p.y != null ? Number(p.y) : session.bot.entity.position.y, Number(p.z) + 0.5) : null }), { timeoutMs: 45000, params: p || {}, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] }),
  dragon: async (p) => session.dragon(p || {}),
  shoot: async (p) => session.shoot(p || {}),
  throw: async (p) => session.throwTest(p || {}),
  prep: async (p) => session.prep(p || {}),
  // Зачарование, зелья, сборы в поход (enchant.js, brew.js, fightkit.js).
  enchant: async (p) => session.enchant(p || {}),
  brew: async (p) => session.brew(p || {}),
  kit: async (p) => session.kit(p || {}),
  loot: async (p) => session.loot(p || {}),
  // Постройки игры: scan | list | where | plan | forget | explore | loot (structures.js).
  structure: async (p) => session.structure(p || {}),
  loot_seen: async (p) => session.immediate(async () => {
    session.require()
    return { chests: require('./loot').seen(session, { radius: (p && p.radius) || 24 }) }
  }),
  // Разбор врагов вокруг — без боя и без движения тела.
  assess: async (p) => session.immediate(async () => {
    session.require()
    const r = require('./assess').plan(session.bot, { radius: (p && p.radius) || 24 })
    if (!r) return { text: 'не в игре' }
    const { first, ...rest } = r
    return rest
  }),
  // Сценам: команда оператора и то, что сервер ответил в чат этому игроку.
  // Ответ /locate в latest.log не попадает (sendSuccess без логирования), а
  // сцене нужна правда о мире, а не отчёт демона.
  ask: async (p) => session.immediate(async () => {
    const bot = session.require()
    const lines = []
    const on = m => lines.push(String(m))
    const re = p && p.match ? new RegExp(p.match) : null
    bot.on('messagestr', on)
    try {
      bot.chat(String((p && p.command) || '').slice(0, 250))
      const t0 = gameClock.wall.now()
      while (gameClock.wall.now() - t0 < Math.min(20000, (p && p.ms) || 3000)) {
        if (re && lines.some(l => re.test(l))) break
        await gameClock.wall.sleep(100)
      }
    } finally { bot.removeListener('messagestr', on) }
    return { lines }
  }),
  // Сценам и отладке: срез мира вокруг тела по слоям, без зрения (fairPlay не
  // участвует) — «что на самом деле лежит вокруг», когда отчёт и мир спорят.
  // Сценам и отладке: срез коробки x0..x1, y0..y1, z0..z1 символами (правда
  // мира, как blocks_around; не зрение). '.' воздух, 'L' лава, 'W' вода,
  // 'G' золото, 'C' сундук, 'B' чернокамень/кирпич, 'b' базальт, 'n' незерак,
  // 's' неполные, 'o' прочее, '?' не прогружено. Не больше 40000 клеток.
  slice: async (p) => session.immediate(async () => {
    const bot = session.require()
    const { Vec3 } = require('vec3')
    const [x0, x1] = [Math.min(p.x0, p.x1), Math.max(p.x0, p.x1)]
    const [y0, y1] = [Math.min(p.y0, p.y1), Math.max(p.y0, p.y1)]
    const [z0, z1] = [Math.min(p.z0, p.z1), Math.max(p.z0, p.z1)]
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 40000) throw new Error('срез больше 40000 клеток')
    // mark: {имя блока: символ} — свои метки поверх стандартных (поток overworld: «O» обсидиан, «c» булыжник).
    const mark = (p && p.mark && typeof p.mark === 'object') ? p.mark : null
    const sym = b => {
      if (!b) return '?'
      const n = b.name
      if (mark && typeof mark[n] === 'string') return mark[n].slice(0, 1)
      if (n === 'air' || n === 'cave_air' || n === 'void_air') return '.'
      if (n === 'lava') return 'L'
      if (n === 'water') return 'W'
      if (n === 'gold_block') return 'G'
      if (/chest|barrel/.test(n)) return 'C'
      if (b.boundingBox === 'empty') return ','
      if (/stairs|slab|wall$|chain|lantern|fence|bars/.test(n)) return 's'
      if (/basalt/.test(n)) return 'b'
      if (/blackstone/.test(n)) return 'B'
      if (/netherrack|nylium/.test(n)) return 'n'
      return 'o'
    }
    const layers = {}
    for (let y = y1; y >= y0; y--) {
      const rows = []
      for (let z = z0; z <= z1; z++) {
        let row = ''
        for (let x = x0; x <= x1; x++) row += sym(bot.blockAt(new Vec3(x, y, z)))
        rows.push(row)
      }
      layers[y] = rows
    }
    // mobs — ещё и все сущности, что видит клиент (имя, клетка): кто где стоит в свежем мире.
    if (p.mobs) {
      const mobs = Object.values(bot.entities).filter(e => e !== bot.entity && e.position && e.name && e.type !== 'object')
        .map(e => [e.name, Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)])
      return { x0, z0, layers, mobs }
    }
    return { x0, z0, layers }
  }),
  blocks_around: async (p) => session.immediate(async () => {
    const bot = session.require()
    const c = bot.entity.position.floored()
    // find — где такие блоки в радиусе (правда мира для сцены, не зрение).
    if (p && p.find) {
      const b = session.mcData.blocksByName[p.find]
      if (!b) throw new Error(`нет блока ${p.find}`)
      const found = bot.findBlocks({ matching: [b.id], maxDistance: Math.min(256, p.radius || 64), count: p.count || 64 })
      return { at: { x: c.x, y: c.y, z: c.z }, found: found.map(v => ({ x: v.x, y: v.y, z: v.z })) }
    }
    const r = Math.max(1, Math.min(6, (p && p.radius) || 3))
    const layers = {}
    for (let dy = r; dy >= -r; dy--) {
      const rows = []
      for (let dz = -r; dz <= r; dz++) {
        const row = []
        for (let dx = -r; dx <= r; dx++) {
          const b = bot.blockAt(c.offset(dx, dy, dz))
          row.push(!b ? '?' : b.name === 'air' || b.name === 'cave_air' ? '.' : b.name.replace(/^(infested_|mossy_|cracked_|chiseled_)/, '').slice(0, 10))
        }
        rows.push(row.join(' '))
      }
      layers[`y${c.y + dy}`] = rows
    }
    return { at: { x: c.x, y: c.y, z: c.z }, xFrom: c.x - r, zFrom: c.z - r, layers }
  }),
  // Отладка копки (арена с чарами, 2026-09-26): сколько тело само думает
  // ломать блок x,y,z — tools.digMs каждым инструментом рюкзака, bestFor и
  // bot.digTime тем, что в руке (mineflayer ждёт ровно его), — и, с dig: true,
  // сколько вышло на деле. bot.dig кончается по своему же предсказанию
  // (digging.js сам ставит «воздух»), поэтому правда сервера — через паузу:
  // не принятую ломку сервер возвращает блоком обратно. ms: N — «докопал»
  // ровно через N мс тем, что в руке, без своей оценки: сервер не должен
  // принять раньше срока. hold: имя — сперва взять это в руку.
  dig_time: async (p = {}) => session.immediate(async () => {
    const bot = session.require()
    const { Vec3 } = require('vec3')
    const tools = require('./tools')
    const ms = v => (Number.isFinite(v) ? Math.round(v) : String(v))
    const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const block = bot.blockAt(pos)
    if (!block) throw new Error('блок не прогружен')
    if (p.hold) {
      const it = bot.inventory.items().find(i => i.name === p.hold)
      if (!it) throw new Error(`нет ${p.hold}`)
      await bot.equip(it, 'hand')
    }
    const by = bot.inventory.items().filter(i => /_(pickaxe|axe|shovel|hoe|sword)$|^shears$/.test(i.name)).map(i => {
      let enchants
      try { enchants = i.enchants } catch (e) { enchants = `ошибка: ${e.message}` }
      return { item: i.name, enchants, ms: ms(tools.digMs(bot, block, i)) }
    })
    const best = tools.bestFor(bot, block)
    let heldMs
    try { heldMs = ms(bot.digTime(block)) } catch (e) { heldMs = `ошибка: ${e.message}` }
    const out = { block: block.name, held: bot.heldItem ? bot.heldItem.name : null, heldMs, best: { item: best.item ? best.item.name : 'рука', ms: ms(best.ms) }, by }
    if (p.ms) {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
      bot._client.write('block_dig', { status: 0, location: pos, face: 1, sequence: 0 })
      bot.swingArm()
      await new Promise(r => gameClock.setTimeout(r, p.ms))
      bot._client.write('block_dig', { status: 2, location: pos, face: 1, sequence: 0 })
      out.digMs = p.ms
    } else if (p.dig) {
      const t0 = gameClock.now()
      try { await bot.dig(block, true) } catch (e) { out.digError = e.message }
      out.digMs = gameClock.now() - t0
      out.heldAfter = bot.heldItem ? bot.heldItem.name : null
    }
    if (p.dig || p.ms) {
      await new Promise(r => gameClock.setTimeout(r, p.settleMs || 800))
      const now = bot.blockAt(pos)
      out.after = now ? now.name : null
    }
    return out
  }),
  tunnel: async (p) => session.tunnel(p || {}),
  mine_seen: async (p) => session.mineSeen(p || {}),
  smelt: async (p) => session.smelt(p || {}),
  chest_put: async (p) => session.chestPut(p || {}),
  chest_take: async (p) => session.chestTake(p || {}),
  chest_list: async (p) => session.chestList(p || {}),
  base: async (p) => session.base(p || {}),
  stash: async (p) => session.stash(p || {}),
  armor: async (p) => session.wearBestArmor(p || {}),
  shelter: async (p) => session.shelter(p || {}),
  // Аварийный отход (survival.refuge, research/05-synthesis.md F.5): оценить
  // место, коробка у стены / нора / замкнутый карман / бегство, внутри — еда
  // и зелья до minHp, выход. Урон и low_health его не рвут — только чат и
  // смерть. Через runIntent прямо здесь (survival.runRefuge): тот же запуск
  // зовёт автопилот на EMERGENCY.
  refuge: async (p) => require('./survival').runRefuge(session, p || {}),
  surface: async (p) => session.surface(p || {}),
  recover: async (p) => session.recoverLoot(p || {}),
  portal: async (p) => session.portal(p || {}),
  // Природная лава для портала (portal-natural.js, агент G): survey/order — только чтение; run — ND_PORTAL_NATURAL=1.
  portal_natural: async (p) => require('./portal-natural').rpc(session, p || {}),
  build: async (p) => session.build(p || {}),
  sort: async (p) => session.sortStorage(p || {}),
  sign: async (p) => session.writeSign(p || {}),
  farm: async (p) => session.farm(p || {}),
  ride: async (p) => session.ride(p || {}),
  mechanism: async (p) => session.mechanism(p || {}),
  sleep: async (p) => session.sleepInBed(p || {}),
  wake: async () => session.wakeUp(),
  // Отладка: живо ли тело — сколько физических тиков за 2 с и почему нет.
  phys: async () => {
    const bot = session.bot
    if (!bot) return { status: 'failed', error: 'нет бота' }
    const t0 = session.ticks || 0
    await new Promise(r => gameClock.setTimeout(r, 2000))
    const ev = (n) => bot.listenerCount(n)
    return {
      status: 'done',
      detail: {
        tps: ((session.ticks || 0) - t0) / 2,
        physicsEnabled: bot.physicsEnabled,
        isAlive: bot.isAlive,
        vehicle: bot.vehicle ? (bot.vehicle.name || bot.vehicle.id) : null,
        pos: bot.entity && bot.entity.position,
        blockAtFeet: (() => { try { const b = bot.blockAt(bot.entity.position); return b ? b.name : null } catch (e) { return 'err ' + e.message } })(),
        effects: bot.entity && bot.entity.effects,
        listeners: { physicsTick: ev('physicsTick'), move: ev('move'), entityMoved: ev('entityMoved'), forcedMove: ev('forcedMove'), packet: bot._client.listenerCount('packet'), position: bot._client.listenerCount('position') }
      }
    }
  },
  // Отладка: профиль процессора на N секунд — самые тяжёлые функции по
  // собственному времени. Тело «встаёт» на 3 tps — смотреть сюда.
  profile: async (p) => {
    const inspector = require('inspector')
    const s = new inspector.Session()
    s.connect()
    const post = (m, a) => new Promise((resolve, reject) => s.post(m, a || {}, (e, r) => e ? reject(e) : resolve(r)))
    await post('Profiler.enable')
    await post('Profiler.start')
    await new Promise(r => gameClock.setTimeout(r, Math.min(60, (p && p.seconds) || 10) * 1000))
    const { profile } = await post('Profiler.stop')
    s.disconnect()
    const self = new Map()
    const dt = profile.timeDeltas || []
    const byId = new Map(profile.nodes.map(n => [n.id, n]))
    ;(profile.samples || []).forEach((id, i) => self.set(id, (self.get(id) || 0) + (dt[i] || 0)))
    const agg = new Map()
    for (const [id, us] of self) {
      const cf = byId.get(id).callFrame
      const k = `${cf.functionName || '(anon)'} ${String(cf.url).split(/[\\/]/).slice(-2).join('/')}:${cf.lineNumber + 1}`
      agg.set(k, (agg.get(k) || 0) + us)
    }
    const total = [...agg.values()].reduce((a, b) => a + b, 0) || 1
    return { status: 'done', detail: { top: [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, us]) => `${(100 * us / total).toFixed(1)}% ${k}`) } }
  },
  equip: async (p) => session.equipItem(p || {}),
  eat: async (p) => session.eat(p || {}),
  drop: async (p) => session.dropItem(p || {}),

  set_goal: async (p) => session.setGoal(p),
  remember: async (p) => session.remember(p),
  recall: async (p) => session.recall(p || {}),
  // Обстановка глазами директора (director.situation) — для мозга-автомата
  // campaign.js: под крышей ли (порода над головой, а не y<50 — в горах это
  // поверхность), ночь и сумерки, враги с вердиктом assess, кровать, кирка.
  // Только чтение: тело не двигается, текущее намерение не рвётся.
  situation: async () => session.immediate(async () => {
    const bot = session.require()
    const s = require('./director').situation(director)
    const f = s.fight
    // Удары кирок: шапка состояния даёт штуки, а две стёртые кирки — это не
    // запас (кампания 2026-09-26: «кирок 2», а ударов 42 на обе, и штрек встал).
    const items = require('./items')
    const picks = items.toolStatus(bot, 'pickaxe')
    // Открытое небо — ещё не поверхность: на дне своего колодца небо над
    // головой видно до самого верха (director.situation смотрит только вверх), и
    // кампания на y=-10 считала себя «наверху» — toSurface не лез, а портал
    // строился бы на дне шахты. Стены — соседние столбы через клетку (±2) с
    // породой на 3..8 выше ног хотя бы с трёх сторон (листва и брёвна не в счёт
    // — лес не колодец).
    const feet = bot.entity.position.floored()
    let walls = 0
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      for (let dy = 3; dy <= 8; dy++) {
        const b = bot.blockAt(feet.offset(dx, dy, dz))
        if (b && b.boundingBox === 'block' && !/leaves|log|wood/.test(b.name)) { walls++; break }
      }
    }
    const pit = s.surface && walls >= 3
    // Голова в блоке (гравий сверху): откапывает автопилот (freeIfBuried), и
    // любое копающее намерение поверх него рвёт его взмах («Digging aborted»,
    // mineflayer держит одну задачу копания). Кампания 2026-09-26 на урон
    // удушья звала shelter/dig_down одно за другим и задохнулась («suffocated
    // in a wall»). Мозгу — знать и ждать.
    let buried = false
    try { buried = !!(session.autopilot && session.autopilot.buriedBy(bot)) } catch {}
    return {
      ...s,
      surface: s.surface && !pit,
      pit,
      buried,
      fight: undefined,
      fightText: f ? f.text : null,
      first: f && f.order && f.order[0] ? f.order[0] : null,
      pickLeft: items.toolBudget(bot, 'pickaxe'),
      picks: picks.tools || [],
      // Время суток в тиках (поток route, 03.10): кровать к ночи — заранее, по часам, а не по «сумеркам».
      tod: bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : null
    }
  }),
  // Вон из лавы и огня (director.escapeFire): вода из ведра под ноги или прыжок
  // к ближайшему твёрдому полу без лавы. Мозгу-автомату: на урон от огня не
  // «зарываться» — нора в лаве это смерть («tried to swim in lava», 2026-09-26).
  escape_fire: async () => session.runIntent('escape_fire', async () => {
    session.require()
    const r = await director.escapeFire()
    return (r && r.detail) || r
  }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'] }),
  director: async (p = {}) => session.immediate(async () => {
    const mode = p.mode || 'status'
    if (mode === 'start') return director.start({ goal: p.goal, rules: p.rules })
    if (mode === 'stop') return director.stop()
    if (mode === 'rules') { Object.assign(director.rules, p.rules || {}); return director.status() }
    return director.status()
  })
}

const wss = new WebSocketServer({ host: cfg.wsHost, port: cfg.wsPort })

let clients = 0
wss.on('connection', (ws) => {
  clients++
  session.brainAttached = clients > 0
  const sendClock = (clock = gameClock.snapshot()) => {
    if (clock && ws.readyState === 1 && (ws.bufferedAmount || 0) < 65536) ws.send(JSON.stringify({ type: 'clock', clock }))
  }
  let sourceClock
  // Followers have no independent prediction loop. Publish every five game
  // ticks so short game sleeps don't wait 250 wall ms at an accelerated rate.
  const onTick = ticks => { if (sourceClock.frozen || ticks % 5 === 0) sendClock() }
  const bindClock = clock => {
    sourceClock?.off('tick', onTick)
    sourceClock?.off('state', sendClock)
    sourceClock = clock
    sourceClock?.on('tick', onTick)
    sourceClock?.on('state', sendClock)
    if (sourceClock) sendClock(sourceClock.snapshot())
  }
  gameClock.changes.on('bound', bindClock)
  bindClock(session.bot?.ndClock)
  // Wall heartbeat is deliberate: freeze must be observable while there are
  // zero gameplay ticks, and campaigns must see stalls and rate changes.
  const clockTimer = gameClock.wall.setInterval(sendClock, 250)
  ws.on('close', () => {
    gameClock.wall.clearInterval(clockTimer)
    gameClock.changes.off('bound', bindClock)
    bindClock(null)
  })
  ws.on('close', () => { clients--; session.brainAttached = clients > 0 })
  log('brain attached')
  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    const { id, method, params } = msg
    const fn = methods[method]
    if (!fn) {
      ws.send(JSON.stringify({ id, ok: false, error: `неизвестный метод: ${method}` }))
      return
    }
    try {
      const result = await fn(params || {})
      if (result && typeof result === 'object' && !result.state) result.clock = gameClock.snapshot()
      ws.send(JSON.stringify({ id, ok: true, result }))
    } catch (err) {
      ws.send(JSON.stringify({ id, ok: false, error: String((err && err.message) || err) }))
    }
  })
  ws.on('close', () => log('brain detached'))
})

function log (...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args)
}

log(`NeuroDown daemon on ws://${cfg.wsHost}:${cfg.wsPort} -> ${cfg.host}:${cfg.port} as ${cfg.username} (fairPlay=${cfg.fairPlay})`)

process.on('SIGINT', async () => {
  autopilot.stop()
  await vision.close()
  session.disconnect('daemon stop')
  process.exit(0)
})
process.on('unhandledRejection', (e) => log('unhandledRejection:', String((e && e.message) || e)))
