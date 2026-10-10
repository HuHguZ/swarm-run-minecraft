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
    ...(p && p.items ? {
      items: session.bot?.inventory?.slots?.slice(5).filter(Boolean).map(it => require('./pvp/combat-observe').itemObs(session.bot, it)) || [],
      storage: session.bot?.inventory?.slots ? Array.from({ length: 36 }, (_, index) => {
        const it = session.bot.inventory.slots[index + 9]
        return it ? { ...require('./pvp/combat-observe').itemObs(session.bot, it),
          plain: !it.nbt && !(it.components?.length) && !(it.removedComponents?.length) && !(it.componentMap?.size) && !(it.metadata) } : null
      }) : null
    } : {}),
    ...(p && p.foeEstimate ? { foeEstimate: require('./pvp/combat-observe').readFoeEstimate(session.bot, p.foeEstimate) } : {}),
    ...(p && p.enchants ? { enchants: enchantedGear(session.bot) } : {}),
    // Последний отчёт дуэли (pvp.duel кладёт при конце боя): арена берёт его, если ответ fight пришёл пустым (S7d).
    ...(p && p.lastDuel ? { lastDuel: session.bot?._ndLastDuel || null } : {}),
    ...(p && p.totem ? { totem: require('./totem').snapshot(session.bot) } : {}),
    ...(p && p.physics && session.bot?.entity ? { physics: {
      pos: session.bot.entity.position, velocity: session.bot.entity.velocity,
      onGround: session.bot.entity.onGround, pose: session.bot.entity.pose,
      isInWater: !!session.bot.entity.isInWater, isInLava: !!session.bot.entity.isInLava,
      clutch: { waterPlan: !!session.bot._ndClutch?.waterPlan,
        stats: Object.fromEntries(['water_plans', 'water_saved', 'water_failed', 'ladders', 'saved', 'placed', 'soft_plans', 'soft_saved', 'soft_failed'].map(key => [key, session.bot._ndClutch?.stats?.[key] ?? 0])),
        lastDecision: session.bot._ndClutch?.lastDecision ? { action: session.bot._ndClutch.lastDecision.action, why: session.bot._ndClutch.lastDecision.why } : null },
      sprintJump: session.bot._ndSprintJump ? { jumps: session.bot._ndSprintJump.jumps, skipped: session.bot._ndSprintJump.skipped } : null,
      controls: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(key => [key, session.bot.getControlState(key)])), jumpTicks: session.bot.jumpTicks,
      worldLoaded: [-8, 0, 8].every(x => [-8, 0, 8].every(z => !!session.bot.blockAt(session.bot.entity.position.offset(x, -1, z)))),
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
  disconnect: async (p) => { await vision.close(); return session.disconnect(p && p.reason) },

  say: async (p) => session.say(p.text, p.to),
  goto: async (p) => session.goto(p),
  flight_route: async (p) => session.flightRoute(p || {}),
  boat_hop: async (p) => session.boatHop(p || {}),
  parkour: async (p) => session.parkour(p || {}),
  follow: async (p) => session.follow(p),
  escort: async (p) => session.escort(p || {}),
  give: async (p) => session.giveItem(p || {}),
  take: async (p) => session.takeItem(p || {}),
  stop: async () => session.stop(),
  wait: async (p) => session.wait(p || {}),
  look_at: async (p) => session.lookAt(p),
  // Жест (гонка в Колизее, 10.10: «эмоции чаще — кивать, махать, присаживаться»): nod | shake | wave | crouch, at — на кого смотреть.
  emote: async (p: any = {}) => session.immediate(async () => {
    const bot = session.require()
    const wait = ms => new Promise<void>(r => gameClock.setTimeout(r, ms))
    if (p.at) await session.turnTo(p.at)
    const yaw = bot.entity.yaw; const pitch = bot.entity.pitch
    const kind = p.kind || 'wave'
    for (let k = 0; k < 3; k++) {
      if (kind === 'nod') { await bot.look(yaw, pitch - 0.5, true); await wait(150); await bot.look(yaw, pitch + 0.2, true); await wait(150) }
      else if (kind === 'shake') { await bot.look(yaw + 0.5, pitch, true); await wait(150); await bot.look(yaw - 0.5, pitch, true); await wait(150) }
      else if (kind === 'crouch') { bot.setControlState('sneak', true); await wait(130); bot.setControlState('sneak', false); await wait(130) }
      else { bot.swingArm(); await wait(220) }
    }
    if (kind !== 'wave') await bot.look(yaw, pitch, true)
    return { emote: kind }
  }),
  observe: async (p) => session.observe(p || {}),
  // Честное восприятие (S10, perception/): mode f3 | pie | pie_arcs | heard | seen | surface | entities | stats | knowledge
  // | sweep | pie_seek (ходом: пеленги «пирога» → оценка места) | без mode — сводка.
  perceive: async (p: any = {}) => p && p.mode === 'pie_seek'
    ? session.runIntent('pie_seek', ctl => { session.require(); session.updateMovements(); return require('./perception/senses').pieSeek(session, ctl, p) },
      { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 120) + 20) * 1000, params: p })
    : session.immediate(async () => { session.require(); return require('./perception/senses').perceive(session, p || {}) }),
  players: async (p) => session.players(p || {}),

  // Actual eyesight. Returns the PNG alongside the usual envelope so the brain
  // gets the picture and the state header in one round trip.
  look: async (p: any = {}) => {
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
  // S8: кремень из гравия рюкзака на месте — поставить у ног и сломать до удачи (src/flint-grind.ts).
  flint_grind: async (p) => session.runIntent('flint_grind', ctl => { session.require(); return require('./flint-grind').flintGrind(session, ctl, p || {}) },
    { timeoutMs: (Math.min(300, (p && p.timeoutSeconds) ?? 90) + 15) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'], params: p || {} }),
  fight: async (p) => session.fight(p || {}),
  // Immediate mailbox update; leave combat events for the owner of the fight.
  // Помощь союзнику (командный бой): зелье лечения ему под ноги / стенка из двух блоков между ним и врагом.
  assist: async (p) => session.runIntent('assist', () => require('./pvp/team-assist').assist(session, p || {}), { timeoutMs: p?.mode === 'deny' ? 9000 : 5000, params: p || {}, interruptOn: ['death', 'kicked', 'disconnected'] }),
  team_hint: async (p) => session.immediate(async () => require('./pvp/team-assist').hint(session, p || {})),
  fight_yield: async (p) => ({ status: 'done', detail: require('./combat').requestStrategicYield(session, p || {}), events: [], state: session.state() }),
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
  wool: async (p: any = {}) => session.runIntent('wool', ctl => {
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
  // Поток S2 (06.10): загон пиглинов «люк за окном» из ямы со ртом (bastion/pen-trap.penIntent: mode pen|pit, timeoutSeconds, pearls, want, lanes).
  pen: async (p) => session.runIntent('pen', ctl => { session.require(); return require('./bastion/pen-trap').penIntent(session, ctl, p || {}) }, { timeoutMs: (Math.min(1200, Number(p && p.timeoutSeconds) || 240) + 40) * 1000, params: p || {}, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] }),
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
  // Автолут сундуков автопилотом (autopilot.lootIfSeen): {enabled:false} — выключить (арена «гонки вооружений»,
  // s7: бот брал сундуки сам, мимо графа, и при 750 TPS скан каждые 5 игровых с жёг процессор).
  auto_loot: async (p) => session.immediate(async () => { session.lootAuto = !(p && p.enabled === false); return { lootAuto: session.lootAuto } }),
  // Бутылки опыта под ноги — уровни для стола зачарований (pvp/xp-bottles, гонка вооружений s7).
  xp_bottles: async (p) => session.runIntent('xp_bottles', ctl => { session.require(); return require('./pvp/xp-bottles').drink(session, ctl, p || {}) },
    { timeoutMs: 30000, interruptOn: ['death', 'kicked', 'disconnected'] }),
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
      const mobs = (Object.values(bot.entities) as any[]).filter((e : any) => e !== bot.entity && e.position && e.name && e.type !== 'object')
        .map((e : any) => [e.name, Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)])
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
      let found = bot.findBlocks({ matching: [b.id], maxDistance: Math.min(256, p.radius || 64), count: p.count || 64 })
      // seen — только видимые глазами: луч до грани первым входит в сам блок (pick.blockSeen; «гонка вооружений» не знает
      // сундуков за облицовкой — s7b 06.10, прежний raySees с допуском 1.2 бл. пропускал их сквозь стену).
      if (p.seen) { const pk = require('./pick'); found = found.filter(v => pk.blockSeen(bot, v, { range: Math.min(256, p.radius || 64) })) }
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
  dig_time: async (p: any = {}) => session.immediate(async () => {
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
    const out: any = { block: block.name, held: bot.heldItem ? bot.heldItem.name : null, heldMs, best: { item: best.item ? best.item.name : 'рука', ms: ms(best.ms) }, by }
    if (p.ms) {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
      bot._client.write('block_dig', { status: 0, location: pos, face: 1, sequence: 0 })
      bot.swingArm()
      await new Promise<any>(r => gameClock.setTimeout(r, p.ms))
      bot._client.write('block_dig', { status: 2, location: pos, face: 1, sequence: 0 })
      out.digMs = p.ms
    } else if (p.dig) {
      const t0 = gameClock.now()
      try { await bot.dig(block, true) } catch (e) { out.digError = e.message }
      out.digMs = gameClock.now() - t0
      out.heldAfter = bot.heldItem ? bot.heldItem.name : null
    }
    if (p.dig || p.ms) {
      await new Promise<any>(r => gameClock.setTimeout(r, p.settleMs || 800))
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
    await new Promise<any>(r => gameClock.setTimeout(r, 2000))
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
    const post = (m, a?: any) => new Promise<any>((resolve, reject) => s.post(m, a || {}, (e, r) => e ? reject(e) : resolve(r)))
    await post('Profiler.enable')
    await post('Profiler.start')
    await new Promise<any>(r => gameClock.setTimeout(r, Math.min(60, (p && p.seconds) || 10) * 1000))
    const { profile }: any = await post('Profiler.stop')
    s.disconnect()
    const self = new Map()
    const dt = profile.timeDeltas || []
    const byId = new Map(profile.nodes.map(n => [n.id, n]))
    ;(profile.samples || []).forEach((id, i) => self.set(id, (self.get(id) || 0) + (dt[i] || 0)))
    const agg = new Map()
    for (const [id, us] of self) {
      const cf = (byId.get(id) as any).callFrame
      const k = `${cf.functionName || '(anon)'} ${String(cf.url).split(/[\\/]/).slice(-2).join('/')}:${cf.lineNumber + 1}`
      agg.set(k, (agg.get(k) || 0) + us)
    }
    const total = [...agg.values()].reduce((a, b) => a + b, 0) || 1
    return { status: 'done', detail: { top: [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, us]) => `${(100 * us / total).toFixed(1)}% ${k}`) } }
  },
  equip: async (p) => session.equipItem(p || {}),
  eat: async (p) => session.eat(p || {}),
  // Уйти в стену (арена 10.10: «буриться киркой в стены, закапываться в Колизей и прятаться»): прорыть ход 2 в высоту
  // на depth клеток в сторону от away (стена рядом — по оси, что дальше всего от врага), зайти, заложить вход за собой
  // и сесть на шифт. Копает лучшим инструментом (tools.equipFastest), ставит честно (build.placeBlockAt, honest).
  burrow: async (p) => session.runIntent('burrow', async (ctl) => {
    const bot = session.require()
    const tools = require('./tools'); const { placeBlockAt, pickFiller } = require('./build')
    const Vec3 = require('vec3')
    const depth = Math.max(2, Math.min(8, p?.depth ?? 4))
    const feet = bot.entity.position.floored()
    const away = p?.away ? new Vec3(bot.entity.position.x - p.away.x, 0, bot.entity.position.z - p.away.z) : new Vec3(1, 0, 0)
    const solid = (v) => { const b = bot.blockAt(v); return b && b.boundingBox === 'block' && tools.breakable(b) }
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => new Vec3(x, 0, z))
      .filter(d => solid(feet.plus(d)) || solid(feet.plus(d).offset(0, 1, 0)))
      .sort((a, b) => (b.x * away.x + b.z * away.z) - (a.x * away.x + a.z * away.z))
    if (!dirs.length) {
      // Стены нет — закопаться вниз на 2 и закрыть голову блоком (под ямой — опора, рядом — ни лавы, ни воды).
      const wet = (v) => /lava|water/.test(bot.blockAt(v)?.name || '')
      const d1 = feet.offset(0, -1, 0); const d2 = feet.offset(0, -2, 0)
      if (!solid(d1) || !solid(d2) || !solid(feet.offset(0, -3, 0)) || [d1, d2].some(v => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => wet(v.offset(x, 0, z))))) return { ok: false, why: 'рядом нет стены, вниз копать нельзя' }
      let dug = 0
      for (const v of [d1, d2]) {
        const b = bot.blockAt(v)
        await tools.equipFastest(bot, b).catch(() => {})
        try { await bot.dig(b, true); dug++ } catch (e) { return { ok: dug > 0, why: 'копка вниз: ' + e.message, dug } }
        for (let t = 0; t < 15 && bot.entity.position.y > v.y + 0.1; t++) await bot.waitForTicks(1)
      }
      let sealed = 0
      if (pickFiller(bot)) { const r = await placeBlockAt(bot, feet, { honest: true, timeoutMs: 1500, ctl }).catch(() => null); if (r && r.ok) sealed++ }
      bot.setControlState('sneak', true)
      return { ok: true, dug, sealed, down: true, at: { x: d2.x, y: d2.y, z: d2.z } }
    }
    const d = dirs[0]
    let dug = 0; let cell = feet
    for (let k = 1; k <= depth && !ctl.aborted; k++) {
      const next = feet.plus(d.scaled(k))
      for (const v of [next, next.offset(0, 1, 0)]) {
        const b = bot.blockAt(v)
        if (b && b.boundingBox === 'block') {
          if (!tools.breakable(b)) return { ok: dug > 0, why: `не копается ${b.name}`, dug }
          await tools.equipFastest(bot, b).catch(() => {})
          try { await bot.dig(b, true); dug++ } catch (e) { return { ok: dug > 0, why: 'копка: ' + e.message, dug } }
        }
      }
      if (!solid(next.offset(0, -1, 0))) break
      await bot.lookAt(next.offset(0.5, 1.6, 0.5), true).catch(() => {})
      bot.setControlState('forward', true)
      for (let t = 0; t < 20 && !bot.entity.position.floored().equals(next); t++) await bot.waitForTicks(1)
      bot.setControlState('forward', false)
      cell = bot.entity.position.floored()
    }
    // Вход за собой — заложить (ноги и голова), чтобы не было видно и не достали.
    let sealed = 0
    if (!cell.equals(feet) && pickFiller(bot)) {
      const back = cell.minus(d)
      for (const v of [back, back.offset(0, 1, 0)]) {
        const r = await placeBlockAt(bot, v, { honest: true, timeoutMs: 1500, ctl }).catch(() => null)
        if (r && r.ok) sealed++
      }
    }
    bot.setControlState('sneak', true)
    return { ok: dug > 0, dug, sealed, at: { x: cell.x, y: cell.y, z: cell.z } }
  }, { timeoutMs: 20000, interruptOn: ['death', 'kicked', 'disconnected'], params: p || {} }),
  // Прыжок на заряде ветра (10.10: «зарядами ветра передвигаться — подкидывать себя, убегать, подниматься высоко»):
  // up — заряд под ноги в прыжке (вверх ~7 бл.); toward {x,z} — разбег к точке, в прыжке заряд под ноги чуть позади:
  // взрыв толкает вперёд и вверх. Перезарядка заряда 10 тиков; times ≤ 3 подряд.
  wind_jump: async (p) => session.runIntent('wind_jump', async (ctl) => {
    const bot = session.require()
    const n = Math.max(1, Math.min(3, p?.times ?? 1))
    let used = 0
    const y0 = bot.entity.position.y
    // Потолок ближе 5 блоков — взлёт упрётся (10.10: «в комнате кидают в потолок, зацикленно»); вперёд — стена ближе 3.
    const feet0 = bot.entity.position.floored()
    for (let dy = 2; dy <= 5; dy++) { const b = bot.blockAt(feet0.offset(0, dy, 0)); if (b && b.boundingBox === 'block') return { used: 0, rise: 0, why: `потолок в ${dy} бл.` } }
    if (p?.toward && !p?.up) {
      const dx = p.toward.x - bot.entity.position.x; const dz = p.toward.z - bot.entity.position.z; const l = Math.hypot(dx, dz) || 1
      for (let k = 1; k <= 3; k++) for (const dy of [0, 1, 2]) { const b = bot.blockAt(bot.entity.position.offset(dx / l * k, dy, dz / l * k).floored()); if (b && b.boundingBox === 'block') return { used: 0, rise: 0, why: `стена впереди в ${k} бл.` } }
    }
    for (let k = 0; k < n && !ctl.aborted; k++) {
      const wc = bot.inventory.items().find(i => i.name === 'wind_charge')
      if (!wc) break
      await bot.equip(wc, 'hand')
      let yaw = bot.entity.yaw
      if (p?.toward) {
        const dx = p.toward.x - bot.entity.position.x; const dz = p.toward.z - bot.entity.position.z
        yaw = Math.atan2(-dx, -dz)
        await bot.look(yaw, 0, true)
        bot.setControlState('sprint', true); bot.setControlState('forward', true)
        await bot.waitForTicks(3)
      }
      bot.setControlState('jump', true)
      await bot.waitForTicks(2)
      bot.setControlState('jump', false)
      // Вниз (вверх — строго под ноги; вперёд — под ноги, чуть за спину).
      // up — строго под ноги (подъём на ярус: вверх ~7 бл., в полёте — вперёд к цели); иначе — под ноги чуть за спину.
      const flat = p?.toward && !p?.up
      await bot.look(flat ? yaw + Math.PI : yaw, flat ? -1.25 : -Math.PI / 2, true)
      bot.activateItem(); used++
      if (p?.toward) { await bot.waitForTicks(2); await bot.look(yaw, 0, true); bot.setControlState('forward', true); bot.setControlState('sprint', true) }
      await bot.waitForTicks(10)
    }
    bot.setControlState('sprint', false); bot.setControlState('forward', false)
    for (let t = 0; t < 40 && !bot.entity.onGround && !ctl.aborted; t++) await bot.waitForTicks(1)
    return { used, rise: Math.round((bot.entity.position.y - y0) * 10) / 10, at: { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) } }
  }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p || {} }),
  // Жемчуг туда, где не достать (10.10: «закидываю жемчуг высоко на Колизей, чтобы никто не достал — боты так не
  // думают»): бросок к точке to (крыша яруса, вершина) — pearl-hop.hopTo без проверки выгоды против пешего пути.
  pearl_to: async (p) => session.runIntent('pearl_to', async (ctl) => {
    const bot = session.require()
    if (!p?.to) throw new Error('нужна точка to')
    const ph = require('./pearl-hop')
    const from = bot.entity.position.clone()
    const r = await ph.hopTo(bot, p.to, { reserve: 0, minGain: -999, hpMin: 3, maxHops: p.maxHops ?? 1, arriveR: 3, walkSec: 999, abortIf: () => ctl.aborted })
    const me = bot.entity.position
    // loose — «куда-нибудь прочь»: удача, если перенёсся на 6+ бл.
    const ok = Math.hypot(me.x - p.to.x, me.y - p.to.y, me.z - p.to.z) <= 4 || (!!p.loose && me.distanceTo(from) >= 6)
    return { ok, hops: r.hops, stop: r.stop, at: { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) } }
  }, { timeoutMs: 12000, interruptOn: ['death', 'kicked', 'disconnected'], params: p || {} }),
  // Закрыть проход за собой (10.10: «стенку застраивать в узких местах, воду, лаву, паутину — система блокирования прохода
  // врагу»): клетка между мной и тем, кто гонится (по ходу к нему), — паутина (держит), иначе 2 блока стены; в проходе
  // (по бокам клетки опора) — ставить; на открытом — лава под ноги на его пути (ведро) или вода (сбивает бег).
  block_behind: async (p) => session.immediate(async () => {
    const bot = session.require()
    const Vec3 = require('vec3'); const { placeBlockAt, pickFiller } = require('./build')
    const foe = (p?.from && bot.players?.[p.from]?.entity) || (p?.fromId != null ? bot.entities[p.fromId] : null)
    if (!foe) return { ok: false, why: 'не вижу его' }
    const me = bot.entity.position
    const dx = foe.position.x - me.x; const dz = foe.position.z - me.z
    const ax = Math.abs(dx) >= Math.abs(dz)
    const step = ax ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
    const cell = me.floored().plus(step)
    const free = (v) => { const b = bot.blockAt(v); return b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
    const solid = (v) => { const b = bot.blockAt(v); return b && b.boundingBox === 'block' }
    if (!free(cell) || foe.position.floored().equals(cell)) return { ok: false, why: 'клетка занята' }
    const side = ax ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0)
    const corridor = solid(cell.plus(side)) && solid(cell.minus(side))
    const has = (n) => bot.inventory.items().find(i => i.name === n)
    const put = async (v, item) => { const r = await placeBlockAt(bot, v, { item, honest: true, timeoutMs: 1200 }).catch(() => null); return !!(r && r.ok) }
    // Паутина — не сплошной блок: placeBlockAt ждёт твёрдую клетку, поэтому проверка — по имени блока.
    if (has('cobweb')) { await put(cell, 'cobweb'); if (bot.blockAt(cell)?.name === 'cobweb') return { ok: true, how: 'паутина', corridor } }
    if (corridor && pickFiller(bot)) {
      const a = await put(cell, null); const b = await put(cell.offset(0, 1, 0), null)
      if (a || b) return { ok: true, how: `стена ${(a ? 1 : 0) + (b ? 1 : 0)}`, corridor }
    }
    for (const [item, how] of [['lava_bucket', 'лава'], ['water_bucket', 'вода']]) {
      const it = has(item); if (!it || !solid(cell.offset(0, -1, 0))) continue
      try {
        await bot.equip(it, 'hand')
        await bot.lookAt(cell.offset(0.5, 0.05, 0.5), true)
        bot.activateItem()
        return { ok: true, how, corridor }
      } catch {}
    }
    return { ok: false, why: 'нечем', corridor }
  }),
  // Враждебные мобы рядом (видно глазами: тип, позиция, скорость, что в руке и на теле) — для общего списка врагов в
  // гонке (10.10: «от мобов бегут, а меня не видят; от нескольких целей сразу убегать не умеют»).
  mobs: async (p) => session.immediate(async () => {
    const bot = session.require()
    const { DOCTRINE } = require('./flee')
    const me = bot.entity.position; const R = p?.radius ?? 24
    const out = []
    for (const e of Object.values(bot.entities) as any[]) {
      if (!e || e === bot.entity || e.username || !e.position || !DOCTRINE[e.name]) continue
      const d = e.position.distanceTo(me); if (d > R) continue
      const eq = (e.equipment || []).map((it: any) => it ? it.name : null)
      out.push({ id: e.id, name: e.name, p: { x: e.position.x, y: e.position.y, z: e.position.z }, v: { x: e.velocity?.x || 0, z: e.velocity?.z || 0 }, d,
        held: eq[0] || null, armor: { feet: eq[2] || null, legs: eq[3] || null, torso: eq[4] || null, head: eq[5] || null } })
    }
    return { mobs: out }
  }),
  // Выпить баффы, которых на мне нет (арена 10.10: «пусть ускоряются жёстко и мочат»; в рюкзаках по 2–6 зелий, бой их
  // не пил). Зелье узнаётся по potion_contents (pvp.potionOf): скорость — swiftness, сила — strength, реген, огнестойкость.
  drink_buffs: async (p) => session.immediate(async () => {
    session.require()
    const bot = session.bot
    const { potionOf } = require('./pvp')
    const EFF = { swiftness: 'speed', strength: 'strength', regeneration: 'regeneration', fire_resistance: 'fire_resistance', turtle_master: 'resistance', leaping: 'jump_boost' }
    const want = (p && p.kinds) || ['swiftness', 'strength']
    const norm = (n) => String(n || '').toLowerCase().replace(/^minecraft:/, '').replace(/_/g, '')
    const has = (eff) => Object.values(bot.entity.effects || {}).some((e: any) => norm(bot.registry.effects?.[e.id]?.name) === norm(eff))
    const drunk = []
    for (const k of want) {
      if (has(EFF[k])) continue
      const it = bot.inventory.items().find(i => i.name === 'potion' && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)
      if (!it) continue
      try { await bot.equip(it, 'hand'); await bot.consume(); drunk.push(k) } catch {}
    }
    return { drunk }
  }),
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
  director: async (p: any = {}) => session.immediate(async () => {
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
  let lastPublished = 0
  // Followers have no independent prediction loop. Publish every five game
  // ticks so short game sleeps don't wait 250 wall ms at an accelerated rate.
  const onTick = ticks => {
    if (sourceClock.frozen || ticks - lastPublished >= 5) { lastPublished = ticks; sendClock() }
  }
  const bindClock = clock => {
    sourceClock?.off('tick', onTick)
    sourceClock?.off('state', sendClock)
    sourceClock = clock
    lastPublished = clock?.ticks ?? 0
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

function log (...args: any[]) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args)
}

log(`NeuroDown daemon on ws://${cfg.wsHost}:${cfg.wsPort} -> ${cfg.host}:${cfg.port} as ${cfg.username} (fairPlay=${cfg.fairPlay})`)
// Флаги демона (S1d 07.10: ND_GOLD_ROUTE/ND_ANGER_SAFE стояли в CENV сцены и до демона не доходили) — видны в daemon-*.out.log.
log(`flags: ${Object.keys(process.env).filter(k => /^ND_/.test(k) && !/KEY|TOKEN|SECRET|PASS/.test(k)).sort().map(k => `${k}=${process.env[k]}`).join(' ') || '—'}`)

process.on('SIGINT', async () => {
  autopilot.stop()
  await vision.close()
  session.disconnect('daemon stop')
  process.exit(0)
})
process.on('unhandledRejection', (e: any) => log('unhandledRejection:', String((e && e.message) || e)))
